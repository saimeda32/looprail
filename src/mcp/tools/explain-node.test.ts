import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { explainNodeHandler } from './explain-node.js'

const FIXTURE = `
name: t
goal: Ship the widget.
agents:
  a: { adapter: mock }
graph:
  plan: { role: planner, agent: a }
  do:   { role: executor, agent: a, after: plan }
  crit: { role: critic, agent: a, of: do, after: do, prompt: Be ruthless. }
rails: { max_iterations: 3, max_cost_usd: 1 }
`

function tmpCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-mcp-explain-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE)
  return cwd
}

test('shows the composed context with placeholders for upstream outputs', async () => {
  const cwd = tmpCwd()
  const result = await explainNodeHandler({ file: 'looprail.yaml', node: 'crit' }, { cwd })
  expect(result.isError).toBeFalsy()
  const text = (result.content[0] as { text: string }).text
  expect(text).toContain('Ship the widget.')
  expect(text).toContain('<output of "do" - placeholder>')
  expect(text).toContain('Be ruthless.')
  expect(text).toContain('VERDICT:')
})

test('an unknown node returns an error result listing valid ids', async () => {
  const cwd = tmpCwd()
  const result = await explainNodeHandler({ file: 'looprail.yaml', node: 'ghost' }, { cwd })
  expect(result.isError).toBe(true)
  expect((result.content[0] as { text: string }).text).toContain('plan, do, crit')
})

test('a missing loopfile returns an error result', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-mcp-explain-'))
  const result = await explainNodeHandler({ file: 'looprail.yaml', node: 'do' }, { cwd })
  expect(result.isError).toBe(true)
})
