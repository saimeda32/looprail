import { describe, expect, test } from 'vitest'
import { previewRun, renderPreview } from './dry-run.js'
import type { LoopDef } from '../core/types.js'

const base: LoopDef = {
  goal: 'ship the thing',
  agents: {
    worker: { adapter: 'claude-code', model: 'sonnet' },
    reviewer: { adapter: 'codex' },
  },
  nodes: [
    { id: 'plan', role: 'planner', agent: 'worker' },
    { id: 'build', role: 'executor', agent: 'worker', after: ['plan'] },
    { id: 'test', role: 'tester', run: 'npm test', after: ['build'] },
    { id: 'crit', role: 'critic', agent: 'reviewer', of: 'build' },
  ],
  rails: { maxIterations: 6, maxCostUsd: 4 },
  verdictPolicy: { kind: 'all-pass' },
}

describe('previewRun', () => {
  test('orders nodes into dependency layers (parallel groups)', () => {
    const p = previewRun(base)
    // plan first; build after plan; test+crit both depend on build so share a layer
    expect(p.layers[0].map((n) => n.id)).toEqual(['plan'])
    expect(p.layers[1].map((n) => n.id)).toEqual(['build'])
    expect(p.layers[2].map((n) => n.id).sort()).toEqual(['crit', 'test'])
  })

  test('resolves each agent-backed node to its adapter and model', () => {
    const p = previewRun(base)
    const build = p.layers[1][0]
    expect(build).toMatchObject({ id: 'build', role: 'executor', adapter: 'claude-code', model: 'sonnet' })
    const crit = p.layers[2].find((n) => n.id === 'crit')
    expect(crit).toMatchObject({ adapter: 'codex' })
    expect(crit?.model).toBeUndefined()
  })

  test('a tester shows its command, not an agent', () => {
    const p = previewRun(base)
    const test = p.layers[2].find((n) => n.id === 'test')
    expect(test?.adapter).toBeUndefined()
    expect(test?.detail).toContain('npm test')
  })

  test('carries the rails ceiling and counts verifiers', () => {
    const p = previewRun(base)
    expect(p.rails).toEqual({ maxIterations: 6, maxCostUsd: 4 })
    // tester + work-critic both verify
    expect(p.verifierCount).toBe(2)
  })

  test('expands a panel into one preview node per clone', () => {
    const paneled: LoopDef = {
      ...base,
      nodes: [
        { id: 'plan', role: 'planner', agent: 'worker' },
        { id: 'build', role: 'executor', agent: 'worker', after: ['plan'] },
        { id: 'judge', role: 'judge', agent: 'reviewer', after: ['build'], panel: 3 },
      ],
    }
    const p = previewRun(paneled)
    const judges = p.layers.flat().filter((n) => n.id.startsWith('judge'))
    expect(judges).toHaveLength(3)
  })
})

describe('renderPreview', () => {
  test('renders a human plan naming order, agents, budget, and no-spend note', () => {
    const lines = renderPreview(previewRun(base)).join('\n')
    expect(lines).toContain('ship the thing')
    expect(lines).toContain('claude-code/sonnet')
    expect(lines).toMatch(/max.*6 iterations/i)
    expect(lines).toMatch(/\$4/)
    expect(lines.toLowerCase()).toContain('nothing was spent')
  })
})
