import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { runsRoot } from '../journal/runs.js'
import { workspaceHash, type RunListEntry, type SessionEntry } from '../workspace/discover.js'
import {
  matchRunRoute, snapshotChanged, startMissionControlServer, type MissionControlServer, type Poller,
} from './mission-control-server.js'

let dashboard: MissionControlServer | undefined
afterEach(async () => { if (dashboard) await dashboard.close(); dashboard = undefined })

function get(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    }).on('error', reject)
  })
}

function fakeRun(overrides: Partial<RunListEntry> = {}): RunListEntry {
  const workspace = overrides.workspace ?? '/projects/demo'
  return {
    workspace, workspaceName: 'demo', workspaceHash: workspaceHash(workspace),
    runId: 'run-1', name: 'fake-loop', goal: 'a fake goal for tests',
    status: 'running', agents: ['worker'],
    iteration: 1, costUsd: 0.1, tokens: 100, startedAt: 1, lastEventAt: 2, journalPath: '/irrelevant',
    ...overrides,
  }
}

function fakeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    workspace: '/projects/demo', workspaceName: 'demo', sessionId: 'session-1', lastActiveAt: 1,
    ...overrides,
  }
}

test('matchRunRoute parses index/model/events/resume sub-routes and rejects non-run paths', () => {
  expect(matchRunRoute('/run/abc123/run-1')).toEqual({ hash: 'abc123', runId: 'run-1', sub: 'index' })
  expect(matchRunRoute('/run/abc123/run-1/model')).toEqual({ hash: 'abc123', runId: 'run-1', sub: 'model' })
  expect(matchRunRoute('/run/abc123/run-1/events')).toEqual({ hash: 'abc123', runId: 'run-1', sub: 'events' })
  expect(matchRunRoute('/run/abc123/run-1/resume')).toEqual({ hash: 'abc123', runId: 'run-1', sub: 'resume' })
  expect(matchRunRoute('/run/abc123/run-1/junk')).toBeNull()
  expect(matchRunRoute('/api/runs')).toBeNull()
})

test('snapshotChanged only reports a change when the serialized scan actually differs', () => {
  expect(snapshotChanged('{"a":1}', '{"a":1}')).toBe(false)
  expect(snapshotChanged('{"a":1}', '{"a":2}')).toBe(true)
})

test('GET / serves the self-contained mission-control HTML page', async () => {
  dashboard = await startMissionControlServer({ scan: () => ({ runs: [], sessions: [] }) })
  const res = await get(dashboard.url + '/')
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toContain('text/html')
  expect(res.body).toContain('looprail mission control')
})

test('GET /api/runs returns the injected runs as JSON', async () => {
  dashboard = await startMissionControlServer({ scan: () => ({ runs: [fakeRun()], sessions: [] }) })
  const res = await get(dashboard.url + '/api/runs')
  const payload = JSON.parse(res.body) as { runs: unknown[]; sessions: unknown[] }
  expect(payload.runs).toHaveLength(1)
})

test('GET /api/runs also returns the injected Claude Code sessions as JSON', async () => {
  dashboard = await startMissionControlServer({
    scan: () => ({ runs: [], sessions: [fakeSession()] }),
  })
  const res = await get(dashboard.url + '/api/runs')
  const payload = JSON.parse(res.body) as { runs: unknown[]; sessions: unknown[] }
  expect(payload.sessions).toHaveLength(1)
  expect(payload.sessions[0]).toMatchObject({ sessionId: 'session-1' })
})

test('GET /events replays the current runs and sessions immediately on connect', async () => {
  dashboard = await startMissionControlServer({
    scan: () => ({ runs: [fakeRun()], sessions: [fakeSession()] }),
    poller: () => ({ close() {} }),
  })
  const body = await new Promise<string>((resolve, reject) => {
    http.get(dashboard!.url + '/events', (res) => {
      let received = ''
      res.on('data', (chunk) => {
        received += chunk
        if (received.includes('\n\n')) { res.destroy(); resolve(received) }
      })
      res.on('error', () => resolve(received))
    }).on('error', reject)
  })
  expect(body).toContain('run-1')
  expect(body).toContain('session-1')
})

