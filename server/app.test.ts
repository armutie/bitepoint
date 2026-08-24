import { describe, expect, it } from 'vitest'

import balanced8 from '../public/tracks/balanced_8.json'
import { handlingPreset } from '../src/core/carParams'
import { clamp, wrapAngle } from '../src/core/math'
import { TimeAttackSim, type CompletedLap } from '../src/core/sim'
import { Track, type TrackData } from '../src/core/track'
import { CURRENT_PHYSICS_RULESET } from '../src/shared/ruleset'
import { deserializeLapRecord, serializeLapRecord } from '../src/storage/records'
import { buildApp } from './app'
import { MemoryLeaderboardRepository } from './memoryRepository'

describe('leaderboard profiles', () => {
  it('claims a unique case-insensitive username and authenticates its device token', async () => {
    const app = await buildApp({ repository: new MemoryLeaderboardRepository() })
    const claimed = await app.inject({
      method: 'POST', url: '/v1/profiles', payload: { username: 'ApexFox' },
    })
    expect(claimed.statusCode).toBe(201)
    const identity = claimed.json<{ accessToken: string }>()

    const duplicate = await app.inject({
      method: 'POST', url: '/v1/profiles', payload: { username: 'apexfox' },
    })
    expect(duplicate.statusCode).toBe(409)

    const me = await app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${identity.accessToken}` },
    })
    expect(me.json()).toMatchObject({ profile: { username: 'ApexFox' } })

    await app.close()
  })

  it('rejects malformed handles without reserving them', async () => {
    const app = await buildApp({ repository: new MemoryLeaderboardRepository() })
    const response = await app.inject({
      method: 'POST', url: '/v1/profiles', payload: { username: 'two words' },
    })
    expect(response.statusCode).toBe(400)
    await app.close()
  })
})

describe('verified lap submission', () => {
  it('derives the official time and ghost from replayed inputs', async () => {
    const app = await buildApp({
      repository: new MemoryLeaderboardRepository(),
      now: () => new Date('2026-08-24T12:00:00.000Z'),
    })
    const claimed = await app.inject({
      method: 'POST', url: '/v1/profiles', payload: { username: 'LateBraker' },
    })
    const token = claimed.json<{ accessToken: string }>().accessToken
    const completed = cleanLap()
    const submitted = serializeLapRecord({
      trackId: 'balanced_8',
      preset: 'legacy',
      easy: false,
      time: 1,
      sectors: [1, 1, 1],
      path: Float64Array.of(999, 999, 999, 999, 999, 999),
      recordedAt: '2000-01-01T00:00:00.000Z',
      recording: completed.recording,
    })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/laps',
      headers: { authorization: `Bearer ${token}` },
      payload: { ruleset: CURRENT_PHYSICS_RULESET, lap: submitted },
    })
    expect(response.statusCode).toBe(201)
    const entry = response.json<{ entry: { id: string; time: number; playerName: string } }>().entry
    expect(entry.time).toBe(completed.time)
    expect(entry.playerName).toBe('LateBraker')

    const board = await app.inject({
      method: 'GET',
      url: `/v1/leaderboards?trackId=balanced_8&easy=false&ruleset=${CURRENT_PHYSICS_RULESET}`,
    })
    expect(board.json()).toMatchObject({
      scope: 'global',
      entries: [{ id: entry.id, rank: 1, verified: true, ghostAvailable: true }],
    })

    const ghostResponse = await app.inject({
      method: 'GET', url: `/v1/leaderboards/entries/${entry.id}/ghost`,
    })
    const ghost = deserializeLapRecord(ghostResponse.json<{ lap: ReturnType<typeof serializeLapRecord> }>().lap)
    expect(ghost.path?.[0]).not.toBe(999)
    expect(ghost.path?.length).toBe(completed.path.length)
    expect(ghost.recordedAt).toBe('2026-08-24T12:00:00.000Z')
    await app.close()
  }, 15_000)

  it('requires a claimed profile before doing verification work', async () => {
    const app = await buildApp({ repository: new MemoryLeaderboardRepository() })
    const response = await app.inject({
      method: 'POST', url: '/v1/laps', payload: { ruleset: CURRENT_PHYSICS_RULESET, lap: {} },
    })
    expect(response.statusCode).toBe(401)
    await app.close()
  })
})

function cleanLap(): CompletedLap {
  const track = new Track(balanced8 as TrackData)
  const sim = new TimeAttackSim(track, handlingPreset('legacy'), track.id, 'legacy')
  for (let tick = 0; tick < 45_000; tick++) {
    const result = sim.step(...autopilot(sim))
    if (result.lapCompleted?.valid) return result.lapCompleted
  }
  throw new Error('Test driver did not finish a clean lap.')
}

function autopilot(sim: TimeAttackSim): [number, number] {
  const state = sim.car.s
  const projection = sim.track.project(state.x, state.y)
  const speed = Math.max(state.vx, 1)
  const lookahead = clamp(6 + speed * 0.6, 8, 40)
  const aim = sim.track.poseAt(projection.s + lookahead)
  const desired = Math.atan2(aim.y - state.y, aim.x - state.x)
  const headingError = wrapAngle(desired - state.yaw)
  const steer = clamp(headingError * 2.2 - state.r * 0.25 - projection.lateral * 0.03, -1, 1)

  let worst = 0
  const scan = clamp(speed * 2.5, 30, 120)
  for (let distance = 5; distance <= scan; distance += 5) {
    worst = Math.max(worst, Math.abs(sim.track.signedCurvatureAt(projection.s + distance)))
  }
  const targetSpeed = clamp(Math.sqrt(13 / (worst + 1e-4)), 12, 40)
  return [steer, clamp((targetSpeed - state.vx) * 0.5, -1, 1)]
}
