import type { Verdict } from './types.js'

export function verdictFingerprint(verdicts: Verdict[]): string {
  return verdicts
    .filter((v) => v.status !== 'pass')
    .map((v) => {
      const bucket = v.score !== undefined ? `:${Math.round(v.score * 10) / 10}` : ''
      return `${v.node}:${v.status}${bucket}`
    })
    .sort()
    .join('|')
}

// Like verdictFingerprint but INCLUDING the evidence text, for the
// convergence breaker (see router.ts): "not converging" must mean the exact
// same failure recurs, not merely that the same node keeps failing. A
// critic that fails every iteration with genuinely different evidence
// ("attempt 0 wrong" -> "attempt 1 wrong") is engaging with changing work
// and must be allowed to keep iterating; only byte-identical failures are a
// true plateau. Kept separate so stall_after's coarser node+status
// fingerprint is unchanged.
export function progressFingerprint(verdicts: Verdict[]): string {
  return verdicts
    .filter((v) => v.status !== 'pass')
    .map((v) => `${v.node}:${v.status}:${v.evidence}`)
    .sort()
    .join('|')
}

export function detectStall(history: string[], stallAfter: number): boolean {
  if (history.length < stallAfter) return false
  const tail = history.slice(-stallAfter)
  return tail.every((f) => f === tail[0])
}
