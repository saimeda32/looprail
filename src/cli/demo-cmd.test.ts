import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { demoAction } from './demo-cmd.js'
import { parseLoopfile } from '../index.js'

test('demo writes a valid mock-adapter loopfile and runs it, needing no API key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-demo-test-'))
  const lines: string[] = []
  let ranCwd: string | undefined
  const code = await demoAction({}, {
    io: { out: (l) => lines.push(l) },
    makeDir: () => dir,
    // capture the run instead of executing a real loop/dashboard
    run: async (_file, opts) => { ranCwd = opts.cwd; return 0 },
  })
  expect(code).toBe(0)
  expect(ranCwd).toBe(dir)
  // a real, parseable, mock-only loopfile was scaffolded
  const yaml = readFileSync(join(dir, 'looprail.yaml'), 'utf8')
  const def = parseLoopfile(yaml)
  expect(def.name).toBe('looprail-demo')
  expect(Object.values(def.agents).every((a) => a.adapter === 'mock')).toBe(true)
  expect(def.nodes.some((n) => n.role === 'tester')).toBe(true)
  expect(def.nodes.some((n) => n.role === 'critic')).toBe(true)
  expect(existsSync(join(dir, 'looprail.yaml'))).toBe(true)
})

test('demo actually verifies end to end on the real mock adapter (no injected run)', async () => {
  const lines: string[] = []
  const code = await demoAction({}, { io: { out: (l) => lines.push(l) } })
  expect(code).toBe(0) // the built-in mock auto-passes verifiers -> verified
  expect(lines.join('\n')).toContain('verified')
})
