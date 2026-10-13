import type { AudioInput } from './mix'

export const POWER_RPM = 5570
export const COAST_RPM = 5581
export const ENGINE_LEVEL = 0.36
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v))
const ease = (v: number) => { const x = clamp(v); return x * x * (3 - 2 * x) }
type Gesture = { rpm?: number; blip?: number; variation?: number; recovering?: boolean }

export function engineMix(input: AudioInput, gesture: Gesture = {}) {
  const rpm = clamp(gesture.rpm ?? input.rpm, input.idleRpm ?? 1200, 16000)
  const rev = clamp(rpm / Math.max(1200, input.redlineRpm))
  const pedal = clamp(input.throttle)
  const brake = clamp(-input.throttle)
  const blip = gesture.blip ?? 0
  const load = Math.max(pedal, blip * 0.64)
  const cut = input.shiftTimer > 0 && blip === 0
  const variation = gesture.variation ?? 0
  // The engine continues spinning during the torque interruption. Unload the
  // power layer, but retain an audible coast body instead of punching a hole.
  const power = clamp((cut ? 0.19 : 0.16 + 0.82 * load) + variation * 0.024, 0.03, 0.99)
  const weight = 0.48 + 0.52 * load + brake * 0.065 * (1 - load)
  return {
    powerRate: rpm / POWER_RPM,
    coastRate: rpm / COAST_RPM,
    powerGain: Math.sqrt(power),
    coastGain: Math.sqrt(1 - power),
    level: ENGINE_LEVEL * weight * (0.72 + 0.28 * rev)
      * (cut ? 0.68 : 1) * (1 + variation * 0.018),
    cutoff: (700 + rev * 1050 + load * 950 + brake * 130) * (1 + variation * 0.035),
    pitchTau: gesture.recovering ? 0.012 : 0.025,
  }
}

/** Audio-only shift articulation. Never writes to vehicle state or gearbox timing. */
export class EnginePerformance {
  private gear: number | undefined
  private lastTime = -1
  private lastRpm = 1200
  private lastPedal = 0
  private shiftAt = -10
  private direction: 'up' | 'down' | null = null
  private fromRpm = 1200
  private liftAt = -10
  private randomState = 0x143abcdef
  private colour = 0
  private colourTarget = 0
  private nextColour = 0

  reset(): void {
    this.gear = undefined
    this.lastTime = -1
    this.direction = null
    this.shiftAt = -10
    this.lastPedal = 0
    this.colour = this.colourTarget = 0
    this.nextColour = 0
  }

  private random(): number {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0
    return this.randomState / 4294967296
  }

  update(input: AudioInput, time: number) {
    // Resuming, restarting, or an inactive tab must not manufacture a shift.
    if (this.lastTime < 0 || time - this.lastTime > 0.35 || time < this.lastTime) {
      this.reset()
      this.gear = input.gear
      this.lastRpm = Math.max(input.idleRpm ?? 1200, input.rpm)
      this.lastPedal = input.throttle
      this.lastTime = time
    }
    const dt = clamp(time - this.lastTime, 0, 0.1)
    let event: 'up' | 'down' | 'lift' | null = null
    if (input.gear !== undefined && this.gear !== undefined && input.gear !== this.gear) {
      this.direction = input.gear > this.gear ? 'up' : 'down'
      this.shiftAt = time
      this.fromRpm = this.lastRpm
      event = this.direction
    } else if (this.lastPedal > 0.55 && input.throttle <= 0 && input.rpm > 4300
      && time - this.liftAt > 1.5 && time - this.shiftAt > 0.3) {
      // One occasional exhaust catch on a meaningful lift, not a repeating
      // crackle machine while coasting, braking or holding a constant pedal.
      this.liftAt = time
      if (this.random() < 0.55) event = 'lift'
    }
    this.gear = input.gear
    if (time >= this.nextColour) {
      this.colourTarget = this.random() * 2 - 1
      this.nextColour = time + 0.9 + this.random() * 1.9
    }
    this.colour += (this.colourTarget - this.colour) * (1 - Math.exp(-dt / 0.6))

    const age = time - this.shiftAt
    const duration = this.direction === 'down' ? 0.155 : 0.18
    const active = this.direction !== null && age < duration
    let rpm = Math.max(input.idleRpm ?? 1200, input.rpm)
    let blip = 0
    if (active) {
      const target = rpm
      rpm = this.fromRpm + (target - this.fromRpm) * ease(age / (this.direction === 'down' ? 0.045 : 0.13))
      if (this.direction === 'down') {
        // Reference braking pulses rise sharply and immediately lose energy.
        // An asymmetric attack/release leaves clear space between downshifts.
        blip = ease(age / 0.045) * Math.exp(-Math.max(0, age - 0.045) / 0.028)
          * ease((duration - age) / 0.025)
        // Modest unloaded flare; settle at actual RPM by engagement. This is
        // acoustic rev matching, not extra torque or a physics RPM change.
        rpm = Math.min(input.redlineRpm * 1.03, rpm + Math.min(180, target * 0.025) * blip)
      }
    }
    this.lastTime = time
    this.lastRpm = rpm
    this.lastPedal = input.throttle
    return {
      ...engineMix(input, { rpm, blip, variation: this.colour, recovering: active }),
      event, rpm, blip,
      // Per-event variation only affects the short sample, never engine pitch.
      eventColour: event ? this.random() : 0,
    }
  }
}
