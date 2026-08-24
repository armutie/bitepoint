import { describe, expect, it } from 'vitest'

import { analyseSession, type SessionLap, type SessionSummary } from './sessionSummary'

const lap = (number: number, time: number, sectors: number[], valid = true): SessionLap => ({
  number,
  time,
  valid,
  sectors,
})

const summary = (laps: SessionLap[], personalBestBefore: number | null = null): SessionSummary => ({
  trackLabel: 'Ashford Loop',
  carLabel: 'F1-Test',
  easy: false,
  personalBestBefore,
  laps,
})

describe('session analysis', () => {
  it('finds the fastest lap, ideal lap, and the source of every best sector', () => {
    const result = analyseSession(summary([
      lap(1, 60.0, [20.0, 20.5, 19.5]),
      lap(2, 59.4, [19.8, 20.1, 19.5]),
      lap(3, 59.2, [19.9, 20.2, 19.1]),
    ]))

    expect(result.fastest?.number).toBe(3)
    expect(result.theoreticalBest).toBeCloseTo(59.0)
    expect(result.theoreticalGain).toBeCloseTo(0.2)
    expect(result.bestSectors.map((sector) => sector?.lap)).toEqual([2, 2, 3])
  })

  it('never lets an invalid lap set a session fact', () => {
    const result = analyseSession(summary([
      lap(1, 60, [20, 20, 20]),
      lap(2, 55, [18, 18, 19], false),
    ]))

    expect(result.validLaps.map((item) => item.number)).toEqual([1])
    expect(result.fastest?.number).toBe(1)
    expect(result.bestSectors.map((sector) => sector?.lap)).toEqual([1, 1, 1])
  })

  it('gives a new personal best priority over softer observations', () => {
    const result = analyseSession(summary([
      lap(1, 61, [20, 21, 20]),
      lap(2, 59.8, [19.8, 20.2, 19.8]),
    ], 60.2))

    expect(result.observation).toBe('New personal best by 0.40s — set on lap 2.')
  })

  it('names a sector only when it clearly explains the gain', () => {
    const result = analyseSession(summary([
      lap(1, 61, [20, 21, 20]),
      lap(2, 60.2, [19.9, 20.3, 20]),
    ]))

    expect(result.improvement).toBeCloseTo(0.8)
    expect(result.observation).toBe('You found 0.80s over 2 clean laps. Most of it came in sector 2.')
  })

  it('stays silent when the pattern is too weak to be useful', () => {
    const result = analyseSession(summary([
      lap(1, 60, [20, 20, 20]),
      lap(2, 60.1, [20.1, 20, 20]),
    ]))

    expect(result.improvement).toBeNull()
    expect(result.observation).toBeNull()
  })

  it('recognises a genuinely consistent closing set', () => {
    const result = analyseSession(summary([
      lap(1, 59.9, [20, 20, 19.9]),
      lap(2, 60.08, [20, 20, 20.08]),
      lap(3, 59.98, [20, 20, 19.98]),
    ]))

    expect(result.observation).toBe('Your last three clean laps landed within 0.18s.')
  })
})
