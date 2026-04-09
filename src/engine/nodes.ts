import { execa } from 'execa'
import type { GateHandler, LoopDef, NodeDef, NodeOutcome } from '../core/types.js'
import { composeContext, type RunState } from '../core/context.js'
import { parseVerdict } from '../core/verdict.js'
import type { AdapterRegistry } from '../adapters/registry.js'

export interface EngineDeps {
  registry: AdapterRegistry
  gate?: GateHandler
  cwd?: string
}

const VERIFYING = new Set(['critic', 'judge'])

export async function executeNode(
  def: LoopDef,
  node: NodeDef,
  state: RunState,
  outcomes: Map<string, NodeOutcome>,
  deps: EngineDeps,
): Promise<NodeOutcome> {
  const base = { nodeId: node.id, role: node.role, costUsd: 0, tokens: 0, durationMs: 0 }

  if (node.role === 'tester') {
    const started = Date.now()
    const res = await execa(node.run!, {
      shell: true, cwd: deps.cwd, reject: false, timeout: node.timeoutMs,
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
  }

  if (node.role === 'gate') {
    if (!deps.gate) {
      return { ...base, output: '', verdict: { node: node.id, status: 'error', evidence: 'no gate handler configured' } }
    }
    const context = composeContext(def, node, state, outcomes)
    const approved = await deps.gate(node, context)
    return {
      ...base,
      output: approved ? 'approved' : 'rejected',
      verdict: { node: node.id, status: approved ? 'pass' : 'fail', evidence: approved ? 'human approved' : 'human rejected' },
    }
  }

  const agentDef = def.agents[node.agent!]
  const adapter = deps.registry.get(agentDef.adapter)
  const prompt = composeContext(def, node, state, outcomes)
  try {
    let res = await adapter.invoke({ prompt, timeoutMs: node.timeoutMs })
    let verdict = VERIFYING.has(node.role) ? parseVerdict(node.id, res.output) : null
    let cost = res.costUsd
    let tokens = res.tokens

    if (VERIFYING.has(node.role) && !verdict) {
      const retry = await adapter.invoke({
        prompt: `${prompt}\n\nYour previous reply had no verdict block. Reply again ending with:\nVERDICT: pass|fail\nEVIDENCE: <reason>`,
        timeoutMs: node.timeoutMs,
      })
      cost += retry.costUsd
      tokens += retry.tokens
      verdict = parseVerdict(node.id, retry.output)
        ?? { node: node.id, status: 'fail', evidence: 'verdict unparseable' }
      res = retry
    }

    if (node.role === 'judge' && verdict && node.threshold !== undefined) {
      if ((verdict.score ?? 0) < node.threshold && verdict.status === 'pass') {
        verdict = { ...verdict, status: 'fail', evidence: `score ${verdict.score ?? 0} below threshold ${node.threshold}` }
      }
    }

    return { ...base, output: res.output, verdict, costUsd: cost, tokens, durationMs: res.durationMs }
  } catch (err) {
    return {
      ...base,
      output: '',
      verdict: { node: node.id, status: 'error', evidence: err instanceof Error ? err.message : String(err) },
    }
  }
}
