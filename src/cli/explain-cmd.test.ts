import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { explainAction } from './explain-cmd.js'

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

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-explain-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE)
  const lines: string[] = []
  return { cwd, io: { out: (l: string) => lines.push(l) }, lines }
}

test('explain prints the exact composed context with placeholders', async () => {
  const { cwd, io, lines } = setup()
  expect(await explainAction('looprail.yaml', 'crit', { cwd }, io)).toBe(0)
  const text = lines.join('\n')
  expect(text).toContain('Ship the widget.')                 // goal
  expect(text).toContain('<output of "do" - placeholder>')   // of-target placeholder
  expect(text).toContain('Be ruthless.')                     // node prompt
  expect(text).toContain('VERDICT:')                         // verifying-role format block
})

test('unknown node exits 1 listing valid ids', async () => {
  const { cwd, io, lines } = setup()
  expect(await explainAction('looprail.yaml', 'ghost', { cwd }, io)).toBe(1)
  expect(lines.join('\n')).toContain('plan, do, crit')
})
