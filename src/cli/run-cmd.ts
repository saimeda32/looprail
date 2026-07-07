import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Option, type Command } from 'commander'
import {
  createDefaultRegistry, expandPanels, findPlanGenerator, gateParkedMessage, JournalWriter, lintLoop, normalizeGateAnswer,
  parseLoopfile, readJournal, runLoop, summarizeJournal,
  type AdapterRegistry, type GateAnswer, type GateHandler, type JournalEvent, type LoopDef, type NodeDef,
  type NodeOutcome, type Rails, type RunReport,
} from '../index.js'
import type { ResumeOverrides } from '../dashboard/server.js'
import {
  DEFAULT_SINGLE_RUN_PORT, startMissionControlServer, type MissionControlServer,
} from '../dashboard/mission-control-server.js'
import { registerPendingGate, resolvePendingGate, sweepPendingGates } from '../dashboard/gate-registry.js'
import { runsRoot, workspaceHash } from '../journal/runs.js'
import { persistRunLoopDef } from '../journal/loopfile-persist.js'
import { hasStoredApproval, storeApproval } from '../journal/gate-approvals.js'
import { defaultIo, dim, err, heading, ok, renderTable, startWithStableDefault, warn, wrapText, type CliIo } from './ui.js'
import { desktopNotifier, type Notifier } from './notify.js'
import { addWorkspace, defaultRegistryPath } from '../workspace/registry.js'
import { loadExpandedLoopDef } from './ui-cmd.js'
import { resumeAction } from './resume-cmd.js'

export function loadLoop(file: string | undefined, cwd: string): { def: LoopDef; path: string } {
  const path = resolve(cwd, file ?? 'looprail.yaml')
  if (!existsSync(path)) {
    throw new Error(`no loopfile at ${path} - run \`looprail init\` to scaffold one`)
  }
  return { def: parseLoopfile(readFileSync(path, 'utf8')), path }
}

export interface GateTimerDeps {
  // returns a promise that rejects with `message` after `ms` milliseconds.
  // Defaults to a real (unref'd) setTimeout owned by makeGate (so it can be
  // cleared once the human answers); tests inject a fake that rejects
  // immediately to exercise the timeout path deterministically.
  gateTimer?: (ms: number, message: string) => Promise<never>
  // Fired when a gate starts waiting for a human, and again if it parks on
  // timeout. Defaults to a NO-OP here so unit-constructed gates stay silent;
  // the real desktopNotifier is wired in explicitly by runAction/resumeAction
  // (the actual CLI entrypoints), keeping notification a product behavior of
  // running looprail, not a side effect of constructing a gate handler.
  notify?: Notifier
  // How often the gate polls for a cross-process gate-answer.json (see
  // journal/gate-files.ts). Default 500ms; tests inject something tiny.
  gateAnswerPollMs?: number
}

export function makeGate(
  rails: Rails, io: CliIo, autoApprove: boolean, cwd: string, timerDeps: GateTimerDeps = {},
  stdin: NodeJS.ReadableStream = process.stdin,
): GateHandler {
  return async (node) => {
    if (autoApprove) {
      io.out(warn(`gate "${node.id}" auto-approved (--yes)`))
      return { approved: true }
    }
    if (hasStoredApproval(cwd, node)) {
      io.out(warn(`gate "${node.id}" - previously approved, skipping prompt`))
      return { approved: true }
    }
    const notify = timerDeps.notify ?? (() => {})
    notify('looprail - approval needed', `gate "${node.id}" is waiting for your answer`)
    const rl = createInterface({ input: stdin, output: process.stdout })
    // Abort seam for the readline question: readline never rejects a pending
    // question on rl.close(), so the timeout path aborts it explicitly to
    // settle it instead of leaving a promise dangling for the process lifetime.
    const ac = new AbortController()
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      const question = rl.question(`gate "${node.id}" - approve? [y/N/a=always] `, { signal: ac.signal })
      const timeoutSec = rails.gateTimeoutSec
      // 0 and undefined both mean "wait forever" - only a positive timeout
      // starts the race. (A gateTimeoutSec of exactly 0 is not treated as
      // "time out immediately"; there was no product requirement for that,
      // so it falls back to the same wait-forever behavior as unset.)
      if (!(timeoutSec !== undefined && timeoutSec > 0)) {
        const answer = await question
        if (/^a(lways)?$/i.test(answer.trim())) {
          storeApproval(cwd, node)
          return { approved: true }
        }
        const trimmed = answer.trim()
        if (/^y(es)?$/i.test(trimmed)) return { approved: true }
        if (trimmed.length === 0) return { approved: false }
        return { approved: false, feedback: trimmed }
      }
      // the parked: tag makes the router HALT as parked-resumable (see
      // router.ts's parked branch) instead of treating the timeout as an
      // infrastructure error or an ordinary gate rejection
      const message = gateParkedMessage(node.id, timeoutSec)
      const timer = timerDeps.gateTimer
        ? timerDeps.gateTimer(timeoutSec * 1000, message)
        : new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(message)), timeoutSec * 1000)
            timeoutId.unref()
          })
      // when the timer wins, abort the still-pending question so it settles;
      // swallow both losers' rejections so neither surfaces as an unhandled one
      timer.catch(() => {
        ac.abort()
        notify('looprail - run parked', `gate "${node.id}" got no answer in time - resume the run to answer it`)
      })
      question.catch(() => {})
      try {
        const answer = await Promise.race([question, timer])
        if (/^a(lways)?$/i.test(answer.trim())) {
          storeApproval(cwd, node)
          return { approved: true }
        }
        const trimmed = answer.trim()
        if (/^y(es)?$/i.test(trimmed)) return { approved: true }
        if (trimmed.length === 0) return { approved: false }
        return { approved: false, feedback: trimmed }
      } finally {
        // human answered first: stop the real timer so it never fires later
        // (no-op when a test injected its own gateTimer)
        clearTimeout(timeoutId)
      }
    } finally {
      rl.close()
    }
  }
}

