import type { Adapter } from '../core/types.js'
import type { PricingTable } from '../core/pricing.js'
import { createRegistry, type AdapterRegistry } from './registry.js'
import type { ExecFn } from './cli-adapter.js'
import { createClaudeCodeAdapter } from './claude-code.js'
import { createCodexAdapter } from './codex.js'
import { createAiderAdapter } from './aider.js'
import { createCopilotAdapter } from './copilot.js'
import { createGeminiAdapter } from './gemini.js'
import { createOpencodeAdapter } from './opencode.js'
import { createOllamaAdapter } from './ollama.js'
import { createShellAdapter } from './shell.js'

export interface DefaultRegistryOptions {
  exec?: ExecFn
  cwd?: string
  // Overridable pricing table loader, threaded into the adapters that
  // derive estimatedCostUsd (copilot, codex, aider, gemini). Left unset in normal
  // use, which defaults each adapter to the real runtime fetch/cache module;
  // tests can override this to avoid network access end to end.
  loadPricingTable?: () => Promise<PricingTable> | PricingTable
}

// Unscripted mock for CLI runs (`adapter: mock` in a loopfile): verifying
// prompts auto-pass, everything else echoes. Deterministic, free, offline.
export function createCliMockAdapter(): Adapter {
  return {
    name: 'mock',
    async invoke(req) {
      const verifying = req.prompt.includes('VERDICT:')
      return {
        output: verifying
          ? 'VERDICT: pass\nSCORE: 1\nEVIDENCE: mock adapter auto-pass'
          : `[mock] ${req.prompt.split('\n')[0].slice(0, 100)}`,
        costUsd: 0,
        tokens: 0,
        durationMs: 1,
      }
    },
  }
}

export function createDefaultRegistry(opts: DefaultRegistryOptions = {}): AdapterRegistry {
  const reg = createRegistry()
  reg.register(createCliMockAdapter())
  reg.register(createClaudeCodeAdapter(opts))
  reg.register(createCodexAdapter(opts))
  reg.register(createAiderAdapter(opts))
  reg.register(createCopilotAdapter(opts))
  reg.register(createGeminiAdapter(opts))
  reg.register(createOpencodeAdapter(opts))
  reg.register(createOllamaAdapter(opts))
  reg.register(createShellAdapter(opts))
  return reg
}
