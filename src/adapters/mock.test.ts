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

  test('a step with no promptPermission behaves exactly as today, even when onPermission is provided', async () => {
    const mock = new MockAdapter([{ output: 'plain result' }])
    const onPermission = () => {
      throw new Error('onPermission must not be called for a step with no promptPermission')
    }
    const result = await mock.invoke({ prompt: 'go' }, undefined, onPermission)
    expect(result.output).toBe('plain result')
  })

  test('a step with promptPermission fires onPermission and blocks the resolved output until answered', async () => {
    const mock = new MockAdapter([
      { output: 'did the risky thing', promptPermission: { question: 'delete file.txt?' } },
    ])
    let resolveAnswer!: (v: boolean) => void
    const answerPromise = new Promise<boolean>((resolve) => {
      resolveAnswer = resolve
    })
    const seenQuestions: string[] = []
    const onPermission = async (req: { question: string }) => {
      seenQuestions.push(req.question)
      return answerPromise
    }

    let settled = false
    const invocation = mock.invoke({ prompt: 'go' }, undefined, onPermission).then((r) => {
      settled = true
      return r
    })

    // Give the microtask queue a chance to run; invoke() must not have
    // resolved yet because onPermission's promise is still pending.
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(seenQuestions).toEqual(['delete file.txt?'])

    resolveAnswer(true)
    const result = await invocation
    expect(settled).toBe(true)
    expect(result.output).toBe('did the risky thing')
  })

  test('the answer received by onPermission is recorded on the mock, proving it reached the simulated subprocess', async () => {
    const mock = new MockAdapter([
      { output: 'ok', promptPermission: { question: 'proceed?' } },
    ])
    await mock.invoke({ prompt: 'go' }, undefined, async () => ({ approved: true, feedback: 'looks fine' }))
    expect(mock.permissionAnswers).toEqual([{ approved: true, feedback: 'looks fine' }])
  })

  test('a denied permission answer is still recorded and invoke still resolves (no throw on denial)', async () => {
    const mock = new MockAdapter([
      { output: 'ok', promptPermission: { question: 'proceed?' } },
    ])
    const result = await mock.invoke({ prompt: 'go' }, undefined, async () => false)
    expect(mock.permissionAnswers).toEqual([{ approved: false, feedback: undefined }])
    expect(result.output).toBe('ok')
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
