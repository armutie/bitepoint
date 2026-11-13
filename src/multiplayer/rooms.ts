/**
 * How two drivers find each other before the race traffic goes peer to peer.
 *
 * Two ways, behind one interface:
 *
 *  - `HttpRoom`: the small room service in `server/multiplayerApp.ts`. Built
 *    into the dev server, or hosted wherever `VITE_MULTIPLAYER_SERVER` says.
 *  - `RealtimeRoom`: a Supabase Realtime channel named after the room code.
 *    No server of our own: the live site already has Supabase, so two players
 *    anywhere can meet through it. Presence carries the lobby (who is in the
 *    room, and the host's settings); broadcast carries the WebRTC offer, answer
 *    and candidates. Nothing touches the database.
 *
 * Either way, only the handshake goes through here. The race itself runs on
 * the direct peer link (or a TURN relay), never through this.
 */
import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js'

import { PROTOCOL, validConfig, type LobbyState, type RoomConfig, type Signal, type Slot, type Ticket } from './protocol'

export interface IceConfig { iceServers: RTCIceServer[]; relay: boolean }

export interface Room {
  readonly ticket: Ticket
  iceServers(): Promise<IceConfig>
  /** Begin delivering lobby updates and connection messages. */
  start(handlers: {
    lobby: (state: LobbyState) => void
    signal: (signal: Signal) => void
    error: (message: string) => void
  }): void
  send(signal: Signal): Promise<void>
  /** The peer link is up: background traffic can slow down. */
  connected(): void
  /** Leave for good, telling the room service where there is one. */
  leave(): Promise<void>
  close(): void
}

/** Public STUN only: finds each player's public address; carries no game data. */
const STUN: RTCIceServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
]

// ---------------------------------------------------------------------------
// HTTP room service

const BASE = (import.meta.env['VITE_MULTIPLAYER_SERVER'] as string | undefined)?.replace(/\/$/, '') ?? './multiplayer-api'

