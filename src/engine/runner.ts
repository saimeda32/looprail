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
import { filesTouched } from '../core/git.js'
import { JournalWriter } from '../journal/journal.js'
import { drainHumanFeedback } from '../journal/human-feedback.js'
import type { AdapterRegistry } from '../adapters/registry.js'
import { runIteration } from './scheduler.js'
import type { EngineDeps } from './nodes.js'
import {
  applyGraphEdits, parseGraphEditsFragment, parseGraphFragment, serializeGraphFragment,
  type GraphFragment,
} from '../config/loopfile.js'
import { spliceFragment } from './splice.js'
import { persistRunLoopDef } from '../journal/loopfile-persist.js'

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
  // Set when this invocation continues a run that already executed some
  // iterations in an earlier process (dashboard "resume in place" and the
  // `resume` CLI command both reuse the source run's own runId/runDir and
  // append to its existing journal, rather than starting a fresh one -
  // see cli/resume-cmd.ts). Without this, a resumed run's in-memory
  // iteration counter would restart at 1, making its rails check
  // (max_iterations) meaningless against a budget bumped to cover work
  // already done in the earlier process.
  startIteration?: number
  // Reconstructed from the source run's own journal (journal/runs.ts's
  // reconstructRunState) - the plan the planner already produced and the
  // critic's evidence for why the run halted, both of which belong in the
  // resumed iteration's prompt. Set together with startIteration and
  // skipPlanning by resume-cmd.ts; a fresh `run` never sets these.
  initialPlan?: string | null
  initialFeedback?: string | null
  // A resumed run continues execution iterations - re-running the planning
  // phase from scratch would discard the plan already reconstructed above
  // and restart the planner-critic revision dance pointlessly.
  skipPlanning?: boolean
}

