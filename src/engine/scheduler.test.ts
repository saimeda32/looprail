import { expect, test } from 'vitest'
import { runIteration } from './scheduler.js'
import { createRegistry } from '../adapters/registry.js'
import type { Adapter, LoopDef, NodeDef } from '../core/types.js'

const makeDef = (concurrency?: number): LoopDef => ({
  name: 't', goal: 'g',
  agents: { a: { adapter: 'probe' } },
  nodes: [],
  rails: { maxIterations: 3, maxCostUsd: 1 },
  verdictPolicy: { kind: 'all-pass' },
  concurrency,
})

function probeAdapter(log: string[], active: { now: number; max: number }): Adapter {
  return {
    name: 'probe',
    async invoke(req) {
      active.now++; active.max = Math.max(active.max, active.now)
      await new Promise((r) => setTimeout(r, 10))
      active.now--
      log.push(req.prompt.length.toString())
      return { output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0, tokens: 0, durationMs: 10 }
    },
  }
}

test('runs layers in order, parallel within a layer, capped by concurrency', async () => {
  const log: string[] = []
  const active = { now: 0, max: 0 }
  const registry = createRegistry()
  registry.register(probeAdapter(log, active))
  const nodes: NodeDef[] = [
    { id: 'plan', role: 'planner', agent: 'a' },
    { id: 'c1', role: 'critic', agent: 'a', of: 'plan', after: ['plan'] },
    { id: 'c2', role: 'critic', agent: 'a', of: 'plan', after: ['plan'] },
    { id: 'c3', role: 'critic', agent: 'a', of: 'plan', after: ['plan'] },
  ]
  const outcomes = await runIteration(
    makeDef(2), nodes, { plan: null, iteration: 0, feedback: null }, { registry })
  expect(outcomes.map((o) => o.nodeId)).toEqual(['plan', 'c1', 'c2', 'c3'])
  expect(active.max).toBeLessThanOrEqual(2)
  expect(active.max).toBeGreaterThan(1) // critics did overlap
})

test('later layers see earlier outcomes (critic gets target output)', async () => {
  const registry = createRegistry()
  const prompts: string[] = []
  registry.register({
    name: 'probe',
    async invoke(req) {
      prompts.push(req.prompt)
      return { output: 'WORK-MARKER', costUsd: 0, tokens: 0, durationMs: 1 }
    },
  })
  const nodes: NodeDef[] = [
    { id: 'do', role: 'executor', agent: 'a' },
    { id: 'c', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
  ]
  await runIteration(makeDef(), nodes, { plan: null, iteration: 1, feedback: null }, { registry })
  expect(prompts[1]).toContain('WORK-MARKER')
})

test('onNode callback fires per completed node', async () => {
  const registry = createRegistry()
  registry.register({
    name: 'probe',
    invoke: async () => ({ output: 'x', costUsd: 0, tokens: 0, durationMs: 1 }),
  })
  const seen: string[] = []
  await runIteration(
    makeDef(), [{ id: 'do', role: 'executor', agent: 'a' }],
    { plan: null, iteration: 1, feedback: null }, { registry },
    (o) => seen.push(o.nodeId))
  expect(seen).toEqual(['do'])
})

test('concurrency 0 or negative is clamped to sequential execution, not a crash', async () => {
  const log: string[] = []
  const active = { now: 0, max: 0 }
  const registry = createRegistry()
  registry.register(probeAdapter(log, active))
  const nodes: NodeDef[] = [
    { id: 'e1', role: 'executor', agent: 'a' },
    { id: 'e2', role: 'executor', agent: 'a' },
  ]
  const outcomes = await runIteration(
    makeDef(0), nodes, { plan: null, iteration: 0, feedback: null }, { registry })
  expect(outcomes.map((o) => o.nodeId)).toEqual(['e1', 'e2'])
  expect(active.max).toBe(1)
})
