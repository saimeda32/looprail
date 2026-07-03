import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runsRoot, type JournalEvent } from '../../index.js'
import { listRunsHandler } from './list-runs.js'

function ev(type: JournalEvent['type'], data: Record<string, unknown>): JournalEvent {
  return { ts: 0, type, data }
}

function writeRun(cwd: string, runId: string, events: JournalEvent[], mtimeMs: number): void {
  const dir = join(cwd, '.looprail', 'runs', runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'journal.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
  utimesSync(dir, new Date(mtimeMs), new Date(mtimeMs))
}

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'lr-mcp-list-'))
}

test('a cwd with no runs returns an empty list', async () => {
  const result = await listRunsHandler({}, { cwd: tmpCwd() })
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.runs).toEqual([])
})

test('lists runs newest first, each summarized', async () => {
  const cwd = tmpCwd()
  writeRun(cwd, 'run-old', [ev('run_start', { runId: 'run-old', name: 'a' }), ev('verified', { reason: 'ok', costUsd: 0.1 })], 1000)
  writeRun(cwd, 'run-new', [ev('run_start', { runId: 'run-new', name: 'b' })], 2000)
  const result = await listRunsHandler({}, { cwd })
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.runs.map((r: { runId: string }) => r.runId)).toEqual(['run-new', 'run-old'])
  expect(parsed.runs[1]).toMatchObject({ status: 'verified', costUsd: 0.1 })
})

test('limit caps the number of runs returned', async () => {
  const cwd = tmpCwd()
  writeRun(cwd, 'run-a', [ev('run_start', { runId: 'run-a', name: 'a' })], 1000)
  writeRun(cwd, 'run-b', [ev('run_start', { runId: 'run-b', name: 'b' })], 2000)
  const result = await listRunsHandler({ limit: 1 }, { cwd })
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.runs).toHaveLength(1)
  expect(parsed.runs[0].runId).toBe('run-b')
})

test('allWorkspaces:true lists runs across every registered workspace, not just cwd', async () => {
  const { addWorkspace } = await import('../../workspace/registry.js')
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-mcp-ws-')), 'workspaces.json')
  const a = mkdtempSync(join(tmpdir(), 'lr-mcp-list-a-'))
  writeRun(a, 'run-1', [ev('run_start', { runId: 'run-1', name: 'demo' })], 1000)
  addWorkspace(registryPath, a)
  const result = await listRunsHandler({ allWorkspaces: true }, { cwd: '/irrelevant', registryPath })
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.scope).toBe('all-workspaces')
  expect(parsed.runs).toHaveLength(1)
})

test('allWorkspaces:false (default) still scopes to cwd only, unaffected by the registry', async () => {
  const { addWorkspace } = await import('../../workspace/registry.js')
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-mcp-ws-')), 'workspaces.json')
  const other = mkdtempSync(join(tmpdir(), 'lr-mcp-list-other-'))
  writeRun(other, 'run-1', [ev('run_start', { runId: 'run-1', name: 'demo' })], 1000)
  addWorkspace(registryPath, other)
  const cwd = tmpCwd()
  const result = await listRunsHandler({}, { cwd, registryPath })
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.scope).toBe('cwd')
  expect(parsed.runs).toEqual([])
})
