import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'commander'
import { readJournal } from '../journal/journal.js'
import { defaultIo, dim, heading, ok, renderTable, type CliIo } from './ui.js'

// `looprail spend` - what looprail itself has spent, per provider and model,
// aggregated from every run's own journal (real, adapter-reported cost kept
// separate from pricing-derived estimates, same discipline as everywhere
// else in this codebase). Deliberately NOT built by scraping other CLIs'
// local session logs: those are global to the machine, so a user's parallel
// interactive sessions would be mis-attributed to looprail - a spend report
// that can silently include someone else's usage is worse than none. The
// journals record exactly what looprail invoked, and nothing else.

export interface SpendRow {
  adapter: string
  model: string
  invocations: number
  costUsd: number
  estimatedCostUsd: number
  tokens: number
}

export interface SpendReport {
  sinceDays: number
  runs: number
  rows: SpendRow[]
  totalCostUsd: number
  totalEstimatedCostUsd: number
}

export function aggregateSpend(runsDir: string, sinceDays: number, now: () => number = Date.now): SpendReport {
  const cutoff = now() - sinceDays * 24 * 60 * 60 * 1000
  const byKey = new Map<string, SpendRow>()
  let runs = 0
  if (!existsSync(runsDir)) {
    return { sinceDays, runs: 0, rows: [], totalCostUsd: 0, totalEstimatedCostUsd: 0 }
  }
  for (const wsHash of readdirSync(runsDir)) {
    const wsDir = join(runsDir, wsHash)
    let runIds: string[]
    try {
      runIds = readdirSync(wsDir)
    } catch {
      continue // a stray file at the workspace level, not a directory of runs
    }
    for (const runId of runIds) {
      const journalPath = join(wsDir, runId, 'journal.jsonl')
      if (!existsSync(journalPath)) continue
      let counted = false
      for (const e of readJournal(journalPath)) {
        if (e.type !== 'node_end' || e.ts < cutoff) continue
        const d = e.data as { adapter?: string; model?: string; costUsd?: number; estimatedCostUsd?: number; tokens?: number }
        // agent-backed nodes only - a tester has no adapter and no spend
        if (!d.adapter) continue
        counted = true
        const key = `${d.adapter}\0${d.model ?? '(default)'}`
        const row = byKey.get(key) ?? {
          adapter: d.adapter, model: d.model ?? '(default)',
          invocations: 0, costUsd: 0, estimatedCostUsd: 0, tokens: 0,
        }
        row.invocations += 1
        row.costUsd += d.costUsd ?? 0
        row.estimatedCostUsd += d.estimatedCostUsd ?? 0
        row.tokens += d.tokens ?? 0
        byKey.set(key, row)
      }
      if (counted) runs += 1
    }
  }
  const rows = [...byKey.values()].sort((a, b) => (b.costUsd + b.estimatedCostUsd) - (a.costUsd + a.estimatedCostUsd))
  return {
    sinceDays, runs, rows,
    totalCostUsd: rows.reduce((s, r) => s + r.costUsd, 0),
    totalEstimatedCostUsd: rows.reduce((s, r) => s + r.estimatedCostUsd, 0),
  }
}

export function spendAction(
  opts: { days?: number; json?: boolean } = {},
  deps: { io?: CliIo; runsDir?: string; now?: () => number } = {},
): number {
  const io = deps.io ?? defaultIo
  const report = aggregateSpend(
    deps.runsDir ?? join(homedir(), '.looprail', 'runs'),
    opts.days ?? 30,
    deps.now,
  )
  if (opts.json) {
    io.out(JSON.stringify(report, null, 2))
    return 0
  }
  io.out(heading(`looprail spend - last ${report.sinceDays} day(s), ${report.runs} run(s)`))
  if (report.rows.length === 0) {
    io.out(dim('  no agent spend recorded in this window'))
    return 0
  }
  io.out(renderTable(
    ['adapter', 'model', 'calls', 'real $', 'est $', 'tokens'],
    report.rows.map((r) => [
      r.adapter, r.model, String(r.invocations),
      r.costUsd > 0 ? `$${r.costUsd.toFixed(2)}` : '-',
      r.estimatedCostUsd > 0 ? `~$${r.estimatedCostUsd.toFixed(2)}` : '-',
      String(r.tokens),
    ]),
  ))
  io.out(ok(`  total: $${report.totalCostUsd.toFixed(2)} real` +
    (report.totalEstimatedCostUsd > 0 ? ` + ~$${report.totalEstimatedCostUsd.toFixed(2)} estimated` : '')))
  io.out(dim('  real = the CLI reported dollars itself; est = priced from its token counts. Only looprail\'s own runs are counted - never your other sessions.'))
  return 0
}

export function registerSpend(program: Command): void {
  program
    .command('spend')
    .description('per-provider/model spend across every looprail run, from the journals')
    .option('--days <n>', 'aggregation window in days (default 30)', (v) => Number(v))
    .option('--json', 'machine-readable report')
    .action((opts: { days?: number; json?: boolean }) => {
      process.exitCode = spendAction(opts)
    })
}
