export interface RenderQuality {
  /** Device pixels rendered for each CSS pixel. */
  pixelRatio: number
  shadowMapSize: number
  decorativeScenery: boolean
  postProcessing: boolean
}

/**
 * Rendering policy in one place, so "Performance" is a coherent mode rather
 * than a collection of unrelated switches.
 *
 * Quality mode deliberately caps at one device pixel per CSS pixel. A racing
 * game gains very little from silently turning a scaled 1080p display into a
 * 4K render target, while full-screen bloom and camera passes pay for every
 * one of those pixels. Performance mode goes a step lower; the browser scales
 * the canvas back to its CSS size while the HUD remains native-resolution DOM.
 */
export function renderQuality(performanceMode: boolean, deviceRatio: number): RenderQuality {
  const safeRatio = Number.isFinite(deviceRatio) ? Math.max(deviceRatio, 0.5) : 1
  return performanceMode
    ? {
        pixelRatio: Math.min(safeRatio, 0.75),
        shadowMapSize: 512,
        decorativeScenery: false,
        postProcessing: false,
      }
    : {
        pixelRatio: Math.min(safeRatio, 1),
        shadowMapSize: 1024,
        decorativeScenery: true,
        postProcessing: true,
      }
}
