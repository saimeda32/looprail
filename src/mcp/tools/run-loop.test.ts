import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readJournal } from '../../index.js'
import { runsRoot } from '../../journal/runs.js'
import { approveGateHandler } from './approve-gate.js'
import { gateKey, pendingGates } from './gate-registry.js'
import { runLoopHandler } from './run-loop.js'

function gatedFixture(cwd: string, opts: { maxIterations: number; gateTimeoutSec?: number }): void {
  writeFileSync(join(cwd, 'looprail.yaml'), `
name: gated-mcp
goal: Needs approval.
agents:
  worker: { adapter: mock }
graph:
  do:      { role: executor, agent: worker }
  approve: { role: gate, after: do }
rails:
  max_iterations: ${opts.maxIterations}
  max_cost_usd: 1
${opts.gateTimeoutSec !== undefined ? `  gate_timeout: ${opts.gateTimeoutSec}` : ''}
`)
}

// Everything between calling runLoopHandler and the gate node registering
// itself in pendingGates is a straight-line chain of promise microtasks (the
// mock adapter resolves immediately, with no setTimeout/setImmediate of its
// own) - so a single macrotask tick is guaranteed to happen strictly after
// every one of those microtasks has drained, regardless of how many there
// are. This is a test-synchronization flush, not a wait on the gate_timeout
// feature itself (that's exercised below via an injected gateTimer, never a
// real timer).
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function fixture(cwd: string, hasVerifier: boolean): void {
  writeFileSync(join(cwd, 'looprail.yaml'), `
name: demo
goal: Say DONE.
agents:
  worker: { adapter: mock }
graph:
  do: { role: executor, agent: worker }
${hasVerifier ? '  check: { role: tester, after: do, run: "true", expect: "exit 0" }' : ''}
rails:
  max_iterations: 2
  max_cost_usd: 1
`)
}

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'lr-mcp-run-'))
}

test('returns a runId immediately, and the run keeps executing in the background', async () => {
  const cwd = tmpCwd()
  fixture(cwd, true)
  const { result, done } = await runLoopHandler({}, { cwd })

  // "Immediately" is a structural guarantee (runLoopHandler never awaits
  // runLoop(...) before returning `result` - see run-loop.ts), not a race
  // this test needs real time to prove. `done` below is the same promise
  // runLoop() itself returns - awaiting it is deterministic and uses no
  // timer or poll loop.
  expect(result.isError).toBeFalsy()
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.runId).toMatch(/^run-/)
  expect(parsed.status).toBe('started')

  const report = await done
  expect(report?.status).toBe('verified')
  const events = readJournal(join(parsed.runDir, 'journal.jsonl'))
  expect(events.some((e) => e.type === 'verified')).toBe(true)
})

test('a loop that fails lint is rejected synchronously and never starts a background run', async () => {
  const cwd = tmpCwd()
  fixture(cwd, false) // no verifying node - L001
  const { result, done } = await runLoopHandler({}, { cwd })
  expect(result.isError).toBe(true)
  expect(await done).toBeUndefined()
  expect(existsSync(runsRoot(cwd))).toBe(false)
})

test('a loop valid pre-expansion but invalid post-expansion is rejected synchronously, never starts, and never emits a runId that looks started', async () => {
  const cwd = tmpCwd()
  // "do" panel-expands into clones "do@1"/"do@2" (see expandPanels in
  // src/core/graph.ts), which collides with the literal node id "do@1"
  // below - a duplicate-id fault validateGraph can only see on the
  // EXPANDED graph, never on the raw one lintLoop checks (raw ids
  // do/do@1/check are all unique).
  writeFileSync(join(cwd, 'looprail.yaml'), `
name: demo
goal: Say DONE.
agents:
  worker: { adapter: mock }
graph:
  do: { role: executor, agent: worker, panel: 2 }
  do@1: { role: executor, agent: worker }
  check: { role: tester, after: "do@1", run: "true", expect: "exit 0" }
rails:
  max_iterations: 2
  max_cost_usd: 1
`)
  const { result, done } = await runLoopHandler({}, { cwd })
  expect(result.isError).toBe(true)
  expect(await done).toBeUndefined()
  expect(existsSync(runsRoot(cwd))).toBe(false)
})

test('a missing loopfile returns an error result', async () => {
  const cwd = tmpCwd()
  const { result, done } = await runLoopHandler({}, { cwd })
  expect(result.isError).toBe(true)
  expect(await done).toBeUndefined()
})

