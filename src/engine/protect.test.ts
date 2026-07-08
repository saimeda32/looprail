import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_TEST_GLOBS, compareProtected, matchesAny, snapshotProtected, tamperVerdict,
} from './protect.js'

function ws(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lr-protect-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

describe('matchesAny', () => {
  test('** crosses directories, * stays within a segment', () => {
    expect(matchesAny('test/slugify.test.js', ['test/**'])).toBe(true)
    expect(matchesAny('deep/nested/a.test.ts', ['**/*.test.*'])).toBe(true)
    expect(matchesAny('src/slugify.js', ['test/**', '**/*.test.*'])).toBe(false)
    expect(matchesAny('conftest.py', ['conftest.py'])).toBe(true)
    expect(matchesAny('src/conftest.py', ['**/conftest.py'])).toBe(true)
    // * must not cross a slash
    expect(matchesAny('a/b.spec.ts', ['*.spec.ts'])).toBe(false)
  })

  test('the default test globs cover the common shapes', () => {
    for (const p of [
      'test/x.js', 'tests/deep/y.py', 'src/a.test.ts', 'lib/b.spec.tsx',
      'conftest.py', 'pkg/conftest.py', 'pytest.ini', 'jest.config.js', 'vitest.config.ts',
    ]) {
      expect(matchesAny(p, DEFAULT_TEST_GLOBS), p).toBe(true)
    }
    expect(matchesAny('src/index.ts', DEFAULT_TEST_GLOBS)).toBe(false)
  })
})

describe('snapshotProtected + compareProtected', () => {
  test('detects modified, deleted, and added protected files - and ignores the rest', async () => {
    const dir = ws({
      'test/a.test.js': 'assert(1)',
      'test/b.test.js': 'assert(2)',
      'src/impl.js': 'code',
    })
    const baseline = await snapshotProtected(dir, ['test/**'])
    // modify one, delete one, add one, and touch an UNprotected file
    writeFileSync(join(dir, 'test/a.test.js'), 'assert(true) // weakened')
    rmSync(join(dir, 'test/b.test.js'))
    writeFileSync(join(dir, 'test/c.test.js'), 'new file')
    writeFileSync(join(dir, 'src/impl.js'), 'changed code')
    const changes = compareProtected(baseline, await snapshotProtected(dir, ['test/**']))
    expect(changes.modified).toEqual(['test/a.test.js'])
    expect(changes.deleted).toEqual(['test/b.test.js'])
    expect(changes.added).toEqual(['test/c.test.js'])
  })

  test('no changes -> all three lists empty', async () => {
    const dir = ws({ 'tests/t.py': 'assert x' })
    const baseline = await snapshotProtected(dir, DEFAULT_TEST_GLOBS)
    const changes = compareProtected(baseline, await snapshotProtected(dir, DEFAULT_TEST_GLOBS))
    expect([...changes.modified, ...changes.deleted, ...changes.added]).toEqual([])
  })

  test('node_modules and .git are never walked', async () => {
    const dir = ws({
      'node_modules/dep/test/x.test.js': 'x',
      '.git/hooks/test/y.test.js': 'y',
      'test/real.test.js': 'real',
    })
    const snap = await snapshotProtected(dir, ['**/*.test.*', 'test/**'])
    expect(Object.keys(snap)).toEqual(['test/real.test.js'])
  })
})

describe('tamperVerdict', () => {
  test('is a fail attributed to __protect__ naming every changed file', () => {
    const v = tamperVerdict({ modified: ['test/a.test.js'], deleted: ['test/b.test.js'], added: [] })
    expect(v.node).toBe('__protect__')
    expect(v.status).toBe('fail')
    expect(v.evidence).toContain('test/a.test.js')
    expect(v.evidence).toContain('test/b.test.js')
    expect(v.evidence.toLowerCase()).toContain('revert')
  })
})
