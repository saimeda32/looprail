import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expandPanels, parseLoopfile, validateGraph, type JournalEvent, type LoopDef } from '../index.js'
import { readGateWaitingMarker } from '../journal/gate-files.js'
import { readJournal } from '../journal/journal.js'
import { runsRoot, workspaceHash } from '../journal/runs.js'
import { buildViewModel } from '../dashboard/view-model.js'

// Same pid-liveness probe the dashboard's controlState uses (see
// src/dashboard/server.ts): a gate-waiting marker only begs for attention
// while the process that wrote it is actually alive.
function runProcessAlive(runDir: string): boolean {
  try {
    const pid = Number(readFileSync(join(runDir, 'pid'), 'utf8').trim())
    if (!Number.isInteger(pid)) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Deliberately duplicated in miniature from loadExpandedLoopDef
// (src/cli/ui-cmd.ts) rather than imported - see design decision 5. Both
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

// Re-exported so existing call sites (mission-control-server.ts, tests) do
// not need an import path change - both now come from journal/runs.ts,
// the single place that decides where run history actually lives.
export { runsRoot as runsRootOf, workspaceHash }

export interface RunListEntry {
  workspace: string
  workspaceName: string
  workspaceHash: string
  runId: string
  name: string
  goal: string
  // 'parked' (gate timeout awaiting a human - resumable pause, NOT a
  // failure) flows through from the view-model; 'stale' is derived HERE:
  // a journal that says running whose process is dead (killed without a
  // terminal event) - the card previously showed it as running forever,
  // red wall-time climbing (docs/UX-AUDIT-2026-07.md, MC-3).
  status: 'running' | 'verified' | 'halted' | 'canceled' | 'parked' | 'stale'
  // A LIVE run blocked on a human answer right now (gate-waiting marker
  // present and the run's process actually alive - a marker left by a
  // dead process must not beg for attention).
  awaitingGate: boolean
  // Only ever set for 'halted'/'canceled' (buildViewModel only populates its
  // own reason on those two statuses) - lets mission control's run tiles
  // show WHY a run stopped without opening it, reusing the exact string the
  // engine already wrote rather than re-deriving or re-wording it here.
  reason?: string
  agents: string[]
  iteration: number
  costUsd: number
  // Adapters that can't report a real dollar figure (copilot-cli, codex,
  // aider) still derive one from token counts - see
  // adapters/default-registry.ts and view-model.ts's DashboardTotals. Carried
  // through verbatim (never merged into costUsd) so mission control's run
  // tiles can fall back to it instead of showing a misleading flat "$0.00"
  // for a run that plainly spent real tokens.
  estimatedCostUsd: number
  tokens: number
  startedAt?: number
  lastEventAt?: number
  // The loopfile's own rails.maxWallMinutes, carried through verbatim so
  // mission control's run tiles (and their aggregate strip) can show elapsed
  // wall time against the run's actual wall budget rather than in a vacuum.
  // Undefined when there's no loopfile (def undefined) or the loopfile sets
  // no wall rail at all - both cases mean "nothing to be proportional
  // against", same spirit as costUsd having no max when maxCostUsd is unset.
  maxWallMinutes?: number
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
    name: model.name,
    goal: model.goal,
    status: model.status === 'running' && !runProcessAlive(dirname(journalPath))
      ? 'stale'
      : model.status,
    reason: model.reason,
    awaitingGate: model.status === 'running'
      && readGateWaitingMarker(dirname(journalPath)) !== undefined
      && runProcessAlive(dirname(journalPath)),
    agents: agentsInUse(def, events),
    iteration: model.totals.iteration,
    costUsd: model.totals.costUsd,
    estimatedCostUsd: model.totals.estimatedCostUsd,
    tokens: model.totals.tokens,
    startedAt: events[0]?.ts,
    lastEventAt: events.at(-1)?.ts,
    maxWallMinutes: def?.rails.maxWallMinutes,
    journalPath,
  }
}

// Impure: the one function in this file that scans the filesystem beyond a
// single journal read. On-demand only - called once per `ui --all`
// request/poll tick, never on a timer of its own (see Global Constraints:
// no daemon).
//
// Two nested guards, each doing a distinct job. The outer try/catch handles a
// registered workspace going bad in ways outside our control between
// registration and scan time (the workspace deleted, its runs root replaced by
// a file, a permissions error on readdirSync); any of those is a synchronous
// throw, and one bad workspace must never zero out or crash the scan for every
// OTHER registered workspace. The inner try/catch does the same at run
// granularity: a single run's journal going bad (its journal.jsonl replaced by
// a directory, truncated, or a TOCTOU race between readdirSync and the read)
// must skip only that run, not blank out every OTHER healthy run in the same
// workspace.
export function discoverRuns(workspaces: string[]): RunListEntry[] {
  const entries: RunListEntry[] = []
  for (const workspace of workspaces) {
    try {
      const root = runsRoot(workspace)
      if (!existsSync(root)) continue
      const def = bestEffortLoopDef(workspace)
      for (const runId of readdirSync(root)) {
        try {
          const journalPath = join(root, runId, 'journal.jsonl')
          if (!existsSync(journalPath)) continue
          const events = readJournal(journalPath)
          entries.push(buildRunListEntry(workspace, runId, journalPath, events, def))
        } catch (err) {
          console.error(`discoverRuns: skipping unreadable run ${runId} in ${workspace}`, err)
        }
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
// only ever lists filenames and reads their mtime - the .jsonl transcript
// content is never opened or parsed. See design constraints: homedir and
// "now" are both injectable so tests never touch the real $HOME, and a
// missing ~/.claude/projects/<slug> directory degrades to an empty result
// rather than throwing.

export interface SessionEntry {
  workspace: string
  workspaceName: string
  sessionId: string
  lastActiveAt: number
  // Which agent CLI the session belongs to - looprail is vendor-neutral,
  // and "recent agent activity" that only ever saw one vendor's sessions
  // (the original claude-code-only scan) undersold every mixed setup.
  tool: 'claude-code' | 'copilot-cli' | 'codex' | 'aider'
  // Best-effort resume hint ("claude --resume <id>") the card offers for
  // copying - empty when the tool has no known session-resume command.
  resumeCommand?: string
}

// Best-effort match of Claude Code's own project-directory naming scheme,
// which is not publicly documented. Claude Code stores each project's
// session transcripts under ~/.claude/projects/<slug>, where <slug> is
// derived from the absolute workspace path. The one verified-real example
// on this machine: `/Users/skiranmeda/sai-git/looprail` produces the
// directory `-Users-skiranmeda-sai-git-looprail` (confirmed live, not
// inferred). That example only exercises `/`, so this broadens the
// replacement to the full non-alphanumeric character class as the most
// defensible guess at Claude Code's actual scheme - it's still only a
// guess for characters this machine has never produced (e.g. a literal
// `.` in a path), and it does NOT eliminate collisions: `/a/b-c` and
// `/a/b/c` both slug to `-a-b-c` either way, because both `/` and `-` map
// to the same replacement character. That is a real, currently
// unavoidable limitation - fixing it with workspace-side disambiguation
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
        try {
          if (!file.endsWith('.jsonl')) continue
          const mtimeMs = statSync(join(projectDir, file)).mtimeMs
          if (mtimeMs < cutoff) continue
          const sessionId = file.slice(0, -'.jsonl'.length)
          entries.push({
            workspace,
            workspaceName: basename(workspace),
            sessionId,
            lastActiveAt: mtimeMs,
            tool: 'claude-code',
            resumeCommand: `claude --resume ${sessionId}`,
          })
        } catch (err) {
          // A single file's statSync throwing (e.g. a TOCTOU deletion between
          // readdirSync and statSync) must skip only that entry, not blank out
          // every other session in this workspace.
          console.error(`discoverClaudeCodeSessions: skipping unreadable session ${file} in ${workspace}`, err)
        }
      }
    } catch (err) {
      console.error(`discoverClaudeCodeSessions: skipping unreadable workspace ${workspace}`, err)
    }
  }
  return entries.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

// Copilot CLI keeps one directory per session under
// ~/.copilot/session-state/<uuid>/, with a workspace.yaml carrying `id:`
// and `cwd:` lines and an events.jsonl whose mtime tracks activity
// (verified live on this machine, not inferred). Only sessions whose cwd
// falls inside a registered workspace are surfaced - same privacy posture
// as the Claude scan: filenames, two yaml header lines, and mtimes; never
// transcript content.
export function discoverCopilotSessions(
  workspaces: string[],
  opts?: { homedir?: string, now?: () => number, recencyMs?: number },
): SessionEntry[] {
  const homedir = opts?.homedir ?? osHomedir()
  const now = (opts?.now ?? Date.now)()
  const cutoff = now - (opts?.recencyMs ?? 15 * 60 * 1000)
  const root = join(homedir, '.copilot', 'session-state')
  const entries: SessionEntry[] = []
  const workspaceOf = (cwd: string): string | undefined =>
    workspaces.find((w) => cwd === w || cwd.startsWith(w.endsWith('/') ? w : w + '/'))
  try {
    if (!existsSync(root)) return []
    for (const dir of readdirSync(root)) {
      try {
        const yamlPath = join(root, dir, 'workspace.yaml')
        if (!existsSync(yamlPath)) continue
        // two header lines only - never the goal/name content below them
        const head = readFileSync(yamlPath, 'utf8').slice(0, 2048)
        const cwd = /^cwd:\s*(.+)$/m.exec(head)?.[1]?.trim()
        if (!cwd) continue
        const workspace = workspaceOf(cwd)
        if (!workspace) continue
        const eventsPath = join(root, dir, 'events.jsonl')
        const mtimeMs = statSync(existsSync(eventsPath) ? eventsPath : join(root, dir)).mtimeMs
        if (mtimeMs < cutoff) continue
        entries.push({
          workspace,
          workspaceName: basename(workspace),
          sessionId: dir,
          lastActiveAt: mtimeMs,
          tool: 'copilot-cli',
          resumeCommand: `copilot --resume ${dir}`,
        })
      } catch (err) {
        console.error(`discoverCopilotSessions: skipping unreadable session ${dir}`, err)
      }
    }
  } catch (err) {
    console.error('discoverCopilotSessions: skipping unreadable session store', err)
  }
  return entries.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

// Codex stores rollout files under ~/.codex/sessions/YYYY/MM/DD/
// rollout-<ts>-<id>.jsonl, whose first line's session_meta carries the cwd.
// Only the first 4KB is read to find it - transcript content stays unread.
export function discoverCodexSessions(
  workspaces: string[],
  opts?: { homedir?: string, now?: () => number, recencyMs?: number },
): SessionEntry[] {
  const homedir = opts?.homedir ?? osHomedir()
  const now = (opts?.now ?? Date.now)()
  const cutoff = now - (opts?.recencyMs ?? 15 * 60 * 1000)
  const root = join(homedir, '.codex', 'sessions')
  const entries: SessionEntry[] = []
  const workspaceOf = (cwd: string): string | undefined =>
    workspaces.find((w) => cwd === w || cwd.startsWith(w.endsWith('/') ? w : w + '/'))
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) { walk(p, depth + 1); continue }
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
        if (st.mtimeMs < cutoff) continue
        const head = readFileSync(p, 'utf8').slice(0, 4096)
        const cwd = /"cwd"\s*:\s*"([^"]+)"/.exec(head)?.[1]
        if (!cwd) continue
        const workspace = workspaceOf(cwd)
        if (!workspace) continue
        const sessionId = name.slice('rollout-'.length, -'.jsonl'.length)
        entries.push({
          workspace,
          workspaceName: basename(workspace),
          sessionId,
          lastActiveAt: st.mtimeMs,
          tool: 'codex',
          resumeCommand: 'codex resume --last',
        })
      } catch (err) {
        console.error(`discoverCodexSessions: skipping unreadable entry ${p}`, err)
      }
    }
  }
  try {
    if (existsSync(root)) walk(root, 0)
  } catch (err) {
    console.error('discoverCodexSessions: skipping unreadable session store', err)
  }
  return entries.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

