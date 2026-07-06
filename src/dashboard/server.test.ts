import { existsSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, expect, test, vi } from 'vitest'
import type { GateAnswer, LoopDef } from '../core/types.js'
import {
  serveControl, serveEvents, serveIndexPage, serveModel, serveResume, type ResumeOverrides,
} from './server.js'
import { fsWatcher, type Watcher } from './tail.js'
import type { PendingGate } from './gate-registry.js'

// Now that startDashboardServer (a whole second, separately-maintained
// createServer + listen implementation) has been deleted in favor of
// consolidating every dashboard entrypoint onto mission-control-server.ts,
// this file's own job - unit-testing the shared serveIndexPage/serveModel/
// serveControl/serveResume/serveEvents route handlers, including the
// getPendingGate/resolvePendingGate/onResume dependency-injection seams
// that let several dashboards in one test file avoid sharing gate-
// registry.ts's one real process-lifetime Map - needs its OWN tiny,
// test-only HTTP harness wiring those exact functions to routes. This is
// NOT a second production dashboard: it lives only in this test file, is
// never imported anywhere else, and reconstructs nothing mission-control-
// server.ts doesn't already do for real routes - it exists purely so these
// route handlers stay exercisable in isolation, with the same fine-grained
// DI seams the production code still exposes.
interface TestDashboardOptions {
  journalPath: string
  def?: LoopDef
  watcher?: Watcher
  port?: number
  onResume?: (overrides: ResumeOverrides) => Promise<void>
  getPendingGate?: (runId: string) => PendingGate | undefined
  resolvePendingGate?: (runId: string, nodeId: string, answer: GateAnswer) => boolean
}

interface TestDashboard {
  server: Server
  url: string
  close(): Promise<void>
}

function startDashboardServer(opts: TestDashboardOptions): Promise<TestDashboard> {
  const watch = opts.watcher ?? fsWatcher

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'GET' && url.pathname === '/') {
      serveIndexPage(res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/model') {
      serveModel(res, opts)
      return
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      serveEvents(req, res, opts, watch)
      return
    }
    if (req.method === 'POST' && url.pathname === '/control') {
      void serveControl(req, res, opts)
      return
    }
    if (req.method === 'POST' && url.pathname === '/resume') {
      void serveResume(req, res, opts)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  return new Promise((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      reject(e.code === 'EADDRINUSE'
        ? new Error(`port ${opts.port} is already in use - stop whatever is using it, or drop --port to pick a free one automatically`)
        : e)
    })
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      })
    })
  })
}

let dashboard: TestDashboard | undefined
let spawned: ChildProcess[] = []

afterEach(async () => {
  if (dashboard) await dashboard.close()
  dashboard = undefined
  for (const p of spawned) { try { p.kill('SIGKILL') } catch { /* already gone */ } }
  spawned = []
})

// A real, disposable, harmless child process to stand in for "the run
// process" - real enough that real signals (SIGSTOP/SIGCONT/SIGTERM) have
// real, observable effects, killed unconditionally in afterEach either way.
function spawnDummyProcess(): ChildProcess {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  spawned.push(p)
  return p
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function post(
  url: string, body: unknown, extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      url, { method: 'POST', headers: { 'content-type': 'application/json', ...extraHeaders } },
      (res) => {
        let resBody = ''
        res.on('data', (chunk) => { resBody += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: resBody }))
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

function get(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    }).on('error', reject)
  })
}

function journalWith(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lr-dash-'))
  const path = join(dir, 'journal.jsonl')
  writeFileSync(path, lines.map((l) => l + '\n').join(''))
  return path
}

test('GET / serves the self-contained HTML page', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  dashboard = await startDashboardServer({ journalPath })
  expect(dashboard.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  const res = await get(dashboard.url + '/')
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toContain('text/html')
  expect(res.body).toContain('<!doctype html>')
})

test('GET /model returns the dashboard payload as JSON, reflecting the journal', async () => {
  const journalPath = journalWith([
    '{"ts":1,"type":"run_start","data":{"runId":"run-9","name":"demo","goal":"g"}}',
    '{"ts":2,"type":"verified","data":{"reason":"all verifiers passed","costUsd":0.4}}',
  ])
  dashboard = await startDashboardServer({ journalPath })
  const res = await get(dashboard.url + '/model')
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toContain('application/json')
  const payload = JSON.parse(res.body)
  expect(payload.runId).toBe('run-9')
  expect(payload.status).toBe('verified')
  expect(payload.layout).toEqual([])
})

test('GET /model on a run directory with no journal yet returns an empty, running payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-dash-'))
  dashboard = await startDashboardServer({ journalPath: join(dir, 'journal.jsonl') })
  const res = await get(dashboard.url + '/model')
  expect(res.status).toBe(200)
  const payload = JSON.parse(res.body)
  expect(payload).toMatchObject({ runId: 'unknown', status: 'running', nodes: [] })
})

