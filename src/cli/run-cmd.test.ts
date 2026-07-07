import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, test, vi } from 'vitest'
import {
  agentCostBreakdown, agentEstimatedCostBreakdown, makeDetachedGate, makeGate, makeUiGate, readGateWaitingMarker, runAction,
} from './run-cmd.js'
import { JournalWriter, MockAdapter, parseLoopfile } from '../index.js'
import { runsRoot } from '../journal/runs.js'
import { loadRunLoopDef } from '../journal/loopfile-persist.js'
import { hasStoredApproval, storeApproval } from '../journal/gate-approvals.js'
import { buildViewModel } from '../dashboard/view-model.js'
import { createRegistry } from '../adapters/registry.js'
import type { NodeDef } from '../core/types.js'
import { getPendingGate, resolvePendingGate } from '../dashboard/gate-registry.js'

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

test('a run records its own pid while active, then removes it once the run finishes', async () => {
  // A stale pid left behind after the process that owned it exits is a real
  // safety issue, not just clutter: `looprail resume`/`replay` on this same
  // run directory does not write its own pid, so a leftover one would tell
  // the dashboard there is still something here to pause or cancel - and
  // after enough real time, that pid can be reassigned by the OS to a
  // completely unrelated process. Uses the gated fixture so there is a real
  // point mid-run to check the pid file exists, not just before/after.
  const { cwd, io } = setup(GATED)
  let pidDuringRun: string | undefined
  await runAction(undefined, { cwd }, {
    io,
    gate: async () => {
      const runs = readdirSync(runsRoot(cwd))
      pidDuringRun = readFileSync(join(runsRoot(cwd), runs[0], 'pid'), 'utf8').trim()
      return true
    },
  })
  expect(Number(pidDuringRun)).toBe(process.pid)
  const runs = readdirSync(runsRoot(cwd))
  expect(existsSync(join(runsRoot(cwd), runs[0], 'pid'))).toBe(false)
})

test('canceling a run (SIGTERM) also removes its pid file, not just process.exit paths', async () => {
  const { cwd, io } = setup(GATED)
  const done = runAction(undefined, { cwd }, {
    io,
    gate: () => new Promise(() => {}), // never resolves - the run stays open until canceled
  })
  await new Promise((r) => setTimeout(r, 20)) // let runAction reach the pid-writing point
  const runs = readdirSync(runsRoot(cwd))
  const pidPath = join(runsRoot(cwd), runs[0], 'pid')
  expect(existsSync(pidPath)).toBe(true)

  const realExit = process.exit
  // capture, but do not actually let it terminate the test worker
  process.exit = ((code?: number) => { throw new ProcessExitStub(code) }) as never
  try {
    process.emit('SIGTERM')
  } catch (e) {
    expect(e).toBeInstanceOf(ProcessExitStub)
  } finally {
    process.exit = realExit
  }
  expect(existsSync(pidPath)).toBe(false)
  void done.catch(() => {}) // this run never naturally completes; avoid an unhandled rejection warning
})

class ProcessExitStub extends Error {
  constructor(public code?: number) { super(`process.exit(${code})`) }
}

test('running many times in one process never leaks a SIGTERM listener past its own run', async () => {
  const before = process.listenerCount('SIGTERM')
  for (let i = 0; i < 5; i++) {
    const { cwd, io } = setup(FIXTURE)
    await runAction(undefined, { cwd }, { io })
  }
  expect(process.listenerCount('SIGTERM')).toBe(before)
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

test('--json surfaces estimatedCostUsd as a distinct field, never folded into costUsd', async () => {
  const { cwd, io, lines } = setup(FIXTURE)
  const registry = createRegistry()
  registry.register(new MockAdapter([
    { output: '[mock] estimate-only executor', costUsd: 0, estimatedCostUsd: 0.05 },
    { output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0, estimatedCostUsd: 0.02 },
  ]))
  const code = await runAction(undefined, { cwd, json: true }, { io, registry })
  expect(code).toBe(0)
  const parsed = JSON.parse(lines[0]) as { costUsd: number; estimatedCostUsd: number }
  expect(parsed.costUsd).toBe(0)
  expect(parsed.estimatedCostUsd).toBeCloseTo(0.07)
})

test('the human-readable report labels estimated spend as "est", separate from real cost', async () => {
  const { cwd, io, lines } = setup(FIXTURE)
  const registry = createRegistry()
  registry.register(new MockAdapter([
    { output: '[mock] estimate-only executor', costUsd: 0, estimatedCostUsd: 0.05 },
    { output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0, estimatedCostUsd: 0.02 },
  ]))
  const code = await runAction(undefined, { cwd }, { io, registry })
  expect(code).toBe(0)
  const text = lines.join('\n')
  expect(text).toContain('total cost: $0.00')
  expect(text).toContain('est')
  expect(text).toMatch(/~\$0\.07 est/)
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
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const gate = makeGate({ maxIterations: 1, maxCostUsd: 1 }, { out: (l) => lines.push(l) }, true, cwd)
  await expect(gate({ id: 'approve', role: 'gate' }, 'ctx')).resolves.toEqual({ approved: true })
  expect(lines.join('\n')).toContain('auto-approved')
})

test('makeGate rejects with a parked-tagged message via the injected gate timer - no real timer used', async () => {
  const lines: string[] = []
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const gate = makeGate(
    { maxIterations: 1, maxCostUsd: 1, gateTimeoutSec: 5 },
    { out: (l) => lines.push(l) },
    false,
    cwd,
    // the injected timer rejects immediately instead of waiting 5 real
    // seconds - this is the whole point of the seam
    { gateTimer: async (_ms, message) => { throw new Error(message) } },
  )
  // parked:, NOT infra: - a human not answering in time is a human being
  // busy, not an infrastructure failure (see router.ts's parked branch)
  await expect(gate({ id: 'approve', role: 'gate' }, 'ctx'))
    .rejects.toThrow('parked: gate "approve" got no human answer within 5s')
})

test('makeGate clears the timeout when the human answers first, leaving no lingering timer', async () => {
  vi.useFakeTimers()
  const fakeStdin = new PassThrough()
  const origStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!
  Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true })
  try {
    const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
    const gate = makeGate(
      { maxIterations: 1, maxCostUsd: 1, gateTimeoutSec: 3600 }, // 1h timeout
      { out: () => {} }, false, cwd,
    )
    const p = gate({ id: 'approve', role: 'gate' }, 'ctx')
    await Promise.resolve() // let readline wire up its line listener
    fakeStdin.write('y\n')
    await expect(p).resolves.toEqual({ approved: true })
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
    const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
    const gate = makeGate(
      { maxIterations: 1, maxCostUsd: 1, gateTimeoutSec: 5 },
      { out: () => {} }, false, cwd,
      { gateTimer: async (_ms, message) => { throw new Error(message) } },
    )
    await expect(gate({ id: 'approve', role: 'gate' }, 'ctx')).rejects.toThrow(/parked:/)
    await new Promise((r) => setTimeout(r, 10)) // flush any dangling rejection
  } finally {
    process.removeListener('unhandledRejection', onRej)
  }
  expect(rejections).toEqual([])
})

