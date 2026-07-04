import type { BenchRunResult, ConfigStats } from './types.js'

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

// Nearest-rank percentile: sorts ascending, takes the value at
// ceil(p/100 * n) - 1, clamped to [0, n-1]. No interpolation, so the
// result is always one of the observed values — deterministic and easy
// to hand-verify against a scripted fixture.
export function percentile(p: number, xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]
}

// Sums node_end costUsd for role:executor events, optionally restricted to
// one iteration. iteration/role/costUsd come off the journal's untyped
// `data` bag (see JournalEvent), so every field is read defensively.
function executorCost(events: BenchRunResult['events'], iteration?: number): number {
  let sum = 0
  for (const e of events) {
    if (e.type !== 'node_end') continue
    const d = e.data as { role?: unknown; costUsd?: unknown; iteration?: unknown }
    if (d.role !== 'executor') continue
    if (iteration !== undefined && Number(d.iteration) !== iteration) continue
    sum += Number(d.costUsd ?? 0)
  }
  return sum
}

// A "wasted" executor dollar is one spent in an iteration that did not
// become the run's landed result:
//   - verified run (iterations = K): iterations 1..K-1 are wasted, K landed.
//   - halted run: every iteration's executor spend is wasted (nothing landed).
export function wastedExecutorCostUsd(r: BenchRunResult): number {
  const total = executorCost(r.events)
  const landed = r.report.status === 'verified' ? executorCost(r.events, r.report.iterations) : 0
  return Math.max(0, total - landed)
}

// "Redo" = iterations beyond the first attempt.
export function redoIterations(r: BenchRunResult): number {
  return Math.max(0, r.report.iterations - 1)
}

export function aggregateConfig(id: string, results: BenchRunResult[]): ConfigStats {
  const n = results.length
  const verified = results.filter((r) => r.report.status === 'verified')
  const iterations = results.map((r) => r.report.iterations)
  const costs = results.map((r) => r.report.costUsd)
  const walls = results.map((r) => r.wallMs)
  const wasted = results.map(wastedExecutorCostUsd)
  // recompute the same total executorCost used inside wastedExecutorCostUsd
  // so the fraction denominator matches exactly what produced the numerator
  const totalsExec = results.map((r) => executorCost(r.events))
  const wastedFractions = results.map((r, i) => (totalsExec[i] > 0 ? wasted[i] / totalsExec[i] : 0))
  const redo = results.map(redoIterations)

  return {
    id,
    n,
    passRate: n === 0 ? 0 : verified.length / n,
    meanIterations: mean(iterations),
    meanIterationsToVerified: verified.length === 0 ? null : mean(verified.map((r) => r.report.iterations)),
    medianIterations: median(iterations),
    costMeanUsd: mean(costs),
    costMedianUsd: median(costs),
    costP90Usd: percentile(90, costs),
    wallMsMean: mean(walls),
    meanWastedExecutorCostUsd: mean(wasted),
    wastedFractionMean: mean(wastedFractions),
    meanRedoIterations: mean(redo),
  }
}
