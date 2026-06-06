import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import { detectAgents, type DetectedAgent } from '../index.js'
import { defaultIo, err, ok, warn, type CliIo } from './ui.js'
import { TEMPLATES } from './templates.js'

export interface InitOpts {
  cwd: string
  template?: string
  agent?: string
  yes?: boolean
  force?: boolean
}

export interface InitDeps {
  detect?: () => Promise<DetectedAgent[]>
  ask?: (question: string, choices: string[]) => Promise<string>
  io?: CliIo
}

async function askViaStdin(question: string, choices: string[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    choices.forEach((c, i) => console.log(`  ${i + 1}. ${c}`))
    const answer = await rl.question(`${question} [1-${choices.length}] `)
    const idx = Number(answer.trim()) - 1
    return choices[idx] ?? choices[0]
  } finally {
    rl.close()
  }
}

export async function initAction(opts: InitOpts, deps: InitDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIo
  const target = resolve(opts.cwd, 'looprail.yaml')
  if (existsSync(target) && !opts.force) {
    io.out(err(`refusing to overwrite ${target} — pass --force to replace it`))
    return 1
  }

  const templateNames = Object.keys(TEMPLATES)
  const templateName = opts.template
    ?? (opts.yes || !deps.ask
      ? templateNames[0]
      : await deps.ask('Pick a template', templateNames))
  const template = TEMPLATES[templateName]
  if (!template) {
    io.out(err(`unknown template "${templateName}" — one of: ${templateNames.join(', ')}`))
    return 1
  }

  const detected = await (deps.detect ?? detectAgents)()
  const availableAdapters = detected.filter((a) => a.available).map((a) => a.adapter)
  let adapter = opts.agent
  if (!adapter && availableAdapters.length > 0) {
    adapter = opts.yes || availableAdapters.length === 1 || !deps.ask
      ? availableAdapters[0]
      : await deps.ask('Which agent should run your loop?', availableAdapters)
  }
  if (!adapter) {
    adapter = 'mock'
    io.out(warn('no agent CLI detected — scaffolding with the mock adapter; run `looprail doctor` to fix'))
  }

  writeFileSync(target, template.yaml(adapter))
  io.out(ok(`wrote ${target} (template: ${templateName}, agent: ${adapter})`))
  io.out('next: looprail run')
  return 0
}

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('scaffold a working looprail.yaml from the template gallery')
    .option('--template <name>', `one of: ${Object.keys(TEMPLATES).join(', ')}`)
    .option('--agent <adapter>', 'adapter to prefill (claude-code, codex, aider, copilot-cli, shell, mock)')
    .option('--yes', 'non-interactive: first available agent, first template')
    .option('--force', 'overwrite an existing looprail.yaml')
    .action(async (opts: Omit<InitOpts, 'cwd'>, cmd: Command) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = await initAction({ ...opts, cwd }, { ask: askViaStdin })
    })
}
