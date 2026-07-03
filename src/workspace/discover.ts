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
//
// Each workspace's work is wrapped in its own try/catch: a registered
// workspace can go bad in ways outside our control between registration and
// scan time (its journal file replaced by a directory, the workspace
// deleted, a permissions error, a TOCTOU race between readdirSync and the
// read) and any of those is a synchronous throw. One bad workspace must
// never zero out or crash the scan for every OTHER registered workspace, so
// we skip and log rather than let it propagate.
export function discoverRuns(workspaces: string[]): RunListEntry[] {
  const entries: RunListEntry[] = []
  for (const workspace of workspaces) {
    try {
      const root = runsRootOf(workspace)
      if (!existsSync(root)) continue
      const def = bestEffortLoopDef(workspace)
      for (const runId of readdirSync(root)) {
        const journalPath = join(root, runId, 'journal.jsonl')
        if (!existsSync(journalPath)) continue
        const events = readJournal(journalPath)
        entries.push(buildRunListEntry(workspace, runId, journalPath, events, def))
      }
    } catch (err) {
      console.error(`discoverRuns: skipping unreadable workspace ${workspace}`, err)
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

// Best-effort match of Claude Code's own project-directory naming scheme,
// which is not publicly documented. Claude Code stores each project's
// session transcripts under ~/.claude/projects/<slug>, where <slug> is
// derived from the absolute workspace path. The one verified-real example
// on this machine: `/Users/skiranmeda/sai-git/looprail` produces the
// directory `-Users-skiranmeda-sai-git-looprail` (confirmed live, not
// inferred). That example only exercises `/`, so this broadens the
// replacement to the full non-alphanumeric character class as the most
// defensible guess at Claude Code's actual scheme — it's still only a
// guess for characters this machine has never produced (e.g. a literal
// `.` in a path), and it does NOT eliminate collisions: `/a/b-c` and
// `/a/b/c` both slug to `-a-b-c` either way, because both `/` and `-` map
// to the same replacement character. That is a real, currently
// unavoidable limitation — fixing it with workspace-side disambiguation
// (e.g. a hash suffix) would break matching against Claude Code's real
// directories entirely, which defeats the purpose of this function, so it
// is intentionally not attempted here.
export function claudeCodeProjectSlug(workspace: string): string {
  return workspace.replace(/[^a-zA-Z0-9]/g, '-')
}

// Each workspace's work is wrapped in its own try/catch for the same reason
// as discoverRuns above: a bad workspace (unreadable projects dir,
// permissions error, a path that turns out not to be a directory) must be
// skipped and logged, not allowed to crash or blank out every OTHER
// registered workspace's session data.
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
    try {
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
    } catch (err) {
      console.error(`discoverClaudeCodeSessions: skipping unreadable workspace ${workspace}`, err)
    }
  }
  return entries.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}
