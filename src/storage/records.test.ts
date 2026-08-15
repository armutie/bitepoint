/**
 * Storage slots: why a slower lap is sometimes worth keeping.
 *
 * One slot per board threw away every unassisted lap that was not also the
 * outright fastest, which made the leaderboard's "no assists" filter a view of
 * an empty set. These tests pin the fix.
 */
import { describe, expect, it } from 'vitest'

import { initialState } from '../core/car'
import {
  assistSlotOf, keyOf, LocalRecordStore, NamespacedStorage, type LapRecord,
} from './records'
import { ASSISTS_ADJUSTABLE } from '../features'

const KEY = { trackId: 'balanced_8', easy: false }
const PRESET = 'legacy'
const TYRE_FLAG = 'car-racing:tyre-10p5-1p35-neg1'

/** A lap with a real TC channel, so `lapUsedTc` has something to read. */
function lap(time: number, at: string, tcPosition: number, abs = false): LapRecord {
  const inputs = new Float64Array(6 * 3)
  for (let i = 0; i < 6; i++) {
    inputs[i * 3 + 1] = 1
    inputs[i * 3 + 2] = tcPosition
  }
  return {
    ...KEY, preset: PRESET, time, sectors: [time], recordedAt: at,
    recording: {
      ...KEY, preset: PRESET, start: initialState(), inputs, tc: true,
      ...(abs ? { abs: true } : {}),
    },
  }
}

class MemoryStorage implements Storage {
  private map = new Map<string, string>()
  get length(): number { return this.map.size }
  clear(): void { this.map.clear() }
  getItem(k: string): string | null { return this.map.get(k) ?? null }
  key(i: number): string | null { return [...this.map.keys()][i] ?? null }
  removeItem(k: string): void { this.map.delete(k) }
  setItem(k: string, v: string): void { this.map.set(k, v) }
}

describe('namespaced storage', () => {
  it('isolates legacy tyre laps while leaving normal records and settings alone', () => {
    const physical = new MemoryStorage()
    physical.setItem('car-racing:record:balanced_8|std', 'released')
    physical.setItem('bite-point:settings', 'shared')
    const legacy = new NamespacedStorage(physical, 'car-racing:legacy-tyres:')

    legacy.setItem('car-racing:record:balanced_8|std', 'legacy')
    expect(legacy.getItem('car-racing:record:balanced_8|std')).toBe('legacy')
    expect(physical.getItem('car-racing:record:balanced_8|std')).toBe('released')
    expect(physical.getItem('bite-point:settings')).toBe('shared')

    legacy.clear()
    expect(legacy.length).toBe(0)
    expect(physical.getItem('car-racing:record:balanced_8|std')).toBe('released')
  })
})

describe('assist slots', () => {
  it('names a slot from what the lap actually used', () => {
    // The mechanism, whatever the flag says. This is what comes back the day
    // the aids are offered again, so it stays covered while it is switched off.
    expect(assistSlotOf(lap(60, 'a', 0))).toBe('')
    expect(assistSlotOf(lap(60, 'a', 4))).toBe('|tc')
    expect(assistSlotOf(lap(60, 'a', 0, true))).toBe('|abs')
    expect(assistSlotOf(lap(60, 'a', 4, true))).toBe('|tc+abs')
  })

  it('puts every lap in one slot while the aids are fixed', () => {
    // v1: nobody can change TC or ABS, so every lap is the same test and the
    // leaderboard is one plain list. If this ever fails, the flag moved and the
    // expectations below about which laps are kept move with it.
    expect(ASSISTS_ADJUSTABLE).toBe(false)
  })

  it('keeps only the fastest lap, whatever the aids were set to', async () => {
    const store = new LocalRecordStore(new MemoryStorage())
    expect(await store.submit(lap(53.7, '2026-08-13T10:00:00Z', 5))).toBe(true)
    // Slower, and nobody could have driven it under different aids anyway.
    expect(await store.submit(lap(58.2, '2026-08-13T11:00:00Z', 0))).toBe(false)
    expect((await store.best(KEY))!.time).toBeCloseTo(53.7, 6)
  })

  it('archives the lap a new best beat', async () => {
    const store = new LocalRecordStore(new MemoryStorage())
    await store.submit(lap(58.2, '2026-08-13T10:00:00Z', 0))
    expect(await store.submit(lap(56.0, '2026-08-13T11:00:00Z', 0))).toBe(true)
    expect((await store.best(KEY))!.time).toBeCloseTo(56.0, 6)
    expect((await store.past(KEY)).map((l) => l.time)).toContain(58.2)
  })

  it('stores on the bare board key, so records from every era load', async () => {
    const store = new LocalRecordStore(new MemoryStorage())
    await store.submit(lap(58.2, '2026-08-13T10:00:00Z', 4))
    expect(keyOf(KEY)).toBe('balanced_8|std')
    expect((await store.best(KEY))!.time).toBeCloseTo(58.2, 6)
  })
})

