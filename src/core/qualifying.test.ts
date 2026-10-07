import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bakedToLine, type BakedLine } from './bakedLines'
import { handlingPreset } from './carParams'
import { gridPose } from './grid'
import { beginQualifyingLap, eventKey, QualifyingIntro, QUALIFYING_INTRO_TICKS, qualifyingGrid, qualifyOpponents } from './qualifying'
import { difficultyByName, RaceSession } from './raceSession'
import { LineFollower } from './referenceDriver'
import { DT, TimeAttackSim } from './sim'
import { Track, type TrackData } from './track'

const read = (file: string) => JSON.parse(readFileSync(new URL(`../../public/${file}`, import.meta.url), 'utf8'))
const track = new Track(read('tracks/power_8.json') as TrackData)
const params = handlingPreset('legacy')
const shape = bakedToLine(read('lines/power_8.legacy.json') as BakedLine, track, params, 1)!
const setup = { trackId: 'power_8', preset: 'legacy', easy: false, opponents: 3, difficulty: 'quick' }

describe('one-shot qualifying', () => {
  it('sorts valid times into the actual starting grid, including the player', () => {
    const result = qualifyingGrid([57, 55, 56], 55.5)
    expect(result.gridOrder).toEqual([1, 3, 2, 0])
    expect(result.playerPosition).toBe(2)
    expect(result.entries.map((entry) => entry.time)).toEqual([55, 55.5, 56, 57])
  })

  it('puts an invalid or abandoned player attempt last, including behind AI with no time', () => {
    for (const time of [null, NaN, Infinity, -1, 0]) {
      const result = qualifyingGrid([null, 55, 56], time)
      expect(result.gridOrder).toEqual([1, 2, 0, 3])
      expect(result.playerPosition).toBe(4)
      expect(result.playerTime).toBeNull()
    }
  })

  it('uses a stable order for tied laps and can award pole', () => {
    expect(qualifyingGrid([55, 55, 56], 55).gridOrder).toEqual([0, 1, 3, 2])
    expect(qualifyingGrid([55, 56, 57], 54).playerPosition).toBe(1)
  })

  it('starts moving further back in sector three with the lap clock unarmed', () => {
    const sim = new TimeAttackSim(track, params, setup.trackId, setup.preset, false)
    beginQualifyingLap(sim, shape)
    expect(sim.timingArmed).toBe(false)
    expect(sim.currentLapTime).toBe(0)
    expect(sim.speed).toBeGreaterThan(20)
    expect(sim.lapsCompleted).toBe(0)
    expect(sim.bestLapTime).toBeNull()
    const projection = track.project(sim.car.s.x, sim.car.s.y)
    expect(track.length - projection.s).toBeGreaterThan(250)
    expect(track.length - projection.s).toBeLessThan(270)
    expect(Math.abs(projection.lateral)).toBeLessThan(projection.half)
  })

  it('drives a repeatable five-second intro and hands over on the approach straight before timing', () => {
    const run = () => {
      const sim = new TimeAttackSim(track, params, setup.trackId, setup.preset, false)
      beginQualifyingLap(sim, shape)
      const intro = new QualifyingIntro(sim, shape)
      for (let tick = 0; tick < QUALIFYING_INTRO_TICKS; tick++) {
        expect(intro.active).toBe(true)
        expect(intro.lights).toBe(Math.floor(tick / 60) + 1)
        const controls = intro.next()!
        sim.step(controls.steer, controls.pedal)
        expect(sim.offTrack).toBe(false)
        expect(sim.timingArmed).toBe(false)
      }
      expect(intro.active).toBe(false)
      expect(intro.lights).toBe(0)
      expect(intro.hint).toBe('YOU HAVE CONTROL')
      expect(intro.next()).toBeNull()
      const projection = track.project(sim.car.s.x, sim.car.s.y)
      expect(track.length - projection.s).toBeGreaterThan(100)
      expect(track.length - projection.s).toBeLessThan(160)
      expect(Math.abs(track.curvature[projection.segment]!)).toBeLessThan(0.003)
      expect(sim.currentLapTime).toBe(0)
      expect(sim.speed).toBeGreaterThan(20)
      for (let tick = 0; tick < 120; tick++) intro.next()
      expect(intro.hint).toBe('')
      return sim.car.s
    }
    expect(run()).toEqual(run())
  })

  it('arms at the first crossing and completes exactly one timed lap on the next', () => {
    const sim = new TimeAttackSim(track, params, setup.trackId, setup.preset, false)
    beginQualifyingLap(sim, shape)
    const follower = new LineFollower(params, shape)
    follower.flying = true
    const intro = new QualifyingIntro(sim, shape)
    let firstCrossing = 0
    let completed = false
    for (let tick = 1; tick <= 60 * 90; tick++) {
      const controls = intro.next() ?? follower.next(sim.car.s)
      const result = sim.step(controls.steer, controls.pedal)
      if (!firstCrossing && result.crossedFinish) {
        firstCrossing = tick
        expect(firstCrossing * DT).toBeGreaterThan(5)
        expect(sim.timingArmed).toBe(true)
        expect(sim.currentLapTime).toBe(0)
        expect(result.lapCompleted).toBeNull()
        expect(sim.currentSectors).toEqual([null, null, null])
      } else if (!firstCrossing) {
        expect(sim.timingArmed).toBe(false)
        expect(sim.currentLapTime).toBe(0)
        expect(result.lapCompleted).toBeNull()
      }
      if (result.lapCompleted) {
        const lap = result.lapCompleted
        expect(lap.time).toBeCloseTo((tick - firstCrossing) * DT)
        expect(lap.valid).toBe(true)
        expect(lap.recording.inputs.length / 2).toBe(tick - firstCrossing)
        expect(sim.lapsCompleted).toBe(1)
        completed = true
        break
      }
    }
    expect(completed).toBe(true)
  })

  it('measures reproducible valid AI laps with the real vehicle simulation', async () => {
    const field = { ...setup, opponents: 2 }
    const first = await qualifyOpponents(track, params, shape, field, 123)
    const second = await qualifyOpponents(track, params, shape, field, 123)
    expect(first).toEqual(second)
    expect(first).toHaveLength(2)
    for (const time of first) {
      expect(time).not.toBeNull()
      expect(time!).toBeGreaterThan(50)
      expect(time!).toBeLessThan(70)
    }
  }, 15000)

  it('invalidates qualifying when the field or driving conditions change', () => {
    expect(eventKey(setup)).not.toBe(eventKey({ ...setup, opponents: 5 }))
    expect(eventKey(setup)).not.toBe(eventKey({ ...setup, difficulty: 'steady' }))
    expect(eventKey(setup)).not.toBe(eventKey({ ...setup, easy: true }))
    const shortRace = { ...setup, laps: 3 }
    const longRace = { ...setup, laps: 7 }
    expect(eventKey(shortRace)).toBe(eventKey(longRace))
  })
})