test('gate timeout PARKS the run with a resume hint - never as an infrastructure or config error (no real timers)', async () => {
  const { cwd, io, lines } = setup(GATED_TIMEOUT)
  const def = parseLoopfile(GATED_TIMEOUT)
  const gate = makeGate(def.rails, io, false, cwd, {
    gateTimer: async (_ms, message) => { throw new Error(message) },
  })
  const code = await runAction(undefined, { cwd }, { io, gate })
  expect(code).toBe(2) // still non-zero: the run is not done, just parked
  const text = lines.join('\n')
  expect(text).toContain('parked - parked awaiting human approval')
  expect(text).toContain('gate "approve" got no human answer within 5s')
  // the single action the human needs is stated right there
  expect(text).toContain('looprail resume')
  // a human being busy must never read as the tool failing
  expect(text).not.toContain('infrastructure error')
  expect(text).not.toContain('config error')
  expect(text).not.toContain('halted -')
})

test('a plain `looprail run` (no --ui) never registers with the dashboard gate registry and never writes gate-waiting.json', async () => {
  // Locks in the regression this task is about: when opts.ui is not set,
  // run-cmd wires makeGate (not makeUiGate) as it always has - so a gate
  // node must never call registerPendingGate, and no <runDir>/gate-waiting.json
  // marker should ever appear, even mid-gate while the run is genuinely
  // blocked waiting on the injected gate function below.
  const { cwd, io } = setup(GATED)
  let sawRunDirDuringGate: string | undefined
  let pendingDuringGate: unknown
  let markerDuringGate: unknown
  const code = await runAction(undefined, { cwd }, {
    io,
    gate: async () => {
      const runs = readdirSync(runsRoot(cwd))
      const runId = runs[0]
      const runDir = join(runsRoot(cwd), runId)
      sawRunDirDuringGate = runDir
      pendingDuringGate = getPendingGate(runId)
      markerDuringGate = readGateWaitingMarker(runDir)
      return true
    },
  })
  expect(code).toBe(0)
  expect(sawRunDirDuringGate).toBeDefined()
  // No pending-gate registry entry was ever created for this run.
  expect(pendingDuringGate).toBeUndefined()
  // No gate-waiting.json marker was ever written for this run.
  expect(markerDuringGate).toBeUndefined()
  expect(existsSync(join(sawRunDirDuringGate!, 'gate-waiting.json'))).toBe(false)
})

test('answering "a" at a gate prompt stores the approval so a later run of the same loop does not prompt again', async () => {
  vi.useFakeTimers()
  const fakeStdin = new PassThrough()
  const origStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!
  Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true })
  try {
    const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
    const lines: string[] = []
    const node: NodeDef = { id: 'release-check', role: 'gate', prompt: 'ship it?' }
    const gate = makeGate({ maxIterations: 1, maxCostUsd: 1 }, { out: (l) => lines.push(l) }, false, cwd)
    const p = gate(node, 'ctx')
    await Promise.resolve() // let readline wire up its line listener
    fakeStdin.write('a\n')
    await expect(p).resolves.toEqual({ approved: true })
    expect(hasStoredApproval(cwd, node)).toBe(true)
  } finally {
    Object.defineProperty(process, 'stdin', origStdin)
    vi.useRealTimers()
  }
})

test('a gate whose approval was already stored is auto-approved without prompting stdin again', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const node: NodeDef = { id: 'release-check', role: 'gate', prompt: 'ship it?' }
  storeApproval(cwd, node)
  const lines: string[] = []
  const gate = makeGate({ maxIterations: 1, maxCostUsd: 1 }, { out: (l) => lines.push(l) }, false, cwd)
  await expect(gate(node, 'ctx')).resolves.toEqual({ approved: true })
  expect(lines.join('\n')).toContain('previously approved')
})

test('makeGate: a non-y/n answer is captured as feedback, not treated as rejection', async () => {
  const lines: string[] = []
  const input = new PassThrough()
  const gate = makeGate({ maxIterations: 1, maxCostUsd: 1 }, { out: (l) => lines.push(l) }, false, 'cwd', {}, input)
  const answerPromise = gate({ id: 'approve', role: 'gate' }, 'ctx')
  input.write('the tests node is missing, add one\n')
  const answer = await answerPromise
  expect(answer).toEqual({ approved: false, feedback: 'the tests node is missing, add one' })
})

test('makeGate: a plain y/n answer still returns a bare boolean-shaped GateAnswer with no feedback', async () => {
  const input = new PassThrough()
  const gate = makeGate({ maxIterations: 1, maxCostUsd: 1 }, { out: () => {} }, false, 'cwd', {}, input)
  const answerPromise = gate({ id: 'approve', role: 'gate' }, 'ctx')
  input.write('y\n')
  expect(await answerPromise).toEqual({ approved: true })
})

test('makeUiGate resolves via a dashboard-style resolvePendingGate approval, never touching stdin', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-gate-run-'))
  const gate = makeUiGate(
    { maxIterations: 1, maxCostUsd: 1 }, { out: () => {} }, false, cwd, 'run-x', runDir,
    [{ id: 'approve', role: 'gate' }],
  )
  const answerPromise = gate({ id: 'approve', role: 'gate' }, 'ctx')
  await Promise.resolve()
  await Promise.resolve() // let registerPendingGate land before we look it up
  expect(getPendingGate('run-x')).toMatchObject({ nodeId: 'approve', runId: 'run-x', isPlanApproval: false })
  const found = resolvePendingGate('run-x', 'approve', { approved: true })
  expect(found).toBe(true)
  await expect(answerPromise).resolves.toEqual({ approved: true })
  expect(getPendingGate('run-x')).toBeUndefined()
})

test('makeUiGate resolves via a dashboard-style rejection carrying feedback', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-gate-run-'))
  const gate = makeUiGate(
    { maxIterations: 1, maxCostUsd: 1 }, { out: () => {} }, false, cwd, 'run-y', runDir,
    [{ id: 'approve', role: 'gate' }],
  )
  const answerPromise = gate({ id: 'approve', role: 'gate' }, 'ctx')
  await Promise.resolve()
  await Promise.resolve()
  resolvePendingGate('run-y', 'approve', { approved: false, feedback: 'needs more tests' })
  await expect(answerPromise).resolves.toEqual({ approved: false, feedback: 'needs more tests' })
})

