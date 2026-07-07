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

test('critic with "of" but no "after" still runs after its target and sees its output', async () => {
  const registry = createRegistry()
  const prompts: string[] = []
  registry.register({
    name: 'probe',
    async invoke(req) {
      prompts.push(req.prompt)
      return { output: 'DRAFT-MARKER', costUsd: 0, tokens: 0, durationMs: 1 }
    },
  })
  const nodes: NodeDef[] = [
    { id: 'crit', role: 'critic', agent: 'a', of: 'draft' }, // no after edge
    { id: 'draft', role: 'executor', agent: 'a' },
  ]
  const outcomes = await runIteration(
    makeDef(), nodes, { plan: null, iteration: 1, feedback: null }, { registry })
  expect(outcomes.map((o) => o.nodeId)).toEqual(['draft', 'crit'])
  expect(prompts[1]).toContain('DRAFT-MARKER')
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

test('node weight is stamped onto its verdict', async () => {
  const registry = createRegistry()
  registry.register({
    name: 'probe',
    invoke: async () => ({
      output: 'VERDICT: fail\nEVIDENCE: nope', costUsd: 0, tokens: 0, durationMs: 1,
    }),
  })
  const outs = await runIteration(
    makeDef(), [{ id: 'c', role: 'critic', agent: 'a', weight: 2 }],
    { plan: null, iteration: 1, feedback: null }, { registry })
  expect(outs[0].verdict?.weight).toBe(2)
})

test('onChunk is labeled per node id even when nodes run concurrently', async () => {
  const registry = createRegistry()
  registry.register({
    name: 'probe',
    async invoke(req, onChunk) {
      onChunk?.(`chunk[${req.prompt}]`)
      return { output: 'x', costUsd: 0, tokens: 0, durationMs: 1 }
    },
  })
  const seen: Record<string, string> = {}
  await runIteration(
    makeDef(2),
    [
      { id: 'n1', role: 'executor', agent: 'a', prompt: 'UNIQUE-N1-MARKER' },
      { id: 'n2', role: 'executor', agent: 'a', prompt: 'UNIQUE-N2-MARKER' },
    ],
    { plan: null, iteration: 1, feedback: null }, { registry },
    undefined, undefined, undefined,
    (nodeId, chunk) => { seen[nodeId] = chunk })
  expect(seen.n1).toContain('UNIQUE-N1-MARKER')
  expect(seen.n2).toContain('UNIQUE-N2-MARKER')
})

test('runIteration works unchanged when onChunk is omitted', async () => {
  const registry = createRegistry()
  registry.register({ name: 'probe', invoke: async () => ({ output: 'x', costUsd: 0, tokens: 0, durationMs: 1 }) })
  const outcomes = await runIteration(
    makeDef(), [{ id: 'do', role: 'executor', agent: 'a' }],
    { plan: null, iteration: 1, feedback: null }, { registry })
  expect(outcomes.map((o) => o.nodeId)).toEqual(['do'])
})

test('onPermission is labeled per node id even when nodes run concurrently', async () => {
  const registry = createRegistry()
  registry.register({
    name: 'probe',
    async invoke(req, _onChunk, onPermission) {
      await onPermission?.({ question: `q-for-${req.prompt}`, answer: (a) => (a ? 'y' : 'n') })
      return { output: 'x', costUsd: 0, tokens: 0, durationMs: 1 }
    },
  })
  const seen: Record<string, string> = {}
  await runIteration(
    makeDef(2),
    [
      { id: 'n1', role: 'executor', agent: 'a', prompt: 'UNIQUE-N1-MARKER' },
      { id: 'n2', role: 'executor', agent: 'a', prompt: 'UNIQUE-N2-MARKER' },
    ],
    { plan: null, iteration: 1, feedback: null }, { registry },
    undefined, undefined, undefined, undefined,
    async (nodeId, req) => { seen[nodeId] = req.question; return true })
  expect(seen.n1).toContain('UNIQUE-N1-MARKER')
  expect(seen.n2).toContain('UNIQUE-N2-MARKER')
})

// Probe panels (EFF-5): a follower carrying probeOf is skipped when its
// leader has already FAILED this iteration under all-pass - the aggregate is
// determined, the follower cannot change the iterate/stop decision. Never
// skipped on the pass path: verified still requires every clone to run.
test('probe follower is skipped when its leader failed (all-pass)', async () => {
  const registry = createRegistry()
  let invocations = 0
  registry.register({
    name: 'probe',
    async invoke(req) {
      invocations++
      const critic = req.prompt.includes('VERDICT:')
      return {
        output: critic ? 'VERDICT: fail\nEVIDENCE: broken' : 'built the thing',
        costUsd: 0, tokens: 0, durationMs: 1,
      }
    },
  })
  const nodes: NodeDef[] = [
    { id: 'do', role: 'executor', agent: 'a' },
    { id: 'c@1', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
    { id: 'c@2', role: 'critic', agent: 'a', of: 'do', after: ['do', 'c@1'], probeOf: 'c@1' },
    { id: 'c@3', role: 'critic', agent: 'a', of: 'do', after: ['do', 'c@1'], probeOf: 'c@1' },
  ]
  const outcomes = await runIteration(
    makeDef(), nodes, { plan: null, iteration: 1, feedback: null }, { registry })
  // executor + leader only - the two followers never dispatched
  expect(invocations).toBe(2)
  expect(outcomes.map((o) => o.nodeId)).toEqual(['do', 'c@1'])
})

test('probe followers all run when the leader passes - the pass path is never thinned', async () => {
  const registry = createRegistry()
  let invocations = 0
  registry.register({
    name: 'probe',
    async invoke(req) {
      invocations++
      const critic = req.prompt.includes('VERDICT:')
      return {
        output: critic ? 'VERDICT: pass\nEVIDENCE: solid' : 'built the thing',
        costUsd: 0, tokens: 0, durationMs: 1,
      }
    },
  })
  const nodes: NodeDef[] = [
    { id: 'do', role: 'executor', agent: 'a' },
    { id: 'c@1', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
    { id: 'c@2', role: 'critic', agent: 'a', of: 'do', after: ['do', 'c@1'], probeOf: 'c@1' },
    { id: 'c@3', role: 'critic', agent: 'a', of: 'do', after: ['do', 'c@1'], probeOf: 'c@1' },
  ]
  const outcomes = await runIteration(
    makeDef(), nodes, { plan: null, iteration: 1, feedback: null }, { registry })
  expect(invocations).toBe(4)
  expect(outcomes.map((o) => o.nodeId).sort()).toEqual(['c@1', 'c@2', 'c@3', 'do'])
})

test('probe follower still runs when the leader ERRORS - only a definite fail skips', async () => {
  const registry = createRegistry()
  let critics = 0
  registry.register({
    name: 'probe',
    async invoke(req) {
      const critic = req.prompt.includes('VERDICT:')
      if (critic) critics++
      return {
        output: critic
          ? (critics === 1 ? 'VERDICT: error\nEVIDENCE: adapter hiccup' : 'VERDICT: pass\nEVIDENCE: ok')
          : 'built the thing',
        costUsd: 0, tokens: 0, durationMs: 1,
      }
    },
  })
  const nodes: NodeDef[] = [
    { id: 'do', role: 'executor', agent: 'a' },
    { id: 'c@1', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
    { id: 'c@2', role: 'critic', agent: 'a', of: 'do', after: ['do', 'c@1'], probeOf: 'c@1' },
  ]
  const outcomes = await runIteration(
    makeDef(), nodes, { plan: null, iteration: 1, feedback: null }, { registry })
  expect(outcomes.map((o) => o.nodeId)).toEqual(['do', 'c@1', 'c@2'])
})
