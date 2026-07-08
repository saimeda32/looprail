import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RunReport } from '../core/types.js'

const execFileAsync = promisify(execFile)

// `looprail run --pr`: a VERIFIED run ships itself as a pull request whose
// description is the run's evidence - verdicts, named gaps, cost, files -
// rather than agent prose. The reviewer reads proof, not narrative. Only a
// verified run may open one; halted work never ships.

export type PrExec = (file: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>

const defaultExec: PrExec = async (file, args, opts = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { cwd: opts.cwd, maxBuffer: 8 * 1024 * 1024 })
    return { stdout, stderr }
  } catch (e) {
    // execFile's error message is just "Command failed: ..." - the actual
    // reason (auth, missing remote, branch protection) lives on stderr.
    // A user staring at "git push failed" with no why cannot act on it.
    const err = e as Error & { stderr?: string }
    throw new Error(`${file} ${args.slice(0, 2).join(' ')} failed: ${(err.stderr ?? err.message).trim().slice(0, 400)}`)
  }
}

// Preflight for --pr, run BEFORE any agent spends: a verified run that then
// can't ship its PR wastes the whole point of asking for one.
export async function preflightPr(cwd: string, exec: PrExec = defaultExec): Promise<string | null> {
  try {
    await exec('git', ['rev-parse', '--git-dir'], { cwd })
  } catch {
    return '--pr needs a git repository - `git init` first, or drop --pr'
  }
  try {
    await exec('gh', ['auth', 'status'], { cwd })
  } catch {
    return '--pr needs the GitHub CLI logged in - `gh auth login`, or drop --pr'
  }
  return null
}

export function buildPrBody(report: RunReport): string {
  const lines: string[] = []
  lines.push(`Opened by looprail from verified run \`${report.runId}\` - every check below actually ran.`)
  lines.push('')
  lines.push(`| | |`)
  lines.push(`| --- | --- |`)
  lines.push(`| Status | **verified** - ${report.reason} |`)
  lines.push(`| Iterations | ${report.iterations} |`)
  lines.push(`| Cost | $${report.costUsd.toFixed(2)}${report.estimatedCostUsd > 0 ? ` (+ ~$${report.estimatedCostUsd.toFixed(2)} estimated)` : ''} |`)
  lines.push('')
  lines.push('### Verdicts')
  lines.push('')
  lines.push('| node | role | verdict | evidence |')
  lines.push('| --- | --- | --- | --- |')
  for (const o of report.outcomes) {
    if (!o.verdict) continue
    lines.push(`| ${o.nodeId} | ${o.role} | ${o.verdict.status} | ${o.verdict.evidence.slice(0, 200).replace(/\|/g, '\\|')} |`)
  }
  if (report.gaps.length > 0) {
    lines.push('')
    lines.push('### Named gaps (passed, with these shortcomings)')
    lines.push('')
    for (const g of report.gaps) lines.push(`- **[${g.node}]** ${g.gap}`)
  }
  if (report.report.filesTouched && report.report.filesTouched.length > 0) {
    lines.push('')
    lines.push('### Files touched (per git, not per the agent)')
    lines.push('')
    for (const f of report.report.filesTouched) lines.push(`- \`${f}\``)
  }
  lines.push('')
  lines.push(`_Full evidence trail: the run's journal; \`looprail replay ${report.runId}\` re-renders it._`)
  return lines.join('\n')
}

export interface PrResult {
  branch: string
  url: string
}

export async function createVerifiedPr(
  cwd: string, report: RunReport, exec: PrExec = defaultExec,
): Promise<PrResult> {
  if (report.status !== 'verified') {
    throw new Error(`refusing to open a PR for a ${report.status} run - only verified work ships`)
  }
  const branch = `looprail/${report.runId}`
  // `??` alone is wrong here: a fallback-built report can carry an EMPTY
  // summary string, which is not nullish - and GitHub rejects a blank PR
  // title outright ("can't be blank"). Caught live in the battle test.
  const title = (report.report.summary ?? '').split('\n')[0].trim().slice(0, 72)
    || `looprail: verified run ${report.runId}`
  // Anything uncommitted (the usual case) gets committed on the new branch;
  // an agent that already committed mid-run just means nothing to add here.
  await exec('git', ['checkout', '-b', branch], { cwd })
  await exec('git', ['add', '-A'], { cwd })
  const status = await exec('git', ['status', '--porcelain'], { cwd })
  if (status.stdout.trim().length > 0) {
    await exec('git', ['commit', '-m', `${title}\n\nverified by looprail run ${report.runId}`], { cwd })
  } else {
    // no uncommitted changes AND no commits beyond the base would mean an
    // empty PR; let `gh pr create` be the judge of whether a diff exists.
  }
  await exec('git', ['push', '-u', 'origin', branch], { cwd })
  const created = await exec('gh', [
    'pr', 'create',
    '--head', branch,
    '--title', title,
    '--body', buildPrBody(report),
  ], { cwd })
  const url = created.stdout.trim().split('\n').pop() ?? ''
  return { branch, url }
}
