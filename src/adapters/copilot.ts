import type { Adapter } from '../core/types.js'
import { CliAdapter, type ExecFn } from './cli-adapter.js'

// Best-effort adapter over the gh copilot extension. It reports no cost or
// token usage (defaults 0) and is exercised for real only behind
// LOOPRAIL_LIVE=1 - CI never shells out to gh.
export function createCopilotAdapter(
  opts: { exec?: ExecFn; cwd?: string } = {},
): Adapter {
  return new CliAdapter({
    name: 'copilot-cli',
    command: 'gh copilot suggest -t shell {prompt}',
    exec: opts.exec,
    cwd: opts.cwd,
  })
}
