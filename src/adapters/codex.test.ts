import { describe, expect, test } from 'vitest'
import { codexStreamLine, createCodexAdapter, parseCodexJsonl } from './codex.js'
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

  test('streams reasoning and each agent_message live, before the node finishes', async () => {
    const chunks: string[] = []
    const exec: ExecFn = async (_file, _args, opts = {}) => {
      opts.onChunk?.(JSONL)
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    const res = await createCodexAdapter({ exec }).invoke({ prompt: 'p' }, (c) => chunks.push(c))
    expect(chunks).toEqual(['[reasoning] thinking', 'partial', 'FINAL ANSWER'])
    expect(res.output).toBe('FINAL ANSWER')
  })
})

describe('codexStreamLine', () => {
  test('surfaces an agent_message item verbatim', () => {
    expect(codexStreamLine('{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}')).toBe('hi')
  })

  test('surfaces a reasoning item with a readable prefix', () => {
    expect(codexStreamLine('{"type":"item.completed","item":{"type":"reasoning","text":"because"}}')).toBe('[reasoning] because')
  })

  test('ignores item.started and other item types', () => {
    expect(codexStreamLine('{"type":"item.started","item":{"type":"agent_message","text":"hi"}}')).toBeNull()
    expect(codexStreamLine('{"type":"item.completed","item":{"type":"command_execution","text":"ls"}}')).toBeNull()
  })

  test('returns null for unparseable lines instead of throwing', () => {
    expect(codexStreamLine('not json')).toBeNull()
  })
})
