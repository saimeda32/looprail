import type { LoopDef, NodeDef, NodeOutcome, PermissionRequest } from '../core/types.js'
import { topoLayers } from '../core/graph.js'
import type { RunState } from '../core/context.js'
import { executeNode, type EngineDeps } from './nodes.js'

async function pool<T>(
  items: (() => Promise<T>)[],
  limit: number,
  shouldContinue?: () => boolean,
): Promise<(T | undefined)[]> {
  const results: (T | undefined)[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      // pre-start rail check (spec §6): never START a node once a rail is
      // breached - in-flight nodes finish, unstarted ones are skipped
      if (shouldContinue && !shouldContinue()) return
      const i = next++
      results[i] = await items[i]()
    }
  })
  await Promise.all(workers)
  return results
}

export async function runIteration(
  def: LoopDef,
  nodes: NodeDef[],
  state: RunState,
  deps: EngineDeps,
  onNode?: (o: NodeOutcome) => void,
  shouldContinue?: () => boolean,
  onNodeStart?: (node: NodeDef) => void,
  onChunk?: (nodeId: string, chunk: string) => void,
  onPermission?: (
    nodeId: string,
    req: PermissionRequest,
  ) => Promise<boolean | { approved: boolean; feedback?: string }>,
): Promise<NodeOutcome[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const outcomes = new Map<string, NodeOutcome>()
  const ordered: NodeOutcome[] = []

  for (const layer of topoLayers(nodes)) {
    const layerResults = await pool(
      layer.map((id) => async () => {
        const node = byId.get(id)!
        // Probe panel short-circuit (EFF-5): a follower whose leader already
        // FAILED this iteration is pure spend - under all-pass the aggregate
        // is determined, its verdict cannot change the iterate/stop decision.
        // Skips ONLY on a definite fail (pass/error/missing dispatch
        // normally) and ONLY under all-pass (expandPanels only sets probeOf
        // there; this guard keeps the invariant local). Same "no outcome
        // exists" posture as a rail-breach skip.
        if (
          node.probeOf && def.verdictPolicy.kind === 'all-pass'
          && outcomes.get(node.probeOf)?.verdict?.status === 'fail'
        ) return undefined
        onNodeStart?.(node)
        let outcome = await executeNode(
          def, node, state, outcomes, deps,
          onChunk && ((chunk: string) => onChunk(node.id, chunk)),
          onPermission && ((req: PermissionRequest) => onPermission(node.id, req)),
        )
        if (outcome.verdict && node.weight !== undefined) {
          outcome = { ...outcome, verdict: { ...outcome.verdict, weight: node.weight } }
        }
        onNode?.(outcome)
        return outcome
      }),
      Math.max(1, Math.floor(def.concurrency ?? 4)),
      shouldContinue,
    )
    for (const o of layerResults) {
      if (!o) continue // skipped by shouldContinue - no outcome exists
      outcomes.set(o.nodeId, o)
      ordered.push(o)
    }
  }
  return ordered
}
