import type { LoopDef, NodeDef, NodeOutcome } from '../core/types.js'
import { topoLayers } from '../core/graph.js'
import type { RunState } from '../core/context.js'
import { executeNode, type EngineDeps } from './nodes.js'

async function pool<T>(items: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
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
): Promise<NodeOutcome[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const outcomes = new Map<string, NodeOutcome>()
  const ordered: NodeOutcome[] = []

  for (const layer of topoLayers(nodes)) {
    const layerResults = await pool(
      layer.map((id) => async () => {
        const outcome = await executeNode(def, byId.get(id)!, state, outcomes, deps)
        onNode?.(outcome)
        return outcome
      }),
      def.concurrency ?? 4,
    )
    for (const o of layerResults) {
      outcomes.set(o.nodeId, o)
      ordered.push(o)
    }
  }
  return ordered
}
