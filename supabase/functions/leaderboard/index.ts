import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'

import balanced8 from '../../../public/tracks/balanced_8.json' with { type: 'json' }
import power3 from '../../../public/tracks/power_3.json' with { type: 'json' }
import power4 from '../../../public/tracks/power_4.json' with { type: 'json' }
import power8 from '../../../public/tracks/power_8.json' with { type: 'json' }
import { applyEasyAids, handlingPreset, type PresetName } from '../../../src/core/carParams.ts'
import { lapUsedTc, verifyLapRecording } from '../../../src/core/sim.ts'
import { Track, type TrackData } from '../../../src/core/track.ts'
import { CURRENT_PHYSICS_RULESET } from '../../../src/shared/ruleset.ts'
import { parseUsername, usernameHint } from '../../../src/shared/playerIdentity.ts'
import {
  deserializeLapRecord, serializeLapRecord, type LapRecord, type SerializedLapRecord,
} from '../../../src/storage/records.ts'

const TRACKS = new Map(
  [balanced8, power3, power4, power8]
    .map((data) => new Track(data as TrackData))
    .map((track) => [track.id, track]),
)
const PRESETS: readonly PresetName[] = ['legacy', 'classic']
const MAX_BOARD_SIZE = 100
const MAX_BODY_BYTES = 4 * 1024 * 1024

const admin = createClient(
  requiredEnv('SUPABASE_URL'),
  requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false, autoRefreshToken: false } },
)

interface PlayerRow {
  id: string
  username: string
}

interface EntryRow {
  entry_id: string
  entry_rank: number | string
  player_id: string
  username: string
  lap_time: number
  recorded_at: string
  tc: boolean
  abs: boolean
  preset: string
  ghost_available: boolean
}

interface LeaderboardEntry {
  id: string
  rank: number
  playerName: string
  time: number
  recordedAt: string
  verified: boolean
  ghostAvailable: boolean
  assists: { tc: boolean; abs: boolean }
  preset: string
}

interface LeaderboardPage {
  key: { trackId: string; easy: boolean; ruleset: string }
  entries: LeaderboardEntry[]
  scope: 'global'
}

export default {
  async fetch(request: Request): Promise<Response> {
    const cors = corsHeaders(request)
    if (!cors) return json({ error: 'Origin is not allowed.' }, 403)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })

    try {
      return await route(request, cors)
    } catch (reason) {
      console.error('[leaderboard]', reason)
      return json({ error: 'Leaderboard service failed.' }, 500, cors)
    }
  },
}

