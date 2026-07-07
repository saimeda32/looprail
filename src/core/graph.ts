import type { LoopDef, NodeDef, Role } from './types.js'

const AGENT_ROLES = new Set(['planner', 'critic', 'executor', 'judge', 'synthesizer'])
const VALID_ROLES: Set<Role> = new Set(['planner', 'critic', 'executor', 'tester', 'judge', 'gate', 'synthesizer'])

export function validateGraph(def: LoopDef): string[] {
  const errors: string[] = []
  const ids = new Set(def.nodes.map((n) => n.id))
  if (ids.size !== def.nodes.length) errors.push('duplicate node ids')

  const byId = new Map(def.nodes.map((n) => [n.id, n]))
  for (const n of def.nodes) {
    // `role` is only a compile-time-checked type in NodeDef - nothing at
    // runtime stops a hand-written loopfile or (worse) an LLM-generated
    // graph fragment from using a role that was never one of the real
    // ones (or omitting it entirely, e.g. by inventing its own unrelated
    // field names). Every check below that's keyed on role silently no-ops
    // for a role it doesn't recognize, so this must be checked explicitly
    // or a completely malformed node sails through with zero errors.
    if (!VALID_ROLES.has(n.role)) {
      errors.push(`node "${n.id}": unknown role "${String(n.role)}"`)
    }
    for (const dep of n.after ?? []) {
      if (!ids.has(dep)) errors.push(`node "${n.id}" depends on unknown node "${dep}"`)
    }
    if (n.of && !ids.has(n.of)) errors.push(`critic "${n.id}" targets unknown node "${n.of}"`)
    if (n.of && byId.get(n.of)?.panel !== undefined) {
      errors.push(
        `node "${n.id}": of targets panel node "${n.of}" - reviewing a fan-out is ambiguous; ` +
        'insert a synthesizer between them',
      )
    }
    if (typeof n.panel === 'number' && (!Number.isInteger(n.panel) || n.panel < 1)) {
      errors.push(`node "${n.id}": panel must be >= 1`)
    }
    // A numeric panel clones the node N times reusing its `agent`. On a
    // non-agent role (tester, gate) `agent` is undefined/ignored, so this
    // silently produces N identical clones with a meaningless agent - reject it.
    if (typeof n.panel === 'number' && !AGENT_ROLES.has(n.role)) {
      errors.push(`node "${n.id}" (${n.role}): a numeric panel fans out over an agent, which a ${n.role} node has none of`)
    }
    const needsAgent = AGENT_ROLES.has(n.role) && !Array.isArray(n.panel)
    if (needsAgent && !n.agent) errors.push(`node "${n.id}" (${n.role}) has no agent`)
    if (n.agent && !def.agents[n.agent]) {
      errors.push(`node "${n.id}" uses unknown agent "${n.agent}"`)
    }
    if (Array.isArray(n.panel)) {
      for (const a of n.panel) {
        if (!def.agents[a]) errors.push(`node "${n.id}" panel uses unknown agent "${a}"`)
      }
    }
    if (n.role === 'tester' && !n.run) errors.push(`tester "${n.id}" has no run command`)
  }

  // AgentDef.fallback is only ever consulted after a rate-limit failure
  // (see engine/nodes.ts), so a typo'd key or an a->b->a loop would stay
  // invisible until the exact moment a provider throttles a long overnight
  // run - the worst possible time to discover a config error. Checked here,
  // where every other reference (after/of/agent) is already checked.
  for (const [key, agent] of Object.entries(def.agents)) {
    if (agent.fallback === undefined) continue
    if (!def.agents[agent.fallback]) {
      errors.push(`agent "${key}": fallback references unknown agent "${agent.fallback}"`)
      continue
    }
    const chain = [key]
    let next: string | undefined = agent.fallback
    while (next !== undefined && def.agents[next] !== undefined) {
      if (chain.includes(next)) {
        errors.push(`agent "${key}": fallback chain cycles (${[...chain, next].join(' -> ')})`)
        break
      }
      chain.push(next)
      next = def.agents[next].fallback
    }
  }

  try {
    topoLayers(def.nodes)
  } catch {
    errors.push('graph contains a cycle')
  }
  return errors
}

