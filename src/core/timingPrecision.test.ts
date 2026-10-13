import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { initialState } from './car'
import { handlingPreset } from './carParams'
import { clamp, wrapAngle } from './math'
import { Race } from './race'
import { channelsOf, DT, LapReplay, TimeAttackSim, verifyLapRecording, type LapRecording } from './sim'
import { Track, type TrackData } from './track'
import { GhostPath } from '../render/ghostPath'
import { deserializeLapRecord, serializeLapRecord } from '../storage/records'

// The start and both sector gates sit on straight segments, so expected
// crossing fractions are analytical, independent of the timer implementation.
const track = new Track({
  id: 'timing', label: 'Timing', blurb: '', profile: '', seed: 0,
  width: 20, length: 600, sectorBoundaries: [50, 350],
  centerline: [[0, 0], [100, 0], [100, 100], [-100, 100], [-100, 0]],
  halfRing: [10, 10, 10, 10, 10], brakeMarkers: [],
})
const params = handlingPreset('f1')

function stateAt(s: number) {
  const pose = track.poseAt(s)
  return { ...initialState(), x: pose.x, y: pose.y, yaw: pose.yaw, vx: 30 }
}

function moveNext(sim: TimeAttackSim, distance: number) {
  vi.spyOn(sim.car, 'step').mockImplementation(() => Object.assign(sim.car.s, stateAt(distance)))
  return sim.step(0, 0)
}

describe('fractional timing gates', () => {
  it('starts at the line inside a tick and retains the remainder in the live clock', () => {
    const sim = new TimeAttackSim(track, params, track.id, 'f1', false, { walls: false })
    sim.beginRollingApproach(stateAt(-0.25))
    const first = moveNext(sim, 0.75)
    expect(first.timingArmed).toBe(true)
    expect(first.finishFraction).toBeCloseTo(0.25, 12)
    expect(sim.currentLapTime).toBeCloseTo(0.75 * DT, 12)
    expect(sim.lapDistance).toBeCloseTo(0.75, 12)
    moveNext(sim, 1.75)
    expect(sim.currentLapTime).toBeCloseTo(1.75 * DT, 12)
    const nearby = new TimeAttackSim(track, params, track.id, 'f1', false, { walls: false })
    nearby.beginRollingApproach(stateAt(-0.31))
    moveNext(nearby, 0.69)
    // Identical 60 Hz updates, but a 1 ms difference in the line crossing.
    expect(0.75 * DT - nearby.currentLapTime).toBeCloseTo(0.001, 12)
    sim.reset()
    expect(sim.currentLapTime).toBe(0)
  })

  it('measures sector crossings between ticks and closes the lap on the line', () => {
    const sim = new TimeAttackSim(track, params, track.id, 'f1', false, { walls: false })
    sim.beginFlyingLap(stateAt(0))
    moveNext(sim, 49.75)
    expect(moveNext(sim, 50.75).sectorClosed).toBe(0)
    expect(sim.currentSectors[0]).toBeCloseTo(1.25 * DT, 12)
    moveNext(sim, 249.75)
    moveNext(sim, 349.75)
    expect(moveNext(sim, 350.75).sectorClosed).toBe(1)
    expect(sim.currentSectors[1]).toBeCloseTo(3 * DT, 12)
    moveNext(sim, 549.75)
    moveNext(sim, 599.75)
    const finish = moveNext(sim, 0.75)
    const lap = finish.lapCompleted!
    expect(finish.finishFraction).toBeCloseTo(0.25, 12)
    expect(lap.time).toBeCloseTo(7.25 * DT, 12)
    expect(lap.sectors.reduce<number>((sum, t) => sum + t!, 0)).toBe(lap.time)
    expect(lap.trace.s[lap.trace.s.length - 1]).toBe(track.length)
    expect(lap.trace.t[lap.trace.t.length - 1]).toBe(lap.time)
    for (let i = 1; i < lap.trace.s.length; i++) {
      expect(lap.trace.s[i]!).toBeGreaterThan(lap.trace.s[i - 1]!)
      expect(lap.trace.t[i]!).toBeGreaterThan(lap.trace.t[i - 1]!)
    }
    expect(sim.currentLapTime).toBeCloseTo(0.75 * DT, 12)
  })

  it('does not arm the clock on a reverse crossing', () => {
    const sim = new TimeAttackSim(track, params, track.id, 'f1', false, { walls: false })
    sim.beginRollingApproach(stateAt(0.25))
    expect(moveNext(sim, -0.75).crossedFinish).toBe(false)
    expect(sim.timingArmed).toBe(false)
    expect(sim.currentLapTime).toBe(0)
  })
})