// The gate-waiting marker + cross-process answer-file protocol live in
// journal/gate-files.ts (the journal layer) so the dashboard can import
// them without a dashboard->cli cycle; re-exported here because this is
// where they historically lived and where gate-handler callers look.
export {
  readGateWaitingMarker, removeGateWaitingMarker, writeGateWaitingMarker, type GateWaitingMarker,
} from '../journal/gate-files.js'
import {
  consumeGateAnswer, discardStaleGateAnswer, removeGateWaitingMarker, writeGateWaitingMarker,
} from '../journal/gate-files.js'

// Polls the run directory for a gate-answer.json written by ANOTHER process
// (a separate mission-control server answering on the human's behalf - see
// journal/gate-files.ts). Resolves with the consumed answer; never rejects.
// The abort signal (shared with the gate's other racers) stops the polling
// the instant any other channel settles first.
//
// keepAlive matters more than it looks: in makeUiGate the interval is
// unref'd (stdin's readline already holds the process open; a stray poll
// must not). But in a DETACHED child this poll is the process's ONLY
// pending work - unref it and Node's event loop drains and the process
// exits cleanly mid-wait, silently abandoning the run at its gate. Caught
// live in the first real `run -d` smoke test: the child logged "gate
// approve" and vanished, no error anywhere, because waiting was all it had
// left to do.
function watchGateAnswerFile(
  runDir: string, signal: AbortSignal, pollMs: number, keepAlive = false,
): Promise<GateAnswer> {
  return new Promise((resolve) => {
    const tick = () => {
      if (signal.aborted) {
        clearInterval(id)
        return
      }
      const answer = consumeGateAnswer(runDir)
      if (answer) {
        clearInterval(id)
        resolve(answer)
      }
    }
    const id = setInterval(tick, pollMs)
    if (!keepAlive) id.unref?.()
    signal.addEventListener('abort', () => clearInterval(id), { once: true })
  })
}

