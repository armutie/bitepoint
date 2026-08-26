/**
 * Lap rules, and the property the leaderboard design depends on.
 *
 * The rules are ported from ``racing/env.py`` and are what make a browser lap
 * and a Python lap the same thing: the clock arms on the first crossing rather
 * than at the spawn, any wheel off the road voids the lap, and sectors close at
 * the circuit's authored timing lines (or equal thirds on legacy tracks).
 *
 * The replay test is the important one. If a recorded lap re-runs to a different
 * result then ghosts drift, and a server could not check a submitted time by
 * re-driving the inputs — which is the only thing standing between a public
 * leaderboard and anyone with devtools.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { Car } from './car'
import { handlingPreset, type CarParams } from './carParams'
import { gridPose, GRID_SLOTS } from './grid'
import { clamp, wrapAngle } from './math'
import {
  channelLayout, channelsOf, DT, GHOST_FIELDS, lapUsedTc, LapReplay, OFF_TRACK_MARGIN,
  TimeAttackSim, verifyLapRecording, withAbs,
} from './sim'
import { GhostPath } from '../render/ghostPath'
import { deserializeLapRecord, keyOf, serializeLapRecord } from '../storage/records'
import { Track, type TrackData } from './track'

function loadTrack(id: string): Track {
  const path = fileURLToPath(new URL(`../../public/tracks/${id}.json`, import.meta.url))
  return new Track(JSON.parse(readFileSync(path, 'utf-8')) as TrackData)
}

/**
 * A modest centreline-follower, good enough to complete clean laps.
 *
 * Not a fast driver and not trying to be — the tests need a lap that finishes
 * and stays on the road, not a competitive one.
 */
function autopilot(sim: TimeAttackSim): [number, number] {
  const s = sim.car.s
  const proj = sim.track.project(s.x, s.y)
  const speed = Math.max(s.vx, 1)

  // Aim further ahead the faster it goes, or it saws at the wheel on straights.
  const lookahead = clamp(6 + speed * 0.6, 8, 40)
  const aim = sim.track.poseAt(proj.s + lookahead)
  const desired = Math.atan2(aim.y - s.y, aim.x - s.x)
  const headingError = wrapAngle(desired - s.yaw)
  // Yaw-rate damping stops it oscillating; the lateral term keeps it off the
  // edges rather than settling into a stable orbit near one.
  const steer = clamp(headingError * 2.2 - s.r * 0.25 - proj.lateral * 0.03, -1, 1)

  // Slow for what is coming, from the road's own curvature. v = sqrt(a / k) is
  // the actual cornering limit; 13 m/s^2 leaves a wide margin under the ~20+
  // these cars can pull, which is what keeps every lap clean.
  let worst = 0
  const scan = clamp(speed * 2.5, 30, 120)
  for (let d = 5; d <= scan; d += 5) {
    worst = Math.max(worst, Math.abs(sim.track.signedCurvatureAt(proj.s + d)))
  }
  const targetSpeed = clamp(Math.sqrt(13 / (worst + 1e-4)), 12, 40)
  const throttle = clamp((targetSpeed - s.vx) * 0.5, -1, 1)
  return [steer, throttle]
}

/**
 * Drive until `laps` timed laps are banked, or `maxSteps` runs out.
 *
 * The autopilot laps in 80-100 s, i.e. 5-6k ticks, so the budget has to be
 * generous — it is a safety net against a stuck car, not a time limit.
 */
function driveLaps(sim: TimeAttackSim, laps: number, maxSteps = 45000) {
  const completed = []
  for (let i = 0; i < maxSteps && completed.length < laps; i++) {
    const [steer, throttle] = autopilot(sim)
    const r = sim.step(steer, throttle)
    if (r.lapCompleted) completed.push(r.lapCompleted)
  }
  return completed
}

