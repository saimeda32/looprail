import type { Command } from 'commander'
import { TEMPLATES } from './templates.js'
import { defaultIo, dim, heading, ok, type CliIo } from './ui.js'

// A machine-readable view of one built-in template: enough to pick one and
// know what agents it will ask you to wire, without running interactive init.
export interface TemplateCatalogEntry {
  name: string
  description: string
  agents: Array<{ key: string; label: string; tier: string; reviewer: boolean }>
}

export function templateCatalog(): TemplateCatalogEntry[] {
  return Object.entries(TEMPLATES).map(([name, t]) => ({
    name,
    description: t.description,
    agents: t.agentRoles.map((r) => ({
      key: r.key,
      label: r.label,
      tier: r.recommendedTier,
      reviewer: r.kind === 'reviewer',
    })),
  }))
}

export function renderTemplateList(): string[] {
  const lines: string[] = []
  lines.push(heading('looprail templates'))
  lines.push(dim('  ready-to-run loop shapes - scaffold one with: looprail init --template <name>'))
  lines.push('')
  const catalog = templateCatalog()
  const width = Math.max(...catalog.map((t) => t.name.length))
  for (const t of catalog) {
    lines.push(`  ${t.name.padEnd(width)}  ${t.description}`)
    // The agent roles the template will ask you to fill, so a different model
    // reviews the worker's output (the whole point of the loop).
    const roles = t.agents
      .map((a) => `${a.key} (${a.tier}${a.reviewer ? ', reviewer' : ''})`)
      .join(', ')
    lines.push(dim(`  ${' '.repeat(width)}  agents: ${roles}`))
  }
  lines.push('')
  lines.push(ok('  pick one, then `looprail run` it - or `looprail run --dry-run` to preview first.'))
  return lines
}

export function templatesAction(
  opts: { json?: boolean } = {},
  deps: { io?: CliIo } = {},
): number {
  const io = deps.io ?? defaultIo
  if (opts.json) {
    io.out(JSON.stringify(templateCatalog(), null, 2))
    return 0
  }
  for (const line of renderTemplateList()) io.out(line)
  return 0
}

export function registerTemplates(program: Command): void {
  program
    .command('templates')
    .description('list the built-in loop templates and what each one verifies')
    .option('--json', 'machine-readable catalog on stdout')
    .action((opts: { json?: boolean }) => {
      process.exitCode = templatesAction(opts)
    })
}
