/**
 * The audio mapping, pinned on the three ways it goes wrong.
 *
 * Sound cannot be regression-tested by listening, and the failures people
 * actually complain about — it squeals on the grid, it snaps on, it drowns
 * everything — are all properties of the mapping rather than of the mix. So
 * they get asserted here.
 */
import { describe, expect, it } from 'vitest'

import {
  combinedLevel, impactGain, levelsFor, slipRatio, smoothstep,
  squealPitch, RASP_MAX_FRONT, RASP_MAX_REAR, SQUEAL_MAX_FRONT, SQUEAL_MAX_REAR,
  TYRE_GATE_LO, type AudioInput,
} from './mix'

const still: AudioInput = {
  speed: 0, vx: 0, wheelVr: 0, slipF: 0, slipR: 0, onKerb: false, onGrass: false,
  rpm: 1200, redlineRpm: 8200, throttle: 0, shiftTimer: 0,
}

const at = (over: Partial<AudioInput>): AudioInput => ({ ...still, ...over })

describe('nothing makes a noise it should not', () => {
  it('is silent at a standstill', () => {
    const l = levelsFor(still)
    expect(l.raspFront).toBe(0)
    expect(l.raspRear).toBe(0)
    expect(l.surfaceGain).toBe(0)
    expect(l.windGain).toBe(0)
  })

  it('does not squeal on the grid at full lock', () => {
    // A stationary car turned to the stop has a huge slip angle. Without the
    // speed gate it sits on the line screaming, which is how this goes wrong
    // most often.
    const l = levelsFor(at({ slipF: 0.7, slipR: 0.7, speed: 0.4, vx: 0.4 }))
    expect(l.raspFront).toBe(0)
    expect(l.raspRear).toBe(0)
    expect(l.squealFront).toBe(0)
    expect(l.squealRear).toBe(0)
  })

  it('keeps quiet through an ordinary quick corner', () => {
    // ~2.9 degrees of slip at speed: a tyre working, not sliding.
    const l = levelsFor(at({ speed: 55, vx: 55, wheelVr: 55, slipF: 0.05, slipR: 0.05 }))
    expect(l.raspFront).toBe(0)
    expect(l.raspRear).toBe(0)
  })
})

/**
 * Steepest gain change per unit of input, sampled finely.
 *
 * A SLOPE, not a step: a step depends on how finely the test happens to sample,
 * so tightening the sampling would fail a curve that had not changed. The slope
 * is the property — "how hard can this layer slam on for a given movement of
 * the car" — and it stays meaningful whatever the resolution.
 */
function steepest(
  from: number, to: number, step: number, read: (x: number) => number,
): number {
  let worst = 0
  let prev = read(from)
  for (let x = from + step; x <= to; x += step) {
    const now = read(x)
    worst = Math.max(worst, Math.abs(now - prev) / step)
    prev = now
  }
  return worst
}

describe('nothing switches on', () => {
  // Per radian of slip.
  //
  // EXPERIMENT: 5.0, up from 3.0. The rasp now falls steeply as its own squeal
  // ducks it, so the steepest part of its curve is the hand-off rather than its
  // own onset — a layer getting out of the way, not slamming on.
  const MAX_SLOPE_PER_RAD = 5.0
  // Per m/s. The speed gate must never be something you can hear open.
  const MAX_SLOPE_PER_MS = 0.15

  it('has no jump anywhere across the whole slip range', () => {
    const rasp = steepest(0, 0.6, 0.002, (slip) =>
      levelsFor(at({ speed: 40, vx: 40, wheelVr: 40, slipR: slip })).raspRear)
    expect(rasp).toBeLessThan(MAX_SLOPE_PER_RAD)
  })

  it('has no jump as the car comes up to speed', () => {
    const gate = steepest(0, 30, 0.05, (speed) =>
      levelsFor(at({ speed, vx: speed, wheelVr: speed, slipR: 0.4 })).raspRear)
    expect(gate).toBeLessThan(MAX_SLOPE_PER_MS)
  })

  it('leaves the gate closed below the floor and open above it', () => {
    expect(levelsFor(at({ speed: TYRE_GATE_LO, slipR: 0.5 })).raspRear).toBe(0)
    // Above the gate the rear is fully expressed — but as SQUEAL, because at
    // this much slip the rasp has ducked itself out of the way. `RASP_MAX_REAR`
    // is therefore no longer a reachable level, which is intended: the rasp is
    // the sound of a tyre working, and by here it has stopped working.
    const fast = levelsFor(at({ speed: 40, vx: 40, wheelVr: 40, slipR: 0.5 }))
    expect(combinedLevel(fast.raspRear, fast.squealRear)).toBeGreaterThan(0.4)
  })
})

