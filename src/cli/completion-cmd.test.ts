import { expect, test } from 'vitest'
import { buildProgram } from './index.js'
import { bashCompletion, completionAction, fishCompletion, zshCompletion } from './completion-cmd.js'

test('zsh completion carries every command with its description', () => {
  const program = buildProgram()
  const script = zshCompletion(program)
  for (const cmd of ['run', 'init', 'why', 'config', 'ledger', 'spend']) {
    expect(script).toContain(`'${cmd}:`)
  }
  expect(script).toContain('#compdef looprail')
})

test('bash and fish completions carry the command names', () => {
  const program = buildProgram()
  expect(bashCompletion(program)).toContain('run')
  expect(bashCompletion(program)).toContain('complete -F _looprail looprail')
  expect(fishCompletion(program)).toContain("-a 'demo'")
})

test('unknown shell prints usage and exits 1', () => {
  const lines: string[] = []
  expect(completionAction('powershell', buildProgram(), { io: { out: (l) => lines.push(l) } })).toBe(1)
  expect(lines.join('\n')).toContain('zsh|bash|fish')
})
