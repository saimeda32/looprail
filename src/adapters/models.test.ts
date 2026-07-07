import { expect, test } from 'vitest'
import {
  LIVE_QUERY_TIMEOUT_MS,
  listAdapterModels,
  parseAiderModelList,
  parseCodexModelCatalog,
  parseCopilotConfigModels,
  parseOllamaList,
} from './models.js'
import type { ExecFn } from './cli-adapter.js'

// Trimmed from a real `codex debug models` run (codex-cli 0.142.5) - the
// real catalog carries base_instructions blobs that add nothing to parsing.
const CODEX_CATALOG = JSON.stringify({
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 0 },
    { slug: 'gpt-5.4', display_name: 'gpt-5.4', visibility: 'list', priority: 1 },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide' },
  ],
})

// Excerpt from a real `copilot help config` run (copilot 1.0.68): the model
// block ends with a blank line before the next backticked config key.
const COPILOT_HELP_CONFIG = [
  '  `logLevel`: log level for CLI; defaults to "default".',
  '',
  '  `model`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.',
  '    - "claude-sonnet-5"',
  '    - "claude-fable-5"',
  '    - "gpt-5.5"',
  '',
  '  `contextTier`: context window tier for tiered-pricing models.',
].join('\n')

// From a real `aider --list-models anthropic/` run (aider 0.86.2): warning +
// horizontal rule + header before the bullets, and substring matching pulls
// in gateway rebrands like openrouter/anthropic/... alongside first-party ids.
const AIDER_ANTHROPIC = [
  'Warning: Input is not a terminal (fd=0).',
  '────────────────────────────────────────',
  'Models which match "anthropic/":',
  '- anthropic/claude-fable-5',
  '- anthropic/claude-haiku-4-5',
  '- openrouter/anthropic/claude-opus-4.5',
].join('\n')

const OLLAMA_LIST = [
  'NAME               ID              SIZE      MODIFIED',
  'llama3.2:latest    a80c4f17acd5    2.0 GB    3 weeks ago',
  'qwen2.5-coder:7b   2b0496514337    4.7 GB    2 days ago',
].join('\n')

test('parseCodexModelCatalog keeps listed slugs and drops hidden ones', () => {
  expect(parseCodexModelCatalog(CODEX_CATALOG)).toEqual(['gpt-5.5', 'gpt-5.4'])
})

test('parseCodexModelCatalog returns empty on non-JSON or wrong shape', () => {
  expect(parseCodexModelCatalog('not json')).toEqual([])
  expect(parseCodexModelCatalog('{"models": "nope"}')).toEqual([])
  expect(parseCodexModelCatalog('[]')).toEqual([])
})

test('parseCopilotConfigModels extracts the quoted ids under the model key only', () => {
  expect(parseCopilotConfigModels(COPILOT_HELP_CONFIG)).toEqual([
    'claude-sonnet-5', 'claude-fable-5', 'gpt-5.5',
  ])
})

test('parseCopilotConfigModels returns empty when the model block is absent', () => {
  expect(parseCopilotConfigModels('  `logLevel`: log level for CLI')).toEqual([])
})

test('parseAiderModelList collects bullet ids and ignores prose lines', () => {
  expect(parseAiderModelList(AIDER_ANTHROPIC)).toEqual([
    'anthropic/claude-fable-5',
    'anthropic/claude-haiku-4-5',
    'openrouter/anthropic/claude-opus-4.5',
  ])
  expect(parseAiderModelList('No models match "zzz/".')).toEqual([])
})

test('parseOllamaList skips the header and takes the first column', () => {
  expect(parseOllamaList(OLLAMA_LIST)).toEqual(['llama3.2:latest', 'qwen2.5-coder:7b'])
  expect(parseOllamaList('NAME ID SIZE MODIFIED\n')).toEqual([])
})

// Every binary present, every live query answering with the captured
// fixtures - the mock records timeouts so the never-hang guarantee is
// asserted alongside the happy path.
function allLiveExec(): { exec: ExecFn; timeouts: (number | undefined)[] } {
  const timeouts: (number | undefined)[] = []
  const exec: ExecFn = async (file, args, opts) => {
    if (file === '/bin/sh' && args[1]?.startsWith('command -v ')) {
      return { stdout: '/usr/local/bin/x\n', stderr: '', exitCode: 0 }
    }
    timeouts.push(opts?.timeoutMs)
    if (file === 'codex') return { stdout: CODEX_CATALOG, stderr: '', exitCode: 0 }
    if (file === 'copilot') return { stdout: COPILOT_HELP_CONFIG, stderr: '', exitCode: 0 }
    if (file === 'aider') {
      // Nonzero exit alongside a valid listing has been observed live; the
      // provider must trust the bullets, not the exit code.
      return args[1] === 'anthropic/'
        ? { stdout: AIDER_ANTHROPIC, stderr: '', exitCode: 1 }
        : { stdout: `No models match "${args[1]}".`, stderr: '', exitCode: 0 }
    }
    if (file === 'ollama') return { stdout: OLLAMA_LIST, stderr: '', exitCode: 0 }
    return { stdout: '', stderr: '', exitCode: 1 }
  }
  return { exec, timeouts }
}

