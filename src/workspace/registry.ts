import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface WorkspaceRegistry {
  workspaces: string[]
}

// ~/.looprail/workspaces.json — the one file that makes `looprail ui --all`
// know which project directories to scan. Kept deliberately dumb: an array
// of absolute paths, deduped, in registration order. No timestamps, no
// per-workspace metadata — everything else (status, agents, cost) is derived
// fresh from each workspace's own .looprail/runs/ on every scan (Task 8), so
// this file never goes stale in a way that matters (see design decision 7).
export function defaultRegistryPath(): string {
  return join(homedir(), '.looprail', 'workspaces.json')
}

function emptyRegistry(): WorkspaceRegistry {
  return { workspaces: [] }
}

// Collapse the many spellings of one path (a trailing slash, a `..` segment, a
// doubled separator) to a single canonical form, so `/foo` and `/foo/` are not
// listed as two distinct workspaces. resolve() normalizes and strips the
// trailing slash; inputs here are already absolute, so it never injects cwd.
function normalizeWorkspacePath(workspacePath: string): string {
  return resolve(workspacePath)
}

function dedupeNormalized(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    const norm = normalizeWorkspacePath(p)
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
  }
  return out
}

export function readRegistry(path: string): WorkspaceRegistry {
  if (!existsSync(path)) return emptyRegistry()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WorkspaceRegistry>
    return {
      workspaces: Array.isArray(parsed.workspaces)
        ? dedupeNormalized(parsed.workspaces.filter((w): w is string => typeof w === 'string'))
        : [],
    }
  } catch {
    // corrupt registry file — treat as empty rather than crash every `run`
    // and every `ui --all` invocation on the machine until a human notices.
    return emptyRegistry()
  }
}

// Atomic: write to a temp file in the same directory, then renameSync over the
// target. rename is atomic on the same filesystem, so a concurrent reader (e.g.
// a `looprail ui --all` poll tick) always observes either the old file or the
// fully-written new one, never a half-written target mid-write.
export function writeRegistry(path: string, reg: WorkspaceRegistry): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n')
  renameSync(tmp, path)
}

// Sub-millisecond-friendly synchronous sleep for the lock retry loop, without
// pulling in a dependency: block this thread for `ms` on a throwaway shared
// buffer nothing ever notifies.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// A dependency-free, best-effort exclusive lock around a read-modify-write.
// mkdirSync of the lock dir is atomic and throws EEXIST if another process
// already holds it, so two `looprail run` invocations starting within the same
// second serialize instead of each reading the registry, mutating its own copy,
// and clobbering the other's registration (a lost update). This is not
// distributed-systems-grade: after a timeout we assume the holder crashed and
// left a stale lock, and proceed anyway rather than deadlock forever.
function withRegistryLock<T>(path: string, fn: () => T): T {
  const lockDir = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + 2000
  let held = false
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir)
      held = true
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      sleepSync(20)
    }
  }
  try {
    return fn()
  } finally {
    if (held) {
      try {
        rmdirSync(lockDir)
      } catch {
        // best-effort release: if the lock dir is already gone, nothing to do.
      }
    }
  }
}

function requireAbsolute(workspacePath: string): void {
  if (!isAbsolute(workspacePath)) {
    throw new Error(`workspace path must be absolute, got: ${workspacePath}`)
  }
}

export function addWorkspace(path: string, workspacePath: string): WorkspaceRegistry {
  requireAbsolute(workspacePath)
  const normalized = normalizeWorkspacePath(workspacePath)
  return withRegistryLock(path, () => {
    const reg = readRegistry(path)
    if (!reg.workspaces.includes(normalized)) reg.workspaces.push(normalized)
    writeRegistry(path, reg)
    return reg
  })
}

export function removeWorkspace(path: string, workspacePath: string): WorkspaceRegistry {
  requireAbsolute(workspacePath)
  const normalized = normalizeWorkspacePath(workspacePath)
  return withRegistryLock(path, () => {
    const reg = readRegistry(path)
    reg.workspaces = reg.workspaces.filter((w) => w !== normalized)
    writeRegistry(path, reg)
    return reg
  })
}

export function listWorkspaces(path: string): string[] {
  return readRegistry(path).workspaces
}