describe('merging the old per-setup boards', () => {
  const stored = (time: number, preset: string) =>
    JSON.stringify({
      v: 1, trackId: 'balanced_8', preset, easy: false, time, sectors: [time],
      recordedAt: '2026-08-13T10:00:00Z', start: initialState(), inputs: '',
    })

  it('keeps the fastest lap across the setups that used to be separate', () => {
    const s = new MemoryStorage()
    s.setItem(TYRE_FLAG, '1')
    s.setItem('car-racing:record:balanced_8|legacy|std', stored(53.7, 'legacy'))
    s.setItem('car-racing:record:balanced_8|classic|std', stored(58.2, 'classic'))
    const store = new LocalRecordStore(s)

    expect(s.getItem('car-racing:record:balanced_8|legacy|std')).toBeNull()
    expect(s.getItem('car-racing:record:balanced_8|classic|std')).toBeNull()
    return store.best(KEY).then((best) => {
      expect(best!.time).toBeCloseTo(53.7, 6)
    })
  })

  it('does not care which order the old boards are read in', () => {
    const s = new MemoryStorage()
    s.setItem(TYRE_FLAG, '1')
    s.setItem('car-racing:record:balanced_8|classic|std', stored(51.0, 'classic'))
    s.setItem('car-racing:record:balanced_8|legacy|std', stored(56.0, 'legacy'))
    const store = new LocalRecordStore(s)
    return store.best(KEY).then((best) => expect(best!.time).toBeCloseTo(51.0, 6))
  })

  it('leaves easy and standard apart, and runs once', () => {
    const s = new MemoryStorage()
    s.setItem(TYRE_FLAG, '1')
    s.setItem('car-racing:record:balanced_8|legacy|std', stored(53.7, 'legacy'))
    s.setItem('car-racing:record:balanced_8|legacy|easy', stored(48.0, 'legacy'))
    new LocalRecordStore(s)
    expect(JSON.parse(s.getItem('car-racing:record:balanced_8|std')!).time).toBeCloseTo(53.7, 6)
    expect(JSON.parse(s.getItem('car-racing:record:balanced_8|easy')!).time).toBeCloseTo(48.0, 6)

    // Second construction must not re-run and must not disturb what is there.
    s.setItem('car-racing:record:balanced_8|std', stored(50.0, 'legacy'))
    new LocalRecordStore(s)
    expect(JSON.parse(s.getItem('car-racing:record:balanced_8|std')!).time).toBeCloseTo(50.0, 6)
  })
})

describe('Croft Bay timing-origin migration', () => {
  it('removes former-layout laps once and leaves every other circuit alone', () => {
    const s = new MemoryStorage()
    s.setItem(TYRE_FLAG, '1')
    s.setItem('car-racing:record:power_8|std', '{}')
    s.setItem('car-racing:past:power_8|easy', '[]')
    s.setItem('car-racing:record:balanced_8|std', '{}')

    new LocalRecordStore(s)
    expect(s.getItem('car-racing:record:power_8|std')).toBeNull()
    expect(s.getItem('car-racing:past:power_8|easy')).toBeNull()
    expect(s.getItem('car-racing:record:balanced_8|std')).toBe('{}')

    // Once the new origin has been seen, a newly set Croft lap must survive the
    // next page load.
    s.setItem('car-racing:record:power_8|std', '{}')
    new LocalRecordStore(s)
    expect(s.getItem('car-racing:record:power_8|std')).toBe('{}')
  })
})

describe('Thruxton Vale timing-origin migration', () => {
  it('removes former-layout laps once and leaves every other circuit alone', () => {
    const s = new MemoryStorage()
    s.setItem(TYRE_FLAG, '1')
    s.setItem('car-racing:record:power_3|std', '{}')
    s.setItem('car-racing:past:power_3|easy', '[]')
    s.setItem('car-racing:record:balanced_8|std', '{}')

    new LocalRecordStore(s)
    expect(s.getItem('car-racing:record:power_3|std')).toBeNull()
    expect(s.getItem('car-racing:past:power_3|easy')).toBeNull()
    expect(s.getItem('car-racing:record:balanced_8|std')).toBe('{}')

    // A new Thruxton lap survives after the new timing origin has been seen.
    s.setItem('car-racing:record:power_3|std', '{}')
    new LocalRecordStore(s)
    expect(s.getItem('car-racing:record:power_3|std')).toBe('{}')
  })
})

describe('Elvington Mile timing-origin migration', () => {
  it('removes former-layout laps once and leaves every other circuit alone', () => {
    const s = new MemoryStorage()
    s.setItem(TYRE_FLAG, '1')
    s.setItem('car-racing:record:power_4|std', '{}')
    s.setItem('car-racing:past:power_4|easy', '[]')
    s.setItem('car-racing:record:balanced_8|std', '{}')

    new LocalRecordStore(s)
    expect(s.getItem('car-racing:record:power_4|std')).toBeNull()
    expect(s.getItem('car-racing:past:power_4|easy')).toBeNull()
    expect(s.getItem('car-racing:record:balanced_8|std')).toBe('{}')

    // A new Elvington lap survives after the new timing origin has been seen.
    s.setItem('car-racing:record:power_4|std', '{}')
    new LocalRecordStore(s)
    expect(s.getItem('car-racing:record:power_4|std')).toBe('{}')
  })
})

describe('tyre-model migration', () => {
  it('retires old laps once without clearing settings or future laps', () => {
    const s = new MemoryStorage()
    s.setItem('car-racing:record:balanced_8|std', '{}')
    s.setItem('car-racing:past:power_1|easy', '[]')
    s.setItem('bite-point:settings', '{"volume":0.5}')

    new LocalRecordStore(s)
    expect(s.getItem('car-racing:record:balanced_8|std')).toBeNull()
    expect(s.getItem('car-racing:past:power_1|easy')).toBeNull()
    expect(s.getItem('bite-point:settings')).toBe('{"volume":0.5}')

    s.setItem('car-racing:record:balanced_8|std', '{}')
    new LocalRecordStore(s)
    expect(s.getItem('car-racing:record:balanced_8|std')).toBe('{}')
  })
})
