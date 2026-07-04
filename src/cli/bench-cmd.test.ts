import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { benchAction } from './bench-cmd.js'
import { createRegistry } from '../adapters/registry.js'
import { MockAdapter } from '../adapters/mock.js'
import type { CliIo } from './ui.js'

function captureIo(): { io: CliIo; lines: string[] } {
  const lines: string[] = []
  return { io: { out: (l) => lines.push(l) }, lines }
}

const BASELINE = `
name: fixture-baseline
goal: produce DONE
agents:
  a: { adapter: mock }
graph:
  do:   { role: executor, agent: a }
  crit: { role: critic, agent: a, of: do, after: do }
rails:
  max_iterations: 1
  max_cost_usd: 5
verdict: { policy: all-pass }
`

const LOOPRAIL = BASELINE.replace('fixture-baseline', 'fixture-looprail')

const BENCH = `
name: fixture
task: demo task
repeat: 2
configs:
  - id: baseline
    loopfile: baseline.yaml
  - id: looprail
    loopfile: looprail.yaml
`

function scaffold(): string {
  const dir = mkdtempSync(join(tmpdir(), 'looprail-bench-cmd-'))
  writeFileSync(join(dir, 'bench.yaml'), BENCH)
  writeFileSync(join(dir, 'baseline.yaml'), BASELINE)
  writeFileSync(join(dir, 'looprail.yaml'), LOOPRAIL)
  return dir
}

function registryFor() {
  const reg = createRegistry()
  reg.register(new MockAdapter([
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ]))
  return reg
}

test('runs a valid benchfile and prints a comparison table', async () => {
  const cwd = scaffold()
  const { io, lines } = captureIo()
  const code = await benchAction('bench.yaml', { cwd }, { registryFor, io })
  expect(code).toBe(0)
  const out = lines.join('\n')
  expect(out).toContain('baseline')
  expect(out).toContain('looprail')
})

test('--json prints a parseable comparison', async () => {
  const cwd = scaffold()
  const { io, lines } = captureIo()
  const code = await benchAction('bench.yaml', { cwd, json: true }, { registryFor, io })
  expect(code).toBe(0)
  const parsed = JSON.parse(lines[0])
  expect(parsed.configs).toHaveLength(2)
})

test('defaults to bench.yaml when no file is given', async () => {
  const cwd = scaffold()
  const { io, lines } = captureIo()
  const code = await benchAction(undefined, { cwd }, { registryFor, io })
  expect(code).toBe(0)
  expect(lines.join('\n')).toContain('fixture')
})

test('missing benchfile exits 1 with a clear error', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'looprail-bench-cmd-empty-'))
  const { io, lines } = captureIo()
  const code = await benchAction('bench.yaml', { cwd }, { io })
  expect(code).toBe(1)
  expect(lines.join('\n')).toContain('no benchfile at')
})

test('an invalid benchfile exits 1 with the parse error', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'looprail-bench-cmd-bad-'))
  writeFileSync(join(cwd, 'bench.yaml'), 'name: x')
  const { io, lines } = captureIo()
  const code = await benchAction('bench.yaml', { cwd }, { io })
  expect(code).toBe(1)
  expect(lines.join('\n')).toContain('invalid benchfile')
})

test('a config pointing at a missing loopfile exits 1', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'looprail-bench-cmd-missingref-'))
  writeFileSync(join(cwd, 'bench.yaml'), BENCH)
  writeFileSync(join(cwd, 'baseline.yaml'), BASELINE)
  // looprail.yaml intentionally absent
  const { io, lines } = captureIo()
  const code = await benchAction('bench.yaml', { cwd }, { io })
  expect(code).toBe(1)
  expect(lines.join('\n')).toContain('config "looprail"')
})

test('a config that fails lint exits 1', async () => {
  const cwd = scaffold()
  // no verifying node at all -> L001
  writeFileSync(join(cwd, 'baseline.yaml'), `
name: no-verifier
goal: g
agents:
  a: { adapter: mock }
graph:
  do: { role: executor, agent: a }
rails:
  max_iterations: 1
  max_cost_usd: 5
verdict: { policy: all-pass }
`)
  const { io, lines } = captureIo()
  const code = await benchAction('bench.yaml', { cwd }, { io })
  expect(code).toBe(1)
  expect(lines.join('\n')).toContain('failed lint')
})
