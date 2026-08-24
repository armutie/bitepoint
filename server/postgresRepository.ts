import postgres from 'postgres'

import type { LeaderboardEntry, LeaderboardPage } from '../src/storage/leaderboard'
import type { SerializedLapRecord } from '../src/storage/records'
import type {
  BoardKey, CreatePlayer, LeaderboardRepository, Player, VerifiedLap,
} from './repository'

type Sql = postgres.Sql
type QuerySql = postgres.Sql | postgres.TransactionSql

interface PlayerRow {
  id: string
  username: string
  username_key: string
  created_at: Date
}

interface EntryRow {
  id: string
  rank: string | number
  username: string
  time: number
  recorded_at: Date
  tc: boolean
  abs: boolean
  preset: string
  ghost_available: boolean
  player_id: string
}

/** PostgreSQL implementation used by the deployed verifier service. */
export class PostgresLeaderboardRepository implements LeaderboardRepository {
  private readonly sql: Sql

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 8, idle_timeout: 20 })
  }

  async createPlayer(input: CreatePlayer): Promise<Player | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<PlayerRow[]>`
        INSERT INTO players (id, username, username_key, created_at)
        VALUES (${input.id}, ${input.username}, ${input.usernameKey}, ${input.createdAt})
        ON CONFLICT (username_key) DO NOTHING
        RETURNING id, username, username_key, created_at
      `
      const row = rows[0]
      if (!row) return null
      await tx`
        INSERT INTO player_tokens (player_id, token_hash, created_at, last_seen_at)
        VALUES (${input.id}, ${input.tokenHash}, ${input.createdAt}, ${input.createdAt})
      `
      return playerFromRow(row)
    })
  }

  async playerForToken(tokenHash: string): Promise<Player | null> {
    const rows = await this.sql<PlayerRow[]>`
      SELECT p.id, p.username, p.username_key, p.created_at
      FROM player_tokens t
      JOIN players p ON p.id = t.player_id
      WHERE t.token_hash = ${tokenHash}
      LIMIT 1
    `
    return rows[0] ? playerFromRow(rows[0]) : null
  }

  async submitLap(lap: VerifiedLap): Promise<LeaderboardEntry> {
    return this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO laps (
          id, player_id, track_id, easy, ruleset, preset, tc, abs,
          time, sectors, recorded_at, received_at
        ) VALUES (
          ${lap.id}, ${lap.playerId}, ${lap.trackId}, ${lap.easy}, ${lap.ruleset},
          ${lap.preset}, ${lap.tc}, ${lap.abs}, ${lap.time}, ${tx.json(lap.sectors)},
          ${lap.recordedAt}, ${lap.recordedAt}
        )
      `

      const best = await tx<{ id: string }[]>`
        SELECT id
        FROM laps
        WHERE player_id = ${lap.playerId}
          AND track_id = ${lap.trackId}
          AND easy = ${lap.easy}
          AND ruleset = ${lap.ruleset}
        ORDER BY time ASC, recorded_at ASC, id ASC
        LIMIT 1
      `
      if (best[0]?.id === lap.id) {
        await tx`
          DELETE FROM lap_replays
          WHERE lap_id IN (
            SELECT id FROM laps
            WHERE player_id = ${lap.playerId}
              AND track_id = ${lap.trackId}
              AND easy = ${lap.easy}
              AND ruleset = ${lap.ruleset}
              AND id <> ${lap.id}
          )
        `
        await tx`
          INSERT INTO lap_replays (lap_id, payload)
          VALUES (${lap.id}, ${tx.json(lap.replay as unknown as postgres.JSONValue)})
          ON CONFLICT (lap_id) DO UPDATE SET payload = EXCLUDED.payload
        `
      }

      const rows = await rankedBoard(tx, lap, 10000)
      const row = rows.find((candidate) => candidate.player_id === lap.playerId)
      if (!row) throw new Error('Submitted lap disappeared from its board.')
      return entryFromRow(row)
    })
  }

  async listBoard(key: BoardKey, limit: number): Promise<LeaderboardPage> {
    const rows = await rankedBoard(this.sql, key, limit)
    return { key, entries: rows.map(entryFromRow), scope: 'global' }
  }

  async ghost(entryId: string): Promise<SerializedLapRecord | null> {
    const rows = await this.sql<{ payload: SerializedLapRecord }[]>`
      SELECT r.payload
      FROM lap_replays r
      JOIN laps l ON l.id = r.lap_id
      WHERE l.id = ${entryId}
      LIMIT 1
    `
    return rows[0]?.payload ?? null
  }

  async close(): Promise<void> {
    await this.sql.end()
  }
}

async function rankedBoard(sql: QuerySql, key: BoardKey, limit: number): Promise<EntryRow[]> {
  return sql<EntryRow[]>`
    WITH personal_bests AS (
      SELECT DISTINCT ON (l.player_id)
        l.id, l.player_id, p.username, l.time, l.recorded_at,
        l.tc, l.abs, l.preset, (r.lap_id IS NOT NULL) AS ghost_available
      FROM laps l
      JOIN players p ON p.id = l.player_id
      LEFT JOIN lap_replays r ON r.lap_id = l.id
      WHERE l.track_id = ${key.trackId}
        AND l.easy = ${key.easy}
        AND l.ruleset = ${key.ruleset}
      ORDER BY l.player_id, l.time ASC, l.recorded_at ASC, l.id ASC
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY time ASC, recorded_at ASC, id ASC) AS rank
      FROM personal_bests
    )
    SELECT * FROM ranked ORDER BY rank LIMIT ${limit}
  `
}

function playerFromRow(row: PlayerRow): Player {
  return {
    id: row.id,
    username: row.username,
    usernameKey: row.username_key,
    createdAt: row.created_at.toISOString(),
  }
}

function entryFromRow(row: EntryRow): LeaderboardEntry {
  return {
    id: row.id,
    rank: Number(row.rank),
    playerName: row.username,
    time: row.time,
    recordedAt: row.recorded_at.toISOString(),
    verified: true,
    ghostAvailable: row.ghost_available,
    assists: { tc: row.tc, abs: row.abs },
    preset: row.preset,
  }
}