async function route(request: Request, cors: Headers): Promise<Response> {
  const url = new URL(request.url)
  const path = apiPath(url.pathname)

  if (request.method === 'GET' && path === '/health') {
    return json({ ok: true, ruleset: CURRENT_PHYSICS_RULESET }, 200, cors)
  }

  if (request.method === 'POST' && path === '/v1/profiles') {
    const user = await authenticatedUser(request)
    if (!user) return json({ error: 'A device session is required.' }, 401, cors)
    const body = await bodyJson(request)
    if (!body.ok) return json({ error: body.error }, body.status, cors)
    const parsed = parseUsername(body.value.username)
    if (!parsed) return json({ error: `Username must be ${usernameHint}` }, 400, cors)

    const existing = await player(user.id)
    if (existing) return json({ profile: profile(existing, user) }, 200, cors)

    const created = await admin.from('players').insert({
      id: user.id,
      username: parsed.username,
    }).select('id, username').single()
    if (created.error?.code === '23505') {
      return json({ error: 'That username is already taken.' }, 409, cors)
    }
    if (created.error || !created.data) throw created.error ?? new Error('Profile insert returned no row.')
    return json({ profile: profile(created.data as PlayerRow, user) }, 201, cors)
  }

  if (request.method === 'GET' && path === '/v1/me') {
    const user = await authenticatedUser(request)
    if (!user) return json({ error: 'A device session is required.' }, 401, cors)
    const current = await player(user.id)
    if (!current) return json({ error: 'No username has been claimed.' }, 404, cors)
    return json({ profile: profile(current, user) }, 200, cors)
  }

  if (request.method === 'GET' && path === '/v1/leaderboards') {
    const key = boardKey(url.searchParams)
    if (!key) return json({ error: 'Leaderboard query is invalid.' }, 400, cors)
    const limit = clampLimit(url.searchParams.get('limit'))
    const result = await admin.rpc('leaderboard_page', {
      p_track_id: key.trackId,
      p_easy: key.easy,
      p_ruleset: key.ruleset,
      p_limit: limit,
    })
    if (result.error) throw result.error
    const rows = (result.data ?? []) as EntryRow[]
    const page: LeaderboardPage = {
      key,
      entries: rows.map(entry),
      scope: 'global',
    }
    return json(page, 200, cors)
  }

  const ghostMatch = /^\/v1\/leaderboards\/entries\/([^/]+)\/ghost$/.exec(path)
  if (request.method === 'GET' && ghostMatch?.[1]) {
    const result = await admin.from('lap_replays')
      .select('payload')
      .eq('lap_id', decodeURIComponent(ghostMatch[1]))
      .maybeSingle()
    if (result.error) throw result.error
    if (!result.data) return json({ error: 'That ghost is no longer available.' }, 404, cors)
    return json({ lap: result.data.payload }, 200, cors)
  }

  if (request.method === 'POST' && path === '/v1/laps') {
    return submitLap(request, cors)
  }

  return json({ error: 'Not found.' }, 404, cors)
}

async function submitLap(request: Request, cors: Headers): Promise<Response> {
  const user = await authenticatedUser(request)
  if (!user) return json({ error: 'Claim a username before submitting laps.' }, 401, cors)
  const current = await player(user.id)
  if (!current) return json({ error: 'Claim a username before submitting laps.' }, 401, cors)

  const rate = await admin.rpc('claim_submission_slot', { p_user_id: user.id })
  if (rate.error) throw rate.error
  if (rate.data !== true) return json({ error: 'Too many lap submissions. Try again shortly.' }, 429, cors)

  const body = await bodyJson(request)
  if (!body.ok) return json({ error: body.error }, body.status, cors)
  if (body.value.ruleset !== CURRENT_PHYSICS_RULESET) {
    return json({ error: 'This physics ruleset is not accepting laps.' }, 409, cors)
  }

  const submitted = parseLap(body.value.lap)
  if (!submitted) return json({ error: 'Lap payload is malformed.' }, 400, cors)
  const track = TRACKS.get(submitted.trackId)
  if (!track) return json({ error: 'Track is not on the current calendar.' }, 400, cors)
  if (!PRESETS.includes(submitted.preset as PresetName)) {
    return json({ error: 'Car setup is not released.' }, 400, cors)
  }
  if (
    submitted.trackId !== submitted.recording.trackId ||
    submitted.preset !== submitted.recording.preset ||
    submitted.easy !== submitted.recording.easy
  ) return json({ error: 'Lap metadata does not match its replay.' }, 400, cors)

  const baseParams = handlingPreset(submitted.preset as PresetName)
  const params = submitted.easy ? applyEasyAids(baseParams) : baseParams
  const verified = verifyLapRecording(track, params, submitted.recording)
  if (
    !verified.accepted || verified.time === undefined || !verified.sectors ||
    !verified.trace || !verified.path
  ) {
    return json({ error: verified.reason ?? 'Lap replay could not be verified.' }, 422, cors)
  }

  const recordedAt = new Date().toISOString()
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
  const lapId = crypto.randomUUID()
  const stored = await admin.rpc('submit_verified_lap', {
    p_id: lapId,
    p_player_id: user.id,
    p_track_id: track.id,
    p_easy: official.easy,
    p_ruleset: CURRENT_PHYSICS_RULESET,
    p_preset: official.preset,
    p_tc: lapUsedTc(official.recording),
    p_abs: official.recording.abs ?? false,
    p_time: official.time,
    p_sectors: official.sectors,
    p_recorded_at: recordedAt,
    p_replay: serializeLapRecord(official),
  })
  if (stored.error) throw stored.error

  const board = await admin.rpc('leaderboard_page', {
    p_track_id: track.id,
    p_easy: official.easy,
    p_ruleset: CURRENT_PHYSICS_RULESET,
    p_limit: 10000,
  })
  if (board.error) throw board.error
  const row = ((board.data ?? []) as EntryRow[]).find((candidate) => candidate.player_id === user.id)
  if (!row) throw new Error('Submitted lap disappeared from its board.')
  return json({ entry: entry(row) }, 201, cors)
}

