import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Command } from 'commander'
import { parse } from 'yaml'
import { desktopNotifier } from './notify.js'
import { runAction, type RunDeps } from './run-cmd.js'
import { defaultIo, dim, err, heading, ok, renderTable, warn } from './ui.js'

// `looprail queue` - run a list of goals unattended, sequentially, and wake
// up to a triage board instead of a stuck terminal. This is the workflow a
// bare agent CLI structurally cannot offer: it needs a human present for
// every approval, every next task, every "is it done?". Here, each item
// runs to verified or parks at its gate (see router.ts's parked branch) -
// a parked item never blocks the rest of the queue, because a human being
// asleep is exactly the situation this command exists for. In the morning:
// verified items are done (with an audit journal), parked items are one
// `looprail resume` from continuing, halted items show exactly why.
//
// Items run SEQUENTIALLY by design: looprail's agents are heavyweight CLI
// subprocesses sharing one working directory - two runs mutating the same
// checkout concurrently would corrupt each other's work, and serializing
// also keeps cost/rate-limit behavior predictable overnight.

export interface QueueItem {
  file?: string
  goal?: string
}

export interface QueueResult {
  item: QueueItem
  runId?: string
  status: 'verified' | 'parked' | 'halted' | 'error'
  reason?: string
  costUsd?: number
  estimatedCostUsd?: number
  durationMs: number
}

// queue.yaml shape:
//   queue:
//     - goal: Fix the flaky auth tests        # ./looprail.yaml, this goal
//     - file: refactor.yaml                   # a different loopfile as-is
//     - file: refactor.yaml
//       goal: Refactor the payments module    # same graph, another goal
export function parseQueueFile(text: string): QueueItem[] {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (e) {
    throw new Error(`invalid queue file:\n${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
  const queue = (raw as { queue?: unknown })?.queue
  if (!Array.isArray(queue) || queue.length === 0) {
    throw new Error('invalid queue file:\ntop-level `queue:` must be a non-empty list')
  }
  return queue.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`invalid queue file:\nitem ${i + 1} must be a map with file: and/or goal:`)
    }
    const { file, goal } = entry as { file?: unknown; goal?: unknown }
    if (file === undefined && goal === undefined) {
      throw new Error(`invalid queue file:\nitem ${i + 1} needs a file: or a goal: (or both)`)
    }
    if (file !== undefined && typeof file !== 'string') {
      throw new Error(`invalid queue file:\nitem ${i + 1} file: must be a string`)
    }
    if (goal !== undefined && typeof goal !== 'string') {
      throw new Error(`invalid queue file:\nitem ${i + 1} goal: must be a string`)
    }
    return { ...(file !== undefined ? { file } : {}), ...(goal !== undefined ? { goal } : {}) }
  })
}

function itemLabel(item: QueueItem): string {
  const label = item.goal ?? item.file ?? ''
  return label.length > 60 ? `${label.slice(0, 57)}...` : label
}

export interface QueueOpts {
  cwd: string
  gateTimeout?: number
  yes?: boolean
  json?: boolean
}

export async function queueAction(
  file: string | undefined,
  opts: QueueOpts,
  deps: RunDeps = {},
): Promise<number> {
  const io = deps.io ?? defaultIo
  const queuePath = resolve(opts.cwd, file ?? 'queue.yaml')
  let items: QueueItem[]
  try {
    items = parseQueueFile(readFileSync(queuePath, 'utf8'))
  } catch (e) {
    io.out(err(e instanceof Error ? e.message : String(e)))
    return 1
  }

  const results: QueueResult[] = []
  for (const [i, item] of items.entries()) {
    if (!opts.json) io.out(heading(`[${i + 1}/${items.length}] ${itemLabel(item)}`))
    // Each item runs through the ordinary runAction in json mode so its
    // machine-readable summary line is capturable here - the queue's own
    // per-item header + final triage table replace the per-run rendering.
    const lines: string[] = []
    const started = Date.now()
    const code = await runAction(item.file, {
      cwd: opts.cwd,
      json: true,
      yes: opts.yes,
      goal: item.goal,
      // An unattended queue must never hang forever on a gate nobody is
      // watching - park (resumable, zero repeated work) and move on. A
      // loopfile's own explicit gate_timeout always wins over this default.
      defaultGateTimeoutSec: opts.gateTimeout ?? 120,
    }, { ...deps, io: { out: (l: string) => lines.push(l) } })
    const durationMs = Date.now() - started
    let summary: { runId?: string; status?: string; reason?: string; costUsd?: number; estimatedCostUsd?: number } = {}
    try {
      summary = JSON.parse(lines.at(-1) ?? '{}') as typeof summary
    } catch {
      // a code-1 failure (lint, missing file) prints prose, not JSON
    }
    const status: QueueResult['status'] = code === 0 ? 'verified'
      : code === 2 && summary.reason?.startsWith('parked') ? 'parked'
      : code === 2 ? 'halted'
      : 'error'
    results.push({
      item, status, durationMs,
      runId: summary.runId, reason: summary.reason,
      costUsd: summary.costUsd, estimatedCostUsd: summary.estimatedCostUsd,
    })
    if (!opts.json) {
      const line = status === 'verified' ? ok(`verified (${(durationMs / 1000).toFixed(0)}s)`)
        : status === 'parked' ? warn(`parked - awaiting your approval (${summary.runId})`)
        : err(`${status}${summary.reason ? ` - ${summary.reason}` : ''}`)
      io.out(`  ${line}`)
    }
  }

  const verified = results.filter((r) => r.status === 'verified').length
  const parked = results.filter((r) => r.status === 'parked').length
  const failed = results.length - verified - parked

  if (opts.json) {
    io.out(JSON.stringify({ total: results.length, verified, parked, failed, results }))
  } else {
    io.out('')
    io.out(heading('queue triage'))
    io.out(renderTable(
      ['#', 'item', 'status', 'run', 'cost'],
      results.map((r, i) => [
        String(i + 1), itemLabel(r.item), r.status, r.runId ?? '-',
        r.costUsd !== undefined
          ? `$${r.costUsd.toFixed(2)}${r.estimatedCostUsd ? ` (~$${r.estimatedCostUsd.toFixed(2)} est)` : ''}`
          : '-',
      ]),
    ))
    io.out(`  ${verified} verified · ${parked} parked · ${failed} halted/error`)
    for (const r of results.filter((x) => x.status === 'parked')) {
      io.out(dim(`  resume parked: looprail resume ${r.runId} (or from mission control)`))
    }
  }

  const notifier = deps.notifier ?? desktopNotifier
  notifier(
    'looprail - queue finished',
    `${verified}/${results.length} verified${parked ? `, ${parked} parked awaiting approval` : ''}${failed ? `, ${failed} halted` : ''}`,
  )
  return verified === results.length ? 0 : 2
}

export function registerQueue(program: Command): void {
  program
    .command('queue [file]')
    .description('run a list of goals unattended, sequentially (default queue.yaml) - verified items finish, gated items park for morning triage (exit 0 all verified, 2 otherwise)')
    .option('--gate-timeout <sec>', 'park a gated item after this many seconds with no answer, when its loopfile sets no gate_timeout of its own (default: 120)', (v: string) => Number(v))
    .option('--yes', 'auto-approve every gate (fully unattended, no parking)')
    .option('--json', 'machine-readable triage summary on stdout')
    .action(async (
      file: string | undefined,
      opts: { gateTimeout?: number; yes?: boolean; json?: boolean },
      cmd: Command,
    ) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = await queueAction(file, { cwd, ...opts })
    })
}
