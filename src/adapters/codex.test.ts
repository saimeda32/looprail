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
    expect(parseCodexJsonl(JSONL)).toEqual({
      output: 'FINAL ANSWER',
      tokens: 1000,
      inputTokens: 900,
      outputTokens: 100,
    })
  })

  test('preserves distinct input/output token counts, not just the combined total', () => {
    const jsonl = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"ANSWER"}}',
      '{"type":"turn.completed","usage":{"input_tokens":750,"output_tokens":250}}',
    ].join('\n')
    const parsed = parseCodexJsonl(jsonl)
    expect(parsed.inputTokens).toBe(750)
    expect(parsed.outputTokens).toBe(250)
    expect(parsed.tokens).toBe(1000)
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
    expect(calls[0].args).toEqual([
      'exec', '--json', 'do it', '-m', 'gpt-5', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request',
    ])
    expect(res).toMatchObject({ output: 'FINAL ANSWER', tokens: 1000, costUsd: 0 })
  })

  test('appends permission flags after -m, resolved via resolvePermissionArgs', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (_f, args) => {
      calls.push(args)
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    await createCodexAdapter({ exec }).invoke({ prompt: 'p', model: 'o3', permissions: 'standard' })
    expect(calls[0]).toEqual([
      'exec', '--json', 'p', '-m', 'o3', '--sandbox', 'workspace-write', '--ask-for-approval', 'never',
    ])
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

  test('estimates a mixed-rate cost from the pinned model + split input/output tokens, without touching costUsd', async () => {
    const exec: ExecFn = async () => ({ stdout: JSONL, stderr: '', exitCode: 0 })
    const loadPricingTable = () => ({
      'gpt-5-codex': { input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5 },
    })
    const res = await createCodexAdapter({ exec, loadPricingTable }).invoke({ prompt: 'p', model: 'gpt-5-codex' })
    // JSONL fixture: input_tokens 900, output_tokens 100.
    expect(res.costUsd).toBe(0)
    expect(res.estimatedCostUsd).toBeCloseTo(900 * 1.25e-6 + 100 * 1e-5)
  })

  test('leaves estimatedCostUsd undefined (never 0) when there is no resolvable model', async () => {
    const exec: ExecFn = async () => ({ stdout: JSONL, stderr: '', exitCode: 0 })
    const res = await createCodexAdapter({ exec, loadPricingTable: () => ({}) }).invoke({ prompt: 'p' })
    expect(res.costUsd).toBe(0)
    expect(res.estimatedCostUsd).toBeUndefined()
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
