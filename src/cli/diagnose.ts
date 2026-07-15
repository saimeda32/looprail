import type { JournalEvent } from '../core/types.js'

// Turns "halted - rail breached (iterations)" into "here is what happened and
// here is your next move". The #1 friction using any agent loop is a run that
// stops and leaves you staring at a terse reason with no idea what to do.
// This reads the journal (deterministic, no model) and produces a plain
// explanation plus concrete next steps. Printed automatically when a run
// halts, and available for any past run via `looprail why <runId>`.

export interface RunFacts {
  status: 'verified' | 'halted'
  reason: string
  iterations: number
  costUsd: number
  estimatedCostUsd: number
  gaps?: Array<{ node: string; gap: string }>
}

export interface Diagnosis {
  headline: string
  cause?: string
  nextSteps: string[]
}

interface FailNote { node: string; evidence: string; iteration: number }

// Every failing/erroring verdict the run journaled, in order.
function failures(events: JournalEvent[]): FailNote[] {
  const out: FailNote[] = []
  for (const e of events) {
    if (e.type !== 'node_end') continue
    const d = e.data as { nodeId?: string; iteration?: number; verdict?: { status?: string; evidence?: string } | null }
    const v = d.verdict
    if (v && (v.status === 'fail' || v.status === 'error') && v.evidence) {
      out.push({ node: String(d.nodeId), evidence: v.evidence, iteration: Number(d.iteration ?? 0) })
    }
  }
  return out
}

// A failure whose evidence recurred across two or more iterations for the
// same node - the run was stuck on it, not making progress.
function recurringFailure(fails: FailNote[]): FailNote | null {
  const seen = new Map<string, Set<number>>()
  for (const f of fails) {
    const key = `${f.node}\0${f.evidence}`
    ;(seen.get(key) ?? seen.set(key, new Set()).get(key)!).add(f.iteration)
  }
  for (const f of fails) {
    if ((seen.get(`${f.node}\0${f.evidence}`)?.size ?? 0) >= 2) return f
  }
  return null
}

// The agent that spent the most (real + estimated), for cost-halt advice.
function topSpender(events: JournalEvent[]): { agent: string; cost: number } | null {
  const byAgent = new Map<string, number>()
  for (const e of events) {
    if (e.type !== 'node_end') continue
    const d = e.data as { agent?: string; costUsd?: number; estimatedCostUsd?: number }
    if (!d.agent) continue
    byAgent.set(d.agent, (byAgent.get(d.agent) ?? 0) + (d.costUsd ?? 0) + (d.estimatedCostUsd ?? 0))
  }
  let top: { agent: string; cost: number } | null = null
  for (const [agent, cost] of byAgent) {
    if (!top || cost > top.cost) top = { agent, cost }
  }
  return top && top.cost > 0 ? top : null
}

