import { expect, test } from 'vitest'
import { spliceFragment } from './splice.js'
import type { AgentDef, NodeDef } from '../core/types.js'

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

test('spliceFragment throws on an agent key that collides with an existing agent', () => {
  expect(() => spliceFragment(
    { nodes: [{ id: 'build', role: 'executor', agent: 'worker' }], agents: { worker: { adapter: 'aider' } } },
    { worker: WORKER },
    new Set(['plan', 'review', 'approve']),
    'approve',
  )).toThrow(/invalid fragment:.*agent key "worker" already exists/)
})

test('spliceFragment throws on a node id that collides with an existing node', () => {
  expect(() => spliceFragment(
    { nodes: [{ id: 'plan', role: 'executor', agent: 'worker' }] },
    { worker: WORKER },
    new Set(['plan', 'review', 'approve']),
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
