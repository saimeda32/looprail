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

  test('rejects a node whose role is missing or not one of the real roles', () => {
    const def = base([{ id: 'x', role: undefined as unknown as NodeDef['role'] }])
    expect(validateGraph(def).some((e) => e.includes('unknown role'))).toBe(true)
  })

  test('rejects agent-backed node without agent', () => {
    const def = base([{ id: 'x', role: 'executor' }])
    expect(validateGraph(def).some((e) => e.includes('agent'))).toBe(true)
  })

  test('rejects a cycle formed through "of" edges', () => {
    const def = base([
      { id: 'x', role: 'critic', agent: 'a', of: 'y' },
      { id: 'y', role: 'critic', agent: 'a', of: 'x' },
    ])
    expect(validateGraph(def).some((e) => e.includes('cycle'))).toBe(true)
  })

  test('rejects "of" targeting a panel node', () => {
    const def = base([
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'do', panel: 3, after: ['do'] },
      { id: 'meta', role: 'critic', agent: 'a', of: 'crit' },
    ])
    const errors = validateGraph(def)
    expect(errors.some((e) => e.includes('panel node "crit"'))).toBe(true)
  })

  test('rejects panel counts below 1 or non-integer', () => {
    for (const panel of [0, -2, 2.5]) {
      const def = base([{ id: 'do', role: 'executor', agent: 'a', panel }])
      expect(validateGraph(def)).toContain('node "do": panel must be >= 1')
    }
  })

  test('rejects a numeric panel on a non-agent role', () => {
    for (const role of ['tester', 'gate'] as const) {
      const def = base([
        { id: 'do', role: 'executor', agent: 'a' },
        { id: 'v', role, run: 'true', panel: 3, after: ['do'] },
      ])
      expect(validateGraph(def).some((e) => e.includes(`node "v" (${role})`) && e.includes('panel')))
        .toBe(true)
    }
  })

  test('accepts a fallback chain that ends at an agent with no fallback', () => {
    const def = {
      ...base([{ id: 'do', role: 'executor' as const, agent: 'a' }]),
      agents: { a: { adapter: 'mock', fallback: 'b' }, b: { adapter: 'mock' } },
    }
    expect(validateGraph(def)).toEqual([])
  })

  test('rejects a fallback that references an unknown agent', () => {
    const def = {
      ...base([{ id: 'do', role: 'executor' as const, agent: 'a' }]),
      agents: { a: { adapter: 'mock', fallback: 'ghost' }, b: { adapter: 'mock' } },
    }
    expect(validateGraph(def)).toContain('agent "a": fallback references unknown agent "ghost"')
  })

  test('rejects a fallback chain that cycles, naming the whole chain', () => {
    const def = {
      ...base([{ id: 'do', role: 'executor' as const, agent: 'a' }]),
      agents: { a: { adapter: 'mock', fallback: 'b' }, b: { adapter: 'mock', fallback: 'a' } },
    }
    expect(validateGraph(def)).toContain('agent "a": fallback chain cycles (a -> b -> a)')
  })

  test('rejects an agent falling back to itself', () => {
    const def = {
      ...base([{ id: 'do', role: 'executor' as const, agent: 'a' }]),
      agents: { a: { adapter: 'mock', fallback: 'a' }, b: { adapter: 'mock' } },
    }
    expect(validateGraph(def)).toContain('agent "a": fallback chain cycles (a -> a)')
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

  test('"of" creates a scheduling edge even without "after"', () => {
    const layers = topoLayers([
      { id: 'crit', role: 'critic', agent: 'a', of: 'draft' },
      { id: 'draft', role: 'executor', agent: 'a' },
    ])
    expect(layers).toEqual([['draft'], ['crit']])
  })

  test('"of" pointing outside the scheduled set is ignored', () => {
    const layers = topoLayers([
      { id: 'crit', role: 'critic', agent: 'a', of: 'elsewhere' },
    ])
    expect(layers).toEqual([['crit']])
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


test('descendantsByNode computes transitive dependents via after and of, keeping independent branches disjoint', async () => {
  const { descendantsByNode } = await import('./graph.js')
  const nodes = [
    { id: 'doA', role: 'executor' as const },
    { id: 'critA', role: 'critic' as const, of: 'doA', after: ['doA'] },
    { id: 'doB', role: 'executor' as const },
    { id: 'critB', role: 'critic' as const, of: 'doB', after: ['doB'] },
    { id: 'merge', role: 'synthesizer' as const, after: ['critA', 'critB'] },
  ]
  const d = descendantsByNode(nodes)
  expect([...d.get('doA')!].sort()).toEqual(['critA', 'merge'])
  expect([...d.get('doB')!].sort()).toEqual(['critB', 'merge'])
  // the two branches are disjoint: doA is NOT a descendant of doB and vice versa
  expect(d.get('doA')!.has('doB')).toBe(false)
  expect(d.get('doB')!.has('doA')).toBe(false)
  expect(d.get('merge')!.size).toBe(0) // nothing depends on the sink
})
