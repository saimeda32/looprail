import { mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { runAction } from './run-cmd.js'
import { loadExpandedLoopDef, uiAction } from './ui-cmd.js'

const FIXTURE = `
name: ui-fixture
goal: Say DONE.
agents:
  worker:  { adapter: mock }
  checker: { adapter: mock }
graph:
  do:   { role: executor, agent: worker }
  crit: { role: critic, agent: checker, of: do, after: do }
rails:
  max_iterations: 2
  max_cost_usd: 1
`

function capture() {
  const lines: string[] = []
  return { io: { out: (l: string) => lines.push(l) }, lines }
}

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { if (cleanup) await cleanup(); cleanup = undefined })

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    }).on('error', reject)
  })
}

async function completedRun() {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-ui-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE)
  const code = await runAction(undefined, { cwd, json: true }, { io: capture().io })
  expect(code).toBe(0)
  return cwd
}

test('uiAction on the latest run starts a server and prints its URL', async () => {
  const cwd = await completedRun()
  const { io, lines } = capture()
  const result = await uiAction(undefined, { cwd }, io)
  cleanup = () => result.dashboard!.close()
  expect(result.code).toBe(0)
  expect(lines.join('\n')).toContain(result.dashboard!.url)
  const res = await get(result.dashboard!.url + '/model')
  const payload = JSON.parse(res.body)
  expect(payload.name).toBe('ui-fixture')
})

test('uiAction with no runs exits 1 and starts nothing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-ui-'))
  const { io, lines } = capture()
  const result = await uiAction(undefined, { cwd }, io)
  expect(result.code).toBe(1)
  expect(result.dashboard).toBeUndefined()
  expect(lines.join('\n')).toContain('no runs')
})

test('uiAction with an unknown explicit runId exits 1', async () => {
  const cwd = await completedRun()
  const { io, lines } = capture()
  const result = await uiAction('not-a-real-run', { cwd }, io)
  expect(result.code).toBe(1)
  expect(lines.join('\n')).toContain('no journal')
})

test('a valid loopfile is loaded, expanded, and drives edges in /model', async () => {
  const cwd = await completedRun()
  const def = loadExpandedLoopDef(undefined, cwd)
  expect(def).toBeDefined()
  expect(def!.nodes.map((n) => n.id).sort()).toEqual(['crit', 'do'])
  const { io } = capture()
  const result = await uiAction(undefined, { cwd }, io)
  cleanup = () => result.dashboard!.close()
  const res = await get(result.dashboard!.url + '/model')
  const payload = JSON.parse(res.body)
  expect(payload.edges).toEqual(expect.arrayContaining([['do', 'crit']]))
  expect(payload.totals.maxCostUsd).toBe(1)
})

test('a missing loopfile falls back to observed-only mode without failing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-ui-'))
  expect(loadExpandedLoopDef(undefined, cwd)).toBeUndefined()
})
