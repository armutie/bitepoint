import { afterEach, describe, expect, it, vi } from 'vitest'

import { DevicePlayerProfileClient } from './player'

afterEach(() => vi.unstubAllGlobals())

describe('browser player profile', () => {
  it('persists the server-issued identity without storing a password', async () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      profile: { id: 'player-1', username: 'ApexFox' },
      accessToken: 'bp_secret-token',
    }), { status: 201, headers: { 'content-type': 'application/json' } })))

    const first = new DevicePlayerProfileClient('https://board.example', storage)
    await expect(first.claim('ApexFox')).resolves.toMatchObject({ username: 'ApexFox' })

    const restored = new DevicePlayerProfileClient('https://board.example', storage)
    expect(restored.current).toMatchObject({ id: 'player-1', username: 'ApexFox' })
    await expect(restored.headers(true)).resolves.toMatchObject({
      authorization: 'Bearer bp_secret-token',
    })
  })

  it('surfaces a taken-name response as useful form text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('That username is already taken.', {
      status: 409,
    })))
    const client = new DevicePlayerProfileClient('https://board.example', new MemoryStorage())
    await expect(client.claim('ApexFox')).rejects.toThrow('That username is already taken.')
  })
})

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}
