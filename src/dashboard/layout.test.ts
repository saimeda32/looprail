import { expect, test } from 'vitest'
import type { JournalEvent } from '../core/types.js'
import { buildDashboardPayload, computeLayout } from './layout.js'

test('no edges: every node lands on layer 0, spread across y', () => {
  const layout = computeLayout(['a', 'b', 'c'], [])
  expect(layout.every((n) => n.layer === 0)).toBe(true)
  expect(layout.every((n) => n.x === layout[0].x)).toBe(true)
  expect(new Set(layout.map((n) => n.y)).size).toBe(3) // distinct y per node
})

test('a chain a->b->c lays out in three increasing layers/x', () => {
  const layout = computeLayout(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']])
  const byId = new Map(layout.map((n) => [n.id, n]))
  expect(byId.get('a')!.layer).toBe(0)
  expect(byId.get('b')!.layer).toBe(1)
  expect(byId.get('c')!.layer).toBe(2)
  expect(byId.get('a')!.x).toBeLessThan(byId.get('b')!.x)
  expect(byId.get('b')!.x).toBeLessThan(byId.get('c')!.x)
})

test('a diamond a->b, a->c, b->d, c->d puts d past both b and c', () => {
  const layout = computeLayout(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']])
  const byId = new Map(layout.map((n) => [n.id, n]))
  expect(byId.get('a')!.layer).toBe(0)
  expect(byId.get('b')!.layer).toBe(1)
  expect(byId.get('c')!.layer).toBe(1)
  expect(byId.get('d')!.layer).toBe(2) // longest-path layering, not first-seen
})

test('a node referenced only by an edge (not in nodeIds) does not crash layout', () => {
  const layout = computeLayout(['a'], [['a', 'ghost']])
  expect(layout.map((n) => n.id)).toEqual(['a'])
})

test('buildDashboardPayload composes the view-model with a layout for every node', () => {
  const events: JournalEvent[] = [{ ts: 0, type: 'run_start', data: { runId: 'r', name: 'n', goal: 'g' } }]
  const payload = buildDashboardPayload(events)
  expect(payload.runId).toBe('r')
  expect(payload.layout).toEqual([])
})
