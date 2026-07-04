import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { JournalEvent } from '../index.js'
import { runsRoot } from '../journal/runs.js'
import { createLooprailMcpServer } from './server.js'

function ev(type: JournalEvent['type'], data: Record<string, unknown>): JournalEvent {
  return { ts: 0, type, data }
}

async function connectedClient(cwd: string): Promise<Client> {
  const server = createLooprailMcpServer({ cwd })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

function textOf(result: { content: unknown }): string {
  return (result.content as { type: string; text: string }[])[0].text
}

test('every tool this plan built is registered on the real server', async () => {
  const client = await connectedClient(mkdtempSync(join(tmpdir(), 'lr-mcp-int-')))
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  for (const expected of ['lint_loopfile', 'run_loop', 'run_status', 'list_runs', 'explain_node']) {
    expect(names).toContain(expected)
  }
})

test('lint_loopfile -> run_loop -> run_status form one coherent flow over the real transport', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-mcp-int-'))
  writeFileSync(join(cwd, 'looprail.yaml'), `
name: demo
goal: Say DONE.
agents:
  worker: { adapter: mock }
graph:
  do:    { role: executor, agent: worker }
  check: { role: tester, after: do, run: "true", expect: "exit 0" }
rails:
  max_iterations: 2
  max_cost_usd: 1
`)
  const client = await connectedClient(cwd)

  const lint = await client.callTool({ name: 'lint_loopfile', arguments: { file: 'looprail.yaml' } })
  expect(lint.isError).toBeFalsy()
  expect(JSON.parse(textOf(lint)).findings).toEqual([])

  const started = await client.callTool({ name: 'run_loop', arguments: { file: 'looprail.yaml' } })
  expect(started.isError).toBeFalsy()
  const parsed = JSON.parse(textOf(started))
  expect(parsed.status).toBe('started')
  expect(parsed.runId).toMatch(/^run-/)

  const status = await client.callTool({ name: 'run_status', arguments: { runId: parsed.runId } })
  // The background run may or may not have journaled anything by the time
  // this resolves (see Task 2/9 notes on why this plan never races real
  // time against a detached promise) - only asserting the call succeeds
  // and names the right run proves the wiring; run_loop's actual async
  // behavior is exhaustively covered at the handler level in run-loop.test.ts.
  expect(status.isError).toBeFalsy()
  expect(JSON.parse(textOf(status)).runId).toBe(parsed.runId)
})

test('list_runs reads a pre-seeded journal fixture correctly over the real transport', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-mcp-int-'))
  const runDir = join(runsRoot(cwd), 'run-fixture')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'journal.jsonl'), [
    ev('run_start', { runId: 'run-fixture', name: 'demo' }),
    ev('verified', { reason: 'ok', costUsd: 0.05 }),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n')

  const client = await connectedClient(cwd)
  const result = await client.callTool({ name: 'list_runs', arguments: {} })
  expect(result.isError).toBeFalsy()
  const parsed = JSON.parse(textOf(result))
  expect(parsed.runs).toHaveLength(1)
  expect(parsed.runs[0]).toMatchObject({ runId: 'run-fixture', status: 'verified', costUsd: 0.05 })
})
