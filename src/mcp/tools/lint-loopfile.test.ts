import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { lintLoopfileHandler } from './lint-loopfile.js'

const OK = `
name: demo
goal: g
agents:
  worker: { adapter: mock }
graph:
  do:   { role: executor, agent: worker }
  test: { role: tester, after: do, run: "true", expect: "exit 0" }
rails:
  max_iterations: 2
  max_cost_usd: 1
`

const NO_VERIFIER = `
name: demo
goal: g
agents:
  worker: { adapter: mock }
graph:
  do: { role: executor, agent: worker }
rails:
  max_iterations: 2
  max_cost_usd: 1
`

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'lr-mcp-lint-'))
}

test('a clean loopfile returns an empty findings list', async () => {
  const cwd = tmpCwd()
  writeFileSync(join(cwd, 'ok.yaml'), OK)
  const result = await lintLoopfileHandler({ file: 'ok.yaml' }, { cwd })
  expect(result.isError).toBeFalsy()
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.findings).toEqual([])
})

test('lint errors are returned as findings, not thrown', async () => {
  const cwd = tmpCwd()
  writeFileSync(join(cwd, 'bad.yaml'), NO_VERIFIER)
  const result = await lintLoopfileHandler({ file: 'bad.yaml' }, { cwd })
  expect(result.isError).toBeFalsy()
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.findings.some((f: { rule: string }) => f.rule === 'L001')).toBe(true)
})

test('a missing file returns an error result instead of throwing', async () => {
  const cwd = tmpCwd()
  const result = await lintLoopfileHandler({ file: 'nope.yaml' }, { cwd })
  expect(result.isError).toBe(true)
  expect((result.content[0] as { text: string }).text).toContain('nope.yaml')
})

test('an unparseable loopfile returns an error result instead of throwing', async () => {
  const cwd = tmpCwd()
  writeFileSync(join(cwd, 'broken.yaml'), 'not: a loopfile\n')
  const result = await lintLoopfileHandler({ file: 'broken.yaml' }, { cwd })
  expect(result.isError).toBe(true)
})
