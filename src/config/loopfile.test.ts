import { expect, test } from 'vitest'
import { parseLoopfile } from './loopfile.js'

const SAMPLE = `
name: research-report
goal: Produce a cited report
agents:
  worker:  { adapter: claude-code, model: sonnet }
  checker: { adapter: claude-code, model: haiku }
graph:
  plan:      { role: planner, agent: worker }
  plan-crit: { role: critic, agent: checker, of: plan, panel: 3, rounds: 2, after: plan }
  draft:     { role: executor, agent: worker, after: plan-crit }
  cite-test: { role: tester, after: draft, run: ./check.sh, expect: exit 0 }
  judge:     { role: judge, agent: checker, after: [cite-test], threshold: 0.85 }
rails:
  max_iterations: 8
  max_cost_usd: 25
  stall_after: 3
  replan_limit: 2
verdict: { policy: all-pass }
`

test('parses a full loopfile into a LoopDef', () => {
  const def = parseLoopfile(SAMPLE)
  expect(def.name).toBe('research-report')
  expect(def.agents.worker).toEqual({ adapter: 'claude-code', model: 'sonnet' })
  expect(def.rails).toEqual({
    maxIterations: 8, maxCostUsd: 25, stallAfter: 3, replanLimit: 2,
  })
  expect(def.verdictPolicy).toEqual({ kind: 'all-pass' })
  const draft = def.nodes.find((n) => n.id === 'draft')!
  expect(draft).toMatchObject({ role: 'executor', agent: 'worker', after: ['plan-crit'] })
  const crit = def.nodes.find((n) => n.id === 'plan-crit')!
  expect(crit).toMatchObject({ panel: 3, rounds: 2, of: 'plan' })
  const judge = def.nodes.find((n) => n.id === 'judge')!
  expect(judge.threshold).toBe(0.85)
})

test('quorum policy maps to atLeast', () => {
  const def = parseLoopfile(SAMPLE.replace('policy: all-pass', 'policy: { quorum: 2 }'))
  expect(def.verdictPolicy).toEqual({ kind: 'quorum', atLeast: 2 })
})

test('lists all missing required fields in one error', () => {
  expect(() => parseLoopfile('name: x')).toThrow(/goal[\s\S]*agents[\s\S]*graph[\s\S]*rails/)
})

test('rejects unsupported expect values', () => {
  expect(() => parseLoopfile(SAMPLE.replace('exit 0', 'contains ok'))).toThrow(/expect/)
})

test('lists all nested problems (empty rails, missing role) in one error', () => {
  const bad = `
name: research-report
goal: Produce a cited report
agents:
  worker:  { adapter: claude-code, model: sonnet }
graph:
  plan: { agent: worker }
rails: {}
`
  try {
    parseLoopfile(bad)
    throw new Error('expected parseLoopfile to throw')
  } catch (err) {
    const message = (err as Error).message
    expect(message).toMatch(/max_iterations/)
    expect(message).toMatch(/max_cost_usd/)
    expect(message).toMatch(/invalid role/)
  }
})

test('rejects unrecognized verdict.policy values', () => {
  expect(() => parseLoopfile(SAMPLE.replace('policy: all-pass', 'policy: al-pass')))
    .toThrow(/verdict\.policy/)
})

test('rejects non-positive quorum values', () => {
  expect(() => parseLoopfile(SAMPLE.replace('policy: all-pass', 'policy: { quorum: 0 }')))
    .toThrow(/verdict\.policy/)
})

test('weighted policy and node weights parse through', () => {
  const withWeights = SAMPLE
    .replace('policy: all-pass', 'policy: { weighted: 0.7 }')
    .replace('{ role: judge, agent: checker, after: [cite-test], threshold: 0.85 }',
      '{ role: judge, agent: checker, after: [cite-test], threshold: 0.85, weight: 3 }')
  const def = parseLoopfile(withWeights)
  expect(def.verdictPolicy).toEqual({ kind: 'weighted', threshold: 0.7 })
  expect(def.nodes.find((n) => n.id === 'judge')!.weight).toBe(3)
})

test('rejects a weighted threshold outside (0, 1]', () => {
  expect(() => parseLoopfile(SAMPLE.replace('policy: all-pass', 'policy: { weighted: 1.5 }')))
    .toThrow(/weighted/)
  expect(() => parseLoopfile(SAMPLE.replace('policy: all-pass', 'policy: { weighted: 0 }')))
    .toThrow(/weighted/)
})
