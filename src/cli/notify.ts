import { spawn } from 'node:child_process'

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
// dashboard. It is put in the notification BODY so it's visible. It is NOT
// used as a click target: macOS `display notification` can't open a URL on
// click (the click only focuses Script Editor), and `terminal-notifier`,
// the tool that can, silently drops notifications when it lacks the macOS
// notification permission most machines never granted it - a worse failure
// (no notification at all) than a click that goes nowhere. Acting on the
// notification is handled separately by auto-opening the dashboard when a
// gate waits (see cli/open-url.ts).
export type Notifier = (title: string, message: string, openUrl?: string) => void

export const desktopNotifier: Notifier = (title, message, openUrl) => {
  // VITEST: the test suite drives runAction's real gate wiring hundreds of
  // times - without this guard, `npm test` sprays real desktop notifications
  // at whoever's machine it runs on (caught live). LOOPRAIL_NO_NOTIFY: a
  // user-facing opt-out for people who don't want desktop notifications.
  if (process.env.VITEST || process.env.LOOPRAIL_NO_NOTIFY) return
  try {
    const body = openUrl ? `${message} - ${openUrl}` : message
    let cmd: string
    let args: string[]
    if (process.platform === 'darwin') {
      // The strings are embedded in an AppleScript literal, so strip the two
      // characters (backslash, double quote) that could escape it. Content is
      // looprail's own gate/run names + a localhost URL; lossy stripping is
      // fine, safety beats fidelity.
      const esc = (s: string) => s.replace(/[\\"]/g, '')
      cmd = 'osascript'
      args = ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`]
    } else if (process.platform === 'linux') {
      cmd = 'notify-send'
      args = [title, body]
    } else {
      return // no portable mechanism worth shelling out to elsewhere
    }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => { /* osascript/notify-send missing - fine */ })
    child.unref()
  } catch {
    // never let a notification failure become a run failure
  }
}
