import { execa } from 'execa'
import type {
  Adapter, AgentRequest, AgentResult, PermissionAnswerer, PermissionRequest,
} from '../core/types.js'
// Re-exported so existing imports of PermissionRequest/PermissionAnswerer
// from this module (e.g. cli-adapter.test.ts) keep working - the canonical
// definitions now live in core/types.ts because PermissionAnswerer appears
// in the Adapter.invoke signature there.
export type { PermissionAnswerer, PermissionRequest } from '../core/types.js'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

// Per-adapter seam: given one complete stdout line, decide whether it is an
// ordinary line (return null) or a permission-prompt moment (return the
// PermissionRequest describing it). See cli-adapter.test.ts for the shape
// each adapter implements this against.
export type PermissionDetector = (line: string) => PermissionRequest | null

export type ExecFn = (
  file: string,
  args: string[],
  opts?: {
    input?: string
    timeoutMs?: number
    cwd?: string
    onChunk?: (text: string) => void
    // Extra env for this subprocess, merged over the inherited process env
    // (AgentDef.env -> AgentRequest.env). Used to point a single agent's CLI
    // at a per-provider caching/optimizing proxy.
    env?: Record<string, string>
    // Configuring a permissionDetector is what turns on the writable-stdin
    // path below - the common no-prompt case never sets this and keeps
    // today's stdin:'ignore' behavior untouched.
    permissionDetector?: PermissionDetector
    onPermission?: PermissionAnswerer
  },
) => Promise<ExecResult>

export const defaultExec: ExecFn = async (file, args, opts = {}) => {
  // Only a configured permissionDetector opens a writable stdin pipe. The
  // common no-prompt path (opts.permissionDetector unset) is completely
  // unaffected: stdin still closes immediately rather than sitting open and
  // unfed, which is exactly the claude -p stall this default was written to
  // avoid in the first place.
  const needsWritableStdin = opts.permissionDetector !== undefined
  const subprocess = execa(file, args, {
    input: opts.input, timeout: opts.timeoutMs, cwd: opts.cwd, reject: false,
    // execa extends process.env by default, so this MERGES rather than
    // replaces - the CLI keeps its normal environment plus the proxy vars.
    ...(opts.env ? { env: opts.env } : {}),
    // Without an explicit input, leave stdin closed rather than an open,
    // unfed pipe - a CLI that auto-detects piped input (claude -p does)
    // can stall for several seconds waiting to see if anything arrives on
    // an ambiguous open pipe, then fail. There is never anything to pipe
    // when opts.input is unset (every adapter using {prompt}-substitution
    // instead of stdin mode), so there is nothing lost by closing it -
    // *unless* a permissionDetector is configured, in which case a human
    // answer may need to reach this exact subprocess's stdin later.
    stdin: opts.input === undefined ? (needsWritableStdin ? 'pipe' : 'ignore') : undefined,
  })
  // Streaming is best-effort: execa's own stdout stream is available on the
  // in-flight subprocess handle before it resolves. A caller that never
  // passes onChunk (every call site that existed before this plan) never
  // touches this branch, so the final-string behavior this function still
  // returns below is unchanged for them.
  if (opts.onChunk) {
    const onChunk = opts.onChunk
    subprocess.stdout?.on('data', (chunk: Buffer) => onChunk(chunk.toString('utf8')))
  }
  if (opts.permissionDetector) {
    const detect = opts.permissionDetector
    const onPermission = opts.onPermission
    // A second, independent line-buffer over the same stdout stream. This is
    // deliberately separate from the onChunk/streamHandler buffer above:
    // detection is orthogonal to what gets displayed, and must keep working
    // even for adapters with no streamHandler configured at all.
    let buffer = ''
    subprocess.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const req = detect(line)
        if (!req || !onPermission) continue
        // Fire-and-forget from this handler's point of view: the subprocess
        // itself is already blocked on its own stdin read, so there is
        // nothing further to pause here - awaiting the human's answer and
        // then writing it back is all that's needed to unblock it.
        void onPermission(req).then((result) => {
          const approved = typeof result === 'boolean' ? result : result.approved
          const feedback = typeof result === 'boolean' ? undefined : result.feedback
          subprocess.stdin?.write(req.answer(approved, feedback))
        })
      }
    })
  }
  const res = await subprocess
  return {
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
    exitCode: res.exitCode ?? 1,
  }
}

export interface ParsedResponse {
  output: string
  costUsd?: number
  tokens?: number
  // See AgentResult.estimatedCostUsd/inputTokens/outputTokens in
  // core/types.ts - same meaning here, mapped straight through by
  // CliAdapter.invoke without ever touching costUsd/tokens.
  estimatedCostUsd?: number
  inputTokens?: number
  outputTokens?: number
  // See AgentResult.resolvedModel in core/types.ts.
  resolvedModel?: string
}

