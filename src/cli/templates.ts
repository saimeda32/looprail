// Model tier is a per-agent-role RECOMMENDATION only - the user (or --yes'
// non-interactive default) always makes the actual choice; nothing in this
// file ever picks a tier on its own.
export type Tier = 'strong' | 'medium' | 'cheap'

// Which already-resolved CLI adapter (worker or reviewer) a role's agent key
// should be wired to - see init-cmd.ts, which resolves `worker`/`reviewer`
// adapter strings once and then fans them out across every agent key here.
export type RoleKind = 'worker' | 'reviewer'

export interface AgentRole {
  key: string
  label: string
  recommendedTier: Tier
  kind: RoleKind
}

export interface Template {
  description: string
  // one entry per agent key the template's yaml() declares - lets a caller
  // (init-cmd.ts) know what to prompt for and what to recommend as default.
  agentRoles: AgentRole[]
  // adapters and models are both keyed by agent key (e.g. 'worker',
  // 'checker', 'fact-editor'). templates.ts does zero tier decision-making
  // here - it only interpolates whatever adapter+model string it is given.
  yaml: (adapters: Record<string, string>, models: Record<string, string | undefined>) => string
}

const REVIEWER_COMMENT = '# independent reviewer - a different model catches what the worker\'s own model misses'

// Model names are Claude-specific (haiku/sonnet/opus), so only claude-code
// gets a model: field -- codex/aider/copilot-cli/shell/mock have different or
// no model-tier concept, and should keep deferring to their own default.
// This is a pure translation: it never runs unless a caller passes an
// explicit tier, and the tier itself always comes from the user's choice (or
// the recommended default in non-interactive mode) - see init-cmd.ts.
export function tierToModel(adapter: string, tier: Tier): string | undefined {
  if (adapter !== 'claude-code') return undefined
  if (tier === 'strong') return 'opus'
  if (tier === 'medium') return 'sonnet'
  return 'haiku'
}

function agentSpec(
  adapters: Record<string, string>,
  models: Record<string, string | undefined>,
  key: string,
): string {
  const model = models[key]
  return `{ adapter: ${adapters[key]}${model ? `, model: ${model}` : ''} }`
}

