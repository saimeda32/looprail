import { scanForInjection } from '../core/injection.js'

// `looprail run --from-issue <ref>` - the 2026-native workflow: point the
// loop at a GitHub issue and the issue IS the goal; with --pr the verified
// result comes back as a PR that closes it. Accepted refs:
//   https://github.com/owner/repo/issues/123
//   owner/repo#123
//   123  or  #123        (repo inferred from the cwd's origin by `gh`)
// Fetching goes through the `gh` CLI - the user's existing auth, no token
// handling here.

export interface IssueRef {
  repo?: string // owner/repo when the ref names one; undefined = cwd's repo
  number: number
}

export interface FetchedIssue {
  ref: IssueRef
  title: string
  body: string
  url: string
  // instruction-shaped content inside the issue body (an issue is untrusted
  // input - anyone can file one); surfaced to the user before the run starts
  injectionWarning?: string
}

export function parseIssueRef(raw: string): IssueRef | null {
  const url = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/.exec(raw)
  if (url) return { repo: url[1], number: Number(url[2]) }
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(raw)
  if (short) return { repo: short[1], number: Number(short[2]) }
  const bare = /^#?(\d+)$/.exec(raw)
  if (bare) return { number: Number(bare[1]) }
  return null
}

export type IssueExec = (args: string[]) => Promise<{ stdout: string; code: number }>

export async function fetchIssue(ref: IssueRef, exec: IssueExec): Promise<FetchedIssue> {
  const args = ['issue', 'view', String(ref.number), '--json', 'title,body,url']
  if (ref.repo) args.push('--repo', ref.repo)
  const res = await exec(args)
  if (res.code !== 0) {
    throw new Error(`could not fetch issue ${ref.repo ? `${ref.repo}#` : '#'}${ref.number} - is \`gh\` authenticated and the repo reachable?`)
  }
  let parsed: { title?: string; body?: string; url?: string }
  try {
    parsed = JSON.parse(res.stdout) as typeof parsed
  } catch {
    throw new Error('unexpected output from `gh issue view --json` - update the gh CLI?')
  }
  const body = parsed.body ?? ''
  const scan = scanForInjection(body)
  return {
    ref,
    title: parsed.title ?? `issue #${ref.number}`,
    body,
    url: parsed.url ?? '',
    injectionWarning: scan.suspicious
      ? `issue body contains instruction-like text (${scan.findings.map((f) => f.pattern).join(', ')})`
      : undefined,
  }
}

// The goal composed from an issue. The body is quoted as reference material,
// not pasted as raw instructions - agents get the task framing from looprail,
// with the issue as the source description.
export function issueGoal(issue: FetchedIssue): string {
  const head = `Resolve GitHub issue #${issue.ref.number}: ${issue.title}`
  if (!issue.body.trim()) return head
  return `${head}\n\nIssue description (reference material from the issue reporter):\n${issue.body.trim()}`
}
