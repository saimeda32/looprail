import { describe, expect, test } from 'vitest'
import { buildPrBody, createVerifiedPr, preflightPr, type PrExec } from './pr.js'
import type { RunReport } from '../core/types.js'

const report = (over: Partial<RunReport> = {}): RunReport => ({
  runId: 'run-abc', status: 'verified', reason: 'all verifiers passed',
  iterations: 2, replans: 0, costUsd: 1.07, estimatedCostUsd: 0.003,
  outcomes: [
    { nodeId: 'tests', role: 'tester', output: 'exit 0', verdict: { node: 'tests', status: 'pass', evidence: 'exit 0, 8/8' }, costUsd: 0, tokens: 0, durationMs: 5 },
    { nodeId: 'crit', role: 'critic', output: '...', verdict: { node: 'crit', status: 'pass', evidence: 'diff is a real fix | no test touched', gaps: ['docs thin'] }, costUsd: 0, tokens: 10, durationMs: 5 },
  ],
  gaps: [{ node: 'crit', gap: 'docs thin' }],
  report: { summary: 'Fixed slugify to satisfy the full suite', claims: [], source: 'fallback', filesTouched: ['src/slugify.js'] },
  ...over,
})

describe('buildPrBody', () => {
  test('carries status, verdicts, gaps, and git-derived files - the evidence, not prose', () => {
    const body = buildPrBody(report())
    expect(body).toContain('verified')
    expect(body).toContain('| tests | tester | pass |')
    expect(body).toContain('docs thin')
    expect(body).toContain('`src/slugify.js`')
    expect(body).toContain('run-abc')
    // pipes in evidence must not break the markdown table
    expect(body).toContain('real fix \\| no test')
  })
})

describe('createVerifiedPr', () => {
  const record = () => {
    const calls: string[][] = []
    const exec: PrExec = async (file, args) => {
      calls.push([file, ...args])
      if (file === 'git' && args[0] === 'status') return { stdout: 'M src/slugify.js\n', stderr: '' }
      if (file === 'gh' && args[0] === 'pr') return { stdout: 'https://github.com/o/r/pull/7\n', stderr: '' }
      return { stdout: '', stderr: '' }
    }
    return { calls, exec }
  }

  test('branches, commits, pushes, and opens the PR with the evidence body', async () => {
    const { calls, exec } = record()
    const result = await createVerifiedPr('/repo', report(), exec)
    expect(result.branch).toBe('looprail/run-abc')
    expect(result.url).toBe('https://github.com/o/r/pull/7')
    const cmds = calls.map((c) => c.slice(0, 2).join(' '))
    expect(cmds).toEqual([
      'git checkout', 'git add', 'git status', 'git commit', 'git push', 'gh pr',
    ])
    const commit = calls.find((c) => c[1] === 'commit')!
    expect(commit.join(' ')).toContain('verified by looprail run run-abc')
    const pr = calls.find((c) => c[0] === 'gh')!
    expect(pr.join(' ')).toContain('--body')
  })

  test('nothing uncommitted: skips the commit, still pushes and opens', async () => {
    const calls: string[][] = []
    const exec: PrExec = async (file, args) => {
      calls.push([file, ...args])
      if (file === 'git' && args[0] === 'status') return { stdout: '', stderr: '' }
      if (file === 'gh') return { stdout: 'https://github.com/o/r/pull/8\n', stderr: '' }
      return { stdout: '', stderr: '' }
    }
    await createVerifiedPr('/repo', report(), exec)
    expect(calls.some((c) => c[1] === 'commit')).toBe(false)
    expect(calls.some((c) => c[1] === 'push')).toBe(true)
  })

  test('refuses to ship a halted run', async () => {
    await expect(createVerifiedPr('/repo', report({ status: 'halted' })))
      .rejects.toThrow(/only verified work ships/)
  })
})

describe('preflightPr', () => {
  test('names the missing piece: git repo, then gh auth', async () => {
    const noGit: PrExec = async (file) => { if (file === 'git') throw new Error('nope'); return { stdout: '', stderr: '' } }
    expect(await preflightPr('/x', noGit)).toContain('git repository')
    const noGh: PrExec = async (file) => { if (file === 'gh') throw new Error('nope'); return { stdout: '', stderr: '' } }
    expect(await preflightPr('/x', noGh)).toContain('gh auth login')
    const ok: PrExec = async () => ({ stdout: '', stderr: '' })
    expect(await preflightPr('/x', ok)).toBeNull()
  })
})
