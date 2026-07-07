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

test('L008: quorum exceeding the verifier count can never be met', () => {
  const def = make(
    [{ id: 'do', role: 'executor', agent: 'big' },
     { id: 't', role: 'tester', run: 'true', after: ['do'] }],
    { verdictPolicy: { kind: 'quorum', atLeast: 2 } })
  const finding = lintLoop(def).find((f) => f.rule === 'L008')!
  expect(finding.level).toBe('error')
  expect(finding.message).toContain('only 1')
})

test('L008: a panel counts as one verifier per clone, so a satisfiable quorum passes lint', () => {
  const def = make(
    [{ id: 'do', role: 'executor', agent: 'big' },
     { id: 'crit', role: 'critic', agent: 'small', of: 'do', panel: 3, after: ['do'] },
     { id: 'syn', role: 'synthesizer', agent: 'big', after: ['crit'] }],
    { verdictPolicy: { kind: 'quorum', atLeast: 3 } })
  expect(rules(def)).not.toContain('L008')
})

test('L008: a quorum within the verifier count passes lint', () => {
  const def = make(
    [{ id: 'do', role: 'executor', agent: 'big' },
     { id: 't1', role: 'tester', run: 'true', after: ['do'] },
     { id: 't2', role: 'tester', run: 'true', after: ['do'] }],
    { verdictPolicy: { kind: 'quorum', atLeast: 2 } })
  expect(rules(def)).not.toContain('L008')
})

test('L009: a raw permissions key naming a different adapter than the agent itself is a warning, not an error', () => {
  const def = make(
    [{ id: 'do', role: 'executor', agent: 'worker' },
     { id: 't', role: 'tester', run: 'true', after: ['do'] }],
    { agents: { worker: { adapter: 'claude-code', permissions: { raw: { codex: ['--sandbox', 'danger-full-access'] } } } } })
  const findings = lintLoop(def)
  expect(findings).toContainEqual(expect.objectContaining({ rule: 'L009', level: 'warn', node: 'do' }))
})

test('L009: a raw permissions key matching the agent\'s own adapter produces no finding', () => {
  const def = make(
    [{ id: 'do', role: 'executor', agent: 'worker' },
     { id: 't', role: 'tester', run: 'true', after: ['do'] }],
    { agents: { worker: { adapter: 'claude-code', permissions: { raw: { 'claude-code': ['--add-dir', './scripts'] } } } } })
  expect(rules(def)).not.toContain('L009')
})


// L010: an executor whose work nothing downstream verifies (a loop can pass
// L001 with a verifier on ONE branch while leaving another unchecked).
test('L010 warns on an executor with no downstream verifier', () => {
  const def = make([
    { id: 'doA', role: 'executor', agent: 'big' },
    { id: 'critA', role: 'critic', agent: 'small', of: 'doA', after: ['doA'] },
    { id: 'doB', role: 'executor', agent: 'big' }, // nothing verifies doB
  ])
  const findings = lintLoop(def).filter((f) => f.rule === 'L010')
  expect(findings).toHaveLength(1)
  expect(findings[0].node).toBe('doB')
  expect(findings[0].level).toBe('warn')
})

test('L010 does NOT fire when every executor is verified by a downstream tester or critic', () => {
  const def = make([
    { id: 'doA', role: 'executor', agent: 'big' },
    { id: 'critA', role: 'critic', agent: 'small', of: 'doA', after: ['doA'] },
    { id: 'doB', role: 'executor', agent: 'big' },
    { id: 'testB', role: 'tester', after: ['doB'], run: 'npm test', expect: 'exit 0' },
  ])
  expect(rules(def)).not.toContain('L010')
})

test('L010 counts a transitive verifier (executor -> intermediate -> tester)', () => {
  const def = make([
    { id: 'build', role: 'executor', agent: 'big' },
    { id: 'refine', role: 'executor', agent: 'big', after: ['build'] },
    { id: 'test', role: 'tester', after: ['refine'], run: 'npm test', expect: 'exit 0' },
  ])
  // build's descendants include refine and (transitively) test -> verified
  expect(rules(def)).not.toContain('L010')
})
