import { expect, test } from 'vitest'
import { doctorAction } from './doctor-cmd.js'
import type { DetectedAgent } from '../index.js'

const agent = (over: Partial<DetectedAgent>): DetectedAgent => ({
  name: 'claude', adapter: 'claude-code', command: 'claude',
  available: false, fixHint: 'install claude', ...over,
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
