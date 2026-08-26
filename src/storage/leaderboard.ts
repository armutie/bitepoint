/**
 * Verified leaderboard access, with a useful local fallback.
 *
 * The browser never gets to assert a lap time to the global board. It submits
 * the exact starting state and input stream already used by `LapReplay`; the
 * service replays those inputs with the named ruleset and derives the result.
 */
import { createClient } from '@supabase/supabase-js'

import { lapUsedTc } from '../core/sim'
import { LEGACY_TYRE_MODE } from '../features'
import type { LapRecord, RecordKey, RecordStore, SerializedLapRecord } from './records'
import { deserializeLapRecord, keyOf, serializeLapRecord } from './records'
import { CURRENT_PHYSICS_RULESET, LEGACY_PHYSICS_RULESET } from '../shared/ruleset'
import {
  DevicePlayerProfileClient, type PlayerProfileClient, SupabasePlayerProfileClient,
} from './player'

/**
 * Bump this whenever a physics, collision, track-boundary, or timing change can
 * alter a lap. Old boards remain readable, but never compete with the new sim.
 */
export const PHYSICS_RULESET = LEGACY_TYRE_MODE
  ? LEGACY_PHYSICS_RULESET
  : CURRENT_PHYSICS_RULESET

export interface LeaderboardKey extends RecordKey {
  ruleset: string
}

/**
 * What the driver had switched on. One board, marked — not separate boards.
 *
 * Separate boards were tried and are wrong here: a board key has to be knowable
 * before the lap so the menu can show what there is to beat, and the TC rotary
 * turns mid-lap. Marking is also simply better information — you can see the
 * outright fastest lap AND the fastest unassisted one on the same list, which
 * two boards can never show you at once.
 *
 * `easy` is not in here. That is a different world rather than a driver aid —
 * full grip on the grass — and it keys the board itself.
 */
export interface Assists {
  /** Traction control was above zero at some point. See `lapUsedTc`. */
  tc: boolean
  /** ABS was on for the lap. It cannot be changed mid-lap. */
  abs: boolean
}

/** No assists at all — the clean lap. */
export const isClean = (a: Assists): boolean => !a.tc && !a.abs

export interface LeaderboardEntry {
  id: string
  rank: number
  playerName: string
  time: number
  recordedAt: string
  verified: boolean
  ghostAvailable: boolean
  /**
   * Optional so a server that has not been taught about assists yet still
   * renders: an entry with nothing said about it is shown unmarked rather than
   * claimed to be clean.
   */
  assists?: Assists
  /**
   * Which aero trim set the lap — `legacy`, `classic`.
   *
   * On the entry rather than in the board key: one car, one board, and the
   * setup is a property of the lap. Optional for the same reason `assists` is.
   */
  preset?: string
}

export interface LeaderboardPage {
  key: LeaderboardKey
  entries: LeaderboardEntry[]
  /** Global when backed by the verification API; personal is this browser. */
  scope: 'global' | 'personal'
}

export interface LeaderboardClient {
  list(key: RecordKey, limit?: number): Promise<LeaderboardPage>
  ghost(entryId: string): Promise<LapRecord>
  /** The server derives the accepted time by replaying `record.recording`. */
  submit(record: LapRecord, playerName: string): Promise<LeaderboardEntry | null>
}

/**
 * Lets the complete UI ship and be exercised before an API is configured.
 * The player's current and superseded bests become a one-person lap history.
 */
export class PersonalLeaderboardClient implements LeaderboardClient {
  private readonly ghosts = new Map<string, LapRecord>()

  constructor(private readonly records: RecordStore) {}

  async list(key: RecordKey, limit = 50): Promise<LeaderboardPage> {
    const best = await this.records.best(key)
    const laps = [...(best ? [best] : []), ...await this.records.past(key)]
      .sort((a, b) => a.time - b.time)
      .slice(0, limit)
    this.ghosts.clear()
    const entries = laps.map((lap, index) => {
      const id = personalEntryId(lap)
      if (lap.recording.inputs.length > 0) this.ghosts.set(id, lap)
      return {
        id,
        rank: index + 1,
        playerName: 'You',
        time: lap.time,
        recordedAt: lap.recordedAt,
        verified: true,
        ghostAvailable: lap.recording.inputs.length > 0,
        // Derived from the lap itself, never from a stored claim: `lapUsedTc`
        // reads the rotary channel that `verifyLapRecording` would replay, so
        // the badge cannot disagree with the lap that was actually driven.
        assists: {
          tc: lapUsedTc(lap.recording),
          abs: lap.recording.abs ?? false,
        },
        preset: lap.recording.preset,
      }
    })
    return { key: withRuleset(key), entries, scope: 'personal' }
  }

