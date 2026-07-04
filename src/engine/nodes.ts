import { execa } from 'execa'
import type { Adapter, AgentDef, GateHandler, LoopDef, NodeDef, NodeOutcome } from '../core/types.js'
import { composeContext, type RunState } from '../core/context.js'
import { parseVerdict } from '../core/verdict.js'
import type { AdapterRegistry } from '../adapters/registry.js'
import { InfraError, invokeWithRetry } from './retry.js'

export interface EngineDeps {
  registry: AdapterRegistry
  gate?: GateHandler
  cwd?: string
  cache?: Map<string, NodeOutcome>
  hash?: (nodeId: string, prompt: string) => string
  sleep?: (ms: number) => Promise<void>  // retry backoff clock (tests inject instant)
  retries?: number                       // adapter retry budget (default 2)
  // Clamps a node's timeout to the remaining wall-clock budget when a wall rail
  // is set (see runner.ts). Absent when there is no wall rail - behavior is then
  // identical to using node.timeoutMs directly.
  effectiveTimeout?: (nodeTimeoutMs?: number) => number | undefined
}

const VERIFYING = new Set(['critic', 'judge'])

export async function executeNode(
  def: LoopDef,
  node: NodeDef,
  state: RunState,
  outcomes: Map<string, NodeOutcome>,
  deps: EngineDeps,
  onChunk?: (text: string) => void,
): Promise<NodeOutcome> {
  const base = { nodeId: node.id, role: node.role, costUsd: 0, tokens: 0, durationMs: 0 }
  // A node with no explicit timeout still gets one when a wall rail is set, so a
  // hung subprocess degrades into the timeout/infra path instead of hanging the
  // whole run past the wall deadline. No wall rail => unchanged (node.timeoutMs).
  const timeoutMs = deps.effectiveTimeout ? deps.effectiveTimeout(node.timeoutMs) : node.timeoutMs

  if (node.role === 'tester') {
    try {
      const started = Date.now()
      const res = await execa(node.run!, {
        shell: true, cwd: deps.cwd, reject: false, timeout: timeoutMs,
        all: true,
      })
      const passed = res.exitCode === 0
      return {
        ...base,
        output: res.all ?? '',
        durationMs: Date.now() - started,
        verdict: {
          node: node.id,
          status: passed ? 'pass' : 'fail',
          evidence: passed ? `exit 0` : (res.all ?? '').slice(-500) || `exit ${res.exitCode}`,
        },
      }
    } catch (err) {
      // execa itself throwing (not a non-zero exit, which is handled above)
      // means the command/shell setup is broken - structural, not transient.
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ...base,
        output: '',
        verdict: { node: node.id, status: 'error', evidence: `config: ${msg}` },
      }
    }
  }

  if (node.role === 'gate') {
    try {
      if (!deps.gate) {
        return { ...base, output: '', verdict: { node: node.id, status: 'error', evidence: 'config: no gate handler configured' } }
      }
      const context = composeContext(def, node, state, outcomes)
      const approved = await deps.gate(node, context)
      return {
        ...base,
        output: approved ? 'approved' : 'rejected',
        verdict: { node: node.id, status: approved ? 'pass' : 'fail', evidence: approved ? 'human approved' : 'human rejected' },
      }
    } catch (err) {
      // a gate handler that throws is usually a wiring bug (no handler,
      // handler misconfigured) and gets a config: verdict - but a gate that
      // times out waiting for a human (makeGate's setTimeout race) already
      // throws an infra:-tagged error, since a human not answering in time
      // is an operational condition, not a broken loopfile. Preserve any
      // existing infra:/config: prefix instead of blindly re-labeling it, or
      // the router's infra branch (spec §10) never sees it.
      const msg = err instanceof Error ? err.message : String(err)
      const evidence = /^(infra|config):/.test(msg) ? msg : `config: ${msg}`
      return {
        ...base,
        output: '',
        verdict: { node: node.id, status: 'error', evidence },
      }
    }
  }

  if (VERIFYING.has(node.role) && node.of && !outcomes.has(node.of)) {
    return {
      ...base,
      output: '',
      verdict: {
        node: node.id,
        status: 'error',
        evidence: `config: target output for "${node.of}" unavailable - check graph ordering`,
      },
    }
  }

  // resolving the agent/adapter/prompt for this node is structural: an
  // unknown agent key or an unregistered adapter reproduces identically on
  // every iteration and must halt loudly rather than iterate (see the
  // invokeWithRetry call below, whose failures ARE transient).
  let agentDef: AgentDef, adapter: Adapter, prompt: string, key: string | undefined
  try {
    agentDef = def.agents[node.agent!]
    if (!agentDef) throw new Error(`unknown agent "${node.agent}" - check the loop's agents map`)
    adapter = deps.registry.get(agentDef.adapter)
    prompt = composeContext(def, node, state, outcomes)
    key = deps.hash?.(node.id, prompt)
    if (key && deps.cache?.has(key)) {
      return { ...deps.cache.get(key)!, costUsd: 0, contextHash: key }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ...base,
      output: '',
      verdict: { node: node.id, status: 'error', evidence: `config: ${msg}` },
    }
  }

  try {
    let res = await invokeWithRetry(adapter, {
      prompt, timeoutMs,
      model: agentDef.model, command: agentDef.command,
    }, deps, onChunk)
    let verdict = VERIFYING.has(node.role) ? parseVerdict(node.id, res.output) : null
    let cost = res.costUsd
    let tokens = res.tokens

    if (VERIFYING.has(node.role) && !verdict) {
      const retry = await invokeWithRetry(adapter, {
        prompt: `${prompt}\n\nYour previous reply had no verdict block. Reply again ending with:\nVERDICT: pass|fail\nEVIDENCE: <reason>`,
        timeoutMs,
        model: agentDef.model, command: agentDef.command,
      }, deps, onChunk)
      cost += retry.costUsd
      tokens += retry.tokens
      verdict = parseVerdict(node.id, retry.output)
        ?? { node: node.id, status: 'fail', evidence: 'verdict unparseable' }
      res = retry
    }

    if (node.role === 'judge' && verdict && node.threshold !== undefined && verdict.status === 'pass') {
      if (verdict.score === undefined || !Number.isFinite(verdict.score)) {
        verdict = { ...verdict, status: 'fail', evidence: `judge reported no usable SCORE; threshold ${node.threshold} requires one` }
      } else if (verdict.score < node.threshold) {
        verdict = { ...verdict, status: 'fail', evidence: `score ${verdict.score} below threshold ${node.threshold}` }
      }
    }

    return { ...base, output: res.output, verdict, costUsd: cost, tokens, durationMs: res.durationMs, contextHash: key }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ...base,
      output: '',
      verdict: {
        node: node.id,
        status: 'error',
        evidence: err instanceof InfraError ? `infra: ${msg}` : msg,
      },
    }
  }
}
