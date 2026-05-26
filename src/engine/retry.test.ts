import { expect, test } from 'vitest'
import { InfraError, invokeWithRetry, isInfraError } from './retry.js'
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
