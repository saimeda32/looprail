import type { Adapter, AgentRequest } from '../core/types.js'
import { CliAdapter, type ExecFn } from './cli-adapter.js'

export function createAiderAdapter(
  opts: { exec?: ExecFn; cwd?: string } = {},
): Adapter {
  return new CliAdapter({
    name: 'aider',
    command: 'aider --message {prompt} --yes-always --no-auto-commits --no-stream --no-pretty',
    extraArgs: (req: AgentRequest) => (req.model ? ['--model', req.model] : []),
    exec: opts.exec,
    cwd: opts.cwd,
  })
}
