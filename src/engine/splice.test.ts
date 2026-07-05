import { expect, test } from 'vitest'
import { spliceFragment } from './splice.js'
import type { AgentDef } from '../core/types.js'

const WORKER: AgentDef = { adapter: 'copilot-cli', model: 'claude-sonnet-5' }

test('spliceFragment wires dependency-free root nodes to depend on the gate', () => {
  const result = spliceFragment(
    {
      nodes: [
        { id: 'build', role: 'executor', agent: 'worker' },
        { id: 'tests', role: 'tester', after: ['build'], run: 'npm test', expect: 'exit 0' },
      ],
    },
    { worker: WORKER },
    new Set(['plan', 'review', 'approve']),
    'approve',
  )
  const build = result.nodes.find((n) => n.id === 'build')!
  const tests = result.nodes.find((n) => n.id === 'tests')!
  expect(build.after).toEqual(['approve']) // root node - now depends on the gate
  expect(tests.after).toEqual(['build'])   // already had a dependency - untouched
})

test('spliceFragment merges fragment agents additively', () => {
  const result = spliceFragment(
    { nodes: [{ id: 'build', role: 'executor', agent: 'extra' }], agents: { extra: WORKER } },
    { worker: WORKER },
    new Set(['plan', 'review', 'approve']),
    'approve',
  )
  expect(result.agents).toEqual({ worker: WORKER, extra: WORKER })
})

test('spliceFragment auto-repairs a colliding agent key by renaming it and rewiring the referencing node', () => {
  const collidingAgent: AgentDef = { adapter: 'aider' }
  const result = spliceFragment(
    { nodes: [{ id: 'build', role: 'executor', agent: 'worker' }], agents: { worker: collidingAgent } },
    { worker: WORKER },
    new Set(['plan', 'review', 'approve']),
    'approve',
  )
  // original "worker" is untouched, the fragment's colliding declaration is
  // renamed to the first non-colliding suffix, and the node referencing it
  // is rewired to the new key - no LLM replan needed.
  expect(result.agents.worker).toEqual(WORKER)
  expect(result.agents['worker-2']).toEqual(collidingAgent)
  const build = result.nodes.find((n) => n.id === 'build')!
  expect(build.agent).toBe('worker-2')
})

test('spliceFragment auto-repair picks the next free suffix when an earlier one is already taken', () => {
  const collidingAgent: AgentDef = { adapter: 'aider' }
  const result = spliceFragment(
    { nodes: [{ id: 'build', role: 'executor', agent: 'worker' }], agents: { worker: collidingAgent } },
    { worker: WORKER, 'worker-2': WORKER },
    new Set(['plan', 'review', 'approve']),
    'approve',
  )
  expect(result.agents['worker-3']).toEqual(collidingAgent)
  const build = result.nodes.find((n) => n.id === 'build')!
  expect(build.agent).toBe('worker-3')
})

test('spliceFragment auto-repair avoids colliding with another key declared in the same fragment', () => {
  const collidingAgent: AgentDef = { adapter: 'aider' }
  const other: AgentDef = { adapter: 'copilot-cli' }
  const result = spliceFragment(
    {
      nodes: [{ id: 'build', role: 'executor', agent: 'worker' }],
      agents: { worker: collidingAgent, 'worker-2': other },
    },
    { worker: WORKER },
    new Set(['plan', 'review', 'approve']),
    'approve',
  )
  expect(result.agents['worker-2']).toEqual(other)
  expect(result.agents['worker-3']).toEqual(collidingAgent)
  const build = result.nodes.find((n) => n.id === 'build')!
  expect(build.agent).toBe('worker-3')
})

test('spliceFragment auto-repairs an unused colliding agent declaration (no node references it)', () => {
  const collidingAgent: AgentDef = { adapter: 'aider' }
  const result = spliceFragment(
    { nodes: [{ id: 'build', role: 'executor', agent: 'extra' }], agents: { worker: collidingAgent, extra: WORKER } },
    { worker: WORKER },
    new Set(['plan', 'review', 'approve']),
    'approve',
  )
  expect(result.agents.worker).toEqual(WORKER)
  expect(result.agents['worker-2']).toEqual(collidingAgent)
  expect(result.agents.extra).toEqual(WORKER)
})

