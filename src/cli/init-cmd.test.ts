import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { initAction } from './init-cmd.js'
import type { DetectedAgent } from '../index.js'

const detected = (adapters: string[]): (() => Promise<DetectedAgent[]>) =>
  async () => adapters.map((adapter) => ({
    name: adapter, adapter, command: adapter, available: true, fixHint: '',
  }))

function capture() {
  const lines: string[] = []
  return { io: { out: (l: string) => lines.push(l) }, lines }
}

test('non-interactive flags scaffold without asking', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const { io } = capture()
  const code = await initAction(
    { cwd, template: 'fix-tests', agent: 'claude-code' },
    { detect: detected(['claude-code']), io })
  expect(code).toBe(0)
  const yaml = readFileSync(join(cwd, 'looprail.yaml'), 'utf8')
  expect(yaml).toContain('name: fix-tests')
  expect(yaml).toContain('adapter: claude-code')
})

// The scaffolded tester runs THIS repo's real suite, not a hardcoded
// `npm test` the user has to notice and hand-edit - a tester wired to the
// wrong command either fails instantly or silently "verifies" untested work.
test('init wires the tester to the detected real test command and says where it came from', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const { io, lines } = capture()
  const code = await initAction(
    { cwd, template: 'fix-tests', agent: 'claude-code' },
    {
      detect: detected(['claude-code']),
      detectTests: () => ({ command: 'go test ./...', source: 'go.mod' }),
      io,
    })
  expect(code).toBe(0)
  const yaml = readFileSync(join(cwd, 'looprail.yaml'), 'utf8')
  expect(yaml).toContain('run: go test ./...')
  expect(yaml).not.toContain('npm test')
  expect(yaml).not.toContain('swap "npm test"')
  expect(lines.join('\n')).toContain('detected test command: go test ./... (go.mod)')
})

test('init falls back to npm test with the swap-it comment when nothing is detected', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const { io } = capture()
  const code = await initAction(
    { cwd, template: 'fix-tests', agent: 'claude-code' },
    { detect: detected(['claude-code']), detectTests: () => undefined, io })
  expect(code).toBe(0)
  const yaml = readFileSync(join(cwd, 'looprail.yaml'), 'utf8')
  expect(yaml).toContain('run: npm test')
  expect(yaml).toContain('swap "npm test"')
})

test('init detects a real package.json test script from the actual cwd (no injected detector)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
  const { io, lines } = capture()
  const code = await initAction(
    { cwd, template: 'fix-tests', agent: 'claude-code' },
    { detect: detected(['claude-code']), io })
  expect(code).toBe(0)
  expect(lines.join('\n')).toContain('package.json scripts.test')
})

test('--yes takes the first available agent and the first template', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const { io } = capture()
  const code = await initAction({ cwd, yes: true }, { detect: detected(['codex']), io })
  expect(code).toBe(0)
  expect(readFileSync(join(cwd, 'looprail.yaml'), 'utf8')).toContain('adapter: codex')
})

test('interactive path uses the injected ask for agent and template', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const asked: string[] = []
  const code = await initAction({ cwd }, {
    detect: detected(['claude-code', 'codex']),
    ask: async (question, choices) => {
      asked.push(question)
      return choices[choices.length - 1]
    },
    io: capture().io,
  })
  expect(code).toBe(0)
  // the template and agent prompts are asked first; the picked template then
  // also prompts once per agent role for its model tier (tested separately
  // below) - this test only pins down the original template/agent behavior.
  expect(asked.slice(0, 2)).toEqual(['Pick a template', 'Which agent should run your loop?'])
  expect(readFileSync(join(cwd, 'looprail.yaml'), 'utf8')).toContain('adapter: codex')
})

test('the template picker shows each template’s description, not a bare name', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  let templateChoices: string[] = []
  await initAction({ cwd }, {
    detect: detected(['claude-code']),
    ask: async (question, choices) => {
      if (question === 'Pick a template') templateChoices = choices
      return choices[0]
    },
    io: capture().io,
  })
  // every choice carries "name - description", and the pick still resolves to
  // a real template (fix-tests is first)
  expect(templateChoices[0]).toContain('fix-tests')
  expect(templateChoices[0]).toContain('anti-gaming critic')
  expect(readFileSync(join(cwd, 'looprail.yaml'), 'utf8')).toContain('name: fix-tests')
})

test('non-interactive (--yes): every agent role silently gets its recommended tier, no prompting', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const { io } = capture()
  const code = await initAction(
    { cwd, template: 'fix-tests', agent: 'claude-code', yes: true },
    { detect: detected(['claude-code']), io })
  expect(code).toBe(0)
  const yaml = readFileSync(join(cwd, 'looprail.yaml'), 'utf8')
  // fix-tests: worker recommends 'medium' (sonnet), checker recommends 'cheap' (haiku)
  expect(yaml).toContain('worker:  { adapter: claude-code, model: sonnet, permissions: safe }')
  expect(yaml).toContain('checker: { adapter: claude-code, model: haiku, permissions: safe }')
})

