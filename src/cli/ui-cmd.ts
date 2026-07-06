import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Command } from 'commander'
import { expandPanels, validateGraph, type LoopDef } from '../index.js'
import type { ResumeOverrides } from '../dashboard/server.js'
import { DEFAULT_MISSION_CONTROL_PORT, DEFAULT_SINGLE_RUN_PORT, startMissionControlServer, type MissionControlServer } from '../dashboard/mission-control-server.js'
import { workspaceHash } from '../journal/runs.js'
import { addWorkspace, defaultRegistryPath, listWorkspaces } from '../workspace/registry.js'
import { loadRunLoopDef } from '../journal/loopfile-persist.js'
import { loadLoop } from './run-cmd.js'
import { resumeAction } from './resume-cmd.js'
import { latestRunId, runsRoot } from './status-cmd.js'
import { defaultIo, dim, err, heading, startWithStableDefault, type CliIo } from './ui.js'

// Best-effort: the dashboard's usefulness (edges, rail maxes) is strictly
// additive on top of the observed-only view. A missing, unparsable, or
// invalid loopfile must never block viewing a run's journal - it just means
// a plainer dashboard (see design decision 4 in the plan).
//
// When `runDir` is given, the run's OWN persisted LoopDef copy
// (runDir/loopfile.json - see journal/loopfile-persist.ts) is preferred
// over re-reading `cwd`'s looprail.yaml: a run's dashboard-ability must not
// depend on its origin workspace still being on disk (a deleted/moved git
// worktree, for instance) - only a pre-existing run from before that fix
// ever falls through to the workspace-path read below.
export function loadExpandedLoopDef(file: string | undefined, cwd: string, runDir?: string): LoopDef | undefined {
  if (runDir) {
    const persisted = loadRunLoopDef(runDir)
    if (persisted) return persisted
  }
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
  port?: number
  registryPath?: string
}

export async function uiAction(
  runId: string | undefined,
  opts: UiActionOpts,
  io: CliIo = defaultIo,
): Promise<{ code: number; dashboard?: MissionControlServer; url?: string }> {
  const id = runId ?? latestRunId(opts.cwd)
  if (!id) {
    io.out(err(`no runs found under ${runsRoot(opts.cwd)} - start one with \`looprail run\``))
    return { code: 1 }
  }
  const journalPath = join(runsRoot(opts.cwd), id, 'journal.jsonl')
  if (!existsSync(journalPath)) {
    io.out(err(`no journal for run "${id}"`))
    return { code: 1 }
  }

  const registryPath = opts.registryPath ?? defaultRegistryPath()
  const resolvedCwd = resolve(opts.cwd)
  // Best-effort, same posture as run-cmd.ts's autoRegisterWorkspace: `ui
  // <runId>` must still work even if this write fails - it just means this
  // run's workspace won't ALSO show up in a later `ui --all` until
  // re-registered. Needed here (unlike before consolidation) because
  // mission-control-server.ts's matchRunRoute resolves a run's workspace
  // hash by looking it up in this same registry.
  try { addWorkspace(registryPath, resolvedCwd) } catch { /* best-effort */ }

  const resumeFor = (workspace: string, forRunId: string) => {
    if (!loadExpandedLoopDef(opts.file, workspace, join(runsRoot(workspace), forRunId))) return undefined
    return async (overrides: ResumeOverrides): Promise<void> => {
      await resumeAction(forRunId, { cwd: workspace, file: opts.file, json: true, ...overrides }, { io: { out: () => {} } })
    }
  }
  let dashboard: MissionControlServer
  try {
    dashboard = await startWithStableDefault(opts.port, DEFAULT_SINGLE_RUN_PORT,
      (port) => startMissionControlServer({ registryPath, resumeFor, port }))
  } catch (e) {
    io.out(err(e instanceof Error ? e.message : String(e)))
    return { code: 1 }
  }

  // Deep-links straight to this run's own view inside the consolidated
  // mission-control server (whose bare root shows every registered
  // workspace's runs, not just this one) - so `looprail ui <runId>` still
  // opens directly on the run the user asked for, same as it always has.
  const url = `${dashboard.url}/run/${workspaceHash(resolvedCwd)}/${id}/`
  const def = loadExpandedLoopDef(opts.file, opts.cwd, join(runsRoot(opts.cwd), id))
  io.out(heading(`looprail dashboard - ${id}`))
  io.out(`  ${url}`)
  if (!def) io.out(dim('  no loopfile loaded - showing observed nodes only (no edges, no rail maxes)'))

  if (opts.open) {
    const { execFile } = await import('node:child_process')
    // `start` is a cmd.exe builtin, not a standalone executable, so it must
    // be invoked through cmd /c rather than execFile'd directly.
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]]
    execFile(cmd, args, () => {})
  }

  return { code: 0, dashboard, url }
}

