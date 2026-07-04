import { expect, test } from 'vitest'
import {
  buildFallbackReport, buildReportPrompt, parseReport, pickReportingAgentKey,
} from './report.js'
import type { LoopDef, NodeOutcome } from './types.js'

function outcome(over: Partial<NodeOutcome> = {}): NodeOutcome {
  return {
    nodeId: 'do', role: 'executor', output: 'x', verdict: null,
    costUsd: 0, tokens: 0, durationMs: 1, ...over,
  }
}

test('parseReport extracts the summary and every claim line', () => {
  const output = [
    'Some preamble the model added anyway.',
    'SUMMARY: Fixed the failing test without weakening any assertion.',
    'CLAIM: tests now pass | CONFIDENCE: 95 | REASON: npm test exited 0',
    'CLAIM: no assertion weakened | CONFIDENCE: 80 | REASON: critic confirmed the diff',
  ].join('\n')
  expect(parseReport(output)).toEqual({
    summary: 'Fixed the failing test without weakening any assertion.',
    claims: [
      { claim: 'tests now pass', confidence: 95, reason: 'npm test exited 0' },
      { claim: 'no assertion weakened', confidence: 80, reason: 'critic confirmed the diff' },
    ],
    source: 'agent',
  })
})

test('parseReport returns null when there is no SUMMARY line at all', () => {
  expect(parseReport('just some unrelated text')).toBeNull()
})

test('parseReport tolerates a summary with zero claim lines', () => {
  expect(parseReport('SUMMARY: nothing much happened.')).toEqual({
    summary: 'nothing much happened.', claims: [], source: 'agent',
  })
})

test('parseReport clamps an out-of-range confidence instead of trusting it verbatim', () => {
  const output = 'SUMMARY: s\nCLAIM: c | CONFIDENCE: 150 | REASON: r'
  expect(parseReport(output)!.claims[0].confidence).toBe(100)
})

test('parseReport skips a claim line with a non-numeric confidence rather than crashing', () => {
  const output = 'SUMMARY: s\nCLAIM: c | CONFIDENCE: not-a-number | REASON: r'
  expect(parseReport(output)!.claims).toEqual([])
})

test('buildFallbackReport derives a pass=100/fail=0 claim per verdict, skipping nodes with none', () => {
  const outcomes = [
    outcome({ nodeId: 'do', role: 'executor', verdict: null }),
    outcome({ nodeId: 'check', role: 'tester', verdict: { node: 'do', status: 'pass', evidence: 'exit 0' } }),
    outcome({ nodeId: 'crit', role: 'critic', verdict: { node: 'do', status: 'fail', evidence: 'still broken' } }),
  ]
  const report = buildFallbackReport(outcomes, 'halted', 'rail breached (iterations): iteration 3 exceeds max 2')
  expect(report.source).toBe('fallback')
  expect(report.summary).toContain('Halted')
  expect(report.claims).toEqual([
    { claim: 'check (tester)', confidence: 100, reason: 'exit 0' },
    { claim: 'crit (critic)', confidence: 0, reason: 'still broken' },
  ])
})

test('buildFallbackReport falls back to the verdict status itself when evidence is empty', () => {
  const outcomes = [outcome({ nodeId: 'check', role: 'tester', verdict: { node: 'do', status: 'pass', evidence: '' } })]
  const report = buildFallbackReport(outcomes, 'verified', 'all verifiers passed')
  expect(report.claims[0].reason).toBe('verdict: pass')
})

test('buildReportPrompt includes the goal, final status, and every node result', () => {
  const outcomes = [
    outcome({ nodeId: 'do', role: 'executor', verdict: null }),
    outcome({ nodeId: 'check', role: 'tester', verdict: { node: 'do', status: 'pass', evidence: 'exit 0' } }),
  ]
  const prompt = buildReportPrompt('Fix the tests.', 'verified', 'all verifiers passed', outcomes)
  expect(prompt).toContain('Fix the tests.')
  expect(prompt).toContain('verified (all verifiers passed)')
  expect(prompt).toContain('do (executor): no verdict')
  expect(prompt).toContain('check (tester): pass - exit 0')
  expect(prompt).toContain('SUMMARY:')
  expect(prompt).toContain('CLAIM:')
})

function loop(over: Partial<LoopDef> = {}): LoopDef {
  return {
    name: 'x', goal: 'g', agents: {}, nodes: [],
    rails: { maxIterations: 1, maxCostUsd: 1 }, verdictPolicy: { kind: 'all-pass' },
    ...over,
  }
}

test('pickReportingAgentKey prefers the last critic/judge outcome with an agent', () => {
  const def = loop({
    agents: { a: { adapter: 'mock' }, b: { adapter: 'mock' } },
    nodes: [
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit1', role: 'critic', agent: 'a', of: 'do' },
      { id: 'crit2', role: 'critic', agent: 'b', of: 'do' },
    ],
  })
  const outcomes = [
    outcome({ nodeId: 'do', role: 'executor' }),
    outcome({ nodeId: 'crit1', role: 'critic' }),
    outcome({ nodeId: 'crit2', role: 'critic' }),
  ]
  expect(pickReportingAgentKey(def, outcomes)).toBe('b')
})

test('pickReportingAgentKey falls back to the last executor outcome when no critic/judge ran', () => {
  const def = loop({
    agents: { a: { adapter: 'mock' } },
    nodes: [
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'check', role: 'tester', run: 'true' },
    ],
  })
  const outcomes = [outcome({ nodeId: 'do', role: 'executor' }), outcome({ nodeId: 'check', role: 'tester' })]
  expect(pickReportingAgentKey(def, outcomes)).toBe('a')
})

test('pickReportingAgentKey ignores a node the graph defines but that never ran (rail-skipped) - never asks a never-invoked agent to report', () => {
  // 'judge' is defined with an agent, but a rail skipped it before it ever
  // started - it must never be picked, real cost for a call the rail
  // specifically prevented from happening.
  const def = loop({
    agents: { a: { adapter: 'mock' } },
    nodes: [
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'do' },
      { id: 'judge', role: 'judge', agent: 'a', of: 'do' },
    ],
  })
  // only do and crit actually produced an outcome; judge was skipped
  const outcomes = [outcome({ nodeId: 'do', role: 'executor' }), outcome({ nodeId: 'crit', role: 'critic' })]
  expect(pickReportingAgentKey(def, outcomes)).toBe('a') // from crit, not judge
})

test('pickReportingAgentKey returns undefined when nothing with an agent actually ran', () => {
  const def = loop({
    agents: { a: { adapter: 'mock' } },
    nodes: [{ id: 'check', role: 'tester', run: 'true' }],
  })
  const outcomes = [outcome({ nodeId: 'check', role: 'tester' })]
  expect(pickReportingAgentKey(def, outcomes)).toBeUndefined()
})

test('pickReportingAgentKey returns undefined for a loop with no agents at all', () => {
  const def = loop({ agents: {}, nodes: [{ id: 'check', role: 'tester', run: 'true' }] })
  expect(pickReportingAgentKey(def, [])).toBeUndefined()
})
