import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { DevicePlayerProfileClient, SupabasePlayerProfileClient } from './player'

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

  it('forgets a device profile when signed out', async () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      profile: { id: 'player-1', username: 'ApexFox' },
      accessToken: 'bp_secret-token',
    }), { status: 201, headers: { 'content-type': 'application/json' } })))

    const client = new DevicePlayerProfileClient('https://board.example', storage)
    await client.claim('ApexFox')
    await client.signOut()

    expect(client.current).toBeNull()
    expect(new DevicePlayerProfileClient('https://board.example', storage).current).toBeNull()
  })

  it('signs out of Supabase without deleting the recoverable profile', async () => {
    const storage = new MemoryStorage()
    storage.setItem('bitepoint:supabase-profile:v1', JSON.stringify({
      id: 'player-1', username: 'ApexFox', locked: true,
    }))
    const signOut = vi.fn(async () => ({ error: null }))
    const supabase = {
      auth: { onAuthStateChange: vi.fn(), signOut },
    } as unknown as SupabaseClient
    const client = new SupabasePlayerProfileClient(
      supabase,
      'publishable-key',
      'https://board.example',
      storage,
    )

    await client.signOut()

    expect(signOut).toHaveBeenCalledOnce()
    expect(client.current).toBeNull()
    expect(storage.getItem('bitepoint:supabase-profile:v1')).toBeNull()
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
