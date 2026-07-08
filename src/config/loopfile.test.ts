import { expect, test } from 'vitest'
import { parseGraphFragment, parseLoopfile } from './loopfile.js'

const SAMPLE = `
name: research-report
goal: Produce a cited report
agents:
  worker:  { adapter: claude-code, model: sonnet }
  checker: { adapter: claude-code, model: haiku }
graph:
  plan:      { role: planner, agent: worker }
  plan-crit: { role: critic, agent: checker, of: plan, panel: 3, rounds: 2, after: plan }
  draft:     { role: executor, agent: worker, after: plan-crit }
  cite-test: { role: tester, after: draft, run: ./check.sh, expect: exit 0 }
  judge:     { role: judge, agent: checker, after: [cite-test], threshold: 0.85 }
rails:
  max_iterations: 8
  max_cost_usd: 25
  stall_after: 3
  replan_limit: 2
verdict: { policy: all-pass }
`

test('parses a full loopfile into a LoopDef', () => {
  const def = parseLoopfile(SAMPLE)
  expect(def.name).toBe('research-report')
  expect(def.agents.worker).toEqual({ adapter: 'claude-code', model: 'sonnet' })
  expect(def.rails).toEqual({
    maxIterations: 8, maxCostUsd: 25, stallAfter: 3, replanLimit: 2,
  })
  expect(def.verdictPolicy).toEqual({ kind: 'all-pass' })
  const draft = def.nodes.find((n) => n.id === 'draft')!
  expect(draft).toMatchObject({ role: 'executor', agent: 'worker', after: ['plan-crit'] })
  const crit = def.nodes.find((n) => n.id === 'plan-crit')!
  expect(crit).toMatchObject({ panel: 3, rounds: 2, of: 'plan' })
  const judge = def.nodes.find((n) => n.id === 'judge')!
  expect(judge.threshold).toBe(0.85)
})

test('parses an agent fallback into AgentDef.fallback', () => {
  const def = parseLoopfile(SAMPLE.replace(
    'worker:  { adapter: claude-code, model: sonnet }',
    'worker:  { adapter: claude-code, model: sonnet, fallback: checker }',
  ))
  expect(def.agents.worker).toEqual({ adapter: 'claude-code', model: 'sonnet', fallback: 'checker' })
  expect(def.agents.checker.fallback).toBeUndefined()
})

test('quorum policy maps to atLeast', () => {
  const def = parseLoopfile(SAMPLE.replace('policy: all-pass', 'policy: { quorum: 2 }'))
  expect(def.verdictPolicy).toEqual({ kind: 'quorum', atLeast: 2 })
})

test('lists all missing required fields in one error', () => {
  expect(() => parseLoopfile('name: x')).toThrow(/goal[\s\S]*agents[\s\S]*graph[\s\S]*rails/)
})

test('rejects unsupported expect values', () => {
  expect(() => parseLoopfile(SAMPLE.replace('exit 0', 'contains ok'))).toThrow(/expect/)
})

test('lists all nested problems (empty rails, missing role) in one error', () => {
  const bad = `
name: research-report
goal: Produce a cited report
agents:
  worker:  { adapter: claude-code, model: sonnet }
graph:
  plan: { agent: worker }
rails: {}
`
  try {
    parseLoopfile(bad)
    throw new Error('expected parseLoopfile to throw')
  } catch (err) {
    const message = (err as Error).message
    expect(message).toMatch(/max_iterations/)
    expect(message).toMatch(/max_cost_usd/)
    expect(message).toMatch(/invalid role/)
  }
})

test('rejects unrecognized verdict.policy values', () => {
  expect(() => parseLoopfile(SAMPLE.replace('policy: all-pass', 'policy: al-pass')))
    .toThrow(/verdict\.policy/)
})

test('rejects non-positive quorum values', () => {
  expect(() => parseLoopfile(SAMPLE.replace('policy: all-pass', 'policy: { quorum: 0 }')))
    .toThrow(/verdict\.policy/)
})

test('weighted policy and node weights parse through', () => {
  const withWeights = SAMPLE
    .replace('policy: all-pass', 'policy: { weighted: 0.7 }')
    .replace('{ role: judge, agent: checker, after: [cite-test], threshold: 0.85 }',
      '{ role: judge, agent: checker, after: [cite-test], threshold: 0.85, weight: 3 }')
  const def = parseLoopfile(withWeights)
  expect(def.verdictPolicy).toEqual({ kind: 'weighted', threshold: 0.7 })
  expect(def.nodes.find((n) => n.id === 'judge')!.weight).toBe(3)
})

