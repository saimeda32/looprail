import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import {
  createDefaultRegistry, expandPanels, JournalWriter, lintLoop, parseLoopfile, readJournal, runLoop,
  summarizeJournal,
  type AdapterRegistry, type GateHandler, type JournalEvent, type LoopDef,
  type NodeOutcome, type Rails, type RunReport,
} from '../index.js'
import { DEFAULT_DASHBOARD_PORT, startDashboardServer, type DashboardServer } from '../dashboard/server.js'
import { runsRoot } from '../journal/runs.js'
import { persistRunLoopDef } from '../journal/loopfile-persist.js'
import { hasStoredApproval, storeApproval } from '../journal/gate-approvals.js'
import { defaultIo, dim, err, heading, ok, renderTable, startWithStableDefault, warn, wrapText, type CliIo } from './ui.js'
import { addWorkspace, defaultRegistryPath } from '../workspace/registry.js'

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
      // the infra: tag makes the router HALT (spec §10) instead of treating the
      // timeout as an ordinary gate rejection
      const message = `infra: gate "${node.id}" timed out after ${timeoutSec}s awaiting human approval`
      const timer = timerDeps.gateTimer
        ? timerDeps.gateTimer(timeoutSec * 1000, message)
        : new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(message)), timeoutSec * 1000)
            timeoutId.unref()
          })
      // when the timer wins, abort the still-pending question so it settles;
      // swallow both losers' rejections so neither surfaces as an unhandled one
      timer.catch(() => ac.abort())
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

export function agentCostBreakdown(def: LoopDef, journalPath: string): [string, number][] {
  const byAgent = new Map<string, number>()
  for (const e of readJournal(journalPath)) {
    if (e.type !== 'node_end') continue
    const d = e.data as { nodeId?: unknown; costUsd?: unknown }
    const baseId = String(d.nodeId ?? '').split('@')[0]
    const node = def.nodes.find((n) => n.id === baseId)
    const key = node?.agent ?? `(${node?.role ?? 'unknown'})`
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
    const d = e.data as { nodeId?: unknown; estimatedCostUsd?: unknown }
    if (d.estimatedCostUsd === undefined || d.estimatedCostUsd === null) continue
    const baseId = String(d.nodeId ?? '').split('@')[0]
    const node = def.nodes.find((n) => n.id === baseId)
    const key = node?.agent ?? `(${node?.role ?? 'unknown'})`
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
      report: report.report,
    }))
    return report.status === 'verified' ? 0 : 2
  }

  ctx.io.out('')
  ctx.io.out(report.status === 'verified'
    ? ok(`verified - ${report.reason}`)
    : err(`halted - ${report.reason}`))
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
  ctx.io.out('')
  ctx.io.out(dim(`  journal: ${join(ctx.runDir, 'journal.jsonl')} · run id: ${report.runId}`))
  return report.status === 'verified' ? 0 : 2
}

export interface RunDeps {
  registry?: AdapterRegistry
  gate?: GateHandler
  io?: CliIo
  registryPath?: string
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
  opts: { cwd: string; json?: boolean; yes?: boolean; ui?: boolean; port?: number },
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
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
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
  // to match the ids the engine will actually journal, same as the
  // dashboard `def:` passed to startDashboardServer below. Re-persisted
  // with the splice-extended graph by engine/runner.ts's applySplice
  // whenever a generates:'graph' fragment is approved. See
  // journal/loopfile-persist.ts.
  persistRunLoopDef(runDir, expandPanels(loaded.def))
  const uninstallCancelHandler = installCancelHandler(runDir, join(runDir, 'journal.jsonl'))

  let dashboard: DashboardServer | undefined
  if (opts.ui) {
    try {
      // panel-expand up front so node ids in the dashboard match the ids the
      // engine will actually journal (runLoop does this same expansion
      // internally - see splitRegions/expandPanels in engine/runner.ts)
      dashboard = await startWithStableDefault(opts.port, DEFAULT_DASHBOARD_PORT, (port) =>
        startDashboardServer({
          journalPath: join(runDir, 'journal.jsonl'),
          def: expandPanels(loaded.def),
          port,
        }))
    } catch (e) {
      io.out(err(e instanceof Error ? e.message : String(e)))
      uninstallCancelHandler()
      removeRunPid(runDir)
      return 1
    }
    if (!opts.json) {
      io.out(dim(`  dashboard: ${dashboard.url}`))
    }
  }

  try {
    return await executeRun(loaded.def, {
      cwd: opts.cwd,
      runId,
      runDir,
      io,
      json: !!opts.json,
      registry: deps.registry ?? createDefaultRegistry({ cwd: opts.cwd }),
      gate: deps.gate ?? makeGate(loaded.def.rails, io, !!opts.yes, opts.cwd),
    })
  } finally {
    uninstallCancelHandler()
    removeRunPid(runDir)
    if (dashboard) await dashboard.close()
  }
}

function parsePort(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port must be an integer between 1 and 65535, got "${value}"`)
  return n
}

export function registerRun(program: Command): void {
  program
    .command('run [file]')
    .description('run a loopfile until verified or a rail halts it (exit 0 verified, 2 halted, 1 error)')
    .option('--json', 'machine-readable summary on stdout')
    .option('--yes', 'auto-approve human gates (CI)')
    .option('--ui', 'start the local dashboard before the run begins')
    .option('--port <n>', 'bind --ui to a fixed port (default: 4747; falls back to a free port automatically if that one is taken)', parsePort)
    .action(async (
      file: string | undefined,
      opts: { json?: boolean; yes?: boolean; ui?: boolean; port?: number },
      cmd: Command,
    ) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = await runAction(file, { cwd, ...opts })
    })
}
