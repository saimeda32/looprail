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
export type Notifier = (title: string, message: string) => void

export const desktopNotifier: Notifier = (title, message) => {
  try {
    let cmd: string
    let args: string[]
    if (process.platform === 'darwin') {
      // osascript's `display notification` - the string is embedded in an
      // AppleScript literal, so strip the two characters (backslash, double
      // quote) that could escape it. Content here is looprail's own gate/run
      // names, so lossy stripping is fine; safety beats fidelity.
      const esc = (s: string) => s.replace(/[\\"]/g, '')
      cmd = 'osascript'
      args = ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`]
    } else if (process.platform === 'linux') {
      cmd = 'notify-send'
      args = [title, message]
    } else {
      return // no portable mechanism worth shelling out to elsewhere
    }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => { /* notify-send/osascript missing - fine */ })
    child.unref()
  } catch {
    // never let a notification failure become a run failure
  }
}
