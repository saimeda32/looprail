import { estimateCostUsd, loadPricingTable, type PricingTable } from '../core/pricing.js'
import type { AgentRequest } from '../core/types.js'
import type { CostEstimator, ParsedResponse } from './cli-adapter.js'

export interface PricingEstimatorOptions {
  // Overridable so tests can inject a fixed table instead of exercising the
  // real network fetch/on-disk cache (already covered by pricing.test.ts).
  loadTable?: () => Promise<PricingTable> | PricingTable
}

// Model key resolution order: a concrete AgentRequest.model wins - that's an
// explicit pin the loopfile author chose. "auto" or an omitted model falls
// back to whatever the adapter's own parser captured as the CLI's
// actually-resolved model (e.g. copilot's session.tools_updated data.model).
// No usable key in either place means no estimate is possible.
function resolveModelKey(req: AgentRequest, parsed: ParsedResponse): string | undefined {
  if (req.model && req.model !== 'auto') return req.model
  return parsed.resolvedModel
}

// Builds a CliAdapterOptions.estimator hook backed by the runtime pricing
// module. Used by copilot/codex/aider - never claude-code, which already
// reports a genuine costUsd and must not get a competing estimate. Returns
// undefined (never 0) whenever there are no split token counts to price, or
// no resolvable model, or the model is absent from the pricing table.
export function createPricingEstimator(opts: PricingEstimatorOptions = {}): CostEstimator {
  const loadTable = opts.loadTable ?? (() => loadPricingTable())
  return async (req, parsed) => {
    if (parsed.inputTokens === undefined && parsed.outputTokens === undefined) return undefined
    const model = resolveModelKey(req, parsed)
    if (!model) return undefined
    const table = await loadTable()
    const est = estimateCostUsd(table, model, {
      inputTokens: parsed.inputTokens ?? 0,
      outputTokens: parsed.outputTokens ?? 0,
    })
    return est ?? undefined
  }
}