test('GET /events replays existing journal lines as SSE frames immediately', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  dashboard = await startDashboardServer({ journalPath, watcher: () => ({ close() {} }) })
  const body = await new Promise<string>((resolve, reject) => {
    http.get(dashboard!.url + '/events', (res) => {
      expect(res.headers['content-type']).toContain('text/event-stream')
      let received = ''
      res.on('data', (chunk) => {
        received += chunk
        if (received.includes('\n\n')) { res.destroy(); resolve(received) }
      })
      res.on('error', () => resolve(received)) // destroy() triggers an error on some Node versions - that's fine
    }).on('error', reject)
  })
  expect(body).toContain('"type":"run_start"')
})

test('GET /events with the REAL fsWatcher does not crash the server when the journal file does not exist yet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-dash-'))
  const journalPath = join(dir, 'journal.jsonl') // deliberately never written before connecting
  dashboard = await startDashboardServer({ journalPath }) // no watcher override - exercises the real fsWatcher
  await new Promise<void>((resolve, reject) => {
    http.get(dashboard!.url + '/events', (res) => {
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/event-stream')
      res.destroy() // SSE stream stays open by design - close it explicitly, don't wait for 'end'
      resolve()
    }).on('error', reject)
  })
  // Process is still alive and serving other routes - the crash the finding describes never happened.
  const health = await get(dashboard.url + '/model')
  expect(health.status).toBe(200)
})

test('GET /events with the REAL fsWatcher picks up events once the journal file appears after connecting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-dash-'))
  const journalPath = join(dir, 'journal.jsonl') // does not exist at connection time
  dashboard = await startDashboardServer({ journalPath })
  const frame = await new Promise<string>((resolve, reject) => {
    http.get(dashboard!.url + '/events', (res) => {
      let received = ''
      res.on('data', (chunk) => {
        received += chunk
        if (received.includes('\n\n')) { res.destroy(); resolve(received) }
      })
      res.on('error', () => resolve(received))
      // Create the journal only after the stream is open, exercising the
      // directory-watch fallback picking up the file's appearance.
      writeFileSync(journalPath, '{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}\n')
    }).on('error', reject)
  })
  expect(frame).toContain('"type":"run_start"')
})

test('an unknown route returns 404', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  dashboard = await startDashboardServer({ journalPath })
  const res = await get(dashboard.url + '/nope')
  expect(res.status).toBe(404)
})

test('GET /model against a journalPath that is a directory returns a clean error instead of crashing the process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-dash-')) // journalPath itself IS the directory, not a file inside it
  dashboard = await startDashboardServer({ journalPath: dir })
  const res = await get(dashboard.url + '/model')
  expect(res.status).toBe(500)
  // the server is still alive and serving other routes afterwards
  const health = await get(dashboard.url + '/')
  expect(health.status).toBe(200)
})

test('GET /events against a journalPath that is a directory returns a clean response instead of crashing the process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-dash-'))
  dashboard = await startDashboardServer({ journalPath: dir })
  const res = await get(dashboard.url + '/events')
  expect(res.status).toBe(500)
  // the server is still alive and serving other routes afterwards
  const health = await get(dashboard.url + '/model')
  expect(health.status).toBe(500) // same broken path - still a clean error, not a crash
})

test('the dashboard never writes to the journal file (read-only)', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const before = readFileSync(journalPath, 'utf8')
  dashboard = await startDashboardServer({ journalPath })
  await get(dashboard.url + '/')
  await get(dashboard.url + '/model')
  const after = readFileSync(journalPath, 'utf8')
  expect(after).toBe(before)
})

// --- POST /control: pause/resume/cancel a run's own process ---

test('POST /control refuses to pause the process serving this exact dashboard (looprail run --ui, same-process trap)', async () => {
  // Reproduces the real bug: pausing the process that is ALSO answering
  // this HTTP request would freeze the dashboard itself, with no way to
  // ever send a resume request to it again. Verified by hand before this
  // fix existed - a real `run --ui` process paused this way stopped
  // answering ANY request at all, not just future ones.
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  writeFileSync(join(dirname(journalPath), 'pid'), String(process.pid))
  dashboard = await startDashboardServer({ journalPath })

  const res = await post(dashboard.url + '/control', { action: 'pause' })
  expect(res.status).toBe(400)
  expect(JSON.parse(res.body).error).toMatch(/ui --all/i)
  expect(existsSync(join(dirname(journalPath), 'paused'))).toBe(false)

  // cancel must stay available for the exact same pid - it is not the
  // same trap (run-cmd.ts's SIGTERM handler finishes this very response
  // before the process exits on its own terms), so refusing it too would
  // be over-broad, not just cautious.
  const model = await get(dashboard.url + '/model')
  expect(JSON.parse(model.body).pauseUnsafe).toBe(true)
})

