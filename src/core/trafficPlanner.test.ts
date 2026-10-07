import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bakedToLine, type BakedLine } from './bakedLines'
import { handlingPreset } from './carParams'
import { LineFollower } from './referenceDriver'
import { atCommitment, lineFromPoints } from './racingLine'
import { RaceSession, difficultyByName } from './raceSession'
import { Track, type TrackData } from './track'
import { RacingRibbon, TrafficPlanner, type TrafficCar } from './trafficPlanner'

// A long straight into a left bend. The line is supplied, never optimised.
const points: [number, number][] = []
for (let x = 0; x < 600; x += 3) points.push([x, 0])
for (let a = -Math.PI / 2; a < Math.PI / 2; a += 0.03) points.push([600 + 100 * Math.cos(a), 100 + 100 * Math.sin(a)])
for (let x = 600; x > 0; x -= 3) points.push([x, 200])
for (let a = Math.PI / 2; a < 3 * Math.PI / 2; a += 0.03) points.push([100 * Math.cos(a), 100 + 100 * Math.sin(a)])
const track = new Track({ id: 'duel', label: 'Duel', blurb: '', profile: '', seed: 0,
  width: 16, length: 1800, centerline: points, halfRing: points.map(() => 8), brakeMarkers: [] })
const params = handlingPreset('legacy')
const x = new Float64Array(points.length), y = new Float64Array(points.length), speeds = new Float64Array(points.length)
for (let i = 0; i < points.length; i++) {
  const a = points[(i - 1 + points.length) % points.length]!, b = points[(i + 1) % points.length]!
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0])
  x[i] = points[i]![0] + Math.sin(angle) * 3
  y[i] = points[i]![1] - Math.cos(angle) * 3
  const onStraight = i < 200 || (i >= 305 && i < 505)
  const remaining = i < 200 ? 600 - points[i]![0] : points[i]![0]
  speeds[i] = onStraight ? Math.min(58, Math.sqrt(34 ** 2 + 22 * Math.max(0, remaining - 10))) : 34
}
const shape = lineFromPoints(track, params, x, y, speeds)

function duel(aiX: number, playerX: number, aiSpeed: number, playerSpeed: number, playerLane = -3, seed?: number) {
  const session = new RaceSession({ track, trackId: 'duel', params, preset: 'legacy', shape,
    ...(seed === undefined ? {} : { seed }),
    opponents: 1, playerSlot: 0, laps: 10,
    difficulty: { ...difficultyByName('ruthless'), mistakeChance: 0, mistakeSize: 0 } })
  for (const [slot, pos, speed, lane] of [[1, aiX, aiSpeed, -3], [0, playerX, playerSpeed, playerLane]]) {
    const car = session.race.sims[slot!]!.car
    car.reset(pos!, lane!, 0)
    car.s.vx = speed!; car.s.wheelVr = speed!; car.s.gear = 4
  }
  session.race.phase = 'racing'
  const playerLine = playerLane === -3 ? shape : lineFromPoints(track, params, x,
    Float64Array.from(y, (v) => v + playerLane + 3), speeds)
  const player = new LineFollower(params, playerLine)
  player.speedLimit = playerSpeed
  let hits = 0, off = 0
  const step = (): void => {
    const c = player.next(session.playerSim.car.s)
    session.step(c.steer, c.pedal)
    if (session.race.impacts[0]! > 1) hits++
    if (session.race.sims[1]!.offTrack) off++
  }
  return { session, step, metrics: () => ({ hits, off }) }
}

