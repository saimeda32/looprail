import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Verdict } from '../core/types.js'

// The hallucinated-dependency rail (`verify_deps: true`): when an iteration
// ADDS packages to a manifest, each new name is checked against its public
// registry. ~20% of agent-suggested packages are hallucinations, and
// attackers squat the recurring fake names (slopsquatting) - an agent that
// auto-adds dependencies skips exactly the verification a human would do.
//
// What each finding means, honestly:
// - `missing`  - the package does not exist: a hallucination (or typo).
//   Deterministic fail with a fix instruction.
// - `young`    - the package exists but was first published very recently:
//   the classic squat signal. Informational (journaled + surfaced in the
//   run), never a fail on its own - young legitimate packages exist.
// - `unchecked` - the registry couldn't be reached: said out loud, never
//   silently treated as either verified or missing.
// A package that exists, is old, and is malicious is out of scope - that
// is a supply-chain scanner's job, not a loop rail's.

export type Registry = 'npm' | 'pypi'

export interface RegistryProbeResult {
  exists: boolean
  createdAt?: number // epoch ms of first publish, when the registry reports it
}

export type RegistryProbe = (registry: Registry, name: string) => Promise<RegistryProbeResult>

// Manifest parsing is deliberately minimal and read-only: npm's
// package.json (dependencies + devDependencies) and python's
// requirements.txt (name tokens before any version/marker syntax). More
// ecosystems can be added here without touching the rail logic.
export function parseManifests(cwd: string): Map<Registry, Set<string>> {
  const out = new Map<Registry, Set<string>>()
  const pkgPath = join(cwd, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>; devDependencies?: Record<string, string>
      }
      const names = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ])
      if (names.size > 0) out.set('npm', names)
    } catch {
      // unparseable manifest: the tester/critic will surface that on its own
    }
  }
  const reqPath = join(cwd, 'requirements.txt')
  if (existsSync(reqPath)) {
    const names = new Set<string>()
    for (const raw of readFileSync(reqPath, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#') || line.startsWith('-')) continue
      const name = line.split(/[=<>!~\[; ]/)[0].trim().toLowerCase()
      if (name) names.add(name)
    }
    if (names.size > 0) out.set('pypi', names)
  }
  return out
}

export interface DepFinding { registry: Registry; name: string }
export interface YoungDepFinding extends DepFinding { ageDays: number }

export interface DepsCheckResult {
  missing: DepFinding[]
  young: YoungDepFinding[]
  unchecked: DepFinding[]
}

const YOUNG_DAYS = 90

export async function checkNewDeps(
  baseline: Map<Registry, Set<string>>,
  current: Map<Registry, Set<string>>,
  probe: RegistryProbe,
  now: () => number = Date.now,
): Promise<DepsCheckResult> {
  const result: DepsCheckResult = { missing: [], young: [], unchecked: [] }
  for (const [registry, names] of current) {
    const before = baseline.get(registry) ?? new Set<string>()
    for (const name of names) {
      if (before.has(name)) continue // only NEWLY added names are probed
      try {
        const probed = await probe(registry, name)
        if (!probed.exists) {
          result.missing.push({ registry, name })
        } else if (probed.createdAt !== undefined) {
          const ageDays = Math.floor((now() - probed.createdAt) / (24 * 60 * 60 * 1000))
          if (ageDays < YOUNG_DAYS) result.young.push({ registry, name, ageDays })
        }
      } catch {
        result.unchecked.push({ registry, name })
      }
    }
  }
  return result
}

// Only nonexistent packages fail the iteration; a young package is a
// journaled signal for the human, because failing on it would block every
// legitimately new library.
export function depsVerdict(result: DepsCheckResult): Verdict | null {
  if (result.missing.length === 0) return null
  const names = result.missing.map((m) => `${m.name} (${m.registry})`).join(', ')
  return {
    node: '__deps__',
    status: 'fail',
    evidence: `newly added dependencies do not exist in their registry: ${names} - these are hallucinated (or typo'd) package names; remove or correct them. Installing a similarly-named package that DOES exist may be a squatted malicious lookalike - verify the intended library's real name.`,
  }
}

// Live registry probe: HEAD-ish GET against the public registries, with the
// created date extracted where the registry reports one. Injected in tests;
// the runner passes this real one.
export async function liveRegistryProbe(registry: Registry, name: string): Promise<RegistryProbeResult> {
  const url = registry === 'npm'
    ? `https://registry.npmjs.org/${encodeURIComponent(name)}`
    : `https://pypi.org/pypi/${encodeURIComponent(name)}/json`
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (res.status === 404) return { exists: false }
  if (!res.ok) throw new Error(`registry ${registry} answered ${res.status} for ${name}`)
  try {
    const body = await res.json() as { time?: { created?: string }; urls?: unknown; releases?: Record<string, Array<{ upload_time_iso_8601?: string }>> }
    if (registry === 'npm' && body.time?.created) {
      return { exists: true, createdAt: Date.parse(body.time.created) }
    }
    if (registry === 'pypi' && body.releases) {
      const times = Object.values(body.releases).flat()
        .map((r) => r.upload_time_iso_8601 ? Date.parse(r.upload_time_iso_8601) : NaN)
        .filter((t) => Number.isFinite(t))
      if (times.length > 0) return { exists: true, createdAt: Math.min(...times) }
    }
  } catch {
    // body parse failure: existence is already known from the status code
  }
  return { exists: true }
}
