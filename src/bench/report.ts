import type { BenchResult } from './types.js'

// One-line verdict: compares every config's pass rate (primary) and, on a
// tie, mean-iterations-to-verified (secondary, lower is better) against the
// config named "baseline" if present, else the first config in the list.
export function renderVerdict(result: BenchResult): string {
  const configs = result.configs
  if (configs.length < 2) return 'not enough configs to compare'
  const baseline = configs.find((c) => c.id === 'baseline') ?? configs[0]
  const best = configs.reduce((a, b) => {
    if (b.stats.passRate !== a.stats.passRate) return b.stats.passRate > a.stats.passRate ? b : a
    const aIt = a.stats.meanIterationsToVerified ?? Infinity
    const bIt = b.stats.meanIterationsToVerified ?? Infinity
    return bIt < aIt ? b : a
  })
  if (best.id === baseline.id) {
    return `no configuration beat "${baseline.id}" on pass rate (all at ${(baseline.stats.passRate * 100).toFixed(0)}%)`
  }
  const passDelta = (best.stats.passRate - baseline.stats.passRate) * 100
  const wasteDelta = (baseline.stats.wastedFractionMean - best.stats.wastedFractionMean) * 100
  return `"${best.id}" beats "${baseline.id}": ${passDelta >= 0 ? '+' : ''}${passDelta.toFixed(0)}pt pass rate, `
    + `${wasteDelta >= 0 ? '-' : '+'}${Math.abs(wasteDelta).toFixed(0)}pt wasted-cost fraction`
}

export function renderTable(result: BenchResult): string {
  const headers = [
    'config', 'mode', 'runs', 'pass rate', 'mean iters', 'iters->verified',
    'mean cost', 'p90 cost', 'wasted $', 'wasted %', 'mean wall ms',
  ]
  const rows = result.configs.map((c) => [
    c.id, c.mode, String(c.stats.n),
    `${(c.stats.passRate * 100).toFixed(0)}%`,
    c.stats.meanIterations.toFixed(2),
    c.stats.meanIterationsToVerified === null ? 'n/a' : c.stats.meanIterationsToVerified.toFixed(2),
    `$${c.stats.costMeanUsd.toFixed(4)}`,
    `$${c.stats.costP90Usd.toFixed(4)}`,
    `$${c.stats.meanWastedExecutorCostUsd.toFixed(4)}`,
    `${(c.stats.wastedFractionMean * 100).toFixed(0)}%`,
    c.stats.wallMsMean.toFixed(0),
  ])
  // fixed-width render, no table library (Global Constraints: no new deps)
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()

  const anyMock = result.configs.some((c) => c.mode === 'mock')
  const banner = anyMock
    ? 'NOTE: costs marked mode=mock are SCRIPTED, not real dollars and not a claim about live-model behavior.'
    : ''

  return [
    `${result.name} - ${result.task} (repeat=${result.repeat})`,
    line(headers), ...rows.map(line),
    renderVerdict(result),
    ...(banner ? [banner] : []),
  ].join('\n')
}

export function renderJson(result: BenchResult): Record<string, unknown> {
  return {
    name: result.name, task: result.task, repeat: result.repeat,
    configs: result.configs.map((c) => ({ id: c.id, mode: c.mode, stats: c.stats })),
    verdict: renderVerdict(result),
  }
}
