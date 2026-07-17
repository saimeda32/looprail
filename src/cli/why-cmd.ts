import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from 'commander'
import { readJournal } from '../index.js'
import { latestRunId, runsRoot } from '../journal/runs.js'
import { diagnoseRun, factsFromJournal, type Diagnosis } from '../core/diagnose.js'
import { defaultIo, dim, err, heading, ok, warn, type CliIo } from './ui.js'

// Renders a diagnosis to the terminal. Shared by `looprail why` and by the
// end of a `run` that halted, so both read identically.
export function renderDiagnosis(io: CliIo, d: Diagnosis, verified: boolean): void {
  io.out(verified ? ok(d.headline) : warn(d.headline))
  if (d.cause) io.out(`  ${d.cause}`)
  if (d.nextSteps.length > 0) {
    io.out(dim('  what to do:'))
    for (const s of d.nextSteps) io.out(`    - ${s}`)
  }
}

export function whyAction(
  runId: string | undefined,
  opts: { cwd: string; json?: boolean },
  deps: { io?: CliIo } = {},
): number {
  const io = deps.io ?? defaultIo
  const id = runId ?? latestRunId(opts.cwd)
  if (!id) {
    io.out(err(`no runs found under ${runsRoot(opts.cwd)} - start one with \`looprail run\``))
    return 1
  }
  const journalPath = join(runsRoot(opts.cwd), id, 'journal.jsonl')
  if (!existsSync(journalPath)) {
    io.out(err(`no run "${id}" found`))
    return 1
  }
  const events = readJournal(journalPath)
  const facts = factsFromJournal(events)
  if (!facts) {
    io.out(warn(`run "${id}" has no terminal outcome yet - it may still be running. Try \`looprail status ${id}\`.`))
    return 0
  }
  const diagnosis = diagnoseRun(facts, events)
  if (opts.json) {
    io.out(JSON.stringify({ runId: id, status: facts.status, ...diagnosis }))
    return 0
  }
  io.out(heading(`why ${id}`))
  renderDiagnosis(io, diagnosis, facts.status === 'verified')
  return 0
}

export function registerWhy(program: Command): void {
  program
    .command('why [runId]')
    .description('explain in plain terms why a run ended the way it did, and what to do next (defaults to the latest run)')
    .option('--json', 'machine-readable diagnosis')
    .action((runId: string | undefined, opts: { json?: boolean }, cmd: Command) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = whyAction(runId, { cwd, json: opts.json })
    })
}
