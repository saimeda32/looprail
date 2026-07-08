import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Verdict } from '../core/types.js'
import { DEFAULT_TEST_GLOBS, matchesAny } from './protect.js'

// The no-weaker-tests rail (`no_weaker_tests: true`): the anti-gaming
// companion to `protect:` for loops where the agent WRITES its own tests
// (build-app shapes). protect: forbids all change to existing tests; this
// rail allows tests to grow and change freely but forbids them getting
// WEAKER - within one run, the aggregate assertion count must never drop
// and the aggregate skip-marker count must never rise. Documented
// reward-hacks this closes: deleting assertions after they fail, adding
// it.skip/xit/@pytest.mark.skip to silence a failing case, and rewriting a
// strict test file into a hollow one.
//
// Aggregate-based on purpose: comparing per-file would flag legitimate
// refactors that move tests between files. Moving N assertions from a.test
// to b.test keeps the aggregate flat - fine; only a NET loss trips the
// rail. The floor RATCHETS: each iteration's strength becomes the next
// iteration's minimum, so a run's tests are monotonically non-weakening.

export interface FileStrength { assertions: number; skips: number }
export interface StrengthSnapshot {
  assertions: number
  skips: number
  perFile: Record<string, FileStrength>
}

// Assertion shapes per ecosystem, deliberately coarse: expect(...) /
// assert / assert.* for JS-family, bare `assert` and self.assert* for
// python. Counting is what makes this deterministic - no judgment calls,
// no model in the loop.
const ASSERTION_PATTERNS = [
  /\bexpect\s*\(/g,          // jest/vitest/chai expect(
  /\bassert\w*\s*[.(]/g,     // node assert( / assert.strictEqual( / assertEquals(
  /^\s*assert\s+/gm,         // python bare assert
  /\bself\.assert\w+\s*\(/g, // python unittest
]
const SKIP_PATTERNS = [
  /\b(?:it|test|describe|suite)\.skip\s*\(/g, // jest/vitest/mocha .skip
  /\bx(?:it|test|describe)\s*\(/g,            // xit/xtest/xdescribe
  /\b(?:it|test)\.todo\s*\(/g,                // .todo placeholders
  /@pytest\.mark\.skip/g,                     // pytest skip decorators
  /\bunittest\.skip/g,                        // unittest.skip*
]

const SKIP_DIRS = new Set(['node_modules', '.git', '.looprail'])

async function walk(root: string, dir: string, acc: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(root, join(dir, e.name), acc)
    } else if (e.isFile()) {
      acc.push(join(dir, e.name).slice(root.length + 1).split('/').join('/'))
    }
  }
}

function count(text: string, patterns: RegExp[]): number {
  let n = 0
  for (const p of patterns) {
    // fresh lastIndex per call - the patterns are module-level /g regexes
    p.lastIndex = 0
    n += (text.match(p) ?? []).length
  }
  return n
}

export async function measureStrength(
  cwd: string, globs: string[] = DEFAULT_TEST_GLOBS,
): Promise<StrengthSnapshot> {
  const files: string[] = []
  try {
    await walk(cwd, cwd, files)
  } catch {
    return { assertions: 0, skips: 0, perFile: {} }
  }
  const perFile: Record<string, FileStrength> = {}
  let assertions = 0
  let skips = 0
  for (const f of files.sort()) {
    if (!matchesAny(f, globs)) continue
    let text: string
    try {
      text = await fs.readFile(join(cwd, f), 'utf8')
    } catch {
      continue
    }
    const fileStrength = { assertions: count(text, ASSERTION_PATTERNS), skips: count(text, SKIP_PATTERNS) }
    perFile[f] = fileStrength
    assertions += fileStrength.assertions
    skips += fileStrength.skips
  }
  return { assertions, skips, perFile }
}

export interface Weakening {
  lostAssertions: number
  addedSkips: number
  suspects: string[]
}

// Null means "not weaker" - growth and lateral moves are always fine.
export function compareStrength(
  floor: StrengthSnapshot, current: StrengthSnapshot,
): Weakening | null {
  const lostAssertions = Math.max(0, floor.assertions - current.assertions)
  const addedSkips = Math.max(0, current.skips - floor.skips)
  if (lostAssertions === 0 && addedSkips === 0) return null
  // Suspects: files that individually lost assertions or gained skips -
  // the aggregate decides, these just aim the feedback.
  const suspects: string[] = []
  for (const [file, was] of Object.entries(floor.perFile)) {
    const now = current.perFile[file]
    if (!now) { suspects.push(file); continue } // deleted test file
    if (now.assertions < was.assertions || now.skips > was.skips) suspects.push(file)
  }
  for (const file of Object.keys(current.perFile)) {
    if (!(file in floor.perFile) && current.perFile[file].skips > 0) suspects.push(file)
  }
  return { lostAssertions, addedSkips, suspects }
}

export function weakerTestsVerdict(w: Weakening): Verdict {
  const parts: string[] = []
  if (w.lostAssertions > 0) parts.push(`net ${w.lostAssertions} assertion(s) removed`)
  if (w.addedSkips > 0) parts.push(`${w.addedSkips} skip marker(s) added`)
  const where = w.suspects.length > 0 ? ` (look at: ${w.suspects.join(', ')})` : ''
  return {
    node: '__tests__',
    status: 'fail',
    evidence: `the test suite got WEAKER this iteration: ${parts.join('; ')}${where} - restore the removed assertions and unskip the tests; make the implementation pass them instead of quieting them`,
  }
}
