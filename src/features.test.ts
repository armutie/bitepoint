import { describe, expect, it } from 'vitest'

import { isLegacyTyrePath } from './features'

describe('legacy tyre entry point', () => {
  it('recognises root and subdirectory legacy pages', () => {
    expect(isLegacyTyrePath('/legacy/')).toBe(true)
    expect(isLegacyTyrePath('/bite-point/legacy/index.html')).toBe(true)
    expect(isLegacyTyrePath('/bite-point/')).toBe(false)
  })
})