test('POST /control pause stops a real running process without killing it, and /model reflects paused', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const child = spawnDummyProcess()
  await new Promise((r) => setTimeout(r, 50)) // let it actually start
  writeFileSync(join(dirname(journalPath), 'pid'), String(child.pid))
  dashboard = await startDashboardServer({ journalPath })

  const res = await post(dashboard.url + '/control', { action: 'pause' })
  expect(res.status).toBe(200)
  expect(isAlive(child.pid!)).toBe(true)
  expect(existsSync(join(dirname(journalPath), 'paused'))).toBe(true)

  const model = await get(dashboard.url + '/model')
  expect(JSON.parse(model.body).paused).toBe(true)
})

test('POST /control resume clears the paused marker', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const child = spawnDummyProcess()
  await new Promise((r) => setTimeout(r, 50))
  writeFileSync(join(dirname(journalPath), 'pid'), String(child.pid))
  dashboard = await startDashboardServer({ journalPath })

  await post(dashboard.url + '/control', { action: 'pause' })
  const res = await post(dashboard.url + '/control', { action: 'resume' })
  expect(res.status).toBe(200)
  expect(isAlive(child.pid!)).toBe(true)
  expect(existsSync(join(dirname(journalPath), 'paused'))).toBe(false)
})

test('POST /control cancel actually terminates the real process', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const child = spawnDummyProcess()
  await new Promise((r) => setTimeout(r, 50))
  writeFileSync(join(dirname(journalPath), 'pid'), String(child.pid))
  dashboard = await startDashboardServer({ journalPath })

  const res = await post(dashboard.url + '/control', { action: 'cancel' })
  expect(res.status).toBe(200)
  await vi.waitFor(() => expect(isAlive(child.pid!)).toBe(false), { timeout: 2000 })
})

test('POST /control refuses to act once the run is no longer running, regardless of the pid file', async () => {
  const journalPath = journalWith([
    '{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}',
    '{"ts":2,"type":"verified","data":{"reason":"ok","costUsd":0}}',
  ])
  const child = spawnDummyProcess()
  await new Promise((r) => setTimeout(r, 50))
  writeFileSync(join(dirname(journalPath), 'pid'), String(child.pid))
  dashboard = await startDashboardServer({ journalPath })

  const res = await post(dashboard.url + '/control', { action: 'cancel' })
  expect(res.status).toBe(409)
  expect(isAlive(child.pid!)).toBe(true) // never touched
})

test('POST /control 404s cleanly when no pid was ever recorded for this run', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  dashboard = await startDashboardServer({ journalPath })
  const res = await post(dashboard.url + '/control', { action: 'pause' })
  expect(res.status).toBe(404)
})

test('POST /control 409s cleanly when the recorded pid is already gone', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  writeFileSync(join(dirname(journalPath), 'pid'), '999999') // almost certainly unused
  dashboard = await startDashboardServer({ journalPath })
  const res = await post(dashboard.url + '/control', { action: 'pause' })
  expect(res.status).toBe(409)
})

test('POST /control rejects an unknown action with 400', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  dashboard = await startDashboardServer({ journalPath })
  const res = await post(dashboard.url + '/control', { action: 'nuke' })
  expect(res.status).toBe(400)
})

test('POST /control rejects a cross-origin request (CSRF): a malicious page open in another tab cannot pause/cancel a run just by knowing it runs on localhost', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const child = spawnDummyProcess()
  await new Promise((r) => setTimeout(r, 50))
  writeFileSync(join(dirname(journalPath), 'pid'), String(child.pid))
  dashboard = await startDashboardServer({ journalPath })

  const res = await post(dashboard.url + '/control', { action: 'cancel' }, { origin: 'https://evil.example.com' })
  expect(res.status).toBe(403)
  expect(isAlive(child.pid!)).toBe(true) // never touched
})

test('POST /control allows a same-origin request (the real dashboard page calling its own server)', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const child = spawnDummyProcess()
  await new Promise((r) => setTimeout(r, 50))
  writeFileSync(join(dirname(journalPath), 'pid'), String(child.pid))
  dashboard = await startDashboardServer({ journalPath })
  const host = new URL(dashboard.url).host

  const res = await post(dashboard.url + '/control', { action: 'cancel' }, { origin: `http://${host}` })
  expect(res.status).toBe(200)
})

