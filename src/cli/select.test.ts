import { describe, expect, test } from 'vitest'
import { decodeKey, decodeKeys, reduceKey, renderSelect, type SelectState } from './select.js'

describe('decodeKey', () => {
  test('maps arrows, vim keys, enter, and ctrl-c', () => {
    expect(decodeKey(Buffer.from('\u001b[A'))).toBe('up')
    expect(decodeKey(Buffer.from('\u001b[B'))).toBe('down')
    expect(decodeKey(Buffer.from('k'))).toBe('up')
    expect(decodeKey(Buffer.from('j'))).toBe('down')
    expect(decodeKey(Buffer.from('\r'))).toBe('enter')
    expect(decodeKey(Buffer.from('\u0003'))).toBe('cancel')
    expect(decodeKey(Buffer.from('x'))).toBe('other')
  })
})

// Buffered chunks: several keys can arrive in ONE stdin data event -
// keystrokes typed while a previous prompt resolved come in together.
test('decodeKeys splits a buffered chunk into individual keys', () => {
  expect(decodeKeys(Buffer.from('\r\r\r'))).toEqual(['enter', 'enter', 'enter'])
  expect(decodeKeys(Buffer.from('\u001b[B\u001b[B\r'))).toEqual(['down', 'down', 'enter'])
  expect(decodeKeys(Buffer.from('jk\r'))).toEqual(['down', 'up', 'enter'])
})

describe('reduceKey', () => {
  const s = (index: number): SelectState => ({ index, count: 3 })
  test('up/down move and wrap at both ends', () => {
    expect(reduceKey(s(0), 'down').index).toBe(1)
    expect(reduceKey(s(2), 'down').index).toBe(0) // wrap bottom -> top
    expect(reduceKey(s(0), 'up').index).toBe(2)   // wrap top -> bottom
  })
  test('other keys leave the state alone', () => {
    expect(reduceKey(s(1), 'other')).toEqual(s(1))
    expect(reduceKey(s(1), 'enter')).toEqual(s(1))
  })
})

describe('renderSelect', () => {
  test('marks the highlighted row with the pointer, dims the rest', () => {
    const lines = renderSelect('Pick one', ['alpha', 'beta'], 1)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('Pick one')
    expect(lines[1]).not.toContain('> ')
    expect(lines[2]).toContain('> beta')
  })

  test('truncates long labels so re-render line counts stay stable', () => {
    const long = 'x'.repeat(300)
    const lines = renderSelect('q', [long], 0, 40)
    expect(lines[1].includes('...')).toBe(true)
  })
})
