import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runLoop } from './runner.js'
import { readJournal } from '../journal/journal.js'
import { MockAdapter } from '../adapters/mock.js'
import { createRegistry } from '../adapters/registry.js'
import type { LoopDef } from '../core/types.js'

const loop = (over: Partial<LoopDef> = {}): LoopDef => ({
  name: 'demo',
  goal: 'produce the word DONE',
  agents: { a: { adapter: 'mock' } },
  nodes: [
    { id: 'plan', role: 'planner', agent: 'a' },
    { id: 'pcrit', role: 'critic', agent: 'a', of: 'plan', after: ['plan'], rounds: 2 },
    { id: 'do', role: 'executor', agent: 'a', after: ['pcrit'] },
    { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
  ],
  rails: { maxIterations: 4, maxCostUsd: 5, stallAfter: 2, replanLimit: 1 },
  verdictPolicy: { kind: 'all-pass' },
  ...over,
})

const reg = (mock: MockAdapter) => {
  const registry = createRegistry()
  registry.register(mock)
  return registry
}

test('verifies when critics pass on first iteration', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'the plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: plan is sound' },
    { match: /EXECUTOR/, output: 'DONE', costUsd: 0.5 },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: verified DONE' },
  ])
  const report = await runLoop(loop(), { registry: reg(mock) })
  expect(report.status).toBe('verified')
  expect(report.iterations).toBe(1)
  expect(report.costUsd).toBeCloseTo(0.5)
})

test('failed verdict feeds evidence into next iteration executor prompt', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'the plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /EXECUTOR/, output: 'half done' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: missing the DONE marker' },
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok now' },
  ])
  const report = await runLoop(loop(), { registry: reg(mock) })
  expect(report.status).toBe('verified')
  expect(report.iterations).toBe(2)
  const secondExec = mock.calls.filter((c) => c.prompt.includes('EXECUTOR'))[1]
  expect(secondExec.prompt).toContain('missing the DONE marker')
})

test('planner revision round runs when plan critic fails', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'weak plan' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: no success criteria' },
    { match: /PLANNER/, output: 'strong plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: fixed' },
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ])
  const report = await runLoop(loop(), { registry: reg(mock) })
  expect(report.status).toBe('verified')
  const plannerCalls = mock.calls.filter((c) => c.prompt.includes('PLANNER'))
  expect(plannerCalls).toHaveLength(2)
  expect(plannerCalls[1].prompt).toContain('no success criteria')
})

test('halts on iteration rail with a report, never throws', async () => {
  const steps = [
    { match: /PLANNER/, output: 'plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ]
  for (let i = 0; i < 4; i++) {
    steps.push(
      { match: /EXECUTOR/, output: `attempt ${i}` },
      { match: /CRITIC/, output: `VERDICT: fail\nEVIDENCE: wrong attempt ${i}` },
    )
  }
  // no stall_after on these rails: identical failing sets must NOT stall —
  // this test exercises the iteration rail in isolation
  const def = loop({ rails: { maxIterations: 4, maxCostUsd: 5 } })
  const report = await runLoop(def, { registry: reg(new MockAdapter(steps)) })
  expect(report.status).toBe('halted')
  expect(report.iterations).toBe(5) // breach detected entering iteration 5
  expect(report.reason).toContain('iterations')
})

test('stall triggers replan, then halts when stall persists', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /EXECUTOR/, output: 'x' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: same wall' },
    { match: /EXECUTOR/, output: 'x' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: same wall' },
    { match: /PLANNER/, output: 'plan B' },          // replan after stall
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /EXECUTOR/, output: 'x' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: same wall' },
    { match: /EXECUTOR/, output: 'x' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: same wall' },
  ])
  const report = await runLoop(loop(), { registry: reg(mock) })
  expect(report.status).toBe('halted')
  expect(report.reason).toContain('stall')
  expect(report.replans).toBe(1)
})

test('journals run lifecycle when runDir is set', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ])
  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run')
  const report = await runLoop(loop(), { registry: reg(mock), runDir, runId: 'r1' })
  const types = readJournal(join(runDir, 'journal.jsonl')).map((e) => e.type)
  expect(types[0]).toBe('run_start')
  expect(types).toContain('node_end')
  expect(types.at(-1)).toBe('verified')
  expect(report.runId).toBe('r1')
})

test('planner with "after" pointing at an execution node runs without crashing', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'the plan' },
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ])
  const def = loop({
    nodes: [
      { id: 'plan', role: 'planner', agent: 'a', after: ['research'] },
      { id: 'research', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'research', after: ['research'] },
    ],
  })
  const report = await runLoop(def, { registry: reg(mock) })
  expect(report.status).toBe('verified')
})

test('verifies when the cost rail breaches during the same iteration the loop passes', async () => {
  const mock = new MockAdapter([
    { match: /EXECUTOR/, output: 'DONE', costUsd: 0.5 },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0.6 },
  ])
  const def = loop({
    nodes: [
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
    ],
    rails: { maxIterations: 4, maxCostUsd: 1.0 },
  })
  const report = await runLoop(def, { registry: reg(mock) })
  expect(report.status).toBe('verified')
  expect(report.costUsd).toBeCloseTo(1.1)
})

test('critic-of-critic targeting a planning critic halts with an error verdict', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: unused' },
  ])
  const def = loop({
    nodes: [
      { id: 'plan', role: 'planner', agent: 'a' },
      { id: 'pcrit', role: 'critic', agent: 'a', of: 'plan', after: ['plan'] },
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'metacrit', role: 'critic', agent: 'a', of: 'pcrit' },
    ],
  })
  const report = await runLoop(def, { registry: reg(mock) })
  expect(report.status).toBe('halted')
  expect(report.reason).toContain('pcrit')
})

test('throws on invalid graph', async () => {
  const bad = loop({ nodes: [{ id: 'x', role: 'executor', agent: 'ghost' }] })
  await expect(runLoop(bad, { registry: reg(new MockAdapter([])) })).rejects.toThrow(/ghost/)
})
