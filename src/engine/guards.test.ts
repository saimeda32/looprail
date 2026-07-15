import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { GuardSet } from './guards.js'
import type { LoopDef } from '../core/types.js'

const base: Omit<LoopDef, 'protect' | 'scope' | 'verifyDeps' | 'noWeakerTests'> = {
  name: 't', goal: 'g', agents: { a: { adapter: 'mock' } }, nodes: [],
  rails: { maxIterations: 5, maxCostUsd: 1 }, verdictPolicy: { kind: 'all-pass' },
}

function ws(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lr-guards-'))
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true })
    writeFileSync(join(dir, p), c)
  }
  return dir
}

describe('GuardSet', () => {
  test('no rails configured: inactive, evaluate is a cheap no-op', async () => {
    const guards = await GuardSet.create(base as LoopDef, ws())
    expect(guards.active).toBe(false)
    expect(await guards.evaluate(1)).toEqual({ verdicts: [], events: [], escalationHalt: null })
  })

  test('protect: a change fails with a verdict + event; a second one escalates to halt', async () => {
    const dir = ws({ 'test/a.test.js': 'assert(1)' })
    const guards = await GuardSet.create({ ...base, protect: ['test/**'] } as LoopDef, dir)
    expect(guards.active).toBe(true)
    writeFileSync(join(dir, 'test/a.test.js'), 'gutted')
    const first = await guards.evaluate(1)
    expect(first.verdicts.map((v) => v.node)).toEqual(['__protect__'])
    expect(first.events.map((e) => e.type)).toEqual(['protect_violation'])
    expect(first.escalationHalt).toBeNull()
    writeFileSync(join(dir, 'test/a.test.js'), 'gutted again')
    const second = await guards.evaluate(2)
    expect(second.escalationHalt).toContain('protect rail')
  })

  test('a fixed rail resets the escalation counter (no false halt)', async () => {
    const dir = ws({ 'test/a.test.js': 'assert(1)' })
    const guards = await GuardSet.create({ ...base, protect: ['test/**'] } as LoopDef, dir)
    writeFileSync(join(dir, 'test/a.test.js'), 'gutted')
    await guards.evaluate(1)                                   // violation 1
    writeFileSync(join(dir, 'test/a.test.js'), 'assert(1)')    // reverted
    const fixed = await guards.evaluate(2)
    expect(fixed.verdicts).toEqual([])
    expect(fixed.escalationHalt).toBeNull()
    writeFileSync(join(dir, 'test/a.test.js'), 'gutted')       // violation again (count 1, not 2)
    expect((await guards.evaluate(3)).escalationHalt).toBeNull()
  })

  test('verify_deps: a hallucinated added package fails, via the injected probe', async () => {
    const dir = ws({ 'package.json': JSON.stringify({ dependencies: { real: '^1' } }) })
    const guards = await GuardSet.create(
      { ...base, verifyDeps: true } as LoopDef, dir,
      async (_r, name) => ({ exists: name === 'real' }),
    )
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { real: '^1', ghostpkg: '^1' } }))
    const r = await guards.evaluate(1)
    expect(r.verdicts.map((v) => v.node)).toEqual(['__deps__'])
    expect(r.verdicts[0].evidence).toContain('ghostpkg')
  })

  test('no_weaker_tests ratchets: growth becomes the new floor, later shrink to old floor still fails', async () => {
    const dir = ws({ 'test/a.test.js': 'expect(a).toBe(1)\nexpect(b).toBe(2)\n' })
    const guards = await GuardSet.create({ ...base, noWeakerTests: true } as LoopDef, dir)
    // grow to 3 assertions - accepted, floor ratchets to 3
    writeFileSync(join(dir, 'test/a.test.js'), 'expect(a).toBe(1)\nexpect(b).toBe(2)\nexpect(c).toBe(3)\n')
    expect((await guards.evaluate(1)).verdicts).toEqual([])
    // drop back to 2 - below the NEW floor of 3, so it fails
    writeFileSync(join(dir, 'test/a.test.js'), 'expect(a).toBe(1)\nexpect(b).toBe(2)\n')
    expect((await guards.evaluate(2)).verdicts.map((v) => v.node)).toEqual(['__tests__'])
  })
})
