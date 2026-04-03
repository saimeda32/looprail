import type { LoopDef, NodeDef } from './types.js'

const AGENT_ROLES = new Set(['planner', 'critic', 'executor', 'judge', 'synthesizer'])

export function validateGraph(def: LoopDef): string[] {
  const errors: string[] = []
  const ids = new Set(def.nodes.map((n) => n.id))
  if (ids.size !== def.nodes.length) errors.push('duplicate node ids')

  for (const n of def.nodes) {
    for (const dep of n.after ?? []) {
      if (!ids.has(dep)) errors.push(`node "${n.id}" depends on unknown node "${dep}"`)
    }
    if (n.of && !ids.has(n.of)) errors.push(`critic "${n.id}" targets unknown node "${n.of}"`)
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
  const remaining = new Map(nodes.map((n) => [n.id, new Set(n.after ?? [])]))
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