// Transitive DESCENDANTS of each node: every node that depends on it,
// directly or through a chain, via `after` or `of`. This is what makes
// feedback lineage-scoped (see core/context.ts): a node should only be
// disturbed by failures in work DERIVED from its own output - a critic
// with `of: do` is a descendant of `do`, so `do` sees that critic's
// failure; an independent branch's executor is NOT a descendant of that
// critic, so its composed prompt is unchanged and the cache serves it
// instead of pointlessly re-running it. Real waste caught live: one
// branch's failure forced the WHOLE execution region to rebuild because
// the global feedback string changed every node's prompt.
export function descendantsByNode(nodes: NodeDef[]): Map<string, Set<string>> {
  const ids = new Set(nodes.map((n) => n.id))
  // direct dependents: for each node, who lists it in after/of
  const directDependents = new Map<string, string[]>()
  for (const id of ids) directDependents.set(id, [])
  for (const n of nodes) {
    const deps = new Set(n.after ?? [])
    if (n.of && ids.has(n.of)) deps.add(n.of)
    for (const dep of deps) if (ids.has(dep)) directDependents.get(dep)!.push(n.id)
  }
  const result = new Map<string, Set<string>>()
  for (const n of nodes) {
    const seen = new Set<string>()
    const stack = [...(directDependents.get(n.id) ?? [])]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const next of directDependents.get(cur) ?? []) stack.push(next)
    }
    result.set(n.id, seen)
  }
  return result
}

export function topoLayers(nodes: NodeDef[]): string[][] {
  const ids = new Set(nodes.map((n) => n.id))
  const remaining = new Map(nodes.map((n) => {
    const deps = new Set(n.after ?? [])
    // `of` is a data dependency: the review target must run first. Only add the
    // edge when the target is in the set being scheduled (regions strip the rest).
    if (n.of && ids.has(n.of)) deps.add(n.of)
    return [n.id, deps] as const
  }))
  const layers: string[][] = []
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id)
    if (ready.length === 0) throw new Error('cycle detected')
    layers.push(ready)
    for (const id of ready) remaining.delete(id)
    for (const deps of remaining.values()) for (const id of ready) deps.delete(id)
  }
  return layers
}

export function expandPanels(def: LoopDef): LoopDef {
  const expansion = new Map<string, string[]>()
  const nodes: NodeDef[] = []
  // Probe wiring is only sound under all-pass: there, one clone's fail already
  // determines the aggregate, so skipping its siblings cannot change the
  // iterate/stop decision. Under quorum/weighted a single fail decides
  // nothing (2 passes + 1 fail can still meet a quorum of 2), so probe is
  // ignored and the panel runs at full width (lint L012 tells the author).
  const probeApplies = def.verdictPolicy.kind === 'all-pass'
  for (const n of def.nodes) {
    if (!n.panel) { nodes.push(n); continue }
    const agents = Array.isArray(n.panel)
      ? n.panel
      : Array.from({ length: n.panel }, () => n.agent!)
    const leaderId = `${n.id}@1`
    const clones = agents.map((agent, i) => ({
      ...n, id: `${n.id}@${i + 1}`, agent, panel: undefined, probe: undefined,
      // Followers of a probe panel wait on the leader and record who it is,
      // so the scheduler can skip them once the leader has already failed
      // the iteration. The leader itself keeps the original wiring.
      ...(probeApplies && n.probe && i > 0
        ? { after: [...(n.after ?? []), leaderId], probeOf: leaderId }
        : {}),
    }))
    expansion.set(n.id, clones.map((c) => c.id))
    nodes.push(...clones)
  }
  const rewired = nodes.map((n) => ({
    ...n,
    after: n.after?.flatMap((dep) => expansion.get(dep) ?? [dep]),
  }))
  return { ...def, nodes: rewired }
}
