import { describe, expect, it } from 'vitest'
import { Car } from './car'
import { handlingPreset } from './carParams'

function atRPM(rpm: number, aware: boolean, gear = 5) {
  const car = new Car(handlingPreset('legacy'))
  car.brakeAwareAuto = aware
  car.s.gear = gear
  car.s.vx = rpm * 2 * Math.PI / 60 * car.p.wheelRadius / (car.p.gearRatios[gear]! * car.p.finalDrive)
  car.s.wheelVr = car.s.vx
  return car
}
describe('brake-aware automatic gearbox', () => {
  it('downshifts during hard braking while coasting and legacy laps hold the high gear', () => {
    const braking = atRPM(5500, true), coasting = atRPM(5500, true), legacy = atRPM(5500, false)
    braking.step(0, -1, 1 / 60)
    coasting.step(0, 0, 1 / 60)
    legacy.step(0, -1, 1 / 60)
    expect(braking.s.gear).toBe(4)
    expect(coasting.s.gear).toBe(5)
    expect(legacy.s.gear).toBe(5)
  })
  it('refuses a braking downshift that would land too near the upshift threshold', () => {
    const car = atRPM(6600, true)
    car.step(0, -1, 1 / 60)
    expect(car.s.gear).toBe(5)
  })
  it('does not hunt when releasing the brake immediately after the downshift', () => {
    const car = atRPM(5500, true)
    car.step(0, -1, 1 / 60)
    for (let i = 0; i < 60; i++) {
      car.step(0, 0, 1 / 60)
      expect(car.s.gear).toBe(4)
    }
  })
  it('preserves the acceleration schedule and first-gear speed guard', () => {
    const old = new Car(handlingPreset('legacy')), next = new Car(handlingPreset('legacy'))
    next.brakeAwareAuto = true
    for (let i = 0; i < 60 * 12; i++) {
      old.step(0, 1, 1 / 60); next.step(0, 1, 1 / 60)
      expect(next.s).toEqual(old.s)
    }
    const second = atRPM(4000, true, 1)
    expect(second.s.vx).toBeGreaterThan(second.p.firstGearSpeed)
    second.step(0, -1, 1 / 60)
    expect(second.s.gear).toBe(1)
  })
  it('responds earlier over a short braking zone without skipping gears or over-revving', () => {
    const old = atRPM(6100, false, 6), next = atRPM(6100, true, 6)
    let oldFirst = Infinity, newFirst = Infinity, previous = next.s.gear
    for (let i = 0; i < 60; i++) {
      old.step(0, -1, 1 / 60); next.step(0, -1, 1 / 60)
      if (old.s.gear < 6) oldFirst = Math.min(oldFirst, i / 60)
      if (next.s.gear < 6) newFirst = Math.min(newFirst, i / 60)
      expect(Math.abs(next.s.gear - previous)).toBeLessThanOrEqual(1)
      expect(next.s.engineRpm).toBeLessThan(next.p.redlineRpm)
      previous = next.s.gear
    }
    expect(newFirst).toBeLessThan(oldFirst)
    expect(newFirst).toBeLessThan(0.2)
  })
})

describe('automatic gear selection while coasting', () => {
  it('leaves fifth at 140 km/h without a brake press', () => {
    const coast = atRPM(5300, false, 4), pressure = atRPM(5300, true, 4)
    coast.brakeAwareAuto = 2
    coast.step(0, 0, 1 / 60)
    pressure.step(0, 0, 1 / 60)
    expect(coast.s.gear).toBe(3)
    expect(pressure.s.gear).toBe(4)
  })
  it('works with a light keyboard dab and its release gap', () => {
    const car = atRPM(5500, false)
    car.brakeAwareAuto = 2
    // A short key press never reaches the prior hard-braking threshold.
    for (const pedal of [-0.03, -0.06, -0.09, -0.12, -0.15, -0.05, 0]) {
      car.step(0, pedal, 1 / 60)
    }
    // Continue coasting: drag eventually crosses the downshift RPM without
    // another key press. Old pressure-gated schedule would hold this gear.
    let shifted = false
    for (let i = 0; i < 60 * 4; i++) {
      car.step(0, 0, 1 / 60)
      if (car.s.gear < 5) shifted = true
    }
    expect(shifted).toBe(true)
    expect(car.s.gear).toBeLessThan(5)
  })
  it('selects a sensible lower gear at 100 km/h, using only coasting inputs', () => {
    const car = atRPM(5500, false, 4)
    car.brakeAwareAuto = 2
    car.s.vx = 100 / 3.6
    car.s.wheelVr = car.s.vx
    for (let i = 0; i < 12; i++) car.step(0, 0, 1 / 60)
    expect(car.s.gear + 1).toBeLessThanOrEqual(3)
    expect(car.s.engineRpm).toBeLessThan(car.p.redlineRpm)
  })
  it('keeps acceleration identical and does not immediately reverse a coast downshift', () => {
    const old = new Car(handlingPreset('legacy')), road = new Car(handlingPreset('legacy'))
    road.brakeAwareAuto = 2
    for (let i = 0; i < 60 * 12; i++) {
      old.step(0, 1, 1 / 60); road.step(0, 1, 1 / 60)
      expect(road.s).toEqual(old.s)
    }
    const car = atRPM(5300, false)
    car.brakeAwareAuto = 2
    car.step(0, 0, 1 / 60)
    for (let i = 0; i < 60; i++) {
      car.step(0, 0, 1 / 60)
      expect(car.s.gear).toBe(4)
    }
  })
})
