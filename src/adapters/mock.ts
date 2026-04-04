import type { Adapter, AgentRequest, AgentResult } from '../core/types.js'

export interface MockStep {
  match?: RegExp
  output: string
  costUsd?: number
  tokens?: number
}

export class MockAdapter implements Adapter {
  name = 'mock'
  calls: AgentRequest[] = []
  private steps: (MockStep | null)[]

  constructor(steps: MockStep[]) {
    this.steps = [...steps]
  }

  async invoke(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req)
    const idx = this.steps.findIndex(
      (s) => s !== null && (!s.match || s.match.test(req.prompt)),
    )
    if (idx === -1) throw new Error(`MockAdapter exhausted for prompt: ${req.prompt.slice(0, 80)}`)
    const step = this.steps[idx]!
    this.steps[idx] = null
    return {
      output: step.output,
      costUsd: step.costUsd ?? 0,
      tokens: step.tokens ?? 0,
      durationMs: 1,
    }
  }
}