describe('race interactions driven through the real vehicle simulation', () => {
  it('avoids a needless speed collapse in Croft Bay traffic without contact', () => {
    const read = (file: string): string => readFileSync(new URL(`../../public/${file}`, import.meta.url), 'utf8')
    const bay = new Track(JSON.parse(read('tracks/power_8.json')) as TrackData)
    const driven = bakedToLine(JSON.parse(read('lines/power_8.legacy.json')) as BakedLine,
      bay, params, 1)!
    const session = new RaceSession({ track: bay, trackId: 'power_8', params, preset: 'legacy',
      shape: driven, seed: 40503, opponents: 5, playerSlot: 0, laps: 3,
      difficulty: difficultyByName('ruthless') })
    const player = new LineFollower(params, atCommitment(driven, params, 0.8))
    session.begin()
    let minimum = Infinity, samples = 0, hits = 0
    for (let tick = 0; tick < 60 * 16; tick++) {
      const controls = player.next(session.playerSim.car.s)
      session.step(controls.steer, controls.pedal)
      if (session.race.impacts.some((impact) => impact > 1)) hits++
      const follower = session.race.sims[5]!
      const s = bay.project(follower.car.s.x, follower.car.s.y).s
      if (s >= 280 && s <= 390) { minimum = Math.min(minimum, follower.speed); samples++ }
    }
    expect(samples).toBeGreaterThan(60)
    expect(minimum).toBeGreaterThan(45)
    expect(hits).toBe(0)
  })

  it('pulls out and completes a pass on a slower car without contact', () => {
    const d = duel(70, 100, 44, 38)
    let passed = false
    for (let i = 0; i < 60 * 7; i++) {
      d.step()
      if (d.session.race.sims[1]!.car.s.x > d.session.playerSim.car.s.x + 8) passed = true
    }
    expect(passed).toBe(true)
    expect(d.metrics()).toEqual({ hits: 0, off: 0 })
  })

  it('escapes a matching-speed queue when its free-road pace is faster', () => {
    const d = duel(70, 89, 42, 42)
    for (let i = 0; i < 60 * 8; i++) d.step()
    expect(d.session.race.sims[1]!.car.s.x).toBeGreaterThan(d.session.playerSim.car.s.x + 8)
    expect(d.metrics()).toEqual({ hits: 0, off: 0 })
  })

  it('keeps racing speed alongside instead of braking for a small progress lead', () => {
    const d = duel(70, 72, 48, 48, 0)
    let minimumSpeed = Infinity
    for (let i = 0; i < 120; i++) {
      d.step()
      minimumSpeed = Math.min(minimumSpeed, d.session.race.sims[1]!.speed)
    }
    expect(minimumSpeed).toBeGreaterThan(44)
    expect(d.metrics()).toEqual({ hits: 0, off: 0 })
  })

  it('takes an inside position before the braking zone under pressure', () => {
    const d = duel(370, 335, 48, 54)
    let inside = -3
    for (let i = 0; i < 110; i++) {
      d.step()
      const ai = d.session.race.sims[1]!
      if (ai.car.s.x < 490) inside = Math.max(inside, track.project(ai.car.s.x, ai.car.s.y).lateral)
    }
    expect(inside).toBeGreaterThan(-1)
    expect(d.metrics()).toEqual({ hits: 0, off: 0 })
  })

  it('preserves the supplied racing path and speeds in clear air', () => {
    const d = duel(70, 450, 48, 48)
    const car = d.session.race.sims[1]!.car.s
    const planner = new TrafficPlanner(new RacingRibbon(track, shape), shape, params)
    const traffic: TrafficCar[] = [{ state: car, speed: 48, road: track.project(car.x, car.y) }]
    const planned = planner.update(traffic, 0)
    expect(Array.from(planned.x)).toEqual(Array.from(shape.x))
    expect(Array.from(planned.y)).toEqual(Array.from(shape.y))
    expect(Array.from(planned.speed)).toEqual(Array.from(shape.speed))
  })

  it.each([1, 2, 3, 10, 101, 90210])('still completes a clean pass with race seed %i', (seed) => {
    const d = duel(70, 89, 42, 42, -3, seed)
    for (let i = 0; i < 60 * 8; i++) d.step()
    expect(d.session.race.sims[1]!.car.s.x).toBeGreaterThan(d.session.playerSim.car.s.x + 8)
    expect(d.metrics()).toEqual({ hits: 0, off: 0 })
  })

  it('varies starts reproducibly without moving before green or delaying the player', () => {
    const launches = (seed: number): number[] => {
      const s = new RaceSession({ track, trackId: 'duel', params, preset: 'legacy', shape,
        seed, opponents: 5, playerSlot: 0, laps: 1,
        difficulty: { ...difficultyByName('ruthless'), mistakeChance: 0 } })
      s.begin()
      const times = Array<number>(6).fill(-1)
      while (s.race.raceTime < 0.5) {
        s.step(0, 1)
        if (s.phase === 'countdown') expect(s.race.sims.every((sim) => sim.speed < 0.001)).toBe(true)
        else s.race.sims.forEach((sim, i) => {
          if (times[i] === -1 && sim.speed > 0.01) times[i] = s.race.raceTime
        })
      }
      return times
    }
    const first = launches(123)
    expect(launches(123)).toEqual(first)
    expect(launches(456)).not.toEqual(first)
    expect(first[0]).toBeLessThan(0.04)
    expect(new Set(first.slice(1)).size).toBeGreaterThan(1)
    for (const reaction of first.slice(1)) {
      expect(reaction).toBeGreaterThanOrEqual(0.05)
      expect(reaction).toBeLessThanOrEqual(0.27)
    }
  })
})
