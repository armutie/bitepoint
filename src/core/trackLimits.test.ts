import { describe, expect, it } from 'vitest'
import { TrackLimits } from './trackLimits'

const rejoin = (limits: TrackLimits, ticks = 30) => {
  for (let i = 0; i < ticks; i++) limits.update(false)
}

describe('race track limits', () => {
  it('issues two warnings, then adds 3s and subsequent 5s penalties', () => {
    const limits = new TrackLimits()
    for (const [index, seconds] of [0, 0, 3, 5, 5].entries()) {
      expect(limits.update(true)).toEqual({ offence: index + 1, seconds })
      rejoin(limits)
    }
    expect(limits.penaltySeconds).toBe(13)
  })

  it('counts a continuous excursion once and requires a stable rejoin', () => {
    const limits = new TrackLimits()
    limits.update(true)
    for (let i = 0; i < 600; i++) expect(limits.update(true)).toBeNull()
    for (let i = 0; i < 10; i++) {
      rejoin(limits, 29)
      expect(limits.update(true)).toBeNull()
    }
    expect(limits.offences).toBe(1)
    rejoin(limits)
    expect(limits.update(true)).toEqual({ offence: 2, seconds: 0 })
  })

  it('ignores inactive ticks and starts each driver and new race fresh', () => {
    const limits = new TrackLimits()
    expect(limits.update(true, false)).toBeNull()
    expect(limits.offences).toBe(0)
    limits.update(true)
    expect(new TrackLimits().offences).toBe(0)
    for (let i = 0; i < 100; i++) limits.update(false, false)
    expect(limits.update(true)).toBeNull()
    expect(limits.offences).toBe(1)
  })
})
