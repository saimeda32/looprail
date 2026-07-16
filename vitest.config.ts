import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // The integration tests that boot real HTTP servers and drive full runs
    // finish in ~2s alone but have been observed at 7-11s when a full-suite
    // run pegs every core with parallel workers - flaking the suite on the
    // 5s default. Different files trip it on different passes, so the
    // ceiling is global: unit tests still finish in milliseconds; only a
    // genuinely slow moment (or a real hang, which now takes 30s to report)
    // uses the headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