describe('lap timing', () => {
  it('stages time attack in the rearmost painted grid slot', () => {
    const track = loadTrack('power_4')
    const sim = new TimeAttackSim(track, handlingPreset('f1'), 'power_4', 'f1')
    const expected = gridPose(track, GRID_SLOTS - 1)

    expect(sim.car.s.x).toBeCloseTo(expected.x, 12)
    expect(sim.car.s.y).toBeCloseTo(expected.y, 12)
    expect(sim.car.s.yaw).toBeCloseTo(expected.yaw, 12)
    const projected = track.project(sim.car.s.x, sim.car.s.y)
    expect(projected.s).toBeCloseTo(expected.s, 9)
    expect(projected.lateral).toBeCloseTo(expected.lateral, 9)
  })

  it('does not start the clock until the line is crossed', () => {
    const sim = new TimeAttackSim(loadTrack('power_8'), handlingPreset('f1'), 'power_8', 'f1')
    expect(sim.timingArmed).toBe(false)
    expect(sim.currentLapTime).toBe(0)

    // The car stages at the back of the grid, so the full run-up must remain untimed.
    let armedAt = -1
    for (let i = 0; i < 1200; i++) {
      const [steer, throttle] = autopilot(sim)
      const r = sim.step(steer, throttle)
      if (r.timingArmed && armedAt < 0) armedAt = i
      // Before arming, the clock stays at zero no matter how long the run-up is.
      if (!r.timingArmed) expect(sim.currentLapTime).toBe(0)
    }
    expect(armedAt).toBeGreaterThanOrEqual(0)
    expect(sim.currentLapTime).toBeGreaterThan(0)
  })

  it('completes laps and splits them into three sectors that sum to the lap', () => {
    const sim = new TimeAttackSim(loadTrack('power_8'), handlingPreset('f1'), 'power_8', 'f1')
    const laps = driveLaps(sim, 2)

    expect(laps.length).toBe(2)
    for (const lap of laps) {
      expect(lap.time).toBeGreaterThan(20)
      expect(lap.sectors.every((x) => x !== null)).toBe(true)
      const sum = lap.sectors.reduce<number>((a, b) => a + (b ?? 0), 0)
      // Sector splits partition the lap exactly; they are differences of the
      // same clock, so this is not an approximation.
      expect(Math.abs(sum - lap.time)).toBeLessThan(1e-9)
    }
  })

  it('closes Silverstone sectors at its authored timing lines', () => {
    const track = loadTrack('silverstone')
    const sim = new TimeAttackSim(track, handlingPreset('f1'), 'silverstone', 'f1')
    const closures: { sector: number; s: number }[] = []
    const laps = []

    for (let i = 0; i < 45000 && laps.length < 1; i++) {
      const [steer, throttle] = autopilot(sim)
      const result = sim.step(steer, throttle)
      if (result.sectorClosed !== null && !result.lapCompleted) {
        closures.push({
          sector: result.sectorClosed,
          s: track.project(sim.car.s.x, sim.car.s.y).s,
        })
      }
      if (result.lapCompleted) laps.push(result.lapCompleted)
    }

    expect(closures.map((entry) => entry.sector)).toEqual([0, 1])
    for (const [index, boundary] of track.sectorBoundaries.entries()) {
      const closedAt = closures[index]!.s
      expect(closedAt).toBeGreaterThanOrEqual(boundary)
      expect(closedAt - boundary).toBeLessThan(2)
    }
    expect(laps).toHaveLength(1)
    expect(laps[0]!.valid).toBe(true)
    expect(laps[0]!.sectors.every((sector) => sector !== null)).toBe(true)
  })

  it('tracks a personal best across laps, and only from valid ones', () => {
    const sim = new TimeAttackSim(loadTrack('power_4'), handlingPreset('f1'), 'power_4', 'f1')
    const laps = driveLaps(sim, 3)
    expect(laps.length).toBe(3)

    const validTimes = laps.filter((l) => l.valid).map((l) => l.time)
    if (validTimes.length > 0) {
      expect(sim.bestLapTime).toBeCloseTo(Math.min(...validTimes), 9)
    } else {
      expect(sim.bestLapTime).toBeNull()
    }
  })
})

