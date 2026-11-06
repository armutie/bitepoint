import { afterEach, describe, expect, it, vi } from 'vitest'
import { InputState } from './input'
import { Car } from '../core/car'
import { DT } from '../core/sim'

afterEach(() => vi.unstubAllGlobals())

function fixture() {
  const win = new EventTarget()
  class Element extends EventTarget {
    isContentEditable = false
    getBoundingClientRect() { return { left: 0, width: 100 } }
  }
  vi.stubGlobal('window', win)
  vi.stubGlobal('HTMLElement', Element)
  vi.stubGlobal('HTMLTextAreaElement', class extends Element {})
  vi.stubGlobal('HTMLInputElement', class extends Element {})
  vi.stubGlobal('HTMLSelectElement', class extends Element {})
  vi.stubGlobal('HTMLButtonElement', class extends Element {})
  const input = new InputState()
  input.mode = 'keyboard'
  input.attach(new Element() as unknown as HTMLElement)
  const key = (type: string, code: string, repeat = false) => {
    const event = new Event(type, { cancelable: true })
    Object.assign(event, { code, repeat })
    win.dispatchEvent(event)
  }
  return { input, key, win }
}

it('requires a continuous S hold to engage reverse at rest', () => {
  const { input, key } = fixture()
  const car = new Car()
  car.lowSpeedControls = 2
  const tick = () => car.step(0, input.sample(car.s.vx <= 0.5).throttle, DT)

  key('keydown', 'KeyS')
  for (let i = 0; i < 30; i++) tick()
  expect(car.s.vx).toBe(0)
  key('keyup', 'KeyS')
  tick()
  expect(car.s.reverseHold).toBe(0)

  key('keydown', 'KeyS')
  for (let i = 0; i < 31; i++) tick()
  expect(car.s.vx).toBeLessThan(0)
})

describe('held throttle after pause', () => {
  it('keeps the normal ramp when the pedal was below 90 percent at pause', () => {
    const { input, key } = fixture()
    key('keydown', 'KeyW')
    for (let i = 0; i < 25; i++) input.sample()
    expect(input.pedals.throttle).toBeCloseTo(0.875)
    input.release(true)
    input.resume()
    expect(input.sample().throttle).toBeCloseTo(0.035)
  })

  it('includes the 90 percent boundary', () => {
    const { input, key } = fixture()
    key('keydown', 'KeyW')
    for (let i = 0; i < 28; i++) input.sample()
    key('keyup', 'KeyW')
    input.sample() // 98 percent minus the normal 8 percent release step.
    expect(input.pedals.throttle).toBeCloseTo(0.9)
    input.release(true)
    key('keydown', 'KeyW')
    input.resume()
    expect(input.sample().throttle).toBe(1)
  })

  it.each(['KeyW', 'ArrowUp'])('resumes %s held across a pause at full throttle', (code) => {
    const { input, key } = fixture()
    key('keydown', code)
    for (let i = 0; i < 26; i++) input.sample()
    expect(input.pedals.throttle).toBeGreaterThanOrEqual(0.9)
    input.release(true)
    expect(input.pedals.throttle).toBe(0)
    key('keydown', code, true)
    input.resume()
    expect(input.sample().throttle).toBe(1)
  })

  it('ramps normally when throttle was first pressed while paused and discards menu shifts', () => {
    const { input, key } = fixture()
    input.release(true)
    key('keydown', 'KeyW')
    key('keydown', 'KeyE')
    input.resume()
    expect(input.sample().throttle).toBeCloseTo(0.035)
    expect(input.takeShift()).toBe(0)
  })

  it('does not restore a pedal released while paused', () => {
    const { input, key } = fixture()
    key('keydown', 'KeyW')
    for (let i = 0; i < 26; i++) input.sample()
    input.release(true)
    key('keyup', 'KeyW')
    input.resume()
    expect(input.sample().throttle).toBe(0)
    key('keydown', 'KeyW')
    expect(input.sample().throttle).toBeCloseTo(0.035)
  })

  it('clears held throttle on lost focus or a complete session release', () => {
    const { input, key, win } = fixture()
    key('keydown', 'KeyW')
    for (let i = 0; i < 26; i++) input.sample()
    input.release(true)
    win.dispatchEvent(new Event('blur'))
    input.resume()
    expect(input.sample().throttle).toBe(0)
    key('keydown', 'KeyW')
    input.release()
    input.resume()
    expect(input.sample().throttle).toBe(0)
  })

  it('does not force full throttle when the brake is held too', () => {
    const { input, key } = fixture()
    key('keydown', 'KeyW')
    for (let i = 0; i < 26; i++) input.sample()
    key('keydown', 'KeyS')
    input.release(true)
    input.resume()
    expect(input.pedals.throttle).toBe(0)
    expect(input.sample().throttle).toBeCloseTo(0.005)
  })
})
