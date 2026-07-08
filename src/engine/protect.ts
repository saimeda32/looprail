import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Verdict } from '../core/types.js'

// The tests-are-the-spec rail (see docs/superpowers/specs/
// 2026-07-07-test-tamper-guard-design.md). The best-documented way agents
// game a verified loop is editing the tests instead of the code -
// conftest.py patching, deleted assertions, sys.exit(0) - and prompt-level
// "never modify tests" rules are demonstrably ignored. `protect:` makes the
// rule structural: hash the protected files at run start, and any change to
// them fails the iteration with an explicit revert instruction; a second
// consecutive violation halts the run (enforced in runner.ts).

// `protect: tests` expands to these. Framework configs are included because
// patching them (pytest's conftest.py, jest/vitest config) alters what
// "tests passed" even means - the exact exploit shape documented in
// production reward-hacking reports.
export const DEFAULT_TEST_GLOBS = [
  'test/**', 'tests/**', '**/*.test.*', '**/*.spec.*',
  'conftest.py', '**/conftest.py', 'pytest.ini', 'jest.config.*', 'vitest.config.*',
]

// Deliberately tiny glob dialect - `**` crosses directories, `*` stays
// within one segment - instead of a new dependency: these two cover every
// test-layout convention the default set needs, and a protect pattern is
// authored by a human against their own repo, not arbitrary input.
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` at a boundary also matches zero directories, so
        // `**/conftest.py` matches a root-level conftest.py too.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if ('.+?^${}()|[]\\'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`^${out}$`)
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path))
}

// Directories that are never part of a project's own test surface and can
// be enormous - descending into them would make the per-iteration rescan
// unacceptably slow and could "protect" files no agent should be judged on.
const SKIP_DIRS = new Set(['node_modules', '.git', '.looprail'])

async function walk(root: string, dir: string, acc: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(root, join(dir, e.name), acc)
    } else if (e.isFile()) {
      acc.push(relative(root, join(dir, e.name)).split(sep).join('/'))
    }
  }
}

// Relative-posix-path -> sha256 of content, for every workspace file
// matching the protect globs. Hash-based (not mtime) so a touch that
// changes nothing is not a violation, and no git is required.
export async function snapshotProtected(
  cwd: string, globs: string[],
): Promise<Record<string, string>> {
  const files: string[] = []
  await walk(cwd, cwd, files)
  const snapshot: Record<string, string> = {}
  for (const f of files.sort()) {
    if (!matchesAny(f, globs)) continue
    const content = await fs.readFile(join(cwd, f))
    snapshot[f] = createHash('sha256').update(content).digest('hex')
  }
  return snapshot
}

export interface ProtectedChanges {
  modified: string[]
  deleted: string[]
  added: string[]
}

export function compareProtected(
  baseline: Record<string, string>, current: Record<string, string>,
): ProtectedChanges {
  const modified: string[] = []
  const deleted: string[] = []
  const added: string[] = []
  for (const [path, hash] of Object.entries(baseline)) {
    if (!(path in current)) deleted.push(path)
    else if (current[path] !== hash) modified.push(path)
  }
  for (const path of Object.keys(current)) {
    if (!(path in baseline)) added.push(path)
  }
  return { modified, deleted, added }
}

export function hasChanges(c: ProtectedChanges): boolean {
  return c.modified.length + c.deleted.length + c.added.length > 0
}

// The deterministic fail verdict appended to an iteration's verdict set on a
// first violation. `__protect__` is a reserved synthetic id - double
// underscores keep it out of collision range of real loopfile node ids.
// Under every verdict policy an appended fail only makes the aggregate
// stricter, so this can never turn a failing iteration into a passing one.
export function tamperVerdict(changes: ProtectedChanges): Verdict {
  const describe = (label: string, files: string[]) =>
    files.length > 0 ? `${label}: ${files.join(', ')}` : ''
  const detail = [
    describe('modified', changes.modified),
    describe('deleted', changes.deleted),
    describe('added', changes.added),
  ].filter(Boolean).join('; ')
  return {
    node: '__protect__',
    status: 'fail',
    evidence: `protected files were changed (${detail}) - revert them to their original state and change the implementation instead; the protected files are the spec`,
  }
}