export function diagnoseRun(facts: RunFacts, events: JournalEvent[]): Diagnosis {
  const { reason } = facts
  const spent = `$${facts.costUsd.toFixed(2)}${facts.estimatedCostUsd > 0 ? ` (+ ~$${facts.estimatedCostUsd.toFixed(2)} est)` : ''}`

  if (facts.status === 'verified') {
    const steps: string[] = ['ship it as a PR whose body is this evidence: `looprail run --pr`']
    if (facts.gaps && facts.gaps.length > 0) {
      steps.unshift(`it passed with ${facts.gaps.length} named gap(s) above - decide if any should block before shipping`)
    }
    return { headline: `Verified in ${facts.iterations} iteration(s), ${spent}.`, nextSteps: steps }
  }

  const allFails = failures(events)
  const stuck = recurringFailure(allFails)
  const lastFail = allFails.length > 0 ? allFails[allFails.length - 1] : null

  // Parked on a human gate - not a failure, just waiting.
  if (/^parked/.test(reason)) {
    return {
      headline: 'Parked, waiting for your approval - nothing failed.',
      cause: reason.replace(/^parked awaiting human approval:\s*/, 'gate: '),
      nextSteps: [
        'answer it: `looprail resume <runId>` (the gate will ask again), or open the dashboard with `looprail ui --all`',
        'work already done is cached - resuming re-bills nothing',
      ],
    }
  }

  // Config / infrastructure - the loop or the environment is wrong; iterating
  // can never fix it.
  if (/^config error|^infrastructure error/.test(reason)) {
    return {
      headline: 'The loop or its environment is misconfigured - this could never have passed.',
      cause: reason,
      nextSteps: [
        'fix the named node or command (a wrong test command, an unregistered agent, a missing tool), then re-run',
        '`looprail lint <loopfile>` catches most of these before spending',
      ],
    }
  }

  // A guard rail halted a persistent offender.
  if (/protected files were modified again/.test(reason)) {
    return {
      headline: 'The agent kept editing the tests instead of the code - the protect rail stopped it.',
      cause: 'It was told to revert and change the implementation, and changed the tests again anyway.',
      nextSteps: [
        'look at what it kept trying: `looprail logs <runId>`',
        'the tests are the spec here; if a test really is wrong, fix it yourself and re-run - the agent is not allowed to',
      ],
    }
  }
  if (/files outside the declared scope were changed again/.test(reason)) {
    return {
      headline: 'The agent kept touching files outside the declared scope - the scope rail stopped it.',
      cause: 'It was told to stay within `scope:` and went outside it again.',
      nextSteps: [
        'if the extra files genuinely need changing, widen `scope:` in the loopfile',
        'otherwise the task may be under-specified - `looprail logs <runId>` shows what it reached for',
      ],
    }
  }
  if (/the test suite was weakened again/.test(reason)) {
    return {
      headline: 'The agent kept weakening its own tests - the no_weaker_tests rail stopped it.',
      cause: 'It removed assertions or added skips instead of making the code pass, twice.',
      nextSteps: [
        '`looprail logs <runId>` shows which tests it gutted',
        'the work likely needs a real fix it could not find - consider a stronger worker model or a narrower goal',
      ],
    }
  }

  // Not converging / stalled - repeated identical failure.
  if (/^not converging|^stalled/.test(reason)) {
    return {
      headline: 'The loop got stuck repeating the same failure - more iterations would not help.',
      cause: stuck
        ? `"${stuck.node}" kept failing with the same problem: ${stuck.evidence}`
        : reason,
      nextSteps: [
        'this usually needs a human decision, not more budget - read the recurring failure above and either fix the blocker yourself or change the approach',
        stuck ? `dig in: \`looprail logs <runId> ${stuck.node}\`` : 'dig in: `looprail logs <runId>`',
        'if a plateau should trigger a replan instead of a halt, set `stall_after:` in the loopfile',
      ],
    }
  }

  // Budget rails.
  if (/rail breached \(cost\)/.test(reason)) {
    const spender = topSpender(events)
    return {
      headline: `Ran out of budget after ${facts.iterations} iteration(s) - spent ${spent}.`,
      cause: lastFail ? `it was still failing on: ${lastFail.evidence}` : 'the work was not verified when the money ran out.',
      nextSteps: [
        spender
          ? `"${spender.agent}" spent the most ($${spender.cost.toFixed(2)}) - a cheaper model there stretches the budget furthest`
          : 'try a cheaper model on the most expensive role (`looprail spend` shows the split)',
        'or raise `max_cost_usd:` if the loop was close and genuinely making progress',
      ],
    }
  }
  if (/rail breached \(iterations\)/.test(reason)) {
    return {
      headline: `Hit the iteration limit after ${facts.iterations} pass(es), still not verified.`,
      cause: stuck
        ? `it was stuck on the same failure - "${stuck.node}": ${stuck.evidence}`
        : 'each iteration failed a verifier; it may have been making progress but ran out of passes.',
      nextSteps: stuck
        ? ['it was NOT making progress (same failure repeating) - raising `max_iterations:` will not help; read the failure above and change the approach']
        : ['if it was getting closer each pass, raise `max_iterations:`', 'if not, `looprail logs <runId>` shows where it is stuck'],
    }
  }
  if (/rail breached \(wall\)/.test(reason)) {
    return {
      headline: `Ran out of wall-clock time after ${facts.iterations} iteration(s).`,
      cause: 'a node took longer than the `max_wall_minutes:` budget allowed.',
      nextSteps: ['raise `max_wall_minutes:`, or find the slow node with `looprail logs <runId>`'],
    }
  }

  // Skipped-nodes / partial verification.
  if (/node\(s\) skipped before verification/.test(reason)) {
    return {
      headline: 'A rail cut the run off mid-iteration, before every verifier ran.',
      cause: reason,
      nextSteps: ['raise the rail that fired so the loop can finish an iteration, then re-run'],
    }
  }

  // Fallback: still better than the raw reason.
  return {
    headline: `Halted after ${facts.iterations} iteration(s), ${spent}.`,
    cause: reason,
    nextSteps: [
      stuck ? `recurring failure - "${stuck.node}": ${stuck.evidence}` : 'inspect what happened: `looprail logs <runId>`',
      '`looprail replay <runId>` re-renders the whole run',
    ],
  }
}

// Pull the RunFacts a diagnosis needs straight from a journal, for `why` on a
// past run (no RunReport in hand). The terminal verified/halt event carries
// status, reason, and cost; iteration count is the last iteration_end.
export function factsFromJournal(events: JournalEvent[]): RunFacts | null {
  let facts: RunFacts | null = null
  let iterations = 0
  const gaps: Array<{ node: string; gap: string }> = []
  for (const e of events) {
    if (e.type === 'iteration_end') iterations = Number((e.data as { iteration?: number }).iteration ?? iterations)
    if (e.type === 'node_end') {
      const d = e.data as { nodeId?: string; verdict?: { status?: string; gaps?: string[] } | null }
      if (d.verdict?.status === 'pass' && d.verdict.gaps) {
        for (const g of d.verdict.gaps) gaps.push({ node: String(d.nodeId), gap: g })
      }
    }
    if (e.type === 'verified' || e.type === 'halt') {
      const d = e.data as { reason?: string; costUsd?: number; estimatedCostUsd?: number }
      facts = {
        status: e.type === 'verified' ? 'verified' : 'halted',
        reason: String(d.reason ?? ''),
        iterations,
        costUsd: Number(d.costUsd ?? 0),
        estimatedCostUsd: Number(d.estimatedCostUsd ?? 0),
      }
    }
  }
  // gaps only meaningful on the final passing set; attach if verified
  if (facts && facts.status === 'verified' && gaps.length > 0) facts.gaps = gaps
  return facts
}
