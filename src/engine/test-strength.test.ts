import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { compareStrength, measureStrength, weakerTestsVerdict } from './test-strength.js'

function ws(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lr-strength-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

describe('measureStrength', () => {
  test('counts JS assertions and skip markers across test files', async () => {
    const dir = ws({
      'test/a.test.js': 'expect(x).toBe(1)\nexpect(y).toBe(2)\nassert.strictEqual(a, b)\n',
      'test/b.test.js': 'it.skip("later", () => {})\nexpect(z).toBeTruthy()\n',
      'src/impl.js': 'expect(this).not.toCount() // not a test file',
    })
    const s = await measureStrength(dir)
    expect(s.assertions).toBe(4)
    expect(s.skips).toBe(1)
    expect(s.perFile['test/a.test.js']).toEqual({ assertions: 3, skips: 0 })
  })

  test('counts python assertions and pytest skip markers', async () => {
    const dir = ws({
      'tests/test_x.py': 'def test_a():\n    assert x == 1\n    assert y\n\n@pytest.mark.skip\ndef test_b():\n    assert z\n',
    })
    const s = await measureStrength(dir)
    expect(s.assertions).toBe(3)
    expect(s.skips).toBe(1)
  })

  test('no test files means zero strength, never a throw', async () => {
    const s = await measureStrength(ws({ 'src/a.js': 'code' }))
    expect(s.assertions).toBe(0)
    expect(s.skips).toBe(0)
  })
})

describe('compareStrength', () => {
  const base = { assertions: 10, skips: 0, perFile: { 'test/a.test.js': { assertions: 10, skips: 0 } } }

  test('net assertion loss is a weakening, with the offending files named', () => {
    const current = { assertions: 7, skips: 0, perFile: { 'test/a.test.js': { assertions: 7, skips: 0 } } }
    const w = compareStrength(base, current)
    expect(w).not.toBeNull()
    expect(w!.lostAssertions).toBe(3)
    expect(w!.suspects).toContain('test/a.test.js')
  })

  test('added skip markers are a weakening even when assertions grow', () => {
    const current = { assertions: 12, skips: 2, perFile: { 'test/a.test.js': { assertions: 12, skips: 2 } } }
    const w = compareStrength(base, current)
    expect(w).not.toBeNull()
    expect(w!.addedSkips).toBe(2)
  })

  test('moving assertions between files is NOT a weakening (aggregate view)', () => {
    const current = {
      assertions: 10, skips: 0,
      perFile: {
        'test/a.test.js': { assertions: 4, skips: 0 },
        'test/b.test.js': { assertions: 6, skips: 0 },
      },
    }
    expect(compareStrength(base, current)).toBeNull()
  })

  test('growth is never a weakening', () => {
    const current = { assertions: 15, skips: 0, perFile: {} }
    expect(compareStrength(base, current)).toBeNull()
  })
})

describe('weakerTestsVerdict', () => {
  test('names the loss, the suspects, and instructs restoration', () => {
    const v = weakerTestsVerdict({ lostAssertions: 3, addedSkips: 1, suspects: ['test/a.test.js'] })
    expect(v.node).toBe('__tests__')
    expect(v.status).toBe('fail')
    expect(v.evidence).toContain('3')
    expect(v.evidence).toContain('test/a.test.js')
    expect(v.evidence.toLowerCase()).toContain('restore')
  })
})
