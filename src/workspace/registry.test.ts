import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

test('addWorkspace treats /foo and /foo/ as the same workspace, not two', () => {
  const path = tmpRegistryPath()
  addWorkspace(path, '/projects/scrumlo')
  addWorkspace(path, '/projects/scrumlo/')
  addWorkspace(path, '/projects/scrumlo/sub/..')
  expect(listWorkspaces(path)).toEqual(['/projects/scrumlo'])
})

test('removeWorkspace matches a non-normalized spelling of a stored path', () => {
  const path = tmpRegistryPath()
  addWorkspace(path, '/projects/scrumlo')
  removeWorkspace(path, '/projects/scrumlo/')
  expect(listWorkspaces(path)).toEqual([])
})

test('readRegistry normalizes and dedupes near-duplicate stored entries', () => {
  const path = tmpRegistryPath()
  writeFileSync(path, JSON.stringify({ workspaces: ['/a', '/a/', '/b//', '/a'] }))
  expect(readRegistry(path).workspaces).toEqual(['/a', '/b'])
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

test('two concurrent addWorkspace calls both survive, neither registration is lost', async () => {
  const path = tmpRegistryPath()
  await Promise.all([
    Promise.resolve().then(() => addWorkspace(path, '/projects/scrumlo')),
    Promise.resolve().then(() => addWorkspace(path, '/projects/finch')),
  ])
  expect(listWorkspaces(path).sort()).toEqual(['/projects/finch', '/projects/scrumlo'])
})

test('writeRegistry leaves no stray temp or lock artifacts behind', () => {
  const path = tmpRegistryPath()
  addWorkspace(path, '/projects/scrumlo')
  const dirEntries = readdirSync(dirname(path))
  expect(dirEntries).toEqual(['workspaces.json'])
})
