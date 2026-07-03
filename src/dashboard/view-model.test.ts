import { expect, test } from 'vitest'
import type { JournalEvent, LoopDef } from '../core/types.js'
import { buildViewModel } from './view-model.js'

function ev(type: JournalEvent['type'], data: Record<string, unknown>, ts = 0): JournalEvent {
  return { ts, type, data }
}

test('empty journal yields an empty, running model', () => {
  const m = buildViewModel([])
  expect(m).toMatchObject({
    runId: 'unknown', name: '', status: 'running', nodes: [], edges: [], plans: [],
    totals: { costUsd: 0, iteration: 0, replans: 0, maxCostUsd: undefined, maxIterations: undefined },
  })
})

test('run_start seeds identity; node lifecycle drives status', () => {
  const events: JournalEvent[] = [
    ev('run_start', { runId: 'run-1', name: 'demo', goal: 'ship it' }),
    ev('node_start', { nodeId: 'plan', role: 'planner', iteration: 0 }),
    ev('node_end', { nodeId: 'plan', role: 'planner', iteration: 0, costUsd: 0.01, verdict: null, output: 'do X then Y' }),
    ev('node_start', { nodeId: 'do', role: 'executor', iteration: 1 }),
    ev('node_end', {
      nodeId: 'do', role: 'executor', iteration: 1, costUsd: 0.2, verdict: null, output: 'did it',
    }),
    ev('node_start', { nodeId: 'check', role: 'critic', iteration: 1 }),
    ev('node_end', {
      nodeId: 'check', role: 'critic', iteration: 1, costUsd: 0.05,
      verdict: { node: 'do', status: 'pass', evidence: 'looks right' }, output: 'PASS',
    }),
  ]
  const m = buildViewModel(events)
  expect(m.runId).toBe('run-1')
  expect(m.name).toBe('demo')
  const check = m.nodes.find((n) => n.id === 'check')!
  expect(check.status).toBe('pass')
  expect(check.iterations).toEqual([
    { iteration: 1, status: 'pass', evidence: 'looks right', costUsd: 0.05, tokens: 0, durationMs: undefined, output: 'PASS' },
  ])
  const doNode = m.nodes.find((n) => n.id === 'do')!
  expect(doNode.status).toBe('done') // no verdict on an executor node_end
})

test('a started-but-not-yet-ended node is running', () => {
  const m = buildViewModel([
    ev('run_start', { runId: 'r', name: 'n', goal: 'g' }),
    ev('node_start', { nodeId: 'do', role: 'executor', iteration: 1 }),
  ])
  expect(m.nodes.find((n) => n.id === 'do')!.status).toBe('running')
})

test('node_skipped marks a node skipped and does not count as cost', () => {
  const m = buildViewModel([
    ev('run_start', { runId: 'r', name: 'n', goal: 'g' }),
    ev('node_start', { nodeId: 'do', role: 'executor', iteration: 1 }),
    ev('node_skipped', { nodeId: 'do', role: 'executor', iteration: 1 }),
  ])
  const n = m.nodes.find((n) => n.id === 'do')!
  expect(n.status).toBe('skipped')
  expect(n.costUsd).toBe(0)
})

test('totals track iteration/cost/replans and status transitions on verified/halt', () => {
  const verified = buildViewModel([
    ev('run_start', { runId: 'r', name: 'n', goal: 'g' }),
    ev('iteration_end', { iteration: 1, costUsd: 0.3 }),
    ev('replan', { replans: 1, feedback: 'try again' }),
    ev('iteration_end', { iteration: 2, costUsd: 0.5 }),
    ev('verified', { reason: 'all verifiers passed', costUsd: 0.5 }),
  ])
  expect(verified.status).toBe('verified')
  expect(verified.reason).toBe('all verifiers passed')
  expect(verified.totals).toMatchObject({ iteration: 2, costUsd: 0.5, replans: 1 })

  const halted = buildViewModel([
    ev('run_start', { runId: 'r', name: 'n', goal: 'g' }),
    ev('halt', { reason: 'rail breached (cost): over budget', costUsd: 1.5 }),
  ])
  expect(halted.status).toBe('halted')
  expect(halted.totals.costUsd).toBe(1.5)
})

test('planner node_end entries become plan versions numbered by replans-so-far', () => {
  const m = buildViewModel([
    ev('run_start', { runId: 'r', name: 'n', goal: 'g' }),
    ev('node_end', { nodeId: 'plan', role: 'planner', iteration: 0, costUsd: 0, verdict: null, output: 'v1' }),
    ev('replan', { replans: 1, feedback: 'nope' }),
    ev('node_end', { nodeId: 'plan', role: 'planner', iteration: 0, costUsd: 0, verdict: null, output: 'v2' }),
  ])
  expect(m.plans).toEqual([
    { replan: 0, iteration: 0, nodeId: 'plan', output: 'v1' },
    { replan: 1, iteration: 0, nodeId: 'plan', output: 'v2' },
  ])
})