test('makeUiGate still resolves via stdin when the dashboard never answers', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-gate-run-'))
  const input = new PassThrough()
  const gate = makeUiGate(
    { maxIterations: 1, maxCostUsd: 1 }, { out: () => {} }, false, cwd, 'run-z', runDir,
    [{ id: 'approve', role: 'gate' }], {}, input,
  )
  const answerPromise = gate({ id: 'approve', role: 'gate' }, 'ctx')
  input.write('y\n')
  await expect(answerPromise).resolves.toEqual({ approved: true })
  // the registry entry this gate call registered must not outlive it
  expect(getPendingGate('run-z')).toBeUndefined()
})

test('makeUiGate times out via the injected gate timer exactly like makeGate, whether or not the dashboard ever answers', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-gate-run-'))
  const gate = makeUiGate(
    { maxIterations: 1, maxCostUsd: 1, gateTimeoutSec: 5 }, { out: () => {} }, false, cwd, 'run-t', runDir,
    [{ id: 'approve', role: 'gate' }],
    { gateTimer: async (_ms, message) => { throw new Error(message) } },
  )
  await expect(gate({ id: 'approve', role: 'gate' }, 'ctx'))
    .rejects.toThrow('parked: gate "approve" got no human answer within 5s')
  expect(getPendingGate('run-t')).toBeUndefined()
})

// The notification is the product answer to the live-caught failure this
// whole parked mechanism exists for: a gate beginning to wait is exactly the
// moment the human's attention is required, and previously the tool had no
// way to ask for it beyond a terminal line nobody was looking at.
test('makeUiGate fires a notification when the gate starts waiting, and another when it parks on timeout', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-gate-run-'))
  const notified: string[] = []
  const gate = makeUiGate(
    { maxIterations: 1, maxCostUsd: 1, gateTimeoutSec: 5 }, { out: () => {} }, false, cwd, 'run-n', runDir,
    [{ id: 'approve', role: 'gate' }],
    {
      gateTimer: async (_ms, message) => { throw new Error(message) },
      notify: (title, message) => { notified.push(`${title}|${message}`) },
    },
  )
  await expect(gate({ id: 'approve', role: 'gate' }, 'ctx')).rejects.toThrow(/parked:/)
  expect(notified.some((n) => n.includes('approval needed') && n.includes('approve'))).toBe(true)
  expect(notified.some((n) => n.includes('parked') && n.includes('resume'))).toBe(true)
})

// The cross-process channel (journal/gate-files.ts): a SEPARATE mission-
// control process answers by writing gate-answer.json into the run dir -
// the waiting gate polls for it. This is what makes a gate answerable from
// a long-lived `ui --all` that shares no memory with the run's process.
test('makeUiGate resolves via a gate-answer.json written by another process', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-gate-run-'))
  const gate = makeUiGate(
    { maxIterations: 1, maxCostUsd: 1 }, { out: () => {} }, false, cwd, 'run-f', runDir,
    [{ id: 'approve', role: 'gate' }],
    { gateAnswerPollMs: 10 },
  )
  const answerPromise = gate({ id: 'approve', role: 'gate' }, 'ctx')
  await new Promise((r) => setTimeout(r, 15))
  const { writeGateAnswer } = await import('../journal/gate-files.js')
  writeGateAnswer(runDir, { approved: false, feedback: 'add a held-out tester' })
  await expect(answerPromise).resolves.toEqual({ approved: false, feedback: 'add a held-out tester' })
})

test('makeUiGate discards a stale pre-existing answer file instead of letting it approve a gate the human never saw', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-gate-run-'))
  const { writeGateAnswer } = await import('../journal/gate-files.js')
  writeGateAnswer(runDir, { approved: true }) // debris from an earlier gate
  const gate = makeUiGate(
    { maxIterations: 1, maxCostUsd: 1 }, { out: () => {} }, false, cwd, 'run-s', runDir,
    [{ id: 'approve', role: 'gate' }],
    { gateAnswerPollMs: 10 },
  )
  const answerPromise = gate({ id: 'approve', role: 'gate' }, 'ctx')
  // give the poller several ticks - the stale answer must NOT resolve it
  await new Promise((r) => setTimeout(r, 50))
  writeGateAnswer(runDir, { approved: false, feedback: 'real answer' })
  await expect(answerPromise).resolves.toEqual({ approved: false, feedback: 'real answer' })
})

// makeDetachedGate: the gate for `run -d` - no stdin, no same-process
// dashboard; the answer file is the ONLY channel, with identical waiting-
// marker/notify/parked-on-timeout semantics to makeUiGate.
test('makeDetachedGate resolves via the answer file, writing and cleaning the waiting marker around it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-gate-run-'))
  const gate = makeDetachedGate(
    { maxIterations: 1, maxCostUsd: 1 }, { out: () => {} }, false, cwd, 'run-d', runDir,
    [{ id: 'approve', role: 'gate' }],
    { gateAnswerPollMs: 10 },
  )
  const answerPromise = gate({ id: 'approve', role: 'gate' }, 'plan ok?')
  await new Promise((r) => setTimeout(r, 15))
  expect(readGateWaitingMarker(runDir)).toEqual({ nodeId: 'approve', isPlanApproval: false, question: 'plan ok?' })
  const { writeGateAnswer } = await import('../journal/gate-files.js')
  writeGateAnswer(runDir, { approved: true })
  await expect(answerPromise).resolves.toEqual({ approved: true })
  expect(readGateWaitingMarker(runDir)).toBeUndefined()
})

test('makeDetachedGate parks on timeout exactly like the other gates (injected timer, no real clock)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-gate-run-'))
  const gate = makeDetachedGate(
    { maxIterations: 1, maxCostUsd: 1, gateTimeoutSec: 5 }, { out: () => {} }, false, cwd, 'run-dt', runDir,
    [{ id: 'approve', role: 'gate' }],
    { gateTimer: async (_ms, message) => { throw new Error(message) }, gateAnswerPollMs: 10 },
  )
  await expect(gate({ id: 'approve', role: 'gate' }, 'ctx'))
    .rejects.toThrow('parked: gate "approve" got no human answer within 5s')
})

test('makeDetachedGate honors --yes without ever writing a waiting marker', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-gate-run-'))
  const gate = makeDetachedGate(
    { maxIterations: 1, maxCostUsd: 1 }, { out: () => {} }, true, cwd, 'run-dy', runDir,
    [{ id: 'approve', role: 'gate' }],
  )
  await expect(gate({ id: 'approve', role: 'gate' }, 'ctx')).resolves.toEqual({ approved: true })
  expect(readGateWaitingMarker(runDir)).toBeUndefined()
})