test('POST /control allows a request with no Origin or Referer at all (a script or curl call, not a browser CSRF)', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const child = spawnDummyProcess()
  await new Promise((r) => setTimeout(r, 50))
  writeFileSync(join(dirname(journalPath), 'pid'), String(child.pid))
  dashboard = await startDashboardServer({ journalPath })

  const res = await post(dashboard.url + '/control', { action: 'cancel' })
  expect(res.status).toBe(200)
})

test('GET /model reports controllable:false when no pid file exists, true once one does', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  dashboard = await startDashboardServer({ journalPath })
  const before = await get(dashboard.url + '/model')
  expect(JSON.parse(before.body).controllable).toBe(false)
  writeFileSync(join(dirname(journalPath), 'pid'), String(process.pid))
  const after = await get(dashboard.url + '/model')
  expect(JSON.parse(after.body).controllable).toBe(true)
})

// Real bug caught live: a run killed with SIGKILL (bypassing the SIGTERM
// handler that normally removes the pid file on a graceful stop) leaves an
// orphaned pid file behind - the dashboard kept reporting that dead run as
// controllable forever, since it only checked the FILE's existence, never
// whether the process it names is actually still alive.
test('GET /model reports controllable:false for an orphaned pid file naming a process that no longer exists', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  dashboard = await startDashboardServer({ journalPath })
  // A pid essentially guaranteed not to be a real running process.
  writeFileSync(join(dirname(journalPath), 'pid'), '999999')
  const res = await get(dashboard.url + '/model')
  expect(JSON.parse(res.body).controllable).toBe(false)
})

// Cross-process gate answering (journal/gate-files.ts): the run lives in a
// DIFFERENT process than this dashboard (a detached `run -d`, or a `run
// --ui` viewed from a separate long-lived mission control). Its in-process
// registry is unreachable, so the pending gate is surfaced from the run
// directory's waiting marker and answered by writing the answer file its
// gate handler polls for - honored only while the run's process is alive.
test('GET /model surfaces a pending gate from the waiting marker when the run lives in another (live) process', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const runDir = dirname(journalPath)
  const proc = spawnDummyProcess()
  writeFileSync(join(runDir, 'pid'), String(proc.pid))
  const { writeGateWaitingMarker } = await import('../journal/gate-files.js')
  writeGateWaitingMarker(runDir, { nodeId: 'approve', isPlanApproval: true, question: 'plan ok?' })
  dashboard = await startDashboardServer({ journalPath, getPendingGate: () => undefined })
  const res = await get(dashboard.url + '/model')
  expect(JSON.parse(res.body).pendingGate).toEqual({ nodeId: 'approve', isPlanApproval: true })
})

test('GET /model ignores a waiting marker left behind by a dead process - no phantom approval prompt', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const runDir = dirname(journalPath)
  writeFileSync(join(runDir, 'pid'), '999999')
  const { writeGateWaitingMarker } = await import('../journal/gate-files.js')
  writeGateWaitingMarker(runDir, { nodeId: 'approve', isPlanApproval: false, question: 'q' })
  dashboard = await startDashboardServer({ journalPath, getPendingGate: () => undefined })
  const res = await get(dashboard.url + '/model')
  expect(JSON.parse(res.body).pendingGate).toBeNull()
})

test('POST /control approve-gate falls back to writing the answer file for a gate waiting in another live process', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const runDir = dirname(journalPath)
  const proc = spawnDummyProcess()
  writeFileSync(join(runDir, 'pid'), String(proc.pid))
  const { consumeGateAnswer, writeGateWaitingMarker } = await import('../journal/gate-files.js')
  writeGateWaitingMarker(runDir, { nodeId: 'approve', isPlanApproval: false, question: 'q' })
  dashboard = await startDashboardServer({ journalPath, getPendingGate: () => undefined })
  const res = await post(dashboard.url + '/control', { action: 'approve-gate' })
  expect(res.status).toBe(200)
  expect(consumeGateAnswer(runDir)).toEqual({ approved: true })
})

test('POST /control reject-gate delivers the feedback text through the answer file too', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const runDir = dirname(journalPath)
  const proc = spawnDummyProcess()
  writeFileSync(join(runDir, 'pid'), String(proc.pid))
  const { consumeGateAnswer, writeGateWaitingMarker } = await import('../journal/gate-files.js')
  writeGateWaitingMarker(runDir, { nodeId: 'approve', isPlanApproval: false, question: 'q' })
  dashboard = await startDashboardServer({ journalPath, getPendingGate: () => undefined })
  const res = await post(dashboard.url + '/control', { action: 'reject-gate', text: 'needs a held-out tester' })
  expect(res.status).toBe(200)
  expect(consumeGateAnswer(runDir)).toEqual({ approved: false, feedback: 'needs a held-out tester' })
})

