import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { listWorkspaces } from '../workspace/registry.js'
import { workspaceAddAction, workspaceListAction, workspaceRemoveAction } from './workspace-cmd.js'

function capture() {
  const lines: string[] = []
  return { io: { out: (l: string) => lines.push(l) }, lines }
}

function tmpRegistryPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'lr-wsreg-')), 'workspaces.json')
}

test('workspace add registers the current directory by default', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-ws-'))
  const registryPath = tmpRegistryPath()
  const { io, lines } = capture()
  const code = workspaceAddAction(undefined, { cwd, registryPath }, io)
  expect(code).toBe(0)
  expect(listWorkspaces(registryPath)).toEqual([cwd])
  expect(lines.join('\n')).toContain(cwd)
})

test('workspace add with an explicit relative path resolves it against cwd', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-ws-'))
  const sub = join(cwd, 'sub')
  mkdirSync(sub)
  const registryPath = tmpRegistryPath()
  const code = workspaceAddAction('sub', { cwd, registryPath }, capture().io)
  expect(code).toBe(0)
  expect(listWorkspaces(registryPath)).toEqual([sub])
})

test('workspace add on a nonexistent directory fails without touching the registry', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-ws-'))
  const registryPath = tmpRegistryPath()
  const { io, lines } = capture()
  const code = workspaceAddAction('does-not-exist', { cwd, registryPath }, io)
  expect(code).toBe(1)
  expect(listWorkspaces(registryPath)).toEqual([])
  expect(lines.join('\n')).toContain('no such directory')
})

test('workspace remove unregisters a path', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-ws-'))
  const registryPath = tmpRegistryPath()
  workspaceAddAction(undefined, { cwd, registryPath }, capture().io)
  const code = workspaceRemoveAction(cwd, { cwd, registryPath }, capture().io)
  expect(code).toBe(0)
  expect(listWorkspaces(registryPath)).toEqual([])
})

test('workspace list on an empty registry prints a helpful hint, not an empty table', () => {
  const registryPath = tmpRegistryPath()
  const { io, lines } = capture()
  const code = workspaceListAction({ cwd: '/irrelevant', registryPath }, io)
  expect(code).toBe(0)
  expect(lines.join('\n')).toContain('no workspaces registered')
})

test('workspace list prints every registered path', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-ws-'))
  const registryPath = tmpRegistryPath()
  workspaceAddAction(undefined, { cwd, registryPath }, capture().io)
  const { io, lines } = capture()
  workspaceListAction({ cwd: '/irrelevant', registryPath }, io)
  expect(lines.join('\n')).toContain(cwd)
})

test('registerWorkspace wires add/remove/list as a `workspace` subcommand group', async () => {
  const { buildProgram } = await import('./index.js')
  const help = buildProgram().helpInformation()
  expect(help).toContain('workspace')
})
