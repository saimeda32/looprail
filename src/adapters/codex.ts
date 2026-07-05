import type { Adapter, AgentRequest } from '../core/types.js'
import type { PricingTable } from '../core/pricing.js'
import { CliAdapter, type ExecFn, type ParsedResponse } from './cli-adapter.js'
import { resolvePermissionArgs } from './permissions.js'
import { createPricingEstimator } from './pricing-estimator.js'

interface CodexEvent {
  type?: string
  item?: { type?: string; text?: string }
  usage?: { input_tokens?: number; output_tokens?: number }
}

export function parseCodexJsonl(stdout: string): ParsedResponse {
  let output = ''
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let e: CodexEvent
    try {
      e = JSON.parse(line) as CodexEvent
    } catch {
      continue
    }
    if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text) {
      output = e.item.text
    }
    if (e.type === 'turn.completed' && e.usage) {
      // Preserve the input/output split (not just the combined total) - mixed-rate
      // cost estimation needs each side priced separately.
      inputTokens = e.usage.input_tokens ?? 0
      outputTokens = e.usage.output_tokens ?? 0
    }
  }
  // codex does not report USD cost in its envelope - costUsd stays 0 (default)
  if (!output) return { output: stdout.trim() }
  if (inputTokens === undefined && outputTokens === undefined) return { output }
  const tokens = (inputTokens ?? 0) + (outputTokens ?? 0)
  return { output, tokens, inputTokens, outputTokens }
}

// `codex exec --json` emits one line per completed item as the turn
// progresses, not one blob at the end - the same items parseCodexJsonl scans
// for above arrive live, so surfacing them as they land is a genuine
// incremental improvement, not just a re-announcement of the final output.
export function codexStreamLine(line: string): string | null {
  let e: CodexEvent
  try {
    e = JSON.parse(line) as CodexEvent
  } catch {
    return null
  }
  if (e.type !== 'item.completed' || !e.item?.text) return null
  if (e.item.type === 'agent_message') return e.item.text
  if (e.item.type === 'reasoning') return `[reasoning] ${e.item.text}`
  return null
}

// No `permissionDetector` is wired here (see cli-adapter.ts's
// PermissionDetector seam). The `codex` binary was not discoverable on PATH
// in this project's development environment - there is zero live evidence of
// any kind for its permission-block output shape, and no existing test
// fixture in this repo captures one either. Deferred pending a real,
// un-configured codex install to observe an actual blocked-prompt line
// against; do not guess this CLI's format.
export function createCodexAdapter(
  opts: { exec?: ExecFn; cwd?: string; loadPricingTable?: () => Promise<PricingTable> | PricingTable } = {},
): Adapter {
  return new CliAdapter({
    name: 'codex',
    command: 'codex exec --json {prompt}',
    extraArgs: (req: AgentRequest) => [
      ...(req.model ? ['-m', req.model] : []),
      ...resolvePermissionArgs(req.permissions, 'codex'),
    ],
    parser: parseCodexJsonl,
    streamHandler: codexStreamLine,
    // codex never reports a real dollar cost (see parseCodexJsonl); derive
    // an estimate from the split tokens via the runtime pricing module,
    // without ever touching costUsd. codex has no resolved-model event of
    // its own, so an estimate here relies on AgentRequest.model being set.
    estimator: createPricingEstimator({ loadTable: opts.loadPricingTable }),
    exec: opts.exec,
    cwd: opts.cwd,
  })
}