test('spliceFragment throws the original collision error when every rename suffix is already taken', () => {
  const existingAgents: Record<string, AgentDef> = { worker: WORKER }
  for (let i = 2; i <= 1000; i++) existingAgents[`worker-${i}`] = WORKER
  expect(() => spliceFragment(
    { nodes: [{ id: 'build', role: 'executor', agent: 'worker' }], agents: { worker: { adapter: 'aider' } } },
    existingAgents,
    new Set(['plan', 'review', 'approve']),
    'approve',
  )).toThrow(/invalid fragment:.*agent key "worker" already exists/)
})

test('spliceFragment auto-repairs a colliding node id by renaming it and rewiring after/of references', () => {
  const result = spliceFragment(
    {
      nodes: [
        { id: 'approve', role: 'executor', agent: 'worker' },
        { id: 'review', role: 'critic', of: 'approve', agent: 'worker' },
        { id: 'finish', role: 'executor', agent: 'worker', after: ['approve'] },
      ],
    },
    { worker: WORKER },
    new Set(['plan', 'approve']),
    'plan',
  )
  // the colliding "approve" id is renamed to the first non-colliding suffix,
  // and every other node in the same fragment that referenced it via `of`
  // or `after` is rewired to the new id - no LLM replan needed.
  expect(result.nodes.find((n) => n.id === 'approve')).toBeUndefined()
  const renamed = result.nodes.find((n) => n.id === 'approve-2')!
  expect(renamed).toBeDefined()
  const review = result.nodes.find((n) => n.id === 'review')!
  expect(review.of).toBe('approve-2')
  const finish = result.nodes.find((n) => n.id === 'finish')!
  expect(finish.after).toEqual(['approve-2'])
})

test('spliceFragment node id auto-repair picks the next free suffix when an earlier one is already taken', () => {
  const result = spliceFragment(
    { nodes: [{ id: 'plan', role: 'executor', agent: 'worker' }] },
    { worker: WORKER },
    new Set(['plan', 'plan-2', 'review', 'approve']),
    'approve',
  )
  expect(result.nodes.find((n) => n.id === 'plan-3')).toBeDefined()
})

test('spliceFragment node id auto-repair avoids colliding with another id declared in the same fragment', () => {
  const result = spliceFragment(
    {
      nodes: [
        { id: 'plan', role: 'executor', agent: 'worker' },
        { id: 'plan-2', role: 'executor', agent: 'worker', after: ['plan'] },
      ],
    },
    { worker: WORKER },
    new Set(['plan', 'review', 'approve']),
    'approve',
  )
  const renamed = result.nodes.find((n) => n.id === 'plan-3')!
  expect(renamed).toBeDefined()
  const dependent = result.nodes.find((n) => n.id === 'plan-2')!
  expect(dependent.after).toEqual(['plan-3'])
})

test('spliceFragment throws the original collision error when every node id rename suffix is already taken', () => {
  const existingNodeIds = new Set(['plan', 'review', 'approve'])
  for (let i = 2; i <= 1000; i++) existingNodeIds.add(`plan-${i}`)
  expect(() => spliceFragment(
    { nodes: [{ id: 'plan', role: 'executor', agent: 'worker' }] },
    { worker: WORKER },
    existingNodeIds,
    'approve',
  )).toThrow(/invalid fragment:.*node id "plan" already exists/)
})

test('spliceFragment throws when the merged graph fails validation (unknown agent reference)', () => {
  expect(() => spliceFragment(
    { nodes: [{ id: 'build', role: 'executor', agent: 'nonexistent' }] },
    { worker: WORKER },
    new Set(['plan', 'review', 'approve']),
    'approve',
  )).toThrow(/invalid fragment:.*unknown agent "nonexistent"/)
})

test('spliceFragment passes through fragment rails untouched (caller applies RailsGuard.tighten separately)', () => {
  const result = spliceFragment(
    { nodes: [{ id: 'build', role: 'executor', agent: 'worker' }], rails: { maxCostUsd: 5 } },
    { worker: WORKER },
    new Set(['plan', 'review', 'approve']),
    'approve',
  )
  expect(result.rails).toEqual({ maxCostUsd: 5 })
})
