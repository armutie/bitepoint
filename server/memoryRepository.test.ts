import { describe, expect, it } from 'vitest'

import type { SerializedLapRecord } from '../src/storage/records'
import { MemoryLeaderboardRepository } from './memoryRepository'
import type { VerifiedLap } from './repository'

const BOARD = { trackId: 'balanced_8', ruleset: 'test' }

function lap(id: string, playerId: string, time: number, easy: boolean): VerifiedLap {
  return {
    id, playerId, time, easy,
    trackId: BOARD.trackId,
    ruleset: BOARD.ruleset,
    preset: 'legacy',
    tc: false,
    abs: false,
    sectors: [time / 3, time / 3, time / 3],
    recordedAt: `2026-11-12T10:00:0${id.length % 10}.000Z`,
    replay: { id } as unknown as SerializedLapRecord,
  }
}

async function repoWithDrivers(): Promise<MemoryLeaderboardRepository> {
  const repo = new MemoryLeaderboardRepository()
  for (const [id, username] of [['a', 'Alpha'], ['b', 'Bravo']]) {
    await repo.createPlayer({
      id: id!, username: username!, usernameKey: username!.toLowerCase(),
      tokenHash: id!, createdAt: '2026-11-12T09:00:00.000Z',
    })
  }
  return repo
}

describe('one board per circuit', () => {
  it('ranks easy and standard laps together and marks the easy ones', async () => {
    const repo = await repoWithDrivers()
    await repo.submitLap(lap('a-std', 'a', 70, false))
    await repo.submitLap(lap('b-std', 'b', 69, false))
    const entry = await repo.submitLap(lap('a-easy', 'a', 68, true))

    expect(entry).toMatchObject({ id: 'a-easy', rank: 1, easy: true })
    const page = await repo.listBoard(BOARD, 50)
    expect(page.entries.map((e) => [e.playerName, e.time, e.easy])).toEqual([
      ['Alpha', 68, true],
      ['Bravo', 69, false],
    ])
  })

  it('keeps a driver’s standard ghost when their easy lap becomes the faster one', async () => {
    const repo = await repoWithDrivers()
    await repo.submitLap(lap('a-std', 'a', 70, false))
    await repo.submitLap(lap('a-easy', 'a', 68, true))

    expect(await repo.ghost('a-std')).not.toBeNull()
    expect(await repo.ghost('a-easy')).not.toBeNull()
  })

  it('still replaces the ghost when a driver beats their own lap in the same mode', async () => {
    const repo = await repoWithDrivers()
    await repo.submitLap(lap('a-std', 'a', 70, false))
    await repo.submitLap(lap('a-std2', 'a', 69, false))

    expect(await repo.ghost('a-std')).toBeNull()
    expect(await repo.ghost('a-std2')).not.toBeNull()
  })
})