// Aider has no session store - it keeps one rolling .aider.chat.history.md
// per repo, IN the repo. Its mtime is the whole signal.
export function discoverAiderSessions(
  workspaces: string[],
  opts?: { now?: () => number, recencyMs?: number },
): SessionEntry[] {
  const now = (opts?.now ?? Date.now)()
  const cutoff = now - (opts?.recencyMs ?? 15 * 60 * 1000)
  const entries: SessionEntry[] = []
  for (const workspace of workspaces) {
    try {
      const historyPath = join(workspace, '.aider.chat.history.md')
      if (!existsSync(historyPath)) continue
      const mtimeMs = statSync(historyPath).mtimeMs
      if (mtimeMs < cutoff) continue
      entries.push({
        workspace,
        workspaceName: basename(workspace),
        sessionId: 'aider',
        lastActiveAt: mtimeMs,
        tool: 'aider',
        resumeCommand: 'aider --restore-chat-history',
      })
    } catch (err) {
      console.error(`discoverAiderSessions: skipping unreadable workspace ${workspace}`, err)
    }
  }
  return entries.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

// The one aggregator mission control calls: every supported agent CLI's
// sessions, newest first.
export function discoverAgentSessions(
  workspaces: string[],
  opts?: { homedir?: string, now?: () => number, recencyMs?: number },
): SessionEntry[] {
  return [
    ...discoverClaudeCodeSessions(workspaces, opts),
    ...discoverCopilotSessions(workspaces, opts),
    ...discoverCodexSessions(workspaces, opts),
    ...discoverAiderSessions(workspaces, opts),
  ].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}
