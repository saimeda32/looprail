import { expect, test } from 'vitest'
import { aggregateConfig, percentile, redoIterations, wastedExecutorCostUsd } from './metrics.js'
import type { BenchRunResult } from './types.js'
import type { JournalEvent, RunReport } from '../core/types.js'

function nodeEnd(iteration: number, role: string, costUsd: number): JournalEvent {
  return { ts: 0, type: 'node_end', data: { nodeId: `${role}@${iteration}`, role, iteration, costUsd } }
}

function report(over: Partial<RunReport> = {}): RunReport {
  return { runId: 'r', status: 'verified', reason: 'ok', iterations: 1, replans: 0, costUsd: 0, outcomes: [], ...over }
}

function run(over: Partial<BenchRunResult> = {}): BenchRunResult {
  return { report: report(), events: [], wallMs: 0, ...over }
}

test('percentile takes the nearest-rank value with no interpolation', () => {
  const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  // p90 of 10 values: idx = ceil(0.9*10)-1 = ceil(9)-1 = 8 -> xs[8] = 90
  expect(percentile(90, xs)).toBe(90)
  // p50 of 10 values: idx = ceil(5)-1 = 4 -> xs[4] = 50
  expect(percentile(50, xs)).toBe(50)
})

test('percentile on an empty array is 0', () => {
  expect(percentile(90, [])).toBe(0)
})

test('wastedExecutorCostUsd: a verified run wastes every iteration before the landed one', () => {
  const r = run({
    report: report({ status: 'verified', iterations: 2 }),
    events: [nodeEnd(1, 'executor', 3), nodeEnd(2, 'executor', 2)],
  })
  // total executor cost 3+2=5; landed (iteration 2) = 2; wasted = 5-2 = 3
  expect(wastedExecutorCostUsd(r)).toBe(3)
})

test('wastedExecutorCostUsd: a halted run wastes everything (nothing landed)', () => {
  const r = run({
    report: report({ status: 'halted', iterations: 2 }),
    events: [nodeEnd(1, 'executor', 2), nodeEnd(2, 'executor', 2)],
  })
  expect(wastedExecutorCostUsd(r)).toBe(4)
})

test('wastedExecutorCostUsd: no executor events wastes nothing', () => {
  const r = run({ events: [{ ts: 0, type: 'node_end', data: { role: 'critic', iteration: 1, costUsd: 1 } }] })
  expect(wastedExecutorCostUsd(r)).toBe(0)
})

test('redoIterations counts passes beyond the first', () => {
  expect(redoIterations(run({ report: report({ iterations: 1 }) }))).toBe(0)
  expect(redoIterations(run({ report: report({ iterations: 3 }) }))).toBe(2)
})

test('aggregateConfig: pass rate and mean-iterations-to-verified over the verified subset only', () => {
  const results = [
    run({ report: report({ status: 'verified', iterations: 1, costUsd: 1 }) }),
    run({ report: report({ status: 'verified', iterations: 3, costUsd: 1 }) }),
    run({ report: report({ status: 'halted', iterations: 3, costUsd: 1 }) }),
    run({ report: report({ status: 'halted', iterations: 3, costUsd: 1 }) }),
    run({ report: report({ status: 'halted', iterations: 3, costUsd: 1 }) }),
  ]
  const stats = aggregateConfig('x', results)
  expect(stats.n).toBe(5)
  expect(stats.passRate).toBeCloseTo(0.4, 5) // 2 of 5 verified
  expect(stats.meanIterationsToVerified).toBe(2) // (1+3)/2
  expect(stats.meanIterations).toBe(2.6) // (1+3+3+3+3)/5
})

test('aggregateConfig: meanIterationsToVerified is null when nothing verified', () => {
  const results = [run({ report: report({ status: 'halted' }) })]
  expect(aggregateConfig('x', results).meanIterationsToVerified).toBeNull()
})

test('aggregateConfig: cost mean/median/p90 arithmetic', () => {
  const results = [1, 2, 3, 4, 5].map((c) => run({ report: report({ costUsd: c }) }))
  const stats = aggregateConfig('x', results)
  expect(stats.costMeanUsd).toBe(3) // (1+2+3+4+5)/5
  expect(stats.costMedianUsd).toBe(3)
  // p90 of [1,2,3,4,5]: idx = ceil(0.9*5)-1 = ceil(4.5)-1 = 5-1 = 4 -> 5
  expect(stats.costP90Usd).toBe(5)
})

test('aggregateConfig: wallMsMean and meanRedoIterations', () => {
  const results = [
    run({ report: report({ iterations: 1 }), wallMs: 100 }),
    run({ report: report({ iterations: 3 }), wallMs: 300 }),
  ]
  const stats = aggregateConfig('x', results)
  expect(stats.wallMsMean).toBe(200)
  expect(stats.meanRedoIterations).toBe(1) // (0 + 2) / 2
})
