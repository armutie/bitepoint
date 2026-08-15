/**
 * The live delta is a TRUE delta: my elapsed time now, minus the reference
 * lap's elapsed time at the same distance round the lap. Ported from the env's
 * `_reference_time_at`, which is `np.interp(progress, ghost_s, ghost_t)`.
 *
 * The property that matters and that the old approximation (positional gap
 * divided by current speed) could not give: replay a lap against ITSELF and
 * the delta must be zero everywhere, at every speed, through every corner.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { handlingPreset } from './carParams'
import { clamp, wrapAngle } from './math'
import { TimeAttackSim, traceTimeAt } from './sim'
import { Track, type TrackData } from './track'

function loadTrack(id: string): Track {
  const path = fileURLToPath(new URL(`../../public/tracks/${id}.json`, import.meta.url))
  return new Track(JSON.parse(readFileSync(path, 'utf-8')) as TrackData)
}

function autopilot(sim: TimeAttackSim): [number, number] {
  const s = sim.car.s
  const proj = sim.track.project(s.x, s.y)
  const speed = Math.max(s.vx, 1)
  const aim = sim.track.poseAt(proj.s + clamp(6 + speed * 0.6, 8, 40))
  const err = wrapAngle(Math.atan2(aim.y - s.y, aim.x - s.x) - s.yaw)
  const steer = clamp(err * 2.2 - s.r * 0.25 - proj.lateral * 0.03, -1, 1)
  let worst = 0
  const scan = clamp(speed * 2.5, 30, 120)
  for (let d = 5; d <= scan; d += 5) {
    worst = Math.max(worst, Math.abs(sim.track.signedCurvatureAt(proj.s + d)))
  }
  const target = clamp(Math.sqrt(13 / (worst + 1e-4)), 12, 40)
  return [steer, clamp((target - s.vx) * 0.5, -1, 1)]
}

describe('true live delta', () => {
  it('reads zero all the way round when a lap is replayed against itself', () => {
    const track = loadTrack('power_8')
    const params = handlingPreset('f1')

    // Lap one: no reference, so no delta, and it leaves a trace behind.
    const first = new TimeAttackSim(track, params, 'power_8', 'f1')
    let trace = null
    const inputs: [number, number][] = []
    for (let i = 0; i < 45000 && !trace; i++) {
      const c = autopilot(first)
      inputs.push(c)
      const r = first.step(c[0], c[1])
      expect(first.liveDelta).toBeNull() // nothing to compare against yet
      if (r.lapCompleted) trace = r.lapCompleted.trace
    }
    expect(trace).not.toBeNull()

    // Lap two: same inputs from the same start, measured against lap one.
    const second = new TimeAttackSim(track, params, 'power_8', 'f1')
    second.referenceTrace = trace
    let worst = 0
    let samples = 0
    for (let i = 0; i < inputs.length; i++) {
      const c = inputs[i]!
      const r = second.step(c[0], c[1])
      if (second.timingArmed && second.liveDelta !== null) {
        worst = Math.max(worst, Math.abs(second.liveDelta))
        samples++
      }
      if (r.lapCompleted) break
    }
    expect(samples).toBeGreaterThan(1000)
    // Identical drive, identical distances: the only error is the linear
    // interpolation between adjacent 60 Hz samples.
    expect(worst).toBeLessThan(1e-9)
  })

  it('interpolates the reference between samples and clamps outside it', () => {
    const trace = {
      s: Float64Array.from([0, 100, 300]),
      t: Float64Array.from([0, 5, 20]),
    }
    expect(traceTimeAt(trace, 0)).toBe(0)
    expect(traceTimeAt(trace, 50)).toBeCloseTo(2.5, 12)
    expect(traceTimeAt(trace, 200)).toBeCloseTo(12.5, 12)
    // np.interp clamps rather than extrapolating.
    expect(traceTimeAt(trace, -40)).toBe(0)
    expect(traceTimeAt(trace, 9999)).toBe(20)
  })
})
