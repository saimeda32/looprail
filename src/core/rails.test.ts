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

test('tighten lowers maxIterations/maxCostUsd when the fragment asks for less, never raises them', () => {
  const guard = new RailsGuard({ maxIterations: 10, maxCostUsd: 20 })
  guard.tighten({ maxIterations: 5, maxCostUsd: 50 }) // cost: fragment asks for MORE - must not win
  expect(guard.check(6)).toEqual({ rail: 'iterations', detail: 'iteration 6 exceeds max 5' })
  guard.addCost(19.99)
  expect(guard.check(1)).toBeNull() // cost ceiling stayed at the outer 20, not the fragment's looser 50
})

test('tighten with an empty partial changes nothing', () => {
  const guard = new RailsGuard({ maxIterations: 3, maxCostUsd: 1 })
  guard.tighten({})
  expect(guard.check(4)).toEqual({ rail: 'iterations', detail: 'iteration 4 exceeds max 3' })
})
