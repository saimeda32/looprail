import { describe, expect, test } from 'vitest'
import { lintLoop, parseLoopfile } from '../index.js'
import { TEMPLATES } from './templates.js'

describe('template gallery', () => {
  test('ships exactly the four advertised templates', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(
      ['content-pipeline', 'fix-tests', 'refactor', 'research-report'])
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
