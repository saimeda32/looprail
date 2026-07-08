import type { Adapter, AgentRequest, AgentResult } from '../core/types.js'
import { estimateCostUsd, loadPricingTable, type PricingTable } from '../core/pricing.js'
import { defaultExec, type ExecFn } from './cli-adapter.js'
import { resolvePermissionArgs } from './permissions.js'
import { estimateTokens } from './ollama.js'

// Google's Antigravity CLI (`agy`) - the successor to gemini CLI, which
// stopped serving individual Google AI Pro/Ultra/free users on 2026-06-18
// (enterprise gemini installs keep working, so the gemini adapter stays).
//
// Verification honesty: `agy` was NOT installed on this project's
// development machine, so nothing below is live-verified. The flag surface
// is corroborated across three sources - the official repo README (binary
// name `agy`), Google's transition announcement, and a hands-on guide
// documenting `-p/--print` (single prompt, no TUI), `-m` (model),
// `--sandbox` (restricted terminal), and `--dangerously-skip-permissions`
// (auto-approve) - and should be re-checked against a real install's
// `agy --help` when one is available. A structured output format
// (`--output-format json`) is documented in places but reported NOT shipped
// in current releases, so this adapter deliberately consumes plain-text
// stdout - the one shape every release has.
//
// Because plain text carries no usage envelope, token numbers are the same
// chars/4 ESTIMATE ollama uses (clearly estimates, never claimed as
// provider-reported), and the dollar figure goes to estimatedCostUsd via
// the runtime pricing table - costUsd stays 0, which keeps meaning "real,
// adapter-reported cost" everywhere else in the engine.
//
// Hand-rolled rather than a CliAdapter for the same reason ollama is:
// estimating input tokens needs the prompt itself, which CliAdapter's
// stdout-only parser seam never sees.
export function createAntigravityAdapter(
  opts: { exec?: ExecFn; cwd?: string; loadPricingTable?: () => Promise<PricingTable> | PricingTable } = {},
): Adapter {
  const exec = opts.exec ?? defaultExec
  const loadTable = opts.loadPricingTable ?? (() => loadPricingTable())
  return {
    name: 'antigravity',
    async invoke(req: AgentRequest, onChunk?: (text: string) => void): Promise<AgentResult> {
      const started = Date.now()
      const args = [
        '-p', req.prompt,
        ...(req.model ? ['-m', req.model] : []),
        ...resolvePermissionArgs(req.permissions, 'antigravity'),
      ]
      const res = await exec('agy', args, {
        timeoutMs: req.timeoutMs,
        cwd: opts.cwd,
        // Print-mode stdout is the model's plain prose itself (no JSONL
        // envelope), so raw chunks are already what a live-output pane
        // should show - same posture as ollama.
        onChunk,
      })
      if (res.exitCode !== 0) {
        throw new Error(`agy exited ${res.exitCode}: ${(res.stderr || res.stdout).slice(-400)}`)
      }
      const output = res.stdout.trim()
      const inputTokens = estimateTokens(req.prompt)
      const outputTokens = estimateTokens(output)
      let estimatedCostUsd: number | undefined
      if (req.model) {
        const table = await loadTable()
        estimatedCostUsd = estimateCostUsd(table, req.model, { inputTokens, outputTokens }) ?? undefined
      }
      return {
        output,
        costUsd: 0, // print mode reports no dollars - the estimate lives in estimatedCostUsd
        tokens: inputTokens + outputTokens, // chars/4 estimates, both sides - see ollama.ts's estimateTokens
        inputTokens,
        outputTokens,
        ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
        durationMs: Date.now() - started,
      }
    },
  }
}
