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
  for (const key of Object.keys(fragment.agents ?? {})) {
    if (existingAgents[key]) {
      throw new Error(`invalid fragment: agent key "${key}" already exists - agents merge additively, they cannot redefine one`)
    }
  }
  for (const n of fragment.nodes) {
    if (existingNodeIds.has(n.id)) {
      throw new Error(`invalid fragment: node id "${n.id}" already exists`)
    }
  }

  const mergedAgents = { ...existingAgents, ...(fragment.agents ?? {}) }
  // Root nodes (no `after` of their own) become dependents of the gate, so
  // the scheduler's topoLayers never runs them before the human approved -
  // nodes that already declare a dependency (on each other, within the
  // fragment) keep it untouched.
  const wiredNodes = fragment.nodes.map((n) => (
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
