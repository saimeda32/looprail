import { describe, expect, test } from 'vitest'
import { lintLoop, parseLoopfile } from '../index.js'
import { TEMPLATES, tierToModel, type Template, type Tier } from './templates.js'

// Builds the adapters/models maps init-cmd.ts would build, fanning the
// worker/reviewer adapters out per role and applying one explicit tier to
// every role - used to prove yaml() correctly interpolates whatever tier a
// caller supplies (not just the recommended default).
function withTier(
  template: Template,
  worker: string,
  reviewer: string,
  tier: Tier,
): { adapters: Record<string, string>; models: Record<string, string | undefined> } {
  const adapters: Record<string, string> = {}
  const models: Record<string, string | undefined> = {}
  for (const role of template.agentRoles) {
    const adapter = role.kind === 'worker' ? worker : reviewer
    adapters[role.key] = adapter
    models[role.key] = tierToModel(adapter, tier)
  }
  return { adapters, models }
}

// Same, but each role gets its own recommendedTier instead of one forced
// tier - this is what init-cmd.ts produces in non-interactive (--yes) mode.
function withRecommended(
  template: Template,
  worker: string,
  reviewer: string,
): { adapters: Record<string, string>; models: Record<string, string | undefined> } {
  const adapters: Record<string, string> = {}
  const models: Record<string, string | undefined> = {}
  for (const role of template.agentRoles) {
    const adapter = role.kind === 'worker' ? worker : reviewer
    adapters[role.key] = adapter
    models[role.key] = tierToModel(adapter, role.recommendedTier)
  }
  return { adapters, models }
}

function recommendedYaml(template: Template, worker: string, reviewer: string): string {
  const { adapters, models } = withRecommended(template, worker, reviewer)
  return template.yaml(adapters, models)
}

describe('tierToModel', () => {
  test('claude-code maps cheap/medium/strong to haiku/sonnet/opus', () => {
    expect(tierToModel('claude-code', 'cheap')).toBe('haiku')
    expect(tierToModel('claude-code', 'medium')).toBe('sonnet')
    expect(tierToModel('claude-code', 'strong')).toBe('opus')
  })

  test('every non-claude-code adapter gets no model regardless of tier', () => {
    for (const adapter of ['codex', 'aider', 'copilot-cli', 'shell', 'mock']) {
      for (const tier of ['cheap', 'medium', 'strong'] as const) {
        expect(tierToModel(adapter, tier), adapter).toBeUndefined()
      }
    }
  })

  test('is a pure translation with no auto-invocation - same inputs always give the same output', () => {
    expect(tierToModel('claude-code', 'strong')).toBe(tierToModel('claude-code', 'strong'))
  })
})