// Builds the GateHandler used ONLY when `looprail run --ui` is active (see
// runAction below) - a live blocked gate answerable from EITHER the
// terminal OR the dashboard's /control approve-gate/reject-gate actions,
// whichever answers first. makeGate above is completely untouched: when
// --ui is not set, this function is never called and the CLI's existing
// stdin-only behavior is exactly what it always was.
//
// autoApprove and hasStoredApproval are honored FIRST, identically to
// makeGate - an already-decided gate (via --yes or a prior "always" answer)
// never even registers with the dashboard, exactly mirroring makeGate's own
// short-circuit.
//
// isPlanApproval is computed once per gate call via findPlanGenerator
// (extracted from engine/runner.ts, see that function's own comment) against
// the full panel-expanded node list, so the dashboard can label a plan-
// approval gate distinctly from an ordinary one without re-deriving a
// second, possibly-diverging detection of its own.
//
// A dashboard-supplied GateAnswer flows through resolvePendingGate exactly
// like the readline-answered path below - both funnel into the exact same
// GateAnswer shape callers (runner.ts's routeIteration/plan-approval
// splice handling) already expect via normalizeGateAnswer; there is no
// second, parallel approval mechanism.
export function makeUiGate(
  rails: Rails, io: CliIo, autoApprove: boolean, cwd: string,
  runId: string, runDir: string, expandedNodes: NodeDef[],
  timerDeps: GateTimerDeps = {},
  stdin: NodeJS.ReadableStream = process.stdin,
): GateHandler {
  return async (node, context) => {
    if (autoApprove) {
      io.out(warn(`gate "${node.id}" auto-approved (--yes)`))
      return { approved: true }
    }
    if (hasStoredApproval(cwd, node)) {
      io.out(warn(`gate "${node.id}" - previously approved, skipping prompt`))
      return { approved: true }
    }

    const isPlanApproval = !!findPlanGenerator(expandedNodes, node)
    // an answer file already on disk was aimed at an earlier gate (or is
    // debris from a killed run) - it must never approve THIS gate unseen
    discardStaleGateAnswer(runDir)
    writeGateWaitingMarker(runDir, { nodeId: node.id, isPlanApproval, question: context })
    const notify = timerDeps.notify ?? (() => {})
    notify('looprail - approval needed', `gate "${node.id}" is waiting for your answer (run ${runId})`)

    const rl = createInterface({ input: stdin, output: process.stdout })
    // Same abort seam makeGate uses for the readline question - whichever
    // of stdin / dashboard / timeout settles first, the others must be
    // settled too so nothing is left dangling for the process lifetime.
    const ac = new AbortController()
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    // Wraps the raw readline answer into the same GateAnswer shape a
    // dashboard-supplied answer already has, using the identical parsing
    // makeGate itself performs (a/always stores the approval, y/yes
    // approves, empty rejects with no feedback, anything else is captured
    // as rejection feedback) - so whichever channel wins the race, the
    // caller downstream sees one consistent GateAnswer shape either way.
    const stdinAnswered: Promise<GateAnswer> = (async () => {
      const answer = await rl.question(`gate "${node.id}" - approve? [y/N/a=always] `, { signal: ac.signal })
      if (/^a(lways)?$/i.test(answer.trim())) {
        storeApproval(cwd, node)
        return { approved: true }
      }
      const trimmed = answer.trim()
      if (/^y(es)?$/i.test(trimmed)) return { approved: true }
      if (trimmed.length === 0) return { approved: false }
      return { approved: false, feedback: trimmed }
    })()
    stdinAnswered.catch(() => {}) // a loser's abort-rejection must never surface as unhandled

    const registryAnswered = new Promise<GateAnswer>((resolve) => {
      registerPendingGate({ resolve, question: context, nodeId: node.id, runId, isPlanApproval })
    })

    // Third channel: an answer file written by a DIFFERENT process - a
    // long-lived `ui --all` mission control answering on the human's behalf
    // (its own in-process registry knows nothing about this run's process).
    // See journal/gate-files.ts for the protocol.
    const fileAnswered = watchGateAnswerFile(runDir, ac.signal, timerDeps.gateAnswerPollMs ?? 500)

    try {
      const timeoutSec = rails.gateTimeoutSec
      const racers: Promise<GateAnswer>[] = [stdinAnswered, registryAnswered, fileAnswered]
      // 0 and undefined both mean "wait forever" - same convention as makeGate
      if (timeoutSec !== undefined && timeoutSec > 0) {
        // the parked: tag makes the router HALT as parked-resumable (see
        // router.ts's parked branch) instead of treating the timeout as an
        // infrastructure error or an ordinary gate rejection
        const message = gateParkedMessage(node.id, timeoutSec)
        const timer = timerDeps.gateTimer
          ? timerDeps.gateTimer(timeoutSec * 1000, message)
          : new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error(message)), timeoutSec * 1000)
              timeoutId.unref()
            })
        // when the timer wins, abort the still-pending stdin question so it
        // settles; swallow the loser's rejection so it never surfaces as unhandled
        timer.catch(() => {
          ac.abort()
          notify('looprail - run parked', `gate "${node.id}" got no answer in time - resume run ${runId} to answer it`)
        })
        try {
          const answer = await Promise.race([...racers, timer])
          return normalizeGateAnswer(answer)
        } finally {
          clearTimeout(timeoutId)
        }
      }
      const answer = await Promise.race(racers)
      return normalizeGateAnswer(answer)
    } finally {
      // whichever channel won, the entry must not outlive this gate call - a
      // repeat resolve of an already-settled promise (or of an already-
      // deleted registry entry) is a harmless no-op, exactly like the MCP
      // gate path's own finally + sweepPendingGates.
      resolvePendingGate(runId, node.id, { approved: false })
      ac.abort()
      rl.close()
      removeGateWaitingMarker(runDir)
    }
  }
}

// The GateHandler for a DETACHED run (`looprail run -d`): there is no
// terminal to read y/N from and no same-process dashboard, so the ONLY
// answer channel is the cross-process answer file (journal/gate-files.ts),
// written by whatever mission-control server the human answers from. The
// waiting marker + notification + parked-on-timeout semantics are identical
// to makeUiGate - a gate must behave the same however the run was started.
export function makeDetachedGate(
  rails: Rails, io: CliIo, autoApprove: boolean, cwd: string,
  runId: string, runDir: string, expandedNodes: NodeDef[],
  timerDeps: GateTimerDeps = {},
): GateHandler {
  return async (node, context) => {
    if (autoApprove) {
      io.out(warn(`gate "${node.id}" auto-approved (--yes)`))
      return { approved: true }
    }
    if (hasStoredApproval(cwd, node)) {
      io.out(warn(`gate "${node.id}" - previously approved, skipping prompt`))
      return { approved: true }
    }

    const isPlanApproval = !!findPlanGenerator(expandedNodes, node)
    discardStaleGateAnswer(runDir)
    writeGateWaitingMarker(runDir, { nodeId: node.id, isPlanApproval, question: context })
    const notify = timerDeps.notify ?? (() => {})
    notify('looprail - approval needed', `gate "${node.id}" is waiting for your answer (run ${runId})`)

    const ac = new AbortController()
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    // keepAlive: this poll is a detached child's ONLY pending work - see
    // watchGateAnswerFile's comment for the live-caught silent-exit bug
    const fileAnswered = watchGateAnswerFile(runDir, ac.signal, timerDeps.gateAnswerPollMs ?? 500, true)

    try {
      const timeoutSec = rails.gateTimeoutSec
      if (timeoutSec !== undefined && timeoutSec > 0) {
        const message = gateParkedMessage(node.id, timeoutSec)
        const timer = timerDeps.gateTimer
          ? timerDeps.gateTimer(timeoutSec * 1000, message)
          : new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error(message)), timeoutSec * 1000)
              timeoutId.unref()
            })
        timer.catch(() => {
          ac.abort()
          notify('looprail - run parked', `gate "${node.id}" got no answer in time - resume run ${runId} to answer it`)
        })
        try {
          return normalizeGateAnswer(await Promise.race([fileAnswered, timer]))
        } finally {
          clearTimeout(timeoutId)
        }
      }
      return normalizeGateAnswer(await fileAnswered)
    } finally {
      ac.abort()
      removeGateWaitingMarker(runDir)
    }
  }
}

