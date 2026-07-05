import type { FinalReport, JournalEvent, LoopDef, Role, Verdict } from '../core/types.js'

export type NodeStatus =
  | 'pending' | 'running' | 'pass' | 'fail' | 'stall' | 'error' | 'done' | 'skipped' | 'interrupted'

export interface NodeIterationRecord {
  iteration: number
  status: NodeStatus
  evidence?: string
  costUsd?: number
  estimatedCostUsd?: number
  tokens?: number
  durationMs?: number
  output?: string
}

export interface StreamChunk {
  text: string
  ts: number
}

export interface DashboardNode {
  id: string
  role: Role
  status: NodeStatus
  costUsd: number
  // Pricing-derived estimate, accumulated separately from costUsd (real,
  // adapter-reported spend). See core/rails.ts and core/types.ts
  // NodeOutcome.estimatedCostUsd for why the two must never merge.
  estimatedCostUsd: number
  tokens: number
  iterations: NodeIterationRecord[]
  agent?: string
  model?: string
  adapter?: string
  streamingOutput?: string
  // Same content as streamingOutput, kept as discrete arrived-at-ts pieces -
  // the live-output panel uses this to show real per-paragraph arrival
  // times and fade older text, neither of which a flat concatenated string
  // can answer once chunks are joined together.
  streamingChunks?: StreamChunk[]
  // Set while this node's own subprocess is blocked mid-execution on a
  // real agent-CLI tool-permission prompt (see adapters/cli-adapter.ts's
  // PermissionDetector and engine/runner.ts's onPermission), cleared the
  // moment a matching permission_resolved event lands. Deliberately NOT the
  // same shape/field as a `role: gate` node's pendingGate (see
  // dashboard/permission-registry.ts's header comment for why the two are
  // not interchangeable): this is per-node, rendered in the live-output
  // panel next to that node's own streamed output, not a run-wide gate row.
  pendingPermission?: { question: string }
}

export interface PlanVersion {
  replan: number
  iteration: number
  nodeId: string
  output: string
}

export interface DashboardTotals {
  costUsd: number
  estimatedCostUsd: number
  maxCostUsd?: number
  iteration: number
  maxIterations?: number
  maxWallMinutes?: number
  replanLimit?: number
  // Timestamps (journal-event ts, not wall-clock at build time - this stays
  // a pure function of its inputs) marking the current wall-time window: a
  // resumed run's rails.ts RailsGuard is a fresh instance per process
  // invocation, so wall-time breaches (and this gauge) reset at the most
  // recent run_start, not the run's original start.
  startedTs?: number
  lastEventTs?: number
  replans: number
  tokens: number
  // Total real node invocations across the whole run - distinct from
  // iteration (which only counts execution-region passes). A planner with
  // rounds > 1, or several replans, can rack up many calls while iteration
  // stays low - this is the number that answers "how much has actually
  // been tried", not "how many execution-region passes have completed".
  calls: number
}

export interface DashboardModel {
  runId: string
  name: string
  goal: string
  status: 'running' | 'verified' | 'halted' | 'canceled'
  reason?: string
  report?: FinalReport
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
  nodes: Map<string, DashboardNode>, id: string, role: Role, agent?: string, model?: string, adapter?: string,
): DashboardNode {
  let n = nodes.get(id)
  if (!n) {
    n = { id, role, status: 'pending', costUsd: 0, estimatedCostUsd: 0, tokens: 0, iterations: [], agent, model, adapter }
    nodes.set(id, n)
  } else {
    // A LoopDef (persisted or freshly-read) pre-populates every node up
    // front, but for a run with no loadable def at all (e.g. a pre-existing
    // run whose workspace is gone AND predates the persisted-copy fix - see
    // journal/loopfile-persist.ts), node_start/node_end are the only source
    // of this info - backfill from whichever event reaches it first,
    // without ever clobbering a value already known.
    if (n.agent === undefined && agent !== undefined) n.agent = agent
    if (n.model === undefined && model !== undefined) n.model = model
    if (n.adapter === undefined && adapter !== undefined) n.adapter = adapter
  }
  return n
}

