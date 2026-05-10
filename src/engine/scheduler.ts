import type { LoopDef, NodeDef, NodeOutcome } from '../core/types.js'
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
      // breached — in-flight nodes finish, unstarted ones are skipped
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
): Promise<NodeOutcome[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const outcomes = new Map<string, NodeOutcome>()
  const ordered: NodeOutcome[] = []

  for (const layer of topoLayers(nodes)) {
    const layerResults = await pool(
      layer.map((id) => async () => {
        const node = byId.get(id)!
        onNodeStart?.(node)
        const outcome = await executeNode(def, node, state, outcomes, deps)
        onNode?.(outcome)
        return outcome
      }),
      Math.max(1, Math.floor(def.concurrency ?? 4)),
      shouldContinue,
    )
    for (const o of layerResults) {
      if (!o) continue // skipped by shouldContinue — no outcome exists
      outcomes.set(o.nodeId, o)
      ordered.push(o)
    }
  }
  return ordered
}