export function agentCostBreakdown(def: LoopDef, journalPath: string): [string, number][] {
  const byAgent = new Map<string, number>()
  for (const e of readJournal(journalPath)) {
    if (e.type !== 'node_end') continue
    const d = e.data as { nodeId?: unknown; costUsd?: unknown; agent?: unknown }
    const baseId = String(d.nodeId ?? '').split('@')[0]
    const node = def.nodes.find((n) => n.id === baseId)
    // The event's own agent (when journaled) wins over the loopfile's
    // node.agent: rate-limit failover (see engine/nodes.ts) can serve a node
    // with a different agent than the one configured, and cost must follow
    // the agent that actually spent it, not the one that was asked first.
    const key = typeof d.agent === 'string' ? d.agent : (node?.agent ?? `(${node?.role ?? 'unknown'})`)
    byAgent.set(key, (byAgent.get(key) ?? 0) + Number(d.costUsd ?? 0))
  }
  return [...byAgent.entries()]
    .map(([k, v]) => [k, Number(v.toFixed(6))] as [string, number])
    .sort((a, b) => b[1] - a[1])
}

// Mirrors agentCostBreakdown but folds estimatedCostUsd instead of costUsd -
// kept as a SEPARATE function (rather than widening agentCostBreakdown's
// tuple) so real-cost callers/tests are untouched, and so a caller can never
// mistake an estimated figure for a real one by pattern-matching the tuple
// shape. Only agents that ever produced an estimate appear here (an agent
// with no estimate anywhere in the journal contributes nothing, not a 0).
export function agentEstimatedCostBreakdown(def: LoopDef, journalPath: string): [string, number][] {
  const byAgent = new Map<string, number>()
  for (const e of readJournal(journalPath)) {
    if (e.type !== 'node_end') continue
    const d = e.data as { nodeId?: unknown; estimatedCostUsd?: unknown; agent?: unknown }
    if (d.estimatedCostUsd === undefined || d.estimatedCostUsd === null) continue
    const baseId = String(d.nodeId ?? '').split('@')[0]
    const node = def.nodes.find((n) => n.id === baseId)
    // Same failover-aware attribution as agentCostBreakdown above.
    const key = typeof d.agent === 'string' ? d.agent : (node?.agent ?? `(${node?.role ?? 'unknown'})`)
    byAgent.set(key, (byAgent.get(key) ?? 0) + Number(d.estimatedCostUsd))
  }
  return [...byAgent.entries()]
    .map(([k, v]) => [k, Number(v.toFixed(6))] as [string, number])
    .sort((a, b) => b[1] - a[1])
}

export interface ExecCtx {
  cwd: string
  runId: string
  runDir: string
  io: CliIo
  registry: AdapterRegistry
  gate: GateHandler
  json: boolean
  cache?: Map<string, NodeOutcome>
  // Set by resumeAction when this invocation continues a run that already
  // executed some iterations in an earlier process (see runner.ts's
  // RunOptions fields of the same names for why each matters).
  startIteration?: number
  initialPlan?: string | null
  initialFeedback?: string | null
  skipPlanning?: boolean
}

