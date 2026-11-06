import { afterEach, describe, expect, it, vi } from 'vitest'
import { finishBuild, runBuild } from './buildScheduler'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('cooperative scene building', () => {
  it('produces the identical result while letting browser tasks run between slices', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('scheduler', { yield: () => new Promise<void>(resolve => setTimeout(resolve, 0)) })
    let clock = 0, pieces = 0, inputHandled = false
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    function* generate(): Generator<void, number[]> {
      const output: number[] = []
      for (let i = 0; i < 5; i++) { clock += 7; pieces++; output.push(i * i); yield }
      return output
    }
    setTimeout(() => { inputHandled = true }, 0)
    const pending = runBuild(generate(), () => true)
    expect(pieces).toBe(1)
    await vi.runAllTimersAsync()
    expect(inputHandled).toBe(true)
    const actual = await pending
    expect(actual).toEqual(finishBuild(generate()))
  })

  it('cancels a superseded selection and runs its resource cleanup', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('scheduler', { yield: () => new Promise<void>(resolve => setTimeout(resolve, 0)) })
    let current = true, clock = 0, disposed = false, pieces = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    function* generate(): Generator<void, string> {
      try { while (true) { pieces++; clock += 7; yield } }
      finally { disposed = true }
    }
    setTimeout(() => { current = false }, 0)
    const pending = runBuild(generate(), () => current)
    await vi.runAllTimersAsync()
    expect(await pending).toBeNull()
    expect(pieces).toBe(1)
    expect(disposed).toBe(true)
  })

  it('does not begin work for an already cancelled request', async () => {
    let started = false
    function* generate(): Generator<void, number> { started = true; return 1 }
    expect(await runBuild(generate(), () => false)).toBeNull()
    expect(started).toBe(false)
  })
})
