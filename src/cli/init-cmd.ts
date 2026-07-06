import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import { detectAgents, type DetectedAgent } from '../index.js'
import { detectTestCommand, type DetectedTestCommand } from './detect-test-command.js'
import { defaultIo, dim, err, ok, warn, type CliIo } from './ui.js'
import { TEMPLATES, tierToModel, type AgentRole, type Tier } from './templates.js'

// order tiers are offered in when a role's recommended tier isn't first - 
// the recommended tier is always moved to the front so it's the default
// choice on a bare enter (askViaStdin falls back to choices[0]).
const ALL_TIERS: Tier[] = ['strong', 'medium', 'cheap']

function tierChoices(recommended: Tier): Tier[] {
  return [recommended, ...ALL_TIERS.filter((t) => t !== recommended)]
}

// Resolves each of the template's agent roles to a concrete adapter (fanning
// the already-resolved worker/reviewer adapters out per role) and a model
// tier - prompting interactively when possible, otherwise silently applying
// the role's recommended tier (exactly like every other --yes-skipped
// prompt in this file).
async function resolveAgents(
  roles: AgentRole[],
  worker: string,
  reviewer: string,
  opts: InitOpts,
  deps: InitDeps,
): Promise<{ adapters: Record<string, string>; models: Record<string, string | undefined> }> {
  const adapters: Record<string, string> = {}
  const models: Record<string, string | undefined> = {}
  for (const role of roles) {
    const adapter = role.kind === 'worker' ? worker : reviewer
    adapters[role.key] = adapter
    const tier = opts.yes || !deps.ask
      ? role.recommendedTier
      : await deps.ask(`Model tier for ${role.label} (${adapter})?`, tierChoices(role.recommendedTier)) as Tier
    models[role.key] = tierToModel(adapter, tier)
  }
  return { adapters, models }
}

// known looprail adapter ids - mirrors createDefaultRegistry's registrations
// (src/adapters/default-registry.ts). Kept here rather than imported so init
// can validate --agent/--reviewer without pulling in the CLI adapter deps.
export const KNOWN_ADAPTERS = ['claude-code', 'codex', 'aider', 'copilot-cli', 'shell', 'mock']

export interface InitOpts {
  cwd: string
  template?: string
  agent?: string
  reviewer?: string
  yes?: boolean
  force?: boolean
}

export interface InitDeps {
  detect?: () => Promise<DetectedAgent[]>
  detectTests?: (cwd: string) => DetectedTestCommand | undefined
  ask?: (question: string, choices: string[]) => Promise<string>
  io?: CliIo
}

async function askViaStdin(question: string, choices: string[], io: CliIo = defaultIo): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    choices.forEach((c, i) => io.out(`  ${i + 1}. ${c}`))
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
    io.out(err(`refusing to overwrite ${target} - pass --force to replace it`))
    return 1
  }

  const templateNames = Object.keys(TEMPLATES)
  const templateName = opts.template
    ?? (opts.yes || !deps.ask
      ? templateNames[0]
      : await deps.ask('Pick a template', templateNames))
  const template = TEMPLATES[templateName]
  if (!template) {
    io.out(err(`unknown template "${templateName}" - one of: ${templateNames.join(', ')}`))
    return 1
  }

  if (opts.agent && !KNOWN_ADAPTERS.includes(opts.agent)) {
    io.out(err(`unknown adapter "${opts.agent}" for --agent - one of: ${KNOWN_ADAPTERS.join(', ')}`))
    return 1
  }
  if (opts.reviewer && !KNOWN_ADAPTERS.includes(opts.reviewer)) {
    io.out(err(`unknown adapter "${opts.reviewer}" for --reviewer - one of: ${KNOWN_ADAPTERS.join(', ')}`))
    return 1
  }

  const detected = await (deps.detect ?? detectAgents)()
  const availableAdapters = detected.filter((a) => a.available).map((a) => a.adapter)
  let worker = opts.agent
  if (!worker && availableAdapters.length > 0) {
    worker = opts.yes || availableAdapters.length === 1 || !deps.ask
      ? availableAdapters[0]
      : await deps.ask('Which agent should run your loop?', availableAdapters)
  }
  if (!worker) {
    worker = 'mock'
    io.out(warn('no agent CLI detected - scaffolding with the mock adapter; run `looprail doctor` to fix'))
  }

  // reviewer defaults to a genuinely different detected adapter than the
  // worker, so the generated loop shows real cross-model verification. An
  // explicit --agent pins the worker deliberately, so we don't second-guess
  // it - reviewer falls back to worker unless --reviewer says otherwise.
  let reviewer = opts.reviewer
  if (!reviewer) {
    const distinct = !opts.agent ? availableAdapters.find((a) => a !== worker) : undefined
    reviewer = distinct ?? worker
  }
  if (worker !== reviewer) {
    io.out(`worker: ${worker}, reviewer: ${reviewer} - independent verification`)
  }

  const { adapters, models } = await resolveAgents(template.agentRoles, worker, reviewer, opts, deps)

  // Wire the scaffolded tester to THIS repo's real test command instead of
  // a hardcoded `npm test` the user has to notice and hand-edit - a tester
  // running the wrong command either fails instantly or, worse, "verifies"
  // work it never tested. Detection is conservative (well-known ecosystem
  // markers only - see detect-test-command.ts); no match keeps the old
  // `npm test` default with its swap-it comment.
  const detectedTests = (deps.detectTests ?? detectTestCommand)(opts.cwd)
  if (detectedTests) {
    io.out(dim(`detected test command: ${detectedTests.command} (${detectedTests.source})`))
  }

  // re-check immediately before the write: closes the TOCTOU window opened
  // by the async prompts/detection above (another process could have
  // created the file in the meantime). The early guard above still covers
  // the fast, no-prompt path without paying for detection first.
  if (existsSync(target) && !opts.force) {
    io.out(err(`refusing to overwrite ${target} - pass --force to replace it`))
    return 1
  }

  writeFileSync(target, template.yaml(adapters, models, detectedTests?.command))
  io.out(ok(`wrote ${target} (template: ${templateName}, worker: ${worker}, reviewer: ${reviewer})`))
  io.out('next: looprail run')
  return 0
}

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('scaffold a working looprail.yaml from the template gallery')
    .option('--template <name>', `one of: ${Object.keys(TEMPLATES).join(', ')}`)
    .option('--agent <adapter>', `worker adapter to prefill - one of: ${KNOWN_ADAPTERS.join(', ')}`)
    .option('--reviewer <adapter>', 'reviewer adapter to prefill (defaults to a different detected adapter than --agent, when available)')
    .option('--yes', 'non-interactive: first available agent, first template')
    .option('--force', 'overwrite an existing looprail.yaml')
    .action(async (opts: Omit<InitOpts, 'cwd'>, cmd: Command) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = await initAction({ ...opts, cwd }, { ask: askViaStdin })
    })
}