test('rejects a weighted threshold outside (0, 1]', () => {
  expect(() => parseLoopfile(SAMPLE.replace('policy: all-pass', 'policy: { weighted: 1.5 }')))
    .toThrow(/weighted/)
  expect(() => parseLoopfile(SAMPLE.replace('policy: all-pass', 'policy: { weighted: 0 }')))
    .toThrow(/weighted/)
})

test('rejects stall_after below 2', () => {
  expect(() => parseLoopfile(SAMPLE.replace('stall_after: 3', 'stall_after: 1')))
    .toThrow(/stall_after must be at least 2/)
})

test('accepts stall_after of exactly 2', () => {
  const def = parseLoopfile(SAMPLE.replace('stall_after: 3', 'stall_after: 2'))
  expect(def.rails.stallAfter).toBe(2)
})

test('rejects a non-numeric concurrency', () => {
  expect(() => parseLoopfile(`${SAMPLE}\nconcurrency: fast`))
    .toThrow(/concurrency must be a positive number/)
})

test('rejects a non-positive concurrency', () => {
  expect(() => parseLoopfile(`${SAMPLE}\nconcurrency: 0`))
    .toThrow(/concurrency must be a positive number/)
})

test('a positive concurrency parses through', () => {
  expect(parseLoopfile(`${SAMPLE}\nconcurrency: 3`).concurrency).toBe(3)
})

test('gate_timeout rail maps to gateTimeoutSec', () => {
  const def = parseLoopfile(
    SAMPLE.replace('max_iterations: 8', 'max_iterations: 8\n  gate_timeout: 300'))
  expect(def.rails.gateTimeoutSec).toBe(300)
})

test('parseGraphFragment parses a graph-only fragment with no agents/rails', () => {
  const fragment = parseGraphFragment(`
graph:
  build: { role: executor, agent: worker, prompt: Do the thing. }
  tests: { role: tester, after: build, run: npm test, expect: exit 0 }
`)
  expect(fragment.nodes.map((n) => n.id)).toEqual(['build', 'tests'])
  expect(fragment.nodes[0]).toMatchObject({ role: 'executor', agent: 'worker', prompt: 'Do the thing.' })
  expect(fragment.nodes[1]).toMatchObject({ role: 'tester', after: ['build'], run: 'npm test' })
  expect(fragment.agents).toBeUndefined()
  expect(fragment.rails).toBeUndefined()
})

test('parseGraphFragment parses its own agents and rails when present', () => {
  const fragment = parseGraphFragment(`
agents:
  extra: { adapter: copilot-cli, model: gpt-5-codex }
graph:
  build: { role: executor, agent: extra }
rails:
  max_cost_usd: 5
  max_iterations: 3
`)
  expect(fragment.agents).toEqual({ extra: { adapter: 'copilot-cli', model: 'gpt-5-codex' } })
  expect(fragment.rails).toEqual({ maxCostUsd: 5, maxIterations: 3 })
})

test('parseGraphFragment throws a clearly-prefixed error on invalid YAML', () => {
  expect(() => parseGraphFragment('graph: [not, a, map]')).toThrow(/^invalid graph fragment:/)
})

test('parseGraphFragment throws when graph is missing entirely', () => {
  expect(() => parseGraphFragment('agents: {}')).toThrow(/^invalid graph fragment:\ngraph is required/)
})

// Superseded behavior, deliberately: fragments used to reject an unsupported
// expect exactly like parseLoopfile. Now a planner-generated fragment REPAIRS
// it (see repairProseExpect) because a planner's structural slip must never
// cost a paid replan - while a hand-written loopfile's identical typo still
// fails loudly at its author (parseLoopfile untouched, covered by the
// 'rejects unsupported expect values' test above).
test('parseGraphFragment repairs an unsupported expect on a run-bearing node instead of rejecting like parseLoopfile does', () => {
  const fragment = parseGraphFragment(`
graph:
  bad: { role: tester, run: echo hi, expect: "exit 1" }
`)
  expect(fragment.nodes[0].expect).toBe('exit 0')
})

test('parseGraphFragment strips a leading sentence and a markdown code fence before parsing', () => {
  const fragment = parseGraphFragment(
    "All referenced files exist. The plan is sound; I'll output it as clean, valid YAML.\n\n" +
    '```yaml\n' +
    'graph:\n' +
    '  build: { role: executor, agent: worker, prompt: Do the thing. }\n' +
    '```\n',
  )
  expect(fragment.nodes.map((n) => n.id)).toEqual(['build'])
})

test('parseGraphFragment still throws its clear error when stripping a fence would not help', () => {
  expect(() => parseGraphFragment('just some prose with no yaml at all'))
    .toThrow(/^invalid graph fragment:/)
})