// The --detach parent: spawns the same CLI as a detached child and returns
// immediately - the child owns the run from there.
test('run --detach spawns a detached child carrying the minted runId and returns 0 immediately', async () => {
  const { cwd, io, lines } = setup(FIXTURE)
  const spawned: { cmd: string; args: string[]; options: Record<string, unknown> }[] = []
  const code = await runAction(undefined, { cwd, detach: true }, {
    io,
    spawner: (cmd, args, options) => {
      spawned.push({ cmd, args, options })
      return { unref: () => {} }
    },
  })
  expect(code).toBe(0)
  expect(spawned).toHaveLength(1)
  expect(spawned[0].cmd).toBe(process.execPath)
  expect(spawned[0].args).toContain('run')
  expect(spawned[0].args).toContain('--detached-child')
  expect(spawned[0].options).toMatchObject({ detached: true, cwd })
  const runId = spawned[0].args[spawned[0].args.indexOf('--detached-child') + 1]
  expect(runId).toMatch(/^run-/)
  const text = lines.join('\n')
  expect(text).toContain('detached')
  expect(text).toContain(runId)
  expect(text).toContain('looprail ui --all')
  // the run directory already exists so the child's log has a home
  expect(existsSync(join(runsRoot(cwd), runId))).toBe(true)
})

test('run --detach still fails fast in the foreground on a lint-broken loopfile - never dies silently in a background log', async () => {
  const { cwd, io, lines } = setup(FIXTURE.replace('role: executor', 'role: executor, after: missing-node'))
  const spawned: unknown[] = []
  const code = await runAction(undefined, { cwd, detach: true }, {
    io,
    spawner: (cmd, args, options) => { spawned.push([cmd, args, options]); return { unref: () => {} } },
  })
  expect(code).toBe(1)
  expect(spawned).toHaveLength(0)
  expect(lines.join('\n')).toContain('lint')
})

// The detached CHILD end-to-end: runAction with detachedChild uses the
// handed-down runId, waits on the answer file, and notifies on completion.
test('a detached child run verifies via a cross-process answer file and fires a completion notification', async () => {
  const { cwd, io } = setup(GATED)
  const notified: string[] = []
  const runId = 'run-detached-e2e'
  const answering = (async () => {
    // simulate the human approving from mission control: wait for the
    // waiting marker, then write the answer file the child is polling for
    const runDir = join(runsRoot(cwd), runId)
    const { writeGateAnswer } = await import('../journal/gate-files.js')
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 25))
      if (readGateWaitingMarker(runDir)) {
        writeGateAnswer(runDir, { approved: true })
        return
      }
    }
    throw new Error('gate never started waiting')
  })()
  const code = await runAction(undefined, { cwd, json: true, detachedChild: runId }, {
    io,
    notifier: (title, message) => { notified.push(`${title}|${message}`) },
  })
  await answering
  expect(code).toBe(0)
  expect(existsSync(join(runsRoot(cwd), runId, 'journal.jsonl'))).toBe(true)
  expect(notified.some((n) => n.includes('approval needed'))).toBe(true)
  expect(notified.some((n) => n.includes('verified'))).toBe(true)
})

test('makeUiGate answered from the dashboard notifies once for the wait and never claims a park', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-gate-run-'))
  const notified: string[] = []
  const gate = makeUiGate(
    { maxIterations: 1, maxCostUsd: 1 }, { out: () => {} }, false, cwd, 'run-n2', runDir,
    [{ id: 'approve', role: 'gate' }],
    { notify: (title, message) => { notified.push(`${title}|${message}`) } },
  )
  const answerPromise = gate({ id: 'approve', role: 'gate' }, 'ctx')
  await Promise.resolve()
  await Promise.resolve()
  resolvePendingGate('run-n2', 'approve', { approved: true })
  await expect(answerPromise).resolves.toEqual({ approved: true })
  expect(notified.filter((n) => n.includes('approval needed'))).toHaveLength(1)
  expect(notified.some((n) => n.includes('run parked'))).toBe(false)
})

test('makeUiGate marks the gate-waiting.json marker while waiting and removes it once settled', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-gate-run-'))
  const gate = makeUiGate(
    { maxIterations: 1, maxCostUsd: 1 }, { out: () => {} }, false, cwd, 'run-m', runDir,
    [{ id: 'approve', role: 'gate' }],
  )
  const answerPromise = gate({ id: 'approve', role: 'gate' }, 'plan ok?')
  await Promise.resolve()
  await Promise.resolve()
  expect(readGateWaitingMarker(runDir)).toEqual({ nodeId: 'approve', isPlanApproval: false, question: 'plan ok?' })
  resolvePendingGate('run-m', 'approve', { approved: true })
  await answerPromise
  expect(readGateWaitingMarker(runDir)).toBeUndefined()
})

test('makeUiGate classifies a gate whose dependency chain leads to a generates:graph planner as a plan-approval gate', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-gate-run-'))
  const nodes: NodeDef[] = [
    { id: 'plan', role: 'planner', generates: 'graph' },
    { id: 'approve', role: 'gate', after: ['plan'] },
  ]
  const gate = makeUiGate(
    { maxIterations: 1, maxCostUsd: 1 }, { out: () => {} }, false, cwd, 'run-p', runDir, nodes,
  )
  const answerPromise = gate(nodes[1]!, 'plan ok?')
  await Promise.resolve()
  await Promise.resolve()
  expect(getPendingGate('run-p')).toMatchObject({ isPlanApproval: true })
  expect(readGateWaitingMarker(runDir)).toMatchObject({ isPlanApproval: true })
  resolvePendingGate('run-p', 'approve', { approved: true })
  await answerPromise
})

test('makeUiGate honors --yes auto-approve without ever registering with the dashboard', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-gate-run-'))
  const gate = makeUiGate(
    { maxIterations: 1, maxCostUsd: 1 }, { out: () => {} }, true, cwd, 'run-auto', runDir,
    [{ id: 'approve', role: 'gate' }],
  )
  await expect(gate({ id: 'approve', role: 'gate' }, 'ctx')).resolves.toEqual({ approved: true })
  expect(getPendingGate('run-auto')).toBeUndefined()
  expect(readGateWaitingMarker(runDir)).toBeUndefined()
})

