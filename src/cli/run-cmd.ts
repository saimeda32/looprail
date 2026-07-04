import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import {
  createDefaultRegistry, expandPanels, lintLoop, parseLoopfile, readJournal, runLoop,
  type AdapterRegistry, type GateHandler, type JournalEvent, type LoopDef,
  type NodeOutcome, type Rails, type RunReport,
} from '../index.js'
import { startDashboardServer, type DashboardServer } from '../dashboard/server.js'
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
  const runDir = join(opts.cwd, '.looprail', 'runs', runId)

  let dashboard: DashboardServer | undefined
  if (opts.ui) {
    // Create the run directory before the dashboard starts listening, so its
    // /events parent-dir-watch fallback always has a real directory to watch
    // from the first connection onward - otherwise a client connecting
    // before executeRun creates the directory (via JournalWriter's own
    // mkdirSync) gets no watcher at all and live updates never start until a
    // manual refresh. JournalWriter's later mkdirSync on this same path is a
    // safe no-op (recursive: true).
    mkdirSync(runDir, { recursive: true })
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