describe('nothing is allowed to dominate', () => {
  it('caps every layer well below full scale', () => {
    // Worst case everything at once: sideways, wheels spinning, on the grass.
    const l = levelsFor(at({
      speed: 70, vx: 70, wheelVr: 130, slipF: 0.9, slipR: 0.9, onGrass: true, onKerb: true,
    }))
    expect(l.raspFront).toBeLessThanOrEqual(RASP_MAX_FRONT)
    expect(l.raspRear).toBeLessThanOrEqual(RASP_MAX_REAR)
    expect(l.windGain).toBeLessThanOrEqual(0.16)
    expect(l.surfaceGain).toBeLessThanOrEqual(0.3)
    expect(l.squealFront).toBeLessThanOrEqual(SQUEAL_MAX_FRONT)
    expect(l.squealRear).toBeLessThanOrEqual(SQUEAL_MAX_REAR)
    // Combined in POWER, because these are uncorrelated noise sources and that
    // is how they actually add. The first version of this test added the gains
    // arithmetically, which overstates the sum by about 2x and is what pushed
    // every ceiling down until the tyres could not be heard at all.
    const total = combinedLevel(
      l.raspFront, l.raspRear, l.squealFront, l.squealRear, l.windGain, l.surfaceGain,
    )
    expect(total).toBeLessThan(1)
  })

  it('never opens a filter into the shrill range', () => {
    for (let slip = 0; slip <= 1; slip += 0.01) {
      const l = levelsFor(at({ speed: 70, vx: 70, wheelVr: 70, slipF: slip, slipR: slip }))
      expect(l.raspCentre).toBeLessThanOrEqual(1700)
      expect(l.windCutoff).toBeLessThanOrEqual(620)
    }
  })

  it('grows a wall hit sub-linearly and caps it', () => {
    // A shunt six times the impulse must not be six times the level.
    const brush = impactGain(2000)
    const shunt = impactGain(30000)
    expect(brush).toBeGreaterThan(0)
    expect(shunt / brush).toBeLessThan(4)
    expect(impactGain(500_000)).toBeLessThanOrEqual(0.55)
    expect(impactGain(0)).toBe(0)
  })
})

describe('the rear speaks up for both kinds of losing it', () => {
  it('reads wheelspin even with the car pointing straight', () => {
    const spinning = levelsFor(at({ speed: 30, vx: 30, wheelVr: 48, slipR: 0 }))
    expect(spinning.raspRear).toBeGreaterThan(0.1)
  })

  it('reads a slide even with the wheels matched to the road', () => {
    // Combined, since which of the two layers carries it depends on how far
    // gone the slide is — that hand-off is the design, not an accident.
    const sliding = levelsFor(at({ speed: 30, vx: 30, wheelVr: 30, slipR: 0.3 }))
    expect(combinedLevel(sliding.raspRear, sliding.squealRear)).toBeGreaterThan(0.1)
  })

  it('measures wheelspin against a floored denominator, not against zero', () => {
    // Otherwise a car creeping at 0.1 m/s with any wheel speed at all reads as
    // infinite slip, and the sound explodes as you pull away.
    expect(slipRatio(1, 0)).toBeCloseTo(1 / 3, 6)
    expect(Number.isFinite(slipRatio(5, 0))).toBe(true)
  })
})

