import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { JournalEvent } from '../core/types.js'

export function runsRoot(cwd: string): string {
  return join(cwd, '.looprail', 'runs')
}

export function listRunIds(cwd: string): string[] {
  const root = runsRoot(cwd)
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => existsSync(join(root, name, 'journal.jsonl')))
    .map((name) => ({ name, mtime: statSync(join(root, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((r) => r.name)
}

export function latestRunId(cwd: string): string | null {
  return listRunIds(cwd)[0] ?? null
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
