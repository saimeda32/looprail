import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from 'commander'
import {
  createDefaultRegistry, expandPanels, loadCache, readJournal, reconstructRunState, summarizeJournal,
  type LoopDef,
} from '../index.js'
import { loadRunLoopDef, persistRunLoopDef } from '../journal/loopfile-persist.js'
import {
  executeRun, installCancelHandler, loadLoop, makeGate, removeRunPid, writeRunPid, type RunDeps,
} from './run-cmd.js'
import { latestRunId, runsRoot } from './status-cmd.js'
import { defaultIo, dim, err } from './ui.js'
import { desktopNotifier } from './notify.js'

export interface ResumeOverrides {
  maxIterations?: number
  maxCostUsd?: number
  maxWallMinutes?: number
  // Named `replanLimit` to match the rails field of the same name (LoopDef.rails.replanLimit,
  // sourced from YAML `replan_limit`) - this is the resume-time raise for that rail.
  replanLimit?: number
  // A resume-time override for the run's GOAL text. Threaded through the SAME
  // override mechanism as the rails above rather than mutating the user's
  // loopfile.yaml on disk from a web UI, because: (a) loadLoop (run-cmd.ts)
  // re-reads and re-parses the loopfile fresh from disk on every resume, so an
  // override applied to the in-memory `def` after load is honored for the
  // resumed run without touching the source file; (b) it keeps one uniform
  // override path matching maxIterations/maxCostUsd/maxWallMinutes/replanLimit;
  // (c) it never silently rewrites the user's source file behind their back.
  // SCOPE: goal-only for this first cut - per-node prompt editing is out of scope.
  goal?: string
}

