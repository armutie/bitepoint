import type { DriverScore } from './protocol'

/**
 * Sector splits for one driver, worked out on each client from the snapshots.
 *
 * The host's snapshot carries lap times but not splits, and sending them would
 * add to every packet for numbers that change three times a lap. Each client
 * already has both cars' positions and running lap times, so it notes the lap
 * time as a car crosses into the next sector. A split read this way can be a
 * snapshot late (a few hundredths at most); the lap times themselves still come
 * straight from the host.
 */
export class SectorClock {
  splits: (number | null)[] = [null, null, null]
  deltas: (number | null)[] = [null, null, null]
  lastSplits: (number | null)[] = [null, null, null]
  lastDeltas: (number | null)[] = [null, null, null]
  /** Best of each sector this race. */
  readonly best: (number | null)[] = [null, null, null]
  private laps = 0

  /**
   * Feed the latest score and the sector the car is in now. Returns true when
   * this call saw the car complete a lap.
   */
  update(score: Pick<DriverScore, 'laps' | 'lapTime' | 'last' | 'armed'>, sector: 0 | 1 | 2): boolean {
    if (score.laps > this.laps) {
      this.laps = score.laps
      const [a, b] = this.splits
      if (a != null && b != null && score.last !== null) this.record(2, score.last - a - b)
      this.lastSplits = this.splits
      this.lastDeltas = this.deltas
      this.splits = [null, null, null]
      this.deltas = [null, null, null]
      return true
    }
    if (!score.armed) {
      this.splits = [null, null, null]
      this.deltas = [null, null, null]
      return false
    }
    // Only the next sector in order counts, so a car reversing over a boundary
    // or a late first snapshot cannot write a split out of turn.
    const next = this.splits.findIndex((x) => x === null)
    if (next >= 0 && next < 2 && sector === next + 1) {
      let done = 0
      for (let i = 0; i < next; i++) done += this.splits[i]!
      this.record(next, Math.max(0, score.lapTime - done))
    }
    return false
  }

  private record(i: number, split: number): void {
    const best = this.best[i] ?? null
    this.splits[i] = split
    this.deltas[i] = best === null ? null : split - best
    if (best === null || split < best) this.best[i] = split
  }
}

/** Whether a split is the fastest either driver has gone through that sector. */
export function fastestSector(clocks: readonly SectorClock[], i: number, split: number | null): boolean {
  if (split === null) return false
  return clocks.every((c) => c.best[i] == null || split <= c.best[i]!)
}
