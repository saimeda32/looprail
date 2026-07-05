import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from 'commander'
import { readJournal } from '../index.js'
import { latestRunId, runsRoot, summarizeJournal, type RunSummary } from '../journal/runs.js'
import { defaultIo, dim, err, heading, ok, warn, type CliIo } from './ui.js'

// Re-exported for backward compatibility - every existing import of these
// three names from './status-cmd.js' (this file's own test file included)
// keeps working unmodified. Real implementations now live in
// src/journal/runs.ts so src/mcp/'s run_status/list_runs tools can reuse
// them without importing anything under src/cli/ (see Global Constraints).
export { latestRunId, runsRoot, summarizeJournal, type RunSummary }

export function renderSummary(s: RunSummary): string[] {
  const statusLine = s.status === 'verified' ? ok('verified')
    : s.status === 'halted' ? err('halted') : warn('running')
  const lines = [
    heading(`${s.runId} - ${s.name}`),
    `status: ${statusLine}${s.reason ? ` (${s.reason})` : ''} · iterations: ${s.iterations} · cost: $${s.costUsd.toFixed(2)}`,
  ]
  for (const v of s.verdicts) {
    const mark = v.status === 'pass' ? ok('pass') : err(v.status)
    lines.push(`  iter ${v.iteration} · ${v.nodeId}: ${mark} - ${v.evidence}`)
  }
  return lines
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function statusAction(
  runId: string | undefined,
  opts: { cwd: string; watch?: boolean; intervalMs?: number },
  io: CliIo = defaultIo,
): Promise<number> {
  const id = runId ?? latestRunId(opts.cwd)
  if (!id) {
    io.out(err(`no runs found under ${runsRoot(opts.cwd)} - start one with \`looprail run\``))
    return 1
  }
  const journalPath = join(runsRoot(opts.cwd), id, 'journal.jsonl')
  if (!existsSync(journalPath)) {
    io.out(err(`no journal for run "${id}"`))
    return 1
  }
  // pure reader: status never writes to the run directory
  for (;;) {
    const summary = summarizeJournal(readJournal(journalPath))
    for (const line of renderSummary(summary)) io.out(line)
    if (!opts.watch || summary.status !== 'running') return 0
    await sleep(opts.intervalMs ?? 1000)
    io.out(dim('-'.repeat(40)))
  }
}

export async function logsAction(
  runId: string | undefined,
  node: string | undefined,
  opts: { cwd: string },
  io: CliIo = defaultIo,
): Promise<number> {
  const id = runId ?? latestRunId(opts.cwd)
  if (!id) {
    io.out(err(`no runs found under ${runsRoot(opts.cwd)}`))
    return 1
  }
  const journalPath = join(runsRoot(opts.cwd), id, 'journal.jsonl')
  if (!existsSync(journalPath)) {
    io.out(err(`no journal for run "${id}"`))
    return 1
  }
  for (const e of readJournal(journalPath)) {
    if (e.type !== 'node_end') continue
    const d = e.data as Record<string, unknown>
    const nodeId = String(d.nodeId)
    if (node && nodeId.split('@')[0] !== node) continue
    io.out(heading(`── ${nodeId} (iter ${String(d.iteration ?? '?')}, ${String(d.role)}) ──`))
    io.out(String(d.output ?? ''))
  }
  return 0
}

export function registerStatus(program: Command): void {
  program
    .command('status [runId]')
    .description('show a run report from its journal (latest run by default)')
    .option('--watch', 'poll the journal until the run finishes')
    .action(async (runId: string | undefined, opts: { watch?: boolean }, cmd: Command) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = await statusAction(runId, { cwd, watch: opts.watch })
    })
}

export function registerLogs(program: Command): void {
  program
    .command('logs [runId] [node]')
    .description('print node outputs from a run journal (optionally one node)')
    .action(async (runId: string | undefined, node: string | undefined, _o: unknown, cmd: Command) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = await logsAction(runId, node, { cwd })
    })
}
