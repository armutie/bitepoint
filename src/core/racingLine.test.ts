/**
 * The racing line, tested on what can be checked rather than on a lap time.
 *
 * These assert PROPERTIES of the generated line — it stays on the road, it is
 * shorter and straighter than the centreline, it brakes before corners rather
 * than in them, and it responds to the car it was built for. Every one of those
 * is objectively true or false.
 *
 * What is deliberately NOT asserted is which setup is quicker. The line is only
 * half the tool; the other half is a controller that has to drive it, and that
 * controller is currently the larger error term — retuning its gains changed
 * both the lap times and which car won. Until it tracks tightly enough that the
 * car and not the driver decides, a test that pinned a lap time would be
 * pinning the controller's tuning and calling it physics.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { handlingPreset } from './carParams'
import {
  atCommitment, buildRacingLine, lineFromOffsets, lineFromPoints, longitudinalLimit,
  planningEnvelope, SpeedWindow, type RacingLine,
} from './racingLine'
import { ggvAt, measureGgv } from './ggv'
import { G, peakDriveForce } from './car'
import { OFF_TRACK_MARGIN } from './sim'
import { Track, type TrackData } from './track'

function loadTrack(id: string): Track {
  const path = fileURLToPath(new URL(`../../public/tracks/${id}.json`, import.meta.url))
  return new Track(JSON.parse(readFileSync(path, 'utf-8')) as TrackData)
}

const CIRCUITS = ['balanced_8', 'power_8'] as const

/**
 * Discrete curvature of a closed polyline, by the same estimator the line uses.
 *
 * TOTAL heading change — the integral of |curvature| along the path, in
 * radians — not the mean of a per-station figure. Two traps had to be walked
 * out of to get here:
 *
 *   - Comparing Menger curvature against `signedCurvatureAt` compares a
 *     three-metre finite difference with a smoothed analytic value, and the
 *     finite difference reads a couple of percent higher on anything, the
 *     centreline included.
 *   - Averaging PER STATION then over-weights the inside of corners, where a
 *     line that cuts the apex bunches its stations together. By that measure a
 *     line is penalised precisely for taking the short way round.
 *
 * Summing |dheading| is free of both: it is how far the car has to turn the
 * wheel over a lap, it does not care how the path is sampled, and it is what
 * "straighter" means.
 */
function totalTurn(x: Float64Array, y: Float64Array): number {
  const n = x.length
  let total = 0
  let prev = Math.atan2(y[0]! - y[n - 1]!, x[0]! - x[n - 1]!)
  for (let i = 0; i < n; i++) {
    const b = (i + 1) % n
    const heading = Math.atan2(y[b]! - y[i]!, x[b]! - x[i]!)
    let d = heading - prev
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    total += Math.abs(d)
    prev = heading
  }
  return total
}

/** Built once each: the optimiser is the slow part of this suite. */
const LINES = new Map<string, ReturnType<typeof buildRacingLine>>()
function lineFor(track: Track, preset: 'legacy' | 'classic') {
  const key = `${track.id}|${preset}`
  let l = LINES.get(key)
  if (!l) {
    // 3 rounds, not the converged 16: these assert PROPERTIES of the line —
    // that it stays on the road, uses the width, brakes before corners — and
    // none of them need the last few tenths. The full search is 18 s a line and
    // would put a minute and a half into this file for no extra coverage.
    l = buildRacingLine(track, handlingPreset(preset), { optimise: 3 })
    LINES.set(key, l)
  }
  return l
}