/**
 * Slip angles this car actually reaches, measured off the f1 traces in
 * `__fixtures__/physics.json` above 8 m/s. The knees are set against these, and
 * the first version was not — which is why nothing could be heard.
 */
const MEASURED = {
  steadyCorner: 0.21,
  liftOff: 0.34,
  powerOnOversteer: 0.36,
  bigSlide: 0.42,
}

describe('audible where the car actually operates', () => {
  it('a committed fast corner is clearly audible', () => {
    // The regression that prompted all this: `steady_corner` peaks at 0.21 rad
    // and produced a squeal gain of 0.022 against a 0.4 master. Silence.
    const l = levelsFor(at({
      speed: 55, vx: 55, wheelVr: 55, slipF: MEASURED.steadyCorner, slipR: MEASURED.steadyCorner,
    }))
    expect(l.raspRear).toBeGreaterThan(0.15)
    expect(l.squealRear).toBeGreaterThan(0.04)
  })

  it('a real slide is unmistakable', () => {
    const l = levelsFor(at({
      speed: 50, vx: 50, wheelVr: 50, slipR: MEASURED.powerOnOversteer,
    }))
    expect(l.squealRear).toBeGreaterThan(0.2)
  })

  it('sits in the same league as the kerbs, which are known good', () => {
    // Kerbs and wind were the two layers that landed first time. The tyres at
    // full slide should be comparable to a kerb, not a third of one.
    const kerb = levelsFor(at({ speed: 50, vx: 50, wheelVr: 50, onKerb: true })).surfaceGain
    const slide = levelsFor(at({ speed: 50, vx: 50, wheelVr: 50, slipR: MEASURED.bigSlide }))
    expect(combinedLevel(slide.raspRear, slide.squealRear)).toBeGreaterThan(kerb)
  })
})

describe('the layers are tellable apart', () => {
  // The failure this guards: wind, rasp and surface were all pink noise
  // through a lowpass at overlapping cutoffs. That is one sound at three
  // volumes, and no amount of level balancing fixes it.
  it('keeps the rasp clear of the wind, at every speed', () => {
    for (let speed = 5; speed <= 90; speed += 1) {
      for (const slip of [0.05, 0.2, 0.45, 0.9]) {
        const l = levelsFor(at({ speed, vx: speed, wheelVr: speed, slipF: slip, slipR: slip }))
        expect(
          l.raspCentre,
          `bands overlap at ${speed} m/s, slip ${slip}`,
        ).toBeGreaterThan(l.windCutoff * 1.4)
      }
    }
  })

  it('gives the tyres a texture the wind cannot have', () => {
    // Frequency separation alone is weak — the ear reads roughness far more
    // readily than band. Wind is smooth by construction; the rasp is not.
    const l = levelsFor(at({ speed: 50, vx: 50, wheelVr: 50, slipR: 0.3 }))
    expect(l.raspGrain).toBeGreaterThan(30)
    expect(l.raspGrain).toBeLessThan(110)
  })

  it('speeds the texture up with the road', () => {
    const slow = levelsFor(at({ speed: 12, vx: 12, wheelVr: 12, slipR: 0.3 })).raspGrain
    const fast = levelsFor(at({ speed: 60, vx: 60, wheelVr: 60, slipR: 0.3 })).raspGrain
    expect(fast).toBeGreaterThan(slow)
  })

  it('puts the three tyre-ish layers in three different places', () => {
    const l = levelsFor(at({
      speed: 50, vx: 50, wheelVr: 50, slipF: 0.3, slipR: 0.3, onKerb: true,
    }))
    // Wind lowest, squeal in the middle as a resonance, rasp highest and broad.
    expect(l.windCutoff).toBeLessThan(l.squealFreqRear)
    expect(l.squealFreqRear).toBeLessThan(l.raspCentre)
    // And the kerb, which already reads correctly, keeps its own slot.
    expect(l.rumbleRate).toBeLessThan(l.windCutoff)
  })
})

