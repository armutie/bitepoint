/**
 * Personal bests and the ghosts that go with them.
 *
 * The interface is **async and keyed exactly as a server would key it**, even
 * though the only implementation right now writes to localStorage. That is the
 * whole point: swapping in a global leaderboard should be a new class behind
 * this interface, not a change to any screen.
 *
 * A record carries the *input trace*, not just a time. Locally that is what
 * makes the ghost exact. Remotely it is what makes the leaderboard checkable —
 * the server re-drives the inputs and derives the time itself, so a faked time
 * would need an input trace that genuinely drives that fast. See LapReplay.
 */
import type { CarState } from '../core/car'
import { lapUsedTc, type LapRecording, type LapTrace } from '../core/sim'
import { ASSISTS_ADJUSTABLE } from '../features'

export interface LapRecord {
  trackId: string
  preset: string
  easy: boolean
  /** See RecordKey.tc — derived from the trace, never claimed. */
  tc?: boolean
  time: number
  sectors: (number | null)[]
  /** Fastest each sector has ever gone here — the purple reference. Optional
   *  so records written before it existed still load. */
  fastestSectors?: (number | null)[]
  /** (distance, time) samples of this lap, for a true live delta. Optional
   *  for the same reason. */
  trace?: LapTrace
  /**
   * Recorded positions, for drawing this lap's ghost. See GHOST_FIELDS.
   *
   * Optional, and that is load-bearing rather than defensive: every lap set
   * before paths existed has only its input trace, so its ghost still has to
   * fall back to replaying inputs — with all the fragility that implies. Those
   * laps get an accurate ghost by being driven again, not by being converted,
   * because converting them would mean replaying them under a car that is no
   * longer the one they were driven on.
   */
  path?: Float64Array
  /** ISO 8601, so records survive being read by something other than JS. */
  recordedAt: string
  recording: LapRecording
}

/** Identity of a leaderboard column. Easy laps never mix with clean ones. */
export interface RecordKey {
  trackId: string
  easy: boolean
}

/**
 * The SETUP is deliberately not part of this either.
 *
 * It used to be: `legacy` and `classic` were two cars, and two cars do not
 * share a board. They are now two aero trims of one car — same mass, engine,
 * grip, brakes and gearbox — and a leaderboard that splits on which wing
 * somebody bolted on is a leaderboard split on setup, which no real timing
 * sheet does. Everyone runs their own; the time is the time.
 *
 * Measured before deciding: at the limit the high-downforce trim is 0.1-0.2 s
 * quicker on both circuits, about 0.2%, and below real commitment the two are
 * within 0.05 s. That is inside a driver's own lap-to-lap scatter, so neither
 * board would have been the "real" one — it would just have been half the
 * competition each.
 *
 * `LapRecord.preset` still says which trim set a lap, so the board can show it.
 *
 * Traction control is deliberately NOT part of this.
 *
 * It was, briefly, on the same reasoning that keys `easy`. That was wrong for a
 * reason worth recording: a board key has to be knowable *before* the lap, so
 * the menu can show you what there is to beat — and the TC rotary can be turned
 * mid-lap, so whether a lap is a TC lap is only known once it is over. Keying on
 * it meant the personal best on screen came from a different board than the lap
 * you were about to file, and a lap could vanish from the menu by being stored
 * under a key nothing looked up.
 *
 * The deeper argument is the same one: traction control is legal equipment, not
 * an assist. Every driver has the same knob, exactly as a real car of this era
 * did, so using it is a setup choice like brake bias rather than a different
 * category. `easy` genuinely is a different world — full grip on the grass — and
 * that is why it still keys.
 *
 * `LapRecord.tc` survives as information about a lap, not as identity.
 */
export const keyOf = (k: RecordKey): string =>
  `${k.trackId}|${k.easy ? 'easy' : 'std'}`