// Real halt caught live: a generates:'graph' planner (claude-sonnet-5, via
// copilot-cli) replied with the common networkx/d3/vis.js graph-library
// shape (a top-level `nodes:` array, each item carrying its own `id`)
// instead of looprail's own map-keyed-by-id shape. It exhausted its replan
// budget and halted, even though the reviewer critic had already passed the
// plan's conceptual soundness - the structural parse and the critic's
// judgment are separate checks. Every field on each array item was already a
// valid NodeDef field; only the wrapping shape was wrong, so this is fixed
// deterministically, without ever costing a replan, the same way a
// fenced/prose-wrapped reply is recovered by extractYamlCandidate above.
test('parseGraphFragment mechanically repairs a nodes: array shape into the real id-keyed map, with no replan', () => {
  const fragment = parseGraphFragment(`
graph:
  nodes:
    - id: build
      role: executor
      agent: worker
      prompt: Do the thing.
    - id: tests
      role: tester
      agent: worker
      after: [build]
      run: npm test
      expect: exit 0
`)
  expect(fragment.nodes.map((n) => n.id)).toEqual(['build', 'tests'])
  expect(fragment.nodes[0]).toMatchObject({ role: 'executor', agent: 'worker', prompt: 'Do the thing.' })
  expect(fragment.nodes[1]).toMatchObject({ role: 'tester', after: ['build'], run: 'npm test' })
})

test('parseGraphFragment folds a separate edges: array (the {from, to} convention) into after on the target node', () => {
  const fragment = parseGraphFragment(`
graph:
  nodes:
    - id: build
      role: executor
      agent: worker
    - id: tests
      role: tester
      agent: worker
      run: npm test
      expect: exit 0
  edges:
    - { from: build, to: tests }
`)
  expect(fragment.nodes.find((n) => n.id === 'tests')).toMatchObject({ after: ['build'] })
})

test('parseGraphFragment folds an edges: array using the {source, target} convention too', () => {
  const fragment = parseGraphFragment(`
graph:
  nodes:
    - id: build
      role: executor
      agent: worker
    - id: tests
      role: tester
      agent: worker
      run: npm test
      expect: exit 0
  edges:
    - { source: build, target: tests }
`)
  expect(fragment.nodes.find((n) => n.id === 'tests')).toMatchObject({ after: ['build'] })
})

test('parseGraphFragment folds edges into an existing after list without dropping what was already there', () => {
  const fragment = parseGraphFragment(`
graph:
  nodes:
    - id: build
      role: executor
      agent: worker
    - id: lint
      role: executor
      agent: worker
    - id: tests
      role: tester
      agent: worker
      after: [build]
      run: npm test
      expect: exit 0
  edges:
    - { from: lint, to: tests }
`)
  expect(fragment.nodes.find((n) => n.id === 'tests')).toMatchObject({ after: ['build', 'lint'] })
})

test('parseGraphFragment leaves a well-formed id-keyed graph untouched (the nodes: array repair only triggers on the malformed shape)', () => {
  const fragment = parseGraphFragment(`
graph:
  build: { role: executor, agent: worker }
`)
  expect(fragment.nodes.map((n) => n.id)).toEqual(['build'])
})

// Real halt caught live (same benchmarking session as the nodes:/edges:
// shape repair above): a planner's very first attempt wrote prose expect
// fields ("file server.js exists and `node -c server.js` passes...") on its
// executor nodes. `expect` only supports the literal "exit 0", so the whole
// otherwise-sound plan was rejected and a paid replan spent on a purely
// structural problem. Same treatment as the shape repair: fix it
// mechanically, never spend an LLM round on it. Hand-written loopfiles keep
// the loud error (parseLoopfile is untouched) - an author's typo should
// fail fast; only planner-generated fragments get auto-repaired.
test('parseGraphFragment repairs a prose expect on a node WITH a run command down to "exit 0" - the command exit code is the real check', () => {
  const fragment = parseGraphFragment(`
graph:
  tests:
    role: tester
    run: npm test
    expect: all endpoint tests pass and the process exits cleanly
`)
  expect(fragment.nodes[0].expect).toBe('exit 0')
  expect(fragment.nodes[0].run).toBe('npm test')
})

test('parseGraphFragment folds a prose expect on a node WITHOUT a run command into the prompt as success criteria, keeping the intent visible to the agent', () => {
  const fragment = parseGraphFragment(`
graph:
  implement_server:
    role: executor
    agent: worker
    prompt: Create server.js implementing the API.
    expect: server.js exists and node --check server.js passes with no syntax errors
`)
  const node = fragment.nodes[0]
  expect(node.expect).toBeUndefined()
  expect(node.prompt).toContain('Create server.js implementing the API.')
  expect(node.prompt).toContain('Success criteria')
  expect(node.prompt).toContain('node --check server.js passes')
})

