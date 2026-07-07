import type { AgentDef } from '../core/types.js'

// One candidate adapter/model combination a variant can re-point agents at.
// model is only ever set for adapters with a real tier concept (claude-code
// today - see templates.ts's tierToModel, which this reuses rather than
// re-encoding tier names here).
export interface Engine {
  adapter: string
  model?: string
}

// One auto-generated arm of a routing run: the base loopfile's graph,
// verbatim, with every agent re-pointed. agents is the COMPLETE map (same
// keys as the base loopfile) so a consumer can drop it straight into a
// loopfile - or into .looprail/routing.json - without merging.
export interface RouteVariant {
  id: string
  agents: Record<string, AgentDef>
}

// What one variant produced. A variant the budget rail prevented from ever
// launching is kept (skipped: true, no measurements) rather than dropped,
// so the report always accounts for every variant that was announced.
export interface RouteEntry {
  variant: RouteVariant
  skipped: boolean
  verified?: boolean
  iterations?: number
  costUsd?: number
  tokens?: number
  wallMs?: number
}

export interface RouteResult {
  // ranked best-first (verified before unverified, then cheapest);
  // budget-skipped variants trail in generation order
  entries: RouteEntry[]
  budgetUsd: number
  spentUsd: number
}

// Shape persisted to .looprail/routing.json and printed by --json - the
// contract future tooling consumes, so field names here are load-bearing.
export interface RoutingFileEntry {
  id: string
  agents: Record<string, AgentDef>
  skipped: boolean
  verified?: boolean
  iterations?: number
  costUsd?: number
  tokens?: number
  wallMs?: number
}

export interface RoutingFile {
  recommendedAgents: Record<string, AgentDef>
  benchmarkedAt: string
  results: RoutingFileEntry[]
}