test('GET /events sends a fresh frame when a poll tick reports a changed scan', async () => {
  let runs = [fakeRun({ status: 'running' })]
  let tick: (() => void) | undefined
  const poller: Poller = (fn) => { tick = fn; return { close: () => { tick = undefined } } }
  dashboard = await startMissionControlServer({ scan: () => ({ runs, sessions: [] }), poller })

  const frames = await new Promise<string[]>((resolve, reject) => {
    http.get(dashboard!.url + '/events', (res) => {
      const seen: string[] = []
      res.on('data', (chunk) => {
        seen.push(...chunk.toString().split('\n\n').filter((s: string) => s.startsWith('data: ')))
        if (seen.length === 1) {
          runs = [fakeRun({ status: 'verified' })]
          tick?.()
        }
        if (seen.length >= 2) { res.destroy(); resolve(seen) }
      })
      res.on('error', () => resolve(seen))
    }).on('error', reject)
  })
  expect(frames[0]).toContain('"running"')
  expect(frames[1]).toContain('"verified"')
})

test('GET /run/<hash>/<runId>/ serves the shared per-run dashboard page, and /model resolves the workspace by hash', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'lr-mc-'))
  const runDir = join(runsRoot(workspace), 'run-1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'journal.jsonl'), JSON.stringify({
    ts: 1, type: 'run_start', data: { runId: 'run-1', name: 'demo', goal: 'g' },
  }) + '\n')
  const hash = workspaceHash(workspace)
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-mc-reg-')), 'workspaces.json')
  writeFileSync(registryPath, JSON.stringify({ workspaces: [workspace] }))

  dashboard = await startMissionControlServer({ registryPath })
  const page = await get(`${dashboard.url}/run/${hash}/run-1/`)
  expect(page.status).toBe(200)
  expect(page.headers['content-type']).toContain('text/html')

  const model = await get(`${dashboard.url}/run/${hash}/run-1/model`)
  const payload = JSON.parse(model.body) as { name: string }
  expect(payload.name).toBe('demo')
})

test('POST /run/<hash>/<runId>/control routes to serveControl, scoped to that workspace', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'lr-mc-ctrl-'))
  const runDir = join(runsRoot(workspace), 'run-1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'journal.jsonl'), JSON.stringify({
    ts: 1, type: 'run_start', data: { runId: 'run-1', name: 'demo', goal: 'g' },
  }) + '\n')
  // no pid file recorded - proves the route reaches serveControl's own
  // 404 rather than mission-control-server crashing or 405-ing the method
  const hash = workspaceHash(workspace)
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-mc-reg-')), 'workspaces.json')
  writeFileSync(registryPath, JSON.stringify({ workspaces: [workspace] }))

  dashboard = await startMissionControlServer({ registryPath })
  const res = await new Promise<{ status: number }>((resolve, reject) => {
    const req = http.request(
      `${dashboard!.url}/run/${hash}/run-1/control`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (r) => { r.on('data', () => {}); r.on('end', () => resolve({ status: r.statusCode ?? 0 })) },
    )
    req.on('error', reject)
    req.end(JSON.stringify({ action: 'pause' }))
  })
  expect(res.status).toBe(404)
})

