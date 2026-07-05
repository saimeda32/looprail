import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { JournalEvent } from '../core/types.js'
import { runsRoot } from '../journal/runs.js'
import {
  buildRunListEntry,
  claudeCodeProjectSlug,
  discoverClaudeCodeSessions,
  discoverRuns,
  workspaceHash,
} from './discover.js'

function ev(type: JournalEvent['type'], data: Record<string, unknown>, ts = 0): JournalEvent {
  return { ts, type, data }
}

test('workspaceHash is a stable, short, deterministic token for a given path', () => {
  expect(workspaceHash('/a/b')).toBe(workspaceHash('/a/b'))
  expect(workspaceHash('/a/b')).not.toBe(workspaceHash('/a/c'))
  expect(workspaceHash('/a/b')).toMatch(/^[a-f0-9]{12}$/)
})

test('buildRunListEntry derives status/iteration/cost from buildViewModel, not its own rules', () => {
  const events: JournalEvent[] = [
    ev('run_start', { runId: 'r1', name: 'demo', goal: 'g' }, 100),
    ev('iteration_end', { iteration: 2, costUsd: 0.4 }, 200),
    ev('verified', { reason: 'ok', costUsd: 0.4 }, 300),
  ]
  const entry = buildRunListEntry('/projects/demo', 'r1', '/projects/demo/.looprail/runs/r1/journal.jsonl', events)
  expect(entry).toMatchObject({
    workspace: '/projects/demo', workspaceName: 'demo', runId: 'r1',
    status: 'verified', iteration: 2, costUsd: 0.4, agents: [],
    startedAt: 100, lastEventAt: 300,
  })
})

test('buildRunListEntry carries the loop\'s own name, goal, and total tokens - not just the workspace and run id', () => {
  const events: JournalEvent[] = [
    ev('run_start', { runId: 'r1', name: 'fix-tests', goal: 'Make CI green again.' }, 100),
    ev('node_end', { nodeId: 'do', role: 'executor', iteration: 1, costUsd: 0.1, tokens: 250, verdict: null }, 150),
  ]
  const entry = buildRunListEntry('/projects/demo', 'r1', '/irrelevant', events)
  expect(entry.name).toBe('fix-tests')
  expect(entry.goal).toBe('Make CI green again.')
  expect(entry.tokens).toBe(250)
})

// Mission control's run tiles need to show WHY a run halted/canceled
// without opening it (see dashboard/mission-control-page.ts's runCard) -
// that string has to come from somewhere, and buildViewModel already
// computes it correctly, so RunListEntry must carry it through verbatim
// rather than the dashboard layer re-deriving or re-wording it.
test('buildRunListEntry carries the halt/cancel reason string through from buildViewModel', () => {
  const haltedEvents: JournalEvent[] = [
    ev('run_start', { runId: 'r1', name: 'demo', goal: 'g' }, 100),
    ev('halt', { reason: 'rail breached (maxCostUsd 5 exceeded)', costUsd: 5.2 }, 200),
  ]
  const halted = buildRunListEntry('/projects/demo', 'r1', '/irrelevant', haltedEvents)
  expect(halted.status).toBe('halted')
  expect(halted.reason).toBe('rail breached (maxCostUsd 5 exceeded)')

  const canceledEvents: JournalEvent[] = [
    ev('run_start', { runId: 'r2', name: 'demo', goal: 'g' }, 100),
    ev('halt', { reason: 'canceled by user request', costUsd: 0.1 }, 200),
  ]
  const canceled = buildRunListEntry('/projects/demo', 'r2', '/irrelevant', canceledEvents)
  expect(canceled.status).toBe('canceled')
  expect(canceled.reason).toBe('canceled by user request')

  const runningEvents: JournalEvent[] = [ev('run_start', { runId: 'r3', name: 'demo', goal: 'g' }, 100)]
  const running = buildRunListEntry('/projects/demo', 'r3', '/irrelevant', runningEvents)
  expect(running.reason).toBeUndefined()
})

// Mirrors the reason test above: mission control's cost display (see
// dashboard/mission-control-page.ts) needs to fall back to the estimate when
// an adapter (copilot-cli/codex/aider) can't report a real costUsd, so
// RunListEntry must carry buildViewModel's estimatedCostUsd through verbatim
// rather than silently dropping it like before.
test('buildRunListEntry carries estimatedCostUsd through from buildViewModel, distinct from costUsd', () => {
  const events: JournalEvent[] = [
    ev('run_start', { runId: 'r1', name: 'demo', goal: 'g' }, 100),
    ev('iteration_end', { iteration: 1, costUsd: 0, estimatedCostUsd: 0.42 }, 200),
  ]
  const entry = buildRunListEntry('/projects/demo', 'r1', '/irrelevant', events)
  expect(entry.costUsd).toBe(0)
  expect(entry.estimatedCostUsd).toBeCloseTo(0.42)
})

