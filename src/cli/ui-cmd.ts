import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from 'commander'
import { expandPanels, validateGraph, type LoopDef } from '../index.js'
import { startDashboardServer, type DashboardServer } from '../dashboard/server.js'
import { loadLoop } from './run-cmd.js'
import { latestRunId, runsRoot } from './status-cmd.js'
import { defaultIo, dim, err, heading, type CliIo } from './ui.js'

// Best-effort: the dashboard's usefulness (edges, rail maxes) is strictly
// additive on top of the observed-only view. A missing, unparsable, or
// invalid loopfile must never block viewing a run's journal — it just means
// a plainer dashboard (see design decision 4 in the plan).
export function loadExpandedLoopDef(file: string | undefined, cwd: string): LoopDef | undefined {
  try {
    const { def } = loadLoop(file, cwd)
    if (validateGraph(def).length > 0) return undefined
    const expanded = expandPanels(def)
    return validateGraph(expanded).length > 0 ? undefined : expanded
  } catch {
    return undefined
  }
}

export interface UiActionOpts {
  cwd: string
  file?: string
  open?: boolean
}

export async function uiAction(
  runId: string | undefined,
  opts: UiActionOpts,
  io: CliIo = defaultIo,
): Promise<{ code: number; dashboard?: DashboardServer }> {
  const id = runId ?? latestRunId(opts.cwd)
  if (!id) {
    io.out(err(`no runs found under ${runsRoot(opts.cwd)} — start one with \`looprail run\``))
    return { code: 1 }
  }
  const journalPath = join(runsRoot(opts.cwd), id, 'journal.jsonl')
  if (!existsSync(journalPath)) {
    io.out(err(`no journal for run "${id}"`))
    return { code: 1 }
  }

  const def = loadExpandedLoopDef(opts.file, opts.cwd)
  const dashboard = await startDashboardServer({ journalPath, def })

  io.out(heading(`looprail dashboard — ${id}`))
  io.out(`  ${dashboard.url}`)
  if (!def) io.out(dim('  no loopfile loaded — showing observed nodes only (no edges, no rail maxes)'))

  if (opts.open) {
    const { execFile } = await import('node:child_process')
    // `start` is a cmd.exe builtin, not a standalone executable, so it must
    // be invoked through cmd /c rather than execFile'd directly.
    const [cmd, args] = process.platform === 'darwin' ? ['open', [dashboard.url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', dashboard.url]]
      : ['xdg-open', [dashboard.url]]
    execFile(cmd, args, () => {})
  }

  return { code: 0, dashboard }
}

export function registerUi(program: Command): void {
  program
    .command('ui [runId]')
    .description('start a local dashboard visualizing a run from its journal (latest run by default)')
    .option('--file <path>', 'loopfile to load for graph edges and rail maxes (default ./looprail.yaml)')
    .option('--open', 'open the dashboard in the default browser')
    .action(async (runId: string | undefined, opts: { file?: string; open?: boolean }, cmd: Command) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      const result = await uiAction(runId, { cwd, file: opts.file, open: opts.open })
      process.exitCode = result.code
      if (result.dashboard) {
        const shutdown = () => { void result.dashboard!.close().then(() => process.exit(0)) }
        process.on('SIGINT', shutdown)
        process.on('SIGTERM', shutdown)
      }
    })
}
