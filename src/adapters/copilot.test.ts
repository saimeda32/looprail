import { describe, expect, test } from 'vitest'
import { copilotStreamLine, createCopilotAdapter, parseCopilotJsonl } from './copilot.js'
import type { ExecFn } from './cli-adapter.js'

const JSONL = [
  JSON.stringify({ type: 'session.tools_updated', data: { model: 'claude-sonnet-5' } }),
  JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'h' } }),
  JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'i' } }),
  JSON.stringify({ type: 'assistant.message', data: { content: 'hi', outputTokens: 4 } }),
  JSON.stringify({ type: 'result', exitCode: 0 }),
].join('\n')

describe('parseCopilotJsonl', () => {
  test('takes the final assistant.message content and its output token count', () => {
    expect(parseCopilotJsonl(JSONL)).toEqual({ output: 'hi', tokens: 4 })
  })

  test('falls back to raw text when no assistant.message line exists', () => {
    expect(parseCopilotJsonl('not json at all\n')).toEqual({ output: 'not json at all' })
  })

  test('ignores unparseable lines instead of throwing', () => {
    expect(parseCopilotJsonl('garbage\n' + JSONL)).toEqual({ output: 'hi', tokens: 4 })
  })
})

describe('copilotStreamLine', () => {
  test('surfaces a message_delta chunk verbatim', () => {
    const line = JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'lo' } })
    expect(copilotStreamLine(line)).toBe('lo')
  })

  test('ignores non-delta lines', () => {
    expect(copilotStreamLine(JSON.stringify({ type: 'assistant.message', data: { content: 'hi' } }))).toBeNull()
    expect(copilotStreamLine(JSON.stringify({ type: 'session.tools_updated' }))).toBeNull()
  })

  test('returns null for unparseable lines instead of throwing', () => {
    expect(copilotStreamLine('not json')).toBeNull()
  })
})

describe('createCopilotAdapter', () => {
  test('invokes gh copilot with JSON output and --allow-all-tools for non-interactive use', async () => {
    const calls: { file: string; args: string[] }[] = []
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args })
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    const res = await createCopilotAdapter({ exec }).invoke({ prompt: 'say hi' })
    expect(calls[0].file).toBe('gh')
    expect(calls[0].args).toEqual([
      'copilot', '-p', 'say hi', '--output-format', 'json', '--allow-all-tools',
    ])
    expect(res).toMatchObject({ output: 'hi', tokens: 4, costUsd: 0 })
  })

  test('appends --model when the request specifies one', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (_file, args) => {
      calls.push(args)
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    await createCopilotAdapter({ exec }).invoke({ prompt: 'say hi', model: 'gpt-5.4' })
    expect(calls[0]).toEqual([
      'copilot', '-p', 'say hi', '--output-format', 'json', '--allow-all-tools', '--model', 'gpt-5.4',
    ])
  })

  test('omits --model when the request has none', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (_file, args) => {
      calls.push(args)
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    await createCopilotAdapter({ exec }).invoke({ prompt: 'say hi' })
    expect(calls[0]).toEqual(['copilot', '-p', 'say hi', '--output-format', 'json', '--allow-all-tools'])
  })

  test('streams each token delta live, before the node finishes', async () => {
    const chunks: string[] = []
    const exec: ExecFn = async (_file, _args, opts = {}) => {
      opts.onChunk?.(JSONL)
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    const res = await createCopilotAdapter({ exec }).invoke({ prompt: 'p' }, (c) => chunks.push(c))
    expect(chunks).toEqual(['h', 'i'])
    expect(res.output).toBe('hi')
  })
})
