import type { Verdict, VerdictPolicy, VerdictStatus } from './types.js'

export function parseVerdict(nodeId: string, output: string): Verdict | null {
  const status = /^VERDICT:\s*(pass|fail|stall|error)\s*$/im.exec(output)?.[1]
  if (!status) return null
  const score = /^SCORE:\s*([\d.]+)\s*$/im.exec(output)?.[1]
  const evidence = /^EVIDENCE:\s*(.+)$/im.exec(output)?.[1] ?? ''
  return {
    node: nodeId,
    status: status.toLowerCase() as VerdictStatus,
    evidence: evidence.trim(),
    ...(score !== undefined ? { score: Number(score) } : {}),
  }
}

export function aggregateVerdicts(
  verdicts: Verdict[],
  policy: VerdictPolicy,
): VerdictStatus {
  if (verdicts.some((v) => v.status === 'error')) return 'error'
  if (verdicts.length === 0) return 'fail'
  const passes = verdicts.filter((v) => v.status === 'pass').length
  if (policy.kind === 'quorum') return passes >= policy.atLeast ? 'pass' : 'fail'
  return passes === verdicts.length ? 'pass' : 'fail'
}