test('parseGraphFragment normalizes a merely whitespace-padded "exit 0" instead of treating it as prose', () => {
  const fragment = parseGraphFragment(`
graph:
  tests: { role: tester, run: npm test, expect: " exit 0 " }
`)
  expect(fragment.nodes[0].expect).toBe('exit 0')
})

test('parseGraphFragment composes both repairs: a nodes: array shape whose items also carry prose expects (the exact combined shape a real planner produced)', () => {
  const fragment = parseGraphFragment(`
graph:
  nodes:
    - id: implement_server
      role: executor
      agent: worker
      prompt: Create server.js.
      expect: server.js exists and passes a syntax check
    - id: run_tests
      role: tester
      after: [implement_server]
      run: node test.js
      expect: every test passes
`)
  const server = fragment.nodes.find((n) => n.id === 'implement_server')!
  const tests = fragment.nodes.find((n) => n.id === 'run_tests')!
  expect(server.expect).toBeUndefined()
  expect(server.prompt).toContain('Success criteria')
  expect(tests.expect).toBe('exit 0')
  expect(tests.after).toEqual(['implement_server'])
})

test('parses probe: true on a panel node', () => {
  const def = parseLoopfile(`
name: t
goal: g
agents:
  a: { adapter: mock }
graph:
  do:   { role: executor, agent: a }
  crit: { role: critic, agent: a, of: do, after: do, panel: 3, probe: true }
rails:
  max_iterations: 2
  max_cost_usd: 1
`)
  const crit = def.nodes.find((n) => n.id === 'crit')!
  expect(crit.probe).toBe(true)
  expect(crit.panel).toBe(3)
})

// protect: the test-tamper guard field (see engine/protect.ts).
test('protect: tests expands to the built-in test globs', () => {
  const def = parseLoopfile(`
name: t
goal: g
protect: tests
agents:
  a: { adapter: mock }
graph:
  do: { role: executor, agent: a }
  t:  { role: tester, after: do, run: "npm test", expect: exit 0 }
rails: { max_iterations: 2, max_cost_usd: 1 }
`)
  expect(def.protect).toContain('test/**')
  expect(def.protect).toContain('**/*.test.*')
  expect(def.protect).toContain('**/conftest.py')
})

test('protect: explicit glob list is taken verbatim', () => {
  const def = parseLoopfile(`
name: t
goal: g
protect: ["spec/**", "golden/*.json"]
agents:
  a: { adapter: mock }
graph:
  do: { role: executor, agent: a }
  t:  { role: tester, after: do, run: "true", expect: exit 0 }
rails: { max_iterations: 2, max_cost_usd: 1 }
`)
  expect(def.protect).toEqual(['spec/**', 'golden/*.json'])
})

test('a malformed protect value is a hard parse error, never a silent unprotect', () => {
  expect(() => parseLoopfile(`
name: t
goal: g
protect: 42
agents:
  a: { adapter: mock }
graph:
  do: { role: executor, agent: a }
rails: { max_iterations: 2, max_cost_usd: 1 }
`)).toThrow(/protect must be/)
})

test('scope: explicit allowlist parses; malformed scope is a hard error', () => {
  const def = parseLoopfile(`
name: t
goal: g
scope: ["src/**"]
agents:
  a: { adapter: mock }
graph:
  do: { role: executor, agent: a }
  t:  { role: tester, after: do, run: "true", expect: exit 0 }
rails: { max_iterations: 2, max_cost_usd: 1 }
`)
  expect(def.scope).toEqual(['src/**'])
  expect(() => parseLoopfile(`
name: t
goal: g
scope: everything
agents:
  a: { adapter: mock }
graph:
  do: { role: executor, agent: a }
rails: { max_iterations: 2, max_cost_usd: 1 }
`)).toThrow(/scope must be/)
})

test('parses blind: true on a critic node', () => {
  const def = parseLoopfile(`
name: t
goal: g
agents:
  a: { adapter: mock }
graph:
  do:   { role: executor, agent: a }
  crit: { role: critic, agent: a, of: do, after: do, blind: true }
  t:    { role: tester, after: do, run: "true", expect: exit 0 }
rails: { max_iterations: 2, max_cost_usd: 1 }
`)
  expect(def.nodes.find((n) => n.id === 'crit')?.blind).toBe(true)
})
