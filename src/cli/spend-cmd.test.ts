import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { aggregateSpend, spendAction } from './spend-cmd.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY

function seedRun(root: string, ws: string, runId: string, events: object[]): void {
  const dir = join(root, ws, runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'journal.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

const nodeEnd = (ts: number, adapter: string, model: string | undefined, costUsd: number, estimatedCostUsd: number, tokens = 100) =>
  ({ ts, type: 'node_end', data: { nodeId: 'n', role: 'executor', adapter, model, costUsd, estimatedCostUsd, tokens } })

test('aggregates per adapter/model across workspaces, real and estimated kept separate', () => {
  const root = mkdtempSync(join(tmpdir(), 'lr-spend-'))
  seedRun(root, 'ws1', 'run-a', [
    nodeEnd(NOW - DAY, 'claude-code', 'sonnet', 0.5, 0),
    nodeEnd(NOW - DAY, 'copilot-cli', 'claude-sonnet-5', 0, 0.02),
    { ts: NOW - DAY, type: 'node_end', data: { nodeId: 'tests', role: 'tester', costUsd: 0 } }, // no adapter -> not spend
  ])
  seedRun(root, 'ws2', 'run-b', [nodeEnd(NOW - 2 * DAY, 'claude-code', 'sonnet', 0.25, 0)])
  const report = aggregateSpend(root, 30, () => NOW)
  expect(report.runs).toBe(2)
  const claude = report.rows.find((r) => r.adapter === 'claude-code')!
  expect(claude.costUsd).toBeCloseTo(0.75)
  expect(claude.invocations).toBe(2)
  const copilot = report.rows.find((r) => r.adapter === 'copilot-cli')!
  expect(copilot.estimatedCostUsd).toBeCloseTo(0.02)
  expect(copilot.costUsd).toBe(0)
  expect(report.totalCostUsd).toBeCloseTo(0.75)
  expect(report.totalEstimatedCostUsd).toBeCloseTo(0.02)
})

test('the window excludes events older than --days', () => {
  const root = mkdtempSync(join(tmpdir(), 'lr-spend2-'))
  seedRun(root, 'ws1', 'run-old', [nodeEnd(NOW - 40 * DAY, 'claude-code', 'sonnet', 9.99, 0)])
  seedRun(root, 'ws1', 'run-new', [nodeEnd(NOW - DAY, 'claude-code', 'sonnet', 0.1, 0)])
  const report = aggregateSpend(root, 7, () => NOW)
  expect(report.totalCostUsd).toBeCloseTo(0.1)
  expect(report.runs).toBe(1)
})

test('renders a friendly empty state and a totals line', () => {
  const empty = mkdtempSync(join(tmpdir(), 'lr-spend3-'))
  const lines: string[] = []
  expect(spendAction({}, { io: { out: (l) => lines.push(l) }, runsDir: empty, now: () => NOW })).toBe(0)
  expect(lines.join('\n')).toContain('no agent spend')
})
