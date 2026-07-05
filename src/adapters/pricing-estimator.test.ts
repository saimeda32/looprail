import { describe, expect, test } from 'vitest'
import { createPricingEstimator } from './pricing-estimator.js'
import type { PricingTable } from '../core/pricing.js'

const TABLE: PricingTable = {
  'claude-sonnet-5': { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 },
}

describe('createPricingEstimator', () => {
  test('computes a mixed-rate estimate for a pinned AgentRequest.model', async () => {
    const estimator = createPricingEstimator({ loadTable: () => TABLE })
    const est = await estimator(
      { prompt: 'p', model: 'claude-sonnet-5' },
      { output: 'hi', inputTokens: 1000, outputTokens: 500 },
    )
    expect(est).toBeCloseTo(1000 * 2e-6 + 500 * 1e-5)
  })

  test('falls back to the parser-resolved model when AgentRequest.model is "auto"', async () => {
    const estimator = createPricingEstimator({ loadTable: () => TABLE })
    const est = await estimator(
      { prompt: 'p', model: 'auto' },
      { output: 'hi', inputTokens: 100, outputTokens: 50, resolvedModel: 'claude-sonnet-5' },
    )
    expect(est).toBeCloseTo(100 * 2e-6 + 50 * 1e-5)
  })

  test('falls back to the parser-resolved model when AgentRequest.model is omitted', async () => {
    const estimator = createPricingEstimator({ loadTable: () => TABLE })
    const est = await estimator(
      { prompt: 'p' },
      { output: 'hi', inputTokens: 10, outputTokens: 5, resolvedModel: 'claude-sonnet-5' },
    )
    expect(est).toBeCloseTo(10 * 2e-6 + 5 * 1e-5)
  })

  test('returns undefined (never 0) when no model key is resolvable', async () => {
    const estimator = createPricingEstimator({ loadTable: () => TABLE })
    const est = await estimator({ prompt: 'p' }, { output: 'hi', inputTokens: 10, outputTokens: 5 })
    expect(est).toBeUndefined()
  })

  test('returns undefined (never 0) when the resolved model is absent from the table', async () => {
    const estimator = createPricingEstimator({ loadTable: () => TABLE })
    const est = await estimator(
      { prompt: 'p', model: 'some-unknown-model' },
      { output: 'hi', inputTokens: 10, outputTokens: 5 },
    )
    expect(est).toBeUndefined()
  })

  test('returns undefined when there are no split token counts to price', async () => {
    const estimator = createPricingEstimator({ loadTable: () => TABLE })
    const est = await estimator({ prompt: 'p', model: 'claude-sonnet-5' }, { output: 'hi' })
    expect(est).toBeUndefined()
  })

  test('supports an async loadTable (e.g. the real fetch/cache module)', async () => {
    const estimator = createPricingEstimator({ loadTable: async () => TABLE })
    const est = await estimator(
      { prompt: 'p', model: 'claude-sonnet-5' },
      { output: 'hi', inputTokens: 1, outputTokens: 1 },
    )
    expect(est).toBeCloseTo(2e-6 + 1e-5)
  })
})