test('a loaded LoopDef seeds pending nodes, edges (after + of), and rail maxes', () => {
  const def: LoopDef = {
    name: 'demo', goal: 'g', agents: {},
    nodes: [
      { id: 'plan', role: 'planner' },
      { id: 'do', role: 'executor', after: ['plan'] },
      { id: 'check', role: 'critic', of: 'do', after: ['do'] },
    ],
    rails: { maxIterations: 5, maxCostUsd: 2.5 },
    verdictPolicy: { kind: 'all-pass' },
  }
  const m = buildViewModel([ev('run_start', { runId: 'r', name: 'n', goal: 'g' })], def)
  expect(m.nodes.map((n) => n.id).sort()).toEqual(['check', 'do', 'plan'])
  expect(m.nodes.every((n) => n.status === 'pending')).toBe(true)
  expect(m.edges).toEqual(
    expect.arrayContaining([['plan', 'do'], ['do', 'check']]),
  )
  expect(m.edges).toHaveLength(2) // 'of' and the explicit 'after' on check collapse to one edge, deduped
  expect(m.totals).toMatchObject({ maxCostUsd: 2.5, maxIterations: 5 })
})

test('a node observed in the journal but absent from a stale def is still listed, edge-less', () => {
  const def: LoopDef = {
    name: 'demo', goal: 'g', agents: {},
    nodes: [{ id: 'plan', role: 'planner' }],
    rails: { maxIterations: 5, maxCostUsd: 2.5 },
    verdictPolicy: { kind: 'all-pass' },
  }
  const m = buildViewModel([
    ev('run_start', { runId: 'r', name: 'n', goal: 'g' }),
    ev('node_start', { nodeId: 'ghost', role: 'executor', iteration: 1 }),
  ], def)
  expect(m.nodes.map((n) => n.id).sort()).toEqual(['ghost', 'plan'])
  expect(m.nodes.find((n) => n.id === 'ghost')!.status).toBe('running')
})

test('node_start resets the streaming buffer and node_progress appends to it in order', () => {
  const m = buildViewModel([
    ev('run_start', { runId: 'r', name: 'n', goal: 'g' }),
    ev('node_start', { nodeId: 'do', role: 'executor', iteration: 1 }),
    ev('node_progress', { nodeId: 'do', role: 'executor', iteration: 1, chunk: 'work' }),
    ev('node_progress', { nodeId: 'do', role: 'executor', iteration: 1, chunk: 'ing...' }),
  ])
  expect(m.nodes.find((n) => n.id === 'do')!.streamingOutput).toBe('working...')
})

test('a fresh node_start clears whatever streamed on a previous run of the same node id', () => {
  const m = buildViewModel([
    ev('run_start', { runId: 'r', name: 'n', goal: 'g' }),
    ev('node_start', { nodeId: 'do', role: 'executor', iteration: 1 }),
    ev('node_progress', { nodeId: 'do', role: 'executor', iteration: 1, chunk: 'stale from iteration 1' }),
    ev('node_end', { nodeId: 'do', role: 'executor', iteration: 1, costUsd: 0, verdict: null, output: 'done-1' }),
    ev('node_start', { nodeId: 'do', role: 'executor', iteration: 2 }),
  ])
  expect(m.nodes.find((n) => n.id === 'do')!.streamingOutput).toBe('')
})

test('a def-seeded node carries its agent key and model from the loopfile', () => {
  const def: LoopDef = {
    name: 'demo', goal: 'g',
    agents: { worker: { adapter: 'claude-code', model: 'claude-opus-4' } },
    nodes: [{ id: 'do', role: 'executor', agent: 'worker' }],
    rails: { maxIterations: 5, maxCostUsd: 2.5 },
    verdictPolicy: { kind: 'all-pass' },
  }
  const m = buildViewModel([ev('run_start', { runId: 'r', name: 'n', goal: 'g' })], def)
  const node = m.nodes.find((n) => n.id === 'do')!
  expect(node.agent).toBe('worker')
  expect(node.model).toBe('claude-opus-4')
})

test('an observed-only node (no loopfile loaded) has no agent or model', () => {
  const m = buildViewModel([
    ev('run_start', { runId: 'r', name: 'n', goal: 'g' }),
    ev('node_start', { nodeId: 'do', role: 'executor', iteration: 1 }),
  ])
  const node = m.nodes.find((n) => n.id === 'do')!
  expect(node.agent).toBeUndefined()
  expect(node.model).toBeUndefined()
})

