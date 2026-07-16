import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import { detectAgents, type DetectedAgent } from '../index.js'
import { detectTestCommand, type DetectedTestCommand } from './detect-test-command.js'
import { defaultIo, dim, err, ok, warn, type CliIo } from './ui.js'
import { TEMPLATES, tierToModel, type AgentRole, type Tier } from './templates.js'
import { readUserConfig } from '../config/user-config.js'
import { canInteract, interactiveSelect } from './select.js'

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
export const KNOWN_ADAPTERS = ['claude-code', 'codex', 'aider', 'copilot-cli', 'gemini', 'antigravity', 'opencode', 'ollama', 'shell', 'mock']

export interface InitOpts {
  cwd: string
  template?: string
  agent?: string
  reviewer?: string
  // Path to a spec/PRD file - forces the implement-spec template and
  // threads the path into its planner/critic prompts (spec intake).
  fromSpec?: string
  yes?: boolean
  force?: boolean
}

export interface InitDeps {
  detect?: () => Promise<DetectedAgent[]>
  // Injected user preferences (tests); defaults to the real config file.
  userConfig?: import('../config/user-config.js').UserConfig
  detectTests?: (cwd: string) => DetectedTestCommand | undefined
  ask?: (question: string, choices: string[]) => Promise<string>
  io?: CliIo
}

// On a real terminal, questions use the arrow-key selector (cli/select.ts);
// everywhere else (CI, pipes) the numbered prompt below keeps working
// exactly as before. Ctrl-c during selection exits like any interrupted
// prompt would.
async function askInteractive(question: string, choices: string[], io: CliIo = defaultIo): Promise<string> {
  if (canInteract()) {
    try {
      return await interactiveSelect(question, choices)
    } catch {
      process.exitCode = 130
      process.exit(130) // selection canceled (ctrl-c) - behave like a real ^C
    }
  }
  return askViaStdin(question, choices, io)
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

  // --from-spec: the spec file must exist (a loop pointed at a missing spec
  // would burn a planner invocation discovering that), and it forces the
  // implement-spec template - picking any other template with a spec makes
  // no sense.
  let specPath: string | undefined
  if (opts.fromSpec) {
    if (!existsSync(resolve(opts.cwd, opts.fromSpec))) {
      io.out(err(`--from-spec: no file at ${resolve(opts.cwd, opts.fromSpec)}`))
      return 1
    }
    if (opts.template && opts.template !== 'implement-spec') {
      io.out(err(`--from-spec always uses the implement-spec template - drop --template ${opts.template}`))
      return 1
    }
    specPath = opts.fromSpec
  }

  const templateNames = Object.keys(TEMPLATES)
  let templateName: string
  if (specPath) {
    templateName = 'implement-spec'
  } else if (opts.template) {
    templateName = opts.template
  } else if (opts.yes || !deps.ask) {
    templateName = templateNames[0]
  } else {
    // Show each template's description in the picker so the choice is
    // informed, not a guess at what a bare name does. The enriched label is
    // mapped back to its template name after the pick.
    const labels = templateNames.map((n) => `${n} - ${TEMPLATES[n].description}`)
    const byLabel = new Map(labels.map((l, i) => [l, templateNames[i]]))
    const picked = await deps.ask('Pick a template', labels)
    templateName = byLabel.get(picked) ?? templateNames[0]
  }
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
  // The user's saved preferences (`looprail config set worker/reviewer ...`)
  // become the pre-selected defaults - but only when actually installed:
  // preferring an absent adapter must not scaffold a loop that can't run.
  const prefs = deps.userConfig ?? readUserConfig()
  const preferredWorker = prefs.worker && availableAdapters.includes(prefs.worker) ? prefs.worker : undefined
  let worker = opts.agent
  if (!worker && availableAdapters.length > 0) {
    // put the preferred adapter first so it's the default-on-enter choice
    const ordered = preferredWorker
      ? [preferredWorker, ...availableAdapters.filter((a) => a !== preferredWorker)]
      : availableAdapters
    worker = opts.yes || ordered.length === 1 || !deps.ask
      ? ordered[0]
      : await deps.ask('Which agent should run your loop?', ordered)
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
    const preferredReviewer = prefs.reviewer && availableAdapters.includes(prefs.reviewer) && prefs.reviewer !== worker
      ? prefs.reviewer : undefined
    const distinct = !opts.agent ? availableAdapters.find((a) => a !== worker) : undefined
    reviewer = preferredReviewer ?? distinct ?? worker
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

  writeFileSync(target, template.yaml(adapters, models, detectedTests?.command, specPath))
  io.out(ok(`wrote ${target} (template: ${templateName}, worker: ${worker}, reviewer: ${reviewer})`))
  io.out('next: looprail run')
  return 0
}

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('scaffold a working looprail.yaml from the template gallery')
    .option('--template <name>', `one of: ${Object.keys(TEMPLATES).join(', ')}`)
    .option('--from-spec <path>', 'scaffold a self-planning loop that implements this spec/PRD file, with requirement-coverage review and a plan-approval gate')
    .option('--agent <adapter>', `worker adapter to prefill - one of: ${KNOWN_ADAPTERS.join(', ')}`)
    .option('--reviewer <adapter>', 'reviewer adapter to prefill (defaults to a different detected adapter than --agent, when available)')
    .option('--yes', 'non-interactive: first available agent, first template')
    .option('--force', 'overwrite an existing looprail.yaml')
    .action(async (opts: Omit<InitOpts, 'cwd'>, cmd: Command) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = await initAction({ ...opts, cwd }, { ask: askInteractive })
    })
}
