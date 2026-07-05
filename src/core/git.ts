import { execFileSync } from 'node:child_process'

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
