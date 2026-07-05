import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { LoopDef } from '../core/types.js'
import { loadRunLoopDef, persistRunLoopDef, RUN_LOOPFILE_NAME } from './loopfile-persist.js'

const def: LoopDef = {
  name: 'demo', goal: 'ship it',
  agents: { worker: { adapter: 'mock' } },
  nodes: [{ id: 'do', role: 'executor', agent: 'worker' }],
  rails: { maxIterations: 1, maxCostUsd: 1 },
  verdictPolicy: { kind: 'all-pass' },
}

test('persistRunLoopDef writes a run-readable JSON copy that loadRunLoopDef reads back unchanged', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'lr-persist-'))
  persistRunLoopDef(runDir, def)
  expect(JSON.parse(readFileSync(join(runDir, RUN_LOOPFILE_NAME), 'utf8'))).toEqual(def)
  expect(loadRunLoopDef(runDir)).toEqual(def)
})

test('loadRunLoopDef returns undefined for a run directory with no persisted copy (pre-existing runs)', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'lr-persist-none-'))
  expect(loadRunLoopDef(runDir)).toBeUndefined()
})

test('loadRunLoopDef returns undefined (never throws) for a corrupt persisted file', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'lr-persist-corrupt-'))
  persistRunLoopDef(runDir, def)
  // corrupt it after the fact
  writeFileSync(join(runDir, RUN_LOOPFILE_NAME), '{ not valid json')
  expect(loadRunLoopDef(runDir)).toBeUndefined()
})

test('persistRunLoopDef never throws even when the run directory is gone (best-effort, like writeRunPid)', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'lr-persist-gone-'))
  rmSync(runDir, { recursive: true, force: true })
  expect(() => persistRunLoopDef(runDir, def)).not.toThrow()
  expect(loadRunLoopDef(runDir)).toBeUndefined()
})

test("a run's persisted def survives its origin workspace directory being deleted entirely", () => {
  const workspace = mkdtempSync(join(tmpdir(), 'lr-persist-workspace-'))
  const runDir = mkdtempSync(join(tmpdir(), 'lr-persist-rundir-'))
  persistRunLoopDef(runDir, def)
  // the workspace that originally produced this run is gone (e.g. a git
  // worktree cleaned up after merging) - the run's own directory is
  // untouched and elsewhere (~/.looprail/runs/...), so its persisted copy
  // must still resolve regardless.
  rmSync(workspace, { recursive: true, force: true })
  expect(loadRunLoopDef(runDir)).toEqual(def)
})
