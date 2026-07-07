import type { DetectedAgent } from '../adapters/detect.js'
import type { AgentDef, LoopDef } from '../core/types.js'
import { tierToModel } from '../cli/templates.js'
import type { Engine, RouteVariant } from './types.js'

export function engineId(e: Engine): string {
  return e.model ? `${e.adapter}-${e.model}` : e.adapter
}

export function engineLabel(e: Engine): string {
  return e.model ? `${e.adapter}/${e.model}` : e.adapter
}

// The engine a given adapter contributes in the fairness pass, and the one
// a cross-model critic gets pointed at: claude-code's is its middle tier
// (the same "medium" default init recommends for workers), everything else
// defers to its CLI's own default model - tierToModel is the single
// authority on tier->model naming, reused rather than re-encoded.
function defaultEngine(adapter: string): Engine {
  const model = tierToModel(adapter, 'medium')
  return model ? { adapter, model } : { adapter }
}

// Candidate engines, ordered so a small --variants cap treats every
// installed provider equally: pass 1 gives each adapter exactly one slot
// (its default engine, in detection order) before pass 2 spends any slots
// on claude-code's remaining tiers. Without this, a cap of 4 with two
// providers installed would burn three slots on claude tiers alone.
function orderedEngines(adapters: string[]): Engine[] {
  const engines: Engine[] = adapters.map(defaultEngine)
  for (const adapter of adapters) {
    for (const tier of ['strong', 'cheap'] as const) {
      const model = tierToModel(adapter, tier)
      if (model) engines.push({ adapter, model })
    }
  }
  return engines
}

// Agent keys referenced EXCLUSIVELY by critic nodes are safe to re-point at
// a second adapter without also changing who does the work: a key shared
// with an executor/planner node must follow the primary engine, or the
// variant would no longer measure that engine's work at all.
function criticOnlyAgentKeys(def: LoopDef): Set<string> {
  const referenced = new Map<string, boolean>()
  for (const n of def.nodes) {
    if (!n.agent) continue
    const soFar = referenced.get(n.agent)
    referenced.set(n.agent, (soFar ?? true) && n.role === 'critic')
  }
  return new Set([...referenced.entries()].filter(([, criticOnly]) => criticOnly).map(([k]) => k))
}

function repoint(base: AgentDef, engine: Engine): AgentDef {
  // spread first so permissions/command survive; model is then explicitly
  // set or dropped - a stale claude tier must never leak onto e.g. codex
  const next: AgentDef = { ...base, adapter: engine.adapter }
  if (engine.model) next.model = engine.model
  else delete next.model
  return next
}

// Generates the variant arms `looprail route` benchmarks: one per candidate
// engine (capped), each with the base loopfile's graph untouched and every
// agent re-pointed at that engine - except critic-only agents, which (when
// a second provider is installed) are paired with a DIFFERENT adapter, the
// cross-model-critic setup the templates already recommend for catching
// what a worker's own model misses.
export function generateVariants(def: LoopDef, detected: DetectedAgent[], cap: number): RouteVariant[] {
  const adapters = detected.filter((a) => a.available).map((a) => a.adapter)
  const criticKeys = criticOnlyAgentKeys(def)
  const variants: RouteVariant[] = []

  for (const engine of orderedEngines(adapters)) {
    if (variants.length >= cap) break
    // cross pairing needs both a second provider and an agent that is
    // safe to re-point independently of the work being measured
    const criticAdapter = adapters.find((a) => a !== engine.adapter)
    const criticEngine = criticAdapter !== undefined && criticKeys.size > 0
      ? defaultEngine(criticAdapter) : undefined

    const agents: Record<string, AgentDef> = {}
    for (const [key, agent] of Object.entries(def.agents)) {
      agents[key] = repoint(agent, criticEngine && criticKeys.has(key) ? criticEngine : engine)
    }
    const id = criticEngine ? `${engineId(engine)}+critic-${engineId(criticEngine)}` : engineId(engine)
    variants.push({ id, agents })
  }
  return variants
}
