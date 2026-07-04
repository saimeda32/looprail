import { createHash } from 'node:crypto'
import type {
  FinalReport, GateHandler, JournalEvent, LoopDef, NodeDef, NodeOutcome, RunReport,
} from '../core/types.js'
import { expandPanels, validateGraph } from '../core/graph.js'
import type { RunState } from '../core/context.js'
import { RailsGuard } from '../core/rails.js'
import { routeIteration } from '../core/router.js'
import { verdictFingerprint } from '../core/fingerprint.js'
import { buildFallbackReport, buildReportPrompt, parseReport, pickReportingAgentKey } from '../core/report.js'
import { JournalWriter } from '../journal/journal.js'
import type { AdapterRegistry } from '../adapters/registry.js'
import { runIteration } from './scheduler.js'
import type { EngineDeps } from './nodes.js'

export interface RunOptions {
  registry: AdapterRegistry
  gate?: GateHandler
  cwd?: string
  runDir?: string
  runId?: string
  now?: () => number
  cache?: Map<string, NodeOutcome>
  sleep?: (ms: number) => Promise<void>
  retries?: number
  onEvent?: (event: JournalEvent) => void  // live observer (CLI progress); mirrors the journal
}

export function contextHash(nodeId: string, prompt: string): string {
  return createHash('sha256').update(`${nodeId}\0${prompt}`).digest('hex')
}

function splitRegions(nodes: NodeDef[]): { planning: NodeDef[]; execution: NodeDef[] } {
  const plannerIds = new Set(nodes.filter((n) => n.role === 'planner').map((n) => n.id))
  const planningMembers = nodes.filter(
    (n) => n.role === 'planner' || (n.role === 'critic' && n.of !== undefined && plannerIds.has(n.of)),
  )
  const planningIds = new Set(planningMembers.map((n) => n.id))
  // strip out-of-region deps symmetrically: a planner pointing at an execution
  // node must not carry an unsatisfiable edge into topoLayers (cycle crash)
  const planning = planningMembers
    .map((n) => ({ ...n, after: n.after?.filter((d) => planningIds.has(d)) }))
  const execution = nodes
    .filter((n) => !planningIds.has(n.id))
    .map((n) => ({ ...n, after: n.after?.filter((d) => !planningIds.has(d)) }))
  return { planning, execution }
}

