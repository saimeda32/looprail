import { spawn, spawnSync } from 'node:child_process'

// Best-effort desktop notification - fire-and-forget, never throws, never
// blocks, never awaited. A run must never fail, hang, or even slow down
// because a notification couldn't be shown; a machine with no notification
// mechanism simply doesn't get one.
//
// This exists because of a real, live-observed failure mode: a run did
// everything right - planned, survived review, built, passed its tests -
// and then died at its human gate purely because the human wasn't looking
// at the terminal during the gate_timeout window. A gate beginning to wait
// is precisely the moment the human's attention is REQUIRED and the one
// moment the tool previously had no way to request it.
//
// `openUrl`, when given, is where the human should GO to act - the run's
// dashboard, deep-linked. Clicking a plain macOS `display notification`
// only focuses Script Editor (the app that ran osascript), useless when
// what you need is to open the dashboard and answer the gate. So when a URL
// is supplied AND `terminal-notifier` is installed, the notification is
// delivered through it with `-open <url>` so the click opens the dashboard.
// Without terminal-notifier we fall back to the plain notification with the
// URL in its body so it is at least visible.
export type Notifier = (title: string, message: string, openUrl?: string) => void

// One-time cached detection: terminal-notifier is the clean way to get a
// click-to-open-URL notification on macOS. spawnSync runs at most once per
// process, off the hot path (only when a gate first needs a human).
let hasTerminalNotifier: boolean | undefined
function terminalNotifierAvailable(): boolean {
  if (hasTerminalNotifier === undefined) {
    try {
      hasTerminalNotifier = spawnSync('command', ['-v', 'terminal-notifier'], {
        shell: true, stdio: 'ignore',
      }).status === 0
    } catch {
      hasTerminalNotifier = false
    }
  }
  return hasTerminalNotifier
}

export const desktopNotifier: Notifier = (title, message, openUrl) => {
  // VITEST: the test suite drives runAction's real gate wiring hundreds of
  // times - without this guard, `npm test` sprays real desktop notifications
  // at whoever's machine it runs on (caught live). LOOPRAIL_NO_NOTIFY: a
  // user-facing opt-out for people who don't want desktop notifications.
  if (process.env.VITEST || process.env.LOOPRAIL_NO_NOTIFY) return
  try {
    let cmd: string
    let args: string[]
    if (process.platform === 'darwin') {
      if (openUrl && terminalNotifierAvailable()) {
        // argv passthrough (no shell) - no escaping needed; the click opens
        // the dashboard.
        cmd = 'terminal-notifier'
        args = ['-title', title, '-message', message, '-open', openUrl]
      } else {
        // osascript's `display notification` - strings are embedded in an
        // AppleScript literal, so strip the two chars (backslash, quote) that
        // could escape it. The URL rides in the body so it stays visible when
        // the click can't open it.
        const esc = (s: string) => s.replace(/[\\"]/g, '')
        const body = openUrl ? `${message} - open ${openUrl}` : message
        cmd = 'osascript'
        args = ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`]
      }
    } else if (process.platform === 'linux') {
      // notify-send has no portable click-to-open, so the URL rides in the body.
      cmd = 'notify-send'
      args = [title, openUrl ? `${message} - open ${openUrl}` : message]
    } else {
      return // no portable mechanism worth shelling out to elsewhere
    }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => { /* the notifier binary is missing - fine */ })
    child.unref()
  } catch {
    // never let a notification failure become a run failure
  }
}
