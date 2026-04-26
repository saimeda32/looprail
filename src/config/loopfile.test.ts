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
