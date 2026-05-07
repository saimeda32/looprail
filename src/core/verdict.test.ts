import { describe, expect, test } from 'vitest'
import { aggregateVerdicts, parseVerdict } from './verdict.js'
import type { Verdict } from './types.js'

const v = (status: Verdict['status'], score?: number): Verdict =>
  ({ node: 'n', status, evidence: 'e', score })

describe('parseVerdict', () => {
  test('parses a full verdict block', () => {
    const out = 'analysis...\nVERDICT: fail\nSCORE: 0.4\nEVIDENCE: two claims lack sources'
    expect(parseVerdict('judge', out)).toEqual({
      node: 'judge', status: 'fail', score: 0.4, evidence: 'two claims lack sources',
    })
  })

  test('parses pass without score', () => {
    const verdict = parseVerdict('crit', 'VERDICT: pass\nEVIDENCE: found no flaws')
    expect(verdict).toMatchObject({ status: 'pass', evidence: 'found no flaws' })
  })

  test('returns null when no verdict block exists', () => {
    expect(parseVerdict('crit', 'I looked at it and it seems fine')).toBeNull()
  })

  test('malformed SCORE that parses to NaN is omitted, not carried as NaN', () => {
    const verdict = parseVerdict('judge', 'VERDICT: pass\nSCORE: 0..7\nEVIDENCE: great')
    expect(verdict).toMatchObject({ status: 'pass', evidence: 'great' })
    expect(verdict).not.toHaveProperty('score')
  })
})

describe('aggregateVerdicts', () => {
  test('all-pass: any fail fails the set', () => {
    expect(aggregateVerdicts([v('pass'), v('fail')], { kind: 'all-pass' })).toBe('fail')
    expect(aggregateVerdicts([v('pass'), v('pass')], { kind: 'all-pass' })).toBe('pass')
  })

  test('error dominates', () => {
    expect(aggregateVerdicts([v('pass'), v('error')], { kind: 'all-pass' })).toBe('error')
  })

  test('quorum passes at threshold', () => {
    const set = [v('pass'), v('pass'), v('fail')]
    expect(aggregateVerdicts(set, { kind: 'quorum', atLeast: 2 })).toBe('pass')
    expect(aggregateVerdicts(set, { kind: 'quorum', atLeast: 3 })).toBe('fail')
  })

  test('empty verdict set fails (nothing verified anything)', () => {
    expect(aggregateVerdicts([], { kind: 'all-pass' })).toBe('fail')
  })
})
