import type { Adapter, AgentRequest } from '../core/types.js'
import type { PricingTable } from '../core/pricing.js'
import { CliAdapter, type ExecFn, type ParsedResponse } from './cli-adapter.js'
import { resolvePermissionArgs } from './permissions.js'
import { createPricingEstimator } from './pricing-estimator.js'

interface CopilotEvent {
  type?: string
  data?: { content?: string; deltaContent?: string; outputTokens?: number; model?: string }
}

// `copilot -p ... --output-format json` emits one JSON object per line:
// session/tool bookkeeping (including a session.tools_updated event whose
// data.model names the model copilot actually resolved to - the only
// reliable model key when AgentRequest.model was omitted or "auto", since
// config alone gives nothing to look pricing up by in that case), an
// assistant.message_delta per token as the reply is generated, a final
// assistant.message with the complete content and its own output token
// count, then a result line. It reports no dollar cost anywhere in this
// format - costUsd stays 0 (default). Verified empirically (live run,
// `copilot -p ... --output-format json --allow-all-tools`): neither the
// final assistant.message nor the result line's `usage` object (which only
// carries premiumRequests/timing/codeChanges) contains an input-token
// count anywhere - only outputTokens exists. inputTokens is therefore left
// undefined (never coerced to 0, which would falsely claim "zero input
// tokens" instead of "unknown").
export function parseCopilotJsonl(stdout: string): ParsedResponse {
  let output = ''
  let tokens = 0
  let resolvedModel: string | undefined
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let e: CopilotEvent
    try {
      e = JSON.parse(line) as CopilotEvent
    } catch {
      continue
    }
    if (e.type === 'session.tools_updated' && typeof e.data?.model === 'string') {
      resolvedModel = e.data.model
    }
    if (e.type === 'assistant.message' && typeof e.data?.content === 'string') {
      output = e.data.content
      tokens = e.data.outputTokens ?? 0
    }
  }
  if (!output) return { output: stdout.trim() }
  return { output, tokens, outputTokens: tokens, resolvedModel }
}

// Unlike claude-code and codex, copilot's JSON mode streams genuine
// per-token deltas (verified empirically), not just per-item snapshots -
// assistant.message_delta.deltaContent is the actual next slice of text.
export function copilotStreamLine(line: string): string | null {
  let e: CopilotEvent
  try {
    e = JSON.parse(line) as CopilotEvent
  } catch {
    return null
  }
  if (e.type === 'assistant.message_delta' && typeof e.data?.deltaContent === 'string') {
    return e.data.deltaContent
  }
  return null
}

// Best-effort adapter over the standalone `copilot` CLI, exercised for real
// only behind LOOPRAIL_LIVE=1 - CI never shells out to it. Invokes the
// `copilot` binary directly rather than through `gh copilot` (which just
// execs this same binary anyway, per `gh copilot --help`) so this adapter
// uses copilot's own native login/credential store - going through `gh`
// instead made auth depend on gh's own token precedence (a GH_TOKEN env var
// set to a stale/different credential than the one actually logged in via
// `gh auth login` silently wins and breaks auth, a real flake hit earlier)
// for no benefit, since nothing here needs any other `gh` functionality.
// --allow-all-tools is required for non-interactive use per `copilot
// --help`; without it, any tool call (writing a file, running a command)
// has nothing to prompt for approval and the model just declines or
// describes what it would do.
// No `permissionDetector` is wired here (see cli-adapter.ts's
// PermissionDetector seam). Investigated live against a real copilot v1.0.68
// install with stdin closed, using this exact adapter's safe-preset flags
// (--allow-tool write --allow-tool "shell(npm:*)") against a shell command
// outside that allowlist: the tool still ran to completion - no
// tool.execution_denied (or similarly-shaped) event was ever observed on this
// machine to build a detector against. Deferred pending a fresh,
// un-configured copilot install where a real denial can be captured; do not
// guess this CLI's format.
export function createCopilotAdapter(
  opts: { exec?: ExecFn; cwd?: string; loadPricingTable?: () => Promise<PricingTable> | PricingTable } = {},
): Adapter {
  return new CliAdapter({
    name: 'copilot-cli',
    command: 'copilot -p {prompt} --output-format json --allow-all-tools',
    // `copilot --help`: "--model <model> Set the AI model to use (use
    // 'auto' to let Copilot pick automatically)" - same shape as
    // claude-code/codex's own model pin, verified against the real CLI.
    extraArgs: (req: AgentRequest) => [
      ...(req.model ? ['--model', req.model] : []),
      ...resolvePermissionArgs(req.permissions, 'copilot-cli'),
    ],
    parser: parseCopilotJsonl,
    streamHandler: copilotStreamLine,
    // copilot never reports a real dollar cost (see parseCopilotJsonl); this
    // estimator derives one from the split tokens + resolved model via the
    // runtime pricing module, without ever touching costUsd.
    estimator: createPricingEstimator({ loadTable: opts.loadPricingTable }),
    exec: opts.exec,
    cwd: opts.cwd,
  })
}
