import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { latestRunId, listRunIds, reconstructRunState, runsRoot } from './runs.js'
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
  expect(reconstructRunState([])).toEqual({ plan: null, feedback: null })
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
