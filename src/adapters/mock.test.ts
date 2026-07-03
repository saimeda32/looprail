import { describe, expect, test } from 'vitest'
import { MockAdapter } from './mock.js'
import { createRegistry } from './registry.js'

describe('MockAdapter', () => {
  test('returns scripted steps in order and records calls', async () => {
    const mock = new MockAdapter([
      { output: 'plan: do X', costUsd: 0.01 },
      { output: 'VERDICT: pass\nEVIDENCE: ok' },
    ])
    const first = await mock.invoke({ prompt: 'make a plan' })
    expect(first.output).toBe('plan: do X')
    expect(first.costUsd).toBe(0.01)
    const second = await mock.invoke({ prompt: 'critique' })
    expect(second.output).toContain('VERDICT: pass')
    expect(mock.calls.map((c) => c.prompt)).toEqual(['make a plan', 'critique'])
  })

  test('match routes by prompt content regardless of order', async () => {
    const mock = new MockAdapter([
      { match: /critique/i, output: 'VERDICT: fail\nEVIDENCE: gap' },
      { match: /plan/i, output: 'the plan' },
    ])
    expect((await mock.invoke({ prompt: 'write a plan' })).output).toBe('the plan')
    expect((await mock.invoke({ prompt: 'Critique this' })).output).toContain('fail')
  })

  test('throws when script is exhausted', async () => {
    const mock = new MockAdapter([])
    await expect(mock.invoke({ prompt: 'x' })).rejects.toThrow(/exhausted/)
  })

  test('scripted chunks are delivered to onChunk, in order, before the promise resolves', async () => {
    const mock = new MockAdapter([{ output: 'final answer', chunks: ['final ', 'answer'] }])
    const seen: string[] = []
    const result = await mock.invoke({ prompt: 'go' }, (c) => seen.push(c))
    expect(seen).toEqual(['final ', 'answer'])
    expect(result.output).toBe('final answer')
  })

  test('a step with no chunks streams nothing even when onChunk is provided', async () => {
    const mock = new MockAdapter([{ output: 'no streaming here' }])
    const seen: string[] = []
    await mock.invoke({ prompt: 'go' }, (c) => seen.push(c))
    expect(seen).toEqual([])
  })
})

describe('registry', () => {
  test('registers and resolves; throws on unknown', () => {
    const reg = createRegistry()
    const mock = new MockAdapter([])
    reg.register(mock)
    expect(reg.get('mock')).toBe(mock)
    expect(() => reg.get('claude-code')).toThrow(/claude-code/)
  })
})
