import { describe, expect, it } from 'vitest'

import { recordRank } from './rankMemory'

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>()
  get length(): number { return this.items.size }
  clear(): void { this.items.clear() }
  getItem(key: string): string | null { return this.items.get(key) ?? null }
  key(index: number): string | null { return [...this.items.keys()][index] ?? null }
  removeItem(key: string): void { this.items.delete(key) }
  setItem(key: string, value: string): void { this.items.set(key, value) }
}

describe('rank memory', () => {
  it('announces the first ranking on a circuit', () => {
    expect(recordRank(new MemoryStorage(), 'power_8', 14)).toEqual({ rank: 14, gained: null })
  })

  it('announces a climb with the places gained', () => {
    const storage = new MemoryStorage()
    recordRank(storage, 'power_8', 14)
    expect(recordRank(storage, 'power_8', 8)).toEqual({ rank: 8, gained: 6 })
  })

  it('stays quiet when holding or dropping a place, but remembers it', () => {
    const storage = new MemoryStorage()
    recordRank(storage, 'power_8', 8)
    expect(recordRank(storage, 'power_8', 8)).toBeNull()
    expect(recordRank(storage, 'power_8', 10)).toBeNull()
    expect(recordRank(storage, 'power_8', 9)).toEqual({ rank: 9, gained: 1 })
  })

  it('keeps circuits apart', () => {
    const storage = new MemoryStorage()
    recordRank(storage, 'power_8', 3)
    expect(recordRank(storage, 'balanced_8', 20)).toEqual({ rank: 20, gained: null })
  })

  it('survives unreadable storage', () => {
    const storage = new MemoryStorage()
    storage.setItem('bitepoint:last-rank:v1', 'not json')
    expect(recordRank(storage, 'power_8', 5)).toEqual({ rank: 5, gained: null })
    expect(recordRank(null, 'power_8', 5)).toEqual({ rank: 5, gained: null })
  })
})
