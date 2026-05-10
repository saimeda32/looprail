import { createHash } from 'node:crypto'
import type {
  GateHandler, LoopDef, NodeDef, NodeOutcome, RunReport,
} from '../core/types.js'
import { expandPanels, validateGraph } from '../core/graph.js'
import type { RunState } from '../core/context.js'
import { RailsGuard } from '../core/rails.js'
import { routeIteration } from '../core/router.js'
import { verdictFingerprint } from '../core/fingerprint.js'
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
  journal?.write('run_start', { runId, name: def.name, goal: def.goal })

  const guard = new RailsGuard(def.rails, opts.now)
  const deps: EngineDeps = {
    registry: opts.registry, gate: opts.gate, cwd: opts.cwd,
    cache: opts.cache, hash: contextHash,
  }
  const onNode = (o: NodeOutcome) => {
    guard.addCost(o.costUsd)
    journal?.write('node_end', {
      nodeId: o.nodeId, role: o.role, verdict: o.verdict, iteration: state.iteration,
      costUsd: o.costUsd, tokens: o.tokens, durationMs: o.durationMs,
      output: o.output, contextHash: o.contextHash,
    })
  }
  const onNodeStart = (n: NodeDef) => {
    journal?.write('node_start', { nodeId: n.id, role: n.role, iteration: state.iteration })
  }
  // pre-start rail enforcement: halt BEFORE starting a node that would breach
  const shouldContinue = () => guard.check(state.iteration) === null

  const { planning, execution } = splitRegions(expanded.nodes)
  const state: RunState = { plan: null, iteration: 0, feedback: null }
  let outcomes: NodeOutcome[] = []
  let replans = 0
  const fingerprints: string[] = []

  const finish = (status: RunReport['status'], reason: string): RunReport => {
    journal?.write(status === 'verified' ? 'verified' : 'halt', { reason, costUsd: guard.spentUsd })
    return {
      runId, status, reason,
      iterations: state.iteration, replans,
      costUsd: guard.spentUsd, outcomes,
    }
  }

  const runPlanning = async (): Promise<void> => {
    if (planning.length === 0) return
    const maxRounds = Math.max(1, ...planning.map((n) => n.rounds ?? 1))
    for (let round = 1; round <= maxRounds; round++) {
      const outs = await runIteration(expanded, planning, state, deps, onNode, shouldContinue, onNodeStart)
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
    if (breachBefore) return finish('halted', `rail breached (${breachBefore.rail}): ${breachBefore.detail}`)

    outcomes = await runIteration(expanded, execution, state, deps, onNode, shouldContinue, onNodeStart)
    const verdicts = outcomes.flatMap((o) => (o.verdict ? [o.verdict] : []))
    fingerprints.push(verdictFingerprint(verdicts))
    journal?.write('iteration_end', { iteration: state.iteration, costUsd: guard.spentUsd })

    const decision = routeIteration({
      outcomes, policy: def.verdictPolicy, fingerprints,
      rails: def.rails, replansUsed: replans, breach: guard.check(state.iteration),
    })

    if (decision.action === 'verified') return finish('verified', 'all verifiers passed')
    if (decision.action === 'halt') return finish('halted', decision.reason)
    state.feedback = decision.feedback
    if (decision.action === 'replan') {
      replans += 1
      fingerprints.length = 0
      journal?.write('replan', { replans, feedback: decision.feedback })
      await runPlanning()
    }
  }
}