export function buildViewModel(events: JournalEvent[], def?: LoopDef): DashboardModel {
  const nodes = new Map<string, DashboardNode>()
  if (def) {
    for (const n of def.nodes) {
      const agentDef = n.agent ? def.agents[n.agent] : undefined
      ensureNode(nodes, n.id, n.role, n.agent, agentDef?.model, agentDef?.adapter)
    }
  }

  let runId = 'unknown'
  let name = ''
  let goal = ''
  let status: DashboardModel['status'] = 'running'
  let reason: string | undefined
  let report: FinalReport | undefined
  let costUsd = 0
  let estimatedCostUsd = 0
  let tokens = 0
  let iteration = 0
  let replans = 0
  // Every node_end is one real, completed invocation - a round inside
  // runPlanning(), a format-correction retry, a replan attempt, or a plain
  // execution-region pass. Iteration only counts execution-region passes
  // (see runner.ts) and can under-report real work by a wide margin: a
  // planner with rounds > 1 or several replans can rack up many calls
  // while iteration stays at 1 or 2, which reads as "barely anything has
  // happened" when a lot actually has.
  let calls = 0
  let startedTs: number | undefined
  let lastEventTs: number | undefined
  const plans: PlanVersion[] = []

  for (const e of events) {
    const d = e.data as Record<string, unknown>
    lastEventTs = e.ts
    switch (e.type) {
      case 'run_start':
        runId = String(d.runId)
        name = String(d.name)
        goal = String(d.goal)
        // A resumed run (looprail resume) appends a fresh run_start to the
        // SAME journal after an earlier halt/verified event. Reset status
        // (and the reason/report that came with it) back to the same
        // defaults a run's very first run_start starts from, so the model
        // reflects "running again" instead of the stale terminal state
        // until whatever verified/halt event eventually concludes it.
        status = 'running'
        reason = undefined
        report = undefined
        // Overwritten on every run_start (not just the first) to match
        // RailsGuard's own per-process-invocation wall-time window - a
        // resume's elapsed-time gauge should reflect time since THIS
        // resume, the same window its own max_wall_minutes rail is
        // actually checked against.
        startedTs = e.ts
        break
      case 'node_start': {
        const n = ensureNode(
          nodes, String(d.nodeId), d.role as Role,
          d.agent as string | undefined, d.model as string | undefined, d.adapter as string | undefined,
        )
        n.status = 'running'
        n.streamingOutput = ''
        n.streamingChunks = []
        // A fresh start of the same node id must not carry a stale pending
        // prompt from an earlier run of it forward - same rationale as
        // resetting streamingOutput/streamingChunks just above.
        n.pendingPermission = undefined
        break
      }
      case 'node_progress': {
        const n = ensureNode(nodes, String(d.nodeId), d.role as Role)
        const chunk = String(d.chunk ?? '')
        n.streamingOutput = (n.streamingOutput ?? '') + chunk
        n.streamingChunks = [...(n.streamingChunks ?? []), { text: chunk, ts: e.ts }]
        break
      }
      case 'node_end': {
        const nodeId = String(d.nodeId)
        const n = ensureNode(
          nodes, nodeId, d.role as Role,
          d.agent as string | undefined, d.model as string | undefined, d.adapter as string | undefined,
        )
        const verdict = d.verdict as Verdict | null
        const iter = Number(d.iteration ?? 0)
        const cost = Number(d.costUsd ?? 0)
        const nodeEstimatedCost = d.estimatedCostUsd === undefined ? undefined : Number(d.estimatedCostUsd)
        const nodeTokens = Number(d.tokens ?? 0)
        const nodeStatus: NodeStatus = verdict ? verdict.status : 'done'
        n.status = nodeStatus
        n.costUsd += cost
        n.estimatedCostUsd += nodeEstimatedCost ?? 0
        n.tokens += nodeTokens
        n.iterations.push({
          iteration: iter,
          status: nodeStatus,
          evidence: verdict?.evidence,
          costUsd: cost,
          estimatedCostUsd: nodeEstimatedCost,
          tokens: nodeTokens,
          durationMs: d.durationMs === undefined ? undefined : Number(d.durationMs),
          output: d.output === undefined ? undefined : String(d.output),
        })
        if (d.role === 'planner') plans.push({ replan: replans, iteration: iter, nodeId, output: String(d.output ?? '') })
        iteration = Math.max(iteration, iter)
        calls += 1
        tokens += nodeTokens
        costUsd += cost
        estimatedCostUsd += nodeEstimatedCost ?? 0
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
        // costUsd is already live (summed per node_end above); reconcile against the rails
        // guard's authoritative running spend in case it saw cost the node-level sum can't
        // (e.g. retry cost not attached to any single node_end). Never let the total regress.
        costUsd = Math.max(costUsd, Number(d.costUsd ?? costUsd))
        estimatedCostUsd = Math.max(estimatedCostUsd, Number(d.estimatedCostUsd ?? estimatedCostUsd))
        break
      case 'permission_request': {
        const n = ensureNode(nodes, String(d.nodeId), d.role as Role)
        n.pendingPermission = { question: String(d.question ?? '') }
        break
      }
      case 'permission_resolved': {
        const n = ensureNode(nodes, String(d.nodeId), d.role as Role)
        n.pendingPermission = undefined
        break
      }
      case 'replan':
        replans += 1
        break
      case 'verified':
      case 'halt':
        // A user-initiated cancellation (run-cmd.ts's installCancelHandler,
        // the dashboard's own Cancel control) is a deliberate stop, not a
        // failure the way a rail breach is - conflating the two under one
        // "halted" status misreports "I chose to stop this" as "this broke".
        status = e.type === 'verified' ? 'verified'
          : d.reason === 'canceled by user request' ? 'canceled' : 'halted'
        reason = String(d.reason)
        report = d.report as FinalReport | undefined
        costUsd = Math.max(costUsd, Number(d.costUsd ?? costUsd))
        estimatedCostUsd = Math.max(estimatedCostUsd, Number(d.estimatedCostUsd ?? estimatedCostUsd))
        // A node that started but never got its own node_end (a rail
        // breach or a user cancel while it was still in flight - the whole
        // point of the cancel control) would otherwise show "running"
        // forever: nothing else ever demotes it once the run itself is
        // over, which is exactly what left the dashboard showing a live,
        // flowing edge and "waiting for output" on an already-halted run.
        for (const n of nodes.values()) {
          if (n.status === 'running') n.status = 'interrupted'
        }
        break
      default:
        break
    }
  }

  return {
    runId, name, goal, status, reason, report,
    nodes: [...nodes.values()],
    edges: def ? edgesFromDef(def) : [],
    totals: {
      costUsd, estimatedCostUsd, iteration, replans, tokens, calls,
      startedTs, lastEventTs,
      maxCostUsd: def?.rails.maxCostUsd,
      maxIterations: def?.rails.maxIterations,
      maxWallMinutes: def?.rails.maxWallMinutes,
      replanLimit: def?.rails.replanLimit,
    },
    plans,
  }
}