test('buildRunListEntry defaults estimatedCostUsd to 0 when no event ever carries one', () => {
  const events: JournalEvent[] = [
    ev('run_start', { runId: 'r1', name: 'demo', goal: 'g' }, 100),
    ev('iteration_end', { iteration: 1, costUsd: 0.4 }, 200),
  ]
  const entry = buildRunListEntry('/projects/demo', 'r1', '/irrelevant', events)
  expect(entry.estimatedCostUsd).toBe(0)
})

// Mission control's run tiles need the run's own wall budget to flag an
// overshoot (see dashboard/mission-control-page.ts's runCard) - the elapsed
// figure itself is already derivable client-side from startedAt/lastEventAt,
// so RunListEntry only needs to carry the loopfile's rails.maxWallMinutes
// through verbatim, exactly like the reason/estimatedCostUsd carry-throughs
// above.
test('buildRunListEntry carries rails.maxWallMinutes through from the loopfile def when set', () => {
  const events: JournalEvent[] = [ev('run_start', { runId: 'r1', name: 'demo', goal: 'g' }, 100)]
  const def = {
    name: 'demo', goal: 'g', agents: {}, graph: {},
    rails: { maxIterations: 10, maxCostUsd: 5, maxWallMinutes: 45, replanLimit: 3 },
  } as unknown as Parameters<typeof buildRunListEntry>[4]
  const entry = buildRunListEntry('/projects/demo', 'r1', '/irrelevant', events, def)
  expect(entry.maxWallMinutes).toBe(45)
})

test('buildRunListEntry leaves maxWallMinutes undefined with no def, or a def with no wall rail', () => {
  const events: JournalEvent[] = [ev('run_start', { runId: 'r1', name: 'demo', goal: 'g' }, 100)]

  const withoutDef = buildRunListEntry('/projects/demo', 'r1', '/irrelevant', events)
  expect(withoutDef.maxWallMinutes).toBeUndefined()

  const defWithNoWallRail = {
    name: 'demo', goal: 'g', agents: {}, graph: {},
    rails: { maxIterations: 10, maxCostUsd: 5, replanLimit: 3 },
  } as unknown as Parameters<typeof buildRunListEntry>[4]
  const withNoWallRail = buildRunListEntry('/projects/demo', 'r1', '/irrelevant', events, defWithNoWallRail)
  expect(withNoWallRail.maxWallMinutes).toBeUndefined()
})

test('discoverRuns on an empty workspace list returns no runs', () => {
  expect(discoverRuns([])).toEqual([])
})

test('discoverRuns skips a registered workspace that has never run anything', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'lr-discover-'))
  expect(discoverRuns([workspace])).toEqual([])
})

test('discoverRuns finds every run under a workspace and fills in agents from its loopfile', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'lr-discover-'))
  writeFileSync(join(workspace, 'looprail.yaml'), `
name: demo
goal: g
agents:
  worker: { adapter: mock }
graph:
  do: { role: executor, agent: worker }
rails:
  max_iterations: 2
  max_cost_usd: 1
`)
  const runDir = join(runsRoot(workspace), 'run-1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'journal.jsonl'), [
    JSON.stringify(ev('run_start', { runId: 'run-1', name: 'demo', goal: 'g' })),
    JSON.stringify(ev('node_start', { nodeId: 'do', role: 'executor', iteration: 1 })),
    JSON.stringify(ev('node_end', { nodeId: 'do', role: 'executor', iteration: 1, costUsd: 0.1, verdict: null, output: 'x' })),
  ].join('\n') + '\n')
  const entries = discoverRuns([workspace])
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({ runId: 'run-1', status: 'running', agents: ['worker'] })
})