describe('racing line', () => {
  for (const id of CIRCUITS) {
    describe(id, () => {
      const track = loadTrack(id)
      const p = handlingPreset('legacy')
      const line = lineFor(track, 'legacy')

      it('never leaves the road', () => {
        // Not "inside the void threshold" — inside the PAINTED edge, with room
        // to spare. A reference line that needs the off-track margin to be
        // legal is a line no one can drive.
        for (let i = 0; i < line.x.length; i++) {
          const pr = track.project(line.x[i]!, line.y[i]!)
          expect(Math.abs(pr.lateral), `station ${i}`).toBeLessThan(pr.half)
        }
      })

      it('uses the width of the road', () => {
        // The failure this exists to catch is silent: a bug in the relaxation
        // leaves the line on the centreline, everything still "passes", and the
        // tool quietly goes back to being the centreline follower it replaced.
        let maxOffset = 0
        for (const o of line.offset) maxOffset = Math.max(maxOffset, Math.abs(o))
        expect(maxOffset).toBeGreaterThan(3)
      })

      it('is shorter than the centreline', () => {
        // Straightening a corner cuts distance. If it did not, the relaxation
        // is not finding anything.
        expect(line.total).toBeLessThan(track.length)
      })

      it('seeds itself straighter than the centreline', () => {
        // The SEED, not the finished line — and the difference is worth
        // recording, because it was surprising.
        //
        // The minimum-curvature seed is straighter than the centreline, as it
        // must be. The time-optimised line is NOT: measured, its mean curvature
        // comes out about ten percent HIGHER. That is not a regression, it is
        // what optimising for the clock buys — a late apex turns in harder in
        // exchange for a straighter exit, and the exit is where the power goes
        // down. A line tuned to be straight and a line tuned to be quick are
        // different lines, and this asserts only the claim that is true.
        const seed = buildRacingLine(track, p, { optimise: 0 })
        const n = seed.x.length
        const cx = new Float64Array(n)
        const cy = new Float64Array(n)
        for (let i = 0; i < n; i++) {
          const pose = track.poseAt((i / n) * track.length)
          cx[i] = pose.x
          cy[i] = pose.y
        }
        expect(totalTurn(seed.x, seed.y)).toBeLessThan(totalTurn(cx, cy))
      })

      it('brakes before the corner, not in it', () => {
        // The backward pass is the whole reason a speed profile is not just
        // "the cornering limit at each point". Somewhere on this circuit there
        // must be a point already slowing for a corner it has not reached.
        const n = line.speed.length
        let anticipated = 0
        for (let i = 0; i < n; i++) {
          const here = Math.abs(line.curvature[i]!)
          const ahead = Math.abs(line.curvature[(i + 8) % n]!)
          // Straight now, much tighter shortly, and already off the pace.
          if (here < 0.004 && ahead > 0.012 && line.speed[i]! < line.speed[(i + n - 8) % n]!) {
            anticipated++
          }
        }
        expect(anticipated).toBeGreaterThan(0)
      })

      it('slows for the corners it has', () => {
        let slowest = Infinity
        let fastest = 0
        for (const v of line.speed) {
          slowest = Math.min(slowest, v)
          fastest = Math.max(fastest, v)
        }
        expect(slowest).toBeLessThan(fastest * 0.6)
        expect(slowest).toBeGreaterThan(3)
      })

      it('gives the high-downforce setup more speed through the corners', () => {
        // The point of putting the car inside the speed model. A wing pays in
        // the corners and nowhere else, so this is where it must show up.
        const lowDrag = lineFor(track, 'legacy')
        const highDf = lineFor(track, 'classic')
        const cornerSpeed = (l: typeof lowDrag) => {
          let sum = 0
          let count = 0
          for (let i = 0; i < l.speed.length; i++) {
            if (Math.abs(l.curvature[i]!) > 0.01) { sum += l.speed[i]!; count++ }
          }
          return sum / Math.max(count, 1)
        }
        expect(cornerSpeed(highDf)).toBeGreaterThan(cornerSpeed(lowDrag))
      }, 30000)

      it('scales with commitment without moving the line', () => {
        const timid = atCommitment(line, p, 0.5)
        expect(timid.x).toBe(line.x)
        for (let i = 0; i < timid.speed.length; i++) {
          expect(timid.speed[i]!).toBeLessThanOrEqual(line.speed[i]! + 1e-9)
        }
      })

      it('keeps its margin off the edge under every commitment', () => {
        // `atCommitment` must not touch geometry; if it ever did, the search in
        // `fastestLap` would be walking the line off the road as it walks the
        // grip up, and would report the crash as the car's limit.
        for (const c of [0.4, 0.8, 1.2]) {
          const l = atCommitment(line, p, c)
          for (let i = 0; i < l.x.length; i++) {
            const pr = track.project(l.x[i]!, l.y[i]!)
            expect(Math.abs(pr.lateral)).toBeLessThan(pr.half + OFF_TRACK_MARGIN)
          }
        }
      })
    })
  }

  it('optimising for time gives a different line than optimising for curvature', () => {
    // If these came out the same, every claim about the line belonging to the
    // car would be false, and the lap-time stage would be dead weight.
    const track = loadTrack('power_8')
    const p = handlingPreset('legacy')
    const minCurvature = buildRacingLine(track, p, { optimise: 0 })
    const minTime = buildRacingLine(track, p, { optimise: 3 })

    let moved = 0
    for (let i = 0; i < minTime.offset.length; i++) {
      moved = Math.max(moved, Math.abs(minTime.offset[i]! - minCurvature.offset[i]!))
    }
    expect(moved).toBeGreaterThan(0.5)
  }, 30000)
})

