import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { configAction } from './config-cmd.js'
import { readUserConfig } from '../config/user-config.js'

const setup = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lr-cfgcmd-')), 'config.json')
  const lines: string[] = []
  return { path, io: { out: (l: string) => lines.push(l) }, lines }
}

test('bare `config` lists every setting with (unset) placeholders and the file path', () => {
  const { path, io, lines } = setup()
  expect(configAction([], { io, path })).toBe(0)
  const text = lines.join('\n')
  for (const k of ['worker', 'reviewer', 'autoOpen', 'notify', 'port']) expect(text).toContain(k)
  expect(text).toContain('(unset)')
  expect(text).toContain(path)
})

test('set validates and persists; the listing then shows the value', () => {
  const { path, io, lines } = setup()
  expect(configAction(['set', 'worker', 'codex'], { io, path })).toBe(0)
  expect(configAction(['set', 'autoOpen', 'false'], { io, path })).toBe(0)
  expect(readUserConfig(path)).toEqual({ worker: 'codex', autoOpen: false })
  configAction([], { io, path })
  expect(lines.join('\n')).toContain('codex')
})

test('set rejects unknown keys and invalid values', () => {
  const { path, io, lines } = setup()
  expect(configAction(['set', 'nope', 'x'], { io, path })).toBe(1)
  expect(lines.join('\n')).toContain('unknown setting')
  expect(configAction(['set', 'port', 'abc'], { io, path })).toBe(1)
})

test('unset removes a key', () => {
  const { path, io } = setup()
  configAction(['set', 'worker', 'codex'], { io, path })
  expect(configAction(['unset', 'worker'], { io, path })).toBe(0)
  expect(readUserConfig(path)).toEqual({})
})