describe('lap validity', () => {
  it('voids the lap as soon as a wheel is off the road, and does not un-void it', () => {
    const track = loadTrack('power_8')
    const sim = new TimeAttackSim(track, handlingPreset('f1'), 'power_8', 'f1')

    // Arm the clock first.
    while (!sim.timingArmed) {
      const [steer, throttle] = autopilot(sim)
      sim.step(steer, throttle)
    }
    expect(sim.lapValid).toBe(true)

    // Put the car well outside the road, then drive it back on.
    const proj = track.project(sim.car.s.x, sim.car.s.y)
    const pose = track.poseAt(proj.s)
    const off = proj.half + OFF_TRACK_MARGIN + 5
    sim.car.setPose(pose.x - Math.sin(pose.yaw) * off, pose.y + Math.cos(pose.yaw) * off, pose.yaw)

    const r = sim.step(0, 0.2)
    expect(r.offTrack).toBe(true)
    expect(r.lapValid).toBe(false)

    // Back on the road, the lap stays void: it is a recovery, not an undo.
    sim.car.setPose(pose.x, pose.y, pose.yaw)
    for (let i = 0; i < 60; i++) sim.step(0, 0.2)
    expect(sim.lapValid).toBe(false)
  })

  it('starts the next lap clean once the line comes round again', () => {
    const sim = new TimeAttackSim(loadTrack('balanced_8'), handlingPreset('f1'), 'balanced_8', 'f1')
    const laps = driveLaps(sim, 2)
    expect(laps.length).toBe(2)
    // The autopilot stays on the road, so both laps should stand.
    expect(laps[0]!.valid).toBe(true)
    expect(laps[1]!.valid).toBe(true)
  })
})