test('listAdapterModels reports live models for every enumerable CLI', async () => {
  const { exec, timeouts } = allLiveExec()
  const listings = await listAdapterModels(exec)
  expect(listings.map((l) => l.adapter)).toEqual([
    'claude-code', 'codex', 'aider', 'copilot-cli', 'shell (ollama)',
  ])
  expect(listings.every((l) => l.available)).toBe(true)

  const bySource = Object.fromEntries(listings.map((l) => [l.adapter, l.models]))
  // claude has no enumeration mechanism, so it is the one honest static row.
  expect(bySource['claude-code'].every((m) => m.source === 'static')).toBe(true)
  expect(bySource['codex']).toEqual([
    { model: 'gpt-5.5', source: 'live' }, { model: 'gpt-5.4', source: 'live' },
  ])
  // Gateway rebrands (openrouter/...) are filtered to first-party ids.
  expect(bySource['aider']).toEqual([
    { model: 'anthropic/claude-fable-5', source: 'live' },
    { model: 'anthropic/claude-haiku-4-5', source: 'live' },
  ])
  expect(bySource['copilot-cli'].map((m) => m.model)).toContain('claude-fable-5')
  expect(bySource['shell (ollama)']).toEqual([
    { model: 'llama3.2:latest', source: 'live' }, { model: 'qwen2.5-coder:7b', source: 'live' },
  ])
  // Every live query carried the hard timeout - doctor must never hang.
  expect(timeouts.length).toBeGreaterThan(0)
  expect(timeouts.every((t) => t === LIVE_QUERY_TIMEOUT_MS)).toBe(true)
})

test('live query failure degrades to static lists (or an empty list) with a note', async () => {
  // Binaries all exist, but every enumeration attempt throws - the report
  // must still come back whole, downgraded, never rejected.
  const broken: ExecFn = async (file, args) => {
    if (file === '/bin/sh' && args[1]?.startsWith('command -v ')) {
      return { stdout: '/usr/local/bin/x\n', stderr: '', exitCode: 0 }
    }
    throw new Error('spawn failed')
  }
  const listings = await listAdapterModels(broken)
  const codex = listings.find((l) => l.adapter === 'codex')!
  expect(codex.models.length).toBeGreaterThan(0)
  expect(codex.models.every((m) => m.source === 'static')).toBe(true)
  expect(codex.note).toContain('codex debug models')
  const aider = listings.find((l) => l.adapter === 'aider')!
  expect(aider.models.every((m) => m.source === 'static')).toBe(true)
  const copilot = listings.find((l) => l.adapter === 'copilot-cli')!
  expect(copilot.models.every((m) => m.source === 'static')).toBe(true)
  // ollama's models are whatever this machine pulled - a static invention
  // would be a lie, so it degrades to empty-with-note instead.
  const ollama = listings.find((l) => l.adapter === 'shell (ollama)')!
  expect(ollama.models).toEqual([])
  expect(ollama.note).toContain('ollama')
})

test('missing binaries are marked unavailable with fix hints and never queried', async () => {
  const queried: string[] = []
  const nothing: ExecFn = async (file) => {
    if (file !== '/bin/sh') queried.push(file)
    return { stdout: '', stderr: '', exitCode: 1 }
  }
  const listings = await listAdapterModels(nothing)
  expect(listings.every((l) => !l.available)).toBe(true)
  expect(listings.every((l) => l.models.length === 0)).toBe(true)
  expect(listings.every((l) => l.fixHint.length > 0)).toBe(true)
  expect(queried).toEqual([])
})

test('ollama installed but with nothing pulled yields an empty live list with a hint', async () => {
  const exec: ExecFn = async (file, args) => {
    if (file === '/bin/sh' && args[1]?.startsWith('command -v ')) {
      const bin = args[1].slice('command -v '.length)
      return bin === 'ollama'
        ? { stdout: '/usr/local/bin/ollama\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 }
    }
    if (file === 'ollama') return { stdout: 'NAME ID SIZE MODIFIED\n', stderr: '', exitCode: 0 }
    return { stdout: '', stderr: '', exitCode: 1 }
  }
  const listings = await listAdapterModels(exec)
  const ollama = listings.find((l) => l.adapter === 'shell (ollama)')!
  expect(ollama.available).toBe(true)
  expect(ollama.models).toEqual([])
  expect(ollama.note).toContain('ollama pull')
})
