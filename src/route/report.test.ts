import { expect, test } from 'vitest'
import { buildRoutingFile, mixLabel, rankEntries } from './report.js'
import type { RouteEntry, RouteResult } from './types.js'

function entry(id: string, over: Partial<RouteEntry> = {}): RouteEntry {
  return {
    variant: { id, agents: { worker: { adapter: id } } },
    skipped: false,
    verified: true,
    iterations: 1,
    costUsd: 1,
    tokens: 10,
    wallMs: 100,
    ...over,
  }
}

test('ranks verified entries before unverified ones, regardless of cost', () => {
  const ranked = rankEntries([
    entry('cheap-but-failed', { verified: false, costUsd: 0.1 }),
    entry('pricey-but-verified', { verified: true, costUsd: 3 }),
  ])
  expect(ranked.map((e) => e.variant.id)).toEqual(['pricey-but-verified', 'cheap-but-failed'])
})

test('within the same verified state, cheaper ranks first', () => {
  const ranked = rankEntries([
    entry('a', { costUsd: 2 }),
    entry('b', { costUsd: 0.5 }),
    entry('c', { costUsd: 1 }),
  ])
  expect(ranked.map((e) => e.variant.id)).toEqual(['b', 'c', 'a'])
})

test('budget-skipped entries always trail, in their original order', () => {
  const ranked = rankEntries([
    entry('s1', { skipped: true, verified: undefined, costUsd: undefined }),
    entry('ran', { verified: false, costUsd: 9 }),
    entry('s2', { skipped: true, verified: undefined, costUsd: undefined }),
  ])
  expect(ranked.map((e) => e.variant.id)).toEqual(['ran', 's1', 's2'])
})

test('buildRoutingFile records the winner\'s agents and every entry\'s numbers', () => {
  const result: RouteResult = {
    entries: rankEntries([
      entry('codex', { costUsd: 0.2 }),
      entry('claude-code-sonnet', { costUsd: 0.8 }),
      entry('claude-code-haiku', { skipped: true, verified: undefined, costUsd: undefined, iterations: undefined, tokens: undefined, wallMs: undefined }),
    ]),
    budgetUsd: 5,
    spentUsd: 1,
  }
  const file = buildRoutingFile(result, '2026-07-06T00:00:00.000Z')
  expect(file.recommendedAgents).toEqual({ worker: { adapter: 'codex' } })
  expect(file.benchmarkedAt).toBe('2026-07-06T00:00:00.000Z')
  expect(file.results.map((r) => r.id)).toEqual(['codex', 'claude-code-sonnet', 'claude-code-haiku'])
  expect(file.results[0]).toMatchObject({
    id: 'codex', verified: true, iterations: 1, costUsd: 0.2, tokens: 10, wallMs: 100, skipped: false,
  })
  expect(file.results[2]).toEqual({
    id: 'claude-code-haiku',
    agents: { worker: { adapter: 'claude-code-haiku' } },
    skipped: true,
  })
})

test('mixLabel collapses a single-engine variant and spells out a mixed one', () => {
  expect(mixLabel({ worker: { adapter: 'claude-code', model: 'sonnet' }, checker: { adapter: 'claude-code', model: 'sonnet' } }))
    .toBe('claude-code/sonnet')
  expect(mixLabel({ worker: { adapter: 'claude-code', model: 'opus' }, checker: { adapter: 'codex' } }))
    .toBe('worker=claude-code/opus checker=codex')
})
