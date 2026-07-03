import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { addWorkspace, listWorkspaces, readRegistry, removeWorkspace, writeRegistry } from './registry.js'

function tmpRegistryPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'lr-registry-')), 'workspaces.json')
}

test('readRegistry on a missing file returns an empty registry, not a crash', () => {
  expect(readRegistry(join(mkdtempSync(join(tmpdir(), 'lr-registry-')), 'nope.json'))).toEqual({ workspaces: [] })
})

test('readRegistry on a corrupt file returns an empty registry instead of throwing', () => {
  const path = tmpRegistryPath()
  writeRegistry(path, { workspaces: ['/a'] })
  writeFileSync(path, 'not json{{{')
  expect(readRegistry(path)).toEqual({ workspaces: [] })
})

test('writeRegistry then readRegistry roundtrips, creating parent directories as needed', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lr-registry-')), 'nested', 'workspaces.json')
  writeRegistry(path, { workspaces: ['/a', '/b'] })
  expect(readRegistry(path)).toEqual({ workspaces: ['/a', '/b'] })
})

test('addWorkspace appends a new absolute path and persists it', () => {
  const path = tmpRegistryPath()
  addWorkspace(path, '/projects/scrumlo')
  expect(listWorkspaces(path)).toEqual(['/projects/scrumlo'])
})

test('addWorkspace dedupes an already-registered path', () => {
  const path = tmpRegistryPath()
  addWorkspace(path, '/projects/scrumlo')
  addWorkspace(path, '/projects/scrumlo')
  expect(listWorkspaces(path)).toEqual(['/projects/scrumlo'])
})

test('addWorkspace rejects a relative path', () => {
  const path = tmpRegistryPath()
  expect(() => addWorkspace(path, 'relative/dir')).toThrow(/absolute/)
})

test('removeWorkspace drops exactly the matching path and leaves the rest', () => {
  const path = tmpRegistryPath()
  addWorkspace(path, '/projects/scrumlo')
  addWorkspace(path, '/projects/finch')
  removeWorkspace(path, '/projects/scrumlo')
  expect(listWorkspaces(path)).toEqual(['/projects/finch'])
})