test('POST /control approve-gate still 409s when the marker belongs to a dead process - never strands an answer file', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const runDir = dirname(journalPath)
  writeFileSync(join(runDir, 'pid'), '999999')
  const { consumeGateAnswer, writeGateWaitingMarker } = await import('../journal/gate-files.js')
  writeGateWaitingMarker(runDir, { nodeId: 'approve', isPlanApproval: false, question: 'q' })
  dashboard = await startDashboardServer({ journalPath, getPendingGate: () => undefined })
  const res = await post(dashboard.url + '/control', { action: 'approve-gate' })
  expect(res.status).toBe(409)
  expect(consumeGateAnswer(runDir)).toBeUndefined()
})

test('POST /control feedback queues a human note readable by drainHumanFeedback, while the run is running', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  dashboard = await startDashboardServer({ journalPath })
  const res = await post(dashboard.url + '/control', { action: 'feedback', text: 'check the empty-list case' })
  expect(res.status).toBe(200)
  const { drainHumanFeedback } = await import('../journal/human-feedback.js')
  expect(drainHumanFeedback(dirname(journalPath))).toBe('check the empty-list case')
})

test('POST /control feedback rejects an empty or missing note with 400', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  dashboard = await startDashboardServer({ journalPath })
  const empty = await post(dashboard.url + '/control', { action: 'feedback', text: '   ' })
  expect(empty.status).toBe(400)
  const missing = await post(dashboard.url + '/control', { action: 'feedback' })
  expect(missing.status).toBe(400)
})

test('POST /control feedback refuses to act once the run is no longer running', async () => {
  const journalPath = journalWith([
    '{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}',
    '{"ts":2,"type":"verified","data":{"reason":"all verifiers passed","costUsd":0}}',
  ])
  dashboard = await startDashboardServer({ journalPath })
  const res = await post(dashboard.url + '/control', { action: 'feedback', text: 'too late' })
  expect(res.status).toBe(409)
})

// Fakes the same PendingGate shape src/dashboard/gate-registry.ts's real
// registry holds, letting these tests drive a real HTTP request against a
// real started server and prove the underlying GateHandler's promise
// actually resolves - not merely that some value got written somewhere.
function fakePendingGateStore() {
  const gates = new Map<string, import('./gate-registry.js').PendingGate>()
  const resolved: { runId: string; nodeId: string; answer: import('../core/types.js').GateAnswer }[] = []
  return {
    gates,
    resolved,
    getPendingGate: (runId: string) => {
      for (const g of gates.values()) if (g.runId === runId) return g
      return undefined
    },
    resolvePendingGate: (runId: string, nodeId: string, answer: import('../core/types.js').GateAnswer) => {
      const key = `${runId}:${nodeId}`
      const pending = gates.get(key)
      if (!pending) return false
      gates.delete(key)
      resolved.push({ runId, nodeId, answer })
      pending.resolve(answer)
      return true
    },
  }
}

test('POST /control approve-gate resolves the awaited gate promise with {approved:true}', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const store = fakePendingGateStore()
  const awaited = new Promise((resolve) => {
    store.gates.set('r:plan', { resolve, question: 'approve the plan?', nodeId: 'plan', runId: 'r', isPlanApproval: false })
  })
  dashboard = await startDashboardServer({
    journalPath, getPendingGate: store.getPendingGate, resolvePendingGate: store.resolvePendingGate,
  })
  const res = await post(dashboard.url + '/control', { action: 'approve-gate' })
  expect(res.status).toBe(200)
  await expect(awaited).resolves.toEqual({ approved: true })
})

test('POST /control reject-gate resolves the awaited gate promise with {approved:false,feedback}', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const store = fakePendingGateStore()
  const awaited = new Promise((resolve) => {
    store.gates.set('r:plan', { resolve, question: 'approve the plan?', nodeId: 'plan', runId: 'r', isPlanApproval: true })
  })
  dashboard = await startDashboardServer({
    journalPath, getPendingGate: store.getPendingGate, resolvePendingGate: store.resolvePendingGate,
  })
  const res = await post(dashboard.url + '/control', { action: 'reject-gate', text: 'split verifier into two nodes' })
  expect(res.status).toBe(200)
  await expect(awaited).resolves.toEqual({ approved: false, feedback: 'split verifier into two nodes' })
})

test('POST /control reject-gate 400s on missing or empty feedback text', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const store = fakePendingGateStore()
  store.gates.set('r:plan', { resolve: () => {}, question: 'q', nodeId: 'plan', runId: 'r', isPlanApproval: false })
  dashboard = await startDashboardServer({
    journalPath, getPendingGate: store.getPendingGate, resolvePendingGate: store.resolvePendingGate,
  })
  const missing = await post(dashboard.url + '/control', { action: 'reject-gate' })
  expect(missing.status).toBe(400)
  const empty = await post(dashboard.url + '/control', { action: 'reject-gate', text: '   ' })
  expect(empty.status).toBe(400)
  expect(store.resolved).toEqual([])
})

