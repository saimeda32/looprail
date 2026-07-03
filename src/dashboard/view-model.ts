import type { JournalEvent, LoopDef, Role, Verdict } from '../core/types.js'

export type NodeStatus = 'pending' | 'running' | 'pass' | 'fail' | 'stall' | 'error' | 'done' | 'skipped'

export interface NodeIterationRecord {
  iteration: number
  status: NodeStatus
  evidence?: string
  costUsd?: number
  tokens?: number
  durationMs?: number
  output?: string
}

export interface DashboardNode {
  id: string
  role: Role
  status: NodeStatus
  costUsd: number
  tokens: number
  iterations: NodeIterationRecord[]
  agent?: string
  model?: string
  streamingOutput?: string
}

export interface PlanVersion {
  replan: number
  iteration: number
  nodeId: string
  output: string
}

export interface DashboardTotals {
  costUsd: number
  maxCostUsd?: number
  iteration: number
  maxIterations?: number
  replans: number
  tokens: number
}

export interface DashboardModel {
  runId: string
  name: string
  goal: string
  status: 'running' | 'verified' | 'halted'
  reason?: string
  nodes: DashboardNode[]
  edges: [string, string][]
  totals: DashboardTotals
  plans: PlanVersion[]
}

function edgesFromDef(def: LoopDef): [string, string][] {
  const ids = new Set(def.nodes.map((n) => n.id))
  const seen = new Set<string>()
  const edges: [string, string][] = []
  const add = (from: string, to: string) => {
    const key = `${from}\0${to}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push([from, to])
  }
  for (const n of def.nodes) {
    for (const dep of n.after ?? []) if (ids.has(dep)) add(dep, n.id)
    if (n.of && ids.has(n.of)) add(n.of, n.id)
  }
  return edges
}

function ensureNode(
  nodes: Map<string, DashboardNode>, id: string, role: Role, agent?: string, model?: string,
): DashboardNode {
  let n = nodes.get(id)
  if (!n) {
    n = { id, role, status: 'pending', costUsd: 0, tokens: 0, iterations: [], agent, model }
    nodes.set(id, n)
  }
  return n
}

export function buildViewModel(events: JournalEvent[], def?: LoopDef): DashboardModel {
  const nodes = new Map<string, DashboardNode>()
  if (def) {
    for (const n of def.nodes) {
      ensureNode(nodes, n.id, n.role, n.agent, n.agent ? def.agents[n.agent]?.model : undefined)
    }
  }

  let runId = 'unknown'
  let name = ''
  let goal = ''
  let status: DashboardModel['status'] = 'running'
  let reason: string | undefined
  let costUsd = 0
  let tokens = 0
  let iteration = 0
  let replans = 0
  const plans: PlanVersion[] = []

  for (const e of events) {
    const d = e.data as Record<string, unknown>
    switch (e.type) {
      case 'run_start':
        runId = String(d.runId)
        name = String(d.name)
        goal = String(d.goal)
        break
      case 'node_start': {
        const n = ensureNode(nodes, String(d.nodeId), d.role as Role)
        n.status = 'running'
        n.streamingOutput = ''
        break
      }
      case 'node_progress': {
        const n = ensureNode(nodes, String(d.nodeId), d.role as Role)
        n.streamingOutput = (n.streamingOutput ?? '') + String(d.chunk ?? '')
        break
      }
      case 'node_end': {
        const nodeId = String(d.nodeId)
        const n = ensureNode(nodes, nodeId, d.role as Role)
        const verdict = d.verdict as Verdict | null
        const iter = Number(d.iteration ?? 0)
        const cost = Number(d.costUsd ?? 0)
        const nodeTokens = Number(d.tokens ?? 0)
        const nodeStatus: NodeStatus = verdict ? verdict.status : 'done'
        n.status = nodeStatus
        n.costUsd += cost
        n.tokens += nodeTokens
        n.iterations.push({
          iteration: iter,
          status: nodeStatus,
          evidence: verdict?.evidence,
          costUsd: cost,
          tokens: nodeTokens,
          durationMs: d.durationMs === undefined ? undefined : Number(d.durationMs),
          output: d.output === undefined ? undefined : String(d.output),
        })
        if (d.role === 'planner') plans.push({ replan: replans, iteration: iter, nodeId, output: String(d.output ?? '') })
        iteration = Math.max(iteration, iter)
        tokens += nodeTokens
        break
      }
      case 'node_skipped': {
        const n = ensureNode(nodes, String(d.nodeId), d.role as Role)
        const iter = Number(d.iteration ?? 0)
        n.status = 'skipped'
        n.iterations.push({ iteration: iter, status: 'skipped' })
        iteration = Math.max(iteration, iter)
        break
      }
      case 'iteration_end':
        iteration = Math.max(iteration, Number(d.iteration ?? 0))
        costUsd = Number(d.costUsd ?? costUsd)
        break
      case 'replan':
        replans += 1
        break
      case 'verified':
      case 'halt':
        status = e.type === 'verified' ? 'verified' : 'halted'
        reason = String(d.reason)
        costUsd = Number(d.costUsd ?? costUsd)
        break
      default:
        break
    }
  }

  return {
    runId, name, goal, status, reason,
    nodes: [...nodes.values()],
    edges: def ? edgesFromDef(def) : [],
    totals: {
      costUsd, iteration, replans, tokens,
      maxCostUsd: def?.rails.maxCostUsd,
      maxIterations: def?.rails.maxIterations,
    },
    plans,
  }
}
