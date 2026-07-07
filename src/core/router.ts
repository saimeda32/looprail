import type { NodeOutcome, Rails, RouterDecision, VerdictPolicy } from './types.js'
import type { RailBreach } from './rails.js'
import { aggregateVerdicts } from './verdict.js'
import { detectStall } from './fingerprint.js'

// How many byte-identical failing iterations, absent an explicit
// stall_after, mean "not making progress" and trip the convergence
// breaker. 3 (not 2) so a single legitimate retry of the same shape isn't
// mistaken for a plateau; a loop that genuinely fixes forward changes its
// failing set well before three identical rounds.
const DEFAULT_CONVERGENCE_LIMIT = 3

export function composeFeedback(outcomes: NodeOutcome[]): string {
  return outcomes
    .filter((o) => o.verdict && o.verdict.status !== 'pass')
    .map((o) => `[${o.nodeId}] ${o.verdict!.evidence}`)
    .join('\n')
}

export interface RouteInput {
  outcomes: NodeOutcome[]
  policy: VerdictPolicy
  // Coarse node+status(+score) fingerprints per iteration, for stall_after.
  fingerprints: string[]
  // Evidence-inclusive fingerprints per iteration, for the convergence
  // breaker - a plateau is the exact same failure recurring, not just the
  // same node failing (see fingerprint.ts's progressFingerprint). Optional
  // so existing callers/tests that only pass `fingerprints` still compile;
  // the breaker simply doesn't fire without it.
  progressFingerprints?: string[]
  rails: Rails
  replansUsed: number
  breach: RailBreach | null
}

export function routeIteration(input: RouteInput): RouterDecision {
  const verdicts = input.outcomes.flatMap((o) => (o.verdict ? [o.verdict] : []))
  // A gate that never got its human answer within gate_timeout is NOT an
  // infrastructure failure - the run did nothing wrong, a human was just
  // busy. Real halt caught live: a run that planned, survived review, built,
  // and passed its tests was reported as "halted - infrastructure error"
  // purely because its human wasn't at the screen for 10 minutes. The run
  // still halts (the process can't wait forever holding resources), but as
  // PARKED: a deliberately distinct classification so the CLI/dashboard can
  // present it as "resume to answer the gate" rather than as a failure.
  // Everything already-passed is in the journal cache, so a resume re-asks
  // only the gate and continues - parking costs zero repeated work.
  const parked = verdicts.filter((v) => v.status === 'error' && v.evidence.startsWith('parked:'))
  if (parked.length > 0) {
    return {
      action: 'halt',
      reason: `parked awaiting human approval: ${parked.map((v) => v.evidence.replace(/^parked:\s*/, '')).join('; ')}`,
    }
  }
  // infrastructural errors (auth expiry) can never be fixed by iterating -
  // halt with the doctor hint carried in the evidence (spec §10)
  const infra = verdicts.filter((v) => v.status === 'error' && v.evidence.startsWith('infra:'))
  if (infra.length > 0) {
    return {
      action: 'halt',
      reason: `infrastructure error: ${infra.map((v) => v.evidence.replace(/^(infra|config):\s*/, '')).join('; ')}`,
    }
  }
  // config/structural errors (bad graph wiring: an unresolved "of" target, a
  // missing gate handler, an unregistered adapter, ...) reproduce identically
  // every iteration - iterating can never fix them, so halt loudly instead of
  // silently churning (C1/I4: reviewing nothing must never silently continue)
  const config = verdicts.filter((v) => v.status === 'error' && v.evidence.startsWith('config:'))
  if (config.length > 0) {
    return {
      action: 'halt',
      reason: `config error - check your loop definition: ${config.map((v) => `[${v.node}] ${v.evidence.replace(/^(infra|config):\s*/, '')}`).join('; ')}`,
    }
  }
  // remaining errors are transient (an adapter that survived retries but
  // still failed) and route like failures: their evidence feeds the next
  // iteration instead of killing the run (spec §10)
  const softened = verdicts.map((v) =>
    v.status === 'error' ? { ...v, status: 'fail' as const } : v)
  // verdicts before breach: a run that verifies in the same iteration it
  // breaches a rail is still verified - the work is done and checked
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
  // Always-on convergence breaker. Even without an explicit stall_after, a
  // loop producing the byte-identical failing state every iteration is not
  // making progress - it will only grind to the iteration/wall rail burning
  // budget. Caught live: a loop iterated to its wall against the same
  // failure repeatedly. When stall_after IS set, the block above already
  // governs (and may replan); this floor applies only when it isn't set, so
  // an unconfigured loop still stops instead of running the whole budget.
  if (!input.rails.stallAfter && input.progressFingerprints
    && detectStall(input.progressFingerprints, DEFAULT_CONVERGENCE_LIMIT)) {
    return {
      action: 'halt',
      reason: `not converging: the same failure(s) persisted across ${DEFAULT_CONVERGENCE_LIMIT} iterations without change - the loop is not making progress (set stall_after to replan on a plateau instead)`,
    }
  }
  return { action: 'iterate', feedback }
}