test('makeUiGate honors an already-stored approval without ever registering with the dashboard', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-gate-run-'))
  const node: NodeDef = { id: 'release-check', role: 'gate' }
  storeApproval(cwd, node)
  const gate = makeUiGate(
    { maxIterations: 1, maxCostUsd: 1 }, { out: () => {} }, false, cwd, 'run-stored', runDir, [node],
  )
  await expect(gate(node, 'ctx')).resolves.toEqual({ approved: true })
  expect(getPendingGate('run-stored')).toBeUndefined()
  expect(readGateWaitingMarker(runDir)).toBeUndefined()
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

test('agentEstimatedCostBreakdown folds journal estimates per agent, separate from real cost', async () => {
  const def = parseLoopfile(FIXTURE)
  const dir = join(mkdtempSync(join(tmpdir(), 'lr-bd-')), 'run')
  const w = new JournalWriter(dir, () => 1)
  w.write('node_end', { nodeId: 'do', costUsd: 0, estimatedCostUsd: 0.4 })
  w.write('node_end', { nodeId: 'crit@1', costUsd: 0, estimatedCostUsd: 0.1 })
  expect(agentEstimatedCostBreakdown(def, w.path)).toEqual([['worker', 0.4], ['checker', 0.1]])
})

test('agentEstimatedCostBreakdown omits an agent that never produced an estimate (not a 0 entry)', async () => {
  const def = parseLoopfile(FIXTURE)
  const dir = join(mkdtempSync(join(tmpdir(), 'lr-bd-')), 'run')
  const w = new JournalWriter(dir, () => 1)
  w.write('node_end', { nodeId: 'do', costUsd: 0.3 }) // no estimatedCostUsd at all
  expect(agentEstimatedCostBreakdown(def, w.path)).toEqual([])
})

function capture() {
  const lines: string[] = []
  return { io: { out: (l: string) => lines.push(l) }, lines }
}

test('run --ui --json keeps stdout to a single JSON line (dashboard URL not printed)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-run-ui-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE)
  const { io, lines } = capture()
  const code = await runAction(undefined, { cwd, json: true, ui: true, port: 41611 }, { io })
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
  const code = await runAction(undefined, { cwd, ui: true, port: 41612 }, { io })
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
      // The printed line is now a deep link into the consolidated
      // mission-control server - `http://127.0.0.1:PORT/run/<hash>/<runId>/`
      // - not a bare origin, so capture the whole path to build /events off
      // of the SAME per-run route, not the server's root /events (which
      // serves the whole-registry SSE feed, not this one run's journal).
      const match = l.match(/http:\/\/127\.0\.0\.1:\d+\/run\/\S+\//)
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
      http.get(`${match[0]}events`, (res) => {
        let received = ''
        res.on('data', (chunk) => {
          received += chunk
          if (received.includes('\n\n')) { res.destroy(); resolve(received) }
        })
        res.on('error', () => resolve(received))
      }).on('error', reject)
    }
  })
  const code = await runAction(undefined, { cwd, ui: true, port: 41613 }, { io, registry })
  expect(code).toBe(0)
  expect(runDirExistedAtDashboardStart).toBe(true)
  const frame = await framePromise
  expect(frame).toContain('"type":"run_start"')
})

test('run --ui dashboard reflects the finished run at /model once closed data is still on disk', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-run-ui-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE)
  const { io } = capture()
  await runAction(undefined, { cwd, json: true, ui: true, port: 41614 }, { io })
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

test('a generates:graph planner node splices its approved fragment into the live run', async () => {
  const SELF_PLANNING = `
name: self-planning-fixture
goal: Do the generated thing.
agents:
  planner: { adapter: mock }
graph:
  plan:    { role: planner, agent: planner, generates: graph }
  approve: { role: gate, after: plan }
rails:
  max_iterations: 5
  max_cost_usd: 1
`
  const { cwd, io } = setup(SELF_PLANNING)
  const registry = createRegistry()
  registry.register(new MockAdapter([
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n  check: { role: critic, of: build, agent: planner }\n' },
    { output: '[mock] build done' }, // the spliced "build" node's own invocation
    { output: 'VERDICT: pass\nEVIDENCE: looks good' }, // the spliced "check" critic's own invocation
  ]))
  const code = await runAction(undefined, { cwd }, {
    io, registry, gate: async () => ({ approved: true }),
  })
  expect(code).toBe(0)
  // the spliced "build" node actually ran as part of this same run
  const { latestRunId, runsRoot } = await import('./status-cmd.js')
  const { readJournal } = await import('../journal/journal.js')
  const runDir = join(runsRoot(cwd), latestRunId(cwd)!)
  const events = readJournal(join(runDir, 'journal.jsonl'))
  expect(events.some((e) => e.type === 'node_start' && (e.data as { nodeId: string }).nodeId === 'build')).toBe(true)
})

test("a run persists its own bootstrap LoopDef copy at run start, surviving the workspace it came from being deleted entirely", async () => {
  const { cwd, io } = setup(FIXTURE)
  const code = await runAction(undefined, { cwd }, { io })
  expect(code).toBe(0)
  const runId = readdirSync(runsRoot(cwd))[0]
  const runDir = join(runsRoot(cwd), runId)

  // the workspace (its looprail.yaml) is gone entirely - e.g. a git
  // worktree cleaned up after merging - but the run's own directory
  // (elsewhere, under ~/.looprail/runs/...) is untouched
  rmSync(cwd, { recursive: true, force: true })

  const persisted = loadRunLoopDef(runDir)
  expect(persisted?.nodes.map((n) => n.id).sort()).toEqual(['crit', 'do'])
  expect(persisted?.agents.worker).toEqual({ adapter: 'mock' })
  // and the dashboard's view model can still derive real graph edges from
  // it, exactly as if the workspace were still there
  const model = buildViewModel([], persisted)
  expect(model.edges).toEqual([['do', 'crit', 'after']])
})

test("a successful graph splice updates the run's own persisted loopfile.json copy with the extended graph - a LATER read (even after the workspace is deleted) shows the spliced nodes' edges", async () => {
  const SELF_PLANNING = `
name: self-planning-fixture
goal: Do the generated thing.
agents:
  planner: { adapter: mock }
graph:
  plan:    { role: planner, agent: planner, generates: graph }
  approve: { role: gate, after: plan }
rails:
  max_iterations: 5
  max_cost_usd: 1
`
  const { cwd, io } = setup(SELF_PLANNING)
  const registry = createRegistry()
  registry.register(new MockAdapter([
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n  check: { role: critic, of: build, agent: planner }\n' },
    { output: '[mock] build done' },
    { output: 'VERDICT: pass\nEVIDENCE: looks good' },
  ]))
  const code = await runAction(undefined, { cwd }, {
    io, registry, gate: async () => ({ approved: true }),
  })
  expect(code).toBe(0)
  const runId = readdirSync(runsRoot(cwd))[0]
  const runDir = join(runsRoot(cwd), runId)

  rmSync(cwd, { recursive: true, force: true })

  const persisted = loadRunLoopDef(runDir)
  const ids = persisted?.nodes.map((n) => n.id).sort()
  // the STATIC bootstrap graph only ever had plan/approve - build/check
  // only exist because the splice extended it, and that extension must
  // have been re-persisted for a later read to see it at all. `approve`
  // is dropped from the LIVE execution list once resolved (its job is
  // done, it must never be asked again) but stays in the PERSISTED copy
  // (see runner.ts's applySplice/resolvedGates) - it genuinely ran, and
  // dropping it here too would leave it rendered with no edges at all.
  expect(ids).toEqual(['approve', 'build', 'check', 'plan'])
  const { readJournal } = await import('../journal/journal.js')
  const events = readJournal(join(runDir, 'journal.jsonl'))
  const model = buildViewModel(events, persisted)
  expect(model.edges).toContainEqual(['build', 'check', 'of'])
  expect(model.edges).toContainEqual(['plan', 'approve', 'after'])
})

