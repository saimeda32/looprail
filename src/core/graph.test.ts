import { describe, expect, test } from 'vitest'
import { expandPanels, topoLayers, validateGraph } from './graph.js'
import type { LoopDef, NodeDef } from './types.js'

const base = (nodes: NodeDef[]): LoopDef => ({
  name: 't', goal: 'g',
  agents: { a: { adapter: 'mock' }, b: { adapter: 'mock' } },
  nodes,
  rails: { maxIterations: 3, maxCostUsd: 1 },
  verdictPolicy: { kind: 'all-pass' },
})

describe('validateGraph', () => {
  test('accepts a valid graph', () => {
    const def = base([
      { id: 'plan', role: 'planner', agent: 'a' },
      { id: 'do', role: 'executor', agent: 'a', after: ['plan'] },
      { id: 'check', role: 'tester', run: 'true', expect: 'exit 0', after: ['do'] },
    ])
    expect(validateGraph(def)).toEqual([])
  })

  test('rejects unknown dependency, unknown agent, and cycles', () => {
    const def = base([
      { id: 'x', role: 'executor', agent: 'nope', after: ['ghost', 'y'] },
      { id: 'y', role: 'executor', agent: 'a', after: ['x'] },
    ])
    const errors = validateGraph(def)
    expect(errors.some((e) => e.includes('ghost'))).toBe(true)
    expect(errors.some((e) => e.includes('nope'))).toBe(true)
    expect(errors.some((e) => e.includes('cycle'))).toBe(true)
  })

  test('rejects agent-backed node without agent', () => {
    const def = base([{ id: 'x', role: 'executor' }])
    expect(validateGraph(def).some((e) => e.includes('agent'))).toBe(true)
  })
})

describe('topoLayers', () => {
  test('groups independent nodes into the same layer', () => {
    const layers = topoLayers([
      { id: 'a', role: 'executor', agent: 'a' },
      { id: 'b', role: 'tester', run: 'true', after: ['a'] },
      { id: 'c', role: 'critic', agent: 'a', of: 'a', after: ['a'] },
      { id: 'd', role: 'judge', agent: 'a', after: ['b', 'c'] },
    ])
    expect(layers).toEqual([['a'], ['b', 'c'], ['d']])
  })
})

describe('expandPanels', () => {
  test('numeric panel clones the node N times and rewires dependents', () => {
    const def = base([
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'do', panel: 3, after: ['do'] },
      { id: 'judge', role: 'judge', agent: 'b', after: ['crit'] },
    ])
    const out = expandPanels(def)
    const ids = out.nodes.map((n) => n.id)
    expect(ids).toEqual(['do', 'crit@1', 'crit@2', 'crit@3', 'judge'])
    expect(out.nodes.find((n) => n.id === 'judge')!.after)
      .toEqual(['crit@1', 'crit@2', 'crit@3'])
  })

  test('agent-list panel assigns one clone per agent', () => {
    const def = base([
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', of: 'do', panel: ['a', 'b'], after: ['do'] },
    ])
    const out = expandPanels(def)
    expect(out.nodes.map((n) => [n.id, n.agent])).toEqual([
      ['do', 'a'], ['crit@1', 'a'], ['crit@2', 'b'],
    ])
  })
})
