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

test('addCost with no second arg behaves exactly as before (backward compat)', () => {
  const g = new RailsGuard({ maxIterations: 9, maxCostUsd: 1 })
  g.addCost(0.6)
  g.addCost(0.4)
  expect(g.spentUsd).toBeCloseTo(1)
  expect(g.estimatedSpentUsd).toBe(0)
  expect(g.check(1)).toMatchObject({ rail: 'cost', detail: '$1.00 spent of $1 budget' })
})

test('addCost(0, est) accumulates estimated spend separately from real spend', () => {
  const g = new RailsGuard({ maxIterations: 9, maxCostUsd: 9 })
  g.addCost(0, 0.5)
  g.addCost(0, 0.5)
  expect(g.spentUsd).toBe(0)
  expect(g.estimatedSpentUsd).toBeCloseTo(1)
  expect(g.totalSpentUsd).toBeCloseTo(1)
  expect(g.check(1)).toBeNull()
})

test('check() breaches max_cost_usd on combined real+estimated spend, even when real spend alone is 0', () => {
  const g = new RailsGuard({ maxIterations: 9, maxCostUsd: 1 })
  g.addCost(0, 0.6)
  g.addCost(0, 0.4)
  const breach = g.check(1)
  expect(breach).toMatchObject({ rail: 'cost' })
  expect(breach!.detail).toContain('est')
  expect(breach!.detail).toMatch(/incl ~\$1\.00 est/)
})

test('check() cost detail mentions no estimate when spend is entirely real', () => {
  const g = new RailsGuard({ maxIterations: 9, maxCostUsd: 1 })
  g.addCost(1)
  const breach = g.check(1)
  expect(breach!.detail).not.toContain('est')
})

test('mixed real+estimated spend breaches on the combined total and labels the estimated portion', () => {
  const g = new RailsGuard({ maxIterations: 9, maxCostUsd: 1 })
  g.addCost(0.5, 0.6)
  const breach = g.check(1)
  expect(breach).toMatchObject({ rail: 'cost' })
  expect(breach!.detail).toContain('incl ~$0.60 est')
})

// A human deciding slowly on a gate isn't the loop "taking too long to do
// work" - charging that wait against max_wall_minutes would halt a run on
// a rail breach that has nothing to do with actual agent work happening.
test('time spent paused for a gate (beginGateWait/endGateWait) does not count toward max_wall_minutes', () => {
  let t = 0
  const g = new RailsGuard({ maxIterations: 9, maxCostUsd: 9, maxWallMinutes: 10 }, () => t)
  t = 5 * 60_000 // 5 real minutes of work
  expect(g.check(1)).toBeNull()
  g.beginGateWait()
  t = 60 * 60_000 // a human takes a full hour to decide
  g.endGateWait()
  t = 60 * 60_000 + 4 * 60_000 // 4 more real minutes of work: 9 real minutes total, still under 10
  expect(g.check(1)).toBeNull()
  t += 60_000 // 1 more real minute: 10 real minutes total, breaches
  expect(g.check(1)).toMatchObject({ rail: 'wall' })
})

test('remainingWallMs excludes completed and still-open gate-wait time the same way check() does', () => {
  let t = 0
  const g = new RailsGuard({ maxIterations: 9, maxCostUsd: 9, maxWallMinutes: 10 }, () => t)
  t = 3 * 60_000
  expect(g.remainingWallMs()).toBeCloseTo(7 * 60_000)
  g.beginGateWait()
  t = 3 * 60_000 + 30 * 60_000 // 30 minutes into an open gate wait
  // Still-open pause must not eat into the budget either - only completed
  // pauses (endGateWait) and real elapsed time do.
  expect(g.remainingWallMs()).toBeCloseTo(7 * 60_000)
  g.endGateWait()
  expect(g.remainingWallMs()).toBeCloseTo(7 * 60_000)
})

test('multiple separate gate waits each get excluded, not just the first', () => {
  let t = 0
  const g = new RailsGuard({ maxIterations: 9, maxCostUsd: 9, maxWallMinutes: 10 }, () => t)
  g.beginGateWait(); t = 20 * 60_000; g.endGateWait() // gate 1: 20min wait, excluded
  t = 22 * 60_000 // 2 real minutes since gate 1 ended
  g.beginGateWait(); t = 52 * 60_000; g.endGateWait() // gate 2: 30min wait, excluded
  t = 55 * 60_000 // 3 more real minutes: 5 real minutes total, well under 10
  expect(g.check(1)).toBeNull()
})
