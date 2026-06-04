import type { Command } from 'commander'
import { detectAgents, type DetectedAgent } from '../index.js'
import { defaultIo, err, heading, ok, renderTable, type CliIo } from './ui.js'

export interface DoctorDeps {
  detect?: () => Promise<DetectedAgent[]>
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
    io.out(err('no agent CLI found — install one above, or use adapter "mock"/"shell" in your loopfile'))
    return 1
  }
  io.out(ok(`${available.length} adapter(s) ready — adapters reuse each CLI's own login, no API keys needed`))
  return 0
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('check which agent CLIs are installed and how to fix missing ones')
    .action(async () => {
      process.exitCode = await doctorAction()
    })
}
