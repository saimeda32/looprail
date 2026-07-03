import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { addWorkspace } from '../../workspace/registry.js'
import { listWorkspacesHandler } from './list-workspaces.js'

test('lists workspaces registered in the given registry file', async () => {
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-mcp-ws-')), 'workspaces.json')
  const a = mkdtempSync(join(tmpdir(), 'lr-mcp-ws-a-'))
  addWorkspace(registryPath, a)
  const result = await listWorkspacesHandler({}, { cwd: '/irrelevant', registryPath })
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.workspaces).toEqual([a])
})

test('a missing registry file returns an empty list, not an error', async () => {
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-mcp-ws-')), 'nope.json')
  const result = await listWorkspacesHandler({}, { cwd: '/irrelevant', registryPath })
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.workspaces).toEqual([])
})
