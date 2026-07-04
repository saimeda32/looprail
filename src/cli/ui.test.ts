import { expect, test } from 'vitest'
import { err, heading, ok, renderTable, warn, dim, wrapText } from './ui.js'

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

test('wrapText never splits a word, even when a single word exceeds the width', () => {
  expect(wrapText('a bb ccc dddd', 5)).toEqual(['a bb', 'ccc', 'dddd'])
  expect(wrapText('supercalifragilistic word', 5)).toEqual(['supercalifragilistic', 'word'])
})

test('wrapText fits as many whole words per line as fit within width', () => {
  expect(wrapText('the quick brown fox jumps', 12)).toEqual(['the quick', 'brown fox', 'jumps'])
})

test('wrapText returns a single empty line for empty or whitespace-only input', () => {
  expect(wrapText('', 40)).toEqual([''])
  expect(wrapText('   ', 40)).toEqual([''])
})

test('wrapText returns the text unwrapped when it already fits', () => {
  expect(wrapText('short line', 40)).toEqual(['short line'])
})