describe('the squeal is the pitched half, and it comes later', () => {
  it('roars before it sings', () => {
    // The design property. Lean on a tyre and you get rasp only; a squeal
    // means you are genuinely sliding. If these ever invert, gentle cornering
    // starts whistling, which is the sound everyone hates.
    const leaning = levelsFor(at({ speed: 45, vx: 45, wheelVr: 45, slipR: 0.12 }))
    expect(leaning.raspRear).toBeGreaterThan(0)
    expect(leaning.squealRear).toBe(0)

    const sliding = levelsFor(at({ speed: 45, vx: 45, wheelVr: 45, slipR: 0.38 }))
    expect(sliding.squealRear).toBeGreaterThan(0)
  })

  it('EXPERIMENT: is deliberately steep, because stick-slip is a threshold', () => {
    // The measured number this experiment is really about. It was under 3 per
    // radian when the squeal was a gentle fade, and you could hear it ramping;
    // it is now around 10.5, which is close to a switch. That is the intended
    // change, so the bound records it rather than forbidding it.
    //
    // A slope this steep is only safe because the graph's 12 ms attack is what
    // finally shapes the onset — the mapping says "now", the envelope decides
    // how "now" sounds. Wind it back by widening SQUEAL_QUIET..SQUEAL_LOUD.
    const squeal = steepest(0, 0.7, 0.002, (slip) =>
      levelsFor(at({ speed: 45, vx: 45, wheelVr: 45, slipR: slip })).squealRear)
    expect(squeal).toBeGreaterThan(6)
    expect(squeal).toBeLessThan(12)
  })

  it('pitches on sliding speed, in the band the real thing occupies', () => {
    // A gentle slide at low speed sits low; a big one at speed sits higher.
    const gentle = squealPitch(20, 0.15)
    const hard = squealPitch(65, 0.5)
    expect(hard).toBeGreaterThan(gentle)
    // MEASURED: the reference screech puts its strongest partials at 1194-1512
    // Hz. The previous 360-900 band was more than an octave low, which is why
    // no amount of turning it up ever sounded piercing.
    for (const speed of [0, 10, 40, 90, 200]) {
      for (const slip of [0, 0.2, 0.8, 1.5, 3]) {
        const f = squealPitch(speed, slip)
        expect(f).toBeGreaterThanOrEqual(950)
        expect(f).toBeLessThanOrEqual(1500)
      }
    }
  })

  it('EXPERIMENT: is fully bright by the time it is properly sliding', () => {
    // The restrained version asserted no edge at all at 0.20 rad and full edge
    // only at 0.46. The experiment moves that to 0.17-0.30 to find out whether
    // "piercing" is actually wanted; restore those numbers to wind it back.
    expect(levelsFor(at({ speed: 50, vx: 50, wheelVr: 50, slipR: 0.16 })).squealEdgeRear).toBe(0)
    expect(levelsFor(at({ speed: 50, vx: 50, wheelVr: 50, slipR: 0.3 })).squealEdgeRear)
      .toBeCloseTo(1, 6)
  })

  it('EXPERIMENT: still never brightens before it is audible at all', () => {
    // The one part of the restraint that survives the experiment. Edge is now
    // allowed to LEAD level — that is what makes it sharp — but a tyre that is
    // making no sound must never suddenly produce a bright one, which would be
    // the ice pick out of nowhere.
    for (let slip = 0; slip <= 0.6; slip += 0.005) {
      const l = levelsFor(at({ speed: 50, vx: 50, wheelVr: 50, slipR: slip }))
      if (l.squealEdgeRear > 0) {
        expect(l.squealRear, `bright but silent at ${slip.toFixed(3)}`).toBeGreaterThan(0)
      }
    }
  })

  it('ducks the rasp out of the way when the squeal takes over', () => {
    // The masking fix. The rasp band sits on top of the squeal's upper
    // partials, so without this the loud version is still muffled.
    const leaning = levelsFor(at({ speed: 50, vx: 50, wheelVr: 50, slipR: 0.14 }))
    const sliding = levelsFor(at({ speed: 50, vx: 50, wheelVr: 50, slipR: 0.45 }))
    expect(sliding.raspRear).toBeLessThan(leaning.raspRear * 0.5)
    expect(sliding.squealRear).toBeGreaterThan(leaning.squealRear)
  })

  it('pierces sideways and only scrabbles under power', () => {
    // The physical distinction: stick-slip needs the patch dragged sideways
    // while still gripping in bursts. A wheel lit up in a straight line is a
    // broadband roar with no note in it, and giving both the same voice was
    // what made the tonal version feel wrong on corner exit.
    const sideways = levelsFor(at({ speed: 45, vx: 45, wheelVr: 45, slipR: 0.4 }))
    const lit = levelsFor(at({ speed: 45, vx: 45, wheelVr: 78, slipR: 0 }))

    // Both are loud — losing it is losing it, whichever way.
    expect(sideways.squealRear).toBeGreaterThan(0.3)
    expect(lit.squealRear).toBeGreaterThan(0.3)
    // But only the slide gets a pitch.
    expect(sideways.squealEdgeRear).toBeCloseTo(1, 6)
    expect(lit.squealEdgeRear).toBe(0)
    // And only the wheelspin gets the extra chatter.
    expect(lit.squealRoughRear).toBeGreaterThan(0.9)
    expect(sideways.squealRoughRear).toBe(0)
  })

  it('EXPERIMENT: the front tyres are muted', () => {
    // Deliberate, and a real loss — understeer is currently inaudible. Restore
    // by putting FRONT_TYRE_LEVEL back above zero.
    const hard = levelsFor(at({ speed: 50, vx: 50, wheelVr: 50, slipF: 0.5, slipR: 0.5 }))
    expect(hard.raspFront).toBe(0)
    expect(hard.squealFront).toBe(0)
    expect(hard.squealRear).toBeGreaterThan(0.3)
  })

  it('ducks the rear rasp by the rear slide, so the mapping still works', () => {
    // The per-axle ducking is unchanged underneath the mute, so bringing the
    // front back does not require rebuilding this.
    const mixed = levelsFor(at({ speed: 50, vx: 50, wheelVr: 50, slipF: 0.14, slipR: 0.5 }))
    expect(mixed.raspRear).toBeLessThan(RASP_MAX_REAR * 0.3)
  })

  it('flutters faster the harder it slides', () => {
    const easy = levelsFor(at({ speed: 45, vx: 45, wheelVr: 45, slipR: 0.2 })).squealGrain
    const hard = levelsFor(at({ speed: 45, vx: 45, wheelVr: 45, slipR: 0.6 })).squealGrain
    expect(hard).toBeGreaterThan(easy)
    // Kept well under the pitch range: modulation at these rates is chatter,
    // and much faster would start producing sidebands, which is a different
    // sound entirely. EXPERIMENT: 26-64 Hz, up from 17-41.
    expect(hard).toBeLessThan(80)
  })
})

describe('smoothstep', () => {
  it('is flat at both ends and monotonic between', () => {
    expect(smoothstep(1, 2, 0.5)).toBe(0)
    expect(smoothstep(1, 2, 2.5)).toBe(1)
    expect(smoothstep(1, 2, 1.5)).toBeCloseTo(0.5, 6)
    expect(smoothstep(2, 2, 2)).toBe(1)
  })
})
