import { defaultExec, type ExecFn, type ExecResult } from './cli-adapter.js'

export type ModelSource = 'live' | 'static'

export interface AdapterModel {
  model: string
  source: ModelSource
}

export interface AdapterModelListing {
  adapter: string   // looprail adapter id (or a labeled variant, e.g. "shell (ollama)")
  binary: string    // binary probed on PATH
  available: boolean
  models: AdapterModel[]
  note?: string     // degradation/context line surfaced under the doctor table
  fixHint: string   // install/login one-liner, same role as DetectedAgent.fixHint
}

// Hard ceiling per live query: doctor must never hang on a CLI that decides
// to wait for a TTY (aider's first-run analytics prompt does exactly this on
// a fresh install) or on a daemon that is down (ollama). On expiry the query
// degrades to the static list, or to an empty list with a note.
export const LIVE_QUERY_TIMEOUT_MS = 5_000

// defaultExec never rejects (execa runs with reject:false), but injected
// ExecFns and pathological spawn failures can still throw - one CLI's
// misbehavior must not take down the whole doctor report.
async function tryExec(exec: ExecFn, file: string, args: string[]): Promise<ExecResult> {
  try {
    return await exec(file, args, { timeoutMs: LIVE_QUERY_TIMEOUT_MS })
  } catch (e) {
    return { stdout: '', stderr: e instanceof Error ? e.message : String(e), exitCode: 1 }
  }
}

// `codex debug models` renders the raw model catalog as one JSON object:
// {"models":[{"slug":"gpt-5.5","visibility":"list",...},...]}. Verified live
// against codex-cli 0.142.5 (2026-07). Entries with visibility "hide" are
// internal-only (e.g. codex-auto-review) and are not selectable via -m, so
// they are dropped here.
export function parseCodexModelCatalog(stdout: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const models = (parsed as { models?: unknown }).models
  if (!Array.isArray(models)) return []
  const out: string[] = []
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue
    const { slug, visibility } = entry as { slug?: unknown; visibility?: unknown }
    if (typeof slug !== 'string') continue
    if (visibility === 'hide') continue
    out.push(slug)
  }
  return out
}

// copilot has no `models` subcommand, but `copilot help config` enumerates
// every selectable model id as a quoted bullet under the `model`: key -
// verified live against copilot 1.0.68 (2026-07). The block ends at the
// first line that is not a quoted bullet (a blank line before the next key).
export function parseCopilotConfigModels(stdout: string): string[] {
  const lines = stdout.split('\n')
  const start = lines.findIndex((l) => /^\s*`model`:/.test(l))
  if (start === -1) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    const m = /^\s*-\s*"([^"]+)"\s*$/.exec(line)
    if (!m) break
    out.push(m[1])
  }
  return out
}