export type ResponseParser = (stdout: string) => ParsedResponse

// Turns one complete line of a CLI's own wire format into text worth showing
// a person, or null to show nothing for that line. Needed because raw stdout
// bytes are rarely readable on their own: claude-code and codex both emit
// newline-delimited JSON (a structured event per line, not prose), so
// forwarding raw chunks straight to a live-output pane just prints unparsed
// JSON. A line handler is what makes streaming mean something.
export type LineHandler = (line: string) => string | null

// Chunk boundaries rarely land on line boundaries, so raw pieces are buffered
// until a full line is available before handleLine ever sees one.
export function lineBufferedTransform(
  handleLine: LineHandler, onChunk: (text: string) => void,
): (raw: string) => void {
  let buffer = ''
  return (raw: string) => {
    buffer += raw
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const text = handleLine(line)
      if (text) onChunk(text)
    }
  }
}

// Post-parse hook for adapters whose CLI never reports a real dollar cost
// (copilot, codex, aider): given the request (for a pinned AgentRequest.model)
// and the parsed response (for split tokens / a resolved model), returns a
// pricing-derived estimate, or undefined when no estimate is computable
// (unknown model, no token counts). Never invoked if the parser itself
// already produced an estimatedCostUsd. Injectable so adapter tests can mock
// pricing lookups instead of exercising the real fetch/cache module.
export type CostEstimator = (
  req: AgentRequest,
  parsed: ParsedResponse,
) => number | undefined | Promise<number | undefined>

export interface CliAdapterOptions {
  name: string
  command: string     // whitespace-tokenized argv template; the token {prompt} becomes one arg
  stdin?: boolean     // pipe the prompt to stdin instead of substituting {prompt}
  parser?: ResponseParser
  streamHandler?: LineHandler  // turns each raw stdout line into live-output text, if the CLI's format needs it
  exec?: ExecFn
  cwd?: string
  extraArgs?: (req: AgentRequest) => string[]  // per-request args appended after the template
  estimator?: CostEstimator
  // Recognizes this CLI's own mid-node tool-permission prompt on its stdout,
  // and describes how to answer it back on stdin. Leaving this unset (every
  // adapter today) keeps stdin closed exactly as before - see defaultExec.
  permissionDetector?: PermissionDetector
}

export class CliAdapter implements Adapter {
  readonly name: string
  private readonly exec: ExecFn

  constructor(private readonly opts: CliAdapterOptions) {
    this.name = opts.name
    this.exec = opts.exec ?? defaultExec
    if (!opts.stdin && !opts.command.includes('{prompt}')) {
      throw new Error(
        `adapter "${opts.name}": command template must contain {prompt} or set stdin mode`,
      )
    }
  }

  async invoke(
    req: AgentRequest,
    onChunk?: (text: string) => void,
    onPermission?: PermissionAnswerer,
  ): Promise<AgentResult> {
    const started = Date.now()
    const tokens = this.opts.command.split(/\s+/).filter(Boolean)
    const [file, ...args] = tokens.map((t) => (t === '{prompt}' ? req.prompt : t))
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs(req))
    const wrappedOnChunk = onChunk && this.opts.streamHandler
      ? lineBufferedTransform(this.opts.streamHandler, onChunk)
      : onChunk
    const res = await this.exec(file, args, {
      input: this.opts.stdin ? req.prompt : undefined,
      timeoutMs: req.timeoutMs,
      cwd: this.opts.cwd,
      env: req.env,
      onChunk: wrappedOnChunk,
      permissionDetector: this.opts.permissionDetector,
      onPermission,
    })
    if (res.exitCode !== 0) {
      throw new Error(
        `${this.name} exited ${res.exitCode}: ${(res.stderr || res.stdout).slice(-400)}`,
      )
    }
    const parsed = this.opts.parser?.(res.stdout) ?? { output: res.stdout.trim() }
    // Only consult the estimator when the parser itself didn't already
    // produce an estimate - claude-code's parser never sets estimatedCostUsd
    // and never gets an estimator wired in, so this branch is a no-op there.
    const estimatedCostUsd = parsed.estimatedCostUsd ?? (await this.opts.estimator?.(req, parsed))
    return {
      output: parsed.output,
      costUsd: parsed.costUsd ?? 0,
      tokens: parsed.tokens ?? 0,
      estimatedCostUsd,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      resolvedModel: parsed.resolvedModel,
      durationMs: Date.now() - started,
    }
  }
}
