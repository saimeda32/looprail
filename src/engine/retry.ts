import type { Adapter, AgentRequest, AgentResult } from '../core/types.js'

// Infrastructural failures (expired auth, logged-out CLI) can never be fixed
// by retrying or iterating — the run must halt and point at `looprail doctor`.
export class InfraError extends Error {}

export function isInfraError(message: string): boolean {
  return /\b(auth|login|logged out|unauthorized|401|forbidden)\b/i.test(message)
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
): Promise<AgentResult> {
  const retries = deps.retries ?? 2
  const sleep = deps.sleep ?? defaultSleep
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await adapter.invoke(req)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isInfraError(msg)) {
        throw new InfraError(`${msg} — run \`looprail doctor\` to check adapter auth`)
      }
      lastErr = err
      if (attempt < retries) await sleep(1000 * 4 ** attempt) // 1s, 4s
    }
  }
  throw lastErr
}
