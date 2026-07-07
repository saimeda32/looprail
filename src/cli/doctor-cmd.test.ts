import { expect, test } from 'vitest'
import { doctorAction, doctorModelsAction } from './doctor-cmd.js'
import type { AdapterModelListing, DetectedAgent } from '../index.js'

const agent = (over: Partial<DetectedAgent>): DetectedAgent => ({
  name: 'claude', adapter: 'claude-code', command: 'claude',
  available: false, fixHint: 'install claude', ...over,
})

const listing = (over: Partial<AdapterModelListing>): AdapterModelListing => ({
  adapter: 'claude-code', binary: 'claude', available: true,
  models: [{ model: 'opus', source: 'static' }],
  fixHint: 'npm i -g @anthropic-ai/claude-code', ...over,
})

function capture() {
  const lines: string[] = []
  return { io: { out: (l: string) => lines.push(l) }, lines }
}

test('renders the adapter table and exits 0 when something is available', async () => {
  const { io, lines } = capture()
  const code = await doctorAction({
    detect: async () => [
      agent({ available: true, version: '1.0.35' }),
      agent({ name: 'codex', adapter: 'codex', command: 'codex', fixHint: 'codex login' }),
    ],
    io,
  })
  expect(code).toBe(0)
  const text = lines.join('\n')
  expect(text).toContain('claude-code')
  expect(text).toContain('available')
  expect(text).toContain('1.0.35')
  expect(text).toContain('codex login') // fix hint for the missing one
})

test('exits 1 with a human-first message when nothing is installed', async () => {
  const { io, lines } = capture()
  const code = await doctorAction({ detect: async () => [agent({})], io })
  expect(code).toBe(1)
  expect(lines.join('\n')).toContain('no agent CLI found')
})

test('--models renders one adapter|model|source row per model', async () => {
  const { io, lines } = capture()
  const code = await doctorModelsAction({}, {
    listModels: async () => [
      listing({
        adapter: 'codex', binary: 'codex',
        models: [
          { model: 'gpt-5.5', source: 'live' },
          { model: 'gpt-5.4', source: 'live' },
        ],
      }),
      listing({}),
    ],
    io,
  })
  expect(code).toBe(0)
  const text = lines.join('\n')
  expect(text).toContain('adapter')
  expect(text).toContain('source')
  expect(text).toMatch(/codex\s+gpt-5\.5\s+live/)
  expect(text).toMatch(/codex\s+gpt-5\.4\s+live/)
  expect(text).toMatch(/claude-code\s+opus\s+static/)
})

test('--models skips missing CLIs with the fix hint, and surfaces degradation notes', async () => {
  const { io, lines } = capture()
  const code = await doctorModelsAction({}, {
    listModels: async () => [
      listing({
        adapter: 'codex', binary: 'codex', available: false, models: [],
        fixHint: 'npm i -g @openai/codex, then `codex login`',
      }),
      listing({ note: 'claude offers no model enumeration command' }),
    ],
    io,
  })
  expect(code).toBe(0)
  const text = lines.join('\n')
  expect(text).toContain('codex: skipped - codex not installed (npm i -g @openai/codex, then `codex login`)')
  expect(text).toContain('claude-code: claude offers no model enumeration command')
  // Missing CLIs are skipped, never rendered as model rows.
  expect(text).not.toMatch(/codex\s+\S+\s+(live|static)/)
})

test('--models exits 1 with the same message as plain doctor when nothing is installed', async () => {
  const { io, lines } = capture()
  const code = await doctorModelsAction({}, {
    listModels: async () => [listing({ available: false, models: [] })],
    io,
  })
  expect(code).toBe(1)
  expect(lines.join('\n')).toContain('no agent CLI found')
})

test('--models --json emits the full listings as machine-readable JSON', async () => {
  const { io, lines } = capture()
  const listings = [
    listing({
      adapter: 'codex', binary: 'codex',
      models: [{ model: 'gpt-5.5', source: 'live' as const }],
    }),
    listing({
      adapter: 'aider', binary: 'aider', available: false, models: [],
      fixHint: 'install aider (https://aider.chat)',
    }),
  ]
  const code = await doctorModelsAction({ json: true }, { listModels: async () => listings, io })
  expect(code).toBe(0)
  const parsed = JSON.parse(lines.join('\n')) as AdapterModelListing[]
  expect(parsed).toEqual(listings)
  expect(parsed[0].models[0]).toEqual({ model: 'gpt-5.5', source: 'live' })
})

test('--models --json still exits 1 when nothing is installed', async () => {
  const { io, lines } = capture()
  const code = await doctorModelsAction({ json: true }, {
    listModels: async () => [listing({ available: false, models: [] })],
    io,
  })
  expect(code).toBe(1)
  // Output stays pure JSON even on failure - consumers parse it either way.
  expect(() => JSON.parse(lines.join('\n'))).not.toThrow()
})
