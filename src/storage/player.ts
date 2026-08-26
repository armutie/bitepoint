import type { SupabaseClient } from '@supabase/supabase-js'

import { parseUsername } from '../shared/playerIdentity'

const DEVICE_PROFILE_KEY = 'bitepoint:player-profile:v1'
const SUPABASE_PROFILE_KEY = 'bitepoint:supabase-profile:v1'

export interface PlayerProfile {
  id: string
  username: string
  /** A Google identity makes the name recoverable on another device. */
  locked: boolean
}

export interface PlayerProfileClient {
  readonly current: PlayerProfile | null
  readonly supportsGoogle: boolean
  /** A failed attempt to reserve a local name after the Google redirect. */
  readonly claimError: string | null
  ready(): Promise<void>
  claim(username: string): Promise<PlayerProfile>
  /** Headers expected by the leaderboard service, optionally requiring a session. */
  headers(authenticated?: boolean): Promise<Record<string, string>>
  lockWithGoogle(): Promise<void>
  signInWithGoogle(): Promise<void>
  /** End the session on this browser without deleting the driver's profile or laps. */
  signOut(): Promise<void>
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
  readonly claimError = null
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

  async signOut(): Promise<void> {
    this.profile = null
    remove(this.storage, DEVICE_PROFILE_KEY)
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
 * Production identity: the browser keeps a provisional name locally. Google
 * authentication is the point where the API reserves it and accepts laps.
 * A leftover anonymous session is discarded before OAuth so an existing
 * Google identity can restore its original profile instead of failing to link.
 */
export class SupabasePlayerProfileClient implements PlayerProfileClient {
  readonly supportsGoogle = true
  private profile: PlayerProfile | null
  private claimProblem: string | null = null
  private readyPromise: Promise<void> | null = null

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly publishableKey: string,
    private readonly functionUrl: string,
    private readonly storage: Storage = window.localStorage,
  ) {
    this.profile = this.load()
    this.supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        if (this.profile?.locked) this.forget()
      }
    })
  }

  get current(): PlayerProfile | null {
    return this.profile
  }

  get claimError(): string | null {
    return this.claimProblem
  }

  ready(): Promise<void> {
    this.readyPromise ??= this.restoreFromSession()
    return this.readyPromise
  }

  async claim(username: string): Promise<PlayerProfile> {
    const parsed = parseUsername(username)
    if (!parsed) throw new Error('That username is not valid.')
    this.claimProblem = null
    const session = await this.session()
    if (session && !session.user.is_anonymous) return this.claimRemote(parsed.username, session)
    return this.remember({
      id: this.profile?.id ?? `local:${crypto.randomUUID()}`,
      username: parsed.username,
      locked: false,
    })
  }

  async headers(authenticated = false): Promise<Record<string, string>> {
    const headers: Record<string, string> = { apikey: this.publishableKey }
    const session = await this.session()
    if (authenticated && (!session || session.user.is_anonymous)) {
      throw new Error('Sign in with Google to save laps to the leaderboard.')
    }
    if (session) headers.authorization = `Bearer ${session.access_token}`
    return headers
  }

  async lockWithGoogle(): Promise<void> {
    if (!this.profile) throw new Error('Choose a driver name before signing in.')
    if (this.profile.locked) return
    const session = await this.session()
    if (session && !session.user.is_anonymous) {
      await this.claimRemote(this.profile.username, session)
      return
    }
    if (session?.user.is_anonymous) {
      // Earlier builds created an anonymous Auth user before Google. Linking
      // that user fails when this Google identity already owns a Bitepoint
      // profile. The local name/laps are browser data, so discard only the
      // temporary Auth session and sign into the authoritative Google user.
      const signedOut = await this.supabase.auth.signOut({ scope: 'local' })
      if (signedOut.error) throw new Error(signedOut.error.message)
    }
    const { error } = await this.supabase.auth.signInWithOAuth({
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

  async signOut(): Promise<void> {
    const session = await this.session()
    if (session) {
      const { error } = await this.supabase.auth.signOut({ scope: 'local' })
      if (error) throw new Error(error.message)
    }
    this.forget()
  }

  private async restoreFromSession(): Promise<void> {
    const session = await this.session()
    if (!session || session.user.is_anonymous) return
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
      this.remember({ ...envelope.profile, locked: true })
      return
    } catch {
      // A newly authenticated driver has no server profile until their local
      // name is claimed below. A returning driver normally succeeds above.
    }
    if (!this.profile || this.profile.locked) return
    try {
      await this.claimRemote(this.profile.username, session)
    } catch (error) {
      this.claimProblem = error instanceof Error ? error.message : 'That name could not be reserved.'
    }
  }

  private async session(): Promise<Session | null> {
    const current = await this.supabase.auth.getSession()
    if (current.error) throw new Error(current.error.message)
    return current.data.session
  }

  private async claimRemote(username: string, session: Session): Promise<PlayerProfile> {
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
    return this.remember({ ...envelope.profile, locked: true })
  }

  private remember(profile: PlayerProfile): PlayerProfile {
    this.profile = profile
    this.claimProblem = null
    save(this.storage, SUPABASE_PROFILE_KEY, profile)
    return profile
  }

  private forget(): void {
    this.profile = null
    this.claimProblem = null
    remove(this.storage, SUPABASE_PROFILE_KEY)
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

function remove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    // Signing out still succeeds in memory when persistence is unavailable.
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
