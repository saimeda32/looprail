export interface Template {
  description: string
  yaml: (adapter: string) => string
}

export const TEMPLATES: Record<string, Template> = {
  'fix-tests': {
    description: 'make a failing test suite pass, with an anti-gaming critic',
    yaml: (adapter) => `name: fix-tests
goal: |
  Make the test suite pass. Done means: npm test exits 0 and a critic
  confirms no test was deleted, skipped, or weakened to force a pass.

agents:
  worker:  { adapter: ${adapter} }
  checker: { adapter: ${adapter} }

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
    yaml: (adapter) => `name: research-report
goal: |
  Produce a cited research report on TOPIC (edit me). Done means: every
  claim has a source and independent critics find no unsupported claims.

agents:
  worker:  { adapter: ${adapter} }
  checker: { adapter: ${adapter} }

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
    description: 'behavior-preserving refactor guarded by tests and a critic',
    yaml: (adapter) => `name: refactor
goal: |
  Refactor TARGET (edit me) without changing behavior. Done means: the
  test suite still passes and a critic finds no behavior change or
  dropped edge case.

agents:
  worker:  { adapter: ${adapter} }
  checker: { adapter: ${adapter} }

graph:
  refactor: { role: executor, agent: worker }
  tests:    { role: tester, after: refactor, run: npm test, expect: exit 0 }
  crit:     { role: critic, agent: checker, of: refactor, after: refactor,
              prompt: Fail on any behavior change, API break, or dropped edge case. }

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
    yaml: (adapter) => `name: content-pipeline
goal: |
  Draft, edit, and fact-check a publishable article on TOPIC (edit me).
  Done means: the weighted critique passes and a human signs off.

agents:
  worker: { adapter: ${adapter} }
  editor: { adapter: ${adapter} }

graph:
  outline: { role: planner, agent: worker }
  draft:   { role: executor, agent: worker, after: outline }
  style:   { role: critic, agent: editor, of: draft, after: draft, weight: 1,
             prompt: Critique clarity, tone, and structure. }
  facts:   { role: critic, agent: editor, of: draft, after: draft, weight: 2,
             prompt: Fail on any claim you cannot verify. }
  approve: { role: gate, after: [style, facts], weight: 2 }

rails:
  max_iterations: 5
  max_cost_usd: 15
  stall_after: 3
  replan_limit: 1

verdict: { policy: { weighted: 0.8 } }
`,
  },
}