/**
 * What a lap is STORED under: the board, plus what the driver had switched on.
 *
 * The board and the storage slot are different questions, and conflating them
 * threw laps away. `keyOf` has to be knowable before a lap exists, so the menu
 * can show you what there is to beat — which is why assists are not in it. But
 * a lap is only saved when it beats what is already in its slot, and with one
 * slot per board a clean lap slower than your traction-control best was
 * discarded on the spot. You could never set a lap for the unassisted board
 * except by accident.
 *
 * A slot per combination fixes that, and only works because by the time a lap
 * is being stored its assists are known. The board itself is still one list;
 * see `LeaderboardEntry.assists`.
 */
export const ASSIST_SLOTS = ['', '|tc', '|abs', '|tc+abs'] as const

export function assistSlotOf(r: { recording: LapRecording }): string {
  const tc = lapUsedTc(r.recording)
  const abs = r.recording.abs ?? false
  return `${tc ? '|tc' : ''}${abs ? '|abs' : ''}`.replace('|tc|abs', '|tc+abs')
}

/**
 * The slot in use, which in v1 is always the bare one.
 *
 * Every lap is the same test while the aids are fixed, so there is nothing to
 * separate: one slot, and it is the bare board key — which is also where every
 * lap set before any of this existed already lives, so nothing migrates either
 * way. `assistSlotOf` keeps the naming honest for when the aids come back.
 */
export function assistSlot(r: { recording: LapRecording }): string {
  return ASSISTS_ADJUSTABLE ? assistSlotOf(r) : ''
}

/** Storage key: the board, then the slot. Unassisted laps keep the bare key,
 *  so every record written before assists existed stays exactly where it is. */
export const slotKeyOf = (r: LapRecord): string => keyOf(r) + assistSlot(r)

export interface RecordStore {
  best(key: RecordKey): Promise<LapRecord | null>
  /** Store if it beats the existing best. Returns true when it was a new best. */
  submit(record: LapRecord): Promise<boolean>
  /** Bests this key used to have, newest first. Empty until one is beaten. */
  past(key: RecordKey): Promise<LapRecord[]>
  all(): Promise<LapRecord[]>
  clear(): Promise<void>
}

const PREFIX = 'car-racing:record:'
/** Superseded bests live here, one list per key. */
const PAST_PREFIX = 'car-racing:past:'

/**
 * How many beaten bests to keep per key.
 *
 * Each carries a full input trace — around 64 KB for a minute's lap — against a
 * ~5 MB localStorage quota shared with everything else, so this is a small
 * number on purpose. Two is enough for the menu field to show a spread of laps
 * without the history becoming the reason a personal best fails to save.
 */
const PAST_KEPT = 2

/**
 * A localStorage view that exposes only one prefixed namespace.
 *
 * `/legacy` uses this so its old-physics PBs and ghosts cannot be read by, or
 * overwrite, laps from the released tyre model. Settings remain shared because
 * only the record store receives this view.
 */
export class NamespacedStorage implements Storage {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}

  get length(): number { return this.keys().length }

  clear(): void {
    for (const key of this.keys()) this.removeItem(key)
  }

  getItem(key: string): string | null {
    return this.storage.getItem(this.namespace + key)
  }

  key(index: number): string | null {
    return this.keys()[index] ?? null
  }

  removeItem(key: string): void {
    this.storage.removeItem(this.namespace + key)
  }

  setItem(key: string, value: string): void {
    this.storage.setItem(this.namespace + key, value)
  }

  private keys(): string[] {
    const keys: string[] = []
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i)
      if (key?.startsWith(this.namespace)) keys.push(key.slice(this.namespace.length))
    }
    return keys
  }
}

/** Serialised form. The input trace is base64 so it is not 8x its own size. */
export interface SerializedLapRecord {
  v: 1
  trackId: string
  preset: string
  easy: boolean
  time: number
  sectors: (number | null)[]
  fastestSectors?: (number | null)[]
  recordedAt: string
  start: CarState
  inputs: string
  /** Driven with a manual gearbox: the trace has three channels, not two. */
  manual?: boolean
  /**
   * Driven with the TC rotary live: the trace carries a position channel.
   *
   * This is the channel count, not the board. Whether the lap counts as a TC
   * lap is read back out of that channel by `lapUsedTc` — a lap can carry the
   * channel and never leave it at zero.
   */
  tc?: boolean
  /** Driven with ABS. One bit, not a channel: it cannot change mid-lap. */
  abs?: boolean
  /** Trace samples, base64 Float32 — half the bytes of the live Float64 and
   *  far finer than the millisecond the delta is read to. */
  traceS?: string
  traceT?: string
  /** Ghost path, base64 Float32. Metres and radians do not need 64 bits, and
   *  this is the largest single thing a record carries. */
  path?: string
}