export interface UiAllActionOpts {
  registryPath?: string
  port?: number
}

// The --all counterpart to uiAction: one server, every registered
// workspace, no runId. See mission-control-server.ts for the routing table.
// Deliberately never fails on an empty registry - an empty mission-control
// page is a legitimate, useful state (it tells the user exactly what to do
// next), not an error condition.
export async function uiAllAction(
  opts: UiAllActionOpts,
  io: CliIo = defaultIo,
): Promise<{ code: number; dashboard?: MissionControlServer }> {
  const registryPath = opts.registryPath ?? defaultRegistryPath()
  const resumeFor = (workspace: string, runId: string) => {
    if (!loadExpandedLoopDef(undefined, workspace, join(runsRoot(workspace), runId))) return undefined
    return async (overrides: ResumeOverrides): Promise<void> => {
      await resumeAction(runId, { cwd: workspace, json: true, ...overrides }, { io: { out: () => {} } })
    }
  }
  let dashboard: MissionControlServer
  try {
    dashboard = await startWithStableDefault(opts.port, DEFAULT_MISSION_CONTROL_PORT,
      (port) => startMissionControlServer({ registryPath, resumeFor, port }))
  } catch (e) {
    io.out(err(e instanceof Error ? e.message : String(e)))
    return { code: 1 }
  }

  io.out(heading('looprail mission control'))
  io.out(`  ${dashboard.url}`)
  if (listWorkspaces(registryPath).length === 0) {
    io.out(dim('  no workspaces registered yet - `looprail workspace add` in a project, or just `looprail run` there (it registers itself automatically)'))
  }

  return { code: 0, dashboard }
}

function parsePort(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port must be an integer between 1 and 65535, got "${value}"`)
  return n
}

export function registerUi(program: Command): void {
  program
    .command('ui [runId]')
    .description('start a local dashboard visualizing a run from its journal (latest run by default)')
    .option('--file <path>', 'loopfile to load for graph edges and rail maxes (default ./looprail.yaml)')
    .option('--open', 'open the dashboard in the default browser')
    .option('--all', 'mission control: show every run across every registered workspace (ignores runId)')
    .option('--port <n>', 'bind to a fixed port (default: 4747, or 4748 with --all; falls back to a free port automatically if that one is taken)', parsePort)
    .action(async (
      runId: string | undefined,
      opts: { file?: string; open?: boolean; all?: boolean; port?: number },
      cmd: Command,
    ) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()

      if (opts.all) {
        if (runId) {
          defaultIo.out(err('`looprail ui --all` does not take a runId - drop --all to view one run'))
          process.exitCode = 1
          return
        }
        const result = await uiAllAction({ port: opts.port })
        process.exitCode = result.code
        if (result.dashboard) {
          const shutdown = () => { void result.dashboard!.close().then(() => process.exit(0)) }
          process.on('SIGINT', shutdown)
          process.on('SIGTERM', shutdown)
        }
        return
      }

      const result = await uiAction(runId, { cwd, file: opts.file, open: opts.open, port: opts.port })
      process.exitCode = result.code
      if (result.dashboard) {
        const shutdown = () => { void result.dashboard!.close().then(() => process.exit(0)) }
        process.on('SIGINT', shutdown)
        process.on('SIGTERM', shutdown)
      }
    })
}
