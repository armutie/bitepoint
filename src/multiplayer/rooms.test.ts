import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { canonicalConfig, PROTOCOL, type LobbyState, type RoomConfig, type Signal } from './protocol'
import { RealtimeRoom } from './rooms'

const config: RoomConfig = { protocol: PROTOCOL, trackId: 'power_8', preset: 'legacy', laps: 3, manual: false, abs: true, contact: false }

/** An in-memory stand-in for Supabase Realtime: presence and broadcast per channel name. */
class FakeRealtime {
  private readonly topics = new Map<string, Set<FakeChannel>>()
  client(): SupabaseClient {
    return {
      channel: (name: string, opts: { config: { presence: { key: string } } }) => new FakeChannel(this, name, opts.config.presence.key),
      removeChannel: async (ch: FakeChannel) => { ch.leave(); return 'ok' },
    } as unknown as SupabaseClient
  }
  join(ch: FakeChannel): void { (this.topics.get(ch.name) ?? this.topics.set(ch.name, new Set()).get(ch.name)!).add(ch) }
  leave(ch: FakeChannel): void { this.topics.get(ch.name)?.delete(ch); this.sync(ch.name) }
  peers(name: string): FakeChannel[] { return [...(this.topics.get(name) ?? [])] }
  sync(name: string): void { for (const ch of this.peers(name)) ch.emit('presence', 'sync', {}) }
}

class FakeChannel {
  presence: Record<string, unknown> | null = null
  private readonly listeners: { type: string; event: string; cb: (p: { payload?: unknown }) => void }[] = []
  constructor(private readonly hub: FakeRealtime, readonly name: string, private readonly key: string) {}
  private subscribed = false
  on(type: string, filter: { event: string }, cb: (p: { payload?: unknown }) => void): this {
    // As supabase-js does: listeners after subscribe() are refused.
    if (this.subscribed) throw new Error(`cannot add \`${type}\` callbacks after \`subscribe()\`.`)
    this.listeners.push({ type, event: filter.event, cb }); return this
  }
  emit(type: string, event: string, p: { payload?: unknown }): void {
    for (const l of this.listeners) if (l.type === type && l.event === event) l.cb(p)
  }
  subscribe(cb: (status: string) => void): this { this.subscribed = true; this.hub.join(this); queueMicrotask(() => cb('SUBSCRIBED')); return this }
  async track(payload: Record<string, unknown>): Promise<string> { this.presence = payload; this.hub.sync(this.name); return 'ok' }
  async untrack(): Promise<string> { this.presence = null; this.hub.sync(this.name); return 'ok' }
  presenceState(): Record<string, unknown[]> {
    return Object.fromEntries(this.hub.peers(this.name).filter((c) => c.presence).map((c) => [c.key, [{ ...c.presence, presence_ref: c.key }]]))
  }
  async send(m: { event: string; payload: unknown }): Promise<string> {
    for (const ch of this.hub.peers(this.name)) if (ch !== this) ch.emit('broadcast', m.event, { payload: m.payload })
    return 'ok'
  }
  leave(): void { this.presence = null; this.hub.leave(this) }
}

function watch(room: RealtimeRoom): { lobby: LobbyState[]; signals: Signal[]; errors: string[] } {
  const seen = { lobby: [] as LobbyState[], signals: [] as Signal[], errors: [] as string[] }
  room.start({ lobby: (s) => seen.lobby.push(s), signal: (s) => seen.signals.push(s), error: (e) => seen.errors.push(e) })
  return seen
}

describe('meeting through Supabase Realtime', () => {
  it('lets a guest join by code, sees both names, and carries the host settings', async () => {
    const hub = new FakeRealtime()
    const host = await RealtimeRoom.create(hub.client(), 'Ana', config)
    const hostSeen = watch(host)
    const guest = await RealtimeRoom.join(hub.client(), 'Ben', host.ticket.code)
    expect(guest.ticket).toMatchObject({ code: host.ticket.code, slot: 1, config })
    expect(hostSeen.lobby.at(-1)?.names).toEqual(['Ana', 'Ben'])
    expect(watch(guest).lobby.at(-1)?.names).toEqual(['Ana', 'Ben'])
  })

  it('delivers each connection message to the other driver only', async () => {
    const hub = new FakeRealtime()
    const host = await RealtimeRoom.create(hub.client(), 'Ana', config)
    const guest = await RealtimeRoom.join(hub.client(), 'Ben', host.ticket.code)
    const h = watch(host), g = watch(guest)
    await host.send({ kind: 'offer', data: { sdp: 'o' } })
    await guest.send({ kind: 'answer', data: { sdp: 'a' } })
    expect(g.signals).toEqual([{ kind: 'offer', data: { sdp: 'o' } }])
    expect(h.signals).toEqual([{ kind: 'answer', data: { sdp: 'a' } }])
  })

  it('turns away a wrong code and a third driver', async () => {
    const hub = new FakeRealtime()
    await expect(RealtimeRoom.join(hub.client(), 'Ben', 'ABC123')).rejects.toThrow('Room not found')
    const host = await RealtimeRoom.create(hub.client(), 'Ana', config)
    await RealtimeRoom.join(hub.client(), 'Ben', host.ticket.code)
    await expect(RealtimeRoom.join(hub.client(), 'Cy', host.ticket.code)).rejects.toThrow('two drivers')
  }, 10_000)

  it('tells the guest when the host leaves', async () => {
    const hub = new FakeRealtime()
    const host = await RealtimeRoom.create(hub.client(), 'Ana', config)
    const guest = await RealtimeRoom.join(hub.client(), 'Ben', host.ticket.code)
    const g = watch(guest)
    host.close()
    await new Promise((r) => setTimeout(r, 0))
    expect(g.errors).toContain('The host left the room.')
  })
})

describe('room settings fingerprint', () => {
  it('is the same whatever order the keys arrive in', () => {
    const shuffled = Object.fromEntries(Object.entries(config).reverse()) as unknown as RoomConfig
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(config))
    expect(JSON.stringify(canonicalConfig(shuffled))).toBe(JSON.stringify(canonicalConfig(config)))
  })
})