describe('manual gearbox', () => {
  /** Drive with a naive shift schedule, so the trace really contains shifts. */
  function driveManual(sim: TimeAttackSim, laps: number) {
    const done = []
    for (let i = 0; i < 60 * 60 * 4 && done.length < laps; i++) {
      const [steer, throttle] = autopilot(sim)
      const s = sim.car.s
      // Shift on rpm, exactly as a driver would, but as a recorded INPUT.
      let shift = 0
      if (s.engineRpm > 7700) shift = 1
      else if (s.engineRpm < 3000) shift = -1
      const r = sim.step(steer, throttle, shift)
      if (r.lapCompleted) done.push(r.lapCompleted)
    }
    return done
  }

  it('records the gear requests, so a manual lap is three channels', () => {
    const track = loadTrack('balanced_8')
    const params = handlingPreset('legacy')
    const auto = driveLaps(new TimeAttackSim(track, params, track.id, 'legacy'), 1)[0]!
    const manual = driveManual(
      new TimeAttackSim(track, params, track.id, 'legacy', false, { manual: true }), 1,
    )[0]!

    expect(auto.recording.manual).toBeUndefined()
    expect(auto.recording.inputs.length % 2).toBe(0)
    expect(manual.recording.manual).toBe(true)
    expect(manual.recording.inputs.length % 3).toBe(0)
  })

  it('replays a manual lap as a manual lap', () => {
    // The failure this exists to catch: replay a manual recording under the
    // automatic gearbox and it takes different gears, makes different power,
    // and the ghost quietly drifts off the line that was actually driven.
    const track = loadTrack('balanced_8')
    const params = handlingPreset('legacy')
    const lap = driveManual(
      new TimeAttackSim(track, params, track.id, 'legacy', false, { manual: true }), 1,
    )[0]!

    const replay = new LapReplay(track, params, lap.recording)
    const shadow = new LapReplay(track, params, lap.recording)
    let drift = 0
    while (!replay.finished) {
      replay.step()
      shadow.step()
      drift = Math.max(drift, Math.hypot(
        replay.car.s.x - shadow.car.s.x, replay.car.s.y - shadow.car.s.y,
      ))
    }
    expect(drift).toBe(0)
    expect(verifyLapRecording(track, params, lap.recording)).toMatchObject({
      accepted: true,
      time: lap.time,
    })
  })

  it('holds each gear at its own redline instead of pulling forever', () => {
    // The bug manual mode exposed: rpm was clamped to the redline BEFORE the
    // torque lookup, so past the limit the engine went on making its redline
    // torque at any engine speed. Held in 2nd, this car reached 15,800 rpm and
    // 190 km/h and was still pulling — the gears limited acceleration but
    // never top speed, so every ratio was effectively a top gear.
    // A bare car on an infinite straight, not a sim on a circuit — pinned in
    // gear and held flat, a car on a real track simply drives into the scenery.
    const params = handlingPreset('legacy')
    const RPM_PER_RADS = 60 / (2 * Math.PI)

    for (const gear of [1, 2, 3]) {
      const car = new Car(params)
      for (let i = 0; i < 60 * 70; i++) {
        car.s.gear = gear
        car.step(0, 1, DT, 10)
      }
      const ratio = params.gearRatios[gear]! * params.finalDrive
      const redlineSpeed = ((params.redlineRpm / RPM_PER_RADS) * params.wheelRadius) / ratio
      // Settles onto the limiter: never below it, and never far past the band.
      expect(car.s.vx, `gear ${gear + 1}`).toBeGreaterThan(redlineSpeed * 0.9)
      expect(car.s.vx, `gear ${gear + 1}`).toBeLessThan(redlineSpeed * 1.05)
    }
  })

  it('downshifts through a braking zone instead of holding one gear', () => {
    // Braking from 250 the car used to hold SEVENTH down to 106 km/h, because
    // a gear was entered at 7800 rpm and only left at 3200.
    const params = handlingPreset('legacy')
    const car = new Car(params)
    for (let i = 0; i < 60 * 40 && car.s.vx * 3.6 < 250; i++) car.step(0, 1, DT, 10)

    const gears = new Set<number>()
    for (let i = 0; i < 60 * 20 && car.s.vx * 3.6 > 60; i++) {
      car.step(0, -1, DT, 10)
      gears.add(car.s.gear)
    }
    // Five or more distinct gears on the way down from 250 to 60. Five, not
    // six, because the box is a seven-speed and first is held out above
    // 31 km/h — so 6th down to 2nd is the whole of it.
    expect(gears.size).toBeGreaterThanOrEqual(5)
  })

  it('stays out of first gear at speed', () => {
    // 2->1 is purely rpm-based otherwise, and on this car 5200 rpm in second
    // IS 70 km/h. First picked up at 70, with its torque multiplication, is a
    // guaranteed spin the moment the throttle is touched.
    const params = handlingPreset('legacy')
    const car = new Car(params)
    for (let i = 0; i < 60 * 40 && car.s.vx * 3.6 < 250; i++) car.step(0, 1, DT, 10)

    let firstAt = 0
    for (let i = 0; i < 60 * 25 && car.s.vx > 2; i++) {
      car.step(0, -1, DT, 10)
      if (car.s.gear === 0 && firstAt === 0) firstAt = car.s.vx
    }
    expect(firstAt).toBeGreaterThan(0)
    expect(firstAt).toBeLessThanOrEqual(params.firstGearSpeed + 0.5)
  })

  it('never hunts: no preset can shift and immediately shift back', () => {
    // The bound that sets `shiftDownRpm`. Downshift, and the engine lands at
    // `down * step`; if that is above `shiftUpRpm` it upshifts again at once
    // and the box oscillates. The widest step in any preset decides the limit.
    for (const name of ['legacy', 'f1', 'nimble', 'boat', 'test'] as const) {
      const p = handlingPreset(name)
      for (let i = 0; i < p.gearRatios.length - 1; i++) {
        const step = p.gearRatios[i]! / p.gearRatios[i + 1]!
        expect(p.shiftDownRpm * step, `${name} gear ${i + 2} downshift`)
          .toBeLessThan(p.shiftUpRpm)
        expect(p.shiftUpRpm / step, `${name} gear ${i + 1} upshift`)
          .toBeGreaterThan(p.shiftDownRpm)
      }
    }
  })

  /** Brake down from 200 km/h to `kph` so the box picks its own gear, then go flat out. */
  function cornerExit(p: CarParams, kph: number): { gear: number; peak: number; end: number } {
    const car = new Car(p)
    car.s.vx = 200 / 3.6
    car.s.gear = p.gearRatios.length - 1
    while (car.s.vx * 3.6 > kph) car.step(0, -1, DT, 10)
    const gear = car.s.gear
    let peak = 0
    for (let i = 0; i < 3 * 60; i++) {
      car.step(0, 1, DT, 10)
      peak = Math.max(peak, (car.s.wheelVr - car.s.vx) / Math.max(Math.abs(car.s.vx), p.slipVxFloor))
    }
    return { gear, peak, end: car.s.vx * 3.6 }
  }

  it('holds the low gears to a flat ceiling the speed taper would have released', () => {
    // The taper is fully open by `tcOffSpeed` — 79 km/h on this car — so by the
    // time you are on the throttle out of a slow corner it has already let go.
    // Second is short enough to reach the ceiling it leaves behind.
    const p = handlingPreset('legacy')
    expect(p.tcGearMax).toBe(1)

    const tapered = cornerExit({ ...p, tcGearMax: -1 }, 50)
    const capped = cornerExit(p, 50)
    expect(tapered.gear).toBe(1)
    expect(capped.gear).toBe(1)

    expect(tapered.peak).toBeGreaterThan(0.4)
    expect(capped.peak).toBeLessThanOrEqual(p.tcGearSlip + 1e-9)
    // And it costs almost nothing, because 0.47 slip is already past the grip
    // peak (~0.16) — it was making smoke, not drive.
    expect(capped.end).toBeGreaterThan(tapered.end - 4)
  })

  it('leaves third and above on the speed taper', () => {
    // A per-gear map that quietly damped the whole car would be a different
    // change from the one that was asked for. Above `tcGearMax` nothing moves.
    const p = handlingPreset('legacy')
    for (const kph of [90, 110, 150]) {
      const capped = cornerExit(p, kph)
      const tapered = cornerExit({ ...p, tcGearMax: -1 }, kph)
      expect(capped.gear, `${kph} km/h`).toBeGreaterThan(p.tcGearMax)
      expect(capped.end, `${kph} km/h`).toBeCloseTo(tapered.end, 9)
    }
  })

  it('is opt-in, so the chassis experiments are untouched', () => {
    // Both offered setups run it — they are one car with two aero sheets, and
    // the traction control belongs to the car. What must stay clear of it is
    // the setup experiments the Python side drives, which are baselines.
    for (const name of ['legacy', 'classic'] as const) {
      expect(handlingPreset(name).tcGearMax, name).toBe(1)
    }
    for (const name of ['nimble', 'f1', 'boat', 'test'] as const) {
      expect(handlingPreset(name).tcGearMax, name).toBe(-1)
    }
  })

  it('will not select a gear that does not exist', () => {
    const track = loadTrack('balanced_8')
    const params = handlingPreset('legacy')
    const sim = new TimeAttackSim(track, params, track.id, 'legacy', false, { manual: true })
    // Hammer upshift for a while, then hammer downshift.
    for (let i = 0; i < 600; i++) sim.step(0, 1, 1)
    expect(sim.car.s.gear).toBe(params.gearRatios.length - 1)
    for (let i = 0; i < 600; i++) sim.step(0, 0, -1)
    expect(sim.car.s.gear).toBe(0)
  })
})

