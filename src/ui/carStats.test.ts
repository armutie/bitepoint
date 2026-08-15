/**
 * The car card quotes measured figures, so the measurements are re-run here.
 *
 * Top speed and cornering cannot be read off a parameter — top speed is where
 * drive meets drag, cornering is where the aero load stops paying — so the card
 * carries numbers somebody measured. A hand-written number is a number that
 * goes quietly wrong the next time the car is retuned, and a spec sheet that
 * lies about the car is worse than one that says nothing. Hence this: retune a
 * setup without re-measuring and the suite says so.
 */
import { describe, expect, it } from 'vitest'

import { Car } from '../core/car'
import { handlingPreset, type CarParams, type MenuPresetName } from '../core/carParams'
import { DT } from '../core/sim'
import { carBars, PERFORMANCE } from './carStats'

/** Flat out from rest for a minute; whatever it is doing then is top speed. */
function topSpeedKmh(p: CarParams): number {
  const car = new Car(p)
  for (let i = 0; i < 60 / DT; i++) car.step(0, 1, DT, 10)
  return car.s.vx * 3.6
}

/** Highest entry speed that holds a ~60 m radius without the rear letting go. */
function corneringKmh(p: CarParams): number {
  let best = 0
  // 1 km/h steps: the two setups are eight km/h apart, so a coarser sweep
  // cannot resolve the difference it exists to check.
  for (let kph = 150; kph <= 240; kph += 1) {
    const car = new Car(p)
    car.s.vx = kph / 3.6
    car.s.gear = 4
    let held = true
    for (let i = 0; i < 3 / DT; i++) {
      car.step(0.35, 0.15, DT, 10)
      const radius = Math.abs(car.s.r) > 1e-6 ? Math.abs(car.s.vx / car.s.r) : 1e9
      if (i > 60 && (radius > 85 || Math.abs(car.s.slipR) > 0.35)) { held = false; break }
    }
    if (held) best = kph
  }
  return best
}

describe('the numbers on the car card', () => {
  for (const preset of ['legacy', 'classic'] as const) {
    it(`${preset}: still does what the card claims`, () => {
      const p = handlingPreset(preset)
      const quoted = PERFORMANCE[preset]!
      // Both exact: top speed converges, and the cornering sweep resolves to
      // the km/h the card quotes.
      expect(topSpeedKmh(p)).toBeCloseTo(quoted.topKmh, 0)
      expect(corneringKmh(p)).toBe(quoted.cornerKmh)
      expect(p.downforceCoef).toBeCloseTo(quoted.downforce, 6)
      expect(p.dragCoef).toBeCloseTo(quoted.drag, 6)
    })
  }

  it('is a trade, not a ranking', () => {
    // If one setup were faster everywhere there would be nothing to choose, and
    // the card would be back to describing a better car and a worse one.
    expect(PERFORMANCE['legacy']!.topKmh).toBeGreaterThan(PERFORMANCE['classic']!.topKmh)
    expect(PERFORMANCE['classic']!.cornerKmh).toBeGreaterThan(PERFORMANCE['legacy']!.cornerKmh)
  })

  it('draws a bar that can actually be seen to differ', () => {
    const bars = (n: MenuPresetName) => carBars(handlingPreset(n), n)
    const low = bars('legacy')
    const high = bars('classic')

    for (let i = 0; i < low.length; i++) {
      const a = low[i]!
      const b = high[i]!
      expect(a.label).toBe(b.label)
      if (a.shared) {
        // Power: equal on purpose, and marked so the UI can dim it.
        expect(a.fill).toBeCloseTo(b.fill, 9)
        continue
      }
      // The point of the non-zero domains. These setups are ~4% apart, so on a
      // zero-based bar every one of these would differ by about two pixels and
      // the card would say the two cars are the same. A fifth of the track is
      // the least that reads as a difference at a glance.
      expect(Math.abs(a.fill - b.fill), a.label).toBeGreaterThan(0.2)
    }
  })

  it('keeps both setups off the ends of every scale', () => {
    // A bar pinned at 0 or 1 says "this is the limit of what exists", which is
    // the invented-endpoint problem that got the last set of bars deleted.
    for (const n of ['legacy', 'classic'] as const) {
      for (const bar of carBars(handlingPreset(n), n)) {
        expect(bar.fill, `${n} ${bar.label}`).toBeGreaterThan(0.02)
        expect(bar.fill, `${n} ${bar.label}`).toBeLessThan(0.98)
      }
    }
  })
})
