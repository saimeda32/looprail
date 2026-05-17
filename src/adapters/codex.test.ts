import { describe, expect, test } from 'vitest'
import { createCodexAdapter, parseCodexJsonl } from './codex.js'
import type { ExecFn } from './cli-adapter.js'

const JSONL = [
  '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"FINAL ANSWER"}}',
  '{"type":"turn.completed","usage":{"input_tokens":900,"output_tokens":100}}',
].join('\n')

describe('parseCodexJsonl', () => {
  test('takes the last agent_message and the turn usage', () => {
    expect(parseCodexJsonl(JSONL)).toEqual({ output: 'FINAL ANSWER', tokens: 1000 })
  })

  test('falls back to raw text when no agent_message exists', () => {
    expect(parseCodexJsonl('not json at all\n')).toEqual({ output: 'not json at all' })
  })
})

describe('createCodexAdapter', () => {
  test('invokes codex exec --json with per-request -m model', async () => {
    const calls: { file: string; args: string[] }[] = []
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args })
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    const res = await createCodexAdapter({ exec }).invoke({ prompt: 'do it', model: 'gpt-5' })
    expect(calls[0].file).toBe('codex')
    expect(calls[0].args).toEqual(['exec', '--json', 'do it', '-m', 'gpt-5'])
    expect(res).toMatchObject({ output: 'FINAL ANSWER', tokens: 1000, costUsd: 0 })
  })
})
