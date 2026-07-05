import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { estimateCostUsd, lookupModelPricing, loadPricingTable } from './pricing.js'
import type { FetchFn } from './pricing.js'

let cacheDir: string
let cachePath: string

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'looprail-pricing-test-'))
  cachePath = join(cacheDir, 'pricing-cache.json')
})

afterEach(() => {
  // mkdtempSync dirs are unique per test - nothing to clean up across tests,
  // and the OS temp dir is reaped independently. Left intentionally empty.
})

const samplePayload = {
  'claude-sonnet-5': {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 1e-5,
    cache_creation_input_token_cost: 2.5e-6,
    cache_read_input_token_cost: 2e-7,
  },
  'gpt-5-codex': {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
  },
}

function okFetch(body: unknown): FetchFn {
  return async () => ({ ok: true, status: 200, json: async () => body })
}

function failingFetch(): FetchFn {
  return async () => { throw new Error('network down') }
}

function non200Fetch(): FetchFn {
  return async () => ({ ok: false, status: 500, json: async () => ({}) })
}

test('fetch success populates the on-disk cache', async () => {
  const table = await loadPricingTable({ fetchFn: okFetch(samplePayload), cachePath })
  expect(table['claude-sonnet-5'].input_cost_per_token).toBeCloseTo(2e-6)
  const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
  expect(cached['gpt-5-codex'].output_cost_per_token).toBeCloseTo(1e-5)
})

test('fetch failure falls back to the on-disk cache', async () => {
  // Seed the cache as if a prior successful fetch already wrote it.
  writeFileSync(cachePath, JSON.stringify(samplePayload))
  const table = await loadPricingTable({ fetchFn: failingFetch(), cachePath })
  expect(table['claude-sonnet-5'].output_cost_per_token).toBeCloseTo(1e-5)
})

test('non-200 response also falls back to the on-disk cache', async () => {
  writeFileSync(cachePath, JSON.stringify(samplePayload))
  const table = await loadPricingTable({ fetchFn: non200Fetch(), cachePath })
  expect(table['gpt-5-codex'].input_cost_per_token).toBeCloseTo(1.25e-6)
})

test('both fetch and cache fail returns an empty table, never throws, never fabricates $0 model entries', async () => {
  const table = await loadPricingTable({ fetchFn: failingFetch(), cachePath })
  expect(table).toEqual({})
  expect(lookupModelPricing(table, 'claude-sonnet-5')).toBeNull()
})

test('known model computes mixed input/output cost at their real separate rates', () => {
  const cost = estimateCostUsd(samplePayload, 'claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 500_000 })
  // 1,000,000 * 2e-6 + 500,000 * 1e-5 = 2.0 + 5.0
  expect(cost).toBeCloseTo(7.0)
})

test('unknown model returns null, never a silent $0', () => {
  const cost = estimateCostUsd(samplePayload, 'some-model-nobody-has-heard-of', { inputTokens: 1000, outputTokens: 1000 })
  expect(cost).toBeNull()
})

test('lookupModelPricing returns the raw per-token rates for a known model', () => {
  const pricing = lookupModelPricing(samplePayload, 'gpt-5-codex')
  expect(pricing).toMatchObject({ inputCostPerToken: 1.25e-6, outputCostPerToken: 1e-5 })
})

test('lookupModelPricing returns null for an absent model, not a zeroed-out record', () => {
  expect(lookupModelPricing(samplePayload, 'absolutely-not-in-the-table')).toBeNull()
})

// Confirmed live: copilot-cli's own CLI argument requires "claude-opus-4.8"
// (dot), but LiteLLM's real table keys the same model "claude-opus-4-8"
// (dash) - a naming-convention mismatch, not a genuinely missing model.
// Every opus-4.8 node silently got neither a real cost nor an estimate
// until this was fixed.
test('lookupModelPricing finds a dash-keyed model when queried with its dot-separated CLI spelling', () => {
  const table = { 'claude-opus-4-8': { input_cost_per_token: 1.5e-5, output_cost_per_token: 7.5e-5 } }
  const pricing = lookupModelPricing(table, 'claude-opus-4.8')
  expect(pricing).toMatchObject({ inputCostPerToken: 1.5e-5, outputCostPerToken: 7.5e-5 })
})

// The reverse direction is deliberately NOT attempted - dashes are also
// word separators ("claude-opus"), so blanket-replacing them with dots
// would mangle a multi-word name instead of just normalizing a version
// number, unlike the dot case (a dot is never a word separator).
test('lookupModelPricing does NOT try a dash-to-dot variant, since dashes are ambiguous word separators too', () => {
  const table = { 'claude-opus-4.8': { input_cost_per_token: 1.5e-5, output_cost_per_token: 7.5e-5 } }
  expect(lookupModelPricing(table, 'claude-opus-4-8')).toBeNull()
})

test('lookupModelPricing prefers an exact match over a normalized variant when both happen to exist', () => {
  const table = {
    'claude-opus-4.8': { input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
    'claude-opus-4-8': { input_cost_per_token: 9e-6, output_cost_per_token: 9e-6 },
  }
  const pricing = lookupModelPricing(table, 'claude-opus-4.8')
  expect(pricing).toMatchObject({ inputCostPerToken: 1e-6, outputCostPerToken: 1e-6 })
})

test('lookupModelPricing still returns null when no spelling of the model exists under any variant', () => {
  expect(lookupModelPricing(samplePayload, 'not.a-real.model-at.all')).toBeNull()
})
