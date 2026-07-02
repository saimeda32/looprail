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
    { iteration: 1, status: 'pass', evidence: 'looks right', costUsd: 0.05, durationMs: undefined, output: 'PASS' },
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
