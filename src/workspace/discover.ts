import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { expandPanels, parseLoopfile, validateGraph, type JournalEvent, type LoopDef } from '../index.js'
import { readJournal } from '../journal/journal.js'
import { buildViewModel } from '../dashboard/view-model.js'

// Deliberately duplicated in miniature from loadExpandedLoopDef
// (src/cli/ui-cmd.ts) rather than imported — see design decision 5. Both
// copies do exactly parseLoopfile -> validateGraph -> expandPanels ->
// validateGraph, best-effort; neither is likely to change independently of
// the other, since both encode the same fixed, already-reviewed pipeline.
function bestEffortLoopDef(workspace: string): LoopDef | undefined {
  try {
    const path = resolve(workspace, 'looprail.yaml')
    if (!existsSync(path)) return undefined
    const def = parseLoopfile(readFileSync(path, 'utf8'))
    if (validateGraph(def).length > 0) return undefined
    const expanded = expandPanels(def)
    return validateGraph(expanded).length > 0 ? undefined : expanded
  } catch {
    return undefined
  }
}

function agentsInUse(def: LoopDef | undefined, events: JournalEvent[]): string[] {
  if (!def) return []
  const seen = new Set<string>()
  for (const e of events) {
    if (e.type !== 'node_start' && e.type !== 'node_end') continue
    const nodeId = String((e.data as Record<string, unknown>).nodeId ?? '')
    const node = def.nodes.find((n) => n.id === nodeId)
    if (node?.agent) seen.add(node.agent)
  }
  return [...seen]
}

export function workspaceHash(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex').slice(0, 12)
}

// A one-line, deliberate duplicate of status-cmd.ts's runsRoot(cwd) — see
// design decision 5 for why this file never imports from src/cli/.
export function runsRootOf(workspace: string): string {
  return join(workspace, '.looprail', 'runs')
}

export interface RunListEntry {
  workspace: string
  workspaceName: string
  workspaceHash: string
  runId: string
  status: 'running' | 'verified' | 'halted'
  agents: string[]
  iteration: number
  costUsd: number
  startedAt?: number
  lastEventAt?: number
  journalPath: string
}

// Pure: reuses buildViewModel (src/dashboard/view-model.ts) for
// status/iteration/cost so this file never re-derives node-status or
// verdict-aggregation rules a second time.
export function buildRunListEntry(
  workspace: string, runId: string, journalPath: string, events: JournalEvent[], def?: LoopDef,
): RunListEntry {
  const model = buildViewModel(events)
  return {
    workspace,
    workspaceName: basename(workspace),
    workspaceHash: workspaceHash(workspace),
    runId,
    status: model.status,
    agents: agentsInUse(def, events),
    iteration: model.totals.iteration,
    costUsd: model.totals.costUsd,
    startedAt: events[0]?.ts,
    lastEventAt: events.at(-1)?.ts,
    journalPath,
  }
}

// Impure: the one function in this file that scans the filesystem beyond a
// single journal read. On-demand only — called once per `ui --all`
// request/poll tick, never on a timer of its own (see Global Constraints:
// no daemon).
export function discoverRuns(workspaces: string[]): RunListEntry[] {
  const entries: RunListEntry[] = []
  for (const workspace of workspaces) {
    const root = runsRootOf(workspace)
    if (!existsSync(root)) continue
    const def = bestEffortLoopDef(workspace)
    for (const runId of readdirSync(root)) {
      const journalPath = join(root, runId, 'journal.jsonl')
      if (!existsSync(journalPath)) continue
      const events = readJournal(journalPath)
      entries.push(buildRunListEntry(workspace, runId, journalPath, events, def))
    }
  }
  return entries.sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0))
}

// --- Claude Code raw-session presence detection ---
//
// Detects ACTIVE Claude Code sessions (not looprail runs) in registered
// workspaces, so mission control can show "a raw Claude Code session is
// active here" as a visually distinct entry. Privacy-motivated design: this
// only ever lists filenames and reads their mtime — the .jsonl transcript
// content is never opened or parsed. See design constraints: homedir and
// "now" are both injectable so tests never touch the real $HOME, and a
// missing ~/.claude/projects/<slug> directory degrades to an empty result
// rather than throwing.

export interface SessionEntry {
  workspace: string
  workspaceName: string
  sessionId: string
  lastActiveAt: number
}

export function claudeCodeProjectSlug(workspace: string): string {
  return workspace.split('/').join('-')
}

export function discoverClaudeCodeSessions(
  workspaces: string[],
  opts?: { homedir?: string, now?: () => number, recencyMs?: number },
): SessionEntry[] {
  const homedir = opts?.homedir ?? osHomedir()
  const now = (opts?.now ?? Date.now)()
  const recencyMs = opts?.recencyMs ?? 15 * 60 * 1000
  const cutoff = now - recencyMs

  const entries: SessionEntry[] = []
  for (const workspace of workspaces) {
    const projectDir = join(homedir, '.claude', 'projects', claudeCodeProjectSlug(workspace))
    if (!existsSync(projectDir)) continue
    for (const file of readdirSync(projectDir)) {
      if (!file.endsWith('.jsonl')) continue
      const mtimeMs = statSync(join(projectDir, file)).mtimeMs
      if (mtimeMs < cutoff) continue
      entries.push({
        workspace,
        workspaceName: basename(workspace),
        sessionId: file.slice(0, -'.jsonl'.length),
        lastActiveAt: mtimeMs,
      })
    }
  }
  return entries.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}
