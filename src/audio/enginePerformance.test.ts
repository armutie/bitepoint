import { describe, expect, it } from 'vitest'
import { EnginePerformance, engineMix, POWER_RPM } from './engineMix'
import type { AudioInput } from './mix'
import { Car } from '../core/car'

const state: AudioInput = {
  speed: 35, vx: 35, wheelVr: 35, slipF: 0, slipR: 0,
  onKerb: false, onGrass: false, rpm: 7600, redlineRpm: 8200,
  idleRpm: 1200, gear: 1, throttle: 1, shiftTimer: 0,
}
describe('gear-aware engine articulation', () => {
  it('retains audible body and traverses an upshift instead of snapping or muting', () => {
    const p = new EnginePerformance()
    const pre = p.update(state, 0)
    const next = { ...state, gear: 2, rpm: 5800, shiftTimer: 0.15 }
    const start = p.update(next, 0.016)
    const middle = p.update(next, 0.08)
    expect(start.event).toBe('up')
    expect(start.rpm).toBeCloseTo(pre.rpm)
    expect(middle.rpm).toBeGreaterThan(5800)
    expect(middle.rpm).toBeLessThan(7600)
    expect(middle.level).toBeGreaterThan(pre.level * 0.55)
    expect(p.update({ ...next, shiftTimer: 0 }, 0.22).rpm).toBe(5800)
  })
  it('makes a braking downshift rise and bark, then settles at real RPM', () => {
    const p = new EnginePerformance()
    p.update({ ...state, gear: 3, rpm: 4550, throttle: -1 }, 0)
    const next = { ...state, gear: 2, rpm: 5950, throttle: -1, shiftTimer: 0.15 }
    expect(p.update(next, 0.016).event).toBe('down')
    const peak = p.update(next, 0.061)
    expect(peak.blip).toBeGreaterThan(0.95)
    expect(peak.rpm).toBeGreaterThan(5950)
    expect(peak.level).toBeGreaterThan(engineMix(next).level * 1.5)
    const tail = p.update({ ...next, shiftTimer: 0, rpm: 5600 }, 0.14)
    expect(tail.blip).toBeLessThan(0.1)
    expect(tail.rpm).toBeLessThan(peak.rpm)
    expect(p.update({ ...next, shiftTimer: 0 }, 0.18).rpm).toBe(5950)
  })
  it('triggers once per gear change, even with closely spaced automatic shifts', () => {
    const p = new EnginePerformance(); const events: string[] = []
    for (let i = 0; i < 60; i++) {
      const event = p.update({ ...state, gear: Math.min(4, Math.floor(i / 12)) }, i / 60).event
      if (event) events.push(event)
    }
    expect(events).toEqual(['up', 'up', 'up', 'up'])
  })
  it('does not invent a downshift after pause, restart, or background suspension', () => {
    const p = new EnginePerformance()
    p.update({ ...state, gear: 5 }, 0)
    p.reset()
    expect(p.update({ ...state, gear: 0 }, 0.1).event).toBeNull()
    expect(p.update({ ...state, gear: 5 }, 2).event).toBeNull()
    expect(p.update({ ...state, gear: 0 }, 0).event).toBeNull()
  })
  it('varies timbre slightly at steady RPM without a pitch wobble or random pops', () => {
    const p = new EnginePerformance(); let lo = Infinity, hi = 0
    for (let i = 0; i < 60 * 30; i++) {
      const m = p.update(state, i / 60)
      expect(m.event).toBeNull()
      expect(m.powerRate).toBeCloseTo(state.rpm / POWER_RPM)
      lo = Math.min(lo, m.cutoff); hi = Math.max(hi, m.cutoff)
    }
    expect(hi / lo).toBeGreaterThan(1.01)
    expect(hi / lo).toBeLessThan(1.08)
  })
  it('distinguishes braking weight from coasting without changing pitch', () => {
    const lift = engineMix({ ...state, throttle: 0 })
    const brake = engineMix({ ...state, throttle: -1 })
    expect(brake.level).toBeGreaterThan(lift.level)
    expect(brake.level).toBeLessThan(lift.level * 1.2)
    expect(brake.powerRate).toBe(lift.powerRate)
  })
  it('follows actual automatic gearbox changes during a launch and hard braking', () => {
    const car = new Car(), performance = new EnginePerformance()
    const events: string[] = []
    for (let i = 0; i < 60 * 23; i++) {
      const throttle = i < 60 * 13 ? 1 : i < 60 * 15 ? 0 : i < 60 * 21 ? -1 : 0
      car.step(0, throttle, 1 / 60)
      const frame = performance.update({ ...state, rpm: car.s.engineRpm,
        gear: car.s.gear, throttle, shiftTimer: car.s.shiftTimer }, i / 60)
      if (frame.event === 'up' || frame.event === 'down') events.push(frame.event)
      expect(Number.isFinite(frame.level)).toBe(true)
      expect(frame.powerRate).toBeGreaterThan(0)
    }
    expect(events.filter(e => e === 'up').length).toBeGreaterThanOrEqual(3)
    expect(events.filter(e => e === 'down').length).toBeGreaterThanOrEqual(3)
  })
})
