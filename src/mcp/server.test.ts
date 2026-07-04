import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createLooprailMcpServer } from './server.js'

async function connectedClient(cwd: string): Promise<Client> {
  const server = createLooprailMcpServer({ cwd })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

test('the server advertises lint_loopfile over a real (in-memory) MCP transport', async () => {
  const client = await connectedClient(mkdtempSync(join(tmpdir(), 'lr-mcp-')))
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name)).toContain('lint_loopfile')
})

test('the server advertises approve_gate over a real (in-memory) MCP transport', async () => {
  const client = await connectedClient(mkdtempSync(join(tmpdir(), 'lr-mcp-')))
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name)).toContain('approve_gate')
})

test('lint_loopfile is callable end to end through the real transport', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-mcp-'))
  writeFileSync(join(cwd, 'looprail.yaml'), `
name: demo
goal: g
agents:
  worker: { adapter: mock }
graph:
  do:   { role: executor, agent: worker }
  test: { role: tester, after: do, run: "true", expect: "exit 0" }
rails:
  max_iterations: 2
  max_cost_usd: 1
`)
  const client = await connectedClient(cwd)
  const result = await client.callTool({ name: 'lint_loopfile', arguments: { file: 'looprail.yaml' } })
  expect(result.isError).toBeFalsy()
  const content = result.content as { type: string; text: string }[]
  expect(JSON.parse(content[0].text).findings).toEqual([])
})
