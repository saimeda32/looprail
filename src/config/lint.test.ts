import { expect, test } from 'vitest'
import { lintLoop } from './lint.js'
import type { LoopDef, NodeDef } from '../core/types.js'

const make = (nodes: NodeDef[], over: Partial<LoopDef> = {}): LoopDef => ({
  name: 't', goal: 'g',
  agents: {
    big: { adapter: 'claude-code', model: 'opus' },
    small: { adapter: 'claude-code', model: 'haiku' },
  },
  nodes,
  rails: { maxIterations: 5, maxCostUsd: 10 },
  verdictPolicy: { kind: 'all-pass' },
  ...over,
})
const rules = (def: LoopDef) => lintLoop(def).map((f) => f.rule)

test('clean loop has no findings', () => {
  const def = make([
    { id: 'do', role: 'executor', agent: 'big' },
    { id: 't', role: 'tester', run: 'true', after: ['do'] },
    { id: 'j', role: 'judge', agent: 'small', after: ['t'] },
  ])
  expect(lintLoop(def)).toEqual([])
})

test('L001: no verifying node in execution region', () => {
  const def = make([
    { id: 'plan', role: 'planner', agent: 'big' },
    { id: 'pc', role: 'critic', agent: 'small', of: 'plan', after: ['plan'] },
    { id: 'do', role: 'executor', agent: 'big', after: ['pc'] },
  ])
  expect(rules(def)).toContain('L001')
})

test('L002: missing budget rails', () => {
  const def = make(
    [{ id: 'do', role: 'executor', agent: 'big' },
     { id: 't', role: 'tester', run: 'true', after: ['do'] }],
    { rails: { maxIterations: 0, maxCostUsd: 10 } })
  expect(rules(def)).toContain('L002')
})

test('L003: judge shares model with executor', () => {
  const def = make([
    { id: 'do', role: 'executor', agent: 'big' },
    { id: 'j', role: 'judge', agent: 'big', after: ['do'] },
  ])
  const finding = lintLoop(def).find((f) => f.rule === 'L003')!
  expect(finding.level).toBe('warn')
  expect(finding.node).toBe('j')
})

test('L004: panel with no downstream judge or synthesizer', () => {
  const def = make([
    { id: 'do', role: 'executor', agent: 'big' },
    { id: 'crit', role: 'critic', agent: 'small', of: 'do', panel: 3, after: ['do'] },
  ])
  expect(rules(def)).toContain('L004')
})

test('L005: structural errors are forwarded', () => {
  const def = make([{ id: 'x', role: 'executor', agent: 'ghost' }])
  expect(rules(def)).toContain('L005')
})

test('L006: non-positive node weight is an error', () => {
  const def = make([
    { id: 'do', role: 'executor', agent: 'big' },
    { id: 't', role: 'tester', run: 'true', after: ['do'], weight: 0 },
  ])
  const finding = lintLoop(def).find((f) => f.rule === 'L006')!
  expect(finding.level).toBe('error')
  expect(finding.node).toBe('t')
})

test('L007: a non-numeric concurrency is an error', () => {
  const def = make(
    [{ id: 'do', role: 'executor', agent: 'big' },
     { id: 't', role: 'tester', run: 'true', after: ['do'] }],
    { concurrency: 'fast' as unknown as number })
  const finding = lintLoop(def).find((f) => f.rule === 'L007')!
  expect(finding.level).toBe('error')
})
