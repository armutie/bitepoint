import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { handlingPreset } from './carParams'
import { Race } from './race'
import { Track, type TrackData } from './track'

const track = new Track(JSON.parse(readFileSync(
  new URL('../../public/tracks/power_8.json', import.meta.url), 'utf8',
)) as TrackData)
const entry = [{ slot: 0, params: handlingPreset('legacy') }]

it('keeps a flagged player drivable without changing their classification', () => {
  const race = new Race(track, entry, { laps: 1, contact: false, postFinishControl: true })
  race.phase = 'finished'
  // Start from the already-classified state to isolate cooldown behavior.
  const flagged = race as unknown as {
    finishTime: Map<number, number>
    finishDistance: Map<number, number>
  }
  flagged.finishTime.set(0, 72.4)
  flagged.finishDistance.set(0, 1000)
  for (let i = 0; i < 30; i++) race.step([{ steer: 0, throttle: 1 }])
  expect(race.sims[0]!.speed).toBeGreaterThan(0)
  expect(race.finishedAt(0)).toBe(72.4)
  expect(race.distanceTravelled(0)).toBe(1000)
})

it('still holds a flagged car without cooldown control', () => {
  const race = new Race(track, entry, { laps: 1, contact: false })
  race.phase = 'finished'
  ;(race as unknown as { finishTime: Map<number, number> }).finishTime.set(0, 72.4)
  for (let i = 0; i < 30; i++) race.step([{ steer: 0, throttle: 1 }])
  expect(race.sims[0]!.speed).toBe(0)
})

it('classifies by adjusted times while preserving the on-road finish order', () => {
  const race = new Race(track, [entry[0]!, { ...entry[0]!, slot: 1 }], { laps: 1, contact: false })
  const flagged = race as unknown as { finishTime: Map<number, number>; finishOrder: number[] }
  flagged.finishTime.set(0, 60)
  flagged.finishTime.set(1, 62)
  flagged.finishOrder.push(0, 1)
  for (let offence = 0; offence < 3; offence++) {
    race.trackLimits[0]!.update(true)
    for (let i = 0; i < 30; i++) race.trackLimits[0]!.update(false)
  }
  expect(race.finishedAt(0)).toBe(60)
  expect(race.adjustedFinishTime(0)).toBe(63)
  expect(race.standings()).toEqual([0, 1])
  expect(race.classification()).toEqual([1, 0])
})

it('enforces limits only during racing, including the finish tick, then freezes penalties', () => {
  const race = new Race(track, entry, { laps: 1, contact: false, postFinishControl: true })
  const sim = race.sims[0]!
  sim.offTrack = true
  const original = sim.step(0, 0)
  sim.offTrack = true
  vi.spyOn(sim, 'step').mockReturnValue({ ...original, offTrack: true, lapCompleted: null })
  const actions = [{ steer: 0, throttle: 0 }]
  race.step(actions)
  race.beginCountdown()
  race.step(actions)
  expect(race.trackLimits[0]!.offences).toBe(0)
  race.phase = 'racing'
  race.step(actions)
  expect(race.trackLimits[0]!.offences).toBe(1)
  sim.offTrack = false
  for (let i = 0; i < 30; i++) race.step(actions)
  sim.offTrack = true
  race.step(actions)
  sim.offTrack = false
  for (let i = 0; i < 30; i++) race.step(actions)
  sim.offTrack = true
  sim.lapsCompleted = 1
  vi.mocked(sim.step).mockReturnValue({ ...original, offTrack: true,
    // Only the finish trigger is needed; recording data is not read by Race.
    lapCompleted: { time: 60, valid: false } as NonNullable<typeof original.lapCompleted> })
  race.step(actions)
  expect(race.phase).toBe('finished')
  expect(race.trackLimits[0]!.penaltySeconds).toBe(3)
  expect(race.adjustedFinishTime(0)).toBeCloseTo(race.finishedAt(0)! + 3)
  sim.offTrack = false
  for (let i = 0; i < 30; i++) race.step(actions)
  sim.offTrack = true
  race.step(actions)
  expect(race.trackLimits[0]!.offences).toBe(3)
})