// `aider --list-models <search>` prints a rule + a "Models which match ..."
// header, then one `- <id>` bullet per match (verified live, aider 0.86.2).
// Warning/header lines never start with "- ", so bullets are the whole
// signal; "No models match" output simply yields no bullets.
export function parseAiderModelList(stdout: string): string[] {
  const out: string[] = []
  for (const line of stdout.split('\n')) {
    const m = /^-\s+(\S+)\s*$/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

// `ollama list` prints a NAME/ID/SIZE/MODIFIED header then one row per
// locally pulled model; the model name is the first whitespace-delimited
// column of each row.
export function parseOllamaList(stdout: string): string[] {
  const out: string[] = []
  for (const [i, line] of stdout.split('\n').entries()) {
    if (i === 0 || !line.trim()) continue
    const name = line.trim().split(/\s+/)[0]
    if (name) out.push(name)
  }
  return out
}

// claude offers no enumeration mechanism at all - verified 2026-07 against
// claude v2.1.201: its 200+-line --help documents --model only with prose
// alias examples ("e.g. 'fable', 'opus', or 'sonnet'"), and a bare
// `claude models` is read as a *prompt* (it runs the agent). These are the
// documented aliases; the list will rot as Anthropic ships new families,
// which is exactly why every other adapter here queries live.
const CLAUDE_STATIC_MODELS = ['fable', 'opus', 'sonnet', 'haiku']

// Snapshot of `codex debug models` visibility:"list" slugs (codex-cli
// 0.142.5, 2026-07) for when the live query fails; rots as OpenAI rotates
// the catalog, so it only exists as a degraded fallback.
const CODEX_STATIC_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2']

// Snapshot of `copilot help config`'s `model` block (copilot 1.0.68,
// 2026-07); rots fast - copilot's catalog changes per release - so it only
// exists as a degraded fallback.
const COPILOT_STATIC_MODELS = [
  'claude-sonnet-5', 'claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-haiku-4.5',
  'claude-fable-5', 'claude-opus-4.8', 'claude-opus-4.8-fast', 'claude-opus-4.7',
  'claude-opus-4.6', 'claude-opus-4.5', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex',
  'gpt-5.4-mini', 'gpt-5-mini', 'gemini-3.1-pro-preview', 'gemini-3.5-flash',
  'kimi-k2.7-code',
]

// Tiny flagship slice of aider's catalog (aider 0.86.2, 2026-07) for when
// every live query fails; the real catalog is thousands of ids and only the
// live query can be trusted, so this rots by design.
const AIDER_STATIC_MODELS = [
  'anthropic/claude-fable-5', 'anthropic/claude-opus-4-5', 'anthropic/claude-haiku-4-5',
  'openai/chatgpt-4o-latest', 'gemini/gemini-2.0-flash',
]

// aider fronts the entire litellm catalog - thousands of ids, most of them
// gateway rebrands (openrouter/..., vercel_ai_gateway/...) of the same
// models - and its search is substring-based, so an unscoped query would
// swamp the table. Scoping to first-party prefixes keeps vendor parity
// across the major providers without privileging any one of them.
const AIDER_PREFIXES = ['anthropic/', 'openai/', 'gemini/']

const asLive = (models: string[]): AdapterModel[] =>
  models.map((model) => ({ model, source: 'live' as const }))
const asStatic = (models: string[]): AdapterModel[] =>
  models.map((model) => ({ model, source: 'static' as const }))

interface ModelQuery {
  models: AdapterModel[]
  note?: string
}

interface ModelProvider {
  adapter: string
  binary: string
  fixHint: string
  listModels(exec: ExecFn): Promise<ModelQuery>
}

const PROVIDERS: ModelProvider[] = [
  {
    adapter: 'claude-code', binary: 'claude',
    fixHint: 'npm i -g @anthropic-ai/claude-code, then run `claude` once to log in',
    async listModels() {
      return {
        models: asStatic(CLAUDE_STATIC_MODELS),
        note: 'claude offers no model enumeration command - showing its documented aliases, which may lag new releases',
      }
    },
  },
  {
    adapter: 'codex', binary: 'codex',
    fixHint: 'npm i -g @openai/codex, then `codex login`',
    async listModels(exec) {
      const res = await tryExec(exec, 'codex', ['debug', 'models'])
      const live = res.exitCode === 0 ? parseCodexModelCatalog(res.stdout) : []
      if (live.length > 0) return { models: asLive(live) }
      return {
        models: asStatic(CODEX_STATIC_MODELS),
        note: '`codex debug models` failed - showing a static snapshot (codex-cli 0.142.5)',
      }
    },
  },
  {
    adapter: 'aider', binary: 'aider',
    fixHint: 'install aider (https://aider.chat), set your provider API key env var',
    async listModels(exec) {
      const results = await Promise.all(AIDER_PREFIXES.map(async (prefix) => {
        // --yes-always because a fresh install's first-run analytics prompt
        // otherwise blocks waiting for a TTY answer (observed live, aider
        // 0.86.2 - the query would always burn its whole timeout);
        // --no-check-update skips a version-check network call that only
        // adds latency here. aider's exit code is not gated on: a valid
        // listing has been observed alongside a nonzero exit, so the bullets
        // themselves are the only trustworthy signal.
        const res = await tryExec(exec, 'aider', ['--list-models', prefix, '--yes-always', '--no-check-update'])
        // Substring search means "anthropic/" also matches
        // "openrouter/anthropic/..."; keep first-party ids only.
        return parseAiderModelList(res.stdout).filter((m) => m.startsWith(prefix))
      }))
      const live = [...new Set(results.flat())]
      if (live.length > 0) return { models: asLive(live) }
      return {
        models: asStatic(AIDER_STATIC_MODELS),
        note: '`aider --list-models` failed - showing a tiny static slice (aider 0.86.2); the real catalog is much larger',
      }
    },
  },
  {
    // Probes/queries the standalone `copilot` binary, not `gh` - the copilot
    // adapter itself drives that binary directly (see copilot.ts for why
    // going through `gh` broke auth), so its catalog is the honest one.
    adapter: 'copilot-cli', binary: 'copilot',
    fixHint: 'npm i -g @github/copilot, then `copilot login`',
    async listModels(exec) {
      const res = await tryExec(exec, 'copilot', ['help', 'config'])
      const live = res.exitCode === 0 ? parseCopilotConfigModels(res.stdout) : []
      if (live.length > 0) return { models: asLive(live) }
      return {
        models: asStatic(COPILOT_STATIC_MODELS),
        note: '`copilot help config` failed - showing a static snapshot (copilot 1.0.68)',
      }
    },
  },
  {
    // looprail reaches ollama through the shell adapter today (no dedicated
    // ollama adapter), but it is the local-model source, so its pulled
    // models belong in this report - labeled so nobody looks for an
    // "ollama" adapter id in a loopfile.
    adapter: 'shell (ollama)', binary: 'ollama',
    fixHint: 'install ollama (https://ollama.com), then `ollama pull <model>`',
    async listModels(exec) {
      const res = await tryExec(exec, 'ollama', ['list'])
      const live = res.exitCode === 0 ? parseOllamaList(res.stdout) : []
      if (live.length > 0) return { models: asLive(live) }
      // No static fallback can make sense here: ollama runs whatever this
      // machine pulled, so inventing a list would be a lie.
      return {
        models: [],
        note: res.exitCode === 0
          ? 'no local models pulled yet - `ollama pull <model>` to add one'
          : '`ollama list` failed - is the ollama daemon running?',
      }
    },
  },
]

export async function listAdapterModels(exec: ExecFn = defaultExec): Promise<AdapterModelListing[]> {
  return Promise.all(
    PROVIDERS.map(async (p): Promise<AdapterModelListing> => {
      const found = await tryExec(exec, '/bin/sh', ['-c', `command -v ${p.binary}`])
      if (found.exitCode !== 0) {
        return { adapter: p.adapter, binary: p.binary, available: false, models: [], fixHint: p.fixHint }
      }
      const { models, note } = await p.listModels(exec)
      return {
        adapter: p.adapter, binary: p.binary, available: true, models,
        fixHint: p.fixHint, ...(note ? { note } : {}),
      }
    }),
  )
}
