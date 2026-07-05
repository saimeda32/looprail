import type { Adapter, AgentRequest } from '../core/types.js'
import type { PricingTable } from '../core/pricing.js'
import { CliAdapter, type ExecFn, type ParsedResponse } from './cli-adapter.js'
import { resolvePermissionArgs } from './permissions.js'
import { createPricingEstimator } from './pricing-estimator.js'

// Turns aider's own abbreviated token count text (e.g. "116", "1.2k") into a
// number. format_tokens() in aider/utils.py (v0.86.2) rounds/abbreviates any
// count >= 1000 with a "k" suffix - that precision loss is genuinely baked
// into aider's own output under these flags, not something recoverable here.
function parseTokenCount(raw: string): number {
  if (raw.endsWith('k')) return Math.round(parseFloat(raw.slice(0, -1)) * 1000)
  return parseInt(raw, 10)
}

const TOKENS_LINE = /^Tokens:\s*[\d.]+k?\s*sent.*received\.?\s*$/i
const SENT_RE = /Tokens:\s*([\d.]+k?)\s*sent/i
const RECEIVED_RE = /([\d.]+k?)\s*received/i

// aider (verified against v0.86.2 source: Coder.calculate_and_show_tokens_and_
// cost + InputOutput.tool_output in aider/coders/base_coder.py and aider/io.py)
// prints exactly one line at the end of a successful turn of the shape
// "Tokens: <sent> sent[, <n> cache write][, <n> cache hit], <received> received."
// via io.tool_output(), which always calls console.print for this line -
// neither --no-pretty (styling only) nor --no-stream (live-reply rendering
// only) suppresses it. It reports no dollar cost in this repo's sense: aider
// does compute its own "Cost: $X message, $Y session." line right after the
// tokens line, but that requires its own bundled litellm pricing data to
// recognize the model, only appears when it does, and is aider's own
// self-estimate rather than a value the CLI's provider actually reported back
// - so it is deliberately NOT read here. costUsd stays 0 (default); this
// repo's own pricing module produces an estimate from the split tokens below
// instead, exactly as it does for copilot/codex.
export function parseAiderOutput(stdout: string): ParsedResponse {
  const lines = stdout.split('\n')
  const summaryLine = lines.find((l) => TOKENS_LINE.test(l.trim()))
  const output = lines.filter((l) => !TOKENS_LINE.test(l.trim())).join('\n').trim()

  if (!summaryLine) return { output: output || stdout.trim() }

  const sentMatch = summaryLine.match(SENT_RE)
  const receivedMatch = summaryLine.match(RECEIVED_RE)
  if (!sentMatch || !receivedMatch) return { output: output || stdout.trim() }

  const inputTokens = parseTokenCount(sentMatch[1])
  const outputTokens = parseTokenCount(receivedMatch[1])
  return { output: output || stdout.trim(), tokens: inputTokens + outputTokens, inputTokens, outputTokens }
}

export function createAiderAdapter(
  opts: { exec?: ExecFn; cwd?: string; loadPricingTable?: () => Promise<PricingTable> | PricingTable } = {},
): Adapter {
  return new CliAdapter({
    name: 'aider',
    command: 'aider --message {prompt} --yes-always --no-auto-commits --no-stream --no-pretty',
    extraArgs: (req: AgentRequest) => [
      ...(req.model ? ['--model', req.model] : []),
      ...resolvePermissionArgs(req.permissions, 'aider'),
    ],
    parser: parseAiderOutput,
    // aider never reports a real dollar cost in the sense this repo trusts
    // (see parseAiderOutput's comment on its own self-estimated "Cost:"
    // line); derive one from the split tokens via the runtime pricing
    // module instead, without ever touching costUsd.
    estimator: createPricingEstimator({ loadTable: opts.loadPricingTable }),
    exec: opts.exec,
    cwd: opts.cwd,
  })
}
