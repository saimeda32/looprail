import { spawn } from 'node:child_process'
import { readUserConfig } from '../config/user-config.js'

// Opens the human's browser to a URL - the reliable "go act on this" path
// that click-to-open notifications can't deliver on macOS (see notify.ts).
// Best-effort and fire-and-forget: a run never fails, hangs, or slows down
// because a browser couldn't be opened.
//
// Guarded two ways so it never opens a useless tab:
//  - a quick reachability probe: if nothing answers at the URL's origin, no
//    dashboard is serving it, so opening would land on a connection error.
//  - LOOPRAIL_NO_AUTO_OPEN: opt-out for people who answer gates in the
//    terminal and don't want a tab appearing.
export type Fetcher = (url: string) => Promise<{ ok: boolean } | null>
export type Opener = (url: string) => void

const defaultFetcher: Fetcher = (url) =>
  fetch(url, { signal: AbortSignal.timeout(800) })
    .then((r) => ({ ok: r.ok || r.status < 500 }))
    .catch(() => null)

const defaultOpener: Opener = (url) => {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
      : 'xdg-open'
  const child = spawn(cmd, [url], { stdio: 'ignore', detached: true })
  child.on('error', () => { /* no opener on this platform - fine */ })
  child.unref()
}

export async function openDashboardIfReachable(
  url: string | undefined,
  deps: { fetcher?: Fetcher; opener?: Opener } = {},
): Promise<boolean> {
  if (!url || process.env.VITEST || process.env.LOOPRAIL_NO_AUTO_OPEN) return false
  if (readUserConfig().autoOpen === false) return false
  try {
    const origin = new URL(url).origin
    const res = await (deps.fetcher ?? defaultFetcher)(origin)
    if (!res || !res.ok) return false // no dashboard here - don't open a dead tab
    ;(deps.opener ?? defaultOpener)(url)
    return true
  } catch {
    return false
  }
}
