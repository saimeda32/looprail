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
  expect(asked).toHaveLength(2)
  expect(readFileSync(join(cwd, 'looprail.yaml'), 'utf8')).toContain('adapter: codex')
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
