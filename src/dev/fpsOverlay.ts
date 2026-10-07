/**
 * The `?fps` frame-health strip. See `SHOW_FPS_OVERLAY` in features.ts.
 *
 * Two numbers and a bar chart, chosen to answer one question: when the game
 * feels rough, is the MAIN THREAD late (our code — the bars would be tall AND
 * `js` high) or is the frame late with the main thread idle (compositor, GPU,
 * driver, another process — tall bars, `js` low)? Headless profiling already
 * says our code runs in under 5 ms; this shows what the player's real session
 * is doing with that headroom.
 *
 * Green bars fit a 60 Hz budget, amber missed one vsync, red missed two or
 * more. `now` is the latest frame gap; `worst` is the worst gap of the last
 * two seconds, which is the number that correlates with "it just hitched".
 */
const BARS = 120
const W = 2
const HEIGHT = 48

export interface FpsOverlay {
  /** Call once per rendered frame with the wall gap and main-thread time, ms. */
  frame(gapMs: number, jsMs: number): void
}

export function buildFpsOverlay(parent: HTMLElement): FpsOverlay {
  const canvas = document.createElement('canvas')
  canvas.width = BARS * W
  canvas.height = HEIGHT
  canvas.style.cssText =
    'position:absolute;left:10px;bottom:10px;z-index:40;pointer-events:none;' +
    'background:rgba(10,12,16,0.72);border-radius:3px'
  const label = document.createElement('div')
  label.style.cssText =
    'position:absolute;left:10px;bottom:62px;z-index:40;pointer-events:none;' +
    'font:11px ui-monospace,monospace;color:#cfd6e0;background:rgba(10,12,16,0.72);' +
    'padding:2px 6px;border-radius:3px'
  parent.append(canvas, label)
  const ctx = canvas.getContext('2d')!

  const gaps = new Float32Array(BARS)
  const jss = new Float32Array(BARS)
  let head = 0
  let sinceText = 0

  return {
    frame(gapMs: number, jsMs: number): void {
      gaps[head] = gapMs
      jss[head] = jsMs
      head = (head + 1) % BARS

      ctx.clearRect(0, 0, canvas.width, HEIGHT)
      for (let i = 0; i < BARS; i++) {
        const g = gaps[(head + i) % BARS]!
        if (g <= 0) continue
        // 33 ms of gap fills half the strip; the scale clips rather than pans
        // so one 200 ms spike does not flatten the history around it.
        const h = Math.min((g / 66) * HEIGHT, HEIGHT)
        ctx.fillStyle = g <= 17.5 ? '#3f9d5a' : g <= 34 ? '#d8a23a' : '#c74343'
        ctx.fillRect(i * W, HEIGHT - h, W - 0.5, h)
      }

      // Text at ~4 Hz: readable, and not itself a per-frame layout cost.
      sinceText += gapMs
      if (sinceText >= 250) {
        sinceText = 0
        let worst = 0
        let worstJs = 0
        let sum = 0
        let n = 0
        for (let i = 0; i < BARS; i++) {
          const g = gaps[i]!
          if (g <= 0) continue
          worst = Math.max(worst, g)
          sum += g
          n++
          // The js of the frame FOLLOWING a long gap is the interesting one —
          // but the simple window-max is enough to answer the only question
          // this exists for: do spikes coincide with our code being busy?
          worstJs = Math.max(worstJs, jss[i]!)
        }
        const fps = n > 0 ? 1000 / (sum / n) : 0
        label.textContent =
          `${fps.toFixed(0)} fps · now ${gapMs.toFixed(1)} ms` +
          ` · worst ${worst.toFixed(0)} ms · js now ${jsMs.toFixed(1)} / worst ${worstJs.toFixed(1)} ms`
      }
    },
  }
}
