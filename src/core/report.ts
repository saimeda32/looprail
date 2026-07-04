import type { FinalReport, LoopDef, NodeOutcome, ReportClaim } from './types.js'

// Mirrors parseVerdict's own SCORE/EVIDENCE parsing style (core/verdict.ts):
// a fixed reply format the model is told to follow, parsed with anchored,
// case-insensitive line regexes rather than asking for JSON a real model
// reply routinely wraps in prose or a code fence.
export function parseReport(output: string): FinalReport | null {
  const summaryMatch = /^SUMMARY:\s*(.+)$/im.exec(output)
  if (!summaryMatch) return null
  const claims: ReportClaim[] = []
  const claimRe = /^CLAIM:\s*(.+?)\s*\|\s*CONFIDENCE:\s*(\d+)\s*\|\s*REASON:\s*(.+)$/gim
  let m: RegExpExecArray | null
  while ((m = claimRe.exec(output)) !== null) {
    const confidence = Math.max(0, Math.min(100, Number(m[2])))
    if (!Number.isFinite(confidence)) continue
    claims.push({ claim: m[1].trim(), confidence, reason: m[3].trim() })
  }
  return { summary: summaryMatch[1].trim(), claims, source: 'agent' }
}

// Every run gets a report, with or without a usable agent: no agent defined
// in the loopfile, the chosen one throws (rate limit, missing permissions,
// exhausted mock in a test), or its reply just doesn't parse - all fall back
// to this, built purely from the verdicts the engine already has in hand.
// Confidence here is a blunt pass=100/fail=0 proxy, not a judgment call; it
// is honest about being mechanical rather than narrated.
export function buildFallbackReport(
  outcomes: NodeOutcome[], status: 'verified' | 'halted', reason: string,
): FinalReport {
  const claims: ReportClaim[] = outcomes
    .filter((o): o is NodeOutcome & { verdict: NonNullable<NodeOutcome['verdict']> } => o.verdict !== null)
    .map((o) => ({
      claim: `${o.nodeId} (${o.role})`,
      confidence: o.verdict.status === 'pass' ? 100 : 0,
      reason: o.verdict.evidence || `verdict: ${o.verdict.status}`,
    }))
  const summary = status === 'verified' ? `Verified: ${reason}.` : `Halted: ${reason}.`
  return { summary, claims, source: 'fallback' }
}

export function buildReportPrompt(
  goal: string, status: 'verified' | 'halted', reason: string, outcomes: NodeOutcome[],
): string {
  const lines = outcomes.map((o) => {
    const v = o.verdict
    return `- ${o.nodeId} (${o.role}): ${v ? `${v.status} - ${v.evidence}` : 'no verdict'}`
  })
  return [
    `Goal: ${goal}`,
    `Final status: ${status} (${reason})`,
    '',
    "Node results from the run's final iteration:",
    ...lines,
    '',
    'Write a concise (2-4 sentence) plain-English summary of what was actually',
    'accomplished or attempted. Then list each distinct, checkable claim about',
    'the outcome with a confidence score (0-100) that it is genuinely true, and',
    'a one-line reason for that score. Reply in exactly this format:',
    'SUMMARY: <2-4 sentence summary>',
    'CLAIM: <short claim text> | CONFIDENCE: <0-100> | REASON: <one line>',
    '(one CLAIM line per distinct claim)',
  ].join('\n')
}

// Prefers the last verifier (critic/judge) that actually ran - it already
// holds the most scrutinizing view of the outcome - then the last executor
// that ran. Deliberately scans outcomes, not def.nodes: a node a rail
// skipped before it ever started has no outcome and must never be asked to
// report on a run it never participated in (real cost for a call the rail
// specifically prevented). Returns undefined when nothing with an agent
// ran at all - a pure shell/tester pipeline, or everything got skipped -
// the one case with no real evidence of any agent's work to narrate, so
// there is nothing to spend on.
export function pickReportingAgentKey(def: LoopDef, outcomes: NodeOutcome[]): string | undefined {
  const agentFor = (nodeId: string): string | undefined => {
    // panel-expanded clones carry an "@n" suffix (e.g. "crit@2") not present
    // in the original node id def.nodes still uses
    const baseId = nodeId.split('@')[0]
    return def.nodes.find((n) => n.id === baseId)?.agent
  }
  const verifiers = outcomes.filter((o) => (o.role === 'critic' || o.role === 'judge') && agentFor(o.nodeId))
  if (verifiers.length > 0) return agentFor(verifiers[verifiers.length - 1].nodeId)
  const executors = outcomes.filter((o) => o.role === 'executor' && agentFor(o.nodeId))
  if (executors.length > 0) return agentFor(executors[executors.length - 1].nodeId)
  return undefined
}
