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

export function detectStall(history: string[], stallAfter: number): boolean {
  if (history.length < stallAfter) return false
  const tail = history.slice(-stallAfter)
  return tail.every((f) => f === tail[0])
}
