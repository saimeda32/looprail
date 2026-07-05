import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// LiteLLM's community-maintained pricing dump. This repo does NOT hardcode
// per-token rates: model prices change often (new models, promo pricing,
// deprecations) and a stale hardcoded table would silently misprice every
// estimate forever. Fetched fresh on every call when reachable; see
// loadPricingTable for the on-disk fallback that keeps a run unblocked when
// the source is briefly unreachable.
export const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

// One entry in LiteLLM's raw JSON. Only the fields this module actually
// reads are typed; the source has ~50 other fields per model (max tokens,
// supported modalities, etc.) that estimation has no use for.
export interface RawModelPricing {
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_creation_input_token_cost?: number
  cache_read_input_token_cost?: number
}

export type PricingTable = Record<string, RawModelPricing>

export interface ModelPricing {
  inputCostPerToken: number
  outputCostPerToken: number
  cacheCreationCostPerToken?: number
  cacheReadCostPerToken?: number
}

export interface FetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type FetchFn = (url: string) => Promise<FetchResponse>

const defaultFetchFn: FetchFn = (url) => fetch(url) as unknown as Promise<FetchResponse>

export function defaultCachePath(): string {
  return join(homedir(), '.looprail', 'pricing-cache.json')
}

function readCache(cachePath: string): PricingTable {
  try {
    if (!existsSync(cachePath)) return {}
    return JSON.parse(readFileSync(cachePath, 'utf8')) as PricingTable
  } catch {
    // A corrupt or half-written cache file is no better than no cache -
    // treat it the same as a cold cache rather than blowing up the run.
    return {}
  }
}

function writeCache(cachePath: string, table: PricingTable): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify(table))
  } catch {
    // Cache writes are best-effort. A read-only filesystem or a full disk
    // must not fail the estimate that was already successfully fetched.
  }
}

export interface LoadPricingTableOptions {
  fetchFn?: FetchFn
  cachePath?: string
  url?: string
}

// Fetches the live LiteLLM pricing table on every call when reachable, and
// writes a successful result to the on-disk cache. When the fetch fails
// (network down, non-200, thrown error) it falls back to whatever the cache
// already has, so a briefly-unreachable pricing source never blocks a run.
// If there is no fetch AND no usable cache, returns an empty table rather
// than throwing - callers (estimateCostUsd/lookupModelPricing) treat an
// empty/missing entry as an explicit "unknown model", never a silent $0.
export async function loadPricingTable(opts: LoadPricingTableOptions = {}): Promise<PricingTable> {
  const fetchFn = opts.fetchFn ?? defaultFetchFn
  const cachePath = opts.cachePath ?? defaultCachePath()
  const url = opts.url ?? LITELLM_PRICING_URL
  try {
    const res = await fetchFn(url)
    if (!res.ok) throw new Error(`pricing fetch failed: HTTP ${res.status}`)
    const table = (await res.json()) as PricingTable
    writeCache(cachePath, table)
    return table
  } catch {
    return readCache(cachePath)
  }
}

// Confirmed live: copilot-cli requires its own CLI argument in dot form
// ("claude-opus-4.8"), but LiteLLM's table keys the very same model with
// dashes ("claude-opus-4-8") - a real naming-convention mismatch between
// what an adapter's CLI needs and how the pricing source names models,
// not a model that's actually missing pricing data. This silently starved
// every opus-4.8 node of both real cost (it never had any) AND an estimate
// (the literal string never matched), even though the pricing data for the
// same model genuinely exists.
//
// Generates plausible alternate spellings to try - deliberately only
// dot-to-dash, not the reverse: a dot in a model name is always a version
// separator (no real model name uses a literal "." as a word separator),
// so normalizing it to a dash is unambiguous. Blanket-replacing dashes
// with dots is NOT safe the same way - dashes ARE used as word separators
// ("claude-opus"), so doing that would mangle "claude-opus-4-8" into
// "claude.opus.4.8" instead of the intended "claude-opus-4.8". This is
// deliberately generic rather than a special case for "opus" specifically,
// since the underlying mismatch is a naming-convention difference that
// could affect any model name shaped this way.
function modelKeyVariants(model: string): string[] {
  const variants = new Set([model, model.replace(/\./g, '-')])
  return [...variants]
}

// Looks up per-token rates for one model key. Returns null - never a
// zeroed-out record - when the model genuinely isn't in the table under
// any plausible spelling, so a caller can never mistake "we don't know
// this model's price" for "this model costs $0".
export function lookupModelPricing(table: PricingTable, model: string): ModelPricing | null {
  for (const candidate of modelKeyVariants(model)) {
    const raw = table[candidate]
    if (raw && raw.input_cost_per_token !== undefined && raw.output_cost_per_token !== undefined) {
      return {
        inputCostPerToken: raw.input_cost_per_token,
        outputCostPerToken: raw.output_cost_per_token,
        cacheCreationCostPerToken: raw.cache_creation_input_token_cost,
        cacheReadCostPerToken: raw.cache_read_input_token_cost,
      }
    }
  }
  return null
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

// Estimates a dollar cost from split input/output token counts at a known
// model's real, separately-rated per-token prices. Returns null (never 0)
// when the model is absent from the table - the caller must treat that as
// "no estimate available", not "this run was free".
export function estimateCostUsd(table: PricingTable, model: string, usage: TokenUsage): number | null {
  const pricing = lookupModelPricing(table, model)
  if (!pricing) return null
  return usage.inputTokens * pricing.inputCostPerToken + usage.outputTokens * pricing.outputCostPerToken
}
