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
  const verdicts = input.outcomes.flatMap((o) => (o.verdict ? [o.verdict] : []))
  // infrastructural errors (auth expiry) can never be fixed by iterating —
  // halt with the doctor hint carried in the evidence (spec §10)
  const infra = verdicts.filter((v) => v.status === 'error' && v.evidence.startsWith('infra:'))
  if (infra.length > 0) {
    return {
      action: 'halt',
      reason: `infrastructure error: ${infra.map((v) => v.evidence).join('; ')}`,
    }
  }
  // transient errors that survived retries route like failures: their evidence
  // feeds the next iteration instead of killing the run (spec §10)
  const softened = verdicts.map((v) =>
    v.status === 'error' ? { ...v, status: 'fail' as const } : v)
  // verdicts before breach: a run that verifies in the same iteration it
  // breaches a rail is still verified — the work is done and checked
  const status = aggregateVerdicts(softened, input.policy)
  if (status === 'pass') return { action: 'verified' }
  if (input.breach) {
    return { action: 'halt', reason: `rail breached (${input.breach.rail}): ${input.breach.detail}` }
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
