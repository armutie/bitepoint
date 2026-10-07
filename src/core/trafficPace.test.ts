import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bakedToLine, type BakedLine } from './bakedLines'
import { handlingPreset } from './carParams'
import { LineFollower } from './referenceDriver'
import { TimeAttackSim } from './sim'
import { Track, type TrackData } from './track'
import { RacingRibbon, TrafficPlanner, type TrafficCar } from './trafficPlanner'

const read = (file: string): string => readFileSync(new URL(`../../public/${file}`, import.meta.url), 'utf8')
const track = new Track(JSON.parse(read('tracks/power_8.json')) as TrackData)
const params = handlingPreset('legacy')
const line = bakedToLine(JSON.parse(read('lines/power_8.legacy.json')) as BakedLine, track, params, 0.99)!

function lap(cruise: number | null): { time: number; off: number; varied: number } {
  const sim = new TimeAttackSim(track, params, 'power_8', 'legacy')
  const driver = new LineFollower(params, line)
  const planner = cruise === null ? null : new TrafficPlanner(new RacingRibbon(track, line), line,
    params, { side: 0, clearance: 0.65, preparation: 2, cruise })
  const cars: TrafficCar[] = [{ state: sim.car.s, road: track.project(sim.car.s.x, sim.car.s.y), speed: 0 }]
  let off = 0, varied = 0
  for (let tick = 0; tick < 60 * 240 && sim.lapsCompleted < 3; tick++) {
    driver.flying = sim.lapsCompleted > 0
    driver.offTrack = sim.offTrack
    cars[0] = { state: sim.car.s, road: track.project(sim.car.s.x, sim.car.s.y), speed: sim.speed }
    if (planner && tick % 6 === 0) driver.setLine(planner.update(cars, 0))
    if (planner?.decision.lane != null) varied++
    const controls = driver.next(sim.car.s)
    sim.step(controls.steer, controls.pedal)
    if (sim.offTrack) off++
  }
  return { time: sim.bestLapTime ?? Infinity, off, varied }
}

describe('recorded-lap pace with personal straight-line variation', () => {
  it('keeps both extremes within a quarter-second of the unmodified follower', () => {
    const baseline = lap(null)
    expect(baseline.time).toBeLessThan(60)
    for (const cruise of [-0.25, 0, 0.25]) {
      const result = lap(cruise)
      expect(result.time - baseline.time, `offset ${cruise}`).toBeLessThan(0.25)
      expect(result.off, `offset ${cruise}`).toBeLessThanOrEqual(baseline.off)
      if (cruise !== 0) expect(result.varied).toBeGreaterThan(0)
    }
  })
})