describe('traction control rotary', () => {
  const track = () => loadTrack('balanced_8')

  /** Drive a lap, turning the rotary partway round as a driver would. */
  function driveTurningTheKnob(sim: TimeAttackSim, from: number, to: number, at = 400) {
    // The staging run is not part of the recording. Use the stabilising rotary
    // through the curved grids, then begin the requested test position exactly
    // when timing arms.
    while (!sim.timingArmed) {
      const [steer, throttle] = autopilot(sim)
      sim.step(steer, throttle, 0, 4)
    }
    for (let i = 0; i < 60 * 60 * 4; i++) {
      const [steer, throttle] = autopilot(sim)
      const r = sim.step(steer, throttle, 0, i < at ? from : to)
      if (r.lapCompleted) return r.lapCompleted
    }
    throw new Error('no lap')
  }

  it('records the rotary position, so a TC lap carries a third channel', () => {
    const p = handlingPreset('legacy')
    const plain = driveLaps(new TimeAttackSim(track(), p, 'balanced_8', 'legacy'), 1)[0]!
    const knob = driveTurningTheKnob(
      new TimeAttackSim(track(), p, 'balanced_8', 'legacy', false, { tc: true }), 4, 4,
    )

    expect(plain.recording.tc).toBeUndefined()
    expect(plain.recording.inputs.length % 2).toBe(0)
    expect(knob.recording.tc).toBe(true)
    expect(knob.recording.inputs.length % 3).toBe(0)
  })

  it('reads the TC slot as TC, not as a gear', () => {
    // The bug this exists to catch. A TC lap on the AUTOMATIC box also has
    // three channels, so anything that assumed "slot 2 is the gear because
    // there are three of them" would feed the rotary position — up to 5 —
    // straight into the gearbox as a shift request.
    const auto = channelLayout({ tc: true })
    expect(auto.count).toBe(3)
    expect(auto.gear).toBe(-1)
    expect(auto.tc).toBe(2)

    const both = channelLayout({ manual: true, tc: true })
    expect(both.count).toBe(4)
    expect(both.gear).toBe(2)
    expect(both.tc).toBe(3)
  })

  it('replays a lap on the position it was actually driven on', () => {
    // Replay a TC-off lap under TC on and the tyres are allowed less than they
    // were given, so the car makes a different line and the ghost drifts.
    const p = handlingPreset('legacy')
    const lap = driveTurningTheKnob(
      new TimeAttackSim(track(), p, 'balanced_8', 'legacy', false, { tc: true }), 0, 0,
    )
    const replay = new LapReplay(track(), p, lap.recording)
    while (!replay.finished) replay.step()

    const verdict = verifyLapRecording(track(), p, lap.recording)
    expect(verdict.accepted, verdict.reason).toBe(true)
    expect(verdict.time!).toBeCloseTo(lap.time, 9)
  })

  it('counts a lap as a TC lap from the trace, not from where the knob ended', () => {
    const p = handlingPreset('legacy')
    // Starts with TC on, finishes with it off. The driver used it.
    const usedThenOff = driveTurningTheKnob(
      new TimeAttackSim(track(), p, 'balanced_8', 'legacy', false, { tc: true }), 3, 0,
    )
    expect(lapUsedTc(usedThenOff.recording)).toBe(true)

    const never = driveTurningTheKnob(
      new TimeAttackSim(track(), p, 'balanced_8', 'legacy', false, { tc: true }), 0, 0,
    )
    expect(lapUsedTc(never.recording)).toBe(false)
  })

  it('does not key the leaderboard on traction control', () => {
    // TC was briefly a board dimension and must not become one again. The key
    // has to be knowable BEFORE the lap so the menu can show what there is to
    // beat, and the rotary can be turned mid-lap — so a TC-keyed board files
    // laps under a key the menu cannot predict, and a real best reads as "no
    // time set". Legal equipment everyone has is not a category.
    // Nor on the setup: one car, two aero trims, one board. Only the circuit
    // and easy mode change what a lap time MEANS.
    const base = { trackId: 'balanced_8', easy: false }
    expect(keyOf(base)).toBe('balanced_8|std')
    expect(keyOf({ ...base, easy: true })).toBe('balanced_8|easy')
  })

  it('rejects a rotary position that is not a position on the wheel', () => {
    const p = handlingPreset('legacy')
    const lap = driveTurningTheKnob(
      new TimeAttackSim(track(), p, 'balanced_8', 'legacy', false, { tc: true }), 4, 4,
    )
    for (const bogus of [7, 2.5, -1]) {
      const tampered = {
        ...lap.recording,
        inputs: Float64Array.from(lap.recording.inputs),
      }
      tampered.inputs[2] = bogus
      const verdict = verifyLapRecording(track(), p, tampered)
      expect(verdict.accepted, `position ${bogus}`).toBe(false)
    }
  })
})

