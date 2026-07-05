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
  // Pricing-derived estimate (RailsGuard.estimatedSpentUsd via the
  // node_end/iteration_end/halt/verified journal events), separate from
  // costUsd - see core/rails.ts and core/types.ts NodeOutcome for why the
  // two must never be merged.
  estimatedCostUsd: number
  verdicts: { iteration: number; nodeId: string; status: string; evidence: string }[]
}

export function summarizeJournal(events: JournalEvent[]): RunSummary {
  const s: RunSummary = {
    runId: 'unknown', name: '', status: 'running',
    iterations: 0, costUsd: 0, estimatedCostUsd: 0, verdicts: [],
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
      s.estimatedCostUsd = Number(d.estimatedCostUsd ?? s.estimatedCostUsd)
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
      s.estimatedCostUsd = Number(d.estimatedCostUsd ?? s.estimatedCostUsd)
    }
  }
  return s
}

export interface ReconstructedState {
  plan: string | null
  feedback: string | null
}

// Resuming a halted run in place (resume-cmd.ts) starts a fresh in-memory
// RunState in a new process - without this, it would silently drop the plan
// the planner already produced and the critic's evidence for exactly why
// the run halted, both of which belong in the next iteration's prompt
// (see core/context.ts). Reconstructing state.feedback also matters for a
// second, less obvious reason: with it blank, the resumed iteration's
// prompt would be byte-identical to the halted run's own last iteration,
// so the cache (which keys on that exact prompt) would silently replay the
// same stale failing verdict for free instead of giving the executor a
// genuinely fresh attempt.
export function reconstructRunState(events: JournalEvent[]): ReconstructedState {
  let plan: string | null = null
  let lastIteration = 0
  const verdictsByIteration = new Map<number, { nodeId: string; evidence: string; status: string }[]>()
  for (const e of events) {
    const d = e.data as Record<string, unknown>
    if (e.type === 'node_end' && d.role === 'planner') {
      plan = String(d.output ?? '')
    }
    if (e.type === 'iteration_end') {
      lastIteration = Number(d.iteration ?? lastIteration)
    }
    if (e.type === 'node_end' && d.verdict) {
      const v = d.verdict as { status: string; evidence: string }
      const iteration = Number(d.iteration ?? 0)
      const list = verdictsByIteration.get(iteration) ?? []
      list.push({ nodeId: String(d.nodeId), evidence: v.evidence, status: v.status })
      verdictsByIteration.set(iteration, list)
    }
  }
  // mirrors core/router.ts's composeFeedback exactly, so the reconstructed
  // prompt matches what the original process would have built for this
  // same next iteration had it not halted
  const failing = (verdictsByIteration.get(lastIteration) ?? []).filter((v) => v.status !== 'pass')
  const feedback = failing.length > 0
    ? failing.map((v) => `[${v.nodeId}] ${v.evidence}`).join('\n')
    : null
  return { plan, feedback }
}