/**
 * Bytes to base64, natively where the browser can.
 *
 * `Uint8Array.prototype.toBase64` produces the exact string the
 * `String.fromCharCode` + `btoa` fallback does, an order of magnitude faster —
 * and speed matters here because a personal best serializes ~700 KB of bytes on
 * the tick the lap ends. NOT `TextDecoder('latin1')` for the binary string:
 * that label is windows-1252, which maps 0x80–0x9F above U+00FF and makes
 * `btoa` throw.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const native = bytes as unknown as { toBase64?: () => string }
  if (typeof native.toBase64 === 'function') return native.toBase64()
  let binary = ''
  // Chunked: String.fromCharCode(...huge) blows the argument limit on a long lap.
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToBytes(encoded: string): Uint8Array {
  const native = Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }
  if (typeof native.fromBase64 === 'function') return native.fromBase64(encoded)
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function encodeInputs(inputs: Float64Array): string {
  return bytesToBase64(new Uint8Array(inputs.buffer, inputs.byteOffset, inputs.byteLength))
}

export function decodeInputs(encoded: string): Float64Array {
  const bytes = base64ToBytes(encoded)
  return new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8)
}

/** Float32 round-trip for the trace: metres and seconds do not need 64 bits,
 *  and halving the bytes matters when this shares a 5 MB quota. */
function encodeFloat32(src: Float64Array): string {
  const f32 = Float32Array.from(src)
  return bytesToBase64(new Uint8Array(f32.buffer))
}

function decodeFloat32(encoded: string): Float64Array {
  const bytes = base64ToBytes(encoded)
  return Float64Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4))
}

export function serializeLapRecord(r: LapRecord): SerializedLapRecord {
  return {
    v: 1,
    trackId: r.trackId,
    preset: r.preset,
    easy: r.easy,
    time: r.time,
    sectors: r.sectors,
    ...(r.fastestSectors ? { fastestSectors: r.fastestSectors } : {}),
    ...(r.trace
      ? {
          traceS: encodeFloat32(r.trace.s),
          traceT: encodeFloat32(r.trace.t),
        }
      : {}),
    ...(r.path ? { path: encodeFloat32(r.path) } : {}),
    recordedAt: r.recordedAt,
    start: r.recording.start,
    inputs: encodeInputs(r.recording.inputs),
    ...(r.recording.manual ? { manual: true } : {}),
    ...(r.recording.tc ? { tc: true } : {}),
    ...(r.recording.abs ? { abs: true } : {}),
  }
}

export function deserializeLapRecord(s: SerializedLapRecord): LapRecord {
  const recording: LapRecording = {
    trackId: s.trackId,
    preset: s.preset,
    easy: s.easy,
    start: s.start,
    inputs: decodeInputs(s.inputs),
    ...(s.manual ? { manual: true } : {}),
    ...(s.tc ? { tc: true } : {}),
    ...(s.abs ? { abs: true } : {}),
  }
  return {
    trackId: s.trackId,
    preset: s.preset,
    easy: s.easy,
    // Derived on the way in rather than stored, so the board a lap sits on can
    // never drift from the trace that would be replayed to check it.
    ...(lapUsedTc(recording) ? { tc: true } : {}),
    time: s.time,
    sectors: s.sectors,
    ...(s.fastestSectors ? { fastestSectors: s.fastestSectors } : {}),
    ...(s.traceS && s.traceT
      ? { trace: { s: decodeFloat32(s.traceS), t: decodeFloat32(s.traceT) } }
      : {}),
    ...(s.path ? { path: decodeFloat32(s.path) } : {}),
    recordedAt: s.recordedAt,
    recording,
  }
}

