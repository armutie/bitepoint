import { describe, expect, it } from 'vitest'
import { SectorClock, fastestSector } from './sectorClock'

const score = (laps: number, lapTime: number, armed = true, last: number | null = null) => ({ laps, lapTime, last, armed })

describe('SectorClock', () => {
  it('splits a lap from the running lap time at each boundary', () => {
    const c = new SectorClock()
    c.update(score(0, 1), 0)
    c.update(score(0, 20), 1)
    c.update(score(0, 45), 2)
    expect(c.splits).toEqual([20, 25, null])
    expect(c.update(score(1, 0.1, true, 70), 0)).toBe(true)
    expect(c.lastSplits).toEqual([20, 25, 25])
    expect(c.splits).toEqual([null, null, null])
  })

  it('records deltas against the best so far', () => {
    const c = new SectorClock()
    c.update(score(0, 20), 1)
    c.update(score(0, 45), 2)
    c.update(score(1, 0, true, 70), 0)
    c.update(score(1, 19), 1)
    expect(c.deltas[0]).toBeCloseTo(-1)
    expect(c.best[0]).toBe(19)
  })

  it('ignores sectors out of turn and an unarmed lap', () => {
    const c = new SectorClock()
    c.update(score(0, 10, false), 1)
    expect(c.splits).toEqual([null, null, null])
    c.update(score(0, 10), 2)
    expect(c.splits).toEqual([null, null, null])
  })

  it('marks only the fastest split of both drivers', () => {
    const a = new SectorClock(), b = new SectorClock()
    a.update(score(0, 20), 1)
    b.update(score(0, 18), 1)
    expect(fastestSector([a, b], 0, 20)).toBe(false)
    expect(fastestSector([a, b], 0, 18)).toBe(true)
  })
})