test('POST /control approve-gate/reject-gate 409s when no gate is currently waiting for this run', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const store = fakePendingGateStore()
  dashboard = await startDashboardServer({
    journalPath, getPendingGate: store.getPendingGate, resolvePendingGate: store.resolvePendingGate,
  })
  const approve = await post(dashboard.url + '/control', { action: 'approve-gate' })
  expect(approve.status).toBe(409)
  const reject = await post(dashboard.url + '/control', { action: 'reject-gate', text: 'nope' })
  expect(reject.status).toBe(409)
})

test('POST /control approve-gate/reject-gate 403s on cross-origin requests', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const store = fakePendingGateStore()
  store.gates.set('r:plan', { resolve: () => {}, question: 'q', nodeId: 'plan', runId: 'r', isPlanApproval: false })
  dashboard = await startDashboardServer({
    journalPath, getPendingGate: store.getPendingGate, resolvePendingGate: store.resolvePendingGate,
  })
  const res = await post(dashboard.url + '/control', { action: 'approve-gate' }, { origin: 'http://evil.example' })
  expect(res.status).toBe(403)
  expect(store.resolved).toEqual([])
})

test('POST /control approve-gate/reject-gate 409s once the run is no longer running', async () => {
  const journalPath = journalWith([
    '{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}',
    '{"ts":2,"type":"verified","data":{"reason":"all verifiers passed","costUsd":0}}',
  ])
  const store = fakePendingGateStore()
  store.gates.set('r:plan', { resolve: () => {}, question: 'q', nodeId: 'plan', runId: 'r', isPlanApproval: false })
  dashboard = await startDashboardServer({
    journalPath, getPendingGate: store.getPendingGate, resolvePendingGate: store.resolvePendingGate,
  })
  const res = await post(dashboard.url + '/control', { action: 'approve-gate' })
  expect(res.status).toBe(409)
})

test('GET /model exposes pendingGate:null when no gate is waiting, and the pending gate details when one is', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const store = fakePendingGateStore()
  dashboard = await startDashboardServer({
    journalPath, getPendingGate: store.getPendingGate, resolvePendingGate: store.resolvePendingGate,
  })
  const before = await get(dashboard.url + '/model')
  expect(JSON.parse(before.body).pendingGate).toBeNull()

  store.gates.set('r:plan', { resolve: () => {}, question: 'approve the plan?', nodeId: 'plan', runId: 'r', isPlanApproval: true })
  const after = await get(dashboard.url + '/model')
  expect(JSON.parse(after.body).pendingGate).toEqual({ nodeId: 'plan', isPlanApproval: true })
})

test('POST /resume 501s cleanly when this dashboard has no onResume wired up', async () => {
  const journalPath = journalWith([
    '{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}',
    '{"ts":2,"type":"halt","data":{"reason":"rail breached (iterations): iteration 2 exceeds max 1","costUsd":0}}',
  ])
  dashboard = await startDashboardServer({ journalPath })
  const res = await post(dashboard.url + '/resume', {})
  expect(res.status).toBe(501)
})

test('POST /resume 409s when the run is not halted (still running, or already verified)', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const onResume = vi.fn(async () => {})
  dashboard = await startDashboardServer({ journalPath, onResume })
  const res = await post(dashboard.url + '/resume', {})
  expect(res.status).toBe(409)
  expect(onResume).not.toHaveBeenCalled()
})

test('POST /resume validates maxIterations/maxCostUsd before calling onResume', async () => {
  const journalPath = journalWith([
    '{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}',
    '{"ts":2,"type":"halt","data":{"reason":"rail breached (iterations): iteration 2 exceeds max 1","costUsd":0}}',
  ])
  const onResume = vi.fn(async () => {})
  dashboard = await startDashboardServer({ journalPath, onResume })
  const badIterations = await post(dashboard.url + '/resume', { maxIterations: -1 })
  expect(badIterations.status).toBe(400)
  const badCost = await post(dashboard.url + '/resume', { maxCostUsd: 'nope' })
  expect(badCost.status).toBe(400)
  const badWallMinutes = await post(dashboard.url + '/resume', { maxWallMinutes: -1 })
  expect(badWallMinutes.status).toBe(400)
  const badReplanLimit = await post(dashboard.url + '/resume', { replanLimit: -1 })
  expect(badReplanLimit.status).toBe(400)
  const badGoalType = await post(dashboard.url + '/resume', { goal: 123 })
  expect(badGoalType.status).toBe(400)
  const badGoalEmpty = await post(dashboard.url + '/resume', { goal: '   ' })
  expect(badGoalEmpty.status).toBe(400)
  expect(onResume).not.toHaveBeenCalled()
})

