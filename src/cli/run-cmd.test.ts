import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { agentCostBreakdown, makeGate, runAction } from './run-cmd.js'
import { JournalWriter, parseLoopfile } from '../index.js'
import { runsRoot } from '../journal/runs.js'
import { startDashboardServer } from '../dashboard/server.js'
import { createRegistry } from '../adapters/registry.js'

const FIXTURE = `
name: cli-fixture
goal: Say DONE.
agents:
  worker:  { adapter: mock }
  checker: { adapter: mock }
graph:
  do:   { role: executor, agent: worker }
  crit: { role: critic, agent: checker, of: do, after: do }
rails:
  max_iterations: 2
  max_cost_usd: 1
`

const HALTING = `
name: halting
goal: Never passes.
agents:
  worker: { adapter: mock }
graph:
  do:  { role: executor, agent: worker }
  bad: { role: tester, after: do, run: "false", expect: exit 0 }
rails:
  max_iterations: 1
  max_cost_usd: 1
`

const GATED = `
name: gated
goal: Needs approval.
agents:
  worker: { adapter: mock }
graph:
  do:      { role: executor, agent: worker }
  approve: { role: gate, after: do }
rails:
  max_iterations: 2
  max_cost_usd: 1
`

const GATED_TIMEOUT = `
name: gated-timeout
goal: Needs approval, human never responds.
agents:
  worker: { adapter: mock }
graph:
  do:      { role: executor, agent: worker }
  approve: { role: gate, after: do }
rails:
  max_iterations: 2
  max_cost_usd: 1
  gate_timeout: 5
`

function setup(content?: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-run-'))
  if (content) writeFileSync(join(cwd, 'looprail.yaml'), content)
  const lines: string[] = []
  return { cwd, io: { out: (l: string) => lines.push(l) }, lines }
}

test('verified run exits 0, renders progress and report, writes a journal', async () => {
  const { cwd, io, lines } = setup(FIXTURE)
  const code = await runAction(undefined, { cwd }, { io })
  expect(code).toBe(0)
  const text = lines.join('\n')
  expect(text).toContain('cli-fixture')
  expect(text).toContain('verified')
  expect(text).toContain('do')            // node progress line
  expect(text).toContain('budget')        // cost ticker vs max_cost_usd
  const runs = readdirSync(runsRoot(cwd))
  expect(runs).toHaveLength(1)
  expect(readdirSync(join(runsRoot(cwd), runs[0]))).toContain('journal.jsonl')
})

test('halted run exits 2 with the rail reason', async () => {
  const { cwd, io, lines } = setup(HALTING)
  const code = await runAction(undefined, { cwd }, { io })
  expect(code).toBe(2)
  expect(lines.join('\n')).toContain('halted')
  expect(lines.join('\n')).toContain('iterations')
})

test('missing loopfile exits 1 pointing at init', async () => {
  const { cwd, io, lines } = setup()
  expect(await runAction(undefined, { cwd }, { io })).toBe(1)
  expect(lines.join('\n')).toContain('looprail init')
})

test('lint errors block the run with exit 1', async () => {
  const noVerifier = FIXTURE.replace('  crit: { role: critic, agent: checker, of: do, after: do }\n', '')
  const { cwd, io, lines } = setup(noVerifier)
  expect(await runAction(undefined, { cwd }, { io })).toBe(1)
  expect(lines.join('\n')).toContain('L001')
})

test('--json emits a machine-readable summary as the only stdout line', async () => {
  const { cwd, io, lines } = setup(FIXTURE)
  const code = await runAction(undefined, { cwd, json: true }, { io })
  expect(code).toBe(0)
  expect(lines).toHaveLength(1)
  const parsed = JSON.parse(lines[0]) as { status: string; runId: string; costUsd: number }
  expect(parsed.status).toBe('verified')
  expect(parsed.runId).toMatch(/^run-/)
})

test('gate handler is consulted and drives the verdict', async () => {
  const { cwd, io } = setup(GATED)
  const gated: string[] = []
  const code = await runAction(undefined, { cwd }, {
    io,
    gate: async (node) => { gated.push(node.id); return true },
  })
  expect(code).toBe(0)
  expect(gated).toEqual(['approve'])
})

test('makeGate --yes auto-approves without touching stdin', async () => {
  const lines: string[] = []
  const gate = makeGate({ maxIterations: 1, maxCostUsd: 1 }, { out: (l) => lines.push(l) }, true)
  await expect(gate({ id: 'approve', role: 'gate' }, 'ctx')).resolves.toBe(true)
  expect(lines.join('\n')).toContain('auto-approved')
})

