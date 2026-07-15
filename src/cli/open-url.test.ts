import { afterEach, describe, expect, test, vi } from 'vitest'
import { openDashboardIfReachable } from './open-url.js'

afterEach(() => vi.unstubAllEnvs())

describe('openDashboardIfReachable', () => {
  const opened: string[] = []
  const opener = (url: string) => { opened.push(url) }
  afterEach(() => { opened.length = 0 })

  test('opens the url when the dashboard origin is reachable', async () => {
    vi.stubEnv('VITEST', '') // bypass the test-suite guard for this unit
    const ok = await openDashboardIfReachable('http://127.0.0.1:4748/run/h/r/', {
      fetcher: async () => ({ ok: true }), opener,
    })
    expect(ok).toBe(true)
    expect(opened).toEqual(['http://127.0.0.1:4748/run/h/r/'])
  })

  test('does NOT open when nothing answers (no dead tab)', async () => {
    vi.stubEnv('VITEST', '')
    const ok = await openDashboardIfReachable('http://127.0.0.1:4748/run/h/r/', {
      fetcher: async () => null, opener,
    })
    expect(ok).toBe(false)
    expect(opened).toEqual([])
  })

  test('no url is a no-op', async () => {
    vi.stubEnv('VITEST', '')
    expect(await openDashboardIfReachable(undefined, { opener })).toBe(false)
  })

  test('LOOPRAIL_NO_AUTO_OPEN suppresses it entirely (no probe, no open)', async () => {
    vi.stubEnv('VITEST', '')
    vi.stubEnv('LOOPRAIL_NO_AUTO_OPEN', '1')
    let probed = false
    const ok = await openDashboardIfReachable('http://x/', {
      fetcher: async () => { probed = true; return { ok: true } }, opener,
    })
    expect(ok).toBe(false)
    expect(probed).toBe(false)
  })

  test('the VITEST guard suppresses it by default', async () => {
    vi.stubEnv('VITEST', '1')
    expect(await openDashboardIfReachable('http://x/', { fetcher: async () => ({ ok: true }), opener })).toBe(false)
  })
})
