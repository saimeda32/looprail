import { describe, expect, test, vi, afterEach } from 'vitest'

// The notifier shells out; capture the spawn to assert the command + args
// without firing a real notification. VITEST guard is bypassed by importing
// after stubbing env so we can exercise the real branch logic.
const spawns: Array<{ cmd: string; args: string[] }> = []
vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    spawns.push({ cmd, args })
    return { on: () => {}, unref: () => {} }
  },
  spawnSync: () => ({ status: 0 }), // pretend terminal-notifier is present
}))

afterEach(() => { spawns.length = 0; vi.unstubAllEnvs() })

describe('desktopNotifier openUrl', () => {
  test('on darwin with terminal-notifier present, a URL uses `terminal-notifier -open <url>`', async () => {
    vi.stubEnv('VITEST', '')            // bypass the test-suite guard for this unit
    vi.stubEnv('LOOPRAIL_NO_NOTIFY', '')
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const { desktopNotifier } = await import('./notify.js')
    desktopNotifier('title', 'answer the gate', 'http://127.0.0.1:4748/run/abc/xyz/')
    const call = spawns.at(-1)!
    expect(call.cmd).toBe('terminal-notifier')
    expect(call.args).toContain('-open')
    expect(call.args).toContain('http://127.0.0.1:4748/run/abc/xyz/')
  })

  test('the VITEST guard suppresses notifications by default', async () => {
    vi.stubEnv('VITEST', '1')
    const { desktopNotifier } = await import('./notify.js')
    desktopNotifier('t', 'm', 'http://x')
    expect(spawns).toHaveLength(0)
  })
})