describe('planning against the measured envelope', () => {
  const p = handlingPreset('legacy')

  it('measures a grip table that rises with speed', () => {
    // Lateral grip cannot fall as speed rises on a car that makes downforce,
    // so a column that dips is a broken measurement rather than a discovery.
    // It dipped: every sweep ran `car.step(cmd, 0, DT, 1.0)`, passing 1.0 as
    // SUBSTEPS where it looks like a grip multiplier, so the whole table came
    // off a car integrated ten times more coarsely than the one that races.
    const ggv = measureGgv(p)
    expect(ggv.v.length).toBeGreaterThan(4)
    for (let i = 1; i < ggv.ay.length; i++) {
      expect(ggv.ay[i]!).toBeGreaterThanOrEqual(ggv.ay[i - 1]!)
    }
  })

  it('never samples a speed the car cannot reach', () => {
    const ggv = measureGgv(p)
    const top = ggv.v[ggv.v.length - 1]!
    expect(peakDriveForce(p, top)).toBeGreaterThan(p.dragCoef * top * top)
  })


  it('calibrates the model to the measurement without touching the engine', () => {
    const measured = measureGgv(p)
    const planning = planningEnvelope(p, measured)
    expect(Array.from(planning.ay)).toEqual(Array.from(measured.ay))
    // A per-speed correction on TYRE grip only. Scaling the whole drive column
    // by the friction ellipse instead was the bug it replaces: above 108 km/h
    // this car is engine limited, so cornering was being charged against a
    // limit the tyre was never setting, and it cost 1.4 s in one speed band.
    expect(planning.muScale).toBeDefined()
    for (const k of planning.muScale!) {
      expect(k).toBeGreaterThan(0.2)
      expect(k).toBeLessThanOrEqual(1)
    }
    // The derived model is optimistic, so at least somewhere it must be cut.
    expect(Math.min(...planning.muScale!)).toBeLessThan(0.999)
  })

  it('plans no corner the car does not have the grip for', () => {
    // The definition of an honest plan, and it does not involve the driver:
    // at commitment 1.0 nothing may demand more lateral grip than the car was
    // measured to have. The derived formula overdraws at ~210 stations here.
    const track = loadTrack('power_8')
    const ggv = planningEnvelope(p, measureGgv(p))
    const line = atCommitment(buildRacingLine(track, p, { ggv }), p, 1.0)
    let over = 0
    for (let i = 0; i < line.speed.length; i++) {
      const v = line.speed[i]!
      const demand = v * v * Math.abs(line.curvature[i]!)
      if (v < 5 || demand < 0.5 * G) continue
      if (demand > ggvAt(ggv, ggv.ay, v) * 1.01) over++
    }
    expect(over).toBe(0)
  }, 60000)

  it('carries its envelope through a commitment change', () => {
    // `atCommitment` rebuilds every driver's speeds in a race. If it fell back
    // to the derived model there, the shape would have been found under one
    // set of limits and driven under another. No optimising needed — this is
    // about the plumbing, and a full search would cost the suite 20 seconds.
    const track = loadTrack('power_8')
    const ggv = planningEnvelope(p, measureGgv(p))
    const shape = buildRacingLine(track, p, { ggv, optimise: 0 })
    expect(shape.ggv).toBeDefined()
    expect(atCommitment(shape, p, 0.9).ggv).toBe(shape.ggv)
  }, 30000)

  it('gives back the line it was handed, not a re-smoothed one', () => {
    // A baked file stores the offsets `geometry` returned, which are already
    // smoothed. Smoothing them again on load is a different, flatter line than
    // the one that was scored — 321 mm and 1.77 s of model lap on Croft Bay.
    const track = loadTrack('power_8')
    const shape = buildRacingLine(track, p, { optimise: 0 })
    const reloaded = lineFromOffsets(track, p, shape.offset)
    let drift = 0
    for (let i = 0; i < shape.offset.length; i++) {
      drift = Math.max(drift, Math.abs(shape.offset[i]! - reloaded.offset[i]!))
    }
    expect(drift).toBeLessThan(1e-9)
  }, 30000)
})

