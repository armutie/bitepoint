import type { SupabaseClient, User } from '@supabase/supabase-js'

import { parseUsername } from '../shared/playerIdentity'

const DEVICE_PROFILE_KEY = 'bitepoint:player-profile:v1'
const SUPABASE_PROFILE_KEY = 'bitepoint:supabase-profile:v1'

export interface PlayerProfile {
  id: string
  username: string
  /** A linked identity makes the name recoverable on another device. */
  locked: boolean
}

export interface PlayerProfileClient {
  readonly current: PlayerProfile | null
  readonly supportsGoogle: boolean
  ready(): Promise<void>
  claim(username: string): Promise<PlayerProfile>
  /** Headers expected by the leaderboard service, optionally requiring a session. */
  headers(authenticated?: boolean): Promise<Record<string, string>>
  lockWithGoogle(): Promise<void>
  signInWithGoogle(): Promise<void>
}

interface DeviceProfile extends PlayerProfile {
  accessToken: string
}

interface DeviceProfileEnvelope {
  profile: { id: string; username: string }
  accessToken: string
}

/**
 * Zero-setup local API identity. The random token is deliberately invisible:
 * it belongs to this browser in the same way a localStorage save does.
 */
export class DevicePlayerProfileClient implements PlayerProfileClient {
  readonly supportsGoogle = false
  private profile: DeviceProfile | null

  constructor(
    private readonly baseUrl: string,
    private readonly storage: Storage = window.localStorage,
  ) {
    this.profile = this.load()
  }

  get current(): PlayerProfile | null {
    return this.profile
  }

  async ready(): Promise<void> {}

  async claim(username: string): Promise<PlayerProfile> {
    if (!parseUsername(username)) throw new Error('That username is not valid.')
    const envelope = await requestJson<DeviceProfileEnvelope>(`${trimSlash(this.baseUrl)}/v1/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username }),
    })
    const profile: DeviceProfile = {
      id: envelope.profile.id,
      username: envelope.profile.username,
      accessToken: envelope.accessToken,
      locked: false,
    }
    this.profile = profile
    save(this.storage, DEVICE_PROFILE_KEY, profile)
    return profile
  }

  async headers(_authenticated = false): Promise<Record<string, string>> {
    return this.profile ? { authorization: `Bearer ${this.profile.accessToken}` } : {}
  }

  async lockWithGoogle(): Promise<void> {
    throw new Error('Google locking is available when Supabase is configured.')
  }

  async signInWithGoogle(): Promise<void> {
    throw new Error('Google sign-in is available when Supabase is configured.')
  }

  private load(): DeviceProfile | null {
    const value = load(this.storage, DEVICE_PROFILE_KEY)
    if (
      typeof value?.id !== 'string' || typeof value.username !== 'string' ||
      typeof value.accessToken !== 'string' || !parseUsername(value.username)
    ) return null
    return {
      id: value.id,
      username: value.username,
      accessToken: value.accessToken,
      locked: false,
    }
  }
}

interface SupabaseProfileEnvelope {
  profile: PlayerProfile
}

/**
 * Production identity: an anonymous Supabase user is the device profile, then
 * Google is linked to that same auth user when the driver chooses to lock it in.
 */
export class SupabasePlayerProfileClient implements PlayerProfileClient {
  readonly supportsGoogle = true
  private profile: PlayerProfile | null
  private readyPromise: Promise<void> | null = null

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly publishableKey: string,
    private readonly functionUrl: string,
    private readonly storage: Storage = window.localStorage,
  ) {
    this.profile = this.load()
    this.supabase.auth.onAuthStateChange((_event, session) => {
      if (!this.profile || !session?.user) return
      this.remember({ ...this.profile, locked: isLocked(session.user) })
    })
  }

  get current(): PlayerProfile | null {
    return this.profile
  }

  ready(): Promise<void> {
    this.readyPromise ??= this.restoreFromSession()
    return this.readyPromise
  }

  async claim(username: string): Promise<PlayerProfile> {
    if (!parseUsername(username)) throw new Error('That username is not valid.')
    const session = await this.session(true)
    if (!session) throw new Error('Could not save a profile on this device.')
    const envelope = await requestJson<SupabaseProfileEnvelope>(
      `${trimSlash(this.functionUrl)}/v1/profiles`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: this.publishableKey,
          authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ username }),
      },
    )
    return this.remember(envelope.profile)
  }

  async headers(authenticated = false): Promise<Record<string, string>> {
    const headers: Record<string, string> = { apikey: this.publishableKey }
    const session = await this.session(authenticated)
    if (session) headers.authorization = `Bearer ${session.access_token}`
    return headers
  }

  async lockWithGoogle(): Promise<void> {
    if (!this.profile) throw new Error('Choose a username before locking it in.')
    if (this.profile.locked) return
    const { error } = await this.supabase.auth.linkIdentity({
      provider: 'google',
      options: { redirectTo: redirectUrl() },
    })
    if (error) throw new Error(error.message)
  }

  async signInWithGoogle(): Promise<void> {
    const { error } = await this.supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: redirectUrl() },
    })
    if (error) throw new Error(error.message)
  }

  private async restoreFromSession(): Promise<void> {
    const session = await this.session(false)
    if (!session) return
    try {
      const envelope = await requestJson<SupabaseProfileEnvelope>(
        `${trimSlash(this.functionUrl)}/v1/me`,
        {
          headers: {
            apikey: this.publishableKey,
            authorization: `Bearer ${session.access_token}`,
          },
        },
      )
      this.remember({ ...envelope.profile, locked: isLocked(session.user) })
    } catch {
      // A valid anonymous session may simply not have chosen a username yet.
    }
  }

  private async session(required: boolean): Promise<Session | null> {
    const current = await this.supabase.auth.getSession()
    if (current.error) throw new Error(current.error.message)
    if (current.data.session || !required) return current.data.session
    const created = await this.supabase.auth.signInAnonymously()
    if (created.error || !created.data.session) {
      throw new Error(created.error?.message ?? 'Could not save a profile on this device.')
    }
    return created.data.session
  }

  private remember(profile: PlayerProfile): PlayerProfile {
    this.profile = profile
    save(this.storage, SUPABASE_PROFILE_KEY, profile)
    return profile
  }

  private load(): PlayerProfile | null {
    const value = load(this.storage, SUPABASE_PROFILE_KEY)
    if (
      typeof value?.id !== 'string' || typeof value.username !== 'string' ||
      typeof value.locked !== 'boolean' || !parseUsername(value.username)
    ) return null
    return { id: value.id, username: value.username, locked: value.locked }
  }
}

type Session = NonNullable<Awaited<ReturnType<SupabaseClient['auth']['getSession']>>['data']['session']>

function isLocked(user: User): boolean {
  return user.is_anonymous === false
}

function redirectUrl(): string {
  return `${window.location.origin}${window.location.pathname}`
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, '')
}

function load(storage: Storage, key: string): Record<string, unknown> | null {
  try {
    const raw = storage.getItem(key)
    return raw ? JSON.parse(raw) as Record<string, unknown> : null
  } catch {
    return null
  }
}

function save(storage: Storage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // The live identity still works; only persistence is unavailable.
  }
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    let message = body
    try {
      const parsed = JSON.parse(body) as { error?: unknown }
      if (typeof parsed.error === 'string') message = parsed.error
    } catch {
      // Plain text is already the most useful error.
    }
    throw new Error(message || `Profile request failed (${response.status}).`)
  }
  return response.json() as Promise<T>
}
