/**
 * Knowing where the other cars are, and what to do about the one in front.
 *
 * The wrap and the lapping cases are what these mostly guard. A race is a loop,
 * so "ahead" is a modular question, and a car being lapped is simultaneously
 * far behind on total distance and immediately in front on the road — get that
 * backwards and a leader brakes for a backmarker it has already passed.
 */
import { describe, expect, it } from 'vitest'

import { carAhead, followingLimit, type FieldState } from './racecraft'

const LAP = 1000

describe('carAhead', () => {
  it('finds the nearest car in front', () => {
    const field: FieldState = { distance: [100, 130, 180], speed: [50, 50, 50] }
    expect(carAhead(field, 0, LAP)?.slot).toBe(1)
    expect(carAhead(field, 0, LAP)?.gap).toBe(30)
  })

  it('ignores cars behind', () => {
    const field: FieldState = { distance: [100, 40], speed: [50, 50] }
    expect(carAhead(field, 0, LAP)).toBeNull()
  })

  it('sees round the timing line', () => {
    // 20 m from the end of the lap, with somebody 30 m along the next one.
    const field: FieldState = { distance: [980, 1010], speed: [50, 50] }
    const ahead = carAhead(field, 0, LAP)
    expect(ahead?.slot).toBe(1)
    expect(ahead?.gap).toBe(30)
  })

  it('treats a car being lapped as being in front, not a lap behind', () => {
    // The leader is on lap 3, the backmarker still on lap 1 — and physically
    // 40 m up the road. Total distance says it is 1960 m behind; the road says
    // it is about to be run into.
    const field: FieldState = { distance: [2000, 40], speed: [70, 40] }
    const ahead = carAhead(field, 0, LAP)
    expect(ahead?.slot).toBe(1)
    expect(ahead?.gap).toBe(40)
  })

  it('ignores cars beyond the look-ahead', () => {
    const field: FieldState = { distance: [0, 300], speed: [50, 50] }
    expect(carAhead(field, 0, LAP, 120)).toBeNull()
  })
})

describe('followingLimit', () => {
  /** About 2.5 g, which is roughly what this car actually stops at. */
  const BRAKE = 25

  it('does not cap anything when the road is clear', () => {
    expect(followingLimit(null, BRAKE)).toBe(Infinity)
  })

  it('does not bite when there is room to stop in', () => {
    expect(followingLimit({ slot: 1, gap: 90, speed: 50 }, BRAKE)).toBeGreaterThan(50)
  })

  it('gives up speed when closing on a slower car', () => {
    // Doing 60 onto a car doing 30, twenty metres back: the cap has to be well
    // under our speed or we arrive in their gearbox.
    const cap = followingLimit({ slot: 1, gap: 20, speed: 30 }, BRAKE)
    expect(cap).toBeLessThan(60)
    expect(cap).toBeGreaterThan(0)
  })

  it('lets a car sit close behind one going the same speed', () => {
    // Deliberate, and worth stating because it looks like a bug. Two IDENTICAL
    // cars at the same speed brake identically, so any positive gap is
    // survivable and the arithmetic correctly declines to invent a margin. It
    // is also why this is a CAP and not a target: nothing here asks a car to
    // close up, it only ever takes speed away.
    expect(followingLimit({ slot: 1, gap: 12, speed: 50 }, BRAKE)).toBeGreaterThan(50)
  })

  it('never asks for a negative speed', () => {
    expect(followingLimit({ slot: 1, gap: 0.5, speed: 30 }, BRAKE)).toBeGreaterThanOrEqual(0)
  })

  it('respects a car that has stopped instead of driving through it', () => {
    // THE REGRESSION THAT MATTERS. The old law ignored anything under 8 m/s
    // outright — a stopgap for having no way past — and measured on Croft Bay
    // that was worth 17324 ticks of contact against a crawling player.
    const cap = followingLimit({ slot: 1, gap: 10, speed: 0 }, BRAKE)
    expect(Number.isFinite(cap)).toBe(true)
    expect(cap).toBeLessThan(15)
  })

  it('still respects a car that is merely braking hard', () => {
    // 18 m/s against 40 is a car braking properly for a hairpin, not an
    // obstacle. A relative test called it one and stopped respecting exactly
    // the car it was about to run into.
    expect(followingLimit({ slot: 1, gap: 10, speed: 18 }, BRAKE)).toBeLessThan(40)
  })

  it('asks for less speed the worse the brakes are', () => {
    // The whole point of taking braking as an argument: a car closing on
    // traffic mid-corner has far less stopping than one on a straight.
    expect(followingLimit({ slot: 1, gap: 30, speed: 20 }, 8))
      .toBeLessThan(followingLimit({ slot: 1, gap: 30, speed: 20 }, 30))
  })

  it('lets the field leave the grid', () => {
    // Nine metres apart at a standstill. Capped to zero, the race never starts.
    expect(followingLimit({ slot: 1, gap: 9, speed: 0 }, BRAKE)).toBeGreaterThan(3)
  })
})