export async function executeRun(def: LoopDef, ctx: ExecCtx): Promise<number> {
  const onEvent = (e: JournalEvent): void => {
    if (ctx.json) return
    const d = e.data as Record<string, unknown>
    switch (e.type) {
      case 'run_start':
        ctx.io.out(heading(`run ${String(d.runId)} - ${String(d.name)}`))
        break
      case 'node_start':
        ctx.io.out(dim(`  ▸ iter ${String(d.iteration)} · ${String(d.role)} ${String(d.nodeId)}`))
        break
      case 'node_end': {
        const v = d.verdict as { status?: string } | null
        const mark = !v ? dim('done') : v.status === 'pass' ? ok('pass') : err(String(v.status))
        const est = d.estimatedCostUsd === undefined || d.estimatedCostUsd === null ? ''
          : ` (~$${Number(d.estimatedCostUsd).toFixed(3)} est)`
        ctx.io.out(`    ${mark} ${String(d.nodeId)} ($${Number(d.costUsd ?? 0).toFixed(3)}${est})`)
        break
      }
      case 'iteration_end': {
        const est = Number(d.estimatedCostUsd ?? 0) > 0 ? ` incl ~$${Number(d.estimatedCostUsd).toFixed(2)} est` : ''
        ctx.io.out(dim(`  - iteration ${String(d.iteration)} · $${Number(d.costUsd).toFixed(2)}${est} of $${def.rails.maxCostUsd} budget`))
        break
      }
      case 'replan':
        ctx.io.out(warn(`  ↻ replan #${String(d.replans)}`))
        break
      case 'node_skipped':
        ctx.io.out(dim(`    skipped ${String(d.nodeId)} (rail)`))
        break
      default:
        break
    }
  }

  let report: RunReport
  try {
    report = await runLoop(def, {
      registry: ctx.registry, gate: ctx.gate, cwd: ctx.cwd,
      runDir: ctx.runDir, runId: ctx.runId, cache: ctx.cache, onEvent,
      startIteration: ctx.startIteration,
      initialPlan: ctx.initialPlan, initialFeedback: ctx.initialFeedback, skipPlanning: ctx.skipPlanning,
    })
  } catch (e) {
    ctx.io.out(err(e instanceof Error ? e.message : String(e)))
    return 1
  }

  if (ctx.json) {
    ctx.io.out(JSON.stringify({
      runId: report.runId, status: report.status, reason: report.reason,
      iterations: report.iterations, replans: report.replans,
      costUsd: Number(report.costUsd.toFixed(4)),
      estimatedCostUsd: Number(report.estimatedCostUsd.toFixed(4)),
      // absolute path so CI can upload the run's evidence trail as an
      // artifact without re-deriving the workspace hash
      journal: join(ctx.runDir, 'journal.jsonl'),
      report: report.report,
    }))
    return report.status === 'verified' ? 0 : 2
  }

  ctx.io.out('')
  // A parked run (gate timed out awaiting a human - router.ts's parked
  // branch) is deliberately NOT rendered through the same red "halted -"
  // line as a genuine failure: nothing went wrong, the work already done is
  // cached in the journal, and the single action needed is a resume.
  const isParked = report.status === 'halted' && report.reason.startsWith('parked')
  ctx.io.out(report.status === 'verified'
    ? ok(`verified - ${report.reason}`)
    : isParked ? warn(`parked - ${report.reason}`)
    : err(`halted - ${report.reason}`))
  if (isParked) {
    ctx.io.out(dim(`  nothing failed - resume with \`looprail resume ${report.runId}\` (or from mission control) and the gate will ask again`))
  }
  const estimatedSummary = report.estimatedCostUsd > 0 ? ` (~$${report.estimatedCostUsd.toFixed(2)} est)` : ''
  ctx.io.out(`  iterations: ${report.iterations} · replans: ${report.replans} · total cost: $${report.costUsd.toFixed(2)}${estimatedSummary}`)
  const breakdown = agentCostBreakdown(def, join(ctx.runDir, 'journal.jsonl'))
  const estimatedBreakdown = new Map(agentEstimatedCostBreakdown(def, join(ctx.runDir, 'journal.jsonl')))
  if (breakdown.length > 0) {
    ctx.io.out(renderTable(
      ['agent', 'adapter', 'cost'],
      breakdown.map(([agent, cost]) => {
        const est = estimatedBreakdown.get(agent)
        return [agent, def.agents[agent]?.adapter ?? '-', `$${cost.toFixed(3)}${est ? ` (~$${est.toFixed(3)} est)` : ''}`]
      }),
    ))
  }
  ctx.io.out('')
  ctx.io.out(heading('summary') + dim(report.report.source === 'fallback' ? ' (mechanical - no reporting agent)' : ''))
  // A real reporting agent's summary/claim/reason text routinely runs
  // 100-300+ characters unwrapped (verified against a live copilot-cli
  // run) - left to the terminal's own wrapping, a continuation line has no
  // indent and reads as a new top-level item instead of a continuation of
  // the one above it. Wrap explicitly, with a hanging indent that lines up
  // under where the text itself starts.
  const width = Math.max(40, (process.stdout.columns || 100) - 2)
  for (const line of wrapText(report.report.summary, width)) {
    ctx.io.out(`  ${line}`)
  }
  if (report.report.claims.length > 0) ctx.io.out('')
  for (const claim of report.report.claims) {
    const badge = String(claim.confidence).padStart(3) + '%'
    const confMark = claim.confidence >= 70 ? ok(badge) : claim.confidence >= 40 ? warn(badge) : err(badge)
    const claimLines = wrapText(claim.claim, width - 7)
    ctx.io.out(`  ${confMark} ${claimLines[0]}`)
    for (const cont of claimLines.slice(1)) ctx.io.out(`       ${cont}`)
    for (const reasonLine of wrapText(claim.reason, width - 7)) {
      ctx.io.out(dim(`       ${reasonLine}`))
    }
  }
  const filesTouched = report.report.filesTouched ?? []
  if (filesTouched.length > 0) {
    ctx.io.out('')
    // Collapsed count only, no interactive expand/collapse mechanism: the
    // full list is one `git diff --stat` away, which is disproportionately
    // simpler than building CLI expand/collapse machinery for this one field.
    ctx.io.out(dim(`  ${filesTouched.length} file${filesTouched.length === 1 ? '' : 's'} touched - run \`git diff --stat\` (in ${ctx.cwd}) to see them`))
  }
  ctx.io.out('')
  ctx.io.out(dim(`  journal: ${join(ctx.runDir, 'journal.jsonl')} · run id: ${report.runId}`))
  return report.status === 'verified' ? 0 : 2
}

