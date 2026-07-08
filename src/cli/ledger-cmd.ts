import { resolve } from 'node:path'
import type { Command } from 'commander'
import { readLedger, verifyLedger } from '../journal/ledger.js'
import { defaultIo, dim, err, heading, ok, renderTable, type CliIo } from './ui.js'

const DEFAULT_LEDGER = '.looprail/ledger.jsonl'

// `looprail ledger` - inspect the repo's evidence ledger; `--verify`
// recomputes the whole hash chain and names exactly where it breaks. This
// is the read side of `ledger: true` in a loopfile (journal/ledger.ts).
export function ledgerAction(
  opts: { cwd: string; file?: string; verify?: boolean; json?: boolean },
  deps: { io?: CliIo } = {},
): number {
  const io = deps.io ?? defaultIo
  const path = resolve(opts.cwd, opts.file ?? DEFAULT_LEDGER)
  if (opts.verify) {
    const result = verifyLedger(path)
    if (opts.json) {
      io.out(JSON.stringify(result))
      return result.ok ? 0 : 1
    }
    if (result.ok) {
      io.out(ok(`ledger intact - ${result.entries} entr${result.entries === 1 ? 'y' : 'ies'}, chain verifies end to end`))
      return 0
    }
    io.out(err(`ledger BROKEN at entry ${result.brokenAtSeq}: ${result.detail}`))
    io.out(dim('  every entry from the break onward is untrustworthy - check git history for what changed'))
    return 1
  }
  const entries = readLedger(path)
  if (opts.json) {
    io.out(JSON.stringify(entries, null, 2))
    return 0
  }
  if (entries.length === 0) {
    io.out(dim(`no ledger at ${path} - add \`ledger: true\` to a loopfile to start recording verdicts`))
    return 0
  }
  io.out(heading(`evidence ledger (${entries.length} entries)`))
  io.out(renderTable(
    ['seq', 'when', 'run', 'iter', 'node', 'role', 'verdict', 'evidence'],
    entries.slice(-30).map((e) => [
      String(e.seq),
      new Date(e.ts).toISOString().slice(0, 16).replace('T', ' '),
      e.runId,
      String(e.iteration),
      e.node,
      e.role,
      e.verdict.status + (e.verdict.gaps?.length ? ` (+${e.verdict.gaps.length} gaps)` : ''),
      e.verdict.evidence.slice(0, 60),
    ]),
  ))
  io.out(dim('  `looprail ledger --verify` recomputes the hash chain'))
  return 0
}

export function registerLedger(program: Command): void {
  program
    .command('ledger [file]')
    .description('inspect the repo\'s hash-chained evidence ledger; --verify checks the chain')
    .option('--verify', 'recompute the whole hash chain and report any break')
    .option('--json', 'machine-readable output')
    .action((file: string | undefined, opts: { verify?: boolean; json?: boolean }, cmd: Command) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = ledgerAction({ cwd, file, verify: opts.verify, json: opts.json })
    })
}
