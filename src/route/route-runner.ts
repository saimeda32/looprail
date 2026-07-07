import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { runBench, type BenchDeps } from '../bench/bench-runner.js'
import type { BenchRunResult } from '../bench/types.js'
import { rankEntries } from './report.js'
import type { RouteEntry, RouteResult, RouteVariant } from './types.js'

export interface RouteRunDeps {
  registry?: BenchDeps['registry']
  registryFor?: BenchDeps['registryFor']
  now?: () => number
  runsRoot: string
  // Where variant loopfiles are materialized. runBench resolves configs
  // from files on purpose (one YAML-to-LoopDef schema, see bench/types.ts),
  // so routing writes real loopfiles instead of teaching the bench runner a
  // second, in-memory config shape.
  variantsDir: string
  // Fired as each variant actually launches, with the cost rail it was
  // given - lets the CLI narrate spend against budget live.
  onVariantStart?: (id: string, maxCostUsd: number) => void
}

// Real + estimated, matching what RailsGuard itself enforces against
// max_cost_usd - a codex/copilot loop that only ever *estimates* dollars
// must still drain the routing budget, or the budget would never bind for
// exactly the adapters most likely to be benchmarked.
function runCost(run: BenchRunResult): number {
  return run.report.costUsd + run.report.estimatedCostUsd
}

// tokens live per node_end in the journal (RunReport.outcomes only covers
// the final iteration), read defensively like bench/metrics.ts does.
function runTokens(run: BenchRunResult): number {
  let sum = 0
  for (const e of run.events) {
    if (e.type !== 'node_end') continue
    sum += Number((e.data as { tokens?: unknown }).tokens ?? 0)
  }
  return sum
}

// Executes route variants through the EXISTING bench machinery - one
// single-config runBench call per variant rather than one call for all of
// them, because the budget decision ("is there anything left to spend?")
// has to happen BETWEEN launches, a seam runBench's all-configs loop does
// not have and should not grow for this.
export async function runRoute(
  baseText: string,
  variants: RouteVariant[],
  budgetUsd: number,
  deps: RouteRunDeps,
): Promise<RouteResult> {
  const entries: RouteEntry[] = []
  let spent = 0

  for (const variant of variants) {
    const remaining = budgetUsd - spent
    if (remaining <= 0) {
      entries.push({ variant, skipped: true })
      continue
    }

    // re-parse per variant so each document is an independent clone of the
    // user's loopfile - graph/goal/verdict untouched, only agents re-pointed
    // and the cost rail clamped to what the budget still allows
    const doc = parse(baseText) as Record<string, unknown>
    doc.agents = variant.agents
    const rails = { ...(doc.rails as Record<string, number>) }
    rails.max_cost_usd = Math.min(rails.max_cost_usd, remaining)
    doc.rails = rails
    const loopfile = `${variant.id}.yaml`
    writeFileSync(join(deps.variantsDir, loopfile), stringify(doc))
    deps.onVariantStart?.(variant.id, rails.max_cost_usd)

    const result = await runBench(
      { name: 'route', task: String(doc.goal), repeat: 1, configs: [{ id: variant.id, loopfile }] },
      deps.variantsDir,
      { registry: deps.registry, registryFor: deps.registryFor, now: deps.now, runsRoot: deps.runsRoot },
    )
    const run = result.configs[0].runs[0]
    spent += runCost(run)
    entries.push({
      variant,
      skipped: false,
      verified: run.report.status === 'verified',
      iterations: run.report.iterations,
      costUsd: runCost(run),
      tokens: runTokens(run),
      wallMs: run.wallMs,
    })
  }

  return { entries: rankEntries(entries), budgetUsd, spentUsd: spent }
}
