import { expect, test } from 'vitest'
import { InfraError, invokeWithRetry, isInfraError, isRateLimitError, RateLimitError } from './retry.js'
import type { Adapter } from '../core/types.js'

function flaky(failures: number, message = 'ETIMEDOUT') {
  let n = 0
  const adapter: Adapter = {
    name: 'flaky',
    async invoke() {
      n++
      if (n <= failures) throw new Error(message)
      return { output: 'ok', costUsd: 0, tokens: 0, durationMs: 1 }
    },
  }
  return { adapter, calls: () => n }
}

test('retries transient failures with 1s/4s backoff', async () => {
  const slept: number[] = []
  const { adapter, calls } = flaky(2)
  const res = await invokeWithRetry(adapter, { prompt: 'p' }, {
    sleep: async (ms) => { slept.push(ms) },
  })
  expect(res.output).toBe('ok')
  expect(calls()).toBe(3)
  expect(slept).toEqual([1000, 4000])
})

test('rethrows the last error after retries are exhausted', async () => {
  const { adapter, calls } = flaky(5)
  await expect(invokeWithRetry(adapter, { prompt: 'p' }, { sleep: async () => {} }))
    .rejects.toThrow(/ETIMEDOUT/)
  expect(calls()).toBe(3) // initial attempt + 2 retries
})

test('auth errors are never retried and carry a doctor hint', async () => {
  const { adapter, calls } = flaky(5, 'HTTP 401: please login again')
  await expect(invokeWithRetry(adapter, { prompt: 'p' }, { sleep: async () => {} }))
    .rejects.toThrow(InfraError)
  await expect(invokeWithRetry(adapter, { prompt: 'p' }, { sleep: async () => {} }))
    .rejects.toThrow(/looprail doctor/)
  expect(calls()).toBe(2) // one attempt per invokeWithRetry call, zero retries
})

test('isInfraError matches auth shapes only', () => {
  expect(isInfraError('HTTP 401 Unauthorized')).toBe(true)
  expect(isInfraError('please run `claude login`')).toBe(true)
  expect(isInfraError('auth token expired')).toBe(true)
  expect(isInfraError('logged out')).toBe(true)
  expect(isInfraError('rate limit exceeded')).toBe(false)
  expect(isInfraError('ECONNRESET')).toBe(false)
})

test('isRateLimitError matches only clearly rate-limit-shaped errors', () => {
  expect(isRateLimitError('HTTP 429 Too Many Requests')).toBe(true)
  expect(isRateLimitError('claude-code exited 1: rate limit exceeded, retry later')).toBe(true)
  expect(isRateLimitError('RateLimitError: requests per minute exhausted')).toBe(true)
  expect(isRateLimitError('overloaded_error: Overloaded')).toBe(true)
  expect(isRateLimitError('insufficient quota for this request')).toBe(true)
  expect(isRateLimitError('Claude AI usage limit reached|1751846400')).toBe(true)
  expect(isRateLimitError('RESOURCE_EXHAUSTED')).toBe(true)
  expect(isRateLimitError('ETIMEDOUT')).toBe(false)
  expect(isRateLimitError('SyntaxError: unexpected token')).toBe(false)
  expect(isRateLimitError('4 tests failed, 2 over the line-length limit')).toBe(false)
})

test('rate-limit errors still spend the full retry budget, then surface as RateLimitError with the original error as cause', async () => {
  const { adapter, calls } = flaky(5, 'HTTP 429 Too Many Requests')
  try {
    await invokeWithRetry(adapter, { prompt: 'p' }, { sleep: async () => {} })
    throw new Error('expected invokeWithRetry to throw')
  } catch (err) {
    expect(err).toBeInstanceOf(RateLimitError)
    expect((err as Error).message).toMatch(/429/)
    expect(((err as Error).cause as Error).message).toBe('HTTP 429 Too Many Requests')
  }
  expect(calls()).toBe(3) // initial attempt + 2 retries - never short-circuited
})

test('a transiently rate-limited adapter that recovers within the retry budget never surfaces a RateLimitError', async () => {
  const { adapter, calls } = flaky(1, 'HTTP 429 Too Many Requests')
  const res = await invokeWithRetry(adapter, { prompt: 'p' }, { sleep: async () => {} })
  expect(res.output).toBe('ok')
  expect(calls()).toBe(2)
})

test('auth shapes keep InfraError precedence even when the text also mentions a rate limit', async () => {
  const { adapter } = flaky(5, 'HTTP 401 unauthorized (rate limit info unavailable)')
  await expect(invokeWithRetry(adapter, { prompt: 'p' }, { sleep: async () => {} }))
    .rejects.toThrow(InfraError)
})

test('forwards onChunk straight through to the adapter on every attempt', async () => {
  const seenChunks: string[] = []
  let n = 0
  const adapter: Adapter = {
    name: 'streamy',
    async invoke(_req, onChunk) {
      n++
      onChunk?.(`attempt-${n} `)
      if (n === 1) throw new Error('ETIMEDOUT')
      return { output: 'ok', costUsd: 0, tokens: 0, durationMs: 1 }
    },
  }
  const res = await invokeWithRetry(adapter, { prompt: 'p' }, { sleep: async () => {} }, (c) => seenChunks.push(c))
  expect(res.output).toBe('ok')
  expect(seenChunks).toEqual(['attempt-1 ', 'attempt-2 '])
})

test('forwards onPermission straight through to the adapter', async () => {
  const adapter: Adapter = {
    name: 'asks-permission',
    async invoke(_req, _onChunk, onPermission) {
      const result = await onPermission?.({ question: 'allow write?', answer: (a) => (a ? 'y\n' : 'n\n') })
      return { output: result && (result === true || result.approved) ? 'approved-path' : 'denied-path', costUsd: 0, tokens: 0, durationMs: 1 }
    },
  }
  const res = await invokeWithRetry(adapter, { prompt: 'p' }, { sleep: async () => {} }, undefined,
    async (req) => { expect(req.question).toBe('allow write?'); return true })
  expect(res.output).toBe('approved-path')
})
