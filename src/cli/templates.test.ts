import { describe, expect, test } from 'vitest'
import { lintLoop, parseLoopfile } from '../index.js'
import { TEMPLATES } from './templates.js'

describe('template gallery', () => {
  test('ships exactly the six advertised templates', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(
      ['build-app', 'content-pipeline', 'fix-tests', 'refactor', 'research-report', 'review-diff'])
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

  test('build-app has a planner, an executor that writes its own tests, a tester, and a spec critic', () => {
    const def = parseLoopfile(TEMPLATES['build-app'].yaml('claude-code', 'codex'))
    expect(def.nodes.filter((n) => n.role === 'planner')).toHaveLength(1)
    expect(def.nodes.filter((n) => n.role === 'executor')).toHaveLength(1)
    expect(def.nodes.filter((n) => n.role === 'tester')).toHaveLength(1)
    expect(def.nodes.filter((n) => n.role === 'critic')).toHaveLength(1)
  })

  test('build-app goal is honest about the SPEC placeholder instead of faking a default project', () => {
    const yaml = TEMPLATES['build-app'].yaml('claude-code', 'codex')
    expect(yaml).toContain('Build SPEC (edit this line:')
    expect(yaml).not.toMatch(/\(edit me\)/i)
    expect(yaml.toLowerCase()).not.toContain('todo app')
  })

  test('build-app critic checks the spec itself, not just that the worker\'s own tests passed', () => {
    const yaml = TEMPLATES['build-app'].yaml('claude-code', 'codex')
    expect(yaml).toContain('Fail if the result doesn\'t actually satisfy the spec above, even if its own tests pass')
  })

  test('build-app tester defaults to npm test with a comment to swap in your stack\'s real command', () => {
    const yaml = TEMPLATES['build-app'].yaml('claude-code', 'codex')
    expect(yaml).toContain('run: npm test, expect: exit 0')
    expect(yaml).toMatch(/#.*swap.*npm test.*for your stack's real test command/i)
  })

  test('build-app rails are the largest budget in the gallery — most open-ended template', () => {
    const def = parseLoopfile(TEMPLATES['build-app'].yaml('claude-code', 'codex'))
    expect(def.rails.maxIterations).toBe(10)
    expect(def.rails.maxCostUsd).toBe(20)
    expect(def.rails.maxWallMinutes).toBe(60)
    expect(def.rails.stallAfter).toBe(3)
    expect(def.rails.replanLimit).toBe(2)
  })

  // Which agent key in each template's yaml maps to which model tier, and
  // whether that key is driven by the `worker` or `reviewer` param passed to
  // `.yaml(worker, reviewer)`. Every template only ever wires the `worker`
  // key to the worker param; every other agent key is wired to the reviewer
  // param — see templates.ts.
  const AGENT_TIERS: Record<string, Record<string, 'strong' | 'cheap'>> = {
    'fix-tests': { worker: 'strong', checker: 'cheap' },
    'research-report': { worker: 'strong', checker: 'strong' },
    refactor: { worker: 'strong', correctness: 'cheap', quality: 'cheap' },
    'content-pipeline': { worker: 'strong', editor: 'cheap', 'fact-editor': 'strong' },
    'review-diff': { worker: 'strong', reviewer: 'strong' },
    'build-app': { worker: 'strong', checker: 'strong' },
  }

  function agentLine(yaml: string, key: string): string {
    // anchored to line-start so e.g. key "editor" can't match inside the
    // "fact-editor" line (a plain \b boundary would, since '-' is a
    // non-word char and would satisfy a word-boundary check there too)
    const match = yaml.match(new RegExp(`^\\s*${key}:\\s*\\{[^}]*\\}`, 'm'))
    if (!match) throw new Error(`agent key "${key}" not found in yaml:\n${yaml}`)
    return match[0]
  }

  test('every AGENT_TIERS entry covers exactly the agent keys the template actually declares', () => {
    expect(Object.keys(AGENT_TIERS).sort()).toEqual(Object.keys(TEMPLATES).sort())
  })

  test('claude-code/claude-code: every agent key gets its documented model tier', () => {
    for (const [name, tiers] of Object.entries(AGENT_TIERS)) {
      const yaml = TEMPLATES[name].yaml('claude-code', 'claude-code')
      for (const [key, tier] of Object.entries(tiers)) {
        const expected = tier === 'strong' ? 'model: sonnet' : 'model: haiku'
        expect(agentLine(yaml, key), `${name}.${key}`).toContain(expected)
      }
    }
  })

  test('mock/mock: no agent line ever contains a literal "model:" field', () => {
    for (const [name, tiers] of Object.entries(AGENT_TIERS)) {
      const yaml = TEMPLATES[name].yaml('mock', 'mock')
      for (const key of Object.keys(tiers)) {
        expect(agentLine(yaml, key), `${name}.${key}`).not.toContain('model:')
      }
      expect(yaml, name).not.toContain('model:')
    }
  })

  test('claude-code worker + codex reviewer: only the claude-code (worker) agent line gets a model tier', () => {
    for (const [name, tiers] of Object.entries(AGENT_TIERS)) {
      const yaml = TEMPLATES[name].yaml('claude-code', 'codex')
      for (const [key, tier] of Object.entries(tiers)) {
        const line = agentLine(yaml, key)
        if (key === 'worker') {
          expect(line, `${name}.${key}`).toContain(tier === 'strong' ? 'model: sonnet' : 'model: haiku')
        } else {
          expect(line, `${name}.${key}`).not.toContain('model:')
        }
      }
    }
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