describe('recording compatibility', () => {
  function realLap() {
    const circuit = new Track(JSON.parse(readFileSync(
      new URL('../../public/tracks/power_8.json', import.meta.url), 'utf8',
    )) as TrackData)
    const sim = new TimeAttackSim(circuit, params, circuit.id, 'f1')
    // Use the real AI line and vehicle to produce a replay, without mocked motion.
    return { circuit, sim }
  }

  it('verifies legacy recordings at their original tick times', () => {
    const { circuit, sim } = realLap()
    let lap = null
    for (let i = 0; i < 30000 && !lap; i++) {
      const s = sim.car.s
      const projected = circuit.project(s.x, s.y)
      const speed = Math.max(s.vx, 1)
      const aim = circuit.poseAt(projected.s + clamp(6 + speed * 0.6, 8, 40))
      const error = wrapAngle(Math.atan2(aim.y - s.y, aim.x - s.x) - s.yaw)
      const steer = clamp(error * 2.2 - s.r * 0.25 - projected.lateral * 0.03, -1, 1)
      let worst = 0
      for (let d = 5; d <= clamp(speed * 2.5, 30, 120); d += 5) {
        worst = Math.max(worst, Math.abs(circuit.signedCurvatureAt(projected.s + d)))
      }
      const target = clamp(Math.sqrt(13 / (worst + 1e-4)), 12, 40)
      lap = sim.step(steer, clamp((target - s.vx) * 0.5, -1, 1)).lapCompleted
    }
    expect(lap).not.toBeNull()
    const replay = new LapReplay(circuit, params, lap!.recording)
    replay.step() // Legacy recordings began at the tick end AFTER the start.
    const { timing: _timing, rollingStart: _rolling, ...rest } = lap!.recording
    const old: LapRecording = {
      ...rest, start: { ...replay.car.s }, inputs: rest.inputs.slice(channelsOf(rest)),
    }
    const back = deserializeLapRecord(serializeLapRecord({
      trackId: circuit.id, preset: 'f1', easy: false,
      time: old.inputs.length / channelsOf(old) * DT,
      sectors: [], recordedAt: '2026-10-11T00:00:00Z', recording: old,
    }))
    expect(back.recording.timing).toBeUndefined()
    const verified = verifyLapRecording(circuit, params, back.recording)
    expect(verified.accepted, verified.reason).toBe(true)
    expect(verified.time).toBe(back.time)
    expect(verified.pathStartTime).toBeUndefined()

    // A rolling replay cannot insert an untimed approach before its first input.
    const earlier = circuit.poseAt(circuit.length - 4)
    const delayed = { ...lap!.recording, start: {
      ...lap!.recording.start, x: earlier.x, y: earlier.y, yaw: earlier.yaw,
    } }
    expect(verifyLapRecording(circuit, params, delayed)).toMatchObject({
      accepted: false, reason: 'The first input must cross the start line.',
    })
  })
})

it('aligns a recorded ghost to elapsed time, including its fractional start tick', () => {
  const path = Float64Array.from([0, 0, 3.1, 0, 20, 20, 1, 0, -3.1, 1, 30, 30, 2, 0, -3, 0, 40, 40])
  const ghost = new GhostPath(path, -0.25 * DT)
  ghost.seekTime(0)
  expect(ghost.car.s.x).toBeCloseTo(0.25, 12)
  expect(ghost.car.s.yaw).toBeGreaterThan(3.1) // shortest turn across +/- pi
  ghost.seekTime(0.75 * DT)
  expect(ghost.car.s.x).toBe(1)
  ghost.seekTime(1.25 * DT)
  expect(ghost.car.s.x).toBeCloseTo(1.5, 12)
  ghost.seekTime(5)
  expect(ghost.car.s.x).toBe(2)
})

it('orders two race finishes within the same tick by their actual crossing times', () => {
  const race = new Race(track, [{ slot: 0, params }, { slot: 1, params }], { laps: 1, contact: false })
  race.phase = 'racing'
  for (const [i, sim] of race.sims.entries()) {
    const result = sim.step(0, 0)
    sim.lapsCompleted = 1
    vi.spyOn(sim, 'step').mockReturnValue({
      ...result, crossedFinish: true, finishFraction: i === 0 ? 0.8 : 0.2,
      lapCompleted: { time: 60, valid: true } as NonNullable<typeof result.lapCompleted>,
    })
  }
  race.step([{ steer: 0, throttle: 0 }, { steer: 0, throttle: 0 }])
  expect(race.finishedAt(0)).toBeCloseTo(0.8 * DT, 12)
  expect(race.finishedAt(1)).toBeCloseTo(0.2 * DT, 12)
  expect(race.standings()).toEqual([1, 0])
})
