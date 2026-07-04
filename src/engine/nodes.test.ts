import { describe, expect, test } from 'vitest'
import { executeNode, type EngineDeps } from './nodes.js'
import { MockAdapter } from '../adapters/mock.js'
import { createRegistry } from '../adapters/registry.js'
import type { LoopDef, NodeDef, NodeOutcome } from '../core/types.js'
import type { RunState } from '../core/context.js'

const def: LoopDef = {
  name: 't', goal: 'g',
  agents: { a: { adapter: 'mock' } },
  nodes: [],
  rails: { maxIterations: 3, maxCostUsd: 1 },
  verdictPolicy: { kind: 'all-pass' },
}
const state: RunState = { plan: null, iteration: 1, feedback: null }
const none = new Map<string, NodeOutcome>()

const depsWith = (mock: MockAdapter): EngineDeps => {
  const registry = createRegistry()
  registry.register(mock)
  return { registry }
}

test('executor returns output with no verdict', async () => {
  const deps = depsWith(new MockAdapter([{ output: 'did the work', costUsd: 0.02 }]))
  const out = await executeNode(def, { id: 'do', role: 'executor', agent: 'a' }, state, none, deps)
  expect(out).toMatchObject({ nodeId: 'do', output: 'did the work', verdict: null, costUsd: 0.02 })
})

test('critic parses verdict from output', async () => {
  const deps = depsWith(new MockAdapter([{ output: 'VERDICT: fail\nEVIDENCE: broken' }]))
  const outcomes = new Map<string, NodeOutcome>([['do', {
    nodeId: 'do', role: 'executor', output: 'the work', verdict: null,
    costUsd: 0, tokens: 0, durationMs: 0,
  }]])
  const out = await executeNode(def, { id: 'c', role: 'critic', agent: 'a', of: 'do' }, state, outcomes, deps)
  expect(out.verdict).toMatchObject({ status: 'fail', evidence: 'broken' })
})

test('unparseable verdict re-asks once, then fails', async () => {
  const mock = new MockAdapter([{ output: 'looks fine to me' }, { output: 'still chatting' }])
  const out = await executeNode(def, { id: 'c', role: 'critic', agent: 'a' }, state, none, depsWith(mock))
  expect(mock.calls.length).toBe(2)
  expect(mock.calls[1].prompt).toContain('VERDICT:')
  expect(out.verdict).toMatchObject({ status: 'fail', evidence: 'verdict unparseable' })
})

test('judge below threshold fails even when it says pass', async () => {
  const deps = depsWith(new MockAdapter([{ output: 'VERDICT: pass\nSCORE: 0.6\nEVIDENCE: ok' }]))
  const node: NodeDef = { id: 'j', role: 'judge', agent: 'a', threshold: 0.85 }
  const out = await executeNode(def, node, state, none, deps)
  expect(out.verdict!.status).toBe('fail')
  expect(out.verdict!.evidence).toContain('threshold')
})

test('tester passes on exit 0 and fails with output evidence otherwise', async () => {
  const deps: EngineDeps = { registry: createRegistry() }
  const pass = await executeNode(def, { id: 't1', role: 'tester', run: 'true' }, state, none, deps)
  expect(pass.verdict!.status).toBe('pass')
  const fail = await executeNode(
    def, { id: 't2', role: 'tester', run: 'echo boom >&2; exit 1' }, state, none, deps)
  expect(fail.verdict!.status).toBe('fail')
  expect(fail.verdict!.evidence).toContain('boom')
})

test('gate consults the handler; missing handler is an error verdict', async () => {
  const registry = createRegistry()
  const ok = await executeNode(
    def, { id: 'g', role: 'gate' }, state, none, { registry, gate: async () => true })
  expect(ok.verdict!.status).toBe('pass')
  const missing = await executeNode(def, { id: 'g', role: 'gate' }, state, none, { registry })
  expect(missing.verdict!.status).toBe('error')
})

test('adapter throw becomes an error verdict', async () => {
  const registry = createRegistry()
  const mock = new MockAdapter([])
  registry.register(mock)
  const out = await executeNode(
    def, { id: 'c', role: 'critic', agent: 'a' }, state, none,
    { registry, sleep: async () => {} })
  expect(out.verdict!.status).toBe('error')
  expect(out.verdict!.evidence).toContain('exhausted')
  // transient - must NOT be tagged infra: or config:, so the router keeps
  // softening it to a failure and iterating rather than halting loudly
  expect(out.verdict!.evidence).not.toMatch(/^(infra|config):/)
})

test('infra error becomes an infra-tagged error verdict', async () => {
  const registry = createRegistry()
  registry.register({
    name: 'mock',
    invoke: async () => { throw new Error('401 unauthorized') },
  })
  const out = await executeNode(
    def, { id: 'c', role: 'critic', agent: 'a' }, state, none,
    { registry, sleep: async () => {} })
  expect(out.verdict).toMatchObject({ status: 'error' })
  expect(out.verdict!.evidence).toMatch(/^infra:/)
  expect(out.verdict!.evidence).toContain('looprail doctor')
})

