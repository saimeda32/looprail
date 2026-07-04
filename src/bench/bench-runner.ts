import { join } from 'node:path'
import type { AdapterRegistry } from '../adapters/registry.js'
import type { GateHandler } from '../core/types.js'
import { runLoop } from '../engine/runner.js'
import { readJournal } from '../journal/journal.js'
// loadLoop is CLI-layer plumbing (path resolution + parseLoopfile + a clear
// "no loopfile here" error). Global Constraints call for reusing it rather
// than re-deriving the same resolve/read/parse sequence here.
import { loadLoop } from '../cli/run-cmd.js'
import { aggregateConfig } from './metrics.js'
import type { BenchConfigResult, BenchDef, BenchResult, BenchRunResult } from './types.js'

export interface BenchDeps {
  registry?: AdapterRegistry
  registryFor?: (configId: string, runIndex: number) => AdapterRegistry
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  gate?: GateHandler
  runsRoot: string
}

export async function runBench(def: BenchDef, benchfileDir: string, deps: BenchDeps): Promise<BenchResult> {
  if (!deps.registry && !deps.registryFor) {
    throw new Error('runBench requires deps.registry or deps.registryFor')
  }
  const now = deps.now ?? Date.now
  const configs: BenchConfigResult[] = []

  for (const ref of def.configs) {
    const { def: loop } = loadLoop(ref.loopfile, benchfileDir)
    const mode: 'mock' | 'real' = Object.values(loop.agents).every((a) => a.adapter === 'mock')
      ? 'mock' : 'real'

    const runs: BenchRunResult[] = []
    for (let i = 0; i < def.repeat; i++) {
      const registry = deps.registryFor ? deps.registryFor(ref.id, i) : deps.registry!
      const runId = `bench-${ref.id}-${i}`
      const runDir = join(deps.runsRoot, runId)
      const start = now()
      const report = await runLoop(loop, {
        registry, runId, runDir, now, sleep: deps.sleep, gate: deps.gate,
      })
      const wallMs = now() - start
      const events = readJournal(join(runDir, 'journal.jsonl'))
      runs.push({ report, events, wallMs })
    }

    configs.push({ id: ref.id, mode, runs, stats: aggregateConfig(ref.id, runs) })
  }

  return { name: def.name, task: def.task, repeat: def.repeat, configs }
}
