import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from 'commander'
import { createDefaultRegistry, loadCache, type LoopDef } from '../index.js'
import { executeRun, loadLoop, makeGate, type RunDeps } from './run-cmd.js'
import { latestRunId, runsRoot } from './status-cmd.js'
import { defaultIo, dim, err, type CliIo } from './ui.js'

export async function replayAction(
  runId: string | undefined,
  opts: { cwd: string; file?: string; json?: boolean; yes?: boolean },
  deps: RunDeps = {},
): Promise<number> {
  const io = deps.io ?? defaultIo
  const source = runId ?? latestRunId(opts.cwd)
  if (!source) {
    io.out(err(`no runs found under ${runsRoot(opts.cwd)} — nothing to resume or replay`))
    return 1
  }
  const journalPath = join(runsRoot(opts.cwd), source, 'journal.jsonl')
  if (!existsSync(journalPath)) {
    io.out(err(`no journal for run "${source}"`))
    return 1
  }
  let loaded: { def: LoopDef; path: string }
  try {
    // v1: the loopfile is re-read from disk — replay from the project directory
    // the run started in. Edited nodes (changed context hash) re-execute live.
    loaded = loadLoop(opts.file, opts.cwd)
  } catch (e) {
    io.out(err(e instanceof Error ? e.message : String(e)))
    return 1
  }
  const cache = loadCache(journalPath)
  // printed in --json mode too: the JSON contract is "last stdout line is the
  // summary object", so informational lines before it are allowed
  io.out(dim(`loaded ${cache.size} cached node result(s) from ${source}`))
  const newRunId = `${source}-r${Date.now().toString(36)}`
  return executeRun(loaded.def, {
    cwd: opts.cwd,
    runId: newRunId,
    runDir: join(runsRoot(opts.cwd), newRunId),
    io,
    json: !!opts.json,
    registry: deps.registry ?? createDefaultRegistry({ cwd: opts.cwd }),
    gate: deps.gate ?? makeGate(loaded.def.rails, io, !!opts.yes),
    cache,
  })
}

function register(program: Command, name: 'resume' | 'replay', description: string): void {
  program
    .command(`${name} [runId]`)
    .description(description)
    .option('--file <file>', 'loopfile to use (default ./looprail.yaml)')
    .option('--json', 'machine-readable summary on stdout')
    .option('--yes', 'auto-approve human gates')
    .action(async (
      runId: string | undefined,
      opts: { file?: string; json?: boolean; yes?: boolean },
      cmd: Command,
    ) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = await replayAction(runId, { cwd, ...opts })
    })
}

export function registerReplay(program: Command): void {
  register(program, 'replay',
    're-run a past run with cached node results — edit one prompt, re-execute only downstream (latest run by default)')
  register(program, 'resume',
    'continue an interrupted run: completed nodes replay from cache for free, the remainder runs live (v1: replay semantics)')
}
