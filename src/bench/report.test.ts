import { expect, test } from 'vitest'
import { renderJson, renderTable, renderVerdict } from './report.js'
import type { BenchResult, ConfigStats } from './types.js'

function stats(over: Partial<ConfigStats> = {}): ConfigStats {
  return {
    id: 'x', n: 5, passRate: 1, meanIterations: 1, meanIterationsToVerified: 1,
    medianIterations: 1, costMeanUsd: 0.01, costMedianUsd: 0.01, costP90Usd: 0.01,
    wallMsMean: 100, meanWastedExecutorCostUsd: 0, wastedFractionMean: 0, meanRedoIterations: 0,
    ...over,
  }
}

function result(over: Partial<BenchResult> = {}): BenchResult {
  return {
    name: 'demo', task: 'demo task', repeat: 5,
    configs: [
      { id: 'baseline', mode: 'mock', runs: [], stats: stats({ id: 'baseline', passRate: 0.4, meanIterationsToVerified: 1, wastedFractionMean: 0.5 }) },
      { id: 'looprail', mode: 'mock', runs: [], stats: stats({ id: 'looprail', passRate: 1, meanIterationsToVerified: 1, wastedFractionMean: 0.1 }) },
    ],
    ...over,
  }
}

test('renderVerdict picks the highest pass rate against the baseline id', () => {
  const v = renderVerdict(result())
  expect(v).toContain('"looprail" beats "baseline"')
  expect(v).toContain('+60pt pass rate')
  expect(v).toContain('40pt wasted-cost fraction')
})

test('renderVerdict reports no winner when nothing beats baseline', () => {
  const r = result({
    configs: [
      { id: 'baseline', mode: 'mock', runs: [], stats: stats({ id: 'baseline', passRate: 0.8 }) },
      { id: 'looprail', mode: 'mock', runs: [], stats: stats({ id: 'looprail', passRate: 0.8 }) },
    ],
  })
  expect(renderVerdict(r)).toContain('no configuration beat "baseline"')
})

test('renderVerdict breaks a pass-rate tie on mean iterations to verified', () => {
  const r = result({
    configs: [
      { id: 'baseline', mode: 'mock', runs: [], stats: stats({ id: 'baseline', passRate: 0.8, meanIterationsToVerified: 3 }) },
      { id: 'looprail', mode: 'mock', runs: [], stats: stats({ id: 'looprail', passRate: 0.8, meanIterationsToVerified: 1 }) },
    ],
  })
  expect(renderVerdict(r)).toContain('"looprail" beats "baseline"')
})

test('renderVerdict handles fewer than 2 configs', () => {
  expect(renderVerdict(result({ configs: [result().configs[0]] }))).toBe('not enough configs to compare')
})

test('renderTable lists every config with its mode and pass rate', () => {
  const table = renderTable(result())
  expect(table).toContain('baseline')
  expect(table).toContain('looprail')
  expect(table).toContain('40%')
  expect(table).toContain('100%')
})

test('renderTable shows the scripted-cost banner when any config is mock', () => {
  expect(renderTable(result())).toContain('SCRIPTED')
})

test('renderTable omits the scripted-cost banner when every config is real', () => {
  const r = result({ configs: result().configs.map((c) => ({ ...c, mode: 'real' as const })) })
  expect(renderTable(r)).not.toContain('SCRIPTED')
})

test('renderJson is a plain object with per-config stats and a verdict line', () => {
  const json = renderJson(result())
  expect(json.name).toBe('demo')
  expect(json.configs as unknown[]).toHaveLength(2)
  expect(typeof json.verdict).toBe('string')
})
