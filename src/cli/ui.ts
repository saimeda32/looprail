import pc from 'picocolors'

export const ok = (s: string): string => pc.green(s)
export const warn = (s: string): string => pc.yellow(s)
export const err = (s: string): string => pc.red(s)
export const heading = (s: string): string => pc.bold(pc.cyan(s))
export const dim = (s: string): string => pc.dim(s)

// Cells must be plain strings (no ANSI codes) so padEnd widths stay correct;
// colorize whole lines at the call site instead.
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: string[]) =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd()
  return [pc.bold(line(headers)), ...rows.map(line)].join('\n')
}

// Word-wraps to `width` columns without ever splitting a word - a real
// agent's report summary/claim/reason text runs 100-300+ characters
// unwrapped (verified against a live run), and a terminal's own raw
// wrapping has no hanging indent, so a continuation line reads as a new
// top-level item instead of a continuation of the one above it. Callers
// own the indent themselves (see run-cmd.ts's report printing).
export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length > width && current) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  lines.push(current)
  return lines
}

export interface CliIo {
  out(line: string): void
}

export const defaultIo: CliIo = { out: (line) => console.log(line) }

// Tries a stable default port first (bookmarkable URL across repeat CLI
// invocations, instead of a fresh random port every time), falling back to
// an OS-assigned free port if that default is already taken by another
// dashboard - but only when the user didn't ask for a specific port
// themselves. An explicitly-requested --port that's taken still fails with
// `start`'s own clear "already in use" error, unchanged.
export async function startWithStableDefault<T>(
  explicitPort: number | undefined,
  defaultPort: number,
  start: (port: number | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await start(explicitPort ?? defaultPort)
  } catch (e) {
    if (explicitPort === undefined && e instanceof Error && /already in use/.test(e.message)) {
      return await start(undefined)
    }
    throw e
  }
}

// A rounded box for moments that demand attention (gate approvals). Width
// adapts to content, capped for readability; lines longer than the cap are
// wrapped by the caller (wrapText) before boxing.
export function box(lines: string[], title?: string): string[] {
  // measure on the color-stripped text so ANSI codes don't inflate widths
  // eslint-disable-next-line no-control-regex
  const bare = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '')
  const inner = Math.min(76, Math.max(24, ...lines.map((l) => bare(l).length), title ? bare(title).length + 2 : 0))
  const top = title
    ? `\u256d\u2500 ${title} ${'\u2500'.repeat(Math.max(0, inner - bare(title).length - 2))}\u256e`
    : `\u256d${'\u2500'.repeat(inner + 2)}\u256e`
  const bottom = `\u2570${'\u2500'.repeat(inner + 2)}\u256f`
  const body = lines.map((l) => `\u2502 ${l}${' '.repeat(Math.max(0, inner - bare(l).length))} \u2502`)
  return [top, ...body, bottom]
}
