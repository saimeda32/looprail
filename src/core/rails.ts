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
