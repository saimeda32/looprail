import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import {
  createDefaultRegistry, detectAgents, lintLoop,
  type AdapterRegistry, type BenchDeps, type DetectedAgent,
} from '../index.js'
import { generateVariants } from '../route/variants.js'
import { runRoute } from '../route/route-runner.js'
import { buildRoutingFile, mixLabel } from '../route/report.js'
import { loadLoop } from './run-cmd.js'
import { defaultIo, dim, err, heading, ok, renderTable, warn, type CliIo } from './ui.js'

export interface RouteCliDeps {
  detect?: () => Promise<DetectedAgent[]>
  registry?: AdapterRegistry
  registryFor?: BenchDeps['registryFor']
  now?: () => number
  io?: CliIo
  // Confirmation seam (real loops cost real dollars): defaults to the same
  // minimal stdin y/N read `run`'s gates use; tests script the answer.
  confirm?: (question: string) => Promise<boolean>
}

async function askConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

export async function routeAction(
  file: string | undefined,
  opts: { cwd: string; json?: boolean; yes?: boolean; variants?: number; maxCostUsd?: number },
  deps: RouteCliDeps = {},
): Promise<number> {
  const io = deps.io ?? defaultIo

  let loaded
  try {
    loaded = loadLoop(file, opts.cwd)
  } catch (e) {
    io.out(err(e instanceof Error ? e.message : String(e)))
    return 1
  }
  // same fail-fast lint gate bench applies to every config it runs
  const findings = lintLoop(loaded.def).filter((f) => f.level === 'error')
  if (findings.length > 0) {
    io.out(err(`loopfile failed lint: ${findings.map((f) => f.message).join('; ')}`))
    return 1
  }

  const detected = await (deps.detect ?? detectAgents)()
  if (!detected.some((a) => a.available)) {
    io.out(err('no agent CLI found - `looprail doctor` lists what to install'))
    return 1
  }

  const budgetUsd = opts.maxCostUsd ?? 5
  const variants = generateVariants(loaded.def, detected, opts.variants ?? 4)
  if (!opts.json) {
    io.out(heading(`route - ${variants.length} variant(s) of ${loaded.path}`))
    for (const v of variants) io.out(`  ${v.id}  ${dim(mixLabel(v.agents))}`)
    io.out(dim(`  budget: $${budgetUsd} total across all variants`))
  }

  if (!opts.yes) {
    const proceed = await (deps.confirm ?? askConfirm)(
      `run ${variants.length} REAL paid loop(s) against this repo (max $${budgetUsd} total)? [y/N] `,
    )
    if (!proceed) {
      io.out(warn('aborted - nothing was run'))
      return 1
    }
  }

  const result = await runRoute(readFileSync(loaded.path, 'utf8'), variants, budgetUsd, {
    registry: deps.registry ?? (deps.registryFor ? undefined : createDefaultRegistry({ cwd: opts.cwd })),
    registryFor: deps.registryFor,
    now: deps.now,
    runsRoot: mkdtempSync(join(tmpdir(), 'looprail-route-runs-')),
    variantsDir: mkdtempSync(join(tmpdir(), 'looprail-route-variants-')),
    onVariantStart: opts.json ? undefined : (id, maxCostUsd) =>
      io.out(dim(`  ▸ running ${id} (cost rail $${maxCostUsd.toFixed(2)})`)),
  })

  const routing = buildRoutingFile(result, new Date((deps.now ?? Date.now)()).toISOString())
  const routingPath = join(opts.cwd, '.looprail', 'routing.json')
  mkdirSync(join(opts.cwd, '.looprail'), { recursive: true })
  writeFileSync(routingPath, `${JSON.stringify(routing, null, 2)}\n`)

  if (opts.json) {
    io.out(JSON.stringify(routing))
  } else {
    io.out('')
    io.out(renderTable(
      ['variant', 'agents', 'verified', 'iterations', 'cost', 'tokens', 'wall ms'],
      result.entries.map((e) => e.skipped
        ? [e.variant.id, mixLabel(e.variant.agents), 'skipped (budget)', '-', '-', '-', '-']
        : [
            e.variant.id, mixLabel(e.variant.agents),
            e.verified ? 'yes' : 'no', String(e.iterations),
            `$${(e.costUsd ?? 0).toFixed(4)}`, String(e.tokens), String(Math.round(e.wallMs ?? 0)),
          ]),
    ))
    const best = result.entries[0]
    io.out(best.verified
      ? ok(`winner: ${best.variant.id} - recommended agents written to ${routingPath}`)
      : warn(`no variant verified - cheapest attempt recorded in ${routingPath}`))
    io.out(dim(`  spent $${result.spentUsd.toFixed(2)} of $${result.budgetUsd} budget`))
  }
  return result.entries[0].verified ? 0 : 2
}

function parsePositiveInt(flag: string): (value: string) => number {
  return (value) => {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer, got "${value}"`)
    return n
  }
}

function parsePositiveNumber(flag: string): (value: string) => number {
  return (value) => {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number, got "${value}"`)
    return n
  }
}

export function registerRoute(program: Command): void {
  program
    .command('route [file]')
    .description('benchmark auto-generated adapter/model variants of this repo\'s own loopfile and record the empirically best mix (exit 0 a variant verified, 2 none did, 1 error)')
    .option('--variants <n>', 'max number of variants to generate (default: 4)', parsePositiveInt('--variants'))
    .option('--max-cost-usd <n>', 'total budget across all variants; no further variant launches once spent (default: 5)', parsePositiveNumber('--max-cost-usd'))
    .option('--yes', 'skip the confirmation prompt (this runs real paid loops)')
    .option('--json', 'machine-readable routing result on stdout (same object as .looprail/routing.json)')
    .action(async (
      file: string | undefined,
      opts: { json?: boolean; yes?: boolean; variants?: number; maxCostUsd?: number },
      cmd: Command,
    ) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = await routeAction(file, { cwd, ...opts })
    })
}
