import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { lintLoop, parseBenchfile, renderJson, renderTable, runBench } from '../index.js'
import { loadLoop } from '../cli/run-cmd.js'
import { createRegistry } from '../adapters/registry.js'
import { MockAdapter, type MockStep } from '../adapters/mock.js'

const benchmarksDir = fileURLToPath(new URL('../../benchmarks', import.meta.url))

function baselineSteps(pass: boolean): MockStep[] {
  return pass
    ? [
        { match: /EXECUTOR/, output: 'fix applied' },
        { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: fix looks correct' },
      ]
    : [
        { match: /EXECUTOR/, output: 'partial fix' },
        { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: still broken' },
        { match: /EXECUTOR/, output: 'partial fix again' },
        { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: still broken' },
      ]
}

// looprail.yaml closes its critic panel with a `merge` synthesizer node
// (role: synthesizer) so the loop is L004-lint-clean (a panel fan-out must
// have a downstream judge/synthesizer to aggregate it) — that node runs
// after both panel critics and needs its own scripted step.
function looprailSteps(): MockStep[] {
  return [
    { match: /PLANNER/, output: 'clear plan with success criteria' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: plan is sound' },
    { match: /EXECUTOR/, output: 'fix applied per plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: panel approves' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: panel approves' },
    { match: /SYNTHESIZER/, output: 'panel findings merged: no unresolved flaws' },
  ]
}

// Deterministic script: baseline passes immediately on runs 0-1 and fails
// out on runs 2-4 (halts after max_iterations: 2); looprail passes on
// every run. With repeat: 5 this always yields baseline passRate = 2/5.
function registryFor(configId: string, i: number) {
  const reg = createRegistry()
  reg.register(configId === 'baseline'
    ? new MockAdapter(baselineSteps(i < 2))
    : new MockAdapter(looprailSteps()))
  return reg
}

const files = readdirSync(benchmarksDir).filter((f) => f.endsWith('.bench.yaml'))

describe('benchmarks/*.bench.yaml are lint-clean and produce a well-formed comparison', () => {
  test('at least 3 mock-backed benchmarks ship', () => {
    expect(files.length).toBeGreaterThanOrEqual(3)
  })

  for (const file of files) {
    test(`benchmarks/${file}`, async () => {
      const def = parseBenchfile(readFileSync(join(benchmarksDir, file), 'utf8'))
      for (const c of def.configs) {
        const { def: loop } = loadLoop(c.loopfile, benchmarksDir)
        expect(lintLoop(loop)).toEqual([])
      }

      let t = 0
      const runsRoot = mkdtempSync(join(tmpdir(), 'looprail-bench-test-'))
      const result = await runBench(def, benchmarksDir, { registryFor, now: () => (t += 10), runsRoot })

      expect(result.configs.map((c) => c.id)).toEqual(['baseline', 'looprail'])
      const [baseline, looprail] = result.configs
      expect(baseline.stats.n).toBe(def.repeat)
      expect(baseline.stats.passRate).toBeCloseTo(2 / def.repeat, 5)
      expect(looprail.stats.passRate).toBe(1)
      expect(looprail.stats.passRate).toBeGreaterThan(baseline.stats.passRate)

      const table = renderTable(result)
      expect(table).toContain('baseline')
      expect(table).toContain('looprail')
      expect(table).toContain('SCRIPTED')

      const json = renderJson(result)
      expect(json.configs).toHaveLength(2)
    })
  }
})
