import { expect, test } from 'vitest'
import { err, heading, ok, renderTable, warn, dim, wrapText, startWithStableDefault } from './ui.js'

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

test('startWithStableDefault tries the default port when the user gave none', async () => {
  const ports: (number | undefined)[] = []
  const result = await startWithStableDefault(undefined, 4747, async (port) => {
    ports.push(port)
    return `ok:${port}`
  })
  expect(ports).toEqual([4747])
  expect(result).toBe('ok:4747')
})

test('startWithStableDefault tries only the user-given port, never the default', async () => {
  const ports: (number | undefined)[] = []
  await startWithStableDefault(9999, 4747, async (port) => {
    ports.push(port)
    return 'ok'
  })
  expect(ports).toEqual([9999])
})

test('startWithStableDefault falls back to no-port (OS-assigned) when the default is already in use', async () => {
  const ports: (number | undefined)[] = []
  const result = await startWithStableDefault(undefined, 4747, async (port) => {
    ports.push(port)
    if (port === 4747) throw new Error('port 4747 is already in use - stop whatever is using it')
    return `ok:${port}`
  })
  expect(ports).toEqual([4747, undefined])
  expect(result).toBe('ok:undefined')
})

test('startWithStableDefault does not retry an explicit port that is already in use', async () => {
  const ports: (number | undefined)[] = []
  await expect(startWithStableDefault(9999, 4747, async (port) => {
    ports.push(port)
    throw new Error('port 9999 is already in use - stop whatever is using it')
  })).rejects.toThrow(/already in use/)
  expect(ports).toEqual([9999])
})

test('startWithStableDefault rethrows an unrelated error without retrying', async () => {
  const ports: (number | undefined)[] = []
  await expect(startWithStableDefault(undefined, 4747, async (port) => {
    ports.push(port)
    throw new Error('boom')
  })).rejects.toThrow('boom')
  expect(ports).toEqual([4747])
})

// box(): attention-demanding moments (gate cards). Widths measured on
// color-stripped text so ANSI never inflates the frame.
test('box wraps content with a title and pads to a stable inner width', async () => {
  const { box } = await import('./ui.js')
  const lines = box(['hello', 'a longer line here'], 'gate: approve')
  expect(lines[0]).toContain('gate: approve')
  expect(lines.at(-1)!.length).toBeGreaterThan(10)
  // every body line renders the same visual width once colors are stripped
  const widths = lines.slice(1, -1).map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').length)
  expect(new Set(widths).size).toBe(1)
})