export class LocalRecordStore implements RecordStore {
  constructor(private readonly storage: Storage = window.localStorage) {
    this.invalidateTyreModel()
    this.migrateLegacy()
    this.mergeSetupBoards()
    this.invalidateCroftTimingOrigin()
    this.invalidateThruxtonTimingOrigin()
    this.invalidateElvingtonTimingOrigin()
  }

  /** Retire every lap recorded on the former 9.5 / 1.5 / 0.97 tyre curve. */
  private invalidateTyreModel(): void {
    const FLAG = 'car-racing:tyre-10p5-1p35-neg1'
    try {
      if (this.storage.getItem(FLAG)) return
      const keys: string[] = []
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i)
        if (key?.startsWith(PREFIX) || key?.startsWith(PAST_PREFIX)) keys.push(key)
      }
      for (const key of keys) this.storage.removeItem(key)
      this.storage.setItem(FLAG, '1')
    } catch {
      // A blocked storage keeps obsolete local laps; it must not block play.
    }
  }

  /**
   * Croft Bay's timing seam moved three centreline samples down the main straight.
   * A saved path from the former line starts 32.58 m behind the player, while an
   * input replay no longer crosses the line on the ticks recorded for it. Remove
   * those laps once instead of presenting a PB or ghost for a retired layout.
   */
  private invalidateCroftTimingOrigin(): void {
    const FLAG = 'car-racing:croft-timing-origin-3'
    try {
      if (this.storage.getItem(FLAG)) return
      const keys: string[] = []
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i)
        if (!key) continue
        const prefix = key.startsWith(PREFIX)
          ? PREFIX
          : key.startsWith(PAST_PREFIX)
            ? PAST_PREFIX
            : null
        if (prefix !== null && key.slice(prefix.length).startsWith('power_8|')) keys.push(key)
      }
      for (const key of keys) this.storage.removeItem(key)
      this.storage.setItem(FLAG, '1')
    } catch {
      // A blocked storage keeps an obsolete local time; it must not block play.
    }
  }

  /** Retire laps recorded before Thruxton Vale's timing line moved 32.70 m. */
  private invalidateThruxtonTimingOrigin(): void {
    const FLAG = 'car-racing:thruxton-timing-origin-3'
    try {
      if (this.storage.getItem(FLAG)) return
      const keys: string[] = []
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i)
        if (!key) continue
        const prefix = key.startsWith(PREFIX)
          ? PREFIX
          : key.startsWith(PAST_PREFIX)
            ? PAST_PREFIX
            : null
        if (prefix !== null && key.slice(prefix.length).startsWith('power_3|')) keys.push(key)
      }
      for (const key of keys) this.storage.removeItem(key)
      this.storage.setItem(FLAG, '1')
    } catch {
      // A blocked storage keeps an obsolete local time; it must not block play.
    }
  }

  /** Retire laps recorded before Elvington Mile's timing line moved 98.62 m. */
  private invalidateElvingtonTimingOrigin(): void {
    const FLAG = 'car-racing:elvington-timing-origin-3'
    try {
      if (this.storage.getItem(FLAG)) return
      const keys: string[] = []
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i)
        if (!key) continue
        const prefix = key.startsWith(PREFIX)
          ? PREFIX
          : key.startsWith(PAST_PREFIX)
            ? PAST_PREFIX
            : null
        if (prefix !== null && key.slice(prefix.length).startsWith('power_4|')) keys.push(key)
      }
      for (const key of keys) this.storage.removeItem(key)
      this.storage.setItem(FLAG, '1')
    } catch {
      // A blocked storage keeps an obsolete local time; it must not block play.
    }
  }

  /**
   * Laps set before the `f1` preset was rebuilt were driven on what is now
   * `legacy` — a 1000 kg car with 462 kW that tops out at 270 km/h. Leaving
   * them keyed to `f1` would credit them to a car that never set them, and put
   * an unbeatable-or-trivial time against the wrong machine. Re-key them once,
   * and never overwrite a genuine `legacy` record if one already exists.
   */
  /**
   * Fold the old per-setup boards into one board per circuit.
   *
   * `keyOf` used to carry the preset, so a lap lived at `track|legacy|std`.
   * Dropping it moves the shelf, and a record left on the old one is not
   * deleted so much as invisible — which is worse, because the player is told
   * they have never set a lap here while the lap sits in storage.
   *
   * Fastest wins the merged key; the rest are simply dropped rather than being
   * pushed into the archive, because two boards' histories interleaved would
   * make `PAST_KEPT` mean something different depending on how many setups
   * happened to exist when you drove.
   */
  private mergeSetupBoards(): void {
    const FLAG = 'car-racing:merged-setups'
    try {
      if (this.storage.getItem(FLAG)) return
      // `track|preset|std` — three fields where there are now two.
      const old: string[] = []
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i)
        if (!k) continue
        for (const prefix of [PREFIX, PAST_PREFIX]) {
          if (!k.startsWith(prefix)) continue
          if (k.slice(prefix.length).split('|').length === 3) old.push(k)
        }
      }
      for (const k of old) {
        const isBest = k.startsWith(PREFIX)
        const [trackId, , mode] = k.slice(isBest ? PREFIX.length : PAST_PREFIX.length).split('|')
        if (!trackId || !mode) continue
        const merged = `${isBest ? PREFIX : PAST_PREFIX}${trackId}|${mode}`
        const value = this.storage.getItem(k)
        this.storage.removeItem(k)
        if (value === null || !isBest) continue
        const existing = this.read(merged)
        const moving = JSON.parse(value) as SerializedLapRecord
        if (!existing || moving.time < existing.time) this.storage.setItem(merged, value)
      }
      this.storage.setItem(FLAG, '1')
    } catch {
      // A blocked storage costs the merge, not the game.
    }
  }

  private migrateLegacy(): void {
    const FLAG = 'car-racing:migrated-legacy'
    try {
      if (this.storage.getItem(FLAG)) return
      const moves: [string, string][] = []
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i)
        if (!k?.startsWith(PREFIX) || !k.includes('|f1|')) continue
        moves.push([k, k.replace('|f1|', '|legacy|')])
      }
      for (const [from, to] of moves) {
        const value = this.storage.getItem(from)
        if (value !== null && this.storage.getItem(to) === null) {
          this.storage.setItem(to, value.replace('"preset":"f1"', '"preset":"legacy"'))
        }
        this.storage.removeItem(from)
      }
      this.storage.setItem(FLAG, '1')
    } catch {
      // A blocked storage costs the migration, not the game.
    }
  }

  async best(key: RecordKey): Promise<LapRecord | null> {
    // The outright best across every assist slot. This is what the menu shows
    // as "your time here", and it is the fastest lap you have set, whatever
    // you had switched on — the leaderboard is where the distinction lives.
    let best: LapRecord | null = null
    for (const slot of ASSIST_SLOTS) {
      const raw = this.read(PREFIX + keyOf(key) + slot)
      if (!raw) continue
      const lap = deserializeLapRecord(raw)
      if (!best || lap.time < best.time) best = lap
    }
    return best
  }

  async submit(record: LapRecord): Promise<boolean> {
    // Against its own slot, not against the board: a clean lap competes with
    // clean laps, so being slower than an assisted one does not lose it.
    const key = PREFIX + slotKeyOf(record)
    const existing = this.read(key)
    if (existing && existing.time <= record.time) return false
    let stored: boolean
    try {
      this.storage.setItem(key, JSON.stringify(serializeLapRecord(record)))
      stored = true
    } catch {
      // A full quota should cost you the ghost, not the lap. Shed weight in
      // order of what is least missed: the path first, because it is the
      // largest single thing here and losing it only means this lap's ghost
      // falls back to replaying its inputs; then the inputs, which costs the
      // ghost and the ability to check the time, but keeps the time itself.
      let stored2 = false
      try {
        const lean = serializeLapRecord(record)
        delete lean.path
        this.storage.setItem(key, JSON.stringify(lean))
        stored2 = true
      } catch {
        try {
          const bare = serializeLapRecord(record)
          delete bare.path
          bare.inputs = ''
          this.storage.setItem(key, JSON.stringify(bare))
          stored2 = true
        } catch {
          stored2 = false
        }
      }
      stored = stored2
    }
    // Only after the best itself is safely written, and never allowed to fail
    // the submit: the beaten lap is a nice-to-have, the new one is the point.
    if (stored && existing) this.archive(slotKeyOf(record), existing)
    return stored
  }

  async past(key: RecordKey): Promise<LapRecord[]> {
    // Every slot's history, plus the slot bests that are not the outright one —
    // otherwise the fastest clean lap would be invisible on a board whose
    // overall best was assisted, which is the whole point of keeping slots.
    const out: LapRecord[] = []
    let bestTime = Infinity
    for (const slot of ASSIST_SLOTS) {
      const raw = this.read(PREFIX + keyOf(key) + slot)
      if (raw) bestTime = Math.min(bestTime, raw.time)
    }
    for (const slot of ASSIST_SLOTS) {
      const raw = this.read(PREFIX + keyOf(key) + slot)
      if (raw && raw.time > bestTime) out.push(deserializeLapRecord(raw))
      out.push(...this.readPast(keyOf(key) + slot).map(deserializeLapRecord))
    }
    return out.sort((a, b) => a.time - b.time)
  }

  /** Push a superseded best onto its key's history, newest first. */
  private archive(key: string, beaten: SerializedLapRecord): void {
    // A lean record was written without its inputs, so it can be replayed by
    // nothing. Keeping it would spend the budget on a lap nobody can watch.
    if (!beaten.inputs) return
    // Archived laps give up their path. There are four assist slots now, each
    // with its own history, so the budget buys three times what it used to —
    // and a beaten lap is watched rarely enough to be worth replaying from its
    // inputs. The current best in each slot keeps its path.
    delete beaten.path
    const list = [beaten, ...this.readPast(key)].slice(0, PAST_KEPT)
    while (list.length > 0) {
      try {
        this.storage.setItem(PAST_PREFIX + key, JSON.stringify(list))
        return
      } catch {
        // Out of room: drop the oldest and try again, then give up quietly.
        list.pop()
      }
    }
    try {
      this.storage.removeItem(PAST_PREFIX + key)
    } catch {
      // Nothing further to do; the best is stored and that is what matters.
    }
  }

  private readPast(key: string): SerializedLapRecord[] {
    try {
      const raw = this.storage.getItem(PAST_PREFIX + key)
      if (!raw) return []
      const parsed = JSON.parse(raw) as SerializedLapRecord[]
      return Array.isArray(parsed) ? parsed.filter((r) => r?.v === 1 && r.inputs) : []
    } catch {
      return []
    }
  }

  async all(): Promise<LapRecord[]> {
    const out: LapRecord[] = []
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i)
      if (!k?.startsWith(PREFIX)) continue
      const raw = this.read(k)
      if (raw) out.push(deserializeLapRecord(raw))
    }
    return out.sort((a, b) => a.trackId.localeCompare(b.trackId) || a.time - b.time)
  }

  async clear(): Promise<void> {
    const keys: string[] = []
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i)
      if (k?.startsWith(PREFIX) || k?.startsWith(PAST_PREFIX)) keys.push(k)
    }
    for (const k of keys) this.storage.removeItem(k)
  }

  private read(key: string): SerializedLapRecord | null {
    const raw = this.storage.getItem(key)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as SerializedLapRecord
      // Anything from a future or unknown version is ignored rather than
      // guessed at; a corrupt personal best should not break the game.
      return parsed?.v === 1 ? parsed : null
    } catch {
      return null
    }
  }
}

/** mm:ss.mmm, or a dash when there is no time. */
export function formatTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return '--:--.---'
  const sign = t < 0 ? '-' : ''
  const abs = Math.abs(t)
  const m = Math.floor(abs / 60)
  const s = abs - m * 60
  return `${sign}${m}:${s.toFixed(3).padStart(6, '0')}`
}

/** +0.123 / -0.456, for deltas against a best. */
export function formatDelta(d: number | null | undefined): string {
  if (d === null || d === undefined || !Number.isFinite(d)) return ''
  return `${d >= 0 ? '+' : '-'}${Math.abs(d).toFixed(3)}`
}