test('no ask provided (e.g. non-TTY without --yes): every agent role still gets its recommended tier', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const { io } = capture()
  const code = await initAction(
    { cwd, template: 'fix-tests', agent: 'claude-code' },
    { detect: detected(['claude-code']), io })
  expect(code).toBe(0)
  const yaml = readFileSync(join(cwd, 'looprail.yaml'), 'utf8')
  expect(yaml).toContain('worker:  { adapter: claude-code, model: sonnet, permissions: safe }')
  expect(yaml).toContain('checker: { adapter: claude-code, model: haiku, permissions: safe }')
})

test('interactive: a real user choice of "strong" overrides the recommended tier in the generated yaml', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const code = await initAction(
    { cwd, template: 'fix-tests', agent: 'claude-code' },
    {
      detect: detected(['claude-code']),
      ask: async (question) => (question.includes('worker') ? 'strong' : 'cheap'),
      io: capture().io,
    })
  expect(code).toBe(0)
  const yaml = readFileSync(join(cwd, 'looprail.yaml'), 'utf8')
  // worker's real answer ("strong") is reflected, not its "medium" recommendation
  expect(yaml).toContain('worker:  { adapter: claude-code, model: opus, permissions: safe }')
  // checker's real answer ("cheap") happens to match its recommendation, but
  // it still came from the injected ask, not a bypass of it
  expect(yaml).toContain('checker: { adapter: claude-code, model: haiku, permissions: safe }')
})

test('interactive tier prompt offers the recommended tier as the first (default-on-enter) choice', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const seen: Record<string, string[]> = {}
  const code = await initAction(
    { cwd, template: 'fix-tests', agent: 'claude-code' },
    {
      detect: detected(['claude-code']),
      ask: async (question, choices) => {
        seen[question] = choices
        return choices[0]
      },
      io: capture().io,
    })
  expect(code).toBe(0)
  expect(seen['Model tier for worker (fixes the failing tests) (claude-code)?']).toEqual(['medium', 'strong', 'cheap'])
  expect(seen['Model tier for checker (anti-gaming critic) (claude-code)?']).toEqual(['cheap', 'strong', 'medium'])
})

test('refuses to overwrite without --force, overwrites with it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  writeFileSync(join(cwd, 'looprail.yaml'), 'existing')
  const { io, lines } = capture()
  const refused = await initAction(
    { cwd, template: 'fix-tests', agent: 'mock' }, { detect: detected([]), io })
  expect(refused).toBe(1)
  expect(lines.join('\n')).toContain('--force')
  const forced = await initAction(
    { cwd, template: 'fix-tests', agent: 'mock', force: true }, { detect: detected([]), io })
  expect(forced).toBe(0)
  expect(readFileSync(join(cwd, 'looprail.yaml'), 'utf8')).toContain('name: fix-tests')
})

test('no agents detected falls back to mock with a warning', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const { io, lines } = capture()
  const code = await initAction({ cwd, yes: true }, { detect: detected([]), io })
  expect(code).toBe(0)
  expect(lines.join('\n')).toContain('mock')
  expect(readFileSync(join(cwd, 'looprail.yaml'), 'utf8')).toContain('adapter: mock')
})

test('unknown template exits 1 listing valid names', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const { io, lines } = capture()
  const code = await initAction(
    { cwd, template: 'nope', agent: 'mock' }, { detect: detected([]), io })
  expect(code).toBe(1)
  expect(lines.join('\n')).toContain('fix-tests')
  expect(existsSync(join(cwd, 'looprail.yaml'))).toBe(false)
})

test('unknown --agent exits 1 listing valid adapters and scaffolds nothing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const { io, lines } = capture()
  const code = await initAction(
    { cwd, template: 'fix-tests', agent: 'gpt5' }, { detect: detected([]), io })
  expect(code).toBe(1)
  expect(lines.join('\n')).toContain('claude-code')
  expect(existsSync(join(cwd, 'looprail.yaml'))).toBe(false)
})

test('unknown --reviewer exits 1 listing valid adapters and scaffolds nothing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const { io, lines } = capture()
  const code = await initAction(
    { cwd, template: 'fix-tests', agent: 'mock', reviewer: 'gpt5' }, { detect: detected([]), io })
  expect(code).toBe(1)
  expect(lines.join('\n')).toContain('claude-code')
  expect(existsSync(join(cwd, 'looprail.yaml'))).toBe(false)
})