describe('template gallery', () => {
  test('ships exactly the six advertised templates', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(
      ['build-app', 'content-pipeline', 'fix-tests', 'refactor', 'research-report', 'review-diff'])
  })

  test('no template ships a literal edit-me placeholder in its goal', () => {
    for (const [name, template] of Object.entries(TEMPLATES)) {
      const yaml = recommendedYaml(template, 'claude-code', 'codex')
      expect(yaml, `${name} should be runnable as shipped`).not.toMatch(/\(edit me\)/i)
    }
  })

  test('refactor splits review into two independent critics on two agent keys', () => {
    const yaml = recommendedYaml(TEMPLATES.refactor, 'claude-code', 'codex')
    expect(yaml).toContain('crit-correct:')
    expect(yaml).toContain('crit-quality:')
    expect(yaml).toContain('agent: correctness')
    expect(yaml).toContain('agent: quality')
  })

  test('review-diff has no planner and no tester - it is a read-only review', () => {
    const def = parseLoopfile(recommendedYaml(TEMPLATES['review-diff'], 'claude-code', 'codex'))
    expect(def.nodes.some((n) => n.role === 'planner')).toBe(false)
    expect(def.nodes.some((n) => n.role === 'tester')).toBe(false)
    expect(def.nodes.filter((n) => n.role === 'executor')).toHaveLength(1)
    expect(def.nodes.filter((n) => n.role === 'critic')).toHaveLength(1)
  })

  test('review-diff goal explicitly mentions git diff and the current pending changes', () => {
    const yaml = recommendedYaml(TEMPLATES['review-diff'], 'claude-code', 'codex')
    expect(yaml).toContain('git diff')
    expect(yaml.toLowerCase()).toContain('pending')
  })

  test('review-diff rails are smaller/cheaper than the multi-round templates', () => {
    const def = parseLoopfile(recommendedYaml(TEMPLATES['review-diff'], 'claude-code', 'codex'))
    expect(def.rails.maxIterations).toBe(4)
    expect(def.rails.maxCostUsd).toBe(8)
    expect(def.rails.stallAfter).toBe(2)
    expect(def.rails.replanLimit).toBe(1)
  })

  test('build-app has a planner, an executor that writes its own tests, a tester, and a spec critic', () => {
    const def = parseLoopfile(recommendedYaml(TEMPLATES['build-app'], 'claude-code', 'codex'))
    expect(def.nodes.filter((n) => n.role === 'planner')).toHaveLength(1)
    expect(def.nodes.filter((n) => n.role === 'executor')).toHaveLength(1)
    expect(def.nodes.filter((n) => n.role === 'tester')).toHaveLength(1)
    expect(def.nodes.filter((n) => n.role === 'critic')).toHaveLength(1)
  })

  test('build-app goal is honest about the SPEC placeholder instead of faking a default project', () => {
    const yaml = recommendedYaml(TEMPLATES['build-app'], 'claude-code', 'codex')
    expect(yaml).toContain('Build SPEC (edit this line:')
    expect(yaml).not.toMatch(/\(edit me\)/i)
    expect(yaml.toLowerCase()).not.toContain('todo app')
  })

  test('build-app critic checks the spec itself, not just that the worker\'s own tests passed', () => {
    const yaml = recommendedYaml(TEMPLATES['build-app'], 'claude-code', 'codex')
    expect(yaml).toContain('Fail if the result doesn\'t actually satisfy the spec above, even if its own tests pass')
  })

  test('build-app tester defaults to npm test with a comment to swap in your stack\'s real command', () => {
    const yaml = recommendedYaml(TEMPLATES['build-app'], 'claude-code', 'codex')
    expect(yaml).toContain('run: npm test, expect: exit 0')
    expect(yaml).toMatch(/#.*swap.*npm test.*for your stack's real test command/i)
  })

  test('build-app rails are the largest budget in the gallery - most open-ended template', () => {
    const def = parseLoopfile(recommendedYaml(TEMPLATES['build-app'], 'claude-code', 'codex'))
    expect(def.rails.maxIterations).toBe(10)
    expect(def.rails.maxCostUsd).toBe(20)
    expect(def.rails.maxWallMinutes).toBe(60)
    expect(def.rails.stallAfter).toBe(3)
    expect(def.rails.replanLimit).toBe(2)
  })

  // Documents each template's recommended tier per agent key - a hardcoded
  // table independent of templates.ts's own agentRoles data, so a test below
  // can catch an accidental drift between the two rather than just
  // reflecting back whatever the implementation currently says.
  const RECOMMENDED_TIERS: Record<string, Record<string, Tier>> = {
    'fix-tests': { worker: 'medium', checker: 'cheap' },
    'research-report': { worker: 'medium', checker: 'medium' },
    refactor: { worker: 'medium', correctness: 'cheap', quality: 'cheap' },
    'content-pipeline': { worker: 'medium', editor: 'cheap', 'fact-editor': 'medium' },
    'review-diff': { worker: 'medium', reviewer: 'medium' },
    'build-app': { worker: 'medium', checker: 'medium' },
  }

  function agentLine(yaml: string, key: string): string {
    // anchored to line-start so e.g. key "editor" can't match inside the
    // "fact-editor" line (a plain \b boundary would, since '-' is a
    // non-word char and would satisfy a word-boundary check there too)
    const match = yaml.match(new RegExp(`^\\s*${key}:\\s*\\{[^}]*\\}`, 'm'))
    if (!match) throw new Error(`agent key "${key}" not found in yaml:\n${yaml}`)
    return match[0]
  }

  test('every RECOMMENDED_TIERS entry covers exactly the agent keys the template actually declares', () => {
    for (const [name, tiers] of Object.entries(RECOMMENDED_TIERS)) {
      expect(Object.keys(tiers).sort(), name).toEqual(TEMPLATES[name].agentRoles.map((r) => r.key).sort())
    }
    expect(Object.keys(RECOMMENDED_TIERS).sort()).toEqual(Object.keys(TEMPLATES).sort())
  })

  test('every template\'s agentRoles.recommendedTier matches the documented tier table', () => {
    for (const [name, tiers] of Object.entries(RECOMMENDED_TIERS)) {
      for (const [key, tier] of Object.entries(tiers)) {
        const role = TEMPLATES[name].agentRoles.find((r) => r.key === key)
        expect(role, `${name}.${key}`).toBeDefined()
        expect(role!.recommendedTier, `${name}.${key}`).toBe(tier)
      }
    }
  })

  test('only the "worker" agent key has kind "worker" - every other key is "reviewer"', () => {
    for (const template of Object.values(TEMPLATES)) {
      for (const role of template.agentRoles) {
        expect(role.kind).toBe(role.key === 'worker' ? 'worker' : 'reviewer')
      }
    }
  })

  test('claude-code/claude-code: every agent key gets its recommended tier\'s model', () => {
    for (const [name, tiers] of Object.entries(RECOMMENDED_TIERS)) {
      const yaml = recommendedYaml(TEMPLATES[name], 'claude-code', 'claude-code')
      for (const [key, tier] of Object.entries(tiers)) {
        expect(agentLine(yaml, key), `${name}.${key}`).toContain(`model: ${tierToModel('claude-code', tier)}`)
      }
    }
  })

  test('mock/mock: no agent line ever contains a literal "model:" field', () => {
    for (const [name, tiers] of Object.entries(RECOMMENDED_TIERS)) {
      const yaml = recommendedYaml(TEMPLATES[name], 'mock', 'mock')
      for (const key of Object.keys(tiers)) {
        expect(agentLine(yaml, key), `${name}.${key}`).not.toContain('model:')
      }
      expect(yaml, name).not.toContain('model:')
    }
  })

  test('claude-code worker + codex reviewer: only the claude-code (worker) agent line gets a model tier', () => {
    for (const [name, tiers] of Object.entries(RECOMMENDED_TIERS)) {
      const yaml = recommendedYaml(TEMPLATES[name], 'claude-code', 'codex')
      for (const [key, tier] of Object.entries(tiers)) {
        const line = agentLine(yaml, key)
        if (key === 'worker') {
          expect(line, `${name}.${key}`).toContain(`model: ${tierToModel('claude-code', tier)}`)
        } else {
          expect(line, `${name}.${key}`).not.toContain('model:')
        }
      }
    }
  })

  test('every template: forcing every role to "strong" yields opus for every claude-code-backed key', () => {
    for (const [name, template] of Object.entries(TEMPLATES)) {
      const { adapters, models } = withTier(template, 'claude-code', 'claude-code', 'strong')
      const yaml = template.yaml(adapters, models)
      for (const role of template.agentRoles) {
        expect(agentLine(yaml, role.key), `${name}.${role.key}`).toContain('model: opus')
      }
    }
  })

  test('every template: forcing every role to "cheap" yields haiku for every claude-code-backed key', () => {
    for (const [name, template] of Object.entries(TEMPLATES)) {
      const { adapters, models } = withTier(template, 'claude-code', 'claude-code', 'cheap')
      const yaml = template.yaml(adapters, models)
      for (const role of template.agentRoles) {
        expect(agentLine(yaml, role.key), `${name}.${role.key}`).toContain('model: haiku')
      }
    }
  })

  const PAIRINGS: Array<[worker: string, reviewer: string]> = [
    ['claude-code', 'claude-code'], // single-adapter environment
    ['mock', 'mock'],               // single-adapter environment
    ['claude-code', 'codex'],       // cross-model independent verification
  ]
  const TIER_MODES: Array<'recommended' | Tier> = ['recommended', 'strong', 'cheap']

  for (const [name, template] of Object.entries(TEMPLATES)) {
    for (const [worker, reviewer] of PAIRINGS) {
      for (const mode of TIER_MODES) {
        test(`${name} (worker=${worker}, reviewer=${reviewer}, tiers=${mode}) parses and lints completely clean`, () => {
          const { adapters, models } = mode === 'recommended'
            ? withRecommended(template, worker, reviewer)
            : withTier(template, worker, reviewer, mode)
          const def = parseLoopfile(template.yaml(adapters, models))
          expect(def.rails.maxCostUsd).toBeGreaterThan(0)
          expect(def.rails.maxIterations).toBeGreaterThan(0)
          expect(lintLoop(def)).toEqual([]) // zero errors AND zero warnings
        })
      }
    }
  }

  test('every template names two adapters (worker + reviewer) that can differ', () => {
    for (const template of Object.values(TEMPLATES)) {
      const yaml = recommendedYaml(template, 'claude-code', 'codex')
      expect(yaml).toContain('adapter: claude-code')
      expect(yaml).toContain('adapter: codex')
    }
  })

  test('every template documents the independent reviewer in a YAML comment', () => {
    for (const template of Object.values(TEMPLATES)) {
      const yaml = recommendedYaml(template, 'claude-code', 'codex')
      expect(yaml).toContain('# independent reviewer - a different model catches what the worker\'s own model misses')
    }
  })

  test('content-pipeline gate node clarifies it pauses for human approval', () => {
    const yaml = recommendedYaml(TEMPLATES['content-pipeline'], 'claude-code', 'codex')
    expect(yaml).toContain('role: gate')
    expect(yaml).toContain('# gate = pauses for human approval (y/n) before the loop can finish')
  })

  test('every template scaffolds each agent with permissions: safe', () => {
    for (const template of Object.values(TEMPLATES)) {
      const adapters = Object.fromEntries(template.agentRoles.map((r) => [r.key, 'claude-code']))
      const models = Object.fromEntries(template.agentRoles.map((r) => [r.key, undefined]))
      const yaml = template.yaml(adapters, models)
      for (const role of template.agentRoles) {
        expect(agentLine(yaml, role.key), role.key).toContain('permissions: safe')
      }
    }
  })
})
