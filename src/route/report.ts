import type { AgentDef } from '../core/types.js'
import type { RouteEntry, RouteResult, RoutingFile, RoutingFileEntry } from './types.js'

// Best-first: a verified variant always beats an unverified one (a cheap
// loop that never lands is not a recommendation), then cheapest wins.
// Skipped variants trail in generation order - they were announced, so the
// report must still account for them, but there is nothing to rank them by.
export function rankEntries(entries: RouteEntry[]): RouteEntry[] {
  const ran = entries.filter((e) => !e.skipped)
  const skipped = entries.filter((e) => e.skipped)
  const ranked = [...ran].sort((a, b) => {
    if (a.verified !== b.verified) return a.verified ? -1 : 1
    return (a.costUsd ?? Infinity) - (b.costUsd ?? Infinity)
  })
  return [...ranked, ...skipped]
}

// One line describing a variant's agent mix: a variant with every agent on
// the same engine collapses to just that engine, so the common case stays
// scannable; only a genuinely mixed variant spells out per-agent wiring.
export function mixLabel(agents: Record<string, AgentDef>): string {
  const engine = (a: AgentDef) => (a.model ? `${a.adapter}/${a.model}` : a.adapter)
  const engines = new Set(Object.values(agents).map(engine))
  if (engines.size === 1) return [...engines][0]
  return Object.entries(agents).map(([key, a]) => `${key}=${engine(a)}`).join(' ')
}

// The persisted contract (.looprail/routing.json / --json). Assumes
// result.entries is already ranked - entries[0] IS the recommendation.
export function buildRoutingFile(result: RouteResult, benchmarkedAt: string): RoutingFile {
  const results: RoutingFileEntry[] = result.entries.map((e) => ({
    id: e.variant.id,
    agents: e.variant.agents,
    skipped: e.skipped,
    ...(e.verified !== undefined ? { verified: e.verified } : {}),
    ...(e.iterations !== undefined ? { iterations: e.iterations } : {}),
    ...(e.costUsd !== undefined ? { costUsd: Number(e.costUsd.toFixed(4)) } : {}),
    ...(e.tokens !== undefined ? { tokens: e.tokens } : {}),
    ...(e.wallMs !== undefined ? { wallMs: e.wallMs } : {}),
  }))
  return {
    recommendedAgents: result.entries[0].variant.agents,
    benchmarkedAt,
    results,
  }
}
