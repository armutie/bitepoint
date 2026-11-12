/**
 * Dissolve from one circuit to the next behind the menu.
 *
 * Swapping circuits used to be a cut, and because the first frames of a new
 * circuit could stall, the cut read as the background blinking out. This holds
 * the last frame of the old circuit on a 2D canvas laid over the 3D one, lets
 * the swap happen underneath it, and fades it away once the new circuit is
 * drawing.
 *
 * The copy has to be taken in the same task as the frame was drawn: the WebGL
 * canvas is not created with `preserveDrawingBuffer`, so once the browser has
 * composited, its pixels are gone. That is why `hold` waits for the loop to
 * call `afterFrame` rather than copying straight away.
 */
export class Crossfade {
  private readonly overlay: HTMLCanvasElement
  private pending: ((held: boolean) => void) | null = null
  private holding = false

  constructor(private readonly source: HTMLCanvasElement, fadeMs = 450) {
    this.overlay = document.createElement('canvas')
    this.overlay.className = 'viewport-crossfade'
    this.overlay.setAttribute('aria-hidden', 'true')
    this.overlay.style.setProperty('--crossfade-ms', `${fadeMs}ms`)
    source.after(this.overlay)
  }

  /** Call straight after the loop draws a frame. */
  afterFrame(): void {
    const resolve = this.pending
    if (!resolve) return
    this.pending = null
    const { width, height } = this.source
    if (width === 0 || height === 0) { resolve(false); return }
    if (this.overlay.width !== width) this.overlay.width = width
    if (this.overlay.height !== height) this.overlay.height = height
    const ctx = this.overlay.getContext('2d')
    if (!ctx) { resolve(false); return }
    ctx.drawImage(this.source, 0, 0)
    this.overlay.classList.remove('is-fading')
    this.overlay.classList.add('is-held')
    this.holding = true
    resolve(true)
  }

  /**
   * Freeze the current picture. Resolves once it is held — or after `timeoutMs`
   * without, when no frame is being drawn (a hidden tab), so a circuit change
   * is never stuck waiting for a picture that is not coming.
   */
  hold(timeoutMs = 150): Promise<boolean> {
    this.pending?.(false)
    return new Promise((resolve) => {
      this.pending = resolve
      setTimeout(() => {
        if (this.pending !== resolve) return
        this.pending = null
        resolve(false)
      }, timeoutMs)
    })
  }

  /** Fade the held picture out, two frames from now so the new circuit is up. */
  release(): void {
    if (!this.holding) return
    this.holding = false
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this.overlay.classList.add('is-fading')
      this.overlay.classList.remove('is-held')
    }))
  }
}
