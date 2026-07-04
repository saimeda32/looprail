import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runsRoot, type JournalEvent } from '../../index.js'
import { gateKey, pendingGates } from './gate-registry.js'
import { runLoopHandler } from './run-loop.js'
import { runStatusHandler } from './run-status.js'

function ev(type: JournalEvent['type'], data: Record<string, unknown>): JournalEvent {
  return { ts: 0, type, data }
}

function writeRun(cwd: string, runId: string, events: JournalEvent[]): void {
  const dir = join(runsRoot(cwd), runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'journal.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'lr-mcp-status-'))
}

test('reports status for an explicit runId', async () => {
  const cwd = tmpCwd()
  writeRun(cwd, 'run-1', [
    ev('run_start', { runId: 'run-1', name: 'demo' }),
    ev('iteration_end', { iteration: 1, costUsd: 0.2 }),
    ev('verified', { reason: 'ok', costUsd: 0.2 }),
  ])
  const result = await runStatusHandler({ runId: 'run-1' }, { cwd })
  expect(result.isError).toBeFalsy()
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed).toMatchObject({ runId: 'run-1', status: 'verified', costUsd: 0.2 })
})

test('defaults to the latest run (by mtime) when runId is omitted', async () => {
  const cwd = tmpCwd()
  writeRun(cwd, 'run-old', [ev('run_start', { runId: 'run-old', name: 'x' })])
  writeRun(cwd, 'run-new', [ev('run_start', { runId: 'run-new', name: 'y' })])
  utimesSync(join(runsRoot(cwd), 'run-old'), new Date(1000), new Date(1000))
  utimesSync(join(runsRoot(cwd), 'run-new'), new Date(2000), new Date(2000))
  const result = await runStatusHandler({}, { cwd })
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.runId).toBe('run-new')
})

test('an unknown runId returns an error result', async () => {
  const cwd = tmpCwd()
  const result = await runStatusHandler({ runId: 'nope' }, { cwd })
  expect(result.isError).toBe(true)
})

test('no runs at all returns an error result', async () => {
  const cwd = tmpCwd()
  const result = await runStatusHandler({}, { cwd })
  expect(result.isError).toBe(true)
})

test('reports waitingOnGates once a gate node has started but not yet ended', async () => {
  const cwd = tmpCwd()
  writeRun(cwd, 'run-gate', [
    ev('run_start', { runId: 'run-gate', name: 'demo' }),
    ev('node_start', { nodeId: 'do', role: 'executor', iteration: 1 }),
    ev('node_end', { nodeId: 'do', role: 'executor', iteration: 1, verdict: null, costUsd: 0 }),
    ev('node_start', { nodeId: 'approve', role: 'gate', iteration: 1 }),
  ])
  const result = await runStatusHandler({ runId: 'run-gate' }, { cwd })
  expect(result.isError).toBeFalsy()
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.waitingOnGates).toEqual([{ nodeId: 'approve' }])
})

test('reports EVERY concurrently-paused gate, not just the first', async () => {
  const cwd = tmpCwd()
  // Two independent gate nodes started, neither ended: the scheduler runs
  // them concurrently, so both are paused at once and both must be reported.
  writeRun(cwd, 'run-two-gates', [
    ev('run_start', { runId: 'run-two-gates', name: 'demo' }),
    ev('node_start', { nodeId: 'approve-a', role: 'gate', iteration: 1 }),
    ev('node_start', { nodeId: 'approve-b', role: 'gate', iteration: 1 }),
  ])
  const result = await runStatusHandler({ runId: 'run-two-gates' }, { cwd })
  expect(result.isError).toBeFalsy()
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.waitingOnGates).toEqual([{ nodeId: 'approve-a' }, { nodeId: 'approve-b' }])
})

test('does not report waitingOnGates once the gate node has a matching node_end', async () => {
  const cwd = tmpCwd()
  writeRun(cwd, 'run-gate-done', [
    ev('run_start', { runId: 'run-gate-done', name: 'demo' }),
    ev('node_start', { nodeId: 'approve', role: 'gate', iteration: 1 }),
    ev('node_end', {
      nodeId: 'approve', role: 'gate', iteration: 1, costUsd: 0,
      verdict: { node: 'approve', status: 'pass', evidence: 'human approved' },
    }),
    ev('iteration_end', { iteration: 1, costUsd: 0 }),
  ])
  const result = await runStatusHandler({ runId: 'run-gate-done' }, { cwd })
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.waitingOnGates).toBeUndefined()
})

test('reflects a real, live pending gate (with question text) for a run started via run_loop', async () => {
  const cwd = tmpCwd()
  writeFileSync(join(cwd, 'looprail.yaml'), `
name: gated-mcp
goal: Needs approval.
agents:
  worker: { adapter: mock }
graph:
  do:      { role: executor, agent: worker }
  approve: { role: gate, after: do }
rails:
  max_iterations: 2
  max_cost_usd: 1
`)
  const { result, done } = await runLoopHandler({}, { cwd })
  const parsed = JSON.parse((result.content[0] as { text: string }).text)

  // flush the (purely microtask) chain from run_loop's start through the
  // gate node registering itself - see run-loop.test.ts's tick() for why a
  // single macrotask tick is sufficient and deterministic here.
  await new Promise((resolve) => setImmediate(resolve))

  const status = await runStatusHandler({ runId: parsed.runId, cwd }, { cwd })
  expect(status.isError).toBeFalsy()
  const statusParsed = JSON.parse((status.content[0] as { text: string }).text)
  expect(statusParsed.waitingOnGates).toHaveLength(1)
  expect(statusParsed.waitingOnGates[0].nodeId).toBe('approve')
  expect(typeof statusParsed.waitingOnGates[0].question).toBe('string')
  expect(statusParsed.waitingOnGates[0].question.length).toBeGreaterThan(0)

  // cleanup: resolve so this test doesn't leave a dangling promise behind
  pendingGates.get(gateKey(parsed.runId, 'approve'))!.resolve(true)
  await done
})
