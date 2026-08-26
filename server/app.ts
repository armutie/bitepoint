import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import balanced8 from '../public/tracks/balanced_8.json'
import power3 from '../public/tracks/power_3.json'
import power4 from '../public/tracks/power_4.json'
import power8 from '../public/tracks/power_8.json'
import silverstone from '../public/tracks/silverstone.json'
import { applyEasyAids, handlingPreset, type PresetName } from '../src/core/carParams'
import { lapUsedTc, verifyLapRecording } from '../src/core/sim'
import { Track, type TrackData } from '../src/core/track'
import { CURRENT_PHYSICS_RULESET } from '../src/shared/ruleset'
import { parseUsername, usernameHint } from '../src/shared/playerIdentity'
import type { LeaderboardEntry } from '../src/storage/leaderboard'
import {
  deserializeLapRecord, serializeLapRecord, type LapRecord, type SerializedLapRecord,
} from '../src/storage/records'
import type { LeaderboardRepository, Player } from './repository'

const TRACKS = new Map(
  [balanced8, power3, power4, power8, silverstone]
    .map((data) => new Track(data as TrackData))
    .map((track) => [track.id, track]),
)
const PRESETS: readonly PresetName[] = ['legacy', 'classic']
const MAX_BOARD_SIZE = 100

export interface BuildAppOptions {
  repository: LeaderboardRepository
  allowedOrigins?: string[]
  now?: () => Date
}

interface ProfileResponse {
  profile: { id: string; username: string }
  accessToken: string
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 4 * 1024 * 1024,
    requestTimeout: 30_000,
  })
  const now = options.now ?? (() => new Date())

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || isAllowedOrigin(origin, options.allowedOrigins ?? [])) callback(null, true)
      else callback(new Error('Origin is not allowed.'), false)
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type'],
  })
  await app.register(rateLimit, { global: false })

  app.get('/health', async () => ({ ok: true, ruleset: CURRENT_PHYSICS_RULESET }))

  app.post<{ Body: { username?: unknown } }>('/v1/profiles', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const parsed = parseUsername(request.body?.username)
    if (!parsed) return fail(reply, 400, `Username must be ${usernameHint}`)

    const accessToken = accessSecret()
    const createdAt = now().toISOString()
    const player = await options.repository.createPlayer({
      id: randomUUID(),
      username: parsed.username,
      usernameKey: parsed.key,
      tokenHash: secretHash(accessToken),
      createdAt,
    })
    if (!player) return fail(reply, 409, 'That username is already taken.')

    reply.code(201)
    return profileResponse(player, accessToken)
  })

  app.get('/v1/me', async (request, reply) => {
    const player = await authenticatedPlayer(options.repository, request.headers.authorization)
    if (!player) return fail(reply, 401, 'Profile token is missing or invalid.')
    return { profile: publicProfile(player) }
  })

  app.get<{
    Querystring: { trackId?: string; easy?: string; ruleset?: string; limit?: string }
  }>('/v1/leaderboards', async (request, reply) => {
    const key = boardKey(request.query)
    if (!key) return fail(reply, 400, 'Leaderboard query is invalid.')
    const limit = clampLimit(request.query.limit)
    return options.repository.listBoard(key, limit)
  })

  app.get<{ Params: { id: string } }>(
    '/v1/leaderboards/entries/:id/ghost',
    async (request, reply) => {
      const lap = await options.repository.ghost(request.params.id)
      if (!lap) return fail(reply, 404, 'That ghost is no longer available.')
      return { lap }
    },
  )

  app.post<{
    Body: { ruleset?: unknown; lap?: unknown }
  }>('/v1/laps', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.headers.authorization ?? request.ip,
      },
    },
  }, async (request, reply): Promise<{ entry: LeaderboardEntry } | unknown> => {
    const player = await authenticatedPlayer(options.repository, request.headers.authorization)
    if (!player) return fail(reply, 401, 'Claim a username before submitting laps.')
    if (request.body?.ruleset !== CURRENT_PHYSICS_RULESET) {
      return fail(reply, 409, 'This physics ruleset is not accepting laps.')
    }

    const submitted = parseLap(request.body?.lap)
    if (!submitted) return fail(reply, 400, 'Lap payload is malformed.')
    const track = TRACKS.get(submitted.trackId)
    if (!track) return fail(reply, 400, 'Track is not on the current calendar.')
    if (!PRESETS.includes(submitted.preset as PresetName)) {
      return fail(reply, 400, 'Car setup is not released.')
    }
    if (
      submitted.trackId !== submitted.recording.trackId ||
      submitted.preset !== submitted.recording.preset ||
      submitted.easy !== submitted.recording.easy
    ) {
      return fail(reply, 400, 'Lap metadata does not match its replay.')
    }

    const baseParams = handlingPreset(submitted.preset as PresetName)
    const params = submitted.easy ? applyEasyAids(baseParams) : baseParams
    const verified = verifyLapRecording(track, params, submitted.recording)
    if (
      !verified.accepted || verified.time === undefined || !verified.sectors ||
      !verified.trace || !verified.path
    ) {
      return fail(reply, 422, verified.reason ?? 'Lap replay could not be verified.')
    }

    // Every official field is derived here. In particular, the submitted path
    // is ignored: otherwise a valid time could carry a deliberately false ghost.
    const recordedAt = now().toISOString()
    const official: LapRecord = {
      trackId: track.id,
      preset: submitted.preset,
      easy: submitted.easy,
      time: verified.time,
      sectors: verified.sectors,
      trace: verified.trace,
      path: verified.path,
      recordedAt,
      recording: submitted.recording,
    }
    const entry = await options.repository.submitLap({
      id: randomUUID(),
      playerId: player.id,
      trackId: track.id,
      easy: official.easy,
      ruleset: CURRENT_PHYSICS_RULESET,
      preset: official.preset,
      tc: lapUsedTc(official.recording),
      abs: official.recording.abs ?? false,
      time: official.time,
      sectors: official.sectors,
      recordedAt,
      replay: serializeLapRecord(official),
    })
    reply.code(201)
    return { entry }
  })

  app.addHook('onClose', async () => options.repository.close())
  return app
}