test('POST /resume on a halted run calls onResume with the parsed overrides and responds before it resolves', async () => {
  const journalPath = journalWith([
    '{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}',
    '{"ts":2,"type":"halt","data":{"reason":"rail breached (iterations): iteration 2 exceeds max 1","costUsd":0}}',
  ])
  let resolveResume: () => void = () => {}
  const resumeStarted = new Promise<void>((resolve) => { resolveResume = resolve })
  const onResume = vi.fn(async (overrides: { maxIterations?: number; maxCostUsd?: number; maxWallMinutes?: number; replanLimit?: number; goal?: string }) => {
    resolveResume()
    expect(overrides).toEqual({ maxIterations: 5, maxCostUsd: 2, maxWallMinutes: 30, replanLimit: 4, goal: 'a clearer goal' })
  })
  dashboard = await startDashboardServer({ journalPath, onResume })
  const res = await post(dashboard.url + '/resume', { maxIterations: 5, maxCostUsd: 2, maxWallMinutes: 30, replanLimit: 4, goal: 'a clearer goal' })
  expect(res.status).toBe(200)
  await resumeStarted
  expect(onResume).toHaveBeenCalledTimes(1)
})

test('POST /resume rejects a cross-origin request (same CSRF protection as /control)', async () => {
  const journalPath = journalWith([
    '{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}',
    '{"ts":2,"type":"halt","data":{"reason":"halted","costUsd":0}}',
  ])
  const onResume = vi.fn(async () => {})
  dashboard = await startDashboardServer({ journalPath, onResume })
  const res = await post(dashboard.url + '/resume', {}, { origin: 'https://evil.example.com' })
  expect(res.status).toBe(403)
  expect(onResume).not.toHaveBeenCalled()
})

test('GET /model reports totals.maxIterations/maxCostUsd from the loopfile and resumable only when halted with onResume wired up', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const def = {
    name: 'n', goal: 'g', agents: {}, nodes: [],
    rails: { maxIterations: 4, maxCostUsd: 1.5 }, verdictPolicy: { kind: 'all-pass' as const },
  }
  dashboard = await startDashboardServer({ journalPath, def, onResume: async () => {} })
  const runningPayload = JSON.parse((await get(dashboard.url + '/model')).body)
  expect(runningPayload.totals.maxIterations).toBe(4)
  expect(runningPayload.totals.maxCostUsd).toBe(1.5)
  expect(runningPayload.resumable).toBe(false) // still running - nothing to resume yet

  appendFileSync(journalPath, '{"ts":2,"type":"halt","data":{"reason":"halted","costUsd":0}}\n')
  const haltedPayload = JSON.parse((await get(dashboard.url + '/model')).body)
  expect(haltedPayload.resumable).toBe(true)
})

test('GET /model reports totals.maxWallMinutes from the loopfile', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const def = {
    name: 'n', goal: 'g', agents: {}, nodes: [],
    rails: { maxWallMinutes: 45 }, verdictPolicy: { kind: 'all-pass' as const },
  }
  dashboard = await startDashboardServer({ journalPath, def, onResume: async () => {} })
  const payload = JSON.parse((await get(dashboard.url + '/model')).body)
  expect(payload.totals.maxWallMinutes).toBe(45)
})

test('GET /model reports totals.replanLimit from the loopfile', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const def = {
    name: 'n', goal: 'g', agents: {}, nodes: [],
    rails: { replanLimit: 6 }, verdictPolicy: { kind: 'all-pass' as const },
  }
  dashboard = await startDashboardServer({ journalPath, def, onResume: async () => {} })
  const payload = JSON.parse((await get(dashboard.url + '/model')).body)
  expect(payload.totals.replanLimit).toBe(6)
})

test('startDashboardServer binds to an explicit port when given one', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const port = 41567
  dashboard = await startDashboardServer({ journalPath, port })
  expect(dashboard.url).toBe(`http://127.0.0.1:${port}`)
})

test('startDashboardServer rejects with a clear error when the requested port is already taken', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const port = 41568
  dashboard = await startDashboardServer({ journalPath, port })
  await expect(startDashboardServer({ journalPath, port })).rejects.toThrow(/port 41568 is already in use/)
})


// Fakes the same PendingPermission shape src/dashboard/permission-registry.ts's
// real registry holds, letting these tests drive a real HTTP request against
// a real started server and prove the underlying onPermission promise
// actually resolves - not merely that some value got written somewhere.
function fakePendingPermissionStore() {
  const permissions = new Map<string, import('./permission-registry.js').PendingPermission>()
  const resolved: { runId: string; nodeId: string; answer: string }[] = []
  return {
    permissions,
    resolved,
    getPendingPermission: (runId: string) => {
      for (const p of permissions.values()) if (p.runId === runId) return p
      return undefined
    },
    resolvePendingPermission: (runId: string, nodeId: string, answer: string) => {
      const key = `${runId}:${nodeId}`
      const pending = permissions.get(key)
      if (!pending) return false
      permissions.delete(key)
      resolved.push({ runId, nodeId, answer })
      pending.resolve(answer)
      return true
    },
  }
}