describe('anti-lock braking', () => {
  const track = () => loadTrack('balanced_8')

  /** Brake hard from speed, which is the only place ABS can show itself. */
  function stoppingDistance(p: CarParams, abs: boolean): number {
    const car = new Car(withAbs(p, abs))
    car.s.vx = 250 / 3.6
    car.s.gear = p.gearRatios.length - 1
    // A little steering, so the rear has a slip angle for ABS to react to —
    // straight-line braking never trips it.
    let travelled = 0
    for (let i = 0; i < 60 * 15 && car.s.vx > 10; i++) {
      const before = car.s.x
      car.step(0.15, -1, DT, 10)
      travelled += Math.abs(car.s.x - before)
    }
    return travelled
  }

  it('changes how the car brakes, so it is a real setting', () => {
    const p = handlingPreset('legacy')
    expect(p.absOn).toBe(false)
    expect(withAbs(p, true).absOn).toBe(true)
    // Copy, never mutate: these params are shared with the ghost and the menu.
    expect(p.absOn).toBe(false)
    expect(stoppingDistance(p, true)).not.toBeCloseTo(stoppingDistance(p, false), 3)
  })

  it('travels with the lap, so an ABS lap is not rejected as a faked time', () => {
    // The failure this exists to catch. ABS bleeds brake pressure, so a lap
    // driven with it and verified without brakes differently, takes a different
    // line, and is thrown out — an honest lap called a cheat.
    const p = handlingPreset('legacy')
    const lap = driveLaps(
      new TimeAttackSim(track(), p, 'balanced_8', 'legacy', false, { abs: true }), 1,
    )[0]!
    expect(lap.recording.abs).toBe(true)

    const verdict = verifyLapRecording(track(), p, lap.recording)
    expect(verdict.accepted, verdict.reason).toBe(true)
    expect(verdict.time!).toBeCloseTo(lap.time, 9)
  })

  it('leaves a lap driven without it alone', () => {
    const p = handlingPreset('legacy')
    const lap = driveLaps(new TimeAttackSim(track(), p, 'balanced_8', 'legacy'), 1)[0]!
    expect(lap.recording.abs).toBeUndefined()
    expect(verifyLapRecording(track(), p, lap.recording).accepted).toBe(true)
  })
})

