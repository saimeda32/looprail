import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { latestRunId, listRunIds, reconstructRunState, runsRoot, summarizeJournal } from './runs.js'
import type { JournalEvent } from '../core/types.js'

test('listRunIds on a cwd with no runs directory returns an empty array', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-runs-'))
  expect(listRunIds(cwd)).toEqual([])
  expect(latestRunId(cwd)).toBeNull()
})

test('listRunIds returns only run dirs that have a journal, newest-modified first', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-runs-'))
  const root = runsRoot(cwd)
  mkdirSync(join(root, 'run-a'), { recursive: true })
  writeFileSync(join(root, 'run-a', 'journal.jsonl'), '')
  mkdirSync(join(root, 'run-b'), { recursive: true })
  writeFileSync(join(root, 'run-b', 'journal.jsonl'), '')
  mkdirSync(join(root, 'run-c-no-journal'), { recursive: true }) // excluded: no journal.jsonl
  const ids = listRunIds(cwd)
  expect([...ids].sort()).toEqual(['run-a', 'run-b'])
  expect(latestRunId(cwd)).toBe(ids[0])
})

function ev(type: JournalEvent['type'], data: Record<string, unknown>): JournalEvent {
  return { ts: 0, type, data }
}

test('reconstructRunState returns null plan and null feedback for an empty journal', () => {
  expect(reconstructRunState([])).toEqual({ plan: null, feedback: null, sources: [], priorOutputs: {} })
})

test('reconstructRunState picks up the last planner output', () => {
  const events = [
    ev('node_end', { nodeId: 'plan', role: 'planner', output: 'v1' }),
    ev('node_end', { nodeId: 'plan', role: 'planner', output: 'v2 (revised)' }),
  ]
  expect(reconstructRunState(events).plan).toBe('v2 (revised)')
})

test('reconstructRunState composes feedback only from the last completed iteration\'s failing verdicts', () => {
  const events = [
    ev('node_end', { nodeId: 'crit', iteration: 1, verdict: { status: 'fail', evidence: 'iteration 1 problem' } }),
    ev('iteration_end', { iteration: 1 }),
    ev('node_end', { nodeId: 'crit', iteration: 2, verdict: { status: 'fail', evidence: 'iteration 2 problem' } }),
    // no iteration_end for iteration 2 - it breached a rail before completing
  ]
  expect(reconstructRunState(events).feedback).toBe('[crit] iteration 1 problem')
})

test('reconstructRunState returns null feedback when the last iteration had no failing verdicts', () => {
  const events = [
    ev('node_end', { nodeId: 'crit', iteration: 1, verdict: { status: 'pass', evidence: 'ok' } }),
    ev('iteration_end', { iteration: 1 }),
  ]
  expect(reconstructRunState(events).feedback).toBeNull()
})

// "No human answered in time" is not actionable feedback for any agent -
// and if it leaked into the reconstructed feedback, every downstream node's
// prompt (and therefore cache hash) would change on resume, silently
// re-running and re-billing work the run finished before it parked.
test('reconstructRunState excludes a parked: gate verdict from feedback and sources - parking must cost zero repeated work on resume', () => {
  const events = [
    ev('node_end', { nodeId: 'approve', iteration: 1, verdict: { status: 'error', evidence: 'parked: gate "approve" got no human answer within 600s - resume the run to answer it' } }),
    ev('iteration_end', { iteration: 1 }),
  ]
  const { feedback, sources } = reconstructRunState(events)
  expect(feedback).toBeNull()
  expect(sources).toEqual([])
})

// --- precise-exclusion provenance: `sources` names exactly the node_end
// entries that fed `feedback`/`plan`, so cache.ts's loadCache can exclude
// only those, instead of every node_end sharing the halted iteration number.

test('reconstructRunState names the failing critic(s) that composed feedback as sources, tagged with the iteration their evidence came from', () => {
  const events = [
    ev('node_end', { nodeId: 'critA', iteration: 1, verdict: { status: 'pass', evidence: 'A ok' } }),
    ev('node_end', { nodeId: 'critB', iteration: 1, verdict: { status: 'fail', evidence: 'B broken' } }),
    ev('iteration_end', { iteration: 1 }),
  ]
  const { sources } = reconstructRunState(events)
  // critA passed - it did not feed the reconstructed feedback, so it must
  // NOT be named as a source (its cache entry is safe to reuse on resume).
  // critB failed - its own evidence composed `feedback` byte-for-byte, so
  // it must be named so loadCache can exclude exactly that entry.
  expect(sources).toEqual([{ nodeId: 'critB', iteration: 1 }])
})

test('reconstructRunState names the planner node_end that composed `plan` as a source, tagged with the iteration it ran in', () => {
  const events = [
    ev('node_end', { nodeId: 'plan', role: 'planner', iteration: 1, output: 'v1' }),
    ev('iteration_end', { iteration: 1 }),
    ev('node_end', { nodeId: 'plan', role: 'planner', iteration: 3, output: 'v2 (revised)' }),
  ]
  const { sources } = reconstructRunState(events)
  expect(sources).toContainEqual({ nodeId: 'plan', iteration: 3 }) // the LAST planner run, not the first
})

test('reconstructRunState names both the planner source and the failing-critic source together when both feedback and plan are reconstructed', () => {
  const events = [
    ev('node_end', { nodeId: 'plan', role: 'planner', iteration: 1, output: 'the plan' }),
    ev('node_end', { nodeId: 'critA', iteration: 2, verdict: { status: 'fail', evidence: 'nope' } }),
    ev('node_end', { nodeId: 'do', iteration: 2, output: 'work' }),
    ev('iteration_end', { iteration: 2 }),
  ]
  const { sources } = reconstructRunState(events)
  expect(sources.sort((a, b) => a.nodeId.localeCompare(b.nodeId))).toEqual([
    { nodeId: 'critA', iteration: 2 },
    { nodeId: 'plan', iteration: 1 },
  ])
})

test('summarizeJournal surfaces estimatedCostUsd separately from costUsd, from iteration_end', () => {
  const events = [
    ev('run_start', { runId: 'r1', name: 'demo' }),
    ev('iteration_end', { iteration: 1, costUsd: 0, estimatedCostUsd: 0.42 }),
  ]
  const s = summarizeJournal(events)
  expect(s.costUsd).toBe(0)
  expect(s.estimatedCostUsd).toBeCloseTo(0.42)
})

test('summarizeJournal reconciles estimatedCostUsd from the terminal verified/halt event, never conflating it with real cost', () => {
  const events = [
    ev('run_start', { runId: 'r1', name: 'demo' }),
    ev('iteration_end', { iteration: 1, costUsd: 0, estimatedCostUsd: 0.5 }),
    ev('halt', { reason: 'rail breached (cost)', costUsd: 0, estimatedCostUsd: 1.2 }),
  ]
  const s = summarizeJournal(events)
  expect(s.status).toBe('halted')
  expect(s.costUsd).toBe(0)
  expect(s.estimatedCostUsd).toBeCloseTo(1.2)
})

test('summarizeJournal defaults estimatedCostUsd to 0 when no event ever carries one', () => {
  const events = [
    ev('run_start', { runId: 'r1', name: 'demo' }),
    ev('iteration_end', { iteration: 1, costUsd: 0.3 }),
  ]
  const s = summarizeJournal(events)
  expect(s.estimatedCostUsd).toBe(0)
})