describe('qualified race grid', () => {
  const race = (gridOrder?: readonly number[]) => new RaceSession({
    ...setup, params, track, shape, laps: 3, seed: 123, playerLaunch: true,
    difficulty: difficultyByName(setup.difficulty), ...(gridOrder ? { gridOrder } : {}),
  })

  it('places the player in their qualified box and retains AI identities and pace', () => {
    const session = race([1, 3, 0, 2])
    const baseline = race()
    expect(session.playerSlot).toBe(1)
    expect(session.playerSim.slot).toBe(1)
    const pose = gridPose(track, 1)
    expect(session.playerSim.car.s.x).toBeCloseTo(pose.x)
    expect(session.playerSim.car.s.y).toBeCloseTo(pose.y)
    expect(Array.from({ length: 4 }, (_, slot) => session.driverIdOf(slot))).toEqual([1, 3, 0, 2])
    expect(session.planOf(2)!.reference.speed).toEqual(baseline.planOf(0)!.reference.speed)
    session.begin()
    session.step(0, 1, 0, undefined, { clutch: false, throttle: true })
    expect(session.phase).toBe('waiting')
    session.step(0, 0, 0, undefined, { clutch: true, throttle: false })
    expect(session.phase).toBe('countdown')
  })

  it('rejects missing, duplicated or unknown drivers instead of building the wrong grid', () => {
    expect(() => race([0, 1, 1, 3])).toThrow()
    expect(() => race([0, 1, 3])).toThrow()
    expect(() => race([0, 1, 2, 8])).toThrow()
  })
})
