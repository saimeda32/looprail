import type { JournalEvent, LoopDef } from '../core/types.js'
import { buildViewModel, type DashboardModel } from './view-model.js'

export interface LayoutNode { id: string; layer: number; x: number; y: number }

const COL_WIDTH = 200
const ROW_HEIGHT = 90
const MARGIN = 60

export function computeLayout(nodeIds: string[], edges: [string, string, ('after' | 'of')?][]): LayoutNode[] {
  const known = new Set(nodeIds)
  const relevant = edges.filter(([from, to]) => known.has(from) && known.has(to))
  const layer = new Map<string, number>(nodeIds.map((id) => [id, 0]))
  const indegree = new Map<string, number>(nodeIds.map((id) => [id, 0]))
  const adj = new Map<string, string[]>(nodeIds.map((id) => [id, []]))
  for (const [from, to] of relevant) {
    adj.get(from)!.push(to)
    indegree.set(to, (indegree.get(to) ?? 0) + 1)
  }
  const queue = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0)
  const remaining = new Map(indegree)
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const next of adj.get(id) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, (layer.get(id) ?? 0) + 1))
      const left = (remaining.get(next) ?? 0) - 1
      remaining.set(next, left)
      if (left === 0) queue.push(next)
    }
  }

  const byLayer = new Map<number, string[]>()
  for (const id of nodeIds) {
    const l = layer.get(id) ?? 0
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(id)
  }

  const out: LayoutNode[] = []
  for (const [l, ids] of byLayer) {
    ids.forEach((id, i) => {
      out.push({ id, layer: l, x: MARGIN + l * COL_WIDTH, y: MARGIN + i * ROW_HEIGHT })
    })
  }
  // stable order: as encountered in nodeIds, not Map iteration order
  const order = new Map(nodeIds.map((id, i) => [id, i]))
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

export type DashboardPayload = DashboardModel & { layout: LayoutNode[] }

export function buildDashboardPayload(events: JournalEvent[], def?: LoopDef): DashboardPayload {
  const model = buildViewModel(events, def)
  const layout = computeLayout(model.nodes.map((n) => n.id), model.edges)
  return { ...model, layout }
}
