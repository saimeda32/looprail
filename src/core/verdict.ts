import type { Verdict, VerdictPolicy, VerdictStatus } from './types.js'

// Real models rarely emit the verdict block perfectly clean: they bold it
// (`**VERDICT: pass**`), prefix it (`## VERDICT`, `> VERDICT`, `- VERDICT`),
// add a trailing period, or continue on the same line (`VERDICT: pass - the
// diff looks right`). The old strict `^VERDICT:\s*(...)\s*$` rejected all of
// those, forcing a whole extra critic invocation just to re-ask for
// formatting (see engine/nodes.ts's verdict-retry) - wasted tokens on a
// reply that was already a clear pass or fail. This tolerates the common
// noise while keeping a line-start anchor (so a verdict mentioned mid-prose,
// e.g. "the verdict: pass rule", is never matched), and takes the LAST
// verdict line, since the critic is told to END with the block.
//
// A leading marker set - blockquote >, list -/*, heading #, bold ** - may
// precede the keyword; anything AFTER the pass/fail word on the line is
// ignored rather than disqualifying the match.
const VERDICT_LINE = /^[>\-*#\s]*\**\s*VERDICT:\s*\**\s*(pass|fail|stall|error)\b/gim
const SCORE_LINE = /^[>\-*#\s]*\**\s*SCORE:\s*\**\s*([\d.]+)/im
const EVIDENCE_LINE = /^[>\-*#\s]*\**\s*EVIDENCE:\s*\**\s*(.+)$/im
// Graded pass: named minor shortcomings on a passing verdict (see
// Verdict.gaps). Same prefix tolerance as the other lines; ";"-separated.
const GAPS_LINE = /^[>\-*#\s]*\**\s*GAPS:\s*\**\s*(.+)$/im

export function parseVerdict(nodeId: string, output: string): Verdict | null {
  // last VERDICT line wins - the critic is told to conclude with it, and a
  // model that reasons out loud may name pass/fail earlier in passing.
  const matches = [...output.matchAll(VERDICT_LINE)]
  const status = matches.length > 0 ? matches[matches.length - 1][1] : undefined
  if (!status) return null
  const scoreRaw = SCORE_LINE.exec(output)?.[1]
  const score = scoreRaw !== undefined ? Number(scoreRaw) : undefined
  const evidence = (EVIDENCE_LINE.exec(output)?.[1] ?? '').replace(/\*+\s*$/, '')
  // Gaps only ride on a PASS: on a fail they are just more failure evidence
  // (the critic already failed the work), and honoring them there would let
  // "VERDICT: fail ... GAPS: minor stuff" read as a graded pass in reports.
  const gapsRaw = status.toLowerCase() === 'pass' ? GAPS_LINE.exec(output)?.[1] : undefined
  const gaps = gapsRaw
    ?.replace(/\*+\s*$/, '')
    .split(';')
    .map((g) => g.trim())
    .filter((g) => g.length > 0 && !/^none\b/i.test(g))
  return {
    node: nodeId,
    status: status.toLowerCase() as VerdictStatus,
    evidence: evidence.trim(),
    ...(gaps && gaps.length > 0 ? { gaps } : {}),
    // a malformed SCORE (e.g. "0..7" → NaN) must not masquerade as a number
    ...(score !== undefined && Number.isFinite(score) ? { score } : {}),
  }
}

export function aggregateVerdicts(
  verdicts: Verdict[],
  policy: VerdictPolicy,
): VerdictStatus {
  if (verdicts.some((v) => v.status === 'error')) return 'error'
  if (verdicts.length === 0) return 'fail'
  if (policy.kind === 'weighted') {
    const total = verdicts.reduce((s, v) => s + (v.weight ?? 1), 0)
    const passed = verdicts
      .filter((v) => v.status === 'pass')
      .reduce((s, v) => s + (v.weight ?? 1), 0)
    return total > 0 && passed / total >= policy.threshold ? 'pass' : 'fail'
  }
  const passes = verdicts.filter((v) => v.status === 'pass').length
  if (policy.kind === 'quorum') return passes >= policy.atLeast ? 'pass' : 'fail'
  return passes === verdicts.length ? 'pass' : 'fail'
}
