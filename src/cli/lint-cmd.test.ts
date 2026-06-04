import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { lintAction } from './lint-cmd.js'

const CLEAN = `
name: t
goal: g
agents:
  a: { adapter: mock }
graph:
  do:   { role: executor, agent: a }
  crit: { role: critic, agent: a, of: do, after: do }
rails: { max_iterations: 3, max_cost_usd: 1 }
`

const NO_VERIFIER = CLEAN.replace('  crit: { role: critic, agent: a, of: do, after: do }\n', '')

function capture() {
  const lines: string[] = []
  return { io: { out: (l: string) => lines.push(l) }, lines }
}

function write(content: string): { cwd: string; file: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-lint-'))
  writeFileSync(join(cwd, 'looprail.yaml'), content)
  return { cwd, file: 'looprail.yaml' }
}

test('clean loopfile exits 0', async () => {
  const { cwd, file } = write(CLEAN)
  const { io, lines } = capture()
  expect(await lintAction(file, { cwd }, io)).toBe(0)
  expect(lines.join('\n')).toContain('lint clean')
})

test('error finding prints its L-code and exits 1', async () => {
  const { cwd, file } = write(NO_VERIFIER)
  const { io, lines } = capture()
  expect(await lintAction(file, { cwd }, io)).toBe(1)
  expect(lines.join('\n')).toContain('L001')
})

test('unreadable or unparseable file exits 1 with the parser message', async () => {
  const { cwd } = write('name: only-a-name')
  const { io, lines } = capture()
  expect(await lintAction('looprail.yaml', { cwd }, io)).toBe(1)
  expect(lines.join('\n')).toContain('missing required field')
  expect(await lintAction('nope.yaml', { cwd }, io)).toBe(1)
})
