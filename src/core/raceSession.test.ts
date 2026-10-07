/**
 * The join between a person and a field of AI.
 *
 * `Race` is already tested on its own terms and `LineFollower` is measured by
 * the benches. What is untested until here is the thing that goes wrong
 * silently: that the player's slot really is driven by the player's input and
 * not by a follower, that the AI slots really are driven by the AI, and that a
 * whole race gets to the flag with everybody on the road. A wiring mistake in
 * any of those still produces a race that runs — it just is not the race
 * anybody asked for.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { handlingPreset } from './carParams'
import { bakedToLine, type BakedLine } from './bakedLines'
import { buildRacingLine } from './racingLine'
import { DIFFICULTIES, difficultyByName, MAX_OPPONENTS, RaceSession } from './raceSession'
import { DT } from './sim'
import { Track, type TrackData } from './track'

function loadTrack(id: string): Track {
  const path = fileURLToPath(new URL(`../../public/tracks/${id}.json`, import.meta.url))
  return new Track(JSON.parse(readFileSync(path, 'utf-8')) as TrackData)
}

const TRACK_ID = 'technical_8'
const track = loadTrack(TRACK_ID)
const params = handlingPreset('classic')
// The shape only, found once — every driver's speeds come off it per commitment.
const shape = buildRacingLine(track, params, { optimise: 2 })

function session(over: Partial<Parameters<typeof makeSetup>[0]> = {}): RaceSession {
  return new RaceSession(makeSetup(over))
}

function makeSetup(over: {
  laps?: number; opponents?: number; difficulty?: string; playerSlot?: number
} = {}): ConstructorParameters<typeof RaceSession>[0] {
  return {
    track,
    trackId: TRACK_ID,
    params,
    preset: 'classic',
    shape,
    laps: over.laps ?? 1,
    opponents: over.opponents ?? 3,
    difficulty: difficultyByName(over.difficulty ?? 'quick'),
    ...(over.playerSlot === undefined ? {} : { playerSlot: over.playerSlot }),
  }
}

describe('race session', () => {
  it('puts the player at the back of the grid by default', () => {
    const s = session({ opponents: 3 })
    expect(s.size).toBe(4)
    expect(s.playerSlot).toBe(3)
  })

  it('caps the field at the painted grid', () => {
    const s = session({ opponents: 99 })
    expect(s.size).toBe(MAX_OPPONENTS + 1)
  })

  it('drives the player slot from the player, and nothing else', () => {
    const s = session({ opponents: 2, playerSlot: 0 })
    s.begin()
    // Through the countdown, so the cars are released.
    for (let i = 0; i < 60 * 4; i++) s.step(0, 0)

    const before = s.race.sims.map((sim) => sim.car.s.x)
    // Full lock and full throttle for the player only. If the wiring is wrong,
    // either nobody moves like this or everybody does.
    for (let i = 0; i < 60; i++) s.step(1, 1)
    const moved = s.race.sims.map((sim, i) => Math.abs(sim.car.s.x - before[i]!))

    expect(moved[0]).toBeGreaterThan(0)
    // The AI cars are following a line, so they moved too — what must differ is
    // the STEERING, which only the player was given.
    expect(Math.abs(s.race.sims[0]!.car.s.steer)).toBeGreaterThan(
      Math.abs(s.race.sims[1]!.car.s.steer),
    )
  })

  it('holds every car still until the lights go out', () => {
    const s = session({ opponents: 3 })
    s.begin()
    expect(s.phase).toBe('countdown')
    for (let i = 0; i < 30; i++) s.step(0, 1)
    for (const sim of s.race.sims) expect(Math.hypot(sim.car.s.vx, sim.car.s.vy)).toBeLessThan(0.5)
  })

  it('gets the supported Croft Bay field round while the player sits on the grid', () => {
    const track = loadTrack('power_8')
    const params = handlingPreset('legacy')
    const baked = JSON.parse(readFileSync(new URL('../../public/lines/power_8.legacy.json', import.meta.url),
      'utf8')) as BakedLine
    const shape = bakedToLine(baked, track, params, 1)!
    const s = new RaceSession({ track, params, shape, trackId: 'power_8', preset: 'legacy',
      difficulty: difficultyByName('quick'), opponents: 3, laps: 1 })
    s.begin()
    let offTicks = 0
    for (let i = 0; i < 60 * 60 * 5; i++) {
      // The player never moves, so nothing the player does can be what gets the
      // race run. The AI has to take itself to the flag.
      s.step(0, 0)
      for (let k = 0; k < s.size; k++) {
        if (k !== s.playerSlot && s.race.finishedAt(k) === null && s.race.sims[k]!.offTrack) offTicks++
      }
      if (s.race.standings().every((k) => k === s.playerSlot || s.race.finishedAt(k) !== null)) break
    }
    for (let k = 0; k < s.size; k++) {
      if (k === s.playerSlot) continue
      expect(s.race.finishedAt(k)).not.toBeNull()
      expect(s.race.sims[k]!.lapsCompleted).toBeGreaterThanOrEqual(1)
    }
    // Measure the timed race, not a finished car held at its crossing position.
    // A little grass is a racing incident; seconds of it is a broken driver.
    expect(offTicks * DT).toBeLessThan(6)
    // And the parked player must NOT hang the race for the person playing it.
    expect(s.playerFinished).toBe(false)
    expect(s.results()).toHaveLength(s.size)
    expect(s.results()[s.results().length - 1]!.isPlayer).toBe(true)
  })

  it('ranks the field by pace, quickest on pole', () => {
    const s = session({ opponents: 4, laps: 1, playerSlot: 4 })
    s.begin()
    for (let i = 0; i < 60 * 60 * 5; i++) {
      s.step(0, 0)
      if (s.phase === 'finished') break
    }
    // Pole is the quickest commitment, so on a clean race it finishes ahead of
    // the back of the AI grid.
    const order = s.race.standings().filter((k) => k !== s.playerSlot)
    expect(order[0]).toBeLessThan(order[order.length - 1]!)
  })

  it('reports the player position and the gaps around them', () => {
    const s = session({ opponents: 3 })
    s.begin()
    for (let i = 0; i < 60 * 20; i++) s.step(0, 0)
    const pos = s.playerPosition()
    expect(pos).toBeGreaterThanOrEqual(1)
    expect(pos).toBeLessThanOrEqual(s.size)
    // Parked at the back: somebody is ahead, nobody is behind.
    expect(s.gapAhead()).not.toBeNull()
    expect(s.gapAhead()!).toBeGreaterThan(0)
    expect(s.gapBehind()).toBeNull()
  })

  it('offers difficulties that are ordered and distinct', () => {
    for (let i = 1; i < DIFFICULTIES.length; i++) {
      expect(DIFFICULTIES[i]!.top).toBeGreaterThan(DIFFICULTIES[i - 1]!.top)
    }
    expect(difficultyByName('nonsense').name).toBe('quick')
  })
})

describe('interval timing', () => {
  it('reports a gap in seconds that matches how far apart the cars are', () => {
    const s = session({ opponents: 3, laps: 2, playerSlot: 3 })
    s.begin()
    for (let i = 0; i < 60 * 40; i++) s.step(0, 0)

    const order = s.race.standings()
    const leader = order[0]!
    const second = order[1]!
    const gap = s.gapSeconds(leader, second)
    expect(gap).not.toBeNull()
    expect(gap!).toBeGreaterThan(0)

    // Cross-check against distance and speed. They are different calculations
    // of the same thing and should agree to within a car length's worth of time.
    const metres = s.race.distanceTravelled(leader) - s.race.distanceTravelled(second)
    const v = Math.hypot(s.race.sims[second]!.car.s.vx, s.race.sims[second]!.car.s.vy)
    if (v > 5) expect(Math.abs(gap! - metres / v)).toBeLessThan(0.6)
  })

  it('says null rather than guessing when the cars share no ground', () => {
    const s = session({ opponents: 2, playerSlot: 2 })
    s.begin()
    for (let i = 0; i < 60 * 25; i++) s.step(0, 0)

    // The player never moved off the grid, so nobody is behind them.
    expect(s.intervalBehind()).toBeNull()
    // And the interval AHEAD is null too, which is the honest answer and worth
    // pinning: the car ahead started ahead and drove away, so it has never been
    // where this car is now. There is no elapsed time to report, and inventing
    // one from distance over speed would put a confident wrong number on the
    // screen at exactly the moment a driver is looking at it.
    expect(s.intervalAhead()).toBeNull()
  })

  it('reports an interval once cars have covered the same ground', () => {
    const s = session({ opponents: 3, laps: 2, playerSlot: 3 })
    s.begin()
    for (let i = 0; i < 60 * 60; i++) s.step(0, 0)
    const order = s.race.standings().filter((k) => k !== s.playerSlot)
    // Every AI pair has covered the same road by now, so every interval between
    // them is a real number and they increase down the order.
    for (let i = 1; i < order.length; i++) {
      const gap = s.gapSeconds(order[0]!, order[i]!)
      expect(gap).not.toBeNull()
      expect(gap!).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('race-local bests', () => {
  it('starts with no sector or lap bests at all', () => {
    const s = session({ opponents: 3 })
    expect(s.fastestSectors).toEqual([null, null, null])
    expect(s.fastestLap).toBeNull()
    // Nothing can be purple before anybody has driven a sector.
    for (let i = 0; i < 3; i++) expect(s.isRaceFastestSector(i, 1)).toBe(false)
  })

  it('collects the fastest sector across the WHOLE field, not one car', () => {
    const s = session({ opponents: 4, laps: 2, playerSlot: 4 })
    s.begin()
    for (let i = 0; i < 60 * 90; i++) s.step(0, 0)

    // Every sector has been set by somebody by now.
    for (let i = 0; i < 3; i++) expect(s.fastestSectors[i]).not.toBeNull()

    // And each one is genuinely the minimum over the field: no car's own best
    // for that sector is quicker than the race's.
    for (let i = 0; i < 3; i++) {
      const race = s.fastestSectors[i]!
      for (const sim of s.race.sims) {
        const own = sim.fastestSectors[i]
        if (own !== null && own !== undefined) expect(race).toBeLessThanOrEqual(own + 1e-9)
      }
    }
  })

  it('credits the fastest lap to the car that actually set it', () => {
    const s = session({ opponents: 4, laps: 2, playerSlot: 4 })
    s.begin()
    for (let i = 0; i < 60 * 90; i++) s.step(0, 0)

    expect(s.fastestLap).not.toBeNull()
    const { slot, time } = s.fastestLap!
    // The parked player never set a lap, so it cannot be theirs.
    expect(slot).not.toBe(s.playerSlot)
    // And nobody in the field has a quicker valid lap than the one credited.
    for (const sim of s.race.sims) {
      if (sim.bestLapTime !== null) expect(time).toBeLessThanOrEqual(sim.bestLapTime + 1e-9)
    }
    expect(s.race.sims[slot]!.bestLapTime).toBeCloseTo(time, 6)
  })

  it('calls a split purple only when nothing in the race beat it', () => {
    const s = session({ opponents: 3, laps: 2 })
    s.begin()
    for (let i = 0; i < 60 * 90; i++) s.step(0, 0)
    const best = s.fastestSectors[0]!
    expect(s.isRaceFastestSector(0, best)).toBe(true)
    expect(s.isRaceFastestSector(0, best - 0.5)).toBe(true)
    expect(s.isRaceFastestSector(0, best + 0.5)).toBe(false)
  })
})

describe('the player lap delta', () => {
  /** Fold a lap of `time` seconds into the session's player bookkeeping. */
  const lap = (s: RaceSession, time: number): void => {
    // Reach the same path a completed lap takes, without driving one.
    const results = s.race.sims.map((_, i) => (
      i === s.playerSlot ? { lapCompleted: { time, valid: true } } : {}
    ))
    ;(s as unknown as { recordBests: (r: unknown) => void }).recordBests(results)
  }

  it('has nothing to say about the first lap', () => {
    const s = session({ opponents: 2 })
    lap(s, 60)
    expect(s.lastLapDelta).toBeNull()
    expect(s.playerBest).toBe(60)
  })

  it('measures a new best against the PREVIOUS best, not against itself', () => {
    const s = session({ opponents: 2 })
    lap(s, 60)
    lap(s, 58)
    // The lap that sets the best is the one the number matters for; comparing
    // it to the standing best including itself would read a useless 0.000.
    expect(s.lastLapDelta).toBeCloseTo(-2, 6)
    expect(s.playerBest).toBe(58)
  })

  it('measures a slower lap against the best so far', () => {
    const s = session({ opponents: 2 })
    lap(s, 60)
    lap(s, 58)
    lap(s, 59)
    expect(s.lastLapDelta).toBeCloseTo(1, 6)
    // And a slower lap does not become the best.
    expect(s.playerBest).toBe(58)
  })
})
