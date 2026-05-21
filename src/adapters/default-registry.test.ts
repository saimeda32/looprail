import { expect, test } from 'vitest'
import { createCliMockAdapter, createDefaultRegistry } from './default-registry.js'

test('registers mock and all real adapters under their loopfile names', () => {
  const reg = createDefaultRegistry()
  for (const name of ['mock', 'claude-code', 'codex', 'aider', 'copilot-cli', 'shell']) {
    expect(reg.get(name).name).toBe(name)
  }
})

test('cli mock auto-passes verifying prompts and echoes the rest', async () => {
  const mock = createCliMockAdapter()
  const verdict = await mock.invoke({ prompt: 'critique this\nVERDICT: pass|fail\n...' })
  expect(verdict.output).toContain('VERDICT: pass')
  expect(verdict.output).toContain('SCORE: 1')
  const echo = await mock.invoke({ prompt: 'build the thing' })
  expect(echo.output).toContain('[mock]')
  expect(echo.costUsd).toBe(0)
})
