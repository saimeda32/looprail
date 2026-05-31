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

export interface CliIo {
  out(line: string): void
}

export const defaultIo: CliIo = { out: (line) => console.log(line) }