test('discoverRuns merges runs from multiple workspaces, sorted most-recently-active first', () => {
  const a = mkdtempSync(join(tmpdir(), 'lr-discover-a-'))
  const b = mkdtempSync(join(tmpdir(), 'lr-discover-b-'))
  for (const [ws, ts] of [[a, 100], [b, 200]] as const) {
    const runDir = join(runsRoot(ws), 'run-1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'journal.jsonl'), JSON.stringify(ev('run_start', { runId: 'run-1', name: 'n', goal: 'g' }, ts)) + '\n')
  }
  const entries = discoverRuns([a, b])
  expect(entries.map((e) => e.workspace)).toEqual([b, a])
})

test('a registered workspace path that no longer exists on disk is skipped, not a crash', () => {
  const ghost = join(tmpdir(), 'lr-discover-ghost-does-not-exist')
  expect(discoverRuns([ghost])).toEqual([])
})

test('discoverRuns skips a workspace whose run journal path is a directory instead of a file, without dropping other workspaces', () => {
  const broken = mkdtempSync(join(tmpdir(), 'lr-discover-broken-'))
  // journal.jsonl is a directory, not a file - e.g. a crashed process, a
  // stray mkdir, or some other tool clobbering the expected path.
  mkdirSync(join(runsRoot(broken), 'run-1', 'journal.jsonl'), { recursive: true })

  const healthy = mkdtempSync(join(tmpdir(), 'lr-discover-healthy-'))
  const healthyRunDir = join(runsRoot(healthy), 'run-2')
  mkdirSync(healthyRunDir, { recursive: true })
  writeFileSync(
    join(healthyRunDir, 'journal.jsonl'),
    JSON.stringify(ev('run_start', { runId: 'run-2', name: 'n', goal: 'g' })) + '\n',
  )

  let entries: ReturnType<typeof discoverRuns> = []
  expect(() => { entries = discoverRuns([broken, healthy]) }).not.toThrow()
  expect(entries).toHaveLength(1)
  expect(entries[0].runId).toBe('run-2')
})

test('discoverRuns skips one broken run but still returns the healthy runs in the SAME workspace', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'lr-discover-mixed-'))
  const runsDir = runsRoot(workspace)

  // A broken run: its journal.jsonl is a directory, not a file, so reading it
  // throws (EISDIR). This must NOT take down the healthy run beside it.
  mkdirSync(join(runsDir, 'run-broken', 'journal.jsonl'), { recursive: true })

  // A healthy run in the very same workspace.
  const goodDir = join(runsDir, 'run-good')
  mkdirSync(goodDir, { recursive: true })
  writeFileSync(
    join(goodDir, 'journal.jsonl'),
    JSON.stringify(ev('run_start', { runId: 'run-good', name: 'n', goal: 'g' })) + '\n',
  )

  let entries: ReturnType<typeof discoverRuns> = []
  expect(() => { entries = discoverRuns([workspace]) }).not.toThrow()
  expect(entries).toHaveLength(1)
  expect(entries[0].runId).toBe('run-good')
})

// --- Claude Code raw-session presence detection ---

test('claudeCodeProjectSlug replaces every slash with a dash', () => {
  expect(claudeCodeProjectSlug('/a/b/c')).toBe('-a-b-c')
})

test('claudeCodeProjectSlug matches the real, verified Claude Code project directory naming for this machine', () => {
  // Pinned ground-truth: confirmed live on this machine, not inferred.
  expect(claudeCodeProjectSlug('/Users/skiranmeda/sai-git/looprail')).toBe('-Users-skiranmeda-sai-git-looprail')
})

test('claudeCodeProjectSlug replaces any non-alphanumeric character, not just slashes', () => {
  expect(claudeCodeProjectSlug('/a/b.c d_e')).toBe('-a-b-c-d-e')
})

test('discoverClaudeCodeSessions returns a session with a recent mtime and excludes an old one', () => {
  const homedir = mkdtempSync(join(tmpdir(), 'lr-claude-home-'))
  const workspace = '/some/workspace'
  const projectsDir = join(homedir, '.claude', 'projects', claudeCodeProjectSlug(workspace))
  mkdirSync(projectsDir, { recursive: true })

  const now = 1_000_000_000_000
  const recentFile = join(projectsDir, 'recent-session.jsonl')
  const oldFile = join(projectsDir, 'old-session.jsonl')
  writeFileSync(recentFile, '{}')
  writeFileSync(oldFile, '{}')
  const recentMtime = new Date(now - 5 * 60 * 1000) // 5 minutes ago
  const oldMtime = new Date(now - 60 * 60 * 1000) // 1 hour ago
  utimesSync(recentFile, recentMtime, recentMtime)
  utimesSync(oldFile, oldMtime, oldMtime)

  const sessions = discoverClaudeCodeSessions([workspace], { homedir, now: () => now })
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({
    workspace,
    workspaceName: 'workspace',
    sessionId: 'recent-session',
  })
  expect(sessions[0].lastActiveAt).toBe(recentMtime.getTime())
})

test('discoverClaudeCodeSessions returns an empty array for a workspace with no matching projects dir, no throw', () => {
  const homedir = mkdtempSync(join(tmpdir(), 'lr-claude-home-'))
  const workspace = '/never/seen/this/workspace'
  expect(() => discoverClaudeCodeSessions([workspace], { homedir })).not.toThrow()
  expect(discoverClaudeCodeSessions([workspace], { homedir })).toEqual([])
})

