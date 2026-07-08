import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { checkNewDeps, depsVerdict, parseManifests, type RegistryProbe } from './deps-rail.js'

function ws(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lr-deps-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

describe('parseManifests', () => {
  test('reads npm deps+devDeps and python requirements', () => {
    const dir = ws({
      'package.json': JSON.stringify({ dependencies: { express: '^4' }, devDependencies: { vitest: '^2' } }),
      'requirements.txt': 'requests==2.31.0\nflask>=2\n# comment\n\n-r other.txt\n',
    })
    const m = parseManifests(dir)
    expect([...m.get('npm')!].sort()).toEqual(['express', 'vitest'])
    expect([...m.get('pypi')!].sort()).toEqual(['flask', 'requests'])
  })

  test('missing manifests mean empty sets, never a throw', () => {
    const m = parseManifests(ws({}))
    expect(m.get('npm')).toBeUndefined()
    expect(m.get('pypi')).toBeUndefined()
  })
})

describe('checkNewDeps', () => {
  const baseline = new Map([['npm', new Set(['express'])]])

  test('flags a newly added package that does not exist in the registry', async () => {
    const probe: RegistryProbe = async (_registry, name) =>
      name === 'left-pad' ? { exists: true } : { exists: false }
    const current = new Map([['npm', new Set(['express', 'left-pad', 'definitely-hallucinated-pkg'])]])
    const result = await checkNewDeps(baseline, current, probe)
    expect(result.missing).toEqual([{ registry: 'npm', name: 'definitely-hallucinated-pkg' }])
    expect(result.young).toEqual([])
  })

  test('flags a package younger than 90 days as a squat signal, not a fail', async () => {
    const now = Date.now()
    const probe: RegistryProbe = async () => ({ exists: true, createdAt: now - 10 * 24 * 60 * 60 * 1000 })
    const current = new Map([['npm', new Set(['express', 'brand-new-pkg'])]])
    const result = await checkNewDeps(baseline, current, probe, () => now)
    expect(result.missing).toEqual([])
    expect(result.young).toEqual([expect.objectContaining({ registry: 'npm', name: 'brand-new-pkg' })])
  })

  test('a probe error degrades to unchecked-with-note, never a false fail', async () => {
    const probe: RegistryProbe = async () => { throw new Error('offline') }
    const current = new Map([['npm', new Set(['express', 'unknowable-pkg'])]])
    const result = await checkNewDeps(baseline, current, probe)
    expect(result.missing).toEqual([])
    expect(result.unchecked).toEqual([{ registry: 'npm', name: 'unknowable-pkg' }])
  })

  test('no new deps means no probes at all', async () => {
    let probes = 0
    const probe: RegistryProbe = async () => { probes += 1; return { exists: true } }
    const result = await checkNewDeps(baseline, baseline, probe)
    expect(probes).toBe(0)
    expect(result.missing).toEqual([])
  })
})

describe('depsVerdict', () => {
  test('missing packages produce a fail naming each one', () => {
    const v = depsVerdict({ missing: [{ registry: 'npm', name: 'ghost-pkg' }], young: [], unchecked: [] })!
    expect(v.node).toBe('__deps__')
    expect(v.status).toBe('fail')
    expect(v.evidence).toContain('ghost-pkg')
    expect(v.evidence.toLowerCase()).toContain('not exist')
  })

  test('young-only findings produce no verdict (informational, journaled instead)', () => {
    expect(depsVerdict({ missing: [], young: [{ registry: 'npm', name: 'newish', ageDays: 5 }], unchecked: [] })).toBeNull()
  })
})
