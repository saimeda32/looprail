import { expect, test } from 'vitest'
import { composeContext, type RunState } from './context.js'
import type { LoopDef, NodeDef, NodeOutcome } from './types.js'

const def: LoopDef = {
  name: 't', goal: 'Fix the flaky tests',
  agents: { a: { adapter: 'mock' } },
  nodes: [],
  rails: { maxIterations: 3, maxCostUsd: 1 },
  verdictPolicy: { kind: 'all-pass' },
}
const state: RunState = { plan: 'step 1: reproduce', iteration: 2, feedback: 'test X still fails' }
const outcome = (nodeId: string, output: string): NodeOutcome =>
  ({ nodeId, role: 'executor', output, verdict: null, costUsd: 0, tokens: 0, durationMs: 0 })

test('executor context includes goal, plan, and feedback', () => {
  const node: NodeDef = { id: 'do', role: 'executor', agent: 'a' }
  const ctx = composeContext(def, node, state, new Map())
  expect(ctx).toContain('Fix the flaky tests')
  expect(ctx).toContain('step 1: reproduce')
  expect(ctx).toContain('test X still fails')
})

test('critic context includes target output and VERDICT format', () => {
  const node: NodeDef = { id: 'crit', role: 'critic', agent: 'a', of: 'do', prompt: 'Refute it.' }
  const ctx = composeContext(def, node, state, new Map([['do', outcome('do', 'THE WORK')]]))
  expect(ctx).toContain('THE WORK')
  expect(ctx).toContain('Refute it.')
  expect(ctx).toContain('VERDICT:')
})

test('judge context includes dependency outputs and threshold', () => {
  const node: NodeDef = {
    id: 'judge', role: 'judge', agent: 'a',
    after: ['do'], rubric: 'Groundedness matters', threshold: 0.85,
  }
  const ctx = composeContext(def, node, state, new Map([['do', outcome('do', 'THE WORK')]]))
  expect(ctx).toContain('THE WORK')
  expect(ctx).toContain('Groundedness matters')
  expect(ctx).toContain('0.85')
  expect(ctx).toContain('SCORE:')
})

test('gate context includes the work being approved', () => {
  const node: NodeDef = { id: 'g', role: 'gate', after: ['do'] }
  const ctx = composeContext(def, node, state, new Map([['do', outcome('do', 'THE WORK')]]))
  expect(ctx).toContain('THE WORK')
})

test('planner context asks for a plan with success criteria', () => {
  const node: NodeDef = { id: 'plan', role: 'planner', agent: 'a' }
  const ctx = composeContext(def, node, { plan: null, iteration: 0, feedback: null }, new Map())
  expect(ctx.toLowerCase()).toContain('success criteria')
})

test('a generates:graph planner is told its reply must be only parseable YAML, unconditionally', () => {
  const node: NodeDef = { id: 'plan', role: 'planner', agent: 'a', generates: 'graph' }
  const ctx = composeContext(def, node, { plan: null, iteration: 0, feedback: null }, new Map())
  expect(ctx.toLowerCase()).toContain('only a parseable yaml document')
  expect(ctx.toLowerCase()).toContain('graph key')
})

// Real halt caught live: a model kept replying with a generic graph-library
// shape ({nodes: [...], edges: [...]}) instead of looprail's own map-keyed-
// by-id shape, exhausting its replan budget and halting without ever
// reaching review. A prose-only positive description wasn't a strong
// enough signal to override that prior - this proves the instruction now
// shows a concrete correct example AND explicitly rules out the specific
// wrong shape that actually happened, not just describes the right one.
test('a generates:graph planner sees a concrete example of the real shape and an explicit callout ruling out the nodes/edges graph-library shape', () => {
  const node: NodeDef = { id: 'plan', role: 'planner', agent: 'a', generates: 'graph' }
  const ctx = composeContext(def, node, { plan: null, iteration: 0, feedback: null }, new Map())
  expect(ctx).toContain('graph:\n  build: { role: executor, agent: worker }')
  expect(ctx.toLowerCase()).toContain('not a generic graph-library shape')
  expect(ctx.toLowerCase()).toContain('do not reply with a top-level `nodes:` list')
})

test('a plain planner (no generates:graph) never gets the YAML-only instruction', () => {
  const node: NodeDef = { id: 'plan', role: 'planner', agent: 'a' }
  const ctx = composeContext(def, node, { plan: null, iteration: 0, feedback: null }, new Map())
  expect(ctx.toLowerCase()).not.toContain('parseable yaml document')
})

test('a generates:graph planner on a replan (has both a previous plan and feedback) is offered a compact edits: block instead of a full rewrite', () => {
  const node: NodeDef = { id: 'plan', role: 'planner', agent: 'a', generates: 'graph' }
  const ctx = composeContext(def, node, state, new Map()) // state has both plan and feedback set
  expect(ctx.toLowerCase()).toContain('edits')
  expect(ctx.toLowerCase()).toContain('remove: true')
  expect(ctx.toLowerCase()).toContain('regenerate the whole graph')
})

test('a generates:graph planner on its first attempt (no prior plan yet) does not get the edits-block instruction - there is nothing to edit yet', () => {
  const node: NodeDef = { id: 'plan', role: 'planner', agent: 'a', generates: 'graph' }
  const ctx = composeContext(def, node, { plan: null, iteration: 0, feedback: null }, new Map())
  expect(ctx.toLowerCase()).not.toContain('edits')
})