test('POST /run/<hash>/<runId>/resume routes to serveResume, calling the injected resumeFor with the right workspace and runId', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'lr-mc-resume-'))
  const runDir = join(runsRoot(workspace), 'run-1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'journal.jsonl'), [
    JSON.stringify({ ts: 1, type: 'run_start', data: { runId: 'run-1', name: 'demo', goal: 'g' } }),
    JSON.stringify({ ts: 2, type: 'halt', data: { reason: 'halted', costUsd: 0 } }),
  ].join('\n') + '\n')
  const hash = workspaceHash(workspace)
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-mc-reg-')), 'workspaces.json')
  writeFileSync(registryPath, JSON.stringify({ workspaces: [workspace] }))

  const calls: { workspace: string; runId: string }[] = []
  const resumeFor = (ws: string, runId: string) => {
    calls.push({ workspace: ws, runId })
    return async () => {}
  }
  dashboard = await startMissionControlServer({ registryPath, resumeFor })
  const res = await new Promise<{ status: number }>((resolve, reject) => {
    const req = http.request(
      `${dashboard!.url}/run/${hash}/run-1/resume`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (r) => { r.on('data', () => {}); r.on('end', () => resolve({ status: r.statusCode ?? 0 })) },
    )
    req.on('error', reject)
    req.end(JSON.stringify({}))
  })
  expect(res.status).toBe(200)
  expect(calls).toEqual([{ workspace, runId: 'run-1' }])
})

test('GET /run/<hash>/<runId>/model reports resumable:true only when resumeFor returns a callback for a halted run', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'lr-mc-resumable-'))
  const runDir = join(runsRoot(workspace), 'run-1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'journal.jsonl'), [
    JSON.stringify({ ts: 1, type: 'run_start', data: { runId: 'run-1', name: 'demo', goal: 'g' } }),
    JSON.stringify({ ts: 2, type: 'halt', data: { reason: 'halted', costUsd: 0 } }),
  ].join('\n') + '\n')
  const hash = workspaceHash(workspace)
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-mc-reg-')), 'workspaces.json')
  writeFileSync(registryPath, JSON.stringify({ workspaces: [workspace] }))

  dashboard = await startMissionControlServer({ registryPath, resumeFor: () => async () => {} })
  const payload = JSON.parse((await get(`${dashboard.url}/run/${hash}/run-1/model`)).body)
  expect(payload.resumable).toBe(true)
})

test('GET /run/<hash>/<runId> without a trailing slash redirects to the slash form, not a 404', async () => {
  // The served page's client fetches 'model'/'events' as URLs relative to
  // its own address - that only resolves to /run/<hash>/<runId>/model
  // (not /run/<hash>/model) when the page's own URL ends in a slash. A run
  // card always links with one, but a bookmark or a hand-typed URL might
  // not, so the server has to make the slash canonical itself.
  const workspace = mkdtempSync(join(tmpdir(), 'lr-mc-noslash-'))
  const runDir = join(runsRoot(workspace), 'run-1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'journal.jsonl'), JSON.stringify({
    ts: 1, type: 'run_start', data: { runId: 'run-1', name: 'demo', goal: 'g' },
  }) + '\n')
  const hash = workspaceHash(workspace)
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-mc-reg-')), 'workspaces.json')
  writeFileSync(registryPath, JSON.stringify({ workspaces: [workspace] }))

  dashboard = await startMissionControlServer({ registryPath })
  const res = await get(`${dashboard.url}/run/${hash}/run-1`)
  expect(res.status).toBe(301)
  expect(res.headers.location).toBe(`/run/${hash}/run-1/`)
})

test('an unknown workspace hash 404s instead of crashing', async () => {
  dashboard = await startMissionControlServer({ scan: () => ({ runs: [], sessions: [] }) })
  const res = await get(dashboard.url + '/run/nonexistent12/run-1/model')
  expect(res.status).toBe(404)
})

// --- Defense in depth: scan() throwing must never crash the process ---
// discover.ts (discoverRuns/discoverClaudeCodeSessions) is hardened at the
// source, but these three call sites (`/api/runs`, `/events`'s initial
// frame, `/events`'s poll tick) also guard directly against scan() itself
// throwing - from these functions or any future replacement of them.

test('GET /api/runs responds with a clean 500 instead of crashing when scan() throws, and a subsequent request still works', async () => {
  let shouldThrow = true
  dashboard = await startMissionControlServer({
    scan: () => {
      if (shouldThrow) throw new Error('simulated scan failure')
      return { runs: [fakeRun()], sessions: [] }
    },
  })

  const failed = await get(dashboard.url + '/api/runs')
  expect(failed.status).toBe(500)

  shouldThrow = false
  const recovered = await get(dashboard.url + '/api/runs')
  expect(recovered.status).toBe(200)
  const payload = JSON.parse(recovered.body) as { runs: unknown[] }
  expect(payload.runs).toHaveLength(1)
})

