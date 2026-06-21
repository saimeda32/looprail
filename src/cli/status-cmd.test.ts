import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { latestRunId, logsAction, statusAction, summarizeJournal } from './status-cmd.js'
import { runAction } from './run-cmd.js'

const FIXTURE = `
name: cli-fixture
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

async function completedRun() {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-status-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE)
  const code = await runAction(undefined, { cwd, json: true }, { io: capture().io })
  expect(code).toBe(0)
  return cwd
}

test('status defaults to the latest run and renders verdict history', async () => {
  const cwd = await completedRun()
  const { io, lines } = capture()
  expect(await statusAction(undefined, { cwd }, io)).toBe(0)
  const text = lines.join('\n')
  expect(text).toContain('verified')
  expect(text).toContain('crit')       // verdict history row
  expect(text).toContain('iter 1')
})

test('status --watch on a finished run renders once and exits', async () => {
  const cwd = await completedRun()
  const { io, lines } = capture()
  expect(await statusAction(undefined, { cwd, watch: true, intervalMs: 1 }, io)).toBe(0)
  expect(lines.join('\n')).toContain('verified')
})

test('status with no runs exits 1', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-status-'))
  const { io, lines } = capture()
  expect(await statusAction(undefined, { cwd }, io)).toBe(1)
  expect(lines.join('\n')).toContain('no runs')
})

test('summarizeJournal folds a running journal as running', () => {
  const s = summarizeJournal([
    { ts: 1, type: 'run_start', data: { runId: 'r1', name: 'demo' } },
    { ts: 2, type: 'node_end', data: { nodeId: 'do', iteration: 1, costUsd: 0.1, verdict: null } },
  ])
  expect(s).toMatchObject({ runId: 'r1', name: 'demo', status: 'running' })
})

test('logs prints node outputs and filters by node id', async () => {
  const cwd = await completedRun()
  const runId = latestRunId(cwd)!
  const all = capture()
  expect(await logsAction(runId, undefined, { cwd }, all.io)).toBe(0)
  expect(all.lines.join('\n')).toContain('[mock]')       // executor echo output
  const filtered = capture()
  expect(await logsAction(runId, 'crit', { cwd }, filtered.io)).toBe(0)
  expect(filtered.lines.join('\n')).toContain('crit')
  expect(filtered.lines.join('\n')).not.toContain('[mock] # Goal')
})

test('logs for an unknown run exits 1', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-status-'))
  const { io } = capture()
  expect(await logsAction('nope', undefined, { cwd }, io)).toBe(1)
})
