import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Command } from 'commander'
import {
  createDefaultRegistry, lintLoop, parseBenchfile, renderJson, renderTable, runBench,
  type AdapterRegistry, type BenchDeps,
} from '../index.js'
import { loadLoop } from './run-cmd.js'
import { defaultIo, err, type CliIo } from './ui.js'

export interface BenchCliDeps {
  registry?: AdapterRegistry
  registryFor?: BenchDeps['registryFor']
  now?: () => number
  io?: CliIo
}

export async function benchAction(
  file: string | undefined,
  opts: { cwd: string; json?: boolean },
  deps: BenchCliDeps = {},
): Promise<number> {
  const io = deps.io ?? defaultIo
  const path = resolve(opts.cwd, file ?? 'bench.yaml')
  if (!existsSync(path)) {
    io.out(err(`no benchfile at ${path}`))
    return 1
  }

  let def
  try {
    def = parseBenchfile(readFileSync(path, 'utf8'))
  } catch (e) {
    io.out(err(e instanceof Error ? e.message : String(e)))
    return 1
  }

  const benchfileDir = dirname(path)
  // fail fast on a bad referenced loopfile - same lint gate `looprail run` uses
  for (const c of def.configs) {
    let loaded
    try {
      loaded = loadLoop(c.loopfile, benchfileDir)
    } catch (e) {
      io.out(err(`config "${c.id}": ${e instanceof Error ? e.message : String(e)}`))
      return 1
    }
    const findings = lintLoop(loaded.def).filter((f) => f.level === 'error')
    if (findings.length > 0) {
      io.out(err(`config "${c.id}" failed lint: ${findings.map((f) => f.message).join('; ')}`))
      return 1
    }
  }

  const runsRoot = mkdtempSync(join(tmpdir(), 'looprail-bench-'))
  const result = await runBench(def, benchfileDir, {
    registry: deps.registry ?? (deps.registryFor ? undefined : createDefaultRegistry({ cwd: opts.cwd })),
    registryFor: deps.registryFor,
    now: deps.now,
    runsRoot,
  })

  if (opts.json) {
    io.out(JSON.stringify(renderJson(result)))
  } else {
    io.out(renderTable(result))
  }
  return 0
}

export function registerBench(program: Command): void {
  program
    .command('bench [file]')
    .description('A/B two or more named loop configs against the same task and report measured deltas')
    .option('--json', 'machine-readable comparison on stdout')
    .action(async (file: string | undefined, opts: { json?: boolean }, cmd: Command) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = await benchAction(file, { cwd, ...opts })
    })
}