/**
 * The windowed profile — what a race planner prices a candidate path with.
 *
 * These assert PROPERTIES rather than agreement with the full-lap profile, and
 * that is deliberate: the full lap is known to be wrong at a handful of
 * stations a lap. `speedProfile` evaluates the braking limit at each station's
 * current speed, `corneringSpeed` is legitimately Infinity wherever downforce
 * outgrows the corner, and `longitudinal` returns NaN when fed that — so
 * `NaN < v` is false, the braking constraint is silently skipped, and the last
 * sweep of the profile is a FORWARD one with no backward sweep left to catch
 * it. Measured on Croft Bay: 30 of 860 stations demand up to 16.6x the braking
 * the car has. `SpeedWindow` guards both and is checked here against the car
 * instead.
 */
describe('windowed speed profile', () => {
  const p = handlingPreset('legacy')

  /** Segment length between two stations of a line, metres. */
  const segAt = (line: RacingLine, i: number): number => {
    const b = (i + 1) % line.x.length
    return Math.hypot(line.x[b]! - line.x[i]!, line.y[b]! - line.y[i]!)
  }

  for (const id of CIRCUITS) {
    it(`never plans a deceleration the car does not have on ${id}`, () => {
      const track = loadTrack(id)
      const line = atCommitment(lineFor(track, 'legacy'), p, 0.95)
      const n = line.x.length
      const win = new SpeedWindow(160)
      let worst = 0
      for (let from = 0; from < n; from += 11) {
        win.fromLine(line, p, from, 100)
        for (let j = 0; j < 99; j++) {
          const st = (from + j) % n
          const v = win.speed[j]!
          const next = win.speed[j + 1]!
          expect(Number.isFinite(v)).toBe(true)
          if (next >= v) continue
          const demand = (v * v - next * next) / (2 * Math.max(segAt(line, st), 1e-3))
          const have = longitudinalLimit(p, v, line.curvature[st]!, line.commitment, 'brake')
          worst = Math.max(worst, demand / Math.max(have, 0.1))
        }
      }
      // Measured 1.005x on Ashford and 1.047x on Croft Bay. The residual is the
      // fixed point not being fully converged, not a skipped constraint — the
      // full lap is 16.6x at the same commitment.
      expect(worst).toBeLessThan(1.1)
    }, 30000)
  }

  it('prices a stretch of road the same however far back the window starts', () => {
    // The property a planner actually leans on. If a candidate's price moved
    // with where the window happened to open, two cars a few metres apart would
    // disagree about the same piece of road, and a car would change its mind
    // about a move for no reason but its own odometer.
    const track = loadTrack('power_8')
    const line = atCommitment(lineFor(track, 'legacy'), p, 0.95)
    const n = line.x.length
    const long = new SpeedWindow(160)
    const short = new SpeedWindow(160)
    let worst = 0
    for (let from = 0; from < n; from += 11) {
      long.fromLine(line, p, from, 120)
      short.fromLine(line, p, (from + 40) % n, 80)
      // The 60 stations both cover and neither has just entered.
      for (let j = 0; j < 60; j++) {
        worst = Math.max(worst, Math.abs(long.speed[60 + j]! - short.speed[20 + j]!))
      }
    }
    expect(worst).toBeLessThan(1e-9)
  }, 30000)

  it('brakes for the corner past its far edge, which only the seed can tell it', () => {
    // The failure this guards: cut a window out of a lap and its last station
    // has nothing ahead of it, so a car not told otherwise arrives at the edge
    // at any speed it likes — and brakes late, once per window, all the way
    // round. It reads as a periodic stutter rather than a missing argument.
    const track = loadTrack('power_8')
    const line = atCommitment(lineFor(track, 'legacy'), p, 0.95)
    const n = line.x.length
    let slow = 0
    for (let i = 1; i < n; i++) if (line.speed[i]! < line.speed[slow]!) slow = i
    // End the window INSIDE the braking zone for that corner. Two placements
    // that look reasonable and prove nothing: end it in the corner, where the
    // corner's own cornering cap binds and no seed is needed; or end it before
    // braking starts, where the honest answer really is "the seed changes
    // nothing". The zone for this corner is about 70 m, so stop 36 m short.
    const from = (slow - 112 + n) % n

    const seeded = new SpeedWindow(120)
    seeded.fromLine(line, p, from, 100)

    // The same road, told nothing useful about what follows it.
    const k = new Float64Array(100)
    const seg = new Float64Array(100)
    for (let j = 0; j < 100; j++) {
      const i = (from + j) % n
      k[j] = line.curvature[i]!
      seg[j] = segAt(line, i)
    }
    const blind = new SpeedWindow(120)
    blind.solve(p, line.commitment, k, seg, 100, {
      entrySpeed: line.speed[from]!, exitSpeed: 200,
    }, line.ggv)

    let biggest = 0
    for (let j = 0; j < 100; j++) {
      biggest = Math.max(biggest, blind.speed[j]! - seeded.speed[j]!)
      // A blind window is never SLOWER: it is missing a constraint, not a
      // different one.
      expect(blind.speed[j]!).toBeGreaterThanOrEqual(seeded.speed[j]! - 1e-9)
    }
    expect(biggest).toBeGreaterThan(5)
  }, 30000)

  it('caps the window at the speed the car actually has', () => {
    // A car that arrived badly must be told it cannot make what is coming,
    // rather than handed the plan drawn for a car that arrived on the line.
    const track = loadTrack('power_8')
    const line = atCommitment(lineFor(track, 'legacy'), p, 0.95)
    const n = line.x.length
    let fast = 0
    for (let i = 1; i < n; i++) if (line.speed[i]! > line.speed[fast]!) fast = i
    const win = new SpeedWindow(80)
    win.fromLine(line, p, fast, 60, 12)
    expect(win.speed[0]!).toBeCloseTo(12, 6)
    // And it cannot climb back to the line's pace in a few metres. Asserted
    // against the fastest station's OWN speed rather than its neighbour's: the
    // neighbour is on the far side of the full lap's braking discontinuity, so
    // it is one of the values this class exists not to trust.
    expect(win.speed[5]!).toBeLessThan(line.speed[fast]! * 0.5)
  }, 30000)

  it('scales a recorded lap instead of modelling it', () => {
    // Croft Bay's shipped line came from a human lap, so its speeds are what
    // somebody carried rather than what a model predicts. Modelling them here
    // would swap a measurement for a prediction on the one circuit where a
    // measurement exists.
    const track = loadTrack('power_8')
    const base = lineFor(track, 'legacy')
    const n = base.x.length
    const driven = lineFromPoints(track, p, base.x, base.y, base.speed, 0.9)
    const win = new SpeedWindow(80)
    win.fromLine(driven, p, 100, 60)
    for (let j = 0; j < 60; j++) {
      expect(win.speed[j]!).toBeCloseTo(base.speed[(100 + j) % n]! * 0.9, 9)
    }
  }, 30000)

  it('reuses its buffers and refuses a window it cannot hold', () => {
    const track = loadTrack('power_8')
    const line = atCommitment(lineFor(track, 'legacy'), p, 0.95)
    const win = new SpeedWindow(120)
    const speed = win.speed
    const pedal = win.pedal
    win.fromLine(line, p, 0, 100)
    win.fromLine(line, p, 50, 60)
    expect(win.speed).toBe(speed)
    expect(win.pedal).toBe(pedal)
    expect(win.count).toBe(60)
    expect(() => new SpeedWindow(10).fromLine(line, p, 0, 50)).toThrow(RangeError)
  }, 30000)
})