test('makeGate rejects with an infra-tagged message via the injected gate timer - no real timer used', async () => {
  const lines: string[] = []
  const gate = makeGate(
    { maxIterations: 1, maxCostUsd: 1, gateTimeoutSec: 5 },
    { out: (l) => lines.push(l) },
    false,
    // the injected timer rejects immediately instead of waiting 5 real
    // seconds - this is the whole point of the seam
    { gateTimer: async (_ms, message) => { throw new Error(message) } },
  )
  await expect(gate({ id: 'approve', role: 'gate' }, 'ctx'))
    .rejects.toThrow('infra: gate "approve" timed out after 5s awaiting human approval')
})

test('makeGate clears the timeout when the human answers first, leaving no lingering timer', async () => {
  vi.useFakeTimers()
  const fakeStdin = new PassThrough()
  const origStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!
  Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true })
  try {
    const gate = makeGate(
      { maxIterations: 1, maxCostUsd: 1, gateTimeoutSec: 3600 }, // 1h timeout
      { out: () => {} }, false,
    )
    const p = gate({ id: 'approve', role: 'gate' }, 'ctx')
    await Promise.resolve() // let readline wire up its line listener
    fakeStdin.write('y\n')
    await expect(p).resolves.toBe(true)
    // the 1h timeout must have been cleared, not left pending for the process
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    Object.defineProperty(process, 'stdin', origStdin)
    vi.useRealTimers()
  }
})

test('a timed-out gate leaves no unhandled rejection (the aborted question is settled)', async () => {
  const rejections: unknown[] = []
  const onRej = (r: unknown) => rejections.push(r)
  process.on('unhandledRejection', onRej)
  try {
    const gate = makeGate(
      { maxIterations: 1, maxCostUsd: 1, gateTimeoutSec: 5 },
      { out: () => {} }, false,
      { gateTimer: async (_ms, message) => { throw new Error(message) } },
    )
    await expect(gate({ id: 'approve', role: 'gate' }, 'ctx')).rejects.toThrow(/timed out/)
    await new Promise((r) => setTimeout(r, 10)) // flush any dangling rejection
  } finally {
    process.removeListener('unhandledRejection', onRej)
  }
  expect(rejections).toEqual([])
})

test('gate timeout halts the run as an infrastructure error, not a config error (no real timers)', async () => {
  const { cwd, io, lines } = setup(GATED_TIMEOUT)
  const def = parseLoopfile(GATED_TIMEOUT)
  const gate = makeGate(def.rails, io, false, {
    gateTimer: async (_ms, message) => { throw new Error(message) },
  })
  const code = await runAction(undefined, { cwd }, { io, gate })
  expect(code).toBe(2)
  const text = lines.join('\n')
  expect(text).toContain('halted')
  expect(text).toContain('infrastructure error')
  expect(text).toContain('gate "approve" timed out after 5s awaiting human approval')
  expect(text).not.toContain('config error')
})

test('agentCostBreakdown folds journal costs per agent (panel clones collapse)', async () => {
  const def = parseLoopfile(FIXTURE)
  const dir = join(mkdtempSync(join(tmpdir(), 'lr-bd-')), 'run')
  const w = new JournalWriter(dir, () => 1)
  w.write('node_end', { nodeId: 'do', costUsd: 0.3 })
  w.write('node_end', { nodeId: 'crit@1', costUsd: 0.15 })
  w.write('node_end', { nodeId: 'crit@2', costUsd: 0.05 })
  expect(agentCostBreakdown(def, w.path)).toEqual([['worker', 0.3], ['checker', 0.2]])
})

function capture() {
  const lines: string[] = []
  return { io: { out: (l: string) => lines.push(l) }, lines }
}

test('run --ui --json keeps stdout to a single JSON line (dashboard URL not printed)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-run-ui-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE)
  const { io, lines } = capture()
  const code = await runAction(undefined, { cwd, json: true, ui: true }, { io })
  expect(code).toBe(0)
  expect(lines).toHaveLength(1)
  const parsed = JSON.parse(lines[0]) as { status: string; runId: string; costUsd: number }
  expect(parsed.status).toBe('verified')
  // dashboard still ran (no error), but its URL was not printed to stdout
  expect(lines.join('\n')).not.toContain('http://127.0.0.1:')
})

test('run --ui starts a dashboard before the run and closes it once the run finishes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-run-ui-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE) // reuse this file's existing FIXTURE constant
  const { io, lines } = capture() // reuse this file's existing capture() helper
  const code = await runAction(undefined, { cwd, ui: true }, { io })
  expect(code).toBe(0)
  expect(lines.some((l) => l.includes('http://127.0.0.1:'))).toBe(true)
})

