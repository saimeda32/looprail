import { describe, expect, test } from 'vitest'
import { diagnoseRun, factsFromJournal, type RunFacts } from './diagnose.js'
import type { JournalEvent } from './types.js'

const facts = (over: Partial<RunFacts> = {}): RunFacts => ({
  status: 'halted', reason: '', iterations: 3, costUsd: 2.5, estimatedCostUsd: 0, ...over,
})

const nodeEnd = (nodeId: string, iteration: number, status: string, evidence: string, agent?: string, costUsd = 0): JournalEvent =>
  ({ ts: 0, type: 'node_end', data: { nodeId, iteration, agent, costUsd, verdict: { status, evidence } } })

describe('diagnoseRun', () => {
  test('verified: congratulates and points at --pr; surfaces gaps', () => {
    const d = diagnoseRun(facts({ status: 'verified', iterations: 2, gaps: [{ node: 'crit', gap: 'thin docs' }] }), [])
    expect(d.headline).toContain('Verified in 2')
    expect(d.nextSteps.join(' ')).toContain('--pr')
    expect(d.nextSteps.join(' ')).toContain('1 named gap')
  })

  test('cost halt: names the most expensive agent as the lever', () => {
    const events = [
      nodeEnd('build', 1, 'fail', 'not done', 'worker', 2.0),
      nodeEnd('build', 2, 'fail', 'closer', 'worker', 1.8),
      nodeEnd('crit', 2, 'pass', 'ok', 'reviewer', 0.1),
    ]
    const d = diagnoseRun(facts({ reason: 'rail breached (cost): iteration 3 exceeds max 4', costUsd: 3.9 }), events)
    expect(d.headline).toContain('Ran out of budget')
    expect(d.cause).toContain('closer') // still failing on the latest evidence
    expect(d.nextSteps[0]).toContain('worker')
    expect(d.nextSteps[0]).toContain('cheaper')
  })

  test('iteration halt on a REPEATED failure: says more iterations will not help', () => {
    const events = [
      nodeEnd('crit', 1, 'fail', 'missing the null check', 'r'),
      nodeEnd('crit', 2, 'fail', 'missing the null check', 'r'),
    ]
    const d = diagnoseRun(facts({ reason: 'rail breached (iterations): iteration 3 exceeds max 2', iterations: 2 }), events)
    expect(d.cause).toContain('stuck on the same failure')
    expect(d.cause).toContain('null check')
    expect(d.nextSteps[0]).toContain('will not help')
  })

  test('iteration halt on DIFFERENT failures each pass: suggests raising the limit', () => {
    const events = [
      nodeEnd('crit', 1, 'fail', 'problem A', 'r'),
      nodeEnd('crit', 2, 'fail', 'problem B', 'r'),
    ]
    const d = diagnoseRun(facts({ reason: 'rail breached (iterations): iteration 3 exceeds max 2' }), events)
    expect(d.nextSteps.join(' ')).toContain('raise `max_iterations')
  })

  test('not converging: points at the recurring failure and the stuck node', () => {
    const events = [
      nodeEnd('tests', 1, 'fail', 'exit 1: 2 failing', 'x'),
      nodeEnd('tests', 2, 'fail', 'exit 1: 2 failing', 'x'),
      nodeEnd('tests', 3, 'fail', 'exit 1: 2 failing', 'x'),
    ]
    const d = diagnoseRun(facts({ reason: 'not converging: the same failure(s) persisted across 3 iterations without change' }), events)
    expect(d.cause).toContain('tests')
    expect(d.cause).toContain('exit 1')
    expect(d.nextSteps.some((s) => s.includes('logs <runId> tests'))).toBe(true)
  })

  test('parked gate: reassures nothing failed, points at resume', () => {
    const d = diagnoseRun(facts({ reason: 'parked awaiting human approval: gate "approve" got no answer' }), [])
    expect(d.headline).toContain('nothing failed')
    expect(d.nextSteps.join(' ')).toContain('resume')
  })

  test('config error: says iterating cannot fix it', () => {
    const d = diagnoseRun(facts({ reason: 'config error - check your loop definition: [tests] command not found' }), [])
    expect(d.headline).toContain('misconfigured')
    expect(d.nextSteps.join(' ')).toContain('lint')
  })

  test('protect rail: explains the agent kept editing tests', () => {
    const d = diagnoseRun(facts({ reason: 'protected files were modified again after an explicit revert instruction (protect rail)' }), [])
    expect(d.headline).toContain('editing the tests')
    expect(d.nextSteps.join(' ')).toContain('logs')
  })
})

describe('factsFromJournal', () => {
  test('reconstructs status, reason, iterations, and cost from a halted run journal', () => {
    const events: JournalEvent[] = [
      { ts: 0, type: 'iteration_end', data: { iteration: 1, costUsd: 1.0 } },
      { ts: 0, type: 'iteration_end', data: { iteration: 2, costUsd: 2.0 } },
      { ts: 0, type: 'halt', data: { reason: 'rail breached (cost): over', costUsd: 2.5, estimatedCostUsd: 0.1 } },
    ]
    const f = factsFromJournal(events)!
    expect(f.status).toBe('halted')
    expect(f.iterations).toBe(2)
    expect(f.costUsd).toBe(2.5)
    expect(f.estimatedCostUsd).toBe(0.1)
    expect(f.reason).toContain('cost')
  })

  test('carries verified gaps through', () => {
    const events: JournalEvent[] = [
      { ts: 0, type: 'node_end', data: { nodeId: 'crit', verdict: { status: 'pass', gaps: ['thin docs'] } } },
      { ts: 0, type: 'iteration_end', data: { iteration: 1 } },
      { ts: 0, type: 'verified', data: { reason: 'all verifiers passed', costUsd: 0.5 } },
    ]
    const f = factsFromJournal(events)!
    expect(f.status).toBe('verified')
    expect(f.gaps).toEqual([{ node: 'crit', gap: 'thin docs' }])
  })

  test('a journal with no terminal event returns null', () => {
    expect(factsFromJournal([{ ts: 0, type: 'iteration_end', data: { iteration: 1 } }])).toBeNull()
  })
})
