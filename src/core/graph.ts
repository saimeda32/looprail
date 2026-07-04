import type { LoopDef, NodeDef } from './types.js'

const AGENT_ROLES = new Set(['planner', 'critic', 'executor', 'judge', 'synthesizer'])

export function validateGraph(def: LoopDef): string[] {
  const errors: string[] = []
  const ids = new Set(def.nodes.map((n) => n.id))
  if (ids.size !== def.nodes.length) errors.push('duplicate node ids')

  const byId = new Map(def.nodes.map((n) => [n.id, n]))
  for (const n of def.nodes) {
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

  try {
    topoLayers(def.nodes)
  } catch {
    errors.push('graph contains a cycle')
  }
  return errors
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
  for (const n of def.nodes) {
    if (!n.panel) { nodes.push(n); continue }
    const agents = Array.isArray(n.panel)
      ? n.panel
      : Array.from({ length: n.panel }, () => n.agent!)
    const clones = agents.map((agent, i) => ({
      ...n, id: `${n.id}@${i + 1}`, agent, panel: undefined,
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
