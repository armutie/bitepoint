import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bakedToLine, type BakedLine } from './bakedLines'
import { carLength, handlingPreset } from './carParams'
import { seeded } from './racecraft'
import { Race } from './race'
import { atCommitment } from './racingLine'
import { LineFollower } from './referenceDriver'
import { DT } from './sim'
import { Track, type TrackData } from './track'
import { RacingRibbon, TrafficPlanner, type TrafficCar } from './trafficPlanner'

const read = (name: string): string => readFileSync(new URL(`../../public/${name}`, import.meta.url), 'utf8')
const track = new Track(JSON.parse(read('tracks/power_8.json')) as TrackData)
const params = handlingPreset('legacy')
const shape = bakedToLine(JSON.parse(read('lines/power_8.legacy.json')) as BakedLine, track, params, 1)!
const ribbon = new RacingRibbon(track, shape)
const stations = Array.from(shape.x, (x, i) => track.project(x, shape.y[i]!).s)
const signed = (d: number): number => ((d + track.length * 1.5) % track.length) - track.length * 0.5
function nearest(s: number): number {
  let best = 0, distance = Infinity
  stations.forEach((road, i) => { const d = Math.abs(signed(road - s)); if (d < distance) { best = i; distance = d } })
  return best
}

/** Small real pace advantage; neither driver is speed-capped or scripted to yield. */
function pair(fast: number, slow: number, start: number, seed: number) {
  const race = new Race(track, [{ slot: 0, params }, { slot: 1, params }], { laps: 10 })
  const lines = [slow, fast].map((pace) => atCommitment(shape, params, pace))
  const planners = lines.map((line, slot) => {
    const random = seeded((seed + slot * 2654435761) >>> 0)
    random()
    return new TrafficPlanner(ribbon, line, params, { side: (random() * 2 - 1) * 0.7,
      clearance: 0.6 + random() * 0.15, preparation: 2 + random() * 0.2,
      cruise: (random() * 2 - 1) * 0.25 })
  })
  const drivers = lines.map((line) => new LineFollower(params, line))
  const indices = [nearest(start), nearest(start - 12)]
  const speed = Math.min(...indices.map((i, slot) => lines[slot]!.speed[i]!))
  const n = shape.x.length
  indices.forEach((i, slot) => {
    const sim = race.sims[slot]!
    const a = (i - 2 + n) % n, b = (i + 2) % n
    sim.car.reset(shape.x[i]!, shape.y[i]!, Math.atan2(shape.y[b]! - shape.y[a]!, shape.x[b]! - shape.x[a]!))
    const rpm = (gear: number): number => speed / params.wheelRadius * params.gearRatios[gear]! * params.finalDrive * 60 / (2 * Math.PI)
    let gear = 0
    while (gear < params.gearRatios.length - 1 && rpm(gear) > params.shiftUpRpm) gear++
    sim.beginRollingApproach({ ...sim.car.s, vx: speed, wheelVr: speed,
      r: shape.curvature[i]! * speed, gear, engineRpm: rpm(gear), shiftTimer: 0 })
  })
  race.phase = 'racing'
  const snapshot = (): TrafficCar[] => race.sims.map((sim) => ({ state: sim.car.s,
    road: track.project(sim.car.s.x, sim.car.s.y), speed: sim.speed }))
  const previous = snapshot().map((car) => car.road.s)
  const progress = [0, signed(previous[1]! - previous[0]!)]
  let held = 0, contact = 0, off = 0
  for (let tick = 0; tick < 60 * 120; tick++) {
    const cars = snapshot()
    const actions = drivers.map((driver, slot) => {
      const planner = planners[slot]!, sim = race.sims[slot]!
      if (tick === 0 || (tick + slot) % 6 === 0) driver.setLine(planner.update(cars, slot))
      driver.speedLimit = planner.speedLimit(cars, slot)
      driver.offTrack = sim.offTrack
      const c = driver.next(sim.car.s)
      return { steer: c.steer, throttle: c.pedal }
    })
    race.step(actions)
    const after = snapshot()
    after.forEach((car, slot) => { progress[slot]! += signed(car.road.s - previous[slot]!); previous[slot] = car.road.s })
    if (race.impacts.some((impulse) => impulse > 1)) contact++
    if (race.sims.some((sim) => sim.offTrack)) off++
    held = progress[1]! - progress[0]! > carLength(params) + 1 ? held + 1 : 0
    if (held >= 60) return { time: (tick + 1) * DT, contact, off }
  }
  return { time: Infinity, contact, off }
}

describe('sustained overtaking against an active AI rival', () => {
  for (const seed of [1, 2, 3]) {
    it.each([69.12, track.length * 0.25, track.length * 0.5, track.length * 0.75])(
      `completes a clean Quick-band pass starting at %f m with seed ${seed}`, (start) => {
        const result = pair(0.93, 0.885, start, seed)
        expect(result.time).toBeLessThan(45)
        expect(result.contact).toBe(0)
        expect(result.off).toBe(0)
      }, 10000)
  }
  it('uses a neighbouring-rank Ruthless advantage without pushing through the rival', () => {
    // Restoring the leader's real pace removed its accidental 2.8 s/lap
    // handicap. This tiny advantage must still find a clean opportunity, but
    // a pass is not guaranteed from every phase of the lap within two minutes.
    const results = [69.12, track.length * 0.5].map((start) => pair(0.99, 0.98125, start, 1))
    expect(results.some((result) => result.time < 120)).toBe(true)
    for (const result of results) {
      expect(result.contact).toBe(0)
      expect(result.off).toBe(0)
    }
  })
})
