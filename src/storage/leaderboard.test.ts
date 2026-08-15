import { describe, expect, it } from 'vitest'

import { initialState } from '../core/car'
import {
  PHYSICS_RULESET, PersonalLeaderboardClient, cleanPlayerName, isClean, withRuleset,
} from './leaderboard'
import type { LapRecord, RecordKey, RecordStore } from './records'
import { keyOf } from './records'

const KEY: RecordKey = { trackId: 'balanced_8', easy: false }
/** The board no longer keys on setup, but a recording still names the one it used. */
const PRESET = 'legacy'

function lap(time: number, recordedAt: string): LapRecord {
  return {
    ...KEY,
    preset: PRESET,
    time,
    sectors: [time],
    recordedAt,
    recording: {
      ...KEY,
      preset: PRESET,
      start: initialState(),
      inputs: new Float64Array([0, 1, 0, 1]),
    },
  }
}

class MemoryRecords implements RecordStore {
  constructor(readonly current: LapRecord, readonly history: LapRecord[]) {}
  async best(key: RecordKey): Promise<LapRecord | null> {
    return keyOf(key) === keyOf(this.current) ? this.current : null
  }
  async submit(): Promise<boolean> { return false }
  async past(key: RecordKey): Promise<LapRecord[]> {
    return keyOf(key) === keyOf(this.current) ? this.history : []
  }
  async all(): Promise<LapRecord[]> { return [this.current] }
  async clear(): Promise<void> {}
}

describe('personal leaderboard fallback', () => {
  it('ranks the current and superseded laps and makes every replay selectable', async () => {
    const records = new MemoryRecords(
      lap(61.2, '2026-08-12T10:00:00.000Z'),
      [lap(64.5, '2026-08-12T09:00:00.000Z'), lap(62.8, '2026-08-12T09:30:00.000Z')],
    )
    const board = new PersonalLeaderboardClient(records)
    const page = await board.list(KEY)

    expect(page.scope).toBe('personal')
    expect(page.key.ruleset).toBe(PHYSICS_RULESET)
    expect(page.entries.map((entry) => entry.time)).toEqual([61.2, 62.8, 64.5])
    expect((await board.ghost(page.entries[1]!.id)).time).toBe(62.8)
  })

  it('can restore a selected personal ghost in a fresh client', async () => {
    const records = new MemoryRecords(
      lap(61.2, '2026-08-12T10:00:00.000Z'),
      [lap(64.5, '2026-08-12T09:00:00.000Z')],
    )
    const first = new PersonalLeaderboardClient(records)
    const entryId = (await first.list(KEY)).entries[1]!.id

    expect((await new PersonalLeaderboardClient(records).ghost(entryId)).time).toBe(64.5)
  })
})

describe('leaderboard identity', () => {
  it('pins every board to the current physics ruleset', () => {
    expect(withRuleset(KEY)).toEqual({ ...KEY, ruleset: PHYSICS_RULESET })
  })

  it('normalises public driver names', () => {
    expect(cleanPlayerName('   Ada    Lovelace   ')).toBe('Ada Lovelace')
    expect(cleanPlayerName(' '.repeat(10))).toBe('Driver')
    expect(cleanPlayerName('x'.repeat(30))).toHaveLength(24)
  })
})

describe('assist marks', () => {
  /** A lap whose TC channel really carries `position` on every tick. */
  function assisted(time: number, at: string, position: number, abs: boolean): LapRecord {
    const ticks = 4
    const inputs = new Float64Array(ticks * 3)
    for (let i = 0; i < ticks; i++) {
      inputs[i * 3] = 0
      inputs[i * 3 + 1] = 1
      inputs[i * 3 + 2] = position
    }
    return {
      ...KEY, preset: PRESET, time, sectors: [time], recordedAt: at,
      recording: {
        ...KEY, preset: PRESET, start: initialState(), inputs, tc: true,
        ...(abs ? { abs: true } : {}),
      },
    }
  }

  it('reads the assists off the lap rather than off a stored claim', async () => {
    const board = new PersonalLeaderboardClient(new MemoryRecords(
      assisted(60, '2026-08-12T10:00:00.000Z', 4, true),
      [assisted(62, '2026-08-12T09:00:00.000Z', 0, false)],
    ))
    const page = await board.list(KEY)
    expect(page.entries[0]!.assists).toEqual({ tc: true, abs: true })
    // Rotary present but never left zero: the channel exists, the assist does not.
    expect(page.entries[1]!.assists).toEqual({ tc: false, abs: false })
  })

  it('marks a lap that only touched TC part-way through', async () => {
    const lap = assisted(60, '2026-08-12T10:00:00.000Z', 0, false)
    lap.recording.inputs[2 * 3 + 2] = 3
    const board = new PersonalLeaderboardClient(new MemoryRecords(lap, []))
    const page = await board.list(KEY)
    expect(page.entries[0]!.assists).toEqual({ tc: true, abs: false })
  })

  it('treats a lap with no rotary channel at all as unassisted', async () => {
    const board = new PersonalLeaderboardClient(new MemoryRecords(
      lap(60, '2026-08-12T10:00:00.000Z'), [],
    ))
    expect((await board.list(KEY)).entries[0]!.assists).toEqual({ tc: false, abs: false })
  })
})

describe('isClean', () => {
  it('is only true when nothing was switched on', () => {
    expect(isClean({ tc: false, abs: false })).toBe(true)
    expect(isClean({ tc: true, abs: false })).toBe(false)
    expect(isClean({ tc: false, abs: true })).toBe(false)
  })
})
