import type { LeaderboardEntry, LeaderboardPage } from '../src/storage/leaderboard'
import type { SerializedLapRecord } from '../src/storage/records'
import type {
  BoardKey, CreatePlayer, LeaderboardRepository, Player, VerifiedLap,
} from './repository'

interface MemoryLap extends Omit<VerifiedLap, 'replay'> {
  replay: SerializedLapRecord | null
}

/** Deterministic repository for API tests and a zero-setup local server. */
export class MemoryLeaderboardRepository implements LeaderboardRepository {
  private readonly players = new Map<string, Player>()
  private readonly playerIdsByUsername = new Map<string, string>()
  private readonly playerIdsByToken = new Map<string, string>()
  private readonly laps: MemoryLap[] = []

  async createPlayer(input: CreatePlayer): Promise<Player | null> {
    if (this.playerIdsByUsername.has(input.usernameKey)) return null
    const player: Player = {
      id: input.id,
      username: input.username,
      usernameKey: input.usernameKey,
      createdAt: input.createdAt,
    }
    this.players.set(player.id, player)
    this.playerIdsByUsername.set(player.usernameKey, player.id)
    this.playerIdsByToken.set(input.tokenHash, player.id)
    return player
  }

  async playerForToken(tokenHash: string): Promise<Player | null> {
    const id = this.playerIdsByToken.get(tokenHash)
    return id ? this.players.get(id) ?? null : null
  }

  async submitLap(input: VerifiedLap): Promise<LeaderboardEntry> {
    const oldBest = this.bestForPlayer(input.playerId, input)
    const isPersonalBest = !oldBest || input.time < oldBest.time
    if (isPersonalBest && oldBest) oldBest.replay = null
    this.laps.push({ ...input, replay: isPersonalBest ? input.replay : null })

    const board = this.ranked(input)
    const playerBest = board.find((lap) => lap.playerId === input.playerId)
    if (!playerBest) throw new Error('Submitted lap disappeared from its board.')
    return this.entry(playerBest, board.indexOf(playerBest) + 1)
  }

  async listBoard(key: BoardKey, limit: number): Promise<LeaderboardPage> {
    const board = this.ranked(key)
    return {
      key,
      entries: board.slice(0, limit).map((lap, index) => this.entry(lap, index + 1)),
      scope: 'global',
    }
  }

  async ghost(entryId: string): Promise<SerializedLapRecord | null> {
    return this.laps.find((lap) => lap.id === entryId)?.replay ?? null
  }

  async close(): Promise<void> {}

  private bestForPlayer(playerId: string, key: BoardKey): MemoryLap | null {
    return this.laps
      .filter((lap) => lap.playerId === playerId && sameBoard(lap, key))
      .reduce<MemoryLap | null>((best, lap) => !best || lap.time < best.time ? lap : best, null)
  }

  private ranked(key: BoardKey): MemoryLap[] {
    const byPlayer = new Map<string, MemoryLap>()
    for (const lap of this.laps) {
      if (!sameBoard(lap, key)) continue
      const current = byPlayer.get(lap.playerId)
      if (!current || lap.time < current.time) byPlayer.set(lap.playerId, lap)
    }
    return [...byPlayer.values()].sort((a, b) => a.time - b.time || a.recordedAt.localeCompare(b.recordedAt))
  }

  private entry(lap: MemoryLap, rank: number): LeaderboardEntry {
    const player = this.players.get(lap.playerId)
    if (!player) throw new Error(`Missing player ${lap.playerId}.`)
    return {
      id: lap.id,
      rank,
      playerName: player.username,
      time: lap.time,
      recordedAt: lap.recordedAt,
      verified: true,
      ghostAvailable: lap.replay !== null,
      assists: { tc: lap.tc, abs: lap.abs },
      preset: lap.preset,
    }
  }
}

const sameBoard = (a: BoardKey, b: BoardKey): boolean =>
  a.trackId === b.trackId && a.easy === b.easy && a.ruleset === b.ruleset
