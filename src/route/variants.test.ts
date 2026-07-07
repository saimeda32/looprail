import { expect, test } from 'vitest'
import { parseLoopfile } from '../config/loopfile.js'
import type { DetectedAgent } from '../adapters/detect.js'
import { generateVariants } from './variants.js'

function detected(adapter: string, available = true): DetectedAgent {
  return { name: adapter, adapter, command: adapter, available, fixHint: 'install it' }
}

// worker drives executor+planner nodes, checker is referenced ONLY by a
// critic node - the shape cross-model pairing keys off
const LOOPFILE = `
name: fixture
goal: produce DONE
agents:
  worker:  { adapter: mock, permissions: safe }
  checker: { adapter: mock }
graph:
  do:   { role: executor, agent: worker }
  crit: { role: critic, agent: checker, of: do, after: do }
rails:
  max_iterations: 2
  max_cost_usd: 5
verdict: { policy: all-pass }
`

const def = () => parseLoopfile(LOOPFILE)

test('single installed adapter (claude-code) yields one variant per tier, medium first', () => {
  const variants = generateVariants(def(), [detected('claude-code')], 4)
  expect(variants.map((v) => v.id)).toEqual([
    'claude-code-sonnet', 'claude-code-opus', 'claude-code-haiku',
  ])
  // no second adapter installed -> no cross-model critic pairing anywhere
  for (const v of variants) {
    expect(v.agents.worker.adapter).toBe('claude-code')
    expect(v.agents.checker.adapter).toBe(v.agents.worker.adapter)
    expect(v.agents.checker.model).toBe(v.agents.worker.model)
  }
  expect(variants[0].agents.worker.model).toBe('sonnet')
  expect(variants[1].agents.worker.model).toBe('opus')
  expect(variants[2].agents.worker.model).toBe('haiku')
})

test('providers are covered round-robin before extra claude tiers, so a cap never starves a provider', () => {
  const variants = generateVariants(def(), [detected('claude-code'), detected('codex')], 4)
  const primaries = variants.map((v) => v.agents.worker)
  // first two variants cover BOTH installed adapters; claude's remaining
  // tiers only claim slots after every provider got one
  expect(primaries[0].adapter).toBe('claude-code')
  expect(primaries[1].adapter).toBe('codex')
  expect(primaries[2].adapter).toBe('claude-code')
  expect(primaries[3].adapter).toBe('claude-code')
})

test('with 2+ adapters, a critic-only agent is re-pointed at a DIFFERENT adapter than the worker', () => {
  const variants = generateVariants(def(), [detected('claude-code'), detected('codex')], 4)
  for (const v of variants) {
    expect(v.agents.checker.adapter).not.toBe(v.agents.worker.adapter)
  }
  // the pairing is visible in the variant id
  expect(variants[0].id).toBe('claude-code-sonnet+critic-codex')
  expect(variants[1].id).toBe('codex+critic-claude-code-sonnet')
})

test('an agent key shared by executor and critic nodes stays on the primary engine', () => {
  const shared = parseLoopfile(`
name: fixture
goal: g
agents:
  a: { adapter: mock }
graph:
  do:   { role: executor, agent: a }
  crit: { role: critic, agent: a, of: do, after: do }
rails:
  max_iterations: 1
  max_cost_usd: 5
verdict: { policy: all-pass }
`)
  const variants = generateVariants(shared, [detected('claude-code'), detected('codex')], 2)
  expect(variants[0].agents.a.adapter).toBe('claude-code')
  expect(variants[1].agents.a.adapter).toBe('codex')
  expect(variants.map((v) => v.id)).toEqual(['claude-code-sonnet', 'codex'])
})

test('the cap bounds how many variants are generated', () => {
  const variants = generateVariants(def(), [detected('claude-code'), detected('codex')], 2)
  expect(variants).toHaveLength(2)
})

test('unavailable adapters never produce variants', () => {
  const variants = generateVariants(def(), [detected('claude-code', false), detected('codex')], 4)
  expect(variants.map((v) => v.id)).toEqual(['codex'])
  expect(variants[0].agents.checker.adapter).toBe('codex')
})

test('re-pointing preserves the rest of each AgentDef and clears model on non-claude engines', () => {
  const variants = generateVariants(def(), [detected('codex')], 4)
  expect(variants[0].agents.worker.permissions).toBe('safe')
  expect(variants[0].agents.worker.model).toBeUndefined()
})

test('graph nodes are never touched - only the agents map changes', () => {
  const base = def()
  const variants = generateVariants(base, [detected('claude-code'), detected('codex')], 4)
  for (const v of variants) {
    expect(Object.keys(v.agents).sort()).toEqual(Object.keys(base.agents).sort())
  }
})
