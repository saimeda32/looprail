import type { Adapter, AgentRequest, AgentResult, PermissionAnswerer } from '../core/types.js'

// Infrastructural failures (expired auth, logged-out CLI) can never be fixed
// by retrying or iterating - the run must halt and point at `looprail doctor`.
export class InfraError extends Error {}

export function isInfraError(message: string): boolean {
  return /\b(auth|login|logged out|unauthorized|401|forbidden)\b/i.test(message)
}

// Rate limiting is transient at the PROVIDER, not in this process: a
// per-account 429/quota ceiling rarely clears within one 1s/4s backoff
// window, so retrying the same adapter just burns the retry budget against
// the same ceiling. Classified separately from plain transient errors so
// the engine can hand the call to a DIFFERENT agent (AgentDef.fallback)
// once this adapter's own retries are spent - see executeNode in nodes.ts.
export class RateLimitError extends Error {}

// Deliberately conservative: only unmistakably rate-limit/quota-shaped text
// qualifies. A looser match would reroute genuine failures (a test log that
// happens to mention "limits", a compiler error an adapter echoed) to a
// fallback agent that fails identically, doubling the cost of every real
// failure. Adapters surface these as `<name> exited N: <stderr tail>`
// (cli-adapter.ts), so this matches the provider phrasings seen in that
// tail: HTTP 429s, "rate limit"/"RateLimitError", "too many requests",
// Anthropic's overloaded_error, quota-exhaustion wording, and claude-code's
// "usage limit reached" banner.
export function isRateLimitError(message: string): boolean {
  return /\b429\b|too many requests|rate[ _-]?limit|overloaded|\bquota\b|usage limit reached|resource[ _-]?exhausted/i.test(message)
}

export interface RetryDeps {
  sleep?: (ms: number) => Promise<void>
  retries?: number
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function invokeWithRetry(
  adapter: Adapter,
  req: AgentRequest,
  deps: RetryDeps = {},
  onChunk?: (text: string) => void,
  onPermission?: PermissionAnswerer,
): Promise<AgentResult> {
  const retries = deps.retries ?? 2
  const sleep = deps.sleep ?? defaultSleep
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await adapter.invoke(req, onChunk, onPermission)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isInfraError(msg)) {
        throw new InfraError(`${msg} - run \`looprail doctor\` to check adapter auth`)
      }
      lastErr = err
      if (attempt < retries) await sleep(1000 * 4 ** attempt) // 1s, 4s
    }
  }
  // Classified only AFTER the budget is spent: a throttle sometimes clears
  // mid-window, and a same-adapter retry is always cheaper than dragging a
  // second agent (different model, cold context) into the node.
  const lastMsg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  if (isRateLimitError(lastMsg)) {
    throw new RateLimitError(lastMsg, { cause: lastErr })
  }
  throw lastErr
}