export async function service<T>(path: string, method = 'GET', body?: unknown, ticket?: Ticket): Promise<T> {
  const response = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(ticket ? { Authorization: `Bearer ${ticket.token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(8000),
  })
  const data = await response.json().catch(() => ({ error: 'Room service unavailable' }))
  if (!response.ok) throw new Error(data.error ?? 'Room service unavailable')
  return data as T
}

class HttpRoom implements Room {
  private timer: ReturnType<typeof setTimeout> | null = null
  private cursor = 0
  private closed = false
  private linked = false
  constructor(readonly ticket: Ticket) {}
  iceServers(): Promise<IceConfig> {
    return service<IceConfig>(`/rooms/${this.ticket.code}/ice`, 'GET', undefined, this.ticket)
  }
  start(h: Parameters<Room['start']>[0]): void {
    const poll = async (): Promise<void> => {
      if (this.closed) return
      try {
        const state = await service<LobbyState & { signals: { id: number; signal: Signal }[]; cursor: number }>(
          `/rooms/${this.ticket.code}?after=${this.cursor}`, 'GET', undefined, this.ticket)
        if (this.closed) return
        h.lobby(state)
        for (const entry of state.signals) h.signal(entry.signal)
        this.cursor = state.cursor
      } catch (e) { h.error(e instanceof Error ? e.message : 'Room connection lost'); return }
      // Fast while connecting; only a keep-alive once the peer link is up.
      if (!this.closed) this.timer = setTimeout(() => void poll(), this.linked ? 10_000 : 300)
    }
    void poll()
  }
  async send(signal: Signal): Promise<void> {
    await service(`/rooms/${this.ticket.code}/signals`, 'POST', { signal }, this.ticket)
  }
  connected(): void { this.linked = true }
  async leave(): Promise<void> {
    this.close()
    await service(`/rooms/${this.ticket.code}`, 'DELETE', undefined, this.ticket).catch(() => {})
  }
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer) }
}

// ---------------------------------------------------------------------------
// Supabase Realtime

interface Presence { slot: Slot; name: string; config?: RoomConfig; protocol: string }

const channelName = (code: string): string => `bitepoint-mp-${code}`
const newCode = (): string => Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()

export class RealtimeRoom implements Room {
  private closed = false
  private handlers: Parameters<Room['start']>[0] | null = null
  private names: [string, string | null]
  private constructor(
    readonly ticket: Ticket,
    private readonly client: SupabaseClient,
    private readonly channel: RealtimeChannel,
    host: string,
  ) {
    this.names = [host, null]
    channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
      const m = payload as { to?: number; signal?: Signal }
      if (m?.to === ticket.slot && m.signal) this.handlers?.signal(m.signal)
    })
    channel.on('presence', { event: 'sync' }, () => this.sync())
  }

  /** Everyone currently in the room, by slot. */
  private members(): Presence[] {
    return Object.values(this.channel.presenceState<Presence>()).flat()
      .filter((p): p is Presence & { presence_ref: string } => p.slot === 0 || p.slot === 1)
  }

  private sync(): void {
    const members = this.members()
    const host = members.find((p) => p.slot === 0), guest = members.find((p) => p.slot === 1)
    if (!host && this.ticket.slot === 1) { this.handlers?.error('The host left the room.'); return }
    this.names = [host?.name ?? this.names[0], guest?.name ?? null]
    this.handlers?.lobby({ names: this.names, config: this.ticket.config })
  }

  static async create(client: SupabaseClient, name: string, config: RoomConfig): Promise<RealtimeRoom> {
    const code = newCode()
    const channel = await subscribe(client, code)
    const room = new RealtimeRoom({ code, token: '', slot: 0, config }, client, channel, name)
    await channel.track({ slot: 0, name, config, protocol: PROTOCOL } satisfies Presence)
    return room
  }

  static async join(client: SupabaseClient, name: string, code: string): Promise<RealtimeRoom> {
    const channel = await subscribe(client, code)
    // Presence arrives just after subscribing; give it a moment to settle.
    const members = await waitForPresence(channel, 4000)
    const host = members.find((p) => p.slot === 0)
    if (!host) { await client.removeChannel(channel); throw new Error('Room not found or expired') }
    if (members.some((p) => p.slot === 1)) { await client.removeChannel(channel); throw new Error('This room already has two drivers') }
    if (host.protocol !== PROTOCOL || !validConfig(host.config)) {
      await client.removeChannel(channel)
      throw new Error('This room uses a different game version. Reload both games.')
    }
    const room = new RealtimeRoom({ code, token: '', slot: 1, config: host.config }, client, channel, host.name)
    await channel.track({ slot: 1, name, protocol: PROTOCOL } satisfies Presence)
    return room
  }

  async iceServers(): Promise<IceConfig> { return { iceServers: STUN, relay: false } }
  start(h: Parameters<Room['start']>[0]): void { this.handlers = h; this.sync() }
  async send(signal: Signal): Promise<void> {
    if (this.closed) return
    const result = await this.channel.send({ type: 'broadcast', event: 'signal', payload: { to: 1 - this.ticket.slot, signal } })
    if (result !== 'ok') throw new Error('The connection message could not be delivered.')
  }
  connected(): void {}
  async leave(): Promise<void> { this.close() }
  close(): void {
    if (this.closed) return
    this.closed = true
    void this.channel.untrack().catch(() => {}).finally(() => void this.client.removeChannel(this.channel))
  }
}

function subscribe(client: SupabaseClient, code: string): Promise<RealtimeChannel> {
  const channel = client.channel(channelName(code), { config: { broadcast: { self: false, ack: true }, presence: { key: crypto.randomUUID() } } })
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Could not reach the room service. Try again.')), 8000)
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') { clearTimeout(timeout); resolve(channel) }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timeout); reject(new Error('Could not reach the room service. Try again.')) }
    })
  })
}

function waitForPresence(channel: RealtimeChannel, ms: number): Promise<Presence[]> {
  const read = (): Presence[] => Object.values(channel.presenceState<Presence>()).flat()
  return new Promise((resolve) => {
    const done = (): void => { clearTimeout(timer); resolve(read()) }
    const timer = setTimeout(done, ms)
    channel.on('presence', { event: 'sync' }, () => { if (read().some((p) => p.slot === 0)) done() })
    if (read().some((p) => p.slot === 0)) done()
  })
}

// ---------------------------------------------------------------------------

let supabase: Promise<SupabaseClient> | null = null
function realtimeClient(): Promise<SupabaseClient> | null {
  const url = (import.meta.env['VITE_SUPABASE_URL'] as string | undefined)?.trim()
  const key = (import.meta.env['VITE_SUPABASE_PUBLISHABLE_KEY'] as string | undefined)?.trim()
  if (!url || !key) return null
  // Loaded only when multiplayer is used, so it never weighs on the main game.
  supabase ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(url, key, { auth: { persistSession: false }, realtime: { params: { eventsPerSecond: 20 } } }))
  return supabase
}

/**
 * Which way rooms are made. An explicit room server wins; otherwise the live
 * site's Supabase; the dev server's built-in room service as the fallback.
 */
export function roomTransport(): 'http' | 'realtime' | null {
  if (import.meta.env['VITE_MULTIPLAYER_SERVER']) return 'http'
  if (realtimeClient()) return 'realtime'
  return import.meta.env.DEV ? 'http' : null
}

export async function createRoom(name: string, config: RoomConfig): Promise<Room> {
  const client = roomTransport() === 'realtime' ? realtimeClient() : null
  if (client) return RealtimeRoom.create(await client, name, config)
  return new HttpRoom(await service<Ticket>('/rooms', 'POST', { name, config }))
}

export async function joinRoom(name: string, code: string): Promise<Room> {
  const clean = code.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 6)
  if (clean.length !== 6) throw new Error('Enter the six-character room code.')
  const client = roomTransport() === 'realtime' ? realtimeClient() : null
  if (client) return RealtimeRoom.join(await client, name, clean)
  return new HttpRoom(await service<Ticket>(`/rooms/${clean}/join`, 'POST', { name }))
}