test('executor with unknown agent key resolves with a config-tagged error verdict, not a rejection', async () => {
  const deps = depsWith(new MockAdapter([{ output: 'unused' }]))
  const out = await executeNode(
    def, { id: 'do', role: 'executor', agent: 'nope' }, state, none, deps)
  expect(out.verdict!.status).toBe('error')
  expect(out.verdict!.evidence).toMatch(/^config:/)
})

test('critic whose adapter is not registered resolves with a config-tagged error verdict', async () => {
  const registry = createRegistry()
  const out = await executeNode(
    def, { id: 'c', role: 'critic', agent: 'a' }, state, none, { registry })
  expect(out.verdict!.status).toBe('error')
  expect(out.verdict!.evidence).toMatch(/^config:/)
})

test('gate handler that throws resolves with a config-tagged error verdict', async () => {
  const registry = createRegistry()
  const out = await executeNode(
    def, { id: 'g', role: 'gate' }, state, none, {
      registry,
      gate: async () => { throw new Error('boom') },
    })
  expect(out.verdict!.status).toBe('error')
  expect(out.verdict!.evidence).toMatch(/^config:/)
})

test('gate node with no gate handler configured resolves with a config-tagged error verdict', async () => {
  const registry = createRegistry()
  const out = await executeNode(def, { id: 'g', role: 'gate' }, state, none, { registry })
  expect(out.verdict!.status).toBe('error')
  expect(out.verdict!.evidence).toMatch(/^config:/)
})

test('tester whose shell command throws resolves with a config-tagged error verdict', async () => {
  const registry = createRegistry()
  const out = await executeNode(
    def, { id: 't', role: 'tester' }, state, none, { registry })
  expect(out.verdict!.status).toBe('error')
  expect(out.verdict!.evidence).toMatch(/^config:/)
})

test('judge with threshold but no SCORE line fails with explicit evidence', async () => {
  const deps = depsWith(new MockAdapter([{ output: 'VERDICT: pass\nEVIDENCE: ok' }]))
  const node: NodeDef = { id: 'j', role: 'judge', agent: 'a', threshold: 0.85 }
  const out = await executeNode(def, node, state, none, deps)
  expect(out.verdict!.status).toBe('fail')
  expect(out.verdict!.evidence).toContain('no usable SCORE')
})

test('judge with threshold and malformed SCORE fails, does not verify on NaN', async () => {
  const deps = depsWith(new MockAdapter([{ output: 'VERDICT: pass\nSCORE: 0..7\nEVIDENCE: great' }]))
  const node: NodeDef = { id: 'j', role: 'judge', agent: 'a', threshold: 0.85 }
  const out = await executeNode(def, node, state, none, deps)
  expect(out.verdict!.status).toBe('fail')
  expect(out.verdict!.evidence).toContain('no usable SCORE')
})

test('critic whose "of" target has no outcome errors instead of reviewing nothing', async () => {
  const mock = new MockAdapter([{ output: 'VERDICT: pass\nEVIDENCE: unused' }])
  const node: NodeDef = { id: 'c', role: 'critic', agent: 'a', of: 'ghost' }
  const out = await executeNode(def, node, state, none, depsWith(mock))
  expect(out.verdict!.status).toBe('error')
  expect(out.verdict!.evidence).toMatch(/^config:/)
  expect(out.verdict!.evidence).toContain('"ghost"')
  expect(mock.calls).toHaveLength(0) // never composed an empty review context
})

test('adapter receives model and command from the AgentDef', async () => {
  const mock = new MockAdapter([{ output: 'done' }])
  const deps = depsWith(mock)
  const withModel: LoopDef = {
    ...def,
    agents: { a: { adapter: 'mock', model: 'haiku', command: 'echo hi' } },
  }
  await executeNode(withModel, { id: 'do', role: 'executor', agent: 'a' }, state, none, deps)
  expect(mock.calls[0]).toMatchObject({ model: 'haiku', command: 'echo hi' })
})

test('onChunk is forwarded to the adapter for an executor node', async () => {
  const seen: string[] = []
  const registry = createRegistry()
  registry.register({
    name: 'mock',
    async invoke(_req, onChunk) {
      onChunk?.('working')
      onChunk?.('...')
      return { output: 'did the work', costUsd: 0, tokens: 0, durationMs: 1 }
    },
  })
  const out = await executeNode(
    def, { id: 'do', role: 'executor', agent: 'a' }, state, none, { registry },
    (c) => seen.push(c))
  expect(seen).toEqual(['working', '...'])
  expect(out.output).toBe('did the work')
})

test('a tester node never calls onChunk (no adapter is invoked)', async () => {
  const seen: string[] = []
  const deps: EngineDeps = { registry: createRegistry() }
  await executeNode(def, { id: 't1', role: 'tester', run: 'true' }, state, none, deps, (c) => seen.push(c))
  expect(seen).toEqual([])
})
