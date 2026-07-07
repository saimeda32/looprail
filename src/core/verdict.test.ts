import { describe, expect, test } from 'vitest'
import { aggregateVerdicts, parseVerdict } from './verdict.js'
import type { Verdict } from './types.js'

const v = (status: Verdict['status'], score?: number): Verdict =>
  ({ node: 'n', status, evidence: 'e', score })
const vw = (status: Verdict['status'], weight?: number): Verdict =>
  ({ node: 'n', status, evidence: 'e', weight })

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

  test('weighted: pass-weight over total-weight against threshold', () => {
    const set = [vw('pass', 2), vw('pass', 1), vw('fail', 1)] // 3/4 = 0.75
    expect(aggregateVerdicts(set, { kind: 'weighted', threshold: 0.7 })).toBe('pass')
    expect(aggregateVerdicts(set, { kind: 'weighted', threshold: 0.8 })).toBe('fail')
  })

  test('weighted: missing weights default to 1', () => {
    const set = [vw('pass'), vw('pass'), vw('fail')] // 2/3 ≈ 0.67
    expect(aggregateVerdicts(set, { kind: 'weighted', threshold: 0.6 })).toBe('pass')
    expect(aggregateVerdicts(set, { kind: 'weighted', threshold: 0.7 })).toBe('fail')
  })

  test('weighted: error still dominates and empty set still fails', () => {
    expect(aggregateVerdicts([vw('pass', 9), vw('error')], { kind: 'weighted', threshold: 0.1 }))
      .toBe('error')
    expect(aggregateVerdicts([], { kind: 'weighted', threshold: 0.1 })).toBe('fail')
  })
})


// Robust parsing: real critics format the block imperfectly. Each of these
// used to return null -> a wasted re-ask invocation; now they parse.
test('parses a verdict wrapped in markdown bold', () => {
  expect(parseVerdict('c', '**VERDICT: pass**')?.status).toBe('pass')
})

test('parses a verdict with a heading, blockquote, or list prefix', () => {
  expect(parseVerdict('c', '## VERDICT: fail')?.status).toBe('fail')
  expect(parseVerdict('c', '> VERDICT: pass')?.status).toBe('pass')
  expect(parseVerdict('c', '- VERDICT: fail')?.status).toBe('fail')
})

test('parses a verdict with trailing text or punctuation on the line', () => {
  expect(parseVerdict('c', 'VERDICT: pass.')?.status).toBe('pass')
  expect(parseVerdict('c', 'VERDICT: fail - the diff dropped an assertion')?.status).toBe('fail')
})

test('takes the LAST verdict line when a critic reasons out loud first', () => {
  const out = ['My initial verdict: pass seemed likely, but on review:', 'VERDICT: fail', 'EVIDENCE: found a weakened test'].join('\n')
  const v = parseVerdict('c', out)
  expect(v?.status).toBe('fail')
  expect(v?.evidence).toBe('found a weakened test')
})

test('never matches a verdict mentioned mid-prose (line-start anchor holds)', () => {
  expect(parseVerdict('c', 'the verdict: pass criterion is strict but no block here')).toBeNull()
})

test('parses bold SCORE and EVIDENCE, stripping trailing bold markers', () => {
  const v = parseVerdict('c', ['**VERDICT: pass**', '**SCORE:** 0.9', '**EVIDENCE:** solid work**'].join('\n'))
  expect(v?.status).toBe('pass')
  expect(v?.score).toBe(0.9)
  expect(v?.evidence).toBe('solid work')
})