export interface RunDeps {
  registry?: AdapterRegistry
  gate?: GateHandler
  io?: CliIo
  registryPath?: string
  // Seam for `run --detach`'s child spawn (tests capture the args instead
  // of forking a real process). Defaults to node:child_process's spawn.
  spawner?: (cmd: string, args: string[], options: Record<string, unknown>) => { unref(): void }
  // Seam for the detached child's completion notification (see notify.ts).
  notifier?: Notifier
}

// The `run --detach` parent: mints the runId, creates the run directory (so
// the child's log has somewhere to live before the child even starts),
// spawns the SAME CLI as a fully detached child (own process group, stdio to
// a log file next to the journal, unref'd - it survives this terminal, this
// shell, and this parent exiting), prints where to watch it, and returns
// immediately. The loopfile was already lint-validated by runAction before
// this is called, so a broken loopfile still fails fast in the foreground
// instead of silently dying in a background log.
//
// Gates on a detached run are answered from mission control (`looprail ui
// --all`): the child's makeDetachedGate polls the run directory's answer
// file (journal/gate-files.ts), which serveControl writes when the human
// clicks approve/reject on ANY dashboard process reading this run.
function detachRun(
  file: string | undefined,
  opts: { cwd: string; yes?: boolean; json?: boolean },
  io: CliIo,
  deps: RunDeps,
): number {
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const runDir = join(runsRoot(opts.cwd), runId)
  mkdirSync(runDir, { recursive: true })
  const logPath = join(runDir, 'detached.log')
  const spawner = deps.spawner ?? ((cmd: string, args: string[], options: Record<string, unknown>) => {
    const fd = openSync(logPath, 'a')
    const child = spawn(cmd, args, { ...options, stdio: ['ignore', fd, fd] } as Parameters<typeof spawn>[2])
    closeSync(fd) // the child holds its own copy of the descriptor
    return child
  })
  const child = spawner(process.execPath, [
    process.argv[1], 'run',
    ...(file ? [file] : []),
    '--detached-child', runId,
    ...(opts.yes ? ['--yes'] : []),
  ], { detached: true, cwd: opts.cwd })
  child.unref()
  if (opts.json) {
    io.out(JSON.stringify({ runId, detached: true, log: logPath }))
  } else {
    io.out(ok(`detached - run ${runId} continues in the background`))
    io.out(dim(`  watch/answer gates: looprail ui --all (mission control)`))
    io.out(dim(`  status:            looprail status ${runId}`))
    io.out(dim(`  log:               ${logPath}`))
  }
  return 0
}

// Best-effort: a run must never fail because the workspace registry file
// couldn't be written (permissions, a blocked path, a full disk). Mission
// control simply won't see this project until the registry write succeeds
// on some later run, or the user runs `looprail workspace add` by hand.
function autoRegisterWorkspace(cwd: string, registryPath: string): void {
  try {
    addWorkspace(registryPath, cwd)
  } catch {
    // swallowed - see comment above
  }
}

// The dashboard's pause/resume/cancel controls (server.ts's serveControl)
// need this process's own pid to signal it later - recorded once, up front,
// same best-effort posture as the registry write above. Exported so
// resume-cmd.ts's resumeAction can give a resumed run the same pid file
// and cancel-on-SIGTERM behavior a fresh `run` gets - it is a real,
// controllable process too, not a fire-and-forget script.
export function writeRunPid(runDir: string): void {
  try {
    writeFileSync(join(runDir, 'pid'), String(process.pid))
  } catch {
    // swallowed - a run must never fail just because it couldn't record its own pid
  }
}

// Once this process is done with a run - however it ends, verified, halted,
// or canceled - its pid file must not outlive it. A pid is only ever
// meaningful while the exact process that wrote it is still alive: left in
// place, it would tell a later `looprail resume`/`replay` on this same run
// directory (which does not write its own pid) that there is still
// something here to pause or cancel, and after enough real time passes,
// that stale pid can be reassigned by the OS to a completely unrelated
// process - making "cancel" a real risk of signaling the wrong thing
// entirely, not just a no-op on an already-finished run.
export function removeRunPid(runDir: string): void {
  try {
    unlinkSync(join(runDir, 'pid'))
  } catch {
    // swallowed - already gone, or never written; either way nothing to clean up
  }
}

// SIGTERM is how the dashboard's "cancel" control (server.ts's serveControl)
// asks this specific process to stop. Node's default SIGTERM behavior is an
// immediate, silent exit, which would leave the journal permanently showing
// "running" (there is no terminal verified/halt event to say otherwise) even
// though the process is long gone - so this writes one before exiting,
// using the cost the journal already knows about since there is no live
// engine state reachable from here. Returns an uninstall function: this
// must never leak past the run it belongs to, since runAction can run
// many times in one process (every test in run-cmd.test.ts does exactly
// that) and each installation is only ever meant to answer for its own run.
export function installCancelHandler(runDir: string, journalPath: string): () => void {
  const onSigterm = (): void => {
    try {
      const summary = existsSync(journalPath) ? summarizeJournal(readJournal(journalPath)) : undefined
      new JournalWriter(runDir).write('halt', {
        reason: 'canceled by user request',
        costUsd: summary?.costUsd ?? 0,
        estimatedCostUsd: summary?.estimatedCostUsd ?? 0,
      })
    } catch {
      // best-effort - the process exits either way
    }
    // process.exit() skips any pending finally block (runAction's own
    // cleanup never runs after this), so the pid removal that would
    // otherwise happen there has to happen here instead.
    removeRunPid(runDir)
    process.exit(2)
  }
  process.once('SIGTERM', onSigterm)
  return () => process.removeListener('SIGTERM', onSigterm)
}

