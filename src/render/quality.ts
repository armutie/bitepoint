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

/** Avoid a large window silently multiplying the scene and full-screen effects workload. HUD stays native. */
export function viewportPixelRatio(width: number, height: number, ceiling: number): number {
  const pixels=Math.max(1,width)*Math.max(1,height),budget=1_250_000
  return Math.min(ceiling,Math.sqrt(budget/pixels))
}

/** Frame-time hysteresis: react to sustained overload, ignore isolated stalls, recover slowly. */
export class AdaptivePixelRatio {
  value: number
  private slow=0
  private fast=0
  private cooldown=2
  constructor(readonly ceiling: number){this.value=ceiling}
  observe(dt: number): number | null {
    if(!Number.isFinite(dt)||dt<0.003||dt>0.10)return null
    this.cooldown=Math.max(0,this.cooldown-dt)
    if(dt>0.021){this.slow+=dt;this.fast=0}else if(dt<0.018){this.fast+=dt;this.slow=Math.max(0,this.slow-dt*2)}else{this.slow=Math.max(0,this.slow-dt);this.fast=0}
    const floor=this.ceiling*0.65
    if(this.cooldown===0&&this.slow>0.8&&this.value>floor+0.001){this.value=Math.max(floor,this.value-this.ceiling*0.10);this.slow=0;this.cooldown=3;return this.value}
    if(this.cooldown===0&&this.fast>8&&this.value<this.ceiling){this.value=Math.min(this.ceiling,this.value+this.ceiling*0.05);this.fast=0;this.cooldown=4;return this.value}
    return null
  }
}
