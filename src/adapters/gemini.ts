import type { Adapter, AgentRequest } from '../core/types.js'
import type { PricingTable } from '../core/pricing.js'
import { CliAdapter, type ExecFn, type ParsedResponse } from './cli-adapter.js'
import { resolvePermissionArgs } from './permissions.js'
import { createPricingEstimator } from './pricing-estimator.js'

interface GeminiStreamEvent {
  type?: string
  role?: string
  content?: string
  model?: string
  tool_name?: string
  stats?: { total_tokens?: number; input_tokens?: number; output_tokens?: number }
}

// `gemini -p ... -o stream-json` emits one JSON object per line. What was
// verifiable on this machine, and how: the flag surface (-p, --model,
// -o stream-json, --approval-mode) comes from the real `gemini --help` of
// v0.49.0 (run live via npx); the auth-failure behavior (a JSON error
// envelope on *stderr*, empty stdout, nonzero exit - exit 41 for a missing
// auth method) was observed live the same way. The success-path event shapes
// below could NOT be observed live (no Google credentials on this machine) -
// they are taken from that exact installed v0.49.0 build's own bundled
// source (packages/core/src/output/stream-json-formatter.ts and
// packages/cli/src/nonInteractiveCli.ts): an `init` event carrying the
// resolved `model`, `message` events with role "user"/"assistant" (assistant
// content arrives as genuine per-chunk deltas), `tool_use`/`tool_result`
// events, and a terminal `result` event whose `stats` object carries
// snake_case `total_tokens`/`input_tokens`/`output_tokens` aggregated across
// every model the turn touched. No event anywhere in that source reports a
// dollar cost - costUsd stays 0 (default) and the pricing estimator below
// derives one instead, exactly as aider/codex/copilot do.
export function parseGeminiStreamJsonl(stdout: string): ParsedResponse {
  let output = ''
  let resolvedModel: string | undefined
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let tokens: number | undefined
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let e: GeminiStreamEvent
    try {
      e = JSON.parse(line) as GeminiStreamEvent
    } catch {
      continue
    }
    if (e.type === 'init' && typeof e.model === 'string') {
      // The model the CLI actually resolved to (config.getModel()), needed
      // for pricing lookup when AgentRequest.model was omitted.
      resolvedModel = e.model
    }
    if (e.type === 'message' && e.role === 'assistant' && typeof e.content === 'string') {
      // Assistant content is delta-streamed; the final answer is the
      // concatenation of every delta, mirroring exactly how the CLI's own
      // single-envelope `-o json` mode accumulates responseText.
      output += e.content
    }
    if (e.type === 'result' && e.stats) {
      inputTokens = e.stats.input_tokens ?? 0
      outputTokens = e.stats.output_tokens ?? 0
      // total_tokens also counts thought/tool/cached tokens the input/output
      // split leaves out (per convertToStreamStats in the bundled source),
      // so prefer it over the sum when present.
      tokens = e.stats.total_tokens ?? inputTokens + outputTokens
    }
  }
  if (!output) return { output: stdout.trim() }
  if (inputTokens === undefined && outputTokens === undefined) return { output, resolvedModel }
  return { output, tokens, inputTokens, outputTokens, resolvedModel }
}

// Assistant `message` events carry `delta: true` per content chunk in the
// bundled v0.49.0 source - genuine token-level streaming like copilot's, not
// per-item snapshots. The user's own echoed prompt also arrives as a
// `message` event (role "user"), so role must gate what gets surfaced.
export function geminiStreamLine(line: string): string | null {
  let e: GeminiStreamEvent
  try {
    e = JSON.parse(line) as GeminiStreamEvent
  } catch {
    return null
  }
  if (e.type === 'message' && e.role === 'assistant' && typeof e.content === 'string' && e.content.length > 0) {
    return e.content
  }
  if (e.type === 'tool_use' && typeof e.tool_name === 'string') {
    return `[using tool: ${e.tool_name}]`
  }
  return null
}

// No `permissionDetector` is wired here (see cli-adapter.ts's
// PermissionDetector seam). Headless gemini never prompts on stdout mid-run
// per its bundled v0.49.0 source (non-approved tools are policy-denied, not
// asked about interactively), and no live authenticated run was possible on
// this machine to observe otherwise - deferred pending real evidence; do not
// guess this CLI's format.
export function createGeminiAdapter(
  opts: { exec?: ExecFn; cwd?: string; loadPricingTable?: () => Promise<PricingTable> | PricingTable } = {},
): Adapter {
  return new CliAdapter({
    name: 'gemini',
    command: 'gemini -p {prompt} -o stream-json',
    // `gemini --help` (v0.49.0, live): "-m, --model  Model" - same shape as
    // claude-code/copilot's model pin.
    extraArgs: (req: AgentRequest) => [
      ...(req.model ? ['--model', req.model] : []),
      ...resolvePermissionArgs(req.permissions, 'gemini'),
    ],
    parser: parseGeminiStreamJsonl,
    streamHandler: geminiStreamLine,
    // gemini never reports a dollar cost in any output format (verified
    // against the bundled v0.49.0 source - see parseGeminiStreamJsonl);
    // derive an estimate from the split tokens + resolved model via the
    // runtime pricing module, without ever touching costUsd.
    estimator: createPricingEstimator({ loadTable: opts.loadPricingTable }),
    exec: opts.exec,
    cwd: opts.cwd,
  })
}
