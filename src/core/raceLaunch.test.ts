import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { RaceLaunch } from './raceLaunch'
import { RaceSession, difficultyByName } from './raceSession'
import { bakedToLine, type BakedLine } from './bakedLines'
import { handlingPreset } from './carParams'
import { Track, type TrackData } from './track'

const read = (file: string): string => readFileSync(new URL(`../../public/${file}`, import.meta.url), 'utf8')
const track = new Track(JSON.parse(read('tracks/power_8.json')) as TrackData)
const params = handlingPreset('legacy')
const shape = bakedToLine(JSON.parse(read('lines/power_8.legacy.json')) as BakedLine, track, params, 1)!
const session = (seed = 123): RaceSession => new RaceSession({ track, trackId: 'power_8', params,
  preset: 'legacy', shape, seed, playerLaunch: true, opponents: 1, laps: 1,
  difficulty: difficultyByName('ruthless') })

describe('keyboard race launch', () => {
  it('has AI throttle staged before green and applies it at clutch release', () => {
    const s = session()
    const raceStep = vi.spyOn(s.race, 'step')
    s.begin()
    s.step(0, 0, 0, undefined, { clutch: true, throttle: false })
    s.step(0, 1, 0, undefined, { clutch: true, throttle: true })
    expect(s.phase).toBe('countdown')
    expect(raceStep.mock.calls.at(-1)![0][0]!.throttle).toBe(1)
    expect(s.race.sims[0]!.speed).toBe(0)

    let ticks = 0
    while (s.phase === 'countdown' && ticks++ < 400) {
      s.step(0, 1, 0, undefined, { clutch: true, throttle: true })
    }
    expect(s.phase).toBe('racing')
    expect(raceStep.mock.calls.at(-1)![0][0]!.throttle).toBe(0)
    let released = false
    for (let i = 0; i < 20; i++) {
      s.step(0, 1, 0, undefined, { clutch: true, throttle: true })
      if (raceStep.mock.calls.at(-1)![0][0]!.throttle > 0) {
        expect(raceStep.mock.calls.at(-1)![0][0]!.throttle).toBeGreaterThan(0.95)
        released = true
        break
      }
    }
    expect(released).toBe(true)
    expect(s.race.sims[0]!.speed).toBeGreaterThan(0)
  })

  it('requires R then a fresh throttle press, and release after green', () => {
    const launch = new RaceLaunch()
    launch.update(false, true, false)
    launch.update(true, true, false)
    expect(launch.state).toBe('throttle')
    launch.update(true, false, false)
    launch.update(true, true, false)
    expect(launch.state).toBe('ready')
    launch.update(true, true, true)
    expect(launch.state).toBe('ready')
    launch.update(false, true, true)
    expect(launch.state).toBe('launched')
  })

  it('does not auto-launch after an early release, even if W stays held', () => {
    const launch = new RaceLaunch()
    launch.update(true, false, false)
    launch.update(true, true, false)
    launch.update(false, true, false)
    expect(launch.state).toBe('early')
    launch.update(false, true, true)
    expect(launch.state).toBe('early')
    launch.update(true, true, true)
    launch.update(true, false, true)
    launch.update(true, true, true)
    launch.update(false, true, true)
    expect(launch.state).toBe('launched')
  })

  it('does not launch when both keys are released, including focus loss', () => {
    const launch = new RaceLaunch()
    launch.update(true, false, false)
    launch.update(true, true, false)
    launch.update(false, false, true)
    expect(launch.state).not.toBe('launched')
  })

  it('holds the actual player while AI reacts, and drives only after clutch release', () => {
    const s = session()
    s.begin()
    const step = (clutch: boolean, throttle: boolean): void => {
      s.step(0, throttle ? 1 : 0, 0, undefined, { clutch, throttle })
    }
    for (let i = 0; i < 100; i++) step(false, true)
    expect(s.phase).toBe('waiting')
    expect(s.playerSim.speed).toBe(0)
    expect(s.race.sims[0]!.speed).toBe(0)
    step(true, false)
    expect(s.phase).toBe('countdown')
    step(true, true)
    expect(s.phase).toBe('countdown')
    for (let i = 0; i < 420; i++) step(true, true)
    expect(s.phase).toBe('racing')
    expect(s.playerSim.speed).toBe(0)
    expect(s.race.sims[0]!.speed).toBeGreaterThan(1)
    step(false, true)
    expect(s.launch!.state).toBe('launched')
    expect(s.playerSim.speed).toBeGreaterThan(0)
  })

  it('waits indefinitely for R, then starts the lights without requiring W', () => {
    const s = session()
    s.begin()
    for (let ticks = 0; ticks < 600; ticks++) {
      s.step(0, 1, 0, undefined, { clutch: false, throttle: true })
    }
    expect(s.phase).toBe('waiting')
    expect(s.race.lightCount).toBe(0)
    expect(s.race.raceTime).toBe(0)
    expect(s.playerSim.speed).toBe(0)
    expect(s.race.sims[0]!.speed).toBe(0)
    s.step(0, 0, 0, undefined, { clutch: true, throttle: false })
    expect(s.phase).toBe('countdown')
    let ticks = 0
    while (s.phase === 'countdown' && ticks++ < 400) {
      s.step(0, 1, 0, undefined, { clutch: false, throttle: true })
    }
    expect(s.phase).toBe('racing')
    expect(s.playerSim.speed).toBe(0)
    for (let i = 0; i < 20; i++) {
      s.step(0, 1, 0, undefined, { clutch: false, throttle: true })
    }
    expect(s.race.sims[0]!.speed).toBeGreaterThan(0)
    expect(s.playerSim.speed).toBe(0)
    s.step(0, 0, 0, undefined, { clutch: true, throttle: false })
    s.step(0, 1, 0, undefined, { clutch: true, throttle: true })
    expect(s.launch!.state).toBe('ready')
    s.step(0, 1, 0, undefined, { clutch: false, throttle: true })
    expect(s.launch!.state).toBe('launched')
    expect(s.playerSim.speed).toBeGreaterThan(0)
  })

  it('varies the all-red hold by seed without revealing the time in the light sequence', () => {
    const run = (seed: number): number => {
      const s = session(seed)
      s.begin()
      s.step(0, 0, 0, undefined, { clutch: true, throttle: false })
      let ticks = 1
      while (s.phase === 'countdown' && ticks < 400) {
        if (ticks >= 180) expect(s.race.lightCount).toBe(5)
        s.step(0, 0, 0, undefined, { clutch: false, throttle: false })
        ticks++
      }
      expect(s.race.lightCount).toBe(0)
      expect(ticks).toBeGreaterThanOrEqual(241)
      expect(ticks).toBeLessThanOrEqual(361)
      return ticks
    }
    expect(run(123)).toBe(run(123))
    expect(new Set([1, 2, 3, 100, 123].map(run)).size).toBeGreaterThan(1)
  })
})
