import { describe, expect, it } from 'vitest'

import { renderQuality } from './quality'

describe('render quality', () => {
  it('does not oversample high-density displays in quality mode', () => {
    expect(renderQuality(false, 2).pixelRatio).toBe(1)
  })

  it('uses a genuinely cheaper performance profile', () => {
    expect(renderQuality(true, 2)).toEqual({
      pixelRatio: 0.75,
      shadowMapSize: 512,
      decorativeScenery: false,
      postProcessing: false,
    })
  })

  it('does not increase resolution on an already low-density display', () => {
    expect(renderQuality(false, 0.6).pixelRatio).toBe(0.6)
    expect(renderQuality(true, 0.6).pixelRatio).toBe(0.6)
  })
})
