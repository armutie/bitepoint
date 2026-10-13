import { afterEach, describe, expect, it, vi } from 'vitest'
import { DT } from '../core/sim'
import { formatTime } from '../storage/records'
import { GameLoop } from './loop'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixture() {
  let nowMs = 0
  let nextFrame: FrameRequestCallback = () => {}
  let ticks = 0
  let displayed = 0
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextFrame = callback
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const loop = new GameLoop(() => { ticks++ }, (alpha) => {
    displayed = ticks * DT + alpha * DT
  })
  loop.start()
  return {
    loop,
    at(ms: number) { nowMs = ms },
    frame(ms: number) { nowMs = ms; nextFrame(ms) },
    get ticks() { return ticks },
    get displayed() { return displayed },
    get snapshot() { return ticks * DT + loop.simulationRemainder },
  }
}

describe('paused live clock', () => {
  it('captures the actual pause event between ticks, instead of the last frame or tick', () => {
    const f = fixture()
    f.frame(20)
    expect(f.ticks).toBe(1)
    expect(f.displayed).toBeCloseTo(0.020, 12)
    f.at(25)
    f.loop.pauseSimulation()
    expect(f.ticks).toBe(1)
    expect(f.snapshot).toBeCloseTo(0.025, 12)
    expect(formatTime(f.snapshot)).toBe('0:00.025')
    f.frame(5000)
    expect(f.ticks).toBe(1)
    expect(f.snapshot).toBeCloseTo(0.025, 12)
    f.loop.pauseSimulation() // repeated calls cannot add paused time
    expect(f.snapshot).toBeCloseTo(0.025, 12)
    f.at(8000)
    f.loop.resumeSimulation()
    f.frame(8005)
    expect(f.displayed).toBeCloseTo(0.030, 12)
    f.frame(8010)
    expect(f.ticks).toBe(2)
    expect(f.displayed).toBeCloseTo(0.035, 12)
  })

  it('distinguishes pause events one millisecond apart at the same physics tick', () => {
    const f = fixture()
    f.frame(20)
    f.at(25)
    f.loop.pauseSimulation()
    const first = f.snapshot
    f.loop.resumeSimulation()
    f.at(26)
    f.loop.pauseSimulation()
    expect(f.ticks).toBe(1)
    expect(f.snapshot - first).toBeCloseTo(0.001, 12)
    expect(formatTime(f.snapshot)).toBe('0:00.026')
  })

  it('finishes a due physics tick before freezing, and resets the fraction for a new lap', () => {
    const f = fixture()
    f.frame(20)
    f.at(35)
    f.loop.pauseSimulation()
    expect(f.ticks).toBe(2)
    expect(f.snapshot).toBeCloseTo(0.035, 12)
    f.at(1000)
    f.loop.resumeSimulation(true)
    expect(f.loop.simulationRemainder).toBe(0)
    f.frame(1001)
    expect(f.loop.simulationRemainder).toBeCloseTo(0.001, 12)
  })

  it('retains a paused fraction when the browser animation loop stops and restarts', () => {
    const f = fixture()
    f.frame(20)
    f.at(25)
    f.loop.pauseSimulation()
    f.loop.stop()
    f.at(10000)
    f.loop.start()
    f.frame(15000)
    expect(f.snapshot).toBeCloseTo(0.025, 12)
    expect(f.ticks).toBe(1)
    f.loop.resumeSimulation()
    f.frame(15001)
    expect(f.displayed).toBeCloseTo(0.026, 12)
  })
})