export async function runAction(
  file: string | undefined,
  opts: {
    cwd: string; json?: boolean; yes?: boolean; ui?: boolean; port?: number
    detach?: boolean
    // Internal (hidden --detached-child flag): this process IS the detached
    // child - use the runId its parent already announced, take gate answers
    // via the cross-process answer file, notify on completion.
    detachedChild?: string
    // Run the loaded loopfile against a DIFFERENT goal without touching the
    // file on disk - the same override posture as resume's goal override
    // (see resume-cmd.ts). This is what lets `looprail queue` run one graph
    // shape against many goals.
    goal?: string
    // Applied only when the loopfile sets NO gate_timeout of its own - an
    // unattended run (queue) must never hang forever on a gate nobody is
    // watching; it parks instead. A loopfile's own explicit value always wins.
    defaultGateTimeoutSec?: number
  },
  deps: RunDeps = {},
): Promise<number> {
  const io = deps.io ?? defaultIo
  let loaded: { def: LoopDef; path: string }
  try {
    loaded = loadLoop(file, opts.cwd)
  } catch (e) {
    io.out(err(e instanceof Error ? e.message : String(e)))
    return 1
  }
  if (opts.goal !== undefined) {
    loaded = { ...loaded, def: { ...loaded.def, goal: opts.goal } }
  }
  if (opts.defaultGateTimeoutSec !== undefined && loaded.def.rails.gateTimeoutSec === undefined) {
    loaded = { ...loaded, def: { ...loaded.def, rails: { ...loaded.def.rails, gateTimeoutSec: opts.defaultGateTimeoutSec } } }
  }
  autoRegisterWorkspace(resolve(opts.cwd), deps.registryPath ?? defaultRegistryPath())
  const findings = lintLoop(loaded.def)
  if (!opts.json) {
    for (const f of findings) {
      io.out(`${f.level === 'error' ? err(`${f.rule} error`) : warn(`${f.rule} warn`)} ${f.message}`)
    }
  }
  if (findings.some((f) => f.level === 'error')) {
    io.out(err('loop failed lint - fix the errors above (details: `looprail lint`)'))
    return 1
  }
  if (opts.detach) return detachRun(file, opts, io, deps)
  const runId = opts.detachedChild ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const runDir = join(runsRoot(opts.cwd), runId)

  // Create the run directory up front (used to be gated behind --ui; now
  // unconditional so the pid file below always lands, whether or not a
  // dashboard was opened for this specific invocation - the user might
  // start a plain `run` and only later open `looprail ui` in another
  // terminal to check on and control it). Also means /events' parent-dir-
  // watch fallback always has something real to watch immediately when
  // --ui is used. JournalWriter's later mkdirSync on this same path is a
  // safe no-op (recursive: true).
  mkdirSync(runDir, { recursive: true })
  writeRunPid(runDir)
  // Self-contained history: the STATIC bootstrap graph, persisted into the
  // run's OWN directory rather than only ever living in this workspace's
  // looprail.yaml - so the dashboard's graph edges and per-node
  // agent/model survive this workspace later being deleted or moved (e.g.
  // a git worktree cleaned up after merging). Expanded (panels resolved)
  // to match the ids the engine will actually journal - this is exactly
  // the file mission-control-server.ts's bestEffortLoopDef re-reads FRESH
  // on every /model request (not just once at dashboard-start), which is
  // what makes a mid-run splice show up immediately below. Re-persisted
  // with the splice-extended graph by engine/runner.ts's applySplice
  // whenever a generates:'graph' fragment is approved. See
  // journal/loopfile-persist.ts.
  // Computed once, up front, and reused for the persisted bootstrap graph
  // and (when --ui is set) makeUiGate's plan-approval detection - both
  // need the SAME panel-expanded node ids
  // the engine will actually journal (runLoop does this same expansion
  // internally - see splitRegions/expandPanels in engine/runner.ts).
  const expanded = expandPanels(loaded.def)
  persistRunLoopDef(runDir, expanded)
  const uninstallCancelHandler = installCancelHandler(runDir, join(runDir, 'journal.jsonl'))

  let dashboard: MissionControlServer | undefined
  if (opts.ui) {
    const registryPath = deps.registryPath ?? defaultRegistryPath()
    // Continues a halted run in place, in the SAME process as this
    // `run --ui` invocation - the exact same resumeFor shape uiAllAction
    // builds (see cli/ui-cmd.ts), not a second one invented here.
    // loadExpandedLoopDef's guard mirrors mission-control-server.ts's own
    // /model 501 path: no loadable loopfile means no way to resume.
    const resumeFor = (workspace: string, forRunId: string) => {
      if (!loadExpandedLoopDef(undefined, workspace, join(runsRoot(workspace), forRunId))) return undefined
      return async (overrides: ResumeOverrides): Promise<void> => {
        await resumeAction(forRunId, { cwd: workspace, json: true, ...overrides }, { io: { out: () => {} } })
      }
    }
    try {
      dashboard = await startWithStableDefault(opts.port, DEFAULT_SINGLE_RUN_PORT, (port) =>
        startMissionControlServer({ registryPath, resumeFor, port }))
    } catch (e) {
      io.out(err(e instanceof Error ? e.message : String(e)))
      uninstallCancelHandler()
      removeRunPid(runDir)
      return 1
    }
    if (!opts.json) {
      // Deep-links straight to THIS run's own view within the consolidated
      // mission-control server (which also serves every other registered
      // workspace's runs at its root) - so `run --ui` still opens directly
      // on the run it just started, same as it always has. This run gates
      // and resumes in-process for free: mission-control-server.ts's
      // serveControl/serveModel fall through to gate-registry.ts's DEFAULT
      // module-scope pendingGates Map whenever no override is passed (none
      // is, here) - and because this dashboard and the run share one
      // process, that default Map IS the same one makeUiGate below
      // registers into. No injection needed; this is the in-process wiring.
      io.out(dim(`  dashboard: ${dashboard.url}/run/${workspaceHash(resolve(opts.cwd))}/${runId}/`))
    }
  }

  try {
    const code = await executeRun(loaded.def, {
      cwd: opts.cwd,
      runId,
      runDir,
      io,
      json: !!opts.json,
      registry: deps.registry ?? createDefaultRegistry({ cwd: opts.cwd }),
      // A detached child's gate is answerable ONLY via the cross-process
      // answer file; a `--ui` run's gate from stdin or its own dashboard; a
      // plain `run` gets the exact same stdin-only makeGate it always has.
      gate: deps.gate ?? (opts.detachedChild
        ? makeDetachedGate(loaded.def.rails, io, !!opts.yes, opts.cwd, runId, runDir, expanded.nodes, { notify: deps.notifier ?? desktopNotifier })
        : opts.ui
          ? makeUiGate(loaded.def.rails, io, !!opts.yes, opts.cwd, runId, runDir, expanded.nodes, { notify: desktopNotifier })
          : makeGate(loaded.def.rails, io, !!opts.yes, opts.cwd, { notify: desktopNotifier })),
    })
    // A detached run has no terminal - the notification IS its completion
    // signal. Parked/halted vs verified is all the human needs at a glance;
    // the details are one mission-control click away.
    if (opts.detachedChild) {
      const notifier = deps.notifier ?? desktopNotifier
      notifier(
        `looprail - run ${code === 0 ? 'verified' : 'stopped'}`,
        code === 0
          ? `${loaded.def.name}: all verifiers passed (${runId})`
          : `${loaded.def.name}: parked or halted - check mission control (${runId})`,
      )
    }
    return code
  } finally {
    uninstallCancelHandler()
    removeRunPid(runDir)
    // A gate this run's engine never got to ask (a sibling node's failure
    // ended the run first) must not leave a stray registry entry sitting
    // around for this process's remaining lifetime - see dashboard/gate-
    // registry.ts's sweepPendingGates and the MCP gate path's identical
    // rationale. Harmless no-op for a plain (non --ui) run: makeGate never
    // registers anything here in the first place.
    sweepPendingGates(runId)
    removeGateWaitingMarker(runDir)
    if (dashboard) await dashboard.close()
  }
}

