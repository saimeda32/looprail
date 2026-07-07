import type { Adapter, AgentRequest, AgentResult } from '../core/types.js'
import { defaultExec, type ExecFn } from './cli-adapter.js'
import { resolvePermissionArgs } from './permissions.js'

// ~4 characters per token is the standard rough heuristic for English-ish
// text (the same rule of thumb OpenAI/Anthropic docs cite). It exists here
// because ollama's plain `run` output carries no usage envelope at all to
// parse a real count from - see createOllamaAdapter's comment for why the
// real counts it does have aren't reachable. Exported so tests pin the
// exact arithmetic the adapter reports.
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / 4)
}

// First-class local models, replacing the `adapter: shell` +
// "ollama run llama3 {prompt}" workaround: `agents: { local: { adapter:
// ollama, model: llama3 } }` runs `ollama run <model>` with the prompt piped
// on stdin.
//
// Verification honesty: the `ollama` binary was NOT installed on this
// project's development machine, so nothing below is live-verified.
// Piping the prompt on stdin is ollama's own documented non-interactive
// usage (its README's "Pass the prompt as an argument" section documents
// both `ollama run llama3 "prompt"` and stdin piping; stdin is used here so
// arbitrarily long prompts never hit argv length limits). `ollama run
// --verbose` does print real token counts, but (a) unverified live and (b)
// to stderr as free-form stat lines, so it is deliberately not parsed -
// do not guess a CLI's format. Until a real install can be observed, token
// numbers are the chars/4 ESTIMATE above, clearly estimates, never claimed
// as provider-reported.
//
// costUsd 0 here is genuinely real, not an estimated-zero: local inference
// bills nobody, whatever the token count. That is exactly why no pricing
// estimator is wired in and estimatedCostUsd stays undefined - an "estimate"
// would imply there was a dollar figure being approximated.
//
// This is a hand-rolled Adapter rather than a CliAdapter because the model
// is a positional argument (`ollama run <model>`) that CliAdapter's static
// command template can't express, and because estimating input tokens needs
// the prompt itself, which CliAdapter's stdout-only parser seam never sees.
export function createOllamaAdapter(
  opts: { exec?: ExecFn; cwd?: string } = {},
): Adapter {
  const exec = opts.exec ?? defaultExec
  return {
    name: 'ollama',
    async invoke(req: AgentRequest, onChunk?: (text: string) => void): Promise<AgentResult> {
      if (!req.model) {
        throw new Error(
          'ollama adapter needs a model - set agents.<name>.model (e.g. llama3) in your loopfile',
        )
      }
      const started = Date.now()
      // ollama has no tool or permission model at all - it only generates
      // text - so no preset ever contributes flags (see permissions.ts).
      // Still resolved here so the loopfile's raw escape hatch can pass
      // ollama-specific flags (e.g. --think, --format) when someone needs to.
      const args = ['run', req.model, ...resolvePermissionArgs(req.permissions, 'ollama')]
      const res = await exec('ollama', args, {
        input: req.prompt,
        timeoutMs: req.timeoutMs,
        cwd: opts.cwd,
        // Raw chunk passthrough with no line handler: unlike every JSONL
        // adapter, ollama's stdout is the model's plain prose itself, so raw
        // chunks are already exactly what a live-output pane should show.
        onChunk,
      })
      if (res.exitCode !== 0) {
        throw new Error(`ollama exited ${res.exitCode}: ${(res.stderr || res.stdout).slice(-400)}`)
      }
      const output = res.stdout.trim()
      const inputTokens = estimateTokens(req.prompt)
      const outputTokens = estimateTokens(output)
      return {
        output,
        costUsd: 0, // real: local inference is genuinely free
        tokens: inputTokens + outputTokens, // chars/4 estimates, both sides - see estimateTokens
        inputTokens,
        outputTokens,
        durationMs: Date.now() - started,
      }
    },
  }
}
