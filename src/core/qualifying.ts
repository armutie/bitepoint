import type { CarParams } from './carParams'
import { findCorners } from './corners'
import { cornerIndex, Mistakes, seeded } from './racecraft'
import { commitmentFor, difficultyByName } from './raceSession'
import { atCommitment, nearestStation, type RacingLine } from './racingLine'
import { LineFollower } from './referenceDriver'
import { TimeAttackSim } from './sim'
import type { Track } from './track'

export interface EventSetup {
  trackId: string
  preset: string
  easy: boolean
  opponents: number
  difficulty: string
}

export interface QualifyingEntry {
  driverId: number
  isPlayer: boolean
  time: number | null
}

export interface QualifyingResult {
  entries: QualifyingEntry[]
  gridOrder: number[]
  playerPosition: number
  playerTime: number | null
}

/** Race distance may change without invalidating an otherwise identical grid. */
export function eventKey(setup: EventSetup): string {
  return JSON.stringify([setup.trackId, setup.preset, setup.easy, setup.opponents, setup.difficulty])
}

export class RaceEvent {
  readonly key: string
  qualifying: QualifyingResult | null = null
  completed = false

  constructor(setup: EventSetup, readonly seed: number) {
    this.key = eventKey(setup)
  }
}

/** Five one-second red-light stages, followed by an exact control handover. */
export const QUALIFYING_INTRO_TICKS = 300

export class QualifyingIntro {
  private ticks = 0
  private readonly follower: LineFollower

  constructor(private readonly sim: TimeAttackSim, shape: RacingLine) {
    this.follower = new LineFollower(sim.car.p, shape)
    this.follower.flying = true
    this.follower.speedLimit = 25
  }

  get active(): boolean { return this.ticks < QUALIFYING_INTRO_TICKS }
  get lights(): number { return this.active ? Math.floor(this.ticks / 60) + 1 : 0 }
  get hint(): string {
    if (this.active) return 'AI DRIVING · TAKE CONTROL WHEN THE LIGHTS GO OUT'
    return this.ticks < QUALIFYING_INTRO_TICKS + 120 ? 'YOU HAVE CONTROL' : ''
  }

  /** Called once per running physics tick; pause also pauses the countdown. */
  next(): { steer: number; pedal: number } | null {
    const active = this.active
    this.ticks++
    if (!active) return null
    this.follower.offTrack = this.sim.offTrack
    return this.follower.next(this.sim.car.s)
  }
}

/** Valid laps first. Stable driver IDs survive qualifying and grid changes. */
export function qualifyingGrid(aiTimes: readonly (number | null)[], playerTime: number | null): QualifyingResult {
  const cleanTime = (time: number | null): number | null =>
    time !== null && Number.isFinite(time) && time > 0 ? time : null
  const playerId = aiTimes.length
  const entries: QualifyingEntry[] = aiTimes.map((time, driverId) =>
    ({ driverId, isPlayer: false, time: cleanTime(time) }))
  entries.push({ driverId: playerId, isPlayer: true, time: cleanTime(playerTime) })
  entries.sort((a, b) => {
    if (a.time === null) return b.time === null ? a.driverId - b.driverId : 1
    if (b.time === null) return -1
    return a.time - b.time || a.driverId - b.driverId
  })
  return { entries, gridOrder: entries.map((entry) => entry.driverId),
    playerPosition: entries.findIndex((entry) => entry.isPlayer) + 1,
    playerTime: cleanTime(playerTime) }
}

/** Shared sector-three run-up, far enough back for the five-second AI intro. */
export function beginQualifyingLap(sim: TimeAttackSim, shape: RacingLine): number {
  const start = sim.track.poseAt(-260)
  // Initial placement needs a full lookup; nearestStation only searches locally.
  let at = 0
  let nearest = Infinity
  for (let i = 0; i < shape.x.length; i++) {
    const distance = (shape.x[i]! - start.x) ** 2 + (shape.y[i]! - start.y) ** 2
    if (distance < nearest) { nearest = distance; at = i }
  }
  const next = (at + 1) % shape.x.length
  // Give the driver time to settle in before the final corner, at up to 90 km/h.
  const speed = Math.min(shape.speed[at]!, 25)
  const yaw = Math.atan2(shape.y[next]! - shape.y[at]!, shape.x[next]! - shape.x[at]!)
  const params = sim.car.p
  let gear = 1
  const rpmFor = (g: number): number => speed / params.wheelRadius
    * params.gearRatios[g]! * params.finalDrive * 60 / (2 * Math.PI)
  while (gear < params.gearRatios.length - 1 && rpmFor(gear) > params.shiftUpRpm) gear++
  sim.beginRollingApproach({ ...sim.car.s, x: shape.x[at]!, y: shape.y[at]!, yaw,
    vx: speed, vy: 0, r: shape.curvature[at]! * speed, wheelVr: speed,
    gear, engineRpm: rpmFor(gear), shiftTimer: 0 })
  return at
}

/** The actual followers and mistakes, each driving one independent flying lap. */
export async function qualifyOpponents(
  track: Track, params: CarParams, shape: RacingLine, setup: EventSetup, seed: number,
  yieldFrame: () => Promise<void> = async () => {},
): Promise<(number | null)[]> {
  const difficulty = difficultyByName(setup.difficulty)
  const drivers = Array.from({ length: setup.opponents }, (_, driverId) => {
    const rank = setup.opponents > 1 ? driverId / (setup.opponents - 1) : 0
    const line = atCommitment(shape, params, commitmentFor(difficulty, rank, shape.recorded != null))
    const sim = new TimeAttackSim(track, params, setup.trackId, setup.preset, setup.easy)
    // The rolling start is shared with the player, rather than advantaging pole.
    const station = beginQualifyingLap(sim, shape)
    const follower = new LineFollower(params, line)
    follower.flying = true
    const mistakes = new Mistakes(line.x.length,
      cornerIndex(line.x.length, findCorners(line).filter((corner) => corner.corner)),
      seeded(seed + driverId * 2654435761), difficulty.mistakeChance, difficulty.mistakeSize)
    follower.brakeBias = mistakes.biases
    return { sim, follower, intro: new QualifyingIntro(sim, shape), mistakes,
      station, done: false, time: null as number | null }
  })
  for (let tick = 0; tick < 60 * 180 && drivers.some((driver) => !driver.done); tick++) {
    for (const driver of drivers) {
      if (driver.done) continue
      driver.station = nearestStation(shape, driver.sim.car.s.x, driver.sim.car.s.y, driver.station)
      driver.mistakes.update(driver.station)
      driver.follower.offTrack = driver.sim.offTrack
      const controls = driver.intro.next() ?? driver.follower.next(driver.sim.car.s)
      const result = driver.sim.step(controls.steer, controls.pedal)
      if (result.lapCompleted) {
        driver.done = true
        driver.time = result.lapCompleted.valid ? result.lapCompleted.time : null
      }
    }
    if (tick % 300 === 299) await yieldFrame()
  }
  return drivers.map((driver) => driver.time)
}
