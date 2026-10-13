import { describe, it, expect } from 'vitest'
import { engineMix, ENGINE_LEVEL } from './engineMix'
import type { AudioInput } from './mix'

const input: AudioInput = {
  speed: 40, vx: 40, wheelVr: 40, slipF: 0, slipR: 0,
  onKerb: false, onGrass: false, rpm: 6000, redlineRpm: 8200,
  throttle: 1, shiftTimer: 0,
}

describe('sample engine driving cues', () => {
  it('follows RPM even when speed, pedal and selected gearing differ', () => {
    const sameRPM = engineMix({ ...input, speed: 2, throttle: 0 })
    expect(sameRPM.powerRate).toBe(engineMix(input).powerRate)
    expect(engineMix({ ...input, rpm: 3000 }).powerRate).toBe(engineMix(input).powerRate / 2)
  })
  it('changes texture and brightness on lift without an invented pitch drop', () => {
    const power = engineMix(input), lift = engineMix({ ...input, throttle: 0 })
    expect(lift.coastGain).toBeGreaterThan(power.coastGain)
    expect(lift.level).toBeLessThan(power.level * 0.6)
    expect(lift.cutoff).toBeLessThan(power.cutoff * 0.75)
    expect(lift.powerRate).toBe(power.powerRate)
  })
  it('makes the real torque cut audible, then follows the lower post-shift RPM', () => {
    const pre = engineMix(input), cut = engineMix({ ...input, shiftTimer: 0.1 })
    const post = engineMix({ ...input, rpm: 4500 })
    expect(cut.level).toBeLessThan(pre.level * 0.8)
    expect(cut.powerGain).toBeLessThan(pre.powerGain * 0.6)
    expect(post.powerRate).toBeCloseTo(pre.powerRate * 0.75)
    expect(post.level).toBeGreaterThan(cut.level * 1.2)
  })
  it('preserves blend energy and bounded level through the entire pedal range', () => {
    for (let throttle = -1; throttle <= 1.2; throttle += 0.01) {
      const m = engineMix({ ...input, throttle })
      expect(m.powerGain ** 2 + m.coastGain ** 2).toBeCloseTo(1, 10)
      expect(m.level).toBeGreaterThan(0)
      expect(m.level).toBeLessThanOrEqual(ENGINE_LEVEL)
    }
  })
  it('keeps high-rev brightness restrained while still communicating increasing RPM', () => {
    const top = engineMix({ ...input, rpm: 8200 })
    expect(top.cutoff).toBeLessThan(3000)
    expect(top.powerRate).toBeGreaterThan(engineMix(input).powerRate)
    expect(engineMix({ ...input, rpm: 0 }).powerRate).toBeGreaterThan(0)
  })
})
