import { dim, ok } from './ui.js'

// A hand-rolled arrow-key selector - the premium first-run feel without a
// prompt-library dependency. Architecture keeps the untestable part tiny:
// pure state/render functions (unit-tested) + a thin raw-mode shell that
// only wires stdin bytes to the reducer and lines to the terminal.
//
// Non-TTY (CI, pipes) falls back to the numbered prompt the caller already
// had - behavior there is byte-identical to before.

export interface SelectState {
  index: number
  count: number
}

// Keys we act on, decoded from raw stdin bytes. Everything else is ignored.
export type SelectKey = 'up' | 'down' | 'enter' | 'cancel' | 'other'

const ESC = '\u001b'
const CTRL_C = '\u0003'

export function decodeKey(buf: Buffer): SelectKey {
  return decodeKeys(buf)[0] ?? 'other'
}

// A single stdin chunk can carry SEVERAL keys: keystrokes buffered while a
// previous prompt was resolving arrive together (caught live - three
// buffered enters came in as one chunk, decoded as 'other', and the flow
// stalled). Scan the chunk into individual key events.
export function decodeKeys(buf: Buffer): SelectKey[] {
  const s = buf.toString('utf8')
  const keys: SelectKey[] = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === CTRL_C) { keys.push('cancel'); continue }
    if (ch === '\r' || ch === '\n') { keys.push('enter'); continue }
    if (ch === ESC && s[i + 1] === '[') {
      if (s[i + 2] === 'A') { keys.push('up'); i += 2; continue }
      if (s[i + 2] === 'B') { keys.push('down'); i += 2; continue }
      i += 2 // an escape sequence we don't act on - skip it whole
      continue
    }
    if (ch === 'k') { keys.push('up'); continue }
    if (ch === 'j') { keys.push('down'); continue }
    keys.push('other')
  }
  return keys
}

export function reduceKey(state: SelectState, key: SelectKey): SelectState {
  if (key === 'up') return { ...state, index: (state.index - 1 + state.count) % state.count }
  if (key === 'down') return { ...state, index: (state.index + 1) % state.count }
  return state
}

// Renders the full prompt block. The highlighted row gets the pointer and
// color; the rest are dimmed. Labels are truncated to the terminal width so
// re-rendering line counts stay stable (a wrapped line would desync the
// cursor-up math in the shell).
export function renderSelect(
  question: string, choices: string[], index: number, width = 100,
): string[] {
  const lines = [`${question} ${dim('(up/down, enter to choose)')}`]
  for (let i = 0; i < choices.length; i++) {
    const label = choices[i].length > width - 4 ? `${choices[i].slice(0, width - 5)}...` : choices[i]
    lines.push(i === index ? ok(`> ${label}`) : dim(`  ${label}`))
  }
  return lines
}

// The raw-mode shell. Resolves with the chosen label; a ctrl-c restores the
// terminal and rejects so the caller can exit cleanly.
export async function interactiveSelect(
  question: string, choices: string[],
  streams: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream } = {},
): Promise<string> {
  const stdin = streams.stdin ?? process.stdin
  const stdout = streams.stdout ?? process.stdout
  let state: SelectState = { index: 0, count: choices.length }
  // Some ptys report 0 or tiny columns (expect's default winsize, minimal
  // CI shells); a floor keeps labels readable rather than truncated stubs.
  const width = Math.max(60, stdout.columns || 100)

  const draw = (first: boolean): void => {
    const lines = renderSelect(question, choices, state.index, width)
    if (!first) stdout.write(`${ESC}[${lines.length}A`) // cursor up: redraw in place
    for (const line of lines) stdout.write(`${ESC}[2K${line}\n`) // clear + write
  }

  return new Promise<string>((resolvePick, rejectPick) => {
    const wasRaw = stdin.isRaw
    stdin.setRawMode?.(true)
    stdin.resume()
    draw(true)
    const onData = (buf: Buffer): void => {
      for (const key of decodeKeys(buf)) {
        if (key === 'up' || key === 'down') {
          state = reduceKey(state, key)
          draw(false)
          continue
        }
        if (key === 'enter' || key === 'cancel') {
          stdin.removeListener('data', onData)
          stdin.setRawMode?.(wasRaw ?? false)
          stdin.pause()
          if (key === 'cancel') rejectPick(new Error('selection canceled'))
          else resolvePick(choices[state.index])
          return // later buffered keys belong to the NEXT prompt, not this one
        }
      }
    }
    stdin.on('data', onData)
  })
}

// True when a real human terminal is on both ends - the only situation the
// raw-mode UI is appropriate for.
export function canInteract(
  stdin: NodeJS.ReadStream = process.stdin, stdout: NodeJS.WriteStream = process.stdout,
): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function')
}
