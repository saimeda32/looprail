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

// Real halt caught live, a second time: a planner used `agent: worker` on
// every attempt but never once declared a `worker` agent, burning both
// replans and halting on the same structural error 3 times. Root cause was
// this instruction's OWN example using agent: worker with no matching
// agents: entry - the model had nothing but an incomplete template to copy.
test('the graph example declares every agent it references, and the instructions call out that an undeclared agent name is invalid', () => {
  const node: NodeDef = { id: 'plan', role: 'planner', agent: 'a', generates: 'graph' }
  const ctx = composeContext(def, node, { plan: null, iteration: 0, feedback: null }, new Map())
  expect(ctx).toContain('agents:\n  worker: { adapter: copilot-cli, model: claude-sonnet-5 }')
  expect(ctx.toLowerCase()).toContain('never reference a name without also declaring it')
  expect(ctx).toContain('is invalid and will be rejected')
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


// EFF-2: lineage-scoped feedback - a node sees only failures from its own
// descendants; an independent branch gets none, keeping its prompt stable.
test('a node sees only feedback from its own descendants, not a sibling branch', () => {
  const twoBranch: LoopDef = {
    ...def,
    nodes: [
      { id: 'doA', role: 'executor', agent: 'a' },
      { id: 'critA', role: 'critic', agent: 'a', of: 'doA', after: ['doA'] },
      { id: 'doB', role: 'executor', agent: 'a' },
      { id: 'critB', role: 'critic', agent: 'a', of: 'doB', after: ['doB'] },
    ],
  }
  const st: RunState = {
    plan: null, iteration: 2, feedback: '[critA] fix A',
    feedbackBySource: [{ nodeId: 'critA', evidence: 'fix A' }],
  }
  const aCtx = composeContext(twoBranch, twoBranch.nodes[0], st, new Map())
  const bCtx = composeContext(twoBranch, twoBranch.nodes[2], st, new Map())
  expect(aCtx).toContain('fix A')             // doA's descendant critA failed
  expect(bCtx).not.toContain('fix A')         // doB's lineage is clean -> no feedback section
  expect(bCtx).not.toContain('Feedback from last iteration')
})

// EFF-3: a re-running executor gets its own previous attempt to revise,
// with a minimal-change instruction - so it patches instead of rebuilding.
test('a re-running executor receives its prior attempt and a minimal-change instruction', () => {
  const node: NodeDef = { id: 'do', role: 'executor', agent: 'a' }
  const st: RunState = {
    plan: null, iteration: 2, feedback: '[crit] missing X',
    feedbackBySource: [{ nodeId: 'do', evidence: 'missing X' }],
    priorOutputs: { do: 'the big artifact I built last time' },
  }
  const ctx = composeContext(def, node, st, new Map())
  expect(ctx).toContain('# Your previous attempt')
  expect(ctx).toContain('the big artifact I built last time')
  expect(ctx).toContain('minimal change')
})

test('a node with NO scoped feedback gets no prior-attempt section (stays cache-stable)', () => {
  const node: NodeDef = { id: 'do', role: 'executor', agent: 'a' }
  const st: RunState = {
    plan: null, iteration: 2, feedback: null,
    feedbackBySource: [{ nodeId: 'other', evidence: 'unrelated' }],
    priorOutputs: { do: 'prior' },
  }
  const ctx = composeContext(def, node, st, new Map())
  expect(ctx).not.toContain('# Your previous attempt')
  expect(ctx).not.toContain('Feedback from last iteration')
})
