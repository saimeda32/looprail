import { describe, expect, test, vi, afterEach } from 'vitest'

const spawns: Array<{ cmd: string; args: string[] }> = []
vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    spawns.push({ cmd, args })
    return { on: () => {}, unref: () => {} }
  },
}))
const realPlatform = process.platform
afterEach(() => {
  spawns.length = 0
  vi.unstubAllEnvs()
  // notify tests override process.platform; restore it so no other test
  // (run concurrently or after) sees a wrong platform.
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

describe('desktopNotifier', () => {
  test('on darwin, uses osascript and puts the openUrl in the notification body', async () => {
    vi.stubEnv('VITEST', '')            // bypass the test-suite guard for this unit
    vi.stubEnv('LOOPRAIL_NO_NOTIFY', '')
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const { desktopNotifier } = await import('./notify.js')
    desktopNotifier('title', 'answer the gate', 'http://127.0.0.1:4748/run/abc/xyz/')
    const call = spawns.at(-1)!
    expect(call.cmd).toBe('osascript')
    // the URL rides in the body so it's visible (click-to-open isn't reliable)
    expect(call.args.join(' ')).toContain('http://127.0.0.1:4748/run/abc/xyz/')
  })

  test('the VITEST guard suppresses notifications by default', async () => {
    vi.stubEnv('VITEST', '1')
    const { desktopNotifier } = await import('./notify.js')
    desktopNotifier('t', 'm', 'http://x')
    expect(spawns).toHaveLength(0)
  })
})
