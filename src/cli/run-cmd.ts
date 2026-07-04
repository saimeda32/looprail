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
import { startDashboardServer, type DashboardServer } from '../dashboard/server.js'
import { runsRoot } from '../journal/runs.js'
import { defaultIo, dim, err, heading, ok, renderTable, warn, type CliIo } from './ui.js'
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
  rails: Rails, io: CliIo, autoApprove: boolean, timerDeps: GateTimerDeps = {},
): GateHandler {
  return async (node) => {
    if (autoApprove) {
      io.out(warn(`gate "${node.id}" auto-approved (--yes)`))
      return true
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    // Abort seam for the readline question: readline never rejects a pending
    // question on rl.close(), so the timeout path aborts it explicitly to
    // settle it instead of leaving a promise dangling for the process lifetime.
    const ac = new AbortController()
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      const question = rl.question(`gate "${node.id}" - approve? [y/N] `, { signal: ac.signal })
      const timeoutSec = rails.gateTimeoutSec
      // 0 and undefined both mean "wait forever" - only a positive timeout
      // starts the race. (A gateTimeoutSec of exactly 0 is not treated as
      // "time out immediately"; there was no product requirement for that,
      // so it falls back to the same wait-forever behavior as unset.)
      if (!(timeoutSec !== undefined && timeoutSec > 0)) {
        const answer = await question
        return /^y(es)?$/i.test(answer.trim())
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
        return /^y(es)?$/i.test(answer.trim())
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
        ctx.io.out(`    ${mark} ${String(d.nodeId)} ($${Number(d.costUsd ?? 0).toFixed(3)})`)
        break
      }
      case 'iteration_end':
        ctx.io.out(dim(`  - iteration ${String(d.iteration)} · $${Number(d.costUsd).toFixed(2)} of $${def.rails.maxCostUsd} budget`))
        break
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
      report: report.report,
    }))
    return report.status === 'verified' ? 0 : 2
  }

  ctx.io.out('')
  ctx.io.out(report.status === 'verified'
    ? ok(`verified - ${report.reason}`)
    : err(`halted - ${report.reason}`))
  ctx.io.out(`  iterations: ${report.iterations} · replans: ${report.replans} · total cost: $${report.costUsd.toFixed(2)}`)
  const breakdown = agentCostBreakdown(def, join(ctx.runDir, 'journal.jsonl'))
  if (breakdown.length > 0) {
    ctx.io.out(renderTable(
      ['agent', 'adapter', 'cost'],
      breakdown.map(([agent, cost]) =>
        [agent, def.agents[agent]?.adapter ?? '-', `$${cost.toFixed(3)}`]),
    ))
  }
  ctx.io.out('')
  ctx.io.out(heading('summary') + dim(report.report.source === 'fallback' ? ' (mechanical - no reporting agent)' : ''))
  ctx.io.out(`  ${report.report.summary}`)
  for (const claim of report.report.claims) {
    const confMark = claim.confidence >= 70 ? ok(`${claim.confidence}%`)
      : claim.confidence >= 40 ? warn(`${claim.confidence}%`) : err(`${claim.confidence}%`)
    ctx.io.out(`  ${confMark} ${claim.claim} ${dim(`- ${claim.reason}`)}`)
  }
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
      const costUsd = existsSync(journalPath) ? summarizeJournal(readJournal(journalPath)).costUsd : 0
      new JournalWriter(runDir).write('halt', { reason: 'canceled by user request', costUsd })
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
  opts: { cwd: string; json?: boolean; yes?: boolean; ui?: boolean },
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
  const uninstallCancelHandler = installCancelHandler(runDir, join(runDir, 'journal.jsonl'))

  let dashboard: DashboardServer | undefined
  if (opts.ui) {
    // panel-expand up front so node ids in the dashboard match the ids the
    // engine will actually journal (runLoop does this same expansion
    // internally - see splitRegions/expandPanels in engine/runner.ts)
    dashboard = await startDashboardServer({
      journalPath: join(runDir, 'journal.jsonl'),
      def: expandPanels(loaded.def),
    })
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
      gate: deps.gate ?? makeGate(loaded.def.rails, io, !!opts.yes),
    })
  } finally {
    uninstallCancelHandler()
    removeRunPid(runDir)
    if (dashboard) await dashboard.close()
  }
}

export function registerRun(program: Command): void {
  program
    .command('run [file]')
    .description('run a loopfile until verified or a rail halts it (exit 0 verified, 2 halted, 1 error)')
    .option('--json', 'machine-readable summary on stdout')
    .option('--yes', 'auto-approve human gates (CI)')
    .option('--ui', 'start the local dashboard before the run begins')
    .action(async (file: string | undefined, opts: { json?: boolean; yes?: boolean; ui?: boolean }, cmd: Command) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = await runAction(file, { cwd, ...opts })
    })
}
