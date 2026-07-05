import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every test process gets its own fake home directory. Without this, any
// test that exercises a code path keyed off the real home dir (most notably
// runAction's auto-registration in run-cmd.ts, which falls back to
// defaultRegistryPath() -> homedir()/.looprail/workspaces.json whenever a
// test forgets to inject an explicit registryPath) writes straight into the
// developer's real ~/.looprail state. That happened: a full test run left
// hundreds of throwaway temp-dir paths permanently registered in a real
// machine's workspaces.json. Redirecting HOME here means no test, present or
// future, can touch real user state by omission — it would have to reach for
// the real os.homedir() explicitly, which nothing in this codebase does.
const fakeHome = mkdtempSync(join(tmpdir(), 'looprail-test-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

// No test process may make a real network call by omission. This bit us
// once already (the fakeHome fix above) for on-disk state; the same
// principle applies to the pricing module's default fetch - any adapter or
// pricing test that doesn't explicitly inject a fetchFn/loadTable would
// otherwise silently hit raw.githubusercontent.com on every run, making the
// suite slow, flaky offline, and dependent on a third party. Stubbing the
// global fetch to always reject means every such test instead exercises the
// documented fallback (empty/cached table -> no estimate), fast and
// deterministic. Tests that specifically need to verify fetch behavior
// inject their own fetchFn and are unaffected by this stub.
globalThis.fetch = (() => Promise.reject(new Error('network calls are disabled in tests'))) as typeof fetch