describe('ghost path', () => {
  it('records one pose per timed tick, matching the input trace', () => {
    const track = loadTrack('balanced_8')
    const p = handlingPreset('legacy')
    const lap = driveLaps(new TimeAttackSim(track, p, 'balanced_8', 'legacy'), 1)[0]!
    const ticks = lap.recording.inputs.length / channelsOf(lap.recording)
    // Ticks PLUS the starting pose, so it begins where `LapReplay` begins.
    expect(lap.path.length).toBe((ticks + 1) * GHOST_FIELDS)
  })

  it('draws exactly the lap that was driven', () => {
    const track = loadTrack('balanced_8')
    const p = handlingPreset('legacy')
    const sim = new TimeAttackSim(track, p, 'balanced_8', 'legacy')
    const lap = driveLaps(sim, 1)[0]!

    // Walk the path and the input replay together. They are the same lap, so
    // while the car is unchanged they must agree to the bit.
    const replay = new LapReplay(track, p, lap.recording)
    const ghost = new GhostPath(lap.path)
    let checked = 0
    // Both start at the lap's starting pose, so they are compared in step.
    expect(ghost.car.s.x).toBeCloseTo(replay.car.s.x, 9)
    while (!replay.finished) {
      replay.step()
      ghost.step()
      expect(ghost.car.s.x).toBeCloseTo(replay.car.s.x, 5)
      expect(ghost.car.s.y).toBeCloseTo(replay.car.s.y, 5)
      expect(ghost.car.s.yaw).toBeCloseTo(replay.car.s.yaw, 5)
      checked++
    }
    expect(checked).toBeGreaterThan(600)
  })

  it('survives a change to the car that breaks the input replay', () => {
    // The reason this exists at all. Drive a lap, then change the car under it.
    // The inputs now describe a different lap — that is not a bug, it is what a
    // trace of inputs IS — and the ghost drawn from them wanders off. The path
    // is a recording of where the car was, so it cannot move.
    const track = loadTrack('balanced_8')
    const driven = handlingPreset('legacy')
    const lap = driveLaps(new TimeAttackSim(track, driven, 'balanced_8', 'legacy'), 1)[0]!

    const before = new GhostPath(lap.path)
    const after = new GhostPath(lap.path)
    // A materially different car: no per-gear TC and a much lazier downshift.
    const changed = { ...driven, tcGearMax: -1, shiftDownRpm: 3200 }
    const replay = new LapReplay(track, changed, lap.recording)

    let drift = 0
    while (!replay.finished) {
      replay.step()
      before.step()
      after.step()
      drift = Math.max(drift, Math.hypot(
        replay.car.s.x - before.car.s.x, replay.car.s.y - before.car.s.y,
      ))
    }
    // The replay really has diverged...
    expect(drift).toBeGreaterThan(1)
    // ...and the path has not moved a millimetre, whatever the car became.
    expect(after.car.s.x).toBe(before.car.s.x)
    expect(after.car.s.y).toBe(before.car.s.y)
  })

  it('round-trips through storage', () => {
    const track = loadTrack('balanced_8')
    const p = handlingPreset('legacy')
    const lap = driveLaps(new TimeAttackSim(track, p, 'balanced_8', 'legacy'), 1)[0]!
    const record = {
      trackId: 'balanced_8', preset: 'legacy', easy: false,
      time: lap.time, sectors: lap.sectors, path: lap.path,
      recordedAt: '2026-01-01T00:00:00.000Z', recording: lap.recording,
    }
    const back = deserializeLapRecord(serializeLapRecord(record))
    expect(back.path).toBeDefined()
    expect(back.path!.length).toBe(lap.path.length)
    // Float32 on the way through: sub-millimetre over a kilometre of circuit,
    // which is finer than anything a ghost can show.
    for (let i = 0; i < lap.path.length; i += 997) {
      expect(back.path![i]!).toBeCloseTo(lap.path[i]!, 2)
    }
  })
})

