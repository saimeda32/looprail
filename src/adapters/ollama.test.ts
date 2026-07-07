import { describe, expect, test } from 'vitest'
import { createOllamaAdapter, estimateTokens } from './ollama.js'
import type { ExecFn } from './cli-adapter.js'

describe('estimateTokens', () => {
  test('rounds chars/4 up, and an empty string is genuinely zero', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('x'.repeat(400))).toBe(100)
  })
})

describe('createOllamaAdapter', () => {
  test('invokes ollama run <model> with the prompt piped on stdin, not as an argv token', async () => {
    const calls: { file: string; args: string[]; input?: string }[] = []
    const exec: ExecFn = async (file, args, opts = {}) => {
      calls.push({ file, args, input: opts.input })
      return { stdout: 'hello from llama\n', stderr: '', exitCode: 0 }
    }
    const res = await createOllamaAdapter({ exec }).invoke({ prompt: 'say hi', model: 'llama3' })
    expect(calls[0].file).toBe('ollama')
    expect(calls[0].args).toEqual(['run', 'llama3'])
    expect(calls[0].input).toBe('say hi')
    expect(res.output).toBe('hello from llama')
  })

  test('refuses to run without a model - ollama has no default to fall back to', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: '', exitCode: 0 })
    await expect(createOllamaAdapter({ exec }).invoke({ prompt: 'p' }))
      .rejects.toThrow(/needs a model.*agents\.<name>\.model/s)
  })

  test('costUsd is genuinely 0 (real, local inference) and estimatedCostUsd stays undefined - never an estimated-zero', async () => {
    const exec: ExecFn = async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })
    const res = await createOllamaAdapter({ exec }).invoke({ prompt: 'p', model: 'llama3' })
    expect(res.costUsd).toBe(0)
    expect(res.estimatedCostUsd).toBeUndefined()
  })

  test('accounts tokens as chars/4 estimates on both sides - ollama\'s plain output has no usage envelope to parse', async () => {
    const exec: ExecFn = async () => ({ stdout: 'y'.repeat(40), stderr: '', exitCode: 0 })
    const res = await createOllamaAdapter({ exec }).invoke({ prompt: 'x'.repeat(80), model: 'llama3' })
    expect(res.inputTokens).toBe(20)   // 80 chars / 4
    expect(res.outputTokens).toBe(10)  // 40 chars / 4
    expect(res.tokens).toBe(30)
  })

  test('permission presets contribute no flags (no tool surface exists), but the raw escape hatch still reaches argv', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (_file, args) => {
      calls.push(args)
      return { stdout: 'ok', stderr: '', exitCode: 0 }
    }
    const adapter = createOllamaAdapter({ exec })
    await adapter.invoke({ prompt: 'p', model: 'llama3', permissions: 'full' })
    expect(calls[0]).toEqual(['run', 'llama3'])
    await adapter.invoke({
      prompt: 'p', model: 'llama3', permissions: { raw: { ollama: ['--format', 'json'] } },
    })
    expect(calls[1]).toEqual(['run', 'llama3', '--format', 'json'])
  })

  test('streams raw stdout chunks straight through - the output is plain prose, not a wire format needing a line handler', async () => {
    const chunks: string[] = []
    const exec: ExecFn = async (_file, _args, opts = {}) => {
      opts.onChunk?.('hel')
      opts.onChunk?.('lo')
      return { stdout: 'hello', stderr: '', exitCode: 0 }
    }
    const res = await createOllamaAdapter({ exec }).invoke(
      { prompt: 'p', model: 'llama3' }, (c) => chunks.push(c),
    )
    expect(chunks).toEqual(['hel', 'lo'])
    expect(res.output).toBe('hello')
  })

  test('throws with the stderr tail on a nonzero exit (e.g. a model that was never pulled)', async () => {
    const exec: ExecFn = async () => ({
      stdout: '', stderr: "Error: model 'llama3' not found, try pulling it first", exitCode: 1,
    })
    await expect(createOllamaAdapter({ exec }).invoke({ prompt: 'p', model: 'llama3' }))
      .rejects.toThrow(/ollama exited 1: .*try pulling it first/s)
  })

  test('passes the request timeout through to the subprocess', async () => {
    let seenTimeout: number | undefined
    const exec: ExecFn = async (_file, _args, opts = {}) => {
      seenTimeout = opts.timeoutMs
      return { stdout: 'ok', stderr: '', exitCode: 0 }
    }
    await createOllamaAdapter({ exec }).invoke({ prompt: 'p', model: 'llama3', timeoutMs: 1234 })
    expect(seenTimeout).toBe(1234)
  })
})
