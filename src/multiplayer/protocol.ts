import type { CarState } from '../core/car'
import type { PresetName } from '../core/carParams'
import type { RaceAction, RacePhase } from '../core/race'
import { CURRENT_PHYSICS_RULESET } from '../shared/ruleset'

export const PROTOCOL = `bitepoint-mp-4:${CURRENT_PHYSICS_RULESET}`
export const TRACKS = ['power_8', 'silverstone-gp', 'power_4', 'balanced_8', 'power_3'] as const
export type Slot = 0 | 1
export interface RoomConfig {
  protocol: string; trackId: string; preset: PresetName; laps: number
  contact: boolean; manual: boolean; abs: boolean
}
export interface InputFrame extends RaceAction { seq: number; shift: number; tcLevel: number }
export const IDLE: InputFrame = { seq: 0, steer: 0, throttle: 0, shift: 0, tcLevel: 2 }
export interface DriverScore {
  laps: number; lapTime: number; last: number | null; best: number | null
  valid: boolean; armed: boolean; position: number; finish: number | null
}
export interface Snapshot {
  tick: number; phase: RacePhase; countdown: number; time: number
  cars: CarState[]; ack: number[]; actions: InputFrame[]; scores: DriverScore[]
}
export interface Ticket {
  code: string; token: string; slot: Slot; config: RoomConfig
}
export interface LobbyState {
  names: [string, string | null]; config: RoomConfig
}
export interface Signal {
  kind: 'offer' | 'answer' | 'candidate'; data: unknown
}
/**
 * The settings in one fixed key order, for hashing. Supabase Realtime does not
 * preserve key order, so the guest's copy of the host's settings can come back
 * reordered; hashed as received, two identical rooms would fingerprint
 * differently and refuse each other.
 */
export function canonicalConfig(c: RoomConfig): RoomConfig {
  return { protocol: c.protocol, trackId: c.trackId, preset: c.preset, laps: c.laps,
    contact: c.contact, manual: c.manual, abs: c.abs }
}
export function validConfig(v: unknown): v is RoomConfig {
  if (!v || typeof v !== 'object') return false
  const c = v as RoomConfig
  return c.protocol === PROTOCOL && (TRACKS as readonly string[]).includes(c.trackId)
    && ['legacy', 'classic'].includes(c.preset) && Number.isInteger(c.laps) && c.laps >= 1 && c.laps <= 10
    && typeof c.contact === 'boolean' && typeof c.manual === 'boolean' && typeof c.abs === 'boolean'
}
export function validInput(v: unknown): v is InputFrame {
  if (!v || typeof v !== 'object') return false
  const f = v as InputFrame
  return Number.isSafeInteger(f.seq) && f.seq > 0 && f.seq < 1e9
    && Number.isFinite(f.steer) && Math.abs(f.steer) <= 1
    && Number.isFinite(f.throttle) && Math.abs(f.throttle) <= 1
    && [-1, 0, 1].includes(f.shift) && Number.isInteger(f.tcLevel) && f.tcLevel >= 0 && f.tcLevel <= 5
}
const STATE_FIELDS: readonly (keyof CarState)[] = ['x','y','yaw','vx','vy','r','steer','wheelVr','slipF','slipR','gear','shiftTimer','engineRpm']
export function validSnapshot(v: unknown): v is Snapshot {
  if (!v || typeof v !== 'object') return false
  const s = v as Snapshot
  return Number.isSafeInteger(s.tick) && s.tick >= 0 && Number.isFinite(s.time)
    && ['waiting','countdown','racing','finished'].includes(s.phase)
    && Number.isInteger(s.countdown) && s.countdown >= 0
    && Array.isArray(s.cars) && s.cars.length === 2
    && s.cars.every(c => c && STATE_FIELDS.every(k => Number.isFinite(c[k])) && (c.reverseHold === undefined || (Number.isFinite(c.reverseHold) && c.reverseHold >= 0 && c.reverseHold <= 1)) && Math.abs(c.x) < 1e7 && Math.abs(c.y) < 1e7)
    && Array.isArray(s.ack) && s.ack.length === 2 && s.ack.every(n => Number.isSafeInteger(n) && n >= 0)
    && Array.isArray(s.actions) && s.actions.length === 2
    && s.actions.every(a => a && Number.isFinite(a.steer) && Number.isFinite(a.throttle) && Number.isFinite(a.tcLevel))
    && Array.isArray(s.scores) && s.scores.length === 2
    && s.scores.every(c => c && Number.isFinite(c.laps) && Number.isFinite(c.lapTime) && Number.isFinite(c.position))
}
