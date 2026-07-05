import type { Adapter, AgentRequest, AgentResult } from '../core/types.js'
import type { PermissionAnswerer } from './cli-adapter.js'

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
  // Opt-in simulation of a mid-node tool-permission prompt (see
  // cli-adapter.ts's PermissionRequest/PermissionDetector). A step with no
  // promptPermission never touches onPermission at all, so every existing
  // MockStep is byte-for-byte unaffected - this mirrors how `chunks` is
  // opt-in for streaming.
  promptPermission?: { question: string }
}

export class MockAdapter implements Adapter {
  name = 'mock'
  calls: AgentRequest[] = []
  // Records every answer this adapter actually received back from
  // onPermission, in order - this is what proves (in tests) that a human's
  // answer really reached the simulated subprocess, not just that a prompt
  // was raised.
  permissionAnswers: { approved: boolean; feedback?: string }[] = []
  private steps: (MockStep | null)[]

  constructor(steps: MockStep[]) {
    this.steps = [...steps]
  }

  async invoke(
    req: AgentRequest,
    onChunk?: (text: string) => void,
    onPermission?: PermissionAnswerer,
  ): Promise<AgentResult> {
    this.calls.push(req)
    const idx = this.steps.findIndex(
      (s) => s !== null && (!s.match || s.match.test(req.prompt)),
    )
    if (idx === -1) throw new Error(`MockAdapter exhausted for prompt: ${req.prompt.slice(0, 80)}`)
    const step = this.steps[idx]!
    this.steps[idx] = null
    if (onChunk) for (const chunk of step.chunks ?? []) onChunk(chunk)
    if (step.promptPermission && onPermission) {
      // Block resolving the step's output until the human (or test) answers,
      // exactly as a real subprocess would sit blocked on its own stdin read
      // while waiting for a permission answer.
      const result = await onPermission({
        question: step.promptPermission.question,
        answer: (approved, feedback) => (approved ? `${feedback ?? ''}y\n` : `${feedback ?? ''}n\n`),
      })
      const answered = typeof result === 'boolean' ? { approved: result } : result
      this.permissionAnswers.push({ approved: answered.approved, feedback: answered.feedback })
    }
    return {
      output: step.output,
      costUsd: step.costUsd ?? 0,
      estimatedCostUsd: step.estimatedCostUsd,
      tokens: step.tokens ?? 0,
      durationMs: 1,
    }
  }
}
