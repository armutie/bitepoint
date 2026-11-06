import { describe, expect, it } from 'vitest'
import { Car, CURRENT_LOW_SPEED_CONTROLS, reverseSelected, speedOf } from './car'
import { handlingPreset } from './carParams'
import { DT } from './sim'

function carAt(vx = 0): Car {
  const car = new Car(handlingPreset('legacy'))
  car.lowSpeedControls = CURRENT_LOW_SPEED_CONTROLS
  car.s.vx = car.s.wheelVr = vx
  return car
}

function drive(car: Car, ticks: number, pedal: number, steer = 0): void {
  for (let tick = 0; tick < ticks; tick++) car.step(steer, pedal, DT)
}

describe('low-speed controls', () => {
  it('settles residual yaw at rest while preserving tyre response in a moving slide', () => {
    const parked = carAt()
    parked.s.r = 0.6
    drive(parked, 300, 0)
    expect(speedOf(parked.s)).toBe(0)
    expect(parked.s.r).toBe(0)
    expect(Math.abs(parked.s.yaw)).toBeLessThan(0.05)

    const sliding = carAt(12)
    const original = carAt(12)
    original.lowSpeedControls = false
    sliding.s.vy = original.s.vy = 4
    sliding.s.r = original.s.r = 0.6
    drive(sliding, 30, 1, -0.6)
    drive(original, 30, 1, -0.6)
    const { reverseHold: _hold, ...state } = sliding.s
    expect(state).toEqual(original.s)
  })

  it.each([-0.35, 0.35])('settles sideways motion of %s m/s and holds position under braking', lateralSpeed => {
    const car = carAt()
    car.manual = true
    car.s.vy = lateralSpeed
    car.s.r = 0.35
    drive(car, 30, -1)
    expect(speedOf(car.s)).toBe(0)
    expect(car.s.r).toBe(0)
    expect(Math.hypot(car.s.x, car.s.y)).toBeLessThan(0.05)
    const { x, y, yaw } = car.s
    drive(car, 60, -1)
    expect(car.s).toMatchObject({ x, y, yaw })
  })

  it('keeps the previous braking physics when replaying a version 2 lap', () => {
    const car = carAt()
    car.lowSpeedControls = 2
    car.s.vy = 0.35
    drive(car, 30, -1)
    expect(car.s.vy).toBe(0.35)
  })

  it('preserves braking in a faster sideways slide', () => {
    const car = carAt()
    const previous = carAt()
    previous.lowSpeedControls = 2
    car.s.vy = previous.s.vy = 4
    car.s.r = previous.s.r = 0.6
    drive(car, 1, -1)
    drive(previous, 1, -1)
    expect(car.s).toEqual(previous.s)
  })

  it('requires more than half a second of continuous braking at rest in automatic', () => {
    const car = carAt()
    drive(car, 30, -1)
    expect(car.s.vx).toBe(0)
    expect(reverseSelected(car.s)).toBe(false)
    drive(car, 1, 0)
    drive(car, 30, -1)
    expect(car.s.vx).toBe(0)
    drive(car, 1, -1)
    expect(car.s.vx).toBeLessThan(0)
    expect(reverseSelected(car.s)).toBe(true)
  })

  it('coasts in R and accelerates backwards when S is pressed again', () => {
    const car = carAt()
    drive(car, 65, -1)
    expect(reverseSelected(car.s)).toBe(true)
    const drivenSpeed = car.s.vx
    drive(car, 15, 0)
    expect(reverseSelected(car.s)).toBe(true)
    expect(car.s.vx).toBeGreaterThan(drivenSpeed)
    const coastingSpeed = car.s.vx
    drive(car, 10, -1)
    expect(car.s.vx).toBeLessThan(coastingSpeed)
    drive(car, 1, 1)
    expect(reverseSelected(car.s)).toBe(false)
  })

  it('retains the original reverse release rule for old lap replays', () => {
    const car = carAt()
    car.lowSpeedControls = true
    drive(car, 31, -1)
    expect(reverseSelected(car.s)).toBe(true)
    drive(car, 1, 0)
    expect(reverseSelected(car.s)).toBe(false)
  })

  it('counts the hold after braking to a stop and leaves manual in forward gear', () => {
    const auto = carAt(10)
    while (auto.s.vx > 0) drive(auto, 1, -1)
    expect(auto.s.reverseHold).toBe(0)
    drive(auto, 30, -1)
    expect(auto.s.vx).toBe(0)
    drive(auto, 1, -1)
    expect(auto.s.vx).toBeLessThan(0)

    const manual = carAt()
    manual.manual = true
    drive(manual, 90, -1)
    expect(manual.s.vx).toBe(0)
    expect(manual.s.gear).toBe(0)
  })

  it('backs toward the turned wheels, swinging the nose the other way', () => {
    const right = carAt()
    const left = carAt()
    drive(right, 120, -1, -0.4)
    drive(left, 120, -1, 0.4)
    expect(right.s.x).toBeLessThan(0)
    expect(right.s.y).toBeLessThan(0)
    expect(right.s.yaw).toBeGreaterThan(0)
    expect(left.s.y).toBeCloseTo(-right.s.y, 8)
    expect(left.s.yaw).toBeCloseTo(-right.s.yaw, 8)
    drive(right, 120, 1)
    expect(right.s.vx).toBeGreaterThan(0)
  })
})
