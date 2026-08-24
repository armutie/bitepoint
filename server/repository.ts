import type { LeaderboardEntry, LeaderboardPage } from '../src/storage/leaderboard'
import type { SerializedLapRecord } from '../src/storage/records'

export interface Player {
  id: string
  username: string
  usernameKey: string
  createdAt: string
}

export interface CreatePlayer {
  id: string
  username: string
  usernameKey: string
  tokenHash: string
  createdAt: string
}

export interface VerifiedLap {
  id: string
  playerId: string
  trackId: string
  easy: boolean
  ruleset: string
  preset: string
  tc: boolean
  abs: boolean
  time: number
  sectors: (number | null)[]
  recordedAt: string
  replay: SerializedLapRecord
}

export interface BoardKey {
  trackId: string
  easy: boolean
  ruleset: string
}

export interface LeaderboardRepository {
  createPlayer(input: CreatePlayer): Promise<Player | null>
  playerForToken(tokenHash: string): Promise<Player | null>
  submitLap(lap: VerifiedLap): Promise<LeaderboardEntry>
  listBoard(key: BoardKey, limit: number): Promise<LeaderboardPage>
  ghost(entryId: string): Promise<SerializedLapRecord | null>
  close(): Promise<void>
}