  async ghost(entryId: string): Promise<LapRecord> {
    let lap = this.ghosts.get(entryId)
    if (!lap) {
      const parsed = parsePersonalEntryId(entryId)
      if (parsed) {
        const best = await this.records.best(parsed.key)
        const candidates = [...(best ? [best] : []), ...await this.records.past(parsed.key)]
        lap = candidates.find((candidate) => candidate.recordedAt === parsed.recordedAt)
      }
    }
    if (!lap) throw new Error('That lap is no longer available on this browser.')
    return lap
  }

  async submit(_record: LapRecord, _playerName: string): Promise<null> {
    // LocalRecordStore is already authoritative locally; there is no second
    // write to make. A subsequent `list` reads the newly saved record.
    return null
  }
}

/** HTTP implementation of the contract documented in LEADERBOARD.md. */
export class HttpLeaderboardClient implements LeaderboardClient {
  constructor(
    private readonly baseUrl: string,
    private readonly profiles: PlayerProfileClient,
  ) {}

  async list(key: RecordKey, limit = 50): Promise<LeaderboardPage> {
    const query = new URLSearchParams({
      trackId: key.trackId,
      easy: String(key.easy),
      ruleset: PHYSICS_RULESET,
      limit: String(limit),
    })
    return this.request<LeaderboardPage>(`/v1/leaderboards?${query}`)
  }

  async ghost(entryId: string): Promise<LapRecord> {
    const body = await this.request<{ lap: SerializedLapRecord }>(
      `/v1/leaderboards/entries/${encodeURIComponent(entryId)}/ghost`,
    )
    return deserializeLapRecord(body.lap)
  }

  async submit(record: LapRecord, _playerName: string): Promise<LeaderboardEntry | null> {
    if (!this.profiles.current?.locked) return null
    const body = await this.request<{ entry: LeaderboardEntry }>('/v1/laps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ruleset: PHYSICS_RULESET,
        lap: serializeLapRecord(record),
      }),
    }, true)
    return body.entry
  }

  private async request<T>(path: string, init?: RequestInit, authenticated = false): Promise<T> {
    const headers = new Headers(init?.headers)
    for (const [name, value] of Object.entries(await this.profiles.headers(authenticated))) {
      headers.set(name, value)
    }
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, { ...init, headers })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(detail || `Leaderboard request failed (${response.status})`)
    }
    return response.json() as Promise<T>
  }
}

export function createLeaderboardClient(records: RecordStore): LeaderboardClient {
  return createLeaderboardServices(records).leaderboard
}

export interface LeaderboardServices {
  leaderboard: LeaderboardClient
  profiles: PlayerProfileClient | null
}

export function createLeaderboardServices(records: RecordStore): LeaderboardServices {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
  if (supabaseUrl && publishableKey) {
    const supabase = createClient(supabaseUrl, publishableKey)
    const functionUrl = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/leaderboard`
    const profiles = new SupabasePlayerProfileClient(
      supabase, publishableKey, functionUrl,
    )
    return {
      leaderboard: new HttpLeaderboardClient(functionUrl, profiles),
      profiles,
    }
  }

  const configured = import.meta.env.VITE_LEADERBOARD_API?.trim()
  const url = configured || (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '')
  if (!url) return { leaderboard: new PersonalLeaderboardClient(records), profiles: null }
  const profiles = new DevicePlayerProfileClient(url)
  return { leaderboard: new HttpLeaderboardClient(url, profiles), profiles }
}

export const withRuleset = (key: RecordKey): LeaderboardKey => ({ ...key, ruleset: PHYSICS_RULESET })

export function sameBoard(a: RecordKey, b: RecordKey): boolean {
  return keyOf(a) === keyOf(b)
}

export function cleanPlayerName(name: string): string {
  const cleaned = name.trim().replace(/\s+/g, ' ')
  return cleaned.slice(0, 24) || 'Driver'
}

function personalEntryId(lap: LapRecord): string {
  return `personal:${encodeURIComponent(keyOf(lap))}:${encodeURIComponent(lap.recordedAt)}`
}

function parsePersonalEntryId(id: string): { key: RecordKey; recordedAt: string } | null {
  const match = /^personal:([^:]+):(.+)$/.exec(id)
  if (!match?.[1] || !match[2]) return null
  const [trackId, mode] = decodeURIComponent(match[1]).split('|')
  if (!trackId || (mode !== 'std' && mode !== 'easy')) return null
  return {
    key: { trackId, easy: mode === 'easy' },
    recordedAt: decodeURIComponent(match[2]),
  }
}
