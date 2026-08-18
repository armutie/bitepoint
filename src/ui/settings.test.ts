/**
 * The sensitivity preview has to be telling the truth.
 *
 * The settings screen draws two lines at `fullLockOffset` and labels them "full
 * lock". If that position and the mapping the car actually reads ever disagree,
 * the drawing becomes a confident lie about a control — which is worse than no
 * preview at all, because a player will trust it and place their hand there.
 * So: the same assertion the drawing makes, run against the input code.
 */
import { describe, expect, it } from 'vitest'

import { MOUSE_DEADZONE, steerFromOffset } from '../game/input'
import { SENSITIVITY, fullLockFraction, fullLockOffset } from './settings'

/** A picture 1600 px wide, i.e. 800 px either side of the straight-ahead point. */
const HALF = 800

/** Lock the cursor asks for at a distance from the centre of the picture. */
const lockAt = (px: number, sensitivity: number): number =>
  Math.abs(steerFromOffset(px, HALF, fullLockFraction(sensitivity)))

describe('where the settings screen draws full lock', () => {
  it('is exactly where the wheel reaches full lock, at every setting', () => {
    for (const sensitivity of [0, SENSITIVITY.low, SENSITIVITY.medium, SENSITIVITY.high, 0.63, 1]) {
      const line = fullLockOffset(sensitivity) * HALF
      expect(lockAt(line, sensitivity)).toBeCloseTo(1, 10)
      // And not before it: a pixel short of the line is short of the stop.
      expect(lockAt(line - 1, sensitivity)).toBeLessThan(1)
    }
  })

  it('never asks the player to reach past the edge of the picture', () => {
    // Sensitivity 0 puts the line on the last pixel of the half-width, which is
    // the least sensitive setting worth offering. Anything beyond it would be
    // lock you cannot physically reach.
    expect(fullLockOffset(0)).toBeCloseTo(1, 10)
    expect(fullLockOffset(1)).toBeLessThan(fullLockOffset(0))
  })

  it('starts measuring from the edge of the deadzone, not from centre', () => {
    // The drawn band reports nothing, which is why the readout sits at 0% for
    // the first few pixels of cursor movement rather than looking broken.
    const edge = MOUSE_DEADZONE * HALF
    expect(lockAt(edge, SENSITIVITY.medium)).toBe(0)
    expect(lockAt(edge + 1, SENSITIVITY.medium)).toBeGreaterThan(0)
  })

  it('moves the line inward as sensitivity rises', () => {
    expect(fullLockOffset(SENSITIVITY.high)).toBeLessThan(fullLockOffset(SENSITIVITY.medium))
    expect(fullLockOffset(SENSITIVITY.medium)).toBeLessThan(fullLockOffset(SENSITIVITY.low))
  })
})