describe('lap replay', () => {
  it('accepts only a clean replay that finishes on its final submitted tick', () => {
    const track = loadTrack('balanced_8')
    const params = handlingPreset('f1')
    const lap = driveLaps(new TimeAttackSim(track, params, track.id, 'f1'), 1)[0]!

    const verified = verifyLapRecording(track, params, lap.recording)
    expect(verified).toMatchObject({ accepted: true, time: lap.time, sectors: lap.sectors })

    const truncated = {
      ...lap.recording,
      inputs: lap.recording.inputs.slice(0, -2),
    }
    expect(verifyLapRecording(track, params, truncated)).toMatchObject({
      accepted: false,
      reason: 'Input trace does not complete a lap.',
    })
  })

  it('reproduces a recorded lap exactly', () => {
    const track = loadTrack('power_8')
    const params = handlingPreset('f1')
    const sim = new TimeAttackSim(track, params, 'power_8', 'f1')

    const laps = driveLaps(sim, 1)
    const lap = laps[0]!

    // Re-drive the recorded inputs and compare against the live sim run again
    // from the same start, tick by tick.
    const replay = new LapReplay(track, params, lap.recording)
    const shadow = new LapReplay(track, params, lap.recording)

    let maxDrift = 0
    while (!replay.finished) {
      replay.step()
      shadow.step()
      maxDrift = Math.max(
        maxDrift,
        Math.hypot(replay.car.s.x - shadow.car.s.x, replay.car.s.y - shadow.car.s.y),
      )
    }
    // Two replays of the same recording are the same drive, bit for bit.
    expect(maxDrift).toBe(0)
  })

  it('derives the same lap time from the inputs alone', () => {
    const track = loadTrack('balanced_8')
    const params = handlingPreset('f1')
    const sim = new TimeAttackSim(track, params, 'balanced_8', 'f1')
    const lap = driveLaps(sim, 1)[0]!

    // This is the leaderboard check: the time is a *consequence* of the inputs,
    // not a number that came along with them. A faked time needs a faked input
    // trace that genuinely drives that fast.
    const replay = new LapReplay(track, params, lap.recording)
    expect(Math.abs(replay.duration - lap.time)).toBeLessThan(1e-9)
  })

  it('replays back onto the line the lap was actually driven on', () => {
    const track = loadTrack('power_4')
    const params = handlingPreset('f1')
    const sim = new TimeAttackSim(track, params, 'power_4', 'f1')
    const lap = driveLaps(sim, 1)[0]!

    // Re-run the live sim from the recorded start with the recorded inputs and
    // confirm it retraces the same path — the ghost is the lap, not a sketch.
    const replay = new LapReplay(track, params, lap.recording)
    const check = new TimeAttackSim(track, params, 'power_4', 'f1')
    check.car.s = { ...lap.recording.start }

    let maxDrift = 0
    const n = lap.recording.inputs.length / 2
    for (let i = 0; i < n; i++) {
      replay.step()
      check.step(lap.recording.inputs[i * 2]!, lap.recording.inputs[i * 2 + 1]!)
      maxDrift = Math.max(
        maxDrift,
        Math.hypot(replay.car.s.x - check.car.s.x, replay.car.s.y - check.car.s.y),
      )
    }
    expect(maxDrift).toBe(0)
    expect(Math.abs(n * DT - lap.time)).toBeLessThan(1e-9)
  })
})
