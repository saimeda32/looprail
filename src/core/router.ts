import type { NodeOutcome, Rails, RouterDecision, VerdictPolicy } from './types.js'
import type { RailBreach } from './rails.js'
import { aggregateVerdicts } from './verdict.js'
import { detectStall } from './fingerprint.js'

export function composeFeedback(outcomes: NodeOutcome[]): string {
  return outcomes
    .filter((o) => o.verdict && o.verdict.status !== 'pass')
    .map((o) => `[${o.nodeId}] ${o.verdict!.evidence}`)
    .join('\n')
}

export interface RouteInput {
  outcomes: NodeOutcome[]
  policy: VerdictPolicy
  fingerprints: string[]
  rails: Rails
  replansUsed: number
  breach: RailBreach | null
}

export function routeIteration(input: RouteInput): RouterDecision {
  if (input.breach) {
    return { action: 'halt', reason: `rail breached (${input.breach.rail}): ${input.breach.detail}` }
  }
  const verdicts = input.outcomes.flatMap((o) => (o.verdict ? [o.verdict] : []))
  const status = aggregateVerdicts(verdicts, input.policy)
  if (status === 'pass') return { action: 'verified' }
  if (status === 'error') {
    const evidence = verdicts.filter((v) => v.status === 'error').map((v) => v.evidence).join('; ')
    return { action: 'halt', reason: `node error: ${evidence}` }
  }
  const feedback = composeFeedback(input.outcomes)
  if (input.rails.stallAfter && detectStall(input.fingerprints, input.rails.stallAfter)) {
    if (input.replansUsed < (input.rails.replanLimit ?? 1)) {
      return { action: 'replan', feedback }
    }
    return { action: 'halt', reason: 'stalled: identical failures persisted and replan limit exhausted' }
  }
  return { action: 'iterate', feedback }
}
