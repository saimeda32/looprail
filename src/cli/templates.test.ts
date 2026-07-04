import { describe, expect, test } from 'vitest'
import { lintLoop, parseLoopfile } from '../index.js'
import { TEMPLATES } from './templates.js'

describe('template gallery', () => {
  test('ships exactly the five advertised templates', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(
      ['content-pipeline', 'fix-tests', 'refactor', 'research-report', 'review-diff'])
  })

  test('no template ships a literal edit-me placeholder in its goal', () => {
    for (const [name, template] of Object.entries(TEMPLATES)) {
      const yaml = template.yaml('claude-code', 'codex')
      expect(yaml, `${name} should be runnable as shipped`).not.toMatch(/\(edit me\)/i)
    }
  })

  test('refactor splits review into two independent critics on two agent keys', () => {
    const yaml = TEMPLATES.refactor.yaml('claude-code', 'codex')
    expect(yaml).toContain('crit-correct:')
    expect(yaml).toContain('crit-quality:')
    expect(yaml).toContain('agent: correctness')
    expect(yaml).toContain('agent: quality')
  })

  test('review-diff has no planner and no tester — it is a read-only review', () => {
    const def = parseLoopfile(TEMPLATES['review-diff'].yaml('claude-code', 'codex'))
    expect(def.nodes.some((n) => n.role === 'planner')).toBe(false)
    expect(def.nodes.some((n) => n.role === 'tester')).toBe(false)
    expect(def.nodes.filter((n) => n.role === 'executor')).toHaveLength(1)
    expect(def.nodes.filter((n) => n.role === 'critic')).toHaveLength(1)
  })

  test('review-diff goal explicitly mentions git diff and the current pending changes', () => {
    const yaml = TEMPLATES['review-diff'].yaml('claude-code', 'codex')
    expect(yaml).toContain('git diff')
    expect(yaml.toLowerCase()).toContain('pending')
  })

  test('review-diff rails are smaller/cheaper than the multi-round templates', () => {
    const def = parseLoopfile(TEMPLATES['review-diff'].yaml('claude-code', 'codex'))
    expect(def.rails.maxIterations).toBe(4)
    expect(def.rails.maxCostUsd).toBe(8)
    expect(def.rails.stallAfter).toBe(2)
    expect(def.rails.replanLimit).toBe(1)
  })

  const PAIRINGS: Array<[worker: string, reviewer: string]> = [
    ['claude-code', 'claude-code'], // single-adapter environment
    ['mock', 'mock'],               // single-adapter environment
    ['claude-code', 'codex'],       // cross-model independent verification
  ]

  for (const [name, template] of Object.entries(TEMPLATES)) {
    for (const [worker, reviewer] of PAIRINGS) {
      test(`${name} (worker=${worker}, reviewer=${reviewer}) parses and lints completely clean`, () => {
        const def = parseLoopfile(template.yaml(worker, reviewer))
        expect(def.rails.maxCostUsd).toBeGreaterThan(0)
        expect(def.rails.maxIterations).toBeGreaterThan(0)
        expect(lintLoop(def)).toEqual([]) // zero errors AND zero warnings
      })
    }
  }

  test('every template names two adapters (worker + reviewer) that can differ', () => {
    for (const template of Object.values(TEMPLATES)) {
      const yaml = template.yaml('claude-code', 'codex')
      expect(yaml).toContain('adapter: claude-code')
      expect(yaml).toContain('adapter: codex')
    }
  })

  test('every template documents the independent reviewer in a YAML comment', () => {
    for (const template of Object.values(TEMPLATES)) {
      const yaml = template.yaml('claude-code', 'codex')
      expect(yaml).toContain('# independent reviewer — a different model catches what the worker\'s own model misses')
    }
  })

  test('content-pipeline gate node clarifies it pauses for human approval', () => {
    const yaml = TEMPLATES['content-pipeline'].yaml('claude-code', 'codex')
    expect(yaml).toContain('role: gate')
    expect(yaml).toContain('# gate = pauses for human approval (y/n) before the loop can finish')
  })
})