export const TEMPLATES: Record<string, Template> = {
  'fix-tests': {
    description: 'make a failing test suite pass, with an anti-gaming critic',
    agentRoles: [
      { key: 'worker', label: 'worker (fixes the failing tests)', recommendedTier: 'medium', kind: 'worker' },
      { key: 'checker', label: 'checker (anti-gaming critic)', recommendedTier: 'cheap', kind: 'reviewer' },
    ],
    yaml: (adapters, models) => `name: fix-tests
goal: |
  Make the test suite pass. Done means: npm test exits 0 and a critic
  confirms no test was deleted, skipped, or weakened to force a pass.

agents:
  worker:  ${agentSpec(adapters, models, 'worker')}
  checker: ${agentSpec(adapters, models, 'checker')}  ${REVIEWER_COMMENT}

graph:
  fix:   { role: executor, agent: worker }
  tests: { role: tester, after: fix, run: npm test, expect: exit 0 }
  crit:  { role: critic, agent: checker, of: fix, after: fix,
           prompt: Fail if any test was deleted, skipped, or weakened to force a pass. }

rails:
  max_iterations: 6
  max_cost_usd: 10
  stall_after: 3
  replan_limit: 1

verdict: { policy: all-pass }
`,
  },

  'research-report': {
    description: 'cited research report with plan critique and a critic panel',
    agentRoles: [
      { key: 'worker', label: 'worker (plans and drafts the report)', recommendedTier: 'medium', kind: 'worker' },
      { key: 'checker', label: 'checker (verifies every claim is sourced)', recommendedTier: 'medium', kind: 'reviewer' },
    ],
    yaml: (adapters, models) => `name: research-report
goal: |
  Produce a cited research report on this repository's own architecture
  and the most consequential decisions in its history - inspect the
  README, git log, and source to ground every claim in what you find.
  Done means: every claim has a source and independent critics find no
  unsupported claims. To research a different topic instead, replace
  the sentence above describing the subject with your own topic.

agents:
  worker:  ${agentSpec(adapters, models, 'worker')}
  checker: ${agentSpec(adapters, models, 'checker')}  ${REVIEWER_COMMENT}
  # recommended tier for the checker is 'medium' rather than a cheap critic:
  # catching an unsupported or hallucinated claim requires real
  # understanding of the domain claim, not a mechanical pattern check.

graph:
  plan:      { role: planner, agent: worker }
  plan-crit: { role: critic, agent: checker, of: plan, after: plan, rounds: 2 }
  draft:     { role: executor, agent: worker, after: plan-crit }
  crit:      { role: critic, agent: checker, of: draft, after: draft, panel: 2,
               prompt: Refute any unsupported or uncited claim. }
  merge:     { role: synthesizer, agent: checker, after: crit }

rails:
  max_iterations: 8
  max_cost_usd: 25
  max_wall_minutes: 90
  stall_after: 3
  replan_limit: 2

verdict: { policy: all-pass }
`,
  },

  refactor: {
    description: 'behavior-preserving refactor guarded by tests and two critics',
    agentRoles: [
      { key: 'worker', label: 'worker (performs the refactor)', recommendedTier: 'medium', kind: 'worker' },
      { key: 'correctness', label: 'correctness critic', recommendedTier: 'cheap', kind: 'reviewer' },
      { key: 'quality', label: 'quality critic', recommendedTier: 'cheap', kind: 'reviewer' },
    ],
    yaml: (adapters, models) => `name: refactor
goal: |
  Refactor the largest or most complex file under src/ without changing
  behavior - use your own judgment to pick one if a specific file isn't
  named. Done means: the test suite still passes, a correctness critic
  finds no behavior change, API break, or dropped edge case, and a
  quality critic confirms the refactor measurably improves readability
  or reduces complexity. To target a specific file instead, replace
  "the largest or most complex file under src/" above with its path.

agents:
  worker:      ${agentSpec(adapters, models, 'worker')}
  correctness: ${agentSpec(adapters, models, 'correctness')}  ${REVIEWER_COMMENT}
  quality:     ${agentSpec(adapters, models, 'quality')}

graph:
  refactor:     { role: executor, agent: worker }
  tests:        { role: tester, after: refactor, run: npm test, expect: exit 0 }
  crit-correct: { role: critic, agent: correctness, of: refactor, after: refactor,
                  prompt: Fail on any behavior change, API break, or dropped edge case. }
  crit-quality: { role: critic, agent: quality, of: refactor, after: refactor,
                  prompt: Fail unless the refactor measurably improves readability or reduces complexity. }

rails:
  max_iterations: 6
  max_cost_usd: 15
  stall_after: 3
  replan_limit: 1

verdict: { policy: all-pass }
`,
  },

  'content-pipeline': {
    description: 'draft → weighted style/fact critique → human sign-off',
    agentRoles: [
      { key: 'worker', label: 'worker (drafts the article)', recommendedTier: 'medium', kind: 'worker' },
      { key: 'editor', label: 'editor (style critic)', recommendedTier: 'cheap', kind: 'reviewer' },
      { key: 'fact-editor', label: 'fact-editor (fact-checking critic)', recommendedTier: 'medium', kind: 'reviewer' },
    ],
    yaml: (adapters, models) => `name: content-pipeline
goal: |
  Draft, edit, and fact-check a short, publishable article explaining
  what this repository does and why it exists, written for engineers
  who have never seen it before. Done means: the weighted critique
  passes and a human signs off. To write about a different topic
  instead, replace the sentence above describing the subject.

agents:
  worker: ${agentSpec(adapters, models, 'worker')}
  editor: ${agentSpec(adapters, models, 'editor')}  ${REVIEWER_COMMENT}
  # fact-editor gets its own agent key; its recommended tier is 'medium'
  # because fact-checking needs real reasoning (same logic as research-report's
  # critics), while style's recommended tier stays 'cheap' since tone/clarity
  # judgment is bounded.
  fact-editor: ${agentSpec(adapters, models, 'fact-editor')}

graph:
  outline: { role: planner, agent: worker }
  draft:   { role: executor, agent: worker, after: outline }
  style:   { role: critic, agent: editor, of: draft, after: draft, weight: 1,
             prompt: Critique clarity, tone, and structure. }
  facts:   { role: critic, agent: fact-editor, of: draft, after: draft, weight: 2,
             prompt: Fail on any claim you cannot verify. }
  approve: { role: gate, after: [style, facts], weight: 2 }  # gate = pauses for human approval (y/n) before the loop can finish

rails:
  max_iterations: 5
  max_cost_usd: 15
  stall_after: 3
  replan_limit: 1

verdict: { policy: { weighted: 0.8 } }
`,
  },

  'review-diff': {
    description: 'adversarial review of a pending diff, no code changes made',
    agentRoles: [
      { key: 'worker', label: 'worker (writes the review)', recommendedTier: 'medium', kind: 'worker' },
      { key: 'reviewer', label: 'reviewer (re-examines the diff)', recommendedTier: 'medium', kind: 'reviewer' },
    ],
    yaml: (adapters, models) => `name: review-diff
goal: |
  Review the currently pending changes (run 'git diff') in whatever
  directory this loop is run from. List every correctness, security,
  and style issue you find, each with a file:line reference. No code
  changes are made - this is a read-only review of the CURRENT PENDING
  diff. Done means: an independent critic re-examines the same diff and
  finds nothing the review missed and nothing it wrongly flagged.

agents:
  worker:   ${agentSpec(adapters, models, 'worker')}
  reviewer: ${agentSpec(adapters, models, 'reviewer')}  ${REVIEWER_COMMENT}
  # recommended tier for the critic is 'medium' rather than a cheap default:
  # code review requires real judgment, not mechanical pattern-matching.

graph:
  review: { role: executor, agent: worker,
            prompt: Run 'git diff' and list every correctness, security, and style issue you find, each with a file:line reference. }
  crit:   { role: critic, agent: reviewer, of: review, after: review,
            prompt: Re-examine the same 'git diff' yourself. Fail if the review missed a real issue, or if it flagged something that is not actually a problem. }

rails:
  max_iterations: 4
  max_cost_usd: 8
  stall_after: 2
  replan_limit: 1

verdict: { policy: all-pass }
`,
  },

  'build-app': {
    description: 'build a new app, website, or feature from a spec, with its own tests',
    agentRoles: [
      { key: 'worker', label: 'worker (builds the app and its tests)', recommendedTier: 'medium', kind: 'worker' },
      { key: 'checker', label: 'checker (spec critic)', recommendedTier: 'medium', kind: 'reviewer' },
    ],
    yaml: (adapters, models) => `name: build-app
goal: |
  Build SPEC (edit this line: describe the app, website, or feature you
  want, including your language/framework if you have one). Done means:
  the code builds, its own tests pass, and a critic confirms the result
  actually satisfies the spec, not just that something runs.

agents:
  worker:  ${agentSpec(adapters, models, 'worker')}
  checker: ${agentSpec(adapters, models, 'checker')}  ${REVIEWER_COMMENT}
  # recommended tier for the critic is 'medium' rather than a cheap default:
  # checking "does this actually satisfy the spec" requires real
  # understanding, not a mechanical check.

graph:
  plan:  { role: planner, agent: worker }
  build: { role: executor, agent: worker, after: plan,
           prompt: Build the app described in the goal above and write its own tests - there is no pre-existing test suite to run. }
  tests: { role: tester, after: build, run: npm test, expect: exit 0 }  # swap "npm test" for your stack's real test command if different, e.g. pytest, go test ./..., or cargo test
  crit:  { role: critic, agent: checker, of: build, after: tests,
           prompt: Fail if the result doesn't actually satisfy the spec above, even if its own tests pass - this catches the case where the agent wrote weak tests for weak work. }

rails:
  max_iterations: 10
  max_cost_usd: 20
  max_wall_minutes: 60
  stall_after: 3
  replan_limit: 2

verdict: { policy: all-pass }
`,
  },
}