test("REGRESSION (splice staleness): a `run --ui` dashboard's own /model reflects a mid-run graph splice IMMEDIATELY, without restarting the dashboard server", async () => {
  // This is the exact bug described in the task: server.ts's
  // startDashboardServer (still wired into run-cmd.ts's `if (opts.ui)`
  // block at the time this test is written) is handed `def: expanded` ONCE
  // at dashboard-start time and never re-reads it - so a self-planning
  // splice that extends the graph mid-run (engine/runner.ts's applySplice,
  // which re-persists runDir/loopfile.json via
  // journal/loopfile-persist.ts's persistRunLoopDef) never shows up in a
  // `run --ui` dashboard's /model, even though the SAME run, queried via
  // `looprail ui <runId>` in a separate process, would show it fine
  // (mission-control-server.ts's bestEffortLoopDef re-reads loopfile.json
  // on every request). This test drives a REAL splice while the `run --ui`
  // dashboard for THIS SAME run is up, fetches /model BEFORE the splice
  // (graph A: plan -> approve only) and AGAIN AFTER the splice completes
  // (graph B: plan -> approve, build -> check), using the SAME server the
  // whole time - proving the dashboard opened by `run --ui` re-reads the
  // persisted loopfile.json fresh on every request instead of freezing it
  // at startup. Currently FAILS: modelAfterSplice's edges will still only
  // contain ['plan','approve'] because startDashboardServer's serveModel
  // reuses the stale `def` closed over at server-start.
  const SELF_PLANNING = `
name: self-planning-fixture
goal: Do the generated thing.
agents:
  planner: { adapter: mock }
graph:
  plan:    { role: planner, agent: planner, generates: graph }
  approve: { role: gate, after: plan }
rails:
  max_iterations: 5
  max_cost_usd: 1
`
  const { cwd, io } = setup(SELF_PLANNING)
  const registry = createRegistry()
  // A small delay on the spliced nodes' own invocations (NOT the planner's)
  // buys real wall-clock time for the background /model fetch below (kicked
  // off, not awaited, right as the gate approves) to land while `build`'s
  // node_start has already been journaled but before the whole run
  // finishes and its dashboard closes.
  registry.register({
    name: 'mock',
    async invoke(req) {
      const verifying = req.prompt.includes('VERDICT:')
      const isPlanner = req.prompt.includes('PLANNER')
      if (isPlanner) {
        return {
          output: 'graph:\n  build: { role: executor, agent: planner }\n  check: { role: critic, of: build, agent: planner }\n',
          costUsd: 0, tokens: 0, durationMs: 1,
        }
      }
      await new Promise((r) => setTimeout(r, 50))
      return {
        output: verifying ? 'VERDICT: pass\nEVIDENCE: looks good' : '[mock] build done',
        costUsd: 0, tokens: 0, durationMs: 1,
      }
    },
  })

  function getJson(url: string): Promise<{ edges: [string, string][] }> {
    return new Promise((resolve, reject) => {
      http.get(url, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => resolve(JSON.parse(body) as { edges: [string, string][] }))
      }).on('error', reject)
    })
  }
  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  let dashboardUrl: string | undefined
  io.out = (l: string) => {
    // The printed line is a deep link into the consolidated mission-control
    // server (`http://127.0.0.1:PORT/run/<hash>/<runId>/`), not a bare
    // origin - capture the whole path so /model below hits the SAME
    // per-run route `run --ui` actually opens on.
    const match = l.match(/http:\/\/127\.0\.0\.1:\d+\/run\/\S+\//)
    if (match) dashboardUrl = match[0]
  }

  let modelBeforeSplice: { edges: [string, string][] } | undefined
  let modelAfterSplicePromise: Promise<{ edges: [string, string][] }> | undefined
  // The gate for the plan's approval fires synchronously (in-process, same
  // as the engine's real gate call) right after `plan` finishes invoking
  // the planner, and strictly BEFORE applySplice re-persists the extended
  // graph - so fetching /model from inside this gate function is the one
  // guaranteed-safe moment to observe graph A.
  const gate = async (): Promise<{ approved: boolean }> => {
    if (!dashboardUrl) throw new Error('dashboard URL was never printed before the gate fired')
    modelBeforeSplice = await getJson(`${dashboardUrl}model`)
    // Scheduled here (not awaited) so it does not block the gate's own
    // resolution the engine is waiting on, but still races nothing:
    // waitFor below only returns once the spliced "build" node has
    // actually started, which cannot happen before applySplice's
    // persistRunLoopDef has already run.
    const runId = readdirSync(runsRoot(cwd))[0]
    const runDir = join(runsRoot(cwd), runId)
    modelAfterSplicePromise = (async () => {
      const { readJournal } = await import('../journal/journal.js')
      await waitFor(() => {
        try {
          const events = readJournal(join(runDir, 'journal.jsonl'))
          return events.some((e) => e.type === 'node_start' && (e.data as { nodeId: string }).nodeId === 'build')
        } catch { return false }
      })
      return getJson(`${dashboardUrl}model`)
    })()
    return { approved: true }
  }

  const code = await runAction(undefined, { cwd, ui: true, port: 41615 }, { io, registry, gate })
  expect(code).toBe(0)

  // graph A: only the static bootstrap graph existed at this point
  expect(modelBeforeSplice?.edges).toEqual([['plan', 'approve', 'after']])

  // graph B: the SAME dashboard server (never restarted) now shows the
  // spliced nodes' edges too, fetched while the run (and its dashboard)
  // were still the very same live process the whole time.
  const modelAfterSplice = await modelAfterSplicePromise
  expect(modelAfterSplice?.edges).toContainEqual(['build', 'check', 'of'])
  expect(modelAfterSplice?.edges).toContainEqual(['plan', 'approve', 'after'])
})

