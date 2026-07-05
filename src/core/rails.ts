import type { Rails } from './types.js'

export interface RailBreach {
  rail: 'iterations' | 'cost' | 'wall'
  detail: string
}

export class RailsGuard {
  private spent = 0
  private readonly startedAt: number

  constructor(private rails: Rails, private now: () => number = Date.now) {
    this.startedAt = this.now()
  }

  addCost(usd: number): void { this.spent += usd }

  get spentUsd(): number { return this.spent }

  // Remaining wall-clock budget in ms, or undefined when no wall rail is set.
  // Nodes clamp their effective timeout to this so a hung in-flight node cannot
  // outlive the wall deadline (the between-node rail check never gets a turn
  // while a node hangs). May be <= 0 once the budget is spent; callers clamp.
  remainingWallMs(): number | undefined {
    if (this.rails.maxWallMinutes === undefined) return undefined
    return this.rails.maxWallMinutes * 60_000 - (this.now() - this.startedAt)
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
    if (this.spent >= this.rails.maxCostUsd) {
      return { rail: 'cost', detail: `$${this.spent.toFixed(2)} spent of $${this.rails.maxCostUsd} budget` }
    }
    if (this.rails.maxWallMinutes !== undefined) {
      const minutes = (this.now() - this.startedAt) / 60_000
      if (minutes >= this.rails.maxWallMinutes) {
        return { rail: 'wall', detail: `${minutes.toFixed(1)}min elapsed of ${this.rails.maxWallMinutes}min limit` }
      }
    }
    return null
  }
}