test('discoverClaudeCodeSessions attributes sessions correctly across multiple workspaces', () => {
  const homedir = mkdtempSync(join(tmpdir(), 'lr-claude-home-'))
  const workspaceA = '/projects/alpha'
  const workspaceB = '/projects/beta'
  const now = 2_000_000_000_000

  for (const [ws, sessionId] of [[workspaceA, 'session-a'], [workspaceB, 'session-b']] as const) {
    const dir = join(homedir, '.claude', 'projects', claudeCodeProjectSlug(ws))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${sessionId}.jsonl`)
    writeFileSync(file, '{}')
    const mtime = new Date(now - 60 * 1000)
    utimesSync(file, mtime, mtime)
  }

  const sessions = discoverClaudeCodeSessions([workspaceA, workspaceB], { homedir, now: () => now })
  expect(sessions).toHaveLength(2)
  const bySessionId = Object.fromEntries(sessions.map((s) => [s.sessionId, s]))
  expect(bySessionId['session-a']).toMatchObject({ workspace: workspaceA, workspaceName: 'alpha' })
  expect(bySessionId['session-b']).toMatchObject({ workspace: workspaceB, workspaceName: 'beta' })
})

test('discoverClaudeCodeSessions skips a workspace whose Claude Code project path is a file instead of a directory, without dropping other workspaces', () => {
  const homedir = mkdtempSync(join(tmpdir(), 'lr-claude-home-'))
  const broken = '/broken/workspace'
  const projectsParent = join(homedir, '.claude', 'projects')
  mkdirSync(projectsParent, { recursive: true })
  // The expected project dir is a plain file, not a directory - readdirSync
  // on it throws ENOTDIR.
  writeFileSync(join(projectsParent, claudeCodeProjectSlug(broken)), 'not a directory')

  const healthy = '/healthy/workspace'
  const healthyDir = join(homedir, '.claude', 'projects', claudeCodeProjectSlug(healthy))
  mkdirSync(healthyDir, { recursive: true })
  const file = join(healthyDir, 'session-ok.jsonl')
  writeFileSync(file, '{}')
  const now = 4_000_000_000_000
  const mtime = new Date(now - 60 * 1000)
  utimesSync(file, mtime, mtime)

  let sessions: ReturnType<typeof discoverClaudeCodeSessions> = []
  expect(() => {
    sessions = discoverClaudeCodeSessions([broken, healthy], { homedir, now: () => now })
  }).not.toThrow()
  expect(sessions).toHaveLength(1)
  expect(sessions[0].workspace).toBe(healthy)
})

test('discoverClaudeCodeSessions skips one session whose statSync throws but still returns the healthy ones in the SAME workspace', () => {
  const homedir = mkdtempSync(join(tmpdir(), 'lr-claude-home-'))
  const workspace = '/projects/mixed'
  const dir = join(homedir, '.claude', 'projects', claudeCodeProjectSlug(workspace))
  mkdirSync(dir, { recursive: true })

  // A dangling symlink ending in .jsonl: it survives readdirSync (the entry
  // exists) but statSync follows it and throws ENOENT, standing in for a
  // TOCTOU deletion between the two calls. This must NOT drop the good session.
  symlinkSync(join(dir, 'nonexistent-target'), join(dir, 'dead-session.jsonl'))

  const goodFile = join(dir, 'good-session.jsonl')
  writeFileSync(goodFile, '{}')
  const now = 5_000_000_000_000
  const mtime = new Date(now - 60 * 1000)
  utimesSync(goodFile, mtime, mtime)

  let sessions: ReturnType<typeof discoverClaudeCodeSessions> = []
  expect(() => {
    sessions = discoverClaudeCodeSessions([workspace], { homedir, now: () => now })
  }).not.toThrow()
  expect(sessions).toHaveLength(1)
  expect(sessions[0].sessionId).toBe('good-session')
})

test('discoverClaudeCodeSessions never reads file content - a corrupt jsonl file is still detected by mtime alone', () => {
  const homedir = mkdtempSync(join(tmpdir(), 'lr-claude-home-'))
  const workspace = '/projects/corrupt'
  const dir = join(homedir, '.claude', 'projects', claudeCodeProjectSlug(workspace))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'broken-session.jsonl')
  // Genuinely invalid/corrupt content - if the implementation ever tried to
  // JSON.parse or otherwise read this, it would throw or behave oddly.
  writeFileSync(file, 'this is not { json at all "]]] \x00\xFF garbage')
  const now = 3_000_000_000_000
  const mtime = new Date(now - 60 * 1000)
  utimesSync(file, mtime, mtime)

  const sessions = discoverClaudeCodeSessions([workspace], { homedir, now: () => now })
  expect(sessions).toHaveLength(1)
  expect(sessions[0].sessionId).toBe('broken-session')
})
