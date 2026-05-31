import { expect, test } from 'vitest'
import { err, heading, ok, renderTable, warn, dim } from './ui.js'

test('color helpers always return a string containing the input', () => {
  for (const fn of [ok, warn, err, heading, dim]) {
    expect(fn('hello')).toContain('hello')
  }
})

test('renderTable pads columns to the widest cell', () => {
  const table = renderTable(['name', 'status'], [
    ['claude-code', 'available'],
    ['gh', 'missing'],
  ])
  const lines = table.split('\n')
  expect(lines).toHaveLength(3)
  expect(lines[1]).toContain('claude-code  available')
  expect(lines[2]).toContain('gh           missing')
})
