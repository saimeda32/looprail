import { expect, test } from 'vitest'
import { detectAgents } from './detect.js'
import type { ExecFn } from './cli-adapter.js'

const onlyClaude: ExecFn = async (file, args) => {
  if (file === '/bin/sh' && args[1]?.startsWith('command -v ')) {
    const bin = args[1].slice('command -v '.length)
    return bin === 'claude'
      ? { stdout: '/usr/local/bin/claude\n', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 1 }
  }
  if (file === 'claude' && args[0] === '--version') {
    return { stdout: '1.0.35 (Claude Code)\n', stderr: '', exitCode: 0 }
  }
  return { stdout: '', stderr: '', exitCode: 1 }
}

test('detects installed agents with versions; marks the rest missing with fix hints', async () => {
  const agents = await detectAgents(onlyClaude)
  expect(agents.map((a) => a.adapter)).toEqual(['claude-code', 'codex', 'aider', 'copilot-cli', 'gemini', 'opencode', 'ollama'])
  expect(agents.find((a) => a.name === 'claude')).toMatchObject({
    available: true, version: '1.0.35 (Claude Code)',
  })
  const codex = agents.find((a) => a.name === 'codex')!
  expect(codex.available).toBe(false)
  expect(codex.fixHint).toContain('codex')
  const gemini = agents.find((a) => a.name === 'gemini')!
  expect(gemini.available).toBe(false)
  expect(gemini.fixHint).toContain('@google/gemini-cli')
  const opencode = agents.find((a) => a.name === 'opencode')!
  expect(opencode.available).toBe(false)
  expect(opencode.fixHint).toContain('opencode auth login')
  const ollama = agents.find((a) => a.name === 'ollama')!
  expect(ollama.available).toBe(false)
  expect(ollama.fixHint).toContain('ollama.com')
})

test('version lookup failure still reports available (version stays undefined)', async () => {
  const noVersion: ExecFn = async (file) =>
    file === '/bin/sh'
      ? { stdout: '/bin/x\n', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: 'boom', exitCode: 1 }
  const agents = await detectAgents(noVersion)
  expect(agents.every((a) => a.available)).toBe(true)
  expect(agents[0].version).toBeUndefined()
})
