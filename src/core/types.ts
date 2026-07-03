export type Role =
  | 'planner' | 'critic' | 'executor' | 'tester'
  | 'judge' | 'gate' | 'synthesizer'

export type VerdictStatus = 'pass' | 'fail' | 'stall' | 'error'

export interface Verdict {
  node: string
  status: VerdictStatus
  evidence: string
  score?: number
  weight?: number  // stamped from NodeDef.weight by the scheduler (default 1)
}

export type VerdictPolicy =
  | { kind: 'all-pass' }
  | { kind: 'quorum'; atLeast: number }
  | { kind: 'weighted'; threshold: number }  // pass-weight / total-weight >= threshold

export interface AgentRequest {
  prompt: string
  timeoutMs?: number
  model?: string    // AgentDef.model, plumbed per request (model-tiered adapters)
  command?: string  // AgentDef.command, consumed by the shell adapter
}

export interface AgentResult {
  output: string
  costUsd: number
  tokens: number
  durationMs: number
}

export interface Adapter {
  name: string
  invoke(req: AgentRequest, onChunk?: (text: string) => void): Promise<AgentResult>
}

export interface AgentDef { adapter: string; model?: string; command?: string }

export interface NodeDef {
  id: string
  role: Role
  agent?: string            // key into LoopDef.agents (agent-backed roles)
  after?: string[]          // dependency node ids
  of?: string               // critic target node id
  panel?: number | string[] // fan-out: count (same agent) or one per agent key
  rounds?: number           // planner-critic revision rounds (critics of planner)
  prompt?: string
  run?: string              // tester shell command
  expect?: string           // tester expectation, e.g. "exit 0"
  rubric?: string           // judge rubric file path or inline text
  threshold?: number        // judge pass threshold 0..1
  weight?: number           // verdict weight under the weighted policy (default 1)
  timeoutMs?: number
}

export interface Rails {
  maxIterations: number
  maxCostUsd: number
  maxWallMinutes?: number
  stallAfter?: number
  replanLimit?: number
  gateTimeoutSec?: number   // gate wait budget in seconds (absent = wait forever)
}

export interface LoopDef {
  name: string
  goal: string
  agents: Record<string, AgentDef>
  nodes: NodeDef[]
  rails: Rails
  verdictPolicy: VerdictPolicy
  concurrency?: number
}

export interface NodeOutcome {
  nodeId: string
  role: Role
  output: string
  verdict: Verdict | null
  costUsd: number
  tokens: number
  durationMs: number
  contextHash?: string
}

export type RouterDecision =
  | { action: 'verified' }
  | { action: 'iterate'; feedback: string }
  | { action: 'replan'; feedback: string }
  | { action: 'halt'; reason: string }

export interface RunReport {
  runId: string
  status: 'verified' | 'halted'
  reason: string
  iterations: number
  replans: number
  costUsd: number
  outcomes: NodeOutcome[]
}

export type GateHandler = (node: NodeDef, context: string) => Promise<boolean>

export interface JournalEvent {
  ts: number
  type: 'run_start' | 'node_start' | 'node_end' | 'node_skipped' | 'node_progress' | 'iteration_end'
        | 'replan' | 'verified' | 'halt'
  data: Record<string, unknown>
}