test("a spliced node's actually-resolved agent/adapter/model is visible directly on its node_end journal event, with no LoopDef needed at all", async () => {
  const SELF_PLANNING = `
name: self-planning-agent-fixture
goal: Do the generated thing.
agents:
  planner: { adapter: mock, model: planner-model }
graph:
  plan:    { role: planner, agent: planner, generates: graph }
  approve: { role: gate, after: plan }
rails:
  max_iterations: 5
  max_cost_usd: 1
`
  const { cwd, io } = setup(SELF_PLANNING)
  const registry = createRegistry()
  registry.register(new MockAdapter([
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n  check: { role: critic, of: build, agent: planner }\n' },
    { output: '[mock] build done' },
    { output: 'VERDICT: pass\nEVIDENCE: looks good' },
  ]))
  const code = await runAction(undefined, { cwd }, {
    io, registry, gate: async () => ({ approved: true }),
  })
  expect(code).toBe(0)
  const runId = readdirSync(runsRoot(cwd))[0]
  const runDir = join(runsRoot(cwd), runId)
  const { readJournal } = await import('../journal/journal.js')
  const events = readJournal(join(runDir, 'journal.jsonl'))
  const buildEnd = events.find((e) => e.type === 'node_end' && (e.data as { nodeId: string }).nodeId === 'build')
  expect(buildEnd?.data).toMatchObject({ agent: 'planner', adapter: 'mock', model: 'planner-model' })
  // the model with NO def at all (buildViewModel(events) - undefined def)
  // still shows the same agent/adapter/model, straight from the events
  const model = buildViewModel(events)
  const build = model.nodes.find((n) => n.id === 'build')
  expect(build).toMatchObject({ agent: 'planner', adapter: 'mock', model: 'planner-model' })
})

test('an ordinary non-spliced run with an intact workspace is completely unaffected by the persisted-copy fix', async () => {
  const { cwd, io } = setup(FIXTURE)
  const code = await runAction(undefined, { cwd }, { io })
  expect(code).toBe(0)
  const runId = readdirSync(runsRoot(cwd))[0]
  const runDir = join(runsRoot(cwd), runId)
  // the workspace is left intact this time - both the persisted copy and
  // the original looprail.yaml exist and agree
  expect(existsSync(join(cwd, 'looprail.yaml'))).toBe(true)
  const persisted = loadRunLoopDef(runDir)
  expect(persisted?.nodes.map((n) => n.id).sort()).toEqual(['crit', 'do'])
})

test('a plan-approval gate rejection with feedback triggers an immediate replan, not a flat halt', async () => {
  const SELF_PLANNING_FEEDBACK = `
name: self-planning-feedback-fixture
goal: Do the generated thing.
agents:
  planner: { adapter: mock }
graph:
  plan:    { role: planner, agent: planner, generates: graph }
  approve: { role: gate, after: plan }
rails:
  max_iterations: 5
  max_cost_usd: 1
`
  const { cwd, io } = setup(SELF_PLANNING_FEEDBACK)
  const registry = createRegistry()
  registry.register(new MockAdapter([
    // one planner call before the first (rejected) approval, one more after
    // the feedback-triggered replan
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n  check: { role: critic, of: build, agent: planner }\n' },
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n  check: { role: critic, of: build, agent: planner }\n' },
    { output: '[mock] build done' },
    { output: 'VERDICT: pass\nEVIDENCE: looks good' },
  ]))
  let gateCalls = 0
  const code = await runAction(undefined, { cwd }, {
    io, registry,
    gate: async () => {
      gateCalls += 1
      return gateCalls === 1 ? { approved: false, feedback: 'add a tests node' } : { approved: true }
    },
  })
  expect(code).toBe(0)
  expect(gateCalls).toBe(2) // first rejection replanned, second approved
})

test('a plan-approval gate rejection with feedback stops replanning once replan_limit is hit', async () => {
  const SELF_PLANNING_FEEDBACK_LIMIT = `
name: self-planning-feedback-limit-fixture
goal: Do the generated thing.
agents:
  planner: { adapter: mock }
graph:
  plan:    { role: planner, agent: planner, generates: graph }
  approve: { role: gate, after: plan }
rails:
  max_iterations: 8
  max_cost_usd: 1
  replan_limit: 2
`
  const { cwd, io } = setup(SELF_PLANNING_FEEDBACK_LIMIT)
  const registry = createRegistry()
  // the planner is asked once up front plus once per replan (bounded by
  // replan_limit: 2) - never a 4th time, since the run must halt once the
  // limit is exhausted instead of replanning forever
  registry.register(new MockAdapter([
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n' },
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n' },
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n' },
  ]))
  let gateCalls = 0
  const code = await runAction(undefined, { cwd }, {
    io, registry,
    // always rejects with feedback - would replan forever without a limit
    gate: async () => {
      gateCalls += 1
      return { approved: false, feedback: `still not right (${gateCalls})` }
    },
  })
  expect(code).toBe(2) // halted, not verified - the limit was hit, not satisfied
  expect(gateCalls).toBe(3) // 1 initial approval attempt + 2 replans (replan_limit) - no 4th
})

test('a generates:graph planner that first replies with prose self-corrects automatically, never reaching the gate on the bad attempt', async () => {
  const SELF_PLANNING_FORMAT = `
name: self-planning-format-fixture
goal: Do the generated thing.
agents:
  planner: { adapter: mock }
graph:
  plan:    { role: planner, agent: planner, generates: graph, rounds: 2 }
  approve: { role: gate, after: plan }
rails:
  max_iterations: 5
  max_cost_usd: 1
`
  const { cwd, io } = setup(SELF_PLANNING_FORMAT)
  const registry = createRegistry()
  registry.register(new MockAdapter([
    // first attempt: prose, no graph: key at all - must self-correct, not reach the gate
    { match: /PLANNER/, output: '## Plan\nHere is my plan in prose form, no YAML at all.' },
    // second attempt, after the automatic format-error feedback: real YAML.
    // Includes a critic so the spliced graph has a verifying node - without
    // one, all-pass has nothing to ever pass and the run just iterates the
    // executor forever until rails halt it (a test-fixture issue, not a
    // property of the format-check fix itself).
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n  check: { role: critic, of: build, agent: planner }\n' },
    { output: '[mock] build done' }, // the spliced "build" node's own invocation
    { output: 'VERDICT: pass\nEVIDENCE: looks good' }, // the spliced "check" critic's own invocation
  ]))
  let gateCalls = 0
  const code = await runAction(undefined, { cwd }, {
    io, registry, gate: async () => { gateCalls += 1; return { approved: true } },
  })
  expect(code).toBe(0)
  // the gate was only ever asked about the SECOND (valid) attempt - the
  // prose attempt never reached it at all
  expect(gateCalls).toBe(1)
  const { latestRunId, runsRoot } = await import('./status-cmd.js')
  const { readJournal } = await import('../journal/journal.js')
  const runDir = join(runsRoot(cwd), latestRunId(cwd)!)
  const events = readJournal(join(runDir, 'journal.jsonl'))
  expect(events.some((e) => e.type === 'node_start' && (e.data as { nodeId: string }).nodeId === 'build')).toBe(true)
})