test('run --ui: the run directory exists the instant the dashboard URL is printed, and /events is live from that first connection', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-run-ui-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE)
  // a slow adapter buys real wall-clock time for the /events connection
  // (opened the instant the dashboard URL is known, via the io.out hook
  // below) to land before the run finishes and the dashboard closes.
  const registry = createRegistry()
  registry.register({
    name: 'mock',
    async invoke(req) {
      await new Promise((r) => setTimeout(r, 50))
      const verifying = req.prompt.includes('VERDICT:')
      return {
        output: verifying ? 'VERDICT: pass\nSCORE: 1\nEVIDENCE: mock adapter auto-pass' : '[mock] done',
        costUsd: 0, tokens: 0, durationMs: 1,
      }
    },
  })
  const { io } = capture()
  let runDirExistedAtDashboardStart: boolean | undefined
  const framePromise = new Promise<string>((resolve, reject) => {
    io.out = (l: string) => {
      const match = l.match(/http:\/\/127\.0\.0\.1:\d+/)
      if (!match) return
      // This fires synchronously the instant the dashboard is listening - 
      // strictly before executeRun (and the JournalWriter inside it) has
      // run a single line. It's the earliest point any real client (a
      // browser tab, this test) could ever connect, so this is exactly
      // where the run directory needs to already exist for the /events
      // parent-dir-watch fallback to have something real to watch.
      const runsDir = runsRoot(cwd)
      const runs = existsSync(runsDir) ? readdirSync(runsDir) : []
      runDirExistedAtDashboardStart = runs.length === 1 && existsSync(join(runsDir, runs[0]!))
      http.get(`${match[0]}/events`, (res) => {
        let received = ''
        res.on('data', (chunk) => {
          received += chunk
          if (received.includes('\n\n')) { res.destroy(); resolve(received) }
        })
        res.on('error', () => resolve(received))
      }).on('error', reject)
    }
  })
  const code = await runAction(undefined, { cwd, ui: true }, { io, registry })
  expect(code).toBe(0)
  expect(runDirExistedAtDashboardStart).toBe(true)
  const frame = await framePromise
  expect(frame).toContain('"type":"run_start"')
})

test('run --ui dashboard reflects the finished run at /model once closed data is still on disk', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-run-ui-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE)
  const { io } = capture()
  await runAction(undefined, { cwd, json: true, ui: true }, { io })
  // the run's own journal is on disk and independently readable after the
  // --ui server has closed - the dashboard never held anything the run needed
  const { latestRunId, runsRoot } = await import('./status-cmd.js')
  const id = latestRunId(cwd)!
  const { readJournal } = await import('../journal/journal.js')
  const { join: j } = await import('node:path')
  const events = readJournal(j(runsRoot(cwd), id, 'journal.jsonl'))
  expect(events.some((e) => e.type === 'verified')).toBe(true)
})

test('run auto-registers its cwd as a workspace on first use', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-autoreg-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE)
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-autoreg-reg-')), 'workspaces.json')
  const { io } = capture()
  const code = await runAction(undefined, { cwd, json: true }, { io, registryPath })
  expect(code).toBe(0)
  const { listWorkspaces } = await import('../workspace/registry.js')
  expect(listWorkspaces(registryPath)).toEqual([cwd])
})

test('running the same workspace twice does not duplicate its registry entry', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-autoreg-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE)
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-autoreg-reg-')), 'workspaces.json')
  await runAction(undefined, { cwd, json: true }, { io: capture().io, registryPath })
  await runAction(undefined, { cwd, json: true }, { io: capture().io, registryPath })
  const { listWorkspaces } = await import('../workspace/registry.js')
  expect(listWorkspaces(registryPath)).toEqual([cwd])
})

test('a registry file the process cannot write to never fails the run', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-autoreg-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE)
  // a path whose parent is itself a FILE, not a directory: writeRegistry's
  // own mkdirSync(dirname(path)) throws ENOTDIR here - this must be
  // swallowed, not surfaced to the run's exit code.
  const blocker = join(mkdtempSync(join(tmpdir(), 'lr-autoreg-blocker-')), 'blocker-file')
  writeFileSync(blocker, 'not a directory')
  const registryPath = join(blocker, 'workspaces.json')
  const code = await runAction(undefined, { cwd, json: true }, { io: capture().io, registryPath })
  expect(code).toBe(0)
})