// A gate whose dependency chain leads back to a generates:'graph' planner is
// a plan-approval gate, not an ordinary one - its approval splices a
// fragment in, and its non-empty-feedback rejection forces an immediate
// replan rather than the generic iterate/stall path. Ordinary gates (no such
// ancestor) are completely unaffected. Extracted as a standalone exported
// function (rather than kept as a runLoop-local closure) so callers outside
// the engine - e.g. cli/run-cmd.ts's makeUiGate, which must classify a gate
// as plan-approval or not BEFORE runLoop itself ever sees the gate call, in
// order to tell the dashboard how to render it - can run the exact same
// detection runLoop uses internally, instead of re-deriving a second,
// possibly-diverging version of this logic.
//
// `nodes` must be the full, panel-expanded node list (LoopDef.nodes after
// expandPanels), since a gate's `after` edge to its planner ancestor is only
// resolvable against that full list - splitRegions' execution/planning
// split strips the very edge this lookup needs.
export function findPlanGenerator(nodes: NodeDef[], gateNode: NodeDef): NodeDef | undefined {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const original = byId.get(gateNode.id) ?? gateNode
  for (const depId of original.after ?? []) {
    const dep = byId.get(depId)
    if (!dep) continue
    if (dep.role === 'planner' && dep.generates === 'graph') return dep
    if (dep.role === 'critic' && dep.of) {
      const target = byId.get(dep.of)
      if (target?.role === 'planner' && target.generates === 'graph') return target
    }
  }
  return undefined
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
    guard.addCost(o.costUsd, o.estimatedCostUsd)
    emit('node_end', {
      nodeId: o.nodeId, role: o.role, verdict: o.verdict, iteration: state.iteration,
      costUsd: o.costUsd, estimatedCostUsd: o.estimatedCostUsd, tokens: o.tokens, durationMs: o.durationMs,
      output: o.output, contextHash: o.contextHash,
      agent: o.agent, adapter: o.adapter, model: o.model,
    })
  }
  const onNodeStart = (n: NodeDef) => {
    // `runAgents` (rather than expanded.agents) so a spliced-in node whose
    // `agent:` key only exists because a fragment declared it still
    // resolves an adapter/model here - see applySplice below.
    const agentDef = n.agent ? runAgents[n.agent] : undefined
    emit('node_start', {
      nodeId: n.id, role: n.role, iteration: state.iteration,
      agent: n.agent, adapter: agentDef?.adapter, model: agentDef?.model,
    })
  }
  const onChunk = (nodeId: string, chunk: string): void => {
    const node = expanded.nodes.find((n) => n.id === nodeId)
    emit('node_progress', { nodeId, role: node?.role, iteration: state.iteration, chunk })
  }
  // pre-start rail enforcement: halt BEFORE starting a node that would breach
  const shouldContinue = () => guard.check(state.iteration) === null

  const { planning, execution: initialExecution } = splitRegions(expanded.nodes)
  // Extended live by applySplice below when a generates:'graph' planner's
  // fragment is approved at a gate - see docs/superpowers/specs/
  // 2026-07-04-self-planning-loop-design.md. Ordinary loops (no such
  // planner) never mutate either of these past their initial value.
  let execution = initialExecution
  let runAgents = expanded.agents
  const nodeIds = new Set(expanded.nodes.map((n) => n.id))
  // A resolved plan-approval gate is dropped from `execution` below (it must
  // never be asked again), but it still genuinely ran - real node_start/
  // node_end events for it exist in the journal, and the dashboard still
  // shows it as a historical node (see view-model.ts's ensureNode, which
  // populates nodes from journal events independent of the current def).
  // Without keeping it here too, the persisted loopfile's node list (and
  // therefore edgesFromDef) loses the gate entirely on the very first
  // splice, leaving it rendered with no edges at all - a real regression
  // confirmed live. Kept with its ORIGINAL `after` (before the
  // dangling-edge-stripping map below), since that original edge is
  // exactly what the dashboard needs to draw it connected.
  const resolvedGates: NodeDef[] = []
  const state: RunState = {
    plan: opts.initialPlan ?? null,
    iteration: opts.startIteration ?? 0,
    feedback: opts.initialFeedback ?? null,
    humanFeedback: null,
  }
  let outcomes: NodeOutcome[] = []
  let replans = 0
  const fingerprints: string[] = []
  // The last full graph fragment a generates:'graph' planner produced that
  // parsed AND passed structural validation - the base a later compact
  // `edits:` reply is applied against (see src/config/loopfile.ts's design
  // note on applyGraphEdits/parseGraphEditsFragment). Declared here, not
  // inside runPlanning, so it survives across separate runPlanning() calls
  // (a plan-approval rejection or an outer replan each call runPlanning()
  // again) - exactly the case where a planner is asked to fix one flagged
  // gap in its OWN prior graph and should be able to send a small edit
  // instead of re-emitting the whole thing.
  let lastGoodGraphFragment: GraphFragment | null = null

  // Looks the gate up against expanded.nodes (its original, pre-splitRegions
  // definition) rather than the current execution list: splitRegions strips
  // a gate's `after` edge into the planning region (the dependency this
  // very check needs to see), since that edge is meaningless to the
  // execution-region scheduler. See findPlanGenerator above.
  const planGeneratorFor = (gateNode: NodeDef): NodeDef | undefined => findPlanGenerator(expanded.nodes, gateNode)

  // Validates and merges an approved fragment into the live run. The
  // now-resolved gate is dropped from `execution` (its job is done - it
  // must never be asked again on a later iteration) and stripped from any
  // node's `after` that pointed at it, mirroring splitRegions' own
  // symmetric-dependency-filtering technique so no edge is left dangling.
  const applySplice = (fragmentText: string, gateNodeId: string): { ok: true } | { ok: false; reason: string } => {
    try {
      const fragment = parseGraphFragment(fragmentText)
      const spliced = spliceFragment(fragment, runAgents, nodeIds, gateNodeId)
      runAgents = spliced.agents
      guard.tighten(spliced.rails)
      for (const n of spliced.nodes) nodeIds.add(n.id)
      // From `expanded.nodes` (the pre-split original), not `execution`:
      // splitRegions already strips a gate's `after` into the planning
      // region before this function ever runs (it must, for the scheduler's
      // own sake), so by the time execution.find would run here the edge is
      // already gone - only the original, unsplit definition still has it.
      const resolvedGate = expanded.nodes.find((n) => n.id === gateNodeId)
      if (resolvedGate) resolvedGates.push(resolvedGate)
      execution = execution
        .filter((n) => n.id !== gateNodeId)
        .concat(spliced.nodes)
        .map((n) => ({ ...n, after: n.after?.filter((d) => d !== gateNodeId) }))
      // Re-persist the run's own loopfile copy with the now splice-extended
      // graph, so a LATER dashboard read (even after this workspace is
      // deleted) still shows the extended graph's edges and per-node
      // agent/model - not just the STATIC bootstrap graph written once at
      // run start (see cli/run-cmd.ts's runAction). `planning` is untouched
      // by a splice (fragments only ever extend the execution region), so
      // the persisted node list is simply planning's original nodes plus
      // execution's current (possibly spliced) ones. `expanded.rails` was
      // already tightened in place by guard.tighten above (RailsGuard holds
      // the very same object), so it reflects any fragment-declared rails
      // too.
      if (opts.runDir) {
        persistRunLoopDef(opts.runDir, {
          ...expanded, agents: runAgents, nodes: [...planning, ...resolvedGates, ...execution],
        })
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }

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
    // Computed here, once, regardless of which path below produces the rest
    // of the report - see core/git.ts for why this is real git state, never
    // something asked of the reporting agent.
    const touched = opts.cwd ? filesTouched(opts.cwd) : []
    const isCostBreach = status === 'halted' && /rail breached \(cost\)/.test(reason)
    const agentKey = isCostBreach ? undefined : pickReportingAgentKey(def, outcomes)
    const agentSpec = agentKey ? def.agents[agentKey] : undefined
    if (!agentSpec) return { ...buildFallbackReport(outcomes, status, reason), filesTouched: touched }
    try {
      const adapter = opts.registry.get(agentSpec.adapter)
      const prompt = buildReportPrompt(def.goal, status, reason, outcomes)
      const result = await adapter.invoke({ prompt, model: agentSpec.model, command: agentSpec.command })
      const parsed = parseReport(result.output) ?? buildFallbackReport(outcomes, status, reason)
      return { ...parsed, filesTouched: touched }
    } catch {
      return { ...buildFallbackReport(outcomes, status, reason), filesTouched: touched }
    }
  }

  const finish = async (status: RunReport['status'], reason: string): Promise<RunReport> => {
    const report = await buildFinalReport(status, reason)
    emit(status === 'verified' ? 'verified' : 'halt', {
      reason, costUsd: guard.spentUsd, estimatedCostUsd: guard.estimatedSpentUsd, report,
    })
    return {
      runId, status, reason,
      iterations: state.iteration, replans,
      costUsd: guard.spentUsd, estimatedCostUsd: guard.estimatedSpentUsd, outcomes, report,
    }
  }

  // Result of a full runPlanning() attempt. `ok: false` means every
  // available replan was spent and the planner STILL never produced
  // parseable output - a definitive failure, not a transient one, that
  // every call site must turn into a clean halt rather than letting known-
  // invalid content reach a critic or a human gate.
  type PlanningResult = { ok: true } | { ok: false; reason: string }

  const runPlanning = async (): Promise<PlanningResult> => {
    if (planning.length === 0) return { ok: true }
    const replanLimit = def.rails.replanLimit ?? Infinity
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const maxRounds = Math.max(1, ...planning.map((n) => n.rounds ?? 1))
      let formatError: string | null = null
      for (let round = 1; round <= maxRounds; round++) {
        const outs = await runIteration({ ...expanded, agents: runAgents }, planning, state, deps, onNode, shouldContinue, onNodeStart, onChunk)
        const planner = outs.find((o) => o.role === 'planner')
        if (planner) state.plan = planner.output
        if (guard.check(state.iteration)) return { ok: true } // breached mid-planning; loop halts on entry

        // A generates:'graph' planner's output must be both parseable AND
        // structurally valid before a human or critic ever sees it. Neither
        // question is a judgment call the way "is this graph a good idea"
        // is - they're purely mechanical - so both get the same automatic,
        // free self-correction round here (parseGraphFragment itself
        // already strips a stray fence/prose wrapper first; this only fires
        // for content that's still broken after that; validateGraph then
        // catches a fragment that parses fine but invents its own node
        // schema instead of the real one), using the real error as
        // feedback, instead of reaching a human as an undiagnosable "reject
        // this and try to explain what's wrong" cycle, or worse, silently
        // splicing broken structure through to fail at execution time.
        formatError = null
        const plannerNode = planner && expanded.nodes.find((n) => n.id === planner.nodeId)
        if (plannerNode?.generates === 'graph') {
          try {
            // A reply may be either a full `graph:` document or a compact
            // `edits:` block applied server-side to the last full fragment
            // this same planner already produced (see loopfile.ts's design
            // note above parseGraphEditsFragment/applyGraphEdits - the fix
            // for this task's actual motivating cost: a targeted content
            // fix no longer has to re-emit the whole ~20KB graph). An
            // absent `edits:` key means "not an edits reply at all" (falls
            // through to the existing full-graph parse, unchanged), and any
            // OTHER edits problem (malformed shape, unknown nodeId, an
            // invented non-NodeDef field, no prior fragment to apply
            // against yet) throws here exactly like a broken full-graph
            // reply would, landing in the same catch below.
            const editsFragment = parseGraphEditsFragment(state.plan ?? '')
            let fragment: GraphFragment
            if (editsFragment) {
              if (!lastGoodGraphFragment) {
                throw new Error('invalid edits: an "edits:" reply requires a previously-produced full graph to apply to, but none exists yet')
              }
              fragment = applyGraphEdits(lastGoodGraphFragment, editsFragment)
            } else {
              fragment = parseGraphFragment(state.plan ?? '')
            }
            // Parsing succeeding only proves `graph:` is a YAML map - it says
            // nothing about whether each node inside actually matches the
            // real NodeDef schema (role/agent/prompt/run/expect/after). A
            // planner can invent its own field names (e.g.
            // title/description/success_criteria) and every node silently
            // ends up with role/agent undefined, which parseGraphNodes never
            // catches at runtime (its `as NodeDef['role']` casts are
            // compile-time only). Reusing validateGraph here - the exact
            // check spliceFragment itself runs at splice time - catches
            // that same failure on this automatic, free round instead of
            // burning a real splice/execute cycle only to fail later with
            // "unknown agent \"undefined\"", after the critic/gate already
            // signed off on content whose structure was never checked at
            // all. Agents merge additively (a fragment can declare its own),
            // so they're merged with the live run's current set here too,
            // mirroring spliceFragment's own merge.
            const mergedAgents = { ...runAgents, ...fragment.agents }
            const fragmentIds = new Set(fragment.nodes.map((n) => n.id))
            const nodesForValidation = fragment.nodes.map((n) => ({
              ...n, after: n.after?.filter((d) => fragmentIds.has(d)),
            }))
            const structuralErrors = validateGraph({
              name: '', goal: '', agents: mergedAgents, nodes: nodesForValidation,
              rails: { maxIterations: 1, maxCostUsd: 1 }, verdictPolicy: { kind: 'all-pass' },
            })
            if (structuralErrors.length > 0) throw new Error(structuralErrors.join('; '))
            lastGoodGraphFragment = fragment
            // Re-serialize back into `state.plan` regardless of which reply
            // shape produced `fragment`, so it always holds a full,
            // re-parseable graph document - composeContext's "# Current
            // plan" display, a later applySplice, and the NEXT edits
            // reply's own base all depend on that invariant.
            state.plan = serializeGraphFragment(fragment)
          } catch (err) {
            formatError = err instanceof Error ? err.message : String(err)
            state.feedback = `OUTPUT FORMAT ERROR (automatic - not from a human or critic): ${formatError}\nYour entire reply must be ONLY a parseable YAML document with a top-level graph: key - no prose, no markdown headers, no explanation before or after it. Every node must use the real fields (role, agent, prompt, run, expect, after, etc.) - not invented ones. Fix this before anything else can be reviewed.`
            continue
          }
        }

        const critiques = outs.filter((o) => o.verdict && o.verdict.status !== 'pass')
        if (critiques.length === 0) return { ok: true }
        state.feedback = critiques.map((o) => `[${o.nodeId}] ${o.verdict!.evidence}`).join('\n')
      }

      // Internal rounds exhausted. A lingering critique failure (formatError
      // null) is pre-existing behavior unchanged by this fix - it falls
      // through to the caller's own replan/gate handling with the last
      // critique as feedback. A lingering FORMAT failure is different: it
      // is never something a critic or human should have to triage, so it
      // escalates through the same replans/replanLimit budget every other
      // replan is bounded by, instead of silently handing invalid content
      // onward.
      if (!formatError) return { ok: true }
      if (replans >= replanLimit) {
        return { ok: false, reason: `plan generation failed: planner could not produce parseable YAML after ${replans} replan(s) (${formatError})` }
      }
      replans += 1
      fingerprints.length = 0
      emit('replan', { replans, feedback: state.feedback ?? undefined })
    }
  }

  if (!opts.skipPlanning) {
    const initialPlan = await runPlanning()
    if (!initialPlan.ok) return await finish('halted', initialPlan.reason)
    state.feedback = null
  }

  while (true) {
    state.iteration += 1
    // One-shot: applies to this iteration's prompts only. A stale note from
    // an iteration where nobody submitted anything must not keep re-injecting
    // forever, so this always resets before checking for a fresh one.
    state.humanFeedback = opts.runDir ? drainHumanFeedback(opts.runDir) ?? null : null
    const breachBefore = guard.check(state.iteration)
    if (breachBefore) return await finish('halted', `rail breached (${breachBefore.rail}): ${breachBefore.detail}`)

    // `runAgents` may have grown since the last pass (a fragment declaring
    // its own agents was spliced in) - execution nodes referencing a
    // freshly-merged agent key must resolve it, so the merged set is
    // threaded through here rather than the run's original, fixed one.
    outcomes = await runIteration({ ...expanded, agents: runAgents }, execution, state, deps, onNode, shouldContinue, onNodeStart, onChunk)
    const verdicts = outcomes.flatMap((o) => (o.verdict ? [o.verdict] : []))
    fingerprints.push(verdictFingerprint(verdicts))
    emit('iteration_end', { iteration: state.iteration, costUsd: guard.spentUsd, estimatedCostUsd: guard.estimatedSpentUsd })

    const breach = guard.check(state.iteration)
    // a rail can preempt the pool between layers (scheduler.ts pre-node check),
    // leaving execution-region nodes - including configured verifiers - that
    // never ran. Their outcomes simply don't exist, so aggregating only the
    // outcomes present can misreport a partial verdict set as "all passed".
    // Computed against the execution list as it was AT THE START of this
    // iteration (before any plan-approval splice below might extend it) -
    // a node the run didn't even know about yet was never "skipped".
    const executionAtStart = execution
    const skipped = outcomes.length < executionAtStart.length
      ? executionAtStart.filter((n) => !outcomes.some((o) => o.nodeId === n.id))
      : []
    for (const n of skipped) {
      emit('node_skipped', { nodeId: n.id, role: n.role, iteration: state.iteration })
    }

    // A gate whose dependency chain leads back to a generates:'graph'
    // planner is a plan-approval gate: approval splices its fragment into
    // `execution` (handled inline, not via the ordinary routeIteration
    // path below - the newly spliced nodes haven't run yet this iteration,
    // so aggregating THIS iteration's outcomes would wrongly report
    // "verified" before they get a chance to), and a non-empty-feedback
    // rejection forces an immediate replan carrying the human's own words,
    // bounded by the same replan_limit as any other replan. A plain
    // (no-feedback) rejection is not a plan-approval-specific case at all -
    // it falls through unchanged to the existing iterate/stall/halt routing
    // every other gate already gets.
    // Same bound routeIteration's own stall-replan path enforces
    // (spec §10) - a plan-approval replan is still a replan, and must not
    // be able to loop past replan_limit just because it's driven inline
    // here instead of through routeIteration.
    const replanLimit = def.rails.replanLimit ?? Infinity
    let planApprovalHandled = false
    let planApprovalHalt: string | null = null
    for (const o of outcomes) {
      if (o.role !== 'gate' || !o.verdict) continue
      const gateNode = executionAtStart.find((n) => n.id === o.nodeId)
      if (!gateNode) continue
      const generator = planGeneratorFor(gateNode)
      if (!generator) continue // an ordinary gate - untouched
      if (o.verdict.status === 'pass') {
        const result = applySplice(state.plan ?? '', gateNode.id)
        if (!result.ok) {
          // an invalid fragment reaching an already-approved gate is
          // treated like any other config-shaped failure: replan, bounded
          // by the existing limit, carrying the parse/validation error as
          // feedback
          if (replans >= replanLimit) {
            planApprovalHalt = `replan limit exhausted: ${result.reason}`
          } else {
            state.feedback = result.reason
            replans += 1
            fingerprints.length = 0
            emit('replan', { replans, feedback: state.feedback })
            const replanned = await runPlanning()
            if (!replanned.ok) planApprovalHalt = replanned.reason
          }
        }
        planApprovalHandled = true
      } else if (o.verdict.evidence.startsWith('human feedback:')) {
        if (replans >= replanLimit) {
          planApprovalHalt = 'replan limit exhausted: human feedback still pending'
        } else {
          state.feedback = o.verdict.evidence.replace(/^human feedback:\s*/, '')
          replans += 1
          fingerprints.length = 0
          emit('replan', { replans, feedback: state.feedback })
          const replanned = await runPlanning()
          if (!replanned.ok) planApprovalHalt = replanned.reason
        }
        planApprovalHandled = true
      }
    }
    if (planApprovalHalt) return await finish('halted', planApprovalHalt)
    if (planApprovalHandled) continue

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
      const replanned = await runPlanning()
      if (!replanned.ok) return await finish('halted', replanned.reason)
    }
  }
}
