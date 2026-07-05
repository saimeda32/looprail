import type { Adapter, AgentRequest, AgentResult } from '../core/types.js'

export interface MockStep {
  match?: RegExp
  output: string
  costUsd?: number
  estimatedCostUsd?: number
  tokens?: number
  // optional scripted streaming chunks, delivered to onChunk (if given)
  // before resolving - see design decision 1: streaming is opt-in per
  // adapter, MockAdapter only streams when a step scripts chunks, so every
  // existing MockStep (and every existing test) is byte-for-byte unaffected.
  chunks?: string[]
}

export class MockAdapter implements Adapter {
  name = 'mock'
  calls: AgentRequest[] = []
  private steps: (MockStep | null)[]

  constructor(steps: MockStep[]) {
    this.steps = [...steps]
  }

  async invoke(req: AgentRequest, onChunk?: (text: string) => void): Promise<AgentResult> {
    this.calls.push(req)
    const idx = this.steps.findIndex(
      (s) => s !== null && (!s.match || s.match.test(req.prompt)),
    )
    if (idx === -1) throw new Error(`MockAdapter exhausted for prompt: ${req.prompt.slice(0, 80)}`)
    const step = this.steps[idx]!
    this.steps[idx] = null
    if (onChunk) for (const chunk of step.chunks ?? []) onChunk(chunk)
    return {
      output: step.output,
      costUsd: step.costUsd ?? 0,
      estimatedCostUsd: step.estimatedCostUsd,
      tokens: step.tokens ?? 0,
      durationMs: 1,
    }
  }
}