test('a gate node pauses the run instead of halting - it stays pending until answered', async () => {
  const cwd = tmpCwd()
  gatedFixture(cwd, { maxIterations: 2 })
  const { result, done } = await runLoopHandler({}, { cwd })
  expect(result.isError).toBeFalsy()
  const parsed = JSON.parse((result.content[0] as { text: string }).text)

  await tick()
  expect(pendingGates.has(gateKey(parsed.runId, 'approve'))).toBe(true)

  // still running: no verified/halt event in the journal, and `done` (the
  // exact promise runLoop() returns) hasn't settled either
  const events = readJournal(join(parsed.runDir, 'journal.jsonl'))
  expect(events.some((e) => e.type === 'verified' || e.type === 'halt')).toBe(false)
  let settled = false
  void done.then(() => { settled = true })
  await tick()
  expect(settled).toBe(false)

  // answer it directly (bypassing approve_gate) so this test doesn't leave a
  // dangling promise or an unresolved run behind
  pendingGates.get(gateKey(parsed.runId, 'approve'))!.resolve(true)
  const report = await done
  expect(report?.status).toBe('verified')
})

test('approve_gate approved:true lets the run continue past the gate and verify', async () => {
  const cwd = tmpCwd()
  gatedFixture(cwd, { maxIterations: 2 })
  const { result, done } = await runLoopHandler({}, { cwd })
  const parsed = JSON.parse((result.content[0] as { text: string }).text)

  await tick()
  const approval = await approveGateHandler({ runId: parsed.runId, nodeId: 'approve', approved: true }, { cwd })
  expect(approval.isError).toBeFalsy()

  const report = await done
  expect(report?.status).toBe('verified')
  // no leftover registry entry once the run has fully settled
  expect(pendingGates.has(gateKey(parsed.runId, 'approve'))).toBe(false)
})

test('approve_gate approved:false rejects the gate - the run iterates/halts per its own rails, same as the CLI', async () => {
  const cwd = tmpCwd()
  // max_iterations: 1 makes the outcome deterministic: a rejected gate is a
  // fail verdict (not a config/infra error), so routeIteration says
  // "iterate" - but the very next iteration immediately breaches
  // max_iterations, producing the same "rail breached" halt the CLI's own
  // rejected-gate-then-rail-breach path produces.
  gatedFixture(cwd, { maxIterations: 1 })
  const { result, done } = await runLoopHandler({}, { cwd })
  const parsed = JSON.parse((result.content[0] as { text: string }).text)

  await tick()
  const approval = await approveGateHandler({ runId: parsed.runId, nodeId: 'approve', approved: false }, { cwd })
  expect(approval.isError).toBeFalsy()
  const approvalParsed = JSON.parse((approval.content[0] as { text: string }).text)
  expect(approvalParsed.status).toBe('rejected')

  const report = await done
  expect(report?.status).toBe('halted')
  expect(report?.reason).toMatch(/rail breached/)
  const events = readJournal(join(parsed.runDir, 'journal.jsonl'))
  const gateEnd = events.find((e) => e.type === 'node_end' && (e.data as { nodeId?: string }).nodeId === 'approve')
  expect((gateEnd?.data as { verdict?: { status?: string } }).verdict?.status).toBe('fail')
})

test('gate_timeout is honored via an injected timer (no real setTimeout) and parks the run, same as the CLI', async () => {
  const cwd = tmpCwd()
  gatedFixture(cwd, { maxIterations: 2, gateTimeoutSec: 5 })
  const timedOut: string[] = []
  const gateTimer = async (ms: number, message: string): Promise<never> => {
    timedOut.push(message)
    throw new Error(message)
  }
  const { result, done } = await runLoopHandler({}, { cwd }, { gateTimer })
  expect(result.isError).toBeFalsy()
  const parsed = JSON.parse((result.content[0] as { text: string }).text)

  const report = await done
  expect(report?.status).toBe('halted')
  // parked, NOT an infrastructure error - a human not answering in time is
  // a human being busy, and the run is resumable (router.ts's parked branch)
  expect(report?.reason).toContain('parked awaiting human approval')
  expect(report?.reason).toContain('gate "approve" got no human answer within 5s')
  expect(report?.reason).not.toContain('infrastructure')
  expect(timedOut).toHaveLength(1)
  // the registry never keeps a timed-out gate's entry around
  expect(pendingGates.has(gateKey(parsed.runId, 'approve'))).toBe(false)
})
