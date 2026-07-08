import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Ground truth for "which files did this run touch", deliberately never
// asked of the reporting agent (see report.ts/runner.ts buildFinalReport):
// an LLM narrating its own edits is exactly the kind of claim that drifts
// from reality, while git already knows for free. `git status --porcelain`
// (rather than a diff against some recorded starting commit, which nothing
// in this codebase captures) is the one command that uniformly captures
// every kind of change a run could have made in cwd - modified, staged,
// deleted, and brand-new untracked files - relative to HEAD, with no setup
// required. Every failure mode (cwd not a git repo, git not installed, a
// bare/detached-HEAD edge case) degrades to an empty list rather than
// throwing: this is an informational extra, never worth failing a report -
// let alone the run itself - over.
export function filesTouched(cwd: string): string[] {
  try {
    const output = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const files = new Set<string>()
    for (const line of output.split('\n')) {
      if (line.length < 4) continue
      // Porcelain short format: two status chars, a space, then the path -
      // renames use "old -> new", where only the new path is what's live now.
      const path = line.slice(3)
      const arrow = path.indexOf(' -> ')
      files.add(arrow === -1 ? path : path.slice(arrow + 4))
    }
    return [...files].sort()
  } catch {
    return []
  }
}

// The commit this run started from - recorded once by the runner so blind
// validation can diff against a fixed point even if the agent commits
// mid-run. Null outside a git repo (blind mode then degrades - see
// workspaceDiff below and engine/nodes.ts).
export function gitHead(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null
  } catch {
    return null
  }
}

// Ground truth for a blind critic: the ACTUAL workspace changes since
// `sinceRef`, never the executor's narrative about them. `git diff
// <sinceRef>` catches tracked edits whether or not the agent staged or even
// committed them (diffing a fixed ref is what makes an agent's own
// mid-run commit visible instead of a hole); untracked files don't appear
// in any ref diff, so their full contents are appended per-file. Truncated
// at maxChars with an explicit marker - a critic must know it saw a
// partial diff rather than silently reviewing half the work. Degrades to
// '' on any git failure, same posture as filesTouched above.
export function workspaceDiff(cwd: string, sinceRef: string, maxChars = 60_000): string {
  try {
    let out = execFileSync('git', ['diff', sinceRef, '--', '.'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024,
    })
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    for (const line of status.split('\n')) {
      if (!line.startsWith('??')) continue
      const path = line.slice(3)
      try {
        const content = readFileSync(join(cwd, path), 'utf8')
        out += `\n--- new untracked file: ${path} ---\n${content}`
      } catch {
        out += `\n--- new untracked file: ${path} (unreadable) ---`
      }
      if (out.length > maxChars) break
    }
    if (out.length > maxChars) {
      out = `${out.slice(0, maxChars)}\n... (diff truncated at ${maxChars} chars)`
    }
    return out
  } catch {
    return ''
  }
}