test('GET /api/runs against a real registry pointing at a directory-as-journal workspace stays alive across requests', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'lr-mc-broken-'))
  // journal.jsonl is a directory, not a file.
  mkdirSync(join(runsRoot(workspace), 'run-1', 'journal.jsonl'), { recursive: true })
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-mc-reg-')), 'workspaces.json')
  writeFileSync(registryPath, JSON.stringify({ workspaces: [workspace] }))

  dashboard = await startMissionControlServer({ registryPath })
  const first = await get(dashboard.url + '/api/runs')
  expect([200, 500]).toContain(first.status)
  // Regardless of status code, the server must still be alive and answer a
  // second request cleanly - the whole point of the fix.
  const second = await get(dashboard.url + '/api/runs')
  expect([200, 500]).toContain(second.status)
})

test('GET /events falls back to an empty snapshot on connect when scan() throws, instead of crashing', async () => {
  dashboard = await startMissionControlServer({
    scan: () => { throw new Error('simulated scan failure') },
    poller: () => ({ close() {} }),
  })
  const body = await new Promise<string>((resolve, reject) => {
    http.get(dashboard!.url + '/events', (res) => {
      let received = ''
      res.on('data', (chunk) => {
        received += chunk
        if (received.includes('\n\n')) { res.destroy(); resolve(received) }
      })
      res.on('error', () => resolve(received))
    }).on('error', reject)
  })
  expect(body).toContain('data: {"runs":[],"sessions":[]}')
})

test('GET /events poll tick survives scan() throwing - connection stays open and a later good tick still delivers', async () => {
  let scanShouldThrow = false
  let runs = [fakeRun({ status: 'running' })]
  let tick: (() => void) | undefined
  const poller: Poller = (fn) => { tick = fn; return { close: () => { tick = undefined } } }
  dashboard = await startMissionControlServer({
    scan: () => {
      if (scanShouldThrow) throw new Error('simulated poll-tick scan failure')
      return { runs, sessions: [] }
    },
    poller,
  })

  const frames = await new Promise<string[]>((resolve, reject) => {
    http.get(dashboard!.url + '/events', (res) => {
      const seen: string[] = []
      res.on('data', (chunk) => {
        seen.push(...chunk.toString().split('\n\n').filter((s: string) => s.startsWith('data: ')))
        if (seen.length === 1) {
          // First tick: scan() throws. Connection must survive this.
          scanShouldThrow = true
          runs = [fakeRun({ status: 'halted' })]
          tick?.()
          // Second tick, right after: scan() recovers and reports a real
          // change, proving the interval (and `last`) are still intact.
          scanShouldThrow = false
          tick?.()
        }
        if (seen.length >= 2) { res.destroy(); resolve(seen) }
      })
      res.on('error', () => resolve(seen))
    }).on('error', reject)
  })
  expect(frames[0]).toContain('"running"')
  expect(frames[1]).toContain('"halted"')
})

test('startMissionControlServer binds to an explicit port when given one', async () => {
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-mc-reg-')), 'workspaces.json')
  writeFileSync(registryPath, JSON.stringify({ workspaces: [] }))
  const port = 41569
  dashboard = await startMissionControlServer({ registryPath, port })
  expect(dashboard.url).toBe(`http://127.0.0.1:${port}`)
})

test('startMissionControlServer rejects with a clear error when the requested port is already taken', async () => {
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-mc-reg-')), 'workspaces.json')
  writeFileSync(registryPath, JSON.stringify({ workspaces: [] }))
  const port = 41570
  dashboard = await startMissionControlServer({ registryPath, port })
  await expect(startMissionControlServer({ registryPath, port })).rejects.toThrow(/port 41570 is already in use/)
})