async function authenticatedUser(request: Request): Promise<User | null> {
  const match = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')
  if (!match?.[1]) return null
  const result = await admin.auth.getUser(match[1])
  return result.error ? null : result.data.user
}

async function player(id: string): Promise<PlayerRow | null> {
  const result = await admin.from('players').select('id, username').eq('id', id).maybeSingle()
  if (result.error) throw result.error
  return result.data as PlayerRow | null
}

function profile(row: PlayerRow, user: User): { id: string; username: string; locked: boolean } {
  return { id: row.id, username: row.username, locked: user.is_anonymous === false }
}

function entry(row: EntryRow): LeaderboardEntry {
  return {
    id: row.entry_id,
    rank: Number(row.entry_rank),
    playerName: row.username,
    time: row.lap_time,
    recordedAt: row.recorded_at,
    verified: true,
    ghostAvailable: row.ghost_available,
    assists: { tc: row.tc, abs: row.abs },
    preset: row.preset,
  }
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

function boardKey(query: URLSearchParams): { trackId: string; easy: boolean; ruleset: string } | null {
  const trackId = query.get('trackId')
  const easy = query.get('easy')
  const ruleset = query.get('ruleset')
  if (!trackId || !TRACKS.has(trackId)) return null
  if (easy !== 'true' && easy !== 'false') return null
  if (ruleset !== CURRENT_PHYSICS_RULESET) return null
  return { trackId, easy: easy === 'true', ruleset }
}

function clampLimit(value: string | null): number {
  const parsed = Number(value ?? 50)
  if (!Number.isFinite(parsed)) return 50
  return Math.min(MAX_BOARD_SIZE, Math.max(1, Math.floor(parsed)))
}

async function bodyJson(request: Request): Promise<
  { ok: true; value: Record<string, unknown> } |
  { ok: false; status: number; error: string }
> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'Request is too large.' }
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'Request is too large.' }
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return { ok: true, value: value as Record<string, unknown> }
  } catch {
    return { ok: false, status: 400, error: 'Request body is not valid JSON.' }
  }
}

function apiPath(pathname: string): string {
  if (pathname.endsWith('/health')) return '/health'
  const marker = pathname.lastIndexOf('/v1/')
  return marker >= 0 ? pathname.slice(marker) : pathname
}

function corsHeaders(request: Request): Headers | null {
  const origin = request.headers.get('origin')
  if (origin && !allowedOrigin(origin)) return null
  const headers = new Headers({
    'access-control-allow-headers': 'apikey, authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
    vary: 'Origin',
  })
  if (origin) headers.set('access-control-allow-origin', origin)
  return headers
}

function allowedOrigin(origin: string): boolean {
  const configured = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://armutie.github.io')
    .split(',').map((value) => value.trim()).filter(Boolean)
  if (configured.includes(origin)) return true
  try {
    const url = new URL(origin)
    return (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      (url.protocol === 'http:' || url.protocol === 'https:')
  } catch {
    return false
  }
}

function json(body: unknown, status = 200, headers = new Headers()): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}
