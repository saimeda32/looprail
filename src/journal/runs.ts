import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { JournalEvent } from '../core/types.js'

// Run history lives under the real home directory, not inside the project -
// the same choice Claude Code makes for ~/.claude/projects/<slug>/. History
// survives a deleted or moved project directory, and mission control can
// read it centrally instead of depending on every registered workspace's
// own .looprail/runs/ still being on disk. Each workspace gets its own
// subdirectory keyed by a hash of its resolved path (see workspaceHash) so
// two projects never collide and a project's runs are still trivially
// groupable without storing anything workspace-identifying in the path.
export function workspaceHash(workspace: string): string {
  return createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 12)
}

export function runsRoot(cwd: string): string {
  return join(homedir(), '.looprail', 'runs', workspaceHash(cwd))
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