test('more than one adapter detected: reviewer auto-defaults to a different detected adapter', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const { io, lines } = capture()
  const code = await initAction(
    { cwd, yes: true }, { detect: detected(['claude-code', 'codex']), io })
  expect(code).toBe(0)
  const yaml = readFileSync(join(cwd, 'looprail.yaml'), 'utf8')
  expect(yaml).toContain('adapter: claude-code')
  expect(yaml).toContain('adapter: codex')
  expect(lines.join('\n')).toContain('worker: claude-code, reviewer: codex - independent verification')
})

test('only one adapter detected: reviewer falls back to the worker adapter', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const { io, lines } = capture()
  const code = await initAction(
    { cwd, yes: true }, { detect: detected(['claude-code']), io })
  expect(code).toBe(0)
  const yaml = readFileSync(join(cwd, 'looprail.yaml'), 'utf8')
  expect(yaml.match(/adapter: claude-code/g)).toHaveLength(2)
  expect(lines.join('\n')).not.toContain('independent verification')
})

test('--agent pins the worker: reviewer falls back to worker even with multiple adapters detected', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const { io, lines } = capture()
  const code = await initAction(
    { cwd, template: 'fix-tests', agent: 'claude-code' },
    { detect: detected(['claude-code', 'codex']), io })
  expect(code).toBe(0)
  const yaml = readFileSync(join(cwd, 'looprail.yaml'), 'utf8')
  expect(yaml.match(/adapter: claude-code/g)).toHaveLength(2)
  expect(yaml).not.toContain('adapter: codex')
  expect(lines.join('\n')).not.toContain('independent verification')
})

test('--reviewer pins a specific reviewer adapter, overriding auto-selection', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-'))
  const { io, lines } = capture()
  const code = await initAction(
    { cwd, template: 'fix-tests', agent: 'claude-code', reviewer: 'aider' },
    { detect: detected(['claude-code', 'codex']), io })
  expect(code).toBe(0)
  const yaml = readFileSync(join(cwd, 'looprail.yaml'), 'utf8')
  expect(yaml).toContain('adapter: claude-code')
  expect(yaml).toContain('adapter: aider')
  expect(yaml).not.toContain('adapter: codex')
  expect(lines.join('\n')).toContain('worker: claude-code, reviewer: aider - independent verification')
})

// Spec intake: init --from-spec scaffolds the self-planning implement-spec
// loop with the spec path threaded through planner and coverage critic.
test('--from-spec scaffolds implement-spec with the spec path and a plan gate', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-spec-'))
  writeFileSync(join(cwd, 'PRD.md'), '# req 1: do the thing')
  const { io } = capture()
  const code = await initAction(
    { cwd, fromSpec: 'PRD.md', agent: 'claude-code', yes: true },
    { detect: detected(['claude-code']), io })
  expect(code).toBe(0)
  const yaml = readFileSync(join(cwd, 'looprail.yaml'), 'utf8')
  expect(yaml).toContain('name: implement-spec')
  expect(yaml).toContain('PRD.md')
  expect(yaml).toContain('generates: graph')
  expect(yaml).toContain('Requirement coverage')
  expect(yaml).toContain('role: gate')
})

test('--from-spec fails fast when the spec file does not exist', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-spec2-'))
  const { io, lines } = capture()
  const code = await initAction(
    { cwd, fromSpec: 'missing.md', yes: true },
    { detect: detected(['claude-code']), io })
  expect(code).toBe(1)
  expect(lines.join('\n')).toContain('no file at')
})

test('--from-spec with a conflicting --template is rejected', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-spec3-'))
  writeFileSync(join(cwd, 'PRD.md'), 'spec')
  const { io, lines } = capture()
  const code = await initAction(
    { cwd, fromSpec: 'PRD.md', template: 'fix-tests', yes: true },
    { detect: detected(['claude-code']), io })
  expect(code).toBe(1)
  expect(lines.join('\n')).toContain('implement-spec')
})

// user config preferences: saved worker/reviewer become init's defaults,
// but only when actually installed.
test('config-preferred worker/reviewer are used as defaults when installed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-cfg-'))
  const { io } = capture()
  const code = await initAction(
    { cwd, template: 'fix-tests', yes: true },
    {
      detect: detected(['claude-code', 'codex', 'copilot-cli']),
      userConfig: { worker: 'codex', reviewer: 'copilot-cli' },
      io,
    })
  expect(code).toBe(0)
  const yaml = readFileSync(join(cwd, 'looprail.yaml'), 'utf8')
  expect(yaml).toContain('worker:  { adapter: codex')
  expect(yaml).toContain('adapter: copilot-cli')
})

test('a preferred adapter that is NOT installed is ignored (never scaffold the unrunnable)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-init-cfg2-'))
  const { io } = capture()
  const code = await initAction(
    { cwd, template: 'fix-tests', yes: true },
    { detect: detected(['claude-code']), userConfig: { worker: 'gemini' }, io })
  expect(code).toBe(0)
  expect(readFileSync(join(cwd, 'looprail.yaml'), 'utf8')).toContain('adapter: claude-code')
})
