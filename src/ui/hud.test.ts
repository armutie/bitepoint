/**
 * The sector pill's colour, which means different things in the two sessions.
 *
 * Worth its own test because the rule is easy to state and easy to get subtly
 * wrong, and being wrong is invisible: a pill that should be green and is grey
 * looks like a design choice rather than a bug.
 */
import { describe, expect, it } from 'vitest'

import { sectorPillState } from './hud'

describe('sector pill state', () => {
  it('paints a purple split purple whatever the delta says', () => {
    expect(sectorPillState(0.4, true, true)).toBe('purple')
    expect(sectorPillState(-0.4, true, false)).toBe('purple')
    expect(sectorPillState(null, true, true)).toBe('purple')
  })

  it('treats a first split in a race as green, not grey', () => {
    // The whole point of race-local timing: lap one has nothing behind it, and
    // that is good news rather than no news.
    expect(sectorPillState(null, false, true)).toBe('good')
  })

  it('keeps a first split neutral in a time trial', () => {
    expect(sectorPillState(null, false, false)).toBe('neutral')
  })

  it('reads the sign of the delta the same way in both sessions', () => {
    for (const racing of [true, false]) {
      expect(sectorPillState(-0.2, false, racing)).toBe('good')
      expect(sectorPillState(0, false, racing)).toBe('good')
      expect(sectorPillState(0.2, false, racing)).toBe('warn')
    }
  })
})
