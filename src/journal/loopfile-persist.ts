import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LoopDef } from '../core/types.js'

// The filename a run's own directory persists its resolved LoopDef under.
export const RUN_LOOPFILE_NAME = 'loopfile.json'

// Persists the currently-resolved LoopDef (the STATIC bootstrap graph on a
// run's first write - see cli/run-cmd.ts's runAction and
// cli/resume-cmd.ts's resumeAction - then the splice-extended graph after
// each successful generates:'graph' splice - see engine/runner.ts's
// applySplice) into the run's OWN directory, alongside its journal.jsonl.
//
// Without this, a run's dashboard-ability (graph edges, per-node
// agent/model) depended entirely on re-reading the ORIGINAL workspace's
// looprail.yaml from scratch on every render - unlike
// ~/.looprail/runs/<hash>/<runId>/journal.jsonl, which already lives
// independent of the workspace that produced it (see journal/runs.ts). If
// that workspace directory is later deleted or moved (e.g. a git worktree
// cleaned up after merging), the run's own history became unrenderable as a
// graph even though its journal was still intact. Serializing the resolved
// LoopDef directly (rather than re-serializing back to YAML) is simpler and
// more robust - it needs no round trip through the loopfile parser.
//
// Best-effort, mirroring cli/run-cmd.ts's writeRunPid: a run must never
// fail just because this couldn't be written (permissions, a full disk,
// ...).
export function persistRunLoopDef(runDir: string, def: LoopDef): void {
  try {
    writeFileSync(join(runDir, RUN_LOOPFILE_NAME), JSON.stringify(def))
  } catch {
    // swallowed - see comment above
  }
}

// Reads a run's own persisted LoopDef copy back, if one was ever written.
// Returns undefined (never throws) when the file is missing - the case for
// every run that predates this fix - or unreadable/corrupt for any reason;
// callers fall back to re-reading the original workspace's looprail.yaml in
// that case (see dashboard/mission-control-server.ts's bestEffortLoopDef and
// cli/ui-cmd.ts's loadExpandedLoopDef).
export function loadRunLoopDef(runDir: string): LoopDef | undefined {
  try {
    const path = join(runDir, RUN_LOOPFILE_NAME)
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, 'utf8')) as LoopDef
  } catch {
    return undefined
  }
}
