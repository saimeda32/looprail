import type { Command } from 'commander'
import {
  detectAgents, listAdapterModels,
  type AdapterModelListing, type DetectedAgent,
} from '../index.js'
import { defaultIo, dim, err, heading, ok, renderTable, type CliIo } from './ui.js'

export interface DoctorDeps {
  detect?: () => Promise<DetectedAgent[]>
  listModels?: () => Promise<AdapterModelListing[]>
  io?: CliIo
}

export async function doctorAction(deps: DoctorDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIo
  const agents = await (deps.detect ?? detectAgents)()
  io.out(heading('looprail doctor'))
  io.out(renderTable(
    ['adapter', 'binary', 'status', 'version', 'fix'],
    agents.map((a) => [
      a.adapter,
      a.command,
      a.available ? 'available' : 'missing',
      a.version ?? '-',
      a.available ? '-' : a.fixHint,
    ]),
  ))
  const available = agents.filter((a) => a.available)
  if (available.length === 0) {
    io.out(err('no agent CLI found - install one above, or use adapter "mock"/"shell" in your loopfile'))
    io.out(dim('  want to see looprail work first? `looprail demo` runs a full verified loop with no CLI at all.'))
    return 1
  }
  io.out(ok(`${available.length} adapter(s) ready - adapters reuse each CLI's own login, no API keys needed`))
  return 0
}

export async function doctorModelsAction(
  opts: { json?: boolean } = {}, deps: DoctorDeps = {},
): Promise<number> {
  const io = deps.io ?? defaultIo
  const listings = await (deps.listModels ?? listAdapterModels)()
  const installed = listings.filter((l) => l.available)
  if (opts.json) {
    // The full listings (including unavailable CLIs) so machine consumers
    // see the same picture the table + skip lines paint for humans.
    io.out(JSON.stringify(listings, null, 2))
    return installed.length === 0 ? 1 : 0
  }
  io.out(heading('looprail doctor --models'))
  io.out(renderTable(
    ['adapter', 'model', 'source'],
    installed.flatMap((l) => l.models.map((m) => [l.adapter, m.model, m.source])),
  ))
  for (const l of installed) {
    if (l.note) io.out(dim(`${l.adapter}: ${l.note}`))
  }
  for (const l of listings) {
    if (!l.available) io.out(dim(`${l.adapter}: skipped - ${l.binary} not installed (${l.fixHint})`))
  }
  if (installed.length === 0) {
    io.out(err('no agent CLI found - install one above, or use adapter "mock"/"shell" in your loopfile'))
    return 1
  }
  io.out(ok('"live" rows were enumerated from the CLI just now; "static" rows are built-in lists that can go stale'))
  return 0
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('check which agent CLIs are installed and how to fix missing ones')
    .option('--models', 'list the models each installed agent CLI can run')
    .option('--json', 'with --models: print the listings as JSON')
    .action(async (opts: { models?: boolean; json?: boolean }) => {
      process.exitCode = opts.models
        ? await doctorModelsAction({ json: opts.json })
        : await doctorAction()
    })
}
