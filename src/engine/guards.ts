import type { JournalEvent, LoopDef, Verdict } from '../core/types.js'
import {
  compareProtected, hasChanges, matchesAny, scopeVerdict, snapshotFiltered,
  tamperVerdict, type ProtectedChanges,
} from './protect.js'
import {
  checkNewDeps, depsVerdict, liveRegistryProbe, parseManifests, type Registry, type RegistryProbe,
} from './deps-rail.js'
import {
  compareStrength, measureStrength, weakerTestsVerdict, type StrengthSnapshot,
} from './test-strength.js'

// The deterministic file-guard rails, gathered into one place so runLoop
// doesn't carry five interleaved baseline-and-counter blocks. Each rail
// anchors verification to something the model can't fake - file hashes,
// registry responses, assertion counts - and none needs its own model call,
// which is what keeps them ungameable. GuardSet owns their run-scoped state
// (baselines, the ratcheting test-strength floor, per-rail repeat counters)
// and evaluates all of them for an iteration in one call.
//
// Behavior is exactly what runLoop did inline before this extraction: a
// violation becomes a deterministic fail verdict appended to the iteration's
// verdict set (never pushed into `outcomes`, so cache/skipped bookkeeping
// never sees a synthetic node), the event is journaled, and a SECOND
// consecutive violation of any one rail returns a halt reason.

export interface GuardEvent {
  type: JournalEvent['type']
  data: Record<string, unknown>
}

export interface GuardEvaluation {
  // Deterministic fail verdicts to fold into the iteration's verdict set.
  verdicts: Verdict[]
  // Journal events to emit for this iteration's guard findings.
  events: GuardEvent[]
  // Set when any one rail has now fired twice in a row: the executor was
  // told to fix it and didn't, so stop. Null otherwise.
  escalationHalt: string | null
}

const EMPTY: GuardEvaluation = { verdicts: [], events: [], escalationHalt: null }

export class GuardSet {
  private constructor(
    private readonly dir: string,
    private readonly registryProbe: RegistryProbe,
    private readonly inProtect: (p: string) => boolean,
    private readonly outOfScope: (p: string) => boolean,
    private readonly guardInclude: (p: string) => boolean,
    private guardBaseline: Record<string, string> | undefined,
    private depsBaseline: Map<Registry, Set<string>> | undefined,
    private strengthFloor: StrengthSnapshot | undefined,
  ) {}

  // Whether any rail is configured at all - lets runLoop skip the whole
  // dance (and its filesystem walks) when no guard is in play.
  get active(): boolean {
    return this.guardBaseline !== undefined
      || this.depsBaseline !== undefined
      || this.strengthFloor !== undefined
  }

  private consecutiveTampers = 0
  private consecutiveScopeCreep = 0
  private consecutiveWeakenings = 0

  // Captures the run-start baselines. Called AFTER planning (planners
  // produce text, not file edits) and naturally re-taken on resume - a
  // human's edits between runs are legitimate, an agent's during the run
  // are not.
  static async create(
    def: LoopDef, dir: string, registryProbe: RegistryProbe = liveRegistryProbe,
  ): Promise<GuardSet> {
    const inProtect = (p: string): boolean => def.protect !== undefined && matchesAny(p, def.protect)
    const outOfScope = (p: string): boolean => def.scope !== undefined && !matchesAny(p, def.scope)
    const guardInclude = (p: string): boolean => inProtect(p) || outOfScope(p)
    // protect watches files MATCHING its globs, scope watches files OUTSIDE
    // its allowlist - one filesystem walk covers both via the combined
    // predicate.
    const guardBaseline = (def.protect || def.scope)
      ? await snapshotFiltered(dir, guardInclude)
      : undefined
    const depsBaseline = def.verifyDeps ? parseManifests(dir) : undefined
    const strengthFloor = def.noWeakerTests ? await measureStrength(dir) : undefined
    return new GuardSet(
      dir, registryProbe, inProtect, outOfScope, guardInclude,
      guardBaseline, depsBaseline, strengthFloor,
    )
  }

  async evaluate(iteration: number): Promise<GuardEvaluation> {
    if (!this.active) return EMPTY
    const verdicts: Verdict[] = []
    const events: GuardEvent[] = []
    let escalationHalt: string | null = null

    if (this.guardBaseline) {
      const changes = compareProtected(this.guardBaseline, await snapshotFiltered(this.dir, this.guardInclude))
      const pick = (test: (p: string) => boolean): ProtectedChanges => ({
        modified: changes.modified.filter(test),
        deleted: changes.deleted.filter(test),
        added: changes.added.filter(test),
      })
      const tamperChanges = pick(this.inProtect)
      // A file can trip both rails (a protected test file that is also out
      // of scope) - reported under protect, the sharper rule, not both.
      const scopeChanges = pick((p) => this.outOfScope(p) && !this.inProtect(p))
      if (hasChanges(tamperChanges)) {
        verdicts.push(tamperVerdict(tamperChanges))
        this.consecutiveTampers += 1
        events.push({ type: 'protect_violation', data: { iteration, ...tamperChanges } })
      } else {
        this.consecutiveTampers = 0
      }
      if (hasChanges(scopeChanges)) {
        verdicts.push(scopeVerdict(scopeChanges))
        this.consecutiveScopeCreep += 1
        events.push({ type: 'scope_violation', data: { iteration, ...scopeChanges } })
      } else {
        this.consecutiveScopeCreep = 0
      }
    }

    if (this.depsBaseline) {
      const depsResult = await checkNewDeps(this.depsBaseline, parseManifests(this.dir), this.registryProbe)
      if (depsResult.missing.length + depsResult.young.length + depsResult.unchecked.length > 0) {
        events.push({ type: 'deps_check', data: { iteration, ...depsResult } })
      }
      const fail = depsVerdict(depsResult)
      if (fail) verdicts.push(fail)
    }

    if (this.strengthFloor) {
      const current = await measureStrength(this.dir)
      const weaker = compareStrength(this.strengthFloor, current)
      if (weaker) {
        verdicts.push(weakerTestsVerdict(weaker))
        this.consecutiveWeakenings += 1
        events.push({ type: 'test_strength_violation', data: { iteration, ...weaker } })
      } else {
        this.consecutiveWeakenings = 0
        this.strengthFloor = current // ratchet: growth becomes the new floor
      }
    }

    // A second consecutive violation of any one rail: told to fix, didn't.
    if (this.consecutiveTampers >= 2) {
      escalationHalt = 'protected files were modified again after an explicit revert instruction (protect rail) - see the protect_violation events in the journal'
    } else if (this.consecutiveScopeCreep >= 2) {
      escalationHalt = 'files outside the declared scope were changed again after an explicit revert instruction (scope rail) - see the scope_violation events in the journal'
    } else if (this.consecutiveWeakenings >= 2) {
      escalationHalt = 'the test suite was weakened again after an explicit restore instruction (no_weaker_tests rail) - see the test_strength_violation events in the journal'
    }

    return { verdicts, events, escalationHalt }
  }
}
