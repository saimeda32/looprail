import type { AgentDef, NodeDef, Rails } from '../core/types.js'
import type { GraphFragment } from '../config/loopfile.js'
import { validateGraph } from '../core/graph.js'

export interface SpliceResult {
  nodes: NodeDef[]
  agents: Record<string, AgentDef>
  rails: Partial<Rails>
}

// Validates and prepares a generated graph fragment for merging into a live
// run. Never mutates its inputs - the caller (runner.ts) decides when to
// swap in the returned nodes/agents. See
// docs/superpowers/specs/2026-07-04-self-planning-loop-design.md.
export function spliceFragment(
  fragment: GraphFragment,
  existingAgents: Record<string, AgentDef>,
  existingNodeIds: Set<string>,
  gateNodeId: string,
): SpliceResult {
  // A colliding agents key is a purely mechanical failure - we already know
  // exactly what's wrong (one key name collides with the live run's agent
  // set) and exactly what a valid fix looks like (rename that one key to
  // something that doesn't collide, and rewire this fragment's own nodes
  // that reference it). Auto-repairing it here means one whole extra LLM
  // replan is avoided for a failure mode that has no judgment call in it.
  // `agentRenames` tracks old key -> new key so node `agent:` fields can be
  // rewritten below; `reservedAgentKeys` is every name already spoken for
  // (the live run's agents, this fragment's own untouched keys, and any
  // rename already chosen) so a rename can never collide with any of those.
  const agentRenames = new Map<string, string>()
  const reservedAgentKeys = new Set([...Object.keys(existingAgents), ...Object.keys(fragment.agents ?? {})])
  const renamedFragmentAgents: Record<string, AgentDef> = {}
  const MAX_RENAME_ATTEMPTS = 1000
  for (const [key, def] of Object.entries(fragment.agents ?? {})) {
    if (!existingAgents[key]) {
      renamedFragmentAgents[key] = def
      continue
    }
    let renamed: string | undefined
    for (let i = 2; i <= MAX_RENAME_ATTEMPTS; i++) {
      const candidate = `${key}-${i}`
      if (!existingAgents[candidate] && !reservedAgentKeys.has(candidate)) {
        renamed = candidate
        break
      }
    }
    if (renamed === undefined) {
      throw new Error(`invalid fragment: agent key "${key}" already exists - agents merge additively, they cannot redefine one`)
    }
    agentRenames.set(key, renamed)
    reservedAgentKeys.add(renamed)
    renamedFragmentAgents[renamed] = def
  }
  const renamedNodes = agentRenames.size === 0
    ? fragment.nodes
    : fragment.nodes.map((n) => (
        n.agent !== undefined && agentRenames.has(n.agent)
          ? { ...n, agent: agentRenames.get(n.agent)! }
          : n
      ))

  for (const n of renamedNodes) {
    if (existingNodeIds.has(n.id)) {
      throw new Error(`invalid fragment: node id "${n.id}" already exists`)
    }
  }

  const mergedAgents = { ...existingAgents, ...renamedFragmentAgents }
  // Root nodes (no `after` of their own) become dependents of the gate, so
  // the scheduler's topoLayers never runs them before the human approved -
  // nodes that already declare a dependency (on each other, within the
  // fragment) keep it untouched.
  const wiredNodes = renamedNodes.map((n) => (
    n.after === undefined || n.after.length === 0
      ? { ...n, after: [gateNodeId] }
      : n
  ))

  // validateGraph needs a full LoopDef shape - a minimal synthetic one
  // built from just the merged agents and the fragment's own nodes is
  // enough to reuse every existing check (unknown agent, cycle, panel
  // rules, ...) with no duplicated validation logic. The gate dependency
  // just wired in above points outside the fragment (at a node already
  // known-valid in the live run), so it's stripped for this check only -
  // same symmetric-dep-filtering technique runner.ts's splitRegions uses -
  // or validateGraph would misreport it as an unknown-node reference.
  const fragmentIds = new Set(wiredNodes.map((n) => n.id))
  const nodesForValidation = wiredNodes.map((n) => ({
    ...n, after: n.after?.filter((d) => fragmentIds.has(d)),
  }))
  const errors = validateGraph({
    name: '', goal: '', agents: mergedAgents, nodes: nodesForValidation,
    rails: { maxIterations: 1, maxCostUsd: 1 }, verdictPolicy: { kind: 'all-pass' },
  })
  if (errors.length > 0) {
    throw new Error(`invalid fragment: ${errors.join('; ')}`)
  }

  return { nodes: wiredNodes, agents: mergedAgents, rails: fragment.rails ?? {} }
}
