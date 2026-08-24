import { describe, expect, it } from 'vitest'

import { isLegacyTyrePath, legacyTyreModeForLocation } from './features'

describe('legacy tyre entry point', () => {
  it('recognises root and subdirectory legacy pages', () => {
    expect(isLegacyTyrePath('/legacy/')).toBe(true)
    expect(isLegacyTyrePath('/bite-point/legacy/index.html')).toBe(true)
    expect(isLegacyTyrePath('/bite-point/')).toBe(false)
  })

  it('stays off in a worker with no browser location', () => {
    expect(legacyTyreModeForLocation(undefined)).toBe(false)
  })
})
