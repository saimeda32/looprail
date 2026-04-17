import { expect, test } from 'vitest'
import { detectStall, verdictFingerprint } from './fingerprint.js'
import type { Verdict } from './types.js'

const v = (node: string, status: Verdict['status'], score?: number): Verdict =>
  ({ node, status, evidence: 'e', score })

test('same failing set gives same fingerprint regardless of order', () => {
  expect(verdictFingerprint([v('a', 'fail'), v('b', 'fail')]))
    .toBe(verdictFingerprint([v('b', 'fail'), v('a', 'fail')]))
})

test('passing verdicts do not affect the fingerprint', () => {
  expect(verdictFingerprint([v('a', 'fail'), v('c', 'pass')]))
    .toBe(verdictFingerprint([v('a', 'fail')]))
})

test('improving judge score changes the fingerprint (not a stall)', () => {
  expect(verdictFingerprint([v('j', 'fail', 0.4)]))
    .not.toBe(verdictFingerprint([v('j', 'fail', 0.7)]))
})

test('score noise within a decile does not change the fingerprint', () => {
  expect(verdictFingerprint([v('j', 'fail', 0.41)]))
    .toBe(verdictFingerprint([v('j', 'fail', 0.44)]))
})

test('detectStall requires N identical trailing fingerprints', () => {
  expect(detectStall(['x', 'x', 'x'], 3)).toBe(true)
  expect(detectStall(['y', 'x', 'x'], 3)).toBe(false)
  expect(detectStall(['x', 'x'], 3)).toBe(false)
})
