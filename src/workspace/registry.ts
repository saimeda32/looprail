import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

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

export function readRegistry(path: string): WorkspaceRegistry {
  if (!existsSync(path)) return emptyRegistry()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WorkspaceRegistry>
    return {
      workspaces: Array.isArray(parsed.workspaces)
        ? parsed.workspaces.filter((w): w is string => typeof w === 'string')
        : [],
    }
  } catch {
    // corrupt registry file — treat as empty rather than crash every `run`
    // and every `ui --all` invocation on the machine until a human notices.
    return emptyRegistry()
  }
}

export function writeRegistry(path: string, reg: WorkspaceRegistry): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(reg, null, 2) + '\n')
}

function requireAbsolute(workspacePath: string): void {
  if (!isAbsolute(workspacePath)) {
    throw new Error(`workspace path must be absolute, got: ${workspacePath}`)
  }
}

export function addWorkspace(path: string, workspacePath: string): WorkspaceRegistry {
  requireAbsolute(workspacePath)
  const reg = readRegistry(path)
  if (!reg.workspaces.includes(workspacePath)) reg.workspaces.push(workspacePath)
  writeRegistry(path, reg)
  return reg
}

export function removeWorkspace(path: string, workspacePath: string): WorkspaceRegistry {
  requireAbsolute(workspacePath)
  const reg = readRegistry(path)
  reg.workspaces = reg.workspaces.filter((w) => w !== workspacePath)
  writeRegistry(path, reg)
  return reg
}

export function listWorkspaces(path: string): string[] {
  return readRegistry(path).workspaces
}
