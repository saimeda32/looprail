import { describe, expect, test } from 'vitest'
import { applyEvent, renderLive, type LiveState } from './live-render.js'
import type { JournalEvent } from '../core/types.js'

const ev = (type: JournalEvent['type'], data: Record<string, unknown>): JournalEvent => ({ ts: 0, type, data })
const empty: LiveState = { iteration: 0, costUsd: 0, maxCostUsd: 5, rows: [] }

describe('applyEvent', () => {
  test('node_start adds a running row; node_end settles it with verdict + cost', () => {
    let s = applyEvent(empty, ev('node_start', { nodeId: 'fix', role: 'executor', iteration: 1 }), 1000)
    expect(s.rows[0]).toMatchObject({ id: 'fix', status: 'running' })
    s = applyEvent(s, ev('node_end', { nodeId: 'fix', costUsd: 0.5, verdict: null }), 2000)
    expect(s.rows[0]).toMatchObject({ status: 'done', costUsd: 0.5 })
    expect(s.costUsd).toBeCloseTo(0.5)
  })

  test('a re-running node updates its existing row back to running (no duplicate rows)', () => {
    let s = applyEvent(empty, ev('node_start', { nodeId: 'fix', role: 'executor', iteration: 1 }), 1000)
    s = applyEvent(s, ev('node_end', { nodeId: 'fix', costUsd: 0.2, verdict: { status: 'fail' } }), 1500)
    s = applyEvent(s, ev('node_start', { nodeId: 'fix', role: 'executor', iteration: 2 }), 2000)
    expect(s.rows).toHaveLength(1)
    expect(s.rows[0].status).toBe('running')
    expect(s.rows[0].costUsd).toBeCloseTo(0.2) // cost accumulates across attempts
    expect(s.iteration).toBe(2)
  })

  test('estimated cost counts toward the ticker (all-estimate CLIs still tick)', () => {
    let s = applyEvent(empty, ev('node_start', { nodeId: 'a', role: 'critic', iteration: 1 }), 0)
    s = applyEvent(s, ev('node_end', { nodeId: 'a', costUsd: 0, estimatedCostUsd: 0.03, verdict: { status: 'pass' } }), 1)
    expect(s.costUsd).toBeCloseTo(0.03)
  })

  test('skipped nodes render as skipped whether or not they ever started', () => {
    const s = applyEvent(empty, ev('node_skipped', { nodeId: 'ghost' }), 0)
    expect(s.rows[0].status).toBe('skipped')
  })
})

describe('renderLive', () => {
  test('header carries iteration, cost ticker, and running count; rows align', () => {
    let s = applyEvent(empty, ev('node_start', { nodeId: 'fix', role: 'executor', iteration: 2 }), 0)
    s = applyEvent(s, ev('node_start', { nodeId: 'tests', role: 'tester', iteration: 2 }), 0)
    const lines = renderLive(s, 5000, 1)
    expect(lines[0]).toContain('iter 2')
    expect(lines[0]).toContain('$0.00 / $5')
    expect(lines[0]).toContain('2 running')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('fix')
    expect(lines[2]).toContain('tests')
  })

  test('a running row shows elapsed seconds; a settled one shows its cost', () => {
    let s = applyEvent(empty, ev('node_start', { nodeId: 'fix', role: 'executor', iteration: 1 }), 1000)
    s = applyEvent(s, ev('node_end', { nodeId: 'fix', costUsd: 1.25, verdict: { status: 'pass' } }), 3000)
    s = applyEvent(s, ev('node_start', { nodeId: 'crit', role: 'critic', iteration: 1 }), 3000)
    const lines = renderLive(s, 8000, 0)
    expect(lines[1]).toContain('$1.25')
    expect(lines[2]).toContain('5s')
  })
})
