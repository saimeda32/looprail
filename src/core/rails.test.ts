import { expect, test } from 'vitest'
import { RailsGuard } from './rails.js'

test('no breach within limits', () => {
  const g = new RailsGuard({ maxIterations: 3, maxCostUsd: 1 })
  g.addCost(0.5)
  expect(g.check(3)).toBeNull()
})

test('iteration breach past max', () => {
  const g = new RailsGuard({ maxIterations: 3, maxCostUsd: 1 })
  expect(g.check(4)).toMatchObject({ rail: 'iterations' })
})

test('cost breach at or past budget, and spend accumulates', () => {
  const g = new RailsGuard({ maxIterations: 9, maxCostUsd: 1 })
  g.addCost(0.6); g.addCost(0.4)
  expect(g.spentUsd).toBeCloseTo(1)
  expect(g.check(1)).toMatchObject({ rail: 'cost' })
})

test('wall-clock breach with injected clock', () => {
  let t = 0
  const g = new RailsGuard({ maxIterations: 9, maxCostUsd: 9, maxWallMinutes: 10 }, () => t)
  expect(g.check(1)).toBeNull()
  t = 11 * 60_000
  expect(g.check(1)).toMatchObject({ rail: 'wall' })
})
