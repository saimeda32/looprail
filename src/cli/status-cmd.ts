import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from 'commander'
import { readJournal, type JournalEvent } from '../index.js'
import { defaultIo, dim, err, heading, ok, warn, type CliIo } from './ui.js'

export function runsRoot(cwd: string): string {
  return join(cwd, '.looprail', 'runs')
}

export function latestRunId(cwd: string): string | null {
  const root = runsRoot(cwd)
  if (!existsSync(root)) return null
  const runs = readdirSync(root)
    .filter((name) => existsSync(join(root, name, 'journal.jsonl')))
    .map((name) => ({ name, mtime: statSync(join(root, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return runs[0]?.name ?? null
}

export interface RunSummary {
  runId: string
  name: string
  status: 'running' | 'verified' | 'halted'
  reason?: string
  iterations: number
  costUsd: number
  verdicts: { iteration: number; nodeId: string; status: string; evidence: string }[]
}

export function summarizeJournal(events: JournalEvent[]): RunSummary {
  const s: RunSummary = {
    runId: 'unknown', name: '', status: 'running',
    iterations: 0, costUsd: 0, verdicts: [],
  }
  for (const e of events) {
    const d = e.data as Record<string, unknown>
    if (e.type === 'run_start') {
      s.runId = String(d.runId)
      s.name = String(d.name)
    }
    if (e.type === 'iteration_end') {
      s.iterations = Number(d.iteration)
      s.costUsd = Number(d.costUsd)
    }
    if (e.type === 'node_end' && d.verdict) {
      const v = d.verdict as { status: string; evidence: string }
      s.verdicts.push({
        iteration: Number(d.iteration ?? 0),
        nodeId: String(d.nodeId),
        status: v.status,
        evidence: v.evidence,
      })
    }
    if (e.type === 'verified' || e.type === 'halt') {
      s.status = e.type === 'verified' ? 'verified' : 'halted'
      s.reason = String(d.reason)
      s.costUsd = Number(d.costUsd)
    }
  }
  return s
}

export function renderSummary(s: RunSummary): string[] {
  const statusLine = s.status === 'verified' ? ok('verified')
    : s.status === 'halted' ? err('halted') : warn('running')
  const lines = [
    heading(`${s.runId} — ${s.name}`),
    `status: ${statusLine}${s.reason ? ` (${s.reason})` : ''} · iterations: ${s.iterations} · cost: $${s.costUsd.toFixed(2)}`,
  ]
  for (const v of s.verdicts) {
    const mark = v.status === 'pass' ? ok('pass') : err(v.status)
    lines.push(`  iter ${v.iteration} · ${v.nodeId}: ${mark} — ${v.evidence}`)
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
    io.out(err(`no runs found under ${runsRoot(opts.cwd)} — start one with \`looprail run\``))
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
    io.out(dim('—'.repeat(40)))
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