function parseLap(value: unknown): LapRecord | null {
  if (!value || typeof value !== 'object') return null
  const serialised = value as Partial<SerializedLapRecord>
  if (
    serialised.v !== 1 || typeof serialised.trackId !== 'string' ||
    typeof serialised.preset !== 'string' || typeof serialised.easy !== 'boolean' ||
    typeof serialised.inputs !== 'string' || typeof serialised.start !== 'object'
  ) return null
  try {
    return deserializeLapRecord(serialised as SerializedLapRecord)
  } catch {
    return null
  }
}

function boardKey(query: {
  trackId?: string
  easy?: string
  ruleset?: string
}): { trackId: string; easy: boolean; ruleset: string } | null {
  if (!query.trackId || !TRACKS.has(query.trackId)) return null
  if (query.easy !== 'true' && query.easy !== 'false') return null
  if (query.ruleset !== CURRENT_PHYSICS_RULESET) return null
  return { trackId: query.trackId, easy: query.easy === 'true', ruleset: query.ruleset }
}

function clampLimit(value: string | undefined): number {
  const parsed = Number(value ?? 50)
  if (!Number.isFinite(parsed)) return 50
  return Math.min(MAX_BOARD_SIZE, Math.max(1, Math.floor(parsed)))
}

async function authenticatedPlayer(
  repository: LeaderboardRepository,
  authorization: string | undefined,
): Promise<Player | null> {
  const match = /^Bearer (bp_[A-Za-z0-9_-]{32,})$/.exec(authorization ?? '')
  return match?.[1] ? repository.playerForToken(secretHash(match[1])) : null
}

const accessSecret = (): string => `bp_${randomBytes(32).toString('base64url')}`

const secretHash = (secret: string): string => createHash('sha256').update(secret).digest('hex')
const publicProfile = (player: Player): { id: string; username: string } => ({
  id: player.id,
  username: player.username,
})

function profileResponse(player: Player, accessToken: string): ProfileResponse {
  return {
    profile: publicProfile(player),
    accessToken,
  }
}

function fail(reply: FastifyReply, status: number, message: string): unknown {
  return reply.code(status).type('text/plain; charset=utf-8').send(message)
}

function isAllowedOrigin(origin: string, configured: string[]): boolean {
  if (configured.includes(origin)) return true
  try {
    const url = new URL(origin)
    return (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      (url.protocol === 'http:' || url.protocol === 'https:')
  } catch {
    return false
  }
}
