import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { JournalEvent } from '../core/types.js'
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
  const runDir = join(workspace, '.looprail', 'runs', 'run-1')
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
    const runDir = join(ws, '.looprail', 'runs', 'run-1')
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

// --- Claude Code raw-session presence detection ---

test('claudeCodeProjectSlug replaces every slash with a dash', () => {
  expect(claudeCodeProjectSlug('/a/b/c')).toBe('-a-b-c')
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

test('discoverClaudeCodeSessions never reads file content — a corrupt jsonl file is still detected by mtime alone', () => {
  const homedir = mkdtempSync(join(tmpdir(), 'lr-claude-home-'))
  const workspace = '/projects/corrupt'
  const dir = join(homedir, '.claude', 'projects', claudeCodeProjectSlug(workspace))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'broken-session.jsonl')
  // Genuinely invalid/corrupt content — if the implementation ever tried to
  // JSON.parse or otherwise read this, it would throw or behave oddly.
  writeFileSync(file, 'this is not { json at all "]]] \x00\xFF garbage')
  const now = 3_000_000_000_000
  const mtime = new Date(now - 60 * 1000)
  utimesSync(file, mtime, mtime)

  const sessions = discoverClaudeCodeSessions([workspace], { homedir, now: () => now })
  expect(sessions).toHaveLength(1)
  expect(sessions[0].sessionId).toBe('broken-session')
})