test('a generates:graph planner that never produces parseable YAML exhausts replan_limit and halts cleanly, never reaching the gate', async () => {
  const SELF_PLANNING_ALWAYS_BAD = `
name: self-planning-always-bad-fixture
goal: Do the generated thing.
agents:
  planner: { adapter: mock }
graph:
  plan:    { role: planner, agent: planner, generates: graph, rounds: 2 }
  approve: { role: gate, after: plan }
rails:
  max_iterations: 8
  max_cost_usd: 1
  replan_limit: 2
`
  const { cwd, io } = setup(SELF_PLANNING_ALWAYS_BAD)
  const registry = createRegistry()
  // unfixable prose, every time: both rounds of the initial attempt, and
  // both rounds of each of the 2 replans (replan_limit) - 6 calls total,
  // never a 7th, since the run must halt once the limit is exhausted
  // instead of silently letting the last bad attempt reach the gate.
  registry.register(new MockAdapter(
    Array.from({ length: 6 }, () => ({ match: /PLANNER/, output: 'Sorry, I could not produce a plan.' })),
  ))
  let gateCalls = 0
  const code = await runAction(undefined, { cwd }, {
    io, registry, gate: async () => { gateCalls += 1; return { approved: true } },
  })
  expect(code).toBe(2) // halted, not verified
  expect(gateCalls).toBe(0) // the gate must never be asked about unparseable content
})

test('a generates:graph planner whose fragment parses but invents its own node schema (missing role/agent) self-corrects automatically, never reaching the gate on the bad attempt', async () => {
  const SELF_PLANNING_STRUCTURAL = `
name: self-planning-structural-fixture
goal: Do the generated thing.
agents:
  planner: { adapter: mock }
graph:
  plan:    { role: planner, agent: planner, generates: graph, rounds: 2 }
  approve: { role: gate, after: plan }
rails:
  max_iterations: 5
  max_cost_usd: 1
`
  const { cwd, io } = setup(SELF_PLANNING_STRUCTURAL)
  const registry = createRegistry()
  registry.register(new MockAdapter([
    // first attempt: parses as YAML fine, but every node uses an invented
    // schema (title/description/success_criteria/depends_on) instead of the
    // real NodeDef fields - role/agent end up undefined at runtime. This
    // must be caught here, not at splice or execution time.
    {
      match: /PLANNER/,
      output: 'graph:\n  build:\n    title: Build the thing\n    description: does the work\n    success_criteria: it works\n    depends_on: []\n',
    },
    // second attempt, after the automatic structural-error feedback: real
    // schema this time.
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n  check: { role: critic, of: build, agent: planner }\n' },
    { output: '[mock] build done' }, // the spliced "build" node's own invocation
    { output: 'VERDICT: pass\nEVIDENCE: looks good' }, // the spliced "check" critic's own invocation
  ]))
  let gateCalls = 0
  const code = await runAction(undefined, { cwd }, {
    io, registry, gate: async () => { gateCalls += 1; return { approved: true } },
  })
  expect(code).toBe(0)
  // the gate was only ever asked about the SECOND (structurally valid)
  // attempt - the broken-schema attempt never reached it at all
  expect(gateCalls).toBe(1)
  const { latestRunId, runsRoot } = await import('./status-cmd.js')
  const { readJournal } = await import('../journal/journal.js')
  const runDir = join(runsRoot(cwd), latestRunId(cwd)!)
  const events = readJournal(join(runDir, 'journal.jsonl'))
  expect(events.some((e) => e.type === 'node_start' && (e.data as { nodeId: string }).nodeId === 'build')).toBe(true)
})

test('a generates:graph planner whose fragment always invents its own node schema exhausts replan_limit and halts cleanly, never reaching the gate or splicing broken structure in', async () => {
  const SELF_PLANNING_STRUCTURAL_ALWAYS_BAD = `
name: self-planning-structural-always-bad-fixture
goal: Do the generated thing.
agents:
  planner: { adapter: mock }
graph:
  plan:    { role: planner, agent: planner, generates: graph, rounds: 2 }
  approve: { role: gate, after: plan }
rails:
  max_iterations: 8
  max_cost_usd: 1
  replan_limit: 2
`
  const { cwd, io } = setup(SELF_PLANNING_STRUCTURAL_ALWAYS_BAD)
  const registry = createRegistry()
  // every reply parses as YAML but every node is missing role/agent - both
  // rounds of the initial attempt, and both rounds of each of the 2 replans
  // (replan_limit) - 6 calls total, never a 7th, since the run must halt
  // once the limit is exhausted instead of ever splicing broken structure
  // into the live graph.
  registry.register(new MockAdapter(
    Array.from({ length: 6 }, () => ({
      match: /PLANNER/,
      output: 'graph:\n  build:\n    title: Build the thing\n    description: does the work\n',
    })),
  ))
  let gateCalls = 0
  const code = await runAction(undefined, { cwd }, {
    io, registry, gate: async () => { gateCalls += 1; return { approved: true } },
  })
  expect(code).toBe(2) // halted, not verified
  expect(gateCalls).toBe(0) // the gate must never be asked about structurally invalid content
})

test('the human-readable report shows a "files touched" count when the run cwd has real git changes', async () => {
  const { cwd, io, lines } = setup(FIXTURE)
  execFileSync('git', ['init', '-q'], { cwd })
  writeFileSync(join(cwd, 'touched-1.txt'), 'a')
  writeFileSync(join(cwd, 'touched-2.txt'), 'b')
  const code = await runAction(undefined, { cwd }, { io })
  expect(code).toBe(0)
  const text = lines.join('\n')
  // looprail.yaml itself is untracked too, so at least the 2 files above are
  // always included, but the exact count also depends on the fixture file -
  // just assert the note appears with some real number, not a specific one.
  expect(text).toMatch(/\d+ files touched - run `git diff --stat`/)
})

test('the human-readable report omits the "files touched" note when the run cwd is not a git repo', async () => {
  const { cwd, io, lines } = setup(FIXTURE)
  const code = await runAction(undefined, { cwd }, { io })
  expect(code).toBe(0)
  const text = lines.join('\n')
  expect(text).not.toContain('files touched')
})

test('--json includes filesTouched inside the nested report object', async () => {
  const { cwd, io, lines } = setup(FIXTURE)
  execFileSync('git', ['init', '-q'], { cwd })
  writeFileSync(join(cwd, 'touched.txt'), 'a')
  const code = await runAction(undefined, { cwd, json: true }, { io })
  expect(code).toBe(0)
  const parsed = JSON.parse(lines[0]) as { report: { filesTouched?: string[] } }
  expect(parsed.report.filesTouched).toContain('touched.txt')
})
