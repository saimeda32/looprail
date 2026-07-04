import type { JournalEvent, RunReport } from '../core/types.js'

// One named arm of a bench run: an id used in the report, and a path to an
// ordinary loopfile (resolved relative to the benchfile's own directory).
// A config never embeds a loop graph inline — there is exactly one
// YAML-to-LoopDef schema in this codebase (parseLoopfile), and benchfiles
// reuse it rather than duplicating it.
export interface BenchConfigRef {
  id: string
  loopfile: string
}

export interface BenchDef {
  name: string
  task: string
  repeat: number
  configs: BenchConfigRef[]
}

// What one run of one config produces, once looprail's own primitives have
// already done the work. RunReport alone has no per-iteration cost
// breakdown and no wall-clock duration, so this pairs it with the run's
// full journal (which does carry iteration-tagged node_end events) and a
// wallMs measured by the bench runner through the engine's own injected
// now() seam.
export interface BenchRunResult {
  report: RunReport
  events: JournalEvent[]
  wallMs: number
}

// Aggregated, per-config statistics. Every field's exact formula is defined
// and unit-tested in src/bench/metrics.ts.
export interface ConfigStats {
  id: string
  n: number
  passRate: number
  meanIterations: number
  meanIterationsToVerified: number | null
  medianIterations: number
  costMeanUsd: number
  costMedianUsd: number
  costP90Usd: number
  wallMsMean: number
  meanWastedExecutorCostUsd: number
  wastedFractionMean: number
  meanRedoIterations: number
}

export interface BenchConfigResult {
  id: string
  mode: 'mock' | 'real'
  runs: BenchRunResult[]
  stats: ConfigStats
}

export interface BenchResult {
  name: string
  task: string
  repeat: number
  configs: BenchConfigResult[]
}