test('node_end tokens accumulate into DashboardNode.tokens and the matching NodeIterationRecord.tokens', () => {
  const m = buildViewModel([
    ev('run_start', { runId: 'r', name: 'n', goal: 'g' }),
    ev('node_start', { nodeId: 'do', role: 'executor', iteration: 1 }),
    ev('node_end', {
      nodeId: 'do', role: 'executor', iteration: 1, costUsd: 0.1, tokens: 1234, verdict: null, output: 'did it',
    }),
  ])
  const node = m.nodes.find((n) => n.id === 'do')!
  expect(node.tokens).toBe(1234)
  expect(node.iterations).toEqual([
    { iteration: 1, status: 'done', evidence: undefined, costUsd: 0.1, tokens: 1234, durationMs: undefined, output: 'did it' },
  ])
})

test('DashboardTotals.tokens sums tokens across multiple nodes and iterations', () => {
  const m = buildViewModel([
    ev('run_start', { runId: 'r', name: 'n', goal: 'g' }),
    ev('node_start', { nodeId: 'do', role: 'executor', iteration: 1 }),
    ev('node_end', { nodeId: 'do', role: 'executor', iteration: 1, costUsd: 0.1, tokens: 100, verdict: null, output: 'a' }),
    ev('node_start', { nodeId: 'do', role: 'executor', iteration: 2 }),
    ev('node_end', { nodeId: 'do', role: 'executor', iteration: 2, costUsd: 0.1, tokens: 50, verdict: null, output: 'b' }),
    ev('node_start', { nodeId: 'check', role: 'critic', iteration: 1 }),
    ev('node_end', {
      nodeId: 'check', role: 'critic', iteration: 1, costUsd: 0.05, tokens: 25,
      verdict: { node: 'do', status: 'pass', evidence: 'looks right' }, output: 'PASS',
    }),
  ])
  expect(m.totals.tokens).toBe(175)
})

test('totals.costUsd updates live per node_end, before iteration_end fires (matching tokens cadence)', () => {
  const midIteration = buildViewModel([
    ev('run_start', { runId: 'r', name: 'n', goal: 'g' }),
    ev('node_start', { nodeId: 'do', role: 'executor', iteration: 1 }),
    ev('node_end', {
      nodeId: 'do', role: 'executor', iteration: 1, costUsd: 0.2, tokens: 500, verdict: null, output: 'did it',
    }),
    // iteration_end has NOT fired yet -- costUsd must already be live, not frozen at 0
  ])
  expect(midIteration.totals.costUsd).toBe(0.2)
  expect(midIteration.totals.tokens).toBe(500) // same cadence as costUsd

  const afterIterationEnd = buildViewModel([
    ev('run_start', { runId: 'r', name: 'n', goal: 'g' }),
    ev('node_start', { nodeId: 'do', role: 'executor', iteration: 1 }),
    ev('node_end', {
      nodeId: 'do', role: 'executor', iteration: 1, costUsd: 0.2, tokens: 500, verdict: null, output: 'did it',
    }),
    ev('iteration_end', { iteration: 1, costUsd: 0.2 }),
  ])
  expect(afterIterationEnd.totals.costUsd).toBe(0.2) // still correct once settled -- no regression
})

test('totals.costUsd reconciles up to the guard-authoritative total if it ever reports ahead of the node_end sum', () => {
  const m = buildViewModel([
    ev('run_start', { runId: 'r', name: 'n', goal: 'g' }),
    ev('node_end', { nodeId: 'do', role: 'executor', iteration: 1, costUsd: 0.1, verdict: null, output: 'did it' }),
    // guard.spentUsd reflects 0.15 here (e.g. cost the view-model can't otherwise see) -- total must never be LESS than this
    ev('iteration_end', { iteration: 1, costUsd: 0.15 }),
  ])
  expect(m.totals.costUsd).toBe(0.15)
})

test('a node_end with no tokens field does not break accumulation for other nodes', () => {
  const m = buildViewModel([
    ev('run_start', { runId: 'r', name: 'n', goal: 'g' }),
    ev('node_start', { nodeId: 'plan', role: 'planner', iteration: 0 }),
    ev('node_end', { nodeId: 'plan', role: 'planner', iteration: 0, costUsd: 0, verdict: null, output: 'v1' }),
    ev('node_start', { nodeId: 'do', role: 'executor', iteration: 1 }),
    ev('node_end', {
      nodeId: 'do', role: 'executor', iteration: 1, costUsd: 0.1, tokens: 0, verdict: null, output: 'did it',
    }),
    ev('node_start', { nodeId: 'check', role: 'critic', iteration: 1 }),
    ev('node_end', {
      nodeId: 'check', role: 'critic', iteration: 1, costUsd: 0.05, tokens: 75,
      verdict: { node: 'do', status: 'pass', evidence: 'looks right' }, output: 'PASS',
    }),
  ])
  expect(m.nodes.find((n) => n.id === 'plan')!.tokens).toBe(0)
  expect(m.nodes.find((n) => n.id === 'do')!.tokens).toBe(0)
  expect(m.nodes.find((n) => n.id === 'check')!.tokens).toBe(75)
  expect(m.totals.tokens).toBe(75)
})