export async function runLoop(def: LoopDef, opts: RunOptions): Promise<RunReport> {
  // validate BEFORE expansion: panel-count and of-targets-panel errors must
  // surface with their real messages, not vanish or dangle post-expansion
  const preErrors = validateGraph(def)
  if (preErrors.length > 0) throw new Error(`invalid loop:\n${preErrors.join('\n')}`)
  const expanded = expandPanels(def)
  const errors = validateGraph(expanded)
  if (errors.length > 0) throw new Error(`invalid loop:\n${errors.join('\n')}`)

  const runId = opts.runId ?? `run-${Date.now().toString(36)}`
  const journal = opts.runDir ? new JournalWriter(opts.runDir, opts.now) : null
  const emit = (type: JournalEvent['type'], data: Record<string, unknown>): void => {
    journal?.write(type, data)
    opts.onEvent?.({ ts: (opts.now ?? Date.now)(), type, data })
  }
  emit('run_start', { runId, name: def.name, goal: def.goal })

  const guard = new RailsGuard(def.rails, opts.now)
  const deps: EngineDeps = {
    registry: opts.registry, gate: opts.gate, cwd: opts.cwd,
    cache: opts.cache, hash: contextHash,
    sleep: opts.sleep, retries: opts.retries,
    // With a wall rail, an in-flight node inherits (at most) the remaining wall
    // budget as its timeout, so a hung node can't run past the wall deadline.
    // An explicit, shorter node.timeoutMs is never loosened; no wall rail leaves
    // the timeout untouched (undefined stays undefined).
    effectiveTimeout: (nodeTimeoutMs?: number) => {
      const remaining = guard.remainingWallMs()
      if (remaining === undefined) return nodeTimeoutMs
      const budget = Math.max(1, remaining)
      return nodeTimeoutMs === undefined ? budget : Math.min(nodeTimeoutMs, budget)
    },
  }
  const onNode = (o: NodeOutcome) => {
    guard.addCost(o.costUsd)
    emit('node_end', {
      nodeId: o.nodeId, role: o.role, verdict: o.verdict, iteration: state.iteration,
      costUsd: o.costUsd, tokens: o.tokens, durationMs: o.durationMs,
      output: o.output, contextHash: o.contextHash,
    })
  }
  const onNodeStart = (n: NodeDef) => {
    emit('node_start', { nodeId: n.id, role: n.role, iteration: state.iteration })
  }
  const onChunk = (nodeId: string, chunk: string): void => {
    const node = expanded.nodes.find((n) => n.id === nodeId)
    emit('node_progress', { nodeId, role: node?.role, iteration: state.iteration, chunk })
  }
  // pre-start rail enforcement: halt BEFORE starting a node that would breach
  const shouldContinue = () => guard.check(state.iteration) === null

  const { planning, execution } = splitRegions(expanded.nodes)
  const state: RunState = { plan: null, iteration: 0, feedback: null }
  let outcomes: NodeOutcome[] = []
  let replans = 0
  const fingerprints: string[] = []

  // Every run gets a report, agent-narrated when one is available and its
  // reply parses, mechanically derived from the verdicts already in hand
  // otherwise - a missing agent, a thrown adapter call (rate limit, missing
  // permissions), or an unparseable reply all degrade to the same fallback
  // rather than ever failing the run over an informational extra. A cost
  // rail breach specifically skips the agent call outright: the whole point
  // of max_cost_usd is a hard dollar ceiling, and spending more on a report
  // right after hitting it would defeat that, no matter how cheap the call
  // itself might be.
  const buildFinalReport = async (status: RunReport['status'], reason: string): Promise<FinalReport> => {
    const isCostBreach = status === 'halted' && /rail breached \(cost\)/.test(reason)
    const agentKey = isCostBreach ? undefined : pickReportingAgentKey(def, outcomes)
    const agentSpec = agentKey ? def.agents[agentKey] : undefined
    if (!agentSpec) return buildFallbackReport(outcomes, status, reason)
    try {
      const adapter = opts.registry.get(agentSpec.adapter)
      const prompt = buildReportPrompt(def.goal, status, reason, outcomes)
      const result = await adapter.invoke({ prompt, model: agentSpec.model, command: agentSpec.command })
      return parseReport(result.output) ?? buildFallbackReport(outcomes, status, reason)
    } catch {
      return buildFallbackReport(outcomes, status, reason)
    }
  }

  const finish = async (status: RunReport['status'], reason: string): Promise<RunReport> => {
    const report = await buildFinalReport(status, reason)
    emit(status === 'verified' ? 'verified' : 'halt', { reason, costUsd: guard.spentUsd, report })
    return {
      runId, status, reason,
      iterations: state.iteration, replans,
      costUsd: guard.spentUsd, outcomes, report,
    }
  }

  const runPlanning = async (): Promise<void> => {
    if (planning.length === 0) return
    const maxRounds = Math.max(1, ...planning.map((n) => n.rounds ?? 1))
    for (let round = 1; round <= maxRounds; round++) {
      const outs = await runIteration(expanded, planning, state, deps, onNode, shouldContinue, onNodeStart, onChunk)
      const planner = outs.find((o) => o.role === 'planner')
      if (planner) state.plan = planner.output
      if (guard.check(state.iteration)) return // breached mid-planning; loop halts on entry
      const critiques = outs.filter((o) => o.verdict && o.verdict.status !== 'pass')
      if (critiques.length === 0) return
      state.feedback = critiques.map((o) => `[${o.nodeId}] ${o.verdict!.evidence}`).join('\n')
    }
  }

  await runPlanning()
  state.feedback = null

  while (true) {
    state.iteration += 1
    const breachBefore = guard.check(state.iteration)
    if (breachBefore) return await finish('halted', `rail breached (${breachBefore.rail}): ${breachBefore.detail}`)

    outcomes = await runIteration(expanded, execution, state, deps, onNode, shouldContinue, onNodeStart, onChunk)
    const verdicts = outcomes.flatMap((o) => (o.verdict ? [o.verdict] : []))
    fingerprints.push(verdictFingerprint(verdicts))
    emit('iteration_end', { iteration: state.iteration, costUsd: guard.spentUsd })

    const breach = guard.check(state.iteration)
    // a rail can preempt the pool between layers (scheduler.ts pre-node check),
    // leaving execution-region nodes - including configured verifiers - that
    // never ran. Their outcomes simply don't exist, so aggregating only the
    // outcomes present can misreport a partial verdict set as "all passed".
    const skipped = outcomes.length < execution.length
      ? execution.filter((n) => !outcomes.some((o) => o.nodeId === n.id))
      : []
    for (const n of skipped) {
      emit('node_skipped', { nodeId: n.id, role: n.role, iteration: state.iteration })
    }

    const decision = routeIteration({
      outcomes, policy: def.verdictPolicy, fingerprints,
      rails: def.rails, replansUsed: replans, breach,
    })

    if (decision.action === 'verified' && skipped.length > 0) {
      const breachDetail = breach ? `rail breached (${breach.rail}): ${breach.detail}` : 'rail breached'
      return await finish(
        'halted',
        `${breachDetail} - ${skipped.length} node(s) skipped before verification completed`,
      )
    }
    if (decision.action === 'verified') return await finish('verified', 'all verifiers passed')
    if (decision.action === 'halt') return await finish('halted', decision.reason)
    state.feedback = decision.feedback
    if (decision.action === 'replan') {
      replans += 1
      fingerprints.length = 0
      emit('replan', { replans, feedback: decision.feedback })
      await runPlanning()
    }
  }
}
