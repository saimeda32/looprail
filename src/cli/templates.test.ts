import { describe, expect, test } from 'vitest'
import { lintLoop, parseLoopfile } from '../index.js'
import { TEMPLATES } from './templates.js'

describe('template gallery', () => {
  test('ships exactly the four advertised templates', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(
      ['content-pipeline', 'fix-tests', 'refactor', 'research-report'])
  })

  for (const [name, template] of Object.entries(TEMPLATES)) {
    for (const adapter of ['claude-code', 'codex', 'mock']) {
      test(`${name} (${adapter}) parses and lints completely clean`, () => {
        const def = parseLoopfile(template.yaml(adapter))
        expect(def.rails.maxCostUsd).toBeGreaterThan(0)
        expect(def.rails.maxIterations).toBeGreaterThan(0)
        expect(lintLoop(def)).toEqual([]) // zero errors AND zero warnings
      })
    }
  }
})