test('POST /control answer-permission approved:true resolves the awaited permission promise with an answer parsePermissionAnswer reads as approved', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const store = fakePendingPermissionStore()
  const awaited = new Promise((resolve) => {
    store.permissions.set('r:do', { resolve, question: 'allow write?', nodeId: 'do', runId: 'r' })
  })
  dashboard = await startDashboardServer({
    journalPath, getPendingPermission: store.getPendingPermission, resolvePendingPermission: store.resolvePendingPermission,
  })
  const res = await post(dashboard.url + '/control', { action: 'answer-permission', nodeId: 'do', approved: true })
  expect(res.status).toBe(200)
  const answer = await awaited
  const { parsePermissionAnswer } = await import('../engine/runner.js')
  expect(parsePermissionAnswer(answer as string)).toEqual({ approved: true })
})

test('POST /control answer-permission approved:false with feedback resolves with an answer parsePermissionAnswer reads as rejection+feedback', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const store = fakePendingPermissionStore()
  const awaited = new Promise((resolve) => {
    store.permissions.set('r:do', { resolve, question: 'allow write?', nodeId: 'do', runId: 'r' })
  })
  dashboard = await startDashboardServer({
    journalPath, getPendingPermission: store.getPendingPermission, resolvePendingPermission: store.resolvePendingPermission,
  })
  const res = await post(dashboard.url + '/control', {
    action: 'answer-permission', nodeId: 'do', approved: false, text: 'do not touch that file',
  })
  expect(res.status).toBe(200)
  const answer = await awaited
  const { parsePermissionAnswer } = await import('../engine/runner.js')
  expect(parsePermissionAnswer(answer as string)).toEqual({ approved: false, feedback: 'do not touch that file' })
})

test('POST /control answer-permission 409s when no permission is currently waiting for that node', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const store = fakePendingPermissionStore()
  dashboard = await startDashboardServer({
    journalPath, getPendingPermission: store.getPendingPermission, resolvePendingPermission: store.resolvePendingPermission,
  })
  const res = await post(dashboard.url + '/control', { action: 'answer-permission', nodeId: 'do', approved: true })
  expect(res.status).toBe(409)
  expect(store.resolved).toEqual([])
})

test('POST /control answer-permission 400s when nodeId or approved is missing/malformed', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const store = fakePendingPermissionStore()
  store.permissions.set('r:do', { resolve: () => {}, question: 'q', nodeId: 'do', runId: 'r' })
  dashboard = await startDashboardServer({
    journalPath, getPendingPermission: store.getPendingPermission, resolvePendingPermission: store.resolvePendingPermission,
  })
  const missingNodeId = await post(dashboard.url + '/control', { action: 'answer-permission', approved: true })
  expect(missingNodeId.status).toBe(400)
  const missingApproved = await post(dashboard.url + '/control', { action: 'answer-permission', nodeId: 'do' })
  expect(missingApproved.status).toBe(400)
  expect(store.resolved).toEqual([])
})

test('POST /control answer-permission 403s on cross-origin requests', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const store = fakePendingPermissionStore()
  store.permissions.set('r:do', { resolve: () => {}, question: 'q', nodeId: 'do', runId: 'r' })
  dashboard = await startDashboardServer({
    journalPath, getPendingPermission: store.getPendingPermission, resolvePendingPermission: store.resolvePendingPermission,
  })
  const res = await post(
    dashboard.url + '/control', { action: 'answer-permission', nodeId: 'do', approved: true }, { origin: 'http://evil.example' },
  )
  expect(res.status).toBe(403)
  expect(store.resolved).toEqual([])
})

test('POST /control answer-permission 409s once the run is no longer running', async () => {
  const journalPath = journalWith([
    '{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}',
    '{"ts":2,"type":"verified","data":{"reason":"all verifiers passed","costUsd":0}}',
  ])
  const store = fakePendingPermissionStore()
  store.permissions.set('r:do', { resolve: () => {}, question: 'q', nodeId: 'do', runId: 'r' })
  dashboard = await startDashboardServer({
    journalPath, getPendingPermission: store.getPendingPermission, resolvePendingPermission: store.resolvePendingPermission,
  })
  const res = await post(dashboard.url + '/control', { action: 'answer-permission', nodeId: 'do', approved: true })
  expect(res.status).toBe(409)
})
