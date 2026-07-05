import type { Rails } from './types.js'

export interface RailBreach {
  rail: 'iterations' | 'cost' | 'wall'
  detail: string
}

export class RailsGuard {
  private spent = 0
  // Separate accumulator for pricing-derived estimates (copilot/codex/aider,
  // whose CLIs never report a real dollar cost - see src/core/pricing.ts).
  // Tracked apart from `spent` so a caller can always tell real spend from
  // estimated spend; check() breaches on the combined total so max_cost_usd
  // can actually fire for an estimate-only loop, which was the whole point.
  private estimatedSpent = 0
  private readonly startedAt: number
  // Wall-clock time spent blocked on a gate awaiting a human answer -
  // never counted toward max_wall_minutes (see beginGateWait/endGateWait).
  // A human deciding slowly isn't the loop "taking too long to do work";
  // charging it against the same budget as real agent time would halt a
  // run on a rail breach that has nothing to do with actual work.
  private pausedMs = 0
  private pauseStartedAt: number | null = null

  constructor(private rails: Rails, private now: () => number = Date.now) {
    this.startedAt = this.now()
  }

  // Call immediately before awaiting a gate's human answer, and
  // endGateWait() immediately after it resolves (see engine/nodes.ts's
  // gate-role branch) - brackets exactly the real wall-clock span spent
  // waiting, however long that turns out to be.
  beginGateWait(): void {
    if (this.pauseStartedAt === null) this.pauseStartedAt = this.now()
  }

  endGateWait(): void {
    if (this.pauseStartedAt === null) return
    this.pausedMs += this.now() - this.pauseStartedAt
    this.pauseStartedAt = null
  }

  // Total real elapsed time minus every completed (and any still-open)
  // gate-wait span - the actual "how long has real work been happening"
  // figure that both remainingWallMs and check()'s wall breach are based
  // on. Still-open pause is included so a rail check that somehow runs
  // WHILE paused (defensive only - a gate await blocks the scheduler, so
  // this shouldn't happen in practice) never double-counts that open span.
  private workingElapsedMs(): number {
    const openPause = this.pauseStartedAt === null ? 0 : this.now() - this.pauseStartedAt
    return (this.now() - this.startedAt) - this.pausedMs - openPause
  }

  // `estimatedUsd` defaults to 0 so every existing single-arg call site
  // (guard.addCost(o.costUsd)) keeps compiling and behaving identically.
  addCost(realUsd: number, estimatedUsd: number = 0): void {
    this.spent += realUsd
    this.estimatedSpent += estimatedUsd
  }

  // Real, adapter-reported spend only - unchanged meaning/behavior for any
  // existing consumer.
  get spentUsd(): number { return this.spent }

  // Pricing-derived estimated spend only, separate from real spend.
  get estimatedSpentUsd(): number { return this.estimatedSpent }

  // Real + estimated combined - what check() actually enforces against
  // max_cost_usd.
  get totalSpentUsd(): number { return this.spent + this.estimatedSpent }

  // Remaining wall-clock budget in ms, or undefined when no wall rail is set.
  // Nodes clamp their effective timeout to this so a hung in-flight node cannot
  // outlive the wall deadline (the between-node rail check never gets a turn
  // while a node hangs). May be <= 0 once the budget is spent; callers clamp.
  remainingWallMs(): number | undefined {
    if (this.rails.maxWallMinutes === undefined) return undefined
    return this.rails.maxWallMinutes * 60_000 - this.workingElapsedMs()
  }

  // Never loosens a limit - only lowers it. Used when a self-planning
  // fragment declares its own rails: the outer loopfile's rails are always
  // the ceiling (see docs/superpowers/specs/2026-07-04-self-planning-loop-design.md).
  tighten(partial: Partial<Rails>): void {
    if (partial.maxIterations !== undefined) {
      this.rails.maxIterations = Math.min(this.rails.maxIterations, partial.maxIterations)
    }
    if (partial.maxCostUsd !== undefined) {
      this.rails.maxCostUsd = Math.min(this.rails.maxCostUsd, partial.maxCostUsd)
    }
    if (partial.maxWallMinutes !== undefined) {
      this.rails.maxWallMinutes = this.rails.maxWallMinutes === undefined
        ? partial.maxWallMinutes
        : Math.min(this.rails.maxWallMinutes, partial.maxWallMinutes)
    }
  }

  check(iteration: number): RailBreach | null {
    if (iteration > this.rails.maxIterations) {
      return { rail: 'iterations', detail: `iteration ${iteration} exceeds max ${this.rails.maxIterations}` }
    }
    if (this.totalSpentUsd >= this.rails.maxCostUsd) {
      const detail = this.estimatedSpent > 0
        ? `$${this.totalSpentUsd.toFixed(2)} spent incl ~$${this.estimatedSpent.toFixed(2)} est of $${this.rails.maxCostUsd} budget`
        : `$${this.spent.toFixed(2)} spent of $${this.rails.maxCostUsd} budget`
      return { rail: 'cost', detail }
    }
    if (this.rails.maxWallMinutes !== undefined) {
      const minutes = this.workingElapsedMs() / 60_000
      if (minutes >= this.rails.maxWallMinutes) {
        return { rail: 'wall', detail: `${minutes.toFixed(1)}min elapsed of ${this.rails.maxWallMinutes}min limit` }
      }
    }
    return null
  }
}