// Unlike replay (a deliberate fork: edit one prompt, compare the variant
// against the original), resume continues the *same* run - same runId,
// same runDir, appending to the same journal - because it is still the
// same goal, just given more budget. JournalWriter already appends rather
// than truncates, and buildViewModel re-derives its whole model fresh from
// every event on each read, so a second run_start/halt pair in the same
// journal is harmless: the last verified/halt event simply wins.
export async function resumeAction(
  runId: string | undefined,
  opts: { cwd: string; file?: string; json?: boolean; yes?: boolean } & ResumeOverrides,
  deps: RunDeps = {},
): Promise<number> {
  const io = deps.io ?? defaultIo
  const source = runId ?? latestRunId(opts.cwd)
  if (!source) {
    io.out(err(`no runs found under ${runsRoot(opts.cwd)} - nothing to resume`))
    return 1
  }
  const runDir = join(runsRoot(opts.cwd), source)
  const journalPath = join(runDir, 'journal.jsonl')
  if (!existsSync(journalPath)) {
    io.out(err(`no journal for run "${source}"`))
    return 1
  }
  // The run's OWN persisted LoopDef (runDir/loopfile.json) is the default,
  // NOT the workspace's looprail.yaml - real bug caught live: a queue item
  // started from `file: ship-check.yaml` parked at its gate, and resuming
  // it re-read the workspace default looprail.yaml, silently continuing the
  // parked run with a COMPLETELY DIFFERENT graph (and billing for it). An
  // explicit --file still wins (deliberately re-pointing the resume is a
  // real workflow); only a run predating loopfile persistence falls back to
  // re-reading the workspace default.
  let loaded: { def: LoopDef; path: string }
  if (opts.file === undefined) {
    const persisted = loadRunLoopDef(runDir)
    if (persisted) {
      loaded = { def: persisted, path: join(runDir, 'loopfile.json') }
    } else {
      try {
        loaded = loadLoop(undefined, opts.cwd)
      } catch (e) {
        io.out(err(e instanceof Error ? e.message : String(e)))
        return 1
      }
    }
  } else {
    try {
      loaded = loadLoop(opts.file, opts.cwd)
    } catch (e) {
      io.out(err(e instanceof Error ? e.message : String(e)))
      return 1
    }
  }
  const events = readJournal(journalPath)
  const priorIterations = summarizeJournal(events).iterations
  const { plan, feedback, sources } = reconstructRunState(events)
  // Excludes only the node_end entries whose own output composed the
  // reconstructed feedback/plan above (see runs.ts's reconstructRunState
  // and cache.ts's loadCache) - not every node_end sharing this iteration
  // number, so already-completed, unrelated work doesn't get needlessly
  // re-run just because it happened to finish in the same iteration.
  const cache = loadCache(journalPath, { excludeNodes: sources })
  const def: LoopDef = (opts.maxIterations === undefined && opts.maxCostUsd === undefined && opts.maxWallMinutes === undefined && opts.replanLimit === undefined && opts.goal === undefined)
    ? loaded.def
    : {
        ...loaded.def,
        goal: opts.goal ?? loaded.def.goal,
        rails: {
          ...loaded.def.rails,
          ...(opts.maxIterations === undefined ? {} : { maxIterations: opts.maxIterations }),
          ...(opts.maxCostUsd === undefined ? {} : { maxCostUsd: opts.maxCostUsd }),
          ...(opts.maxWallMinutes === undefined ? {} : { maxWallMinutes: opts.maxWallMinutes }),
          ...(opts.replanLimit === undefined ? {} : { replanLimit: opts.replanLimit }),
        },
      }
  io.out(dim(
    `loaded ${cache.size} cached node result(s) from ${source}, continuing from iteration ${priorIterations} `
      + `(rails: max ${def.rails.maxIterations} iterations, $${def.rails.maxCostUsd} budget)`,
  ))

  // Same pid/cancel-handler wiring runAction gives a fresh `run` - a
  // resumed run is a real, controllable process too (pause/cancel from the
  // dashboard must work on it exactly as well as on the original).
  writeRunPid(runDir)
  // Refresh the run's own persisted LoopDef copy too - a resume is not just
  // a fresh run's bootstrap write; it can also load a DIFFERENT loopfile
  // (--file) or override rails, and either change must be reflected in the
  // self-contained copy the dashboard reads, not just in memory for this
  // process. See journal/loopfile-persist.ts and cli/run-cmd.ts's runAction.
  persistRunLoopDef(runDir, expandPanels(def))
  const uninstallCancelHandler = installCancelHandler(runDir, journalPath)
  try {
    return await executeRun(def, {
      cwd: opts.cwd,
      runId: source,
      runDir,
      io,
      json: !!opts.json,
      registry: deps.registry ?? createDefaultRegistry({ cwd: opts.cwd }),
      gate: deps.gate ?? makeGate(def.rails, io, !!opts.yes, opts.cwd, { notify: desktopNotifier }),
      cache,
      startIteration: priorIterations,
      initialPlan: plan,
      initialFeedback: feedback,
      skipPlanning: true,
    })
  } finally {
    uninstallCancelHandler()
    removeRunPid(runDir)
  }
}

function parsePositiveNumber(value: string, flag: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number, got "${value}"`)
  return n
}

export function registerResume(program: Command): void {
  program
    .command('resume [runId]')
    .description('continue a halted or interrupted run in place - same run, more budget (latest run by default)')
    .option('--file <file>', 'loopfile to use (default ./looprail.yaml)')
    .option('--json', 'machine-readable summary on stdout')
    .option('--yes', 'auto-approve human gates')
    .option('--max-iterations <n>', 'raise rails.max_iterations for this run before continuing', (v: string) => parsePositiveNumber(v, '--max-iterations'))
    .option('--max-cost-usd <n>', 'raise rails.max_cost_usd for this run before continuing', (v: string) => parsePositiveNumber(v, '--max-cost-usd'))
    .option('--max-wall-minutes <n>', 'raise rails.max_wall_minutes for this run before continuing', (v: string) => parsePositiveNumber(v, '--max-wall-minutes'))
    .option('--replan-limit <n>', 'raise rails.replan_limit for this run before continuing', (v: string) => parsePositiveNumber(v, '--replan-limit'))
    .option('--goal <text>', 'override the run goal for this resume without editing the loopfile on disk')
    .action(async (
      runId: string | undefined,
      opts: { file?: string; json?: boolean; yes?: boolean; maxIterations?: number; maxCostUsd?: number; maxWallMinutes?: number; replanLimit?: number; goal?: string },
      cmd: Command,
    ) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = await resumeAction(runId, { cwd, ...opts })
    })
}