function parsePort(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port must be an integer between 1 and 65535, got "${value}"`)
  return n
}

export function registerRun(program: Command): void {
  const cmd = program
    .command('run [file]')
    .description('run a loopfile until verified or a rail halts it (exit 0 verified, 2 halted, 1 error)')
    .option('--json', 'machine-readable summary on stdout')
    .option('--yes', 'auto-approve human gates (CI)')
    .option('--ui', 'start the local dashboard before the run begins')
    .option('-d, --detach', 'run in the background: returns immediately; watch it and answer its gates from mission control (looprail ui --all)')
    .option('--port <n>', 'bind --ui to a fixed port (default: 4747; falls back to a free port automatically if that one is taken)', parsePort)
  // Internal plumbing for --detach's child process, never for humans: the
  // parent mints the runId and hands it down so it can print where to watch
  // BEFORE the child even starts. Hidden from --help.
  cmd.addOption(new Option('--detached-child <runId>').hideHelp())
  cmd.action(async (
    file: string | undefined,
    opts: { json?: boolean; yes?: boolean; ui?: boolean; port?: number; detach?: boolean; detachedChild?: string },
    command: Command,
  ) => {
    const { cwd } = command.optsWithGlobals<{ cwd: string }>()
    if (opts.detach && opts.ui) {
      defaultIo.out(err('--detach and --ui cannot be combined - a detached run is watched from mission control (`looprail ui --all`), which serves every run'))
      process.exitCode = 1
      return
    }
    process.exitCode = await runAction(file, { cwd, ...opts })
  })
}
