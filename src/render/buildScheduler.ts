/** Identical generation for synchronous tools and cooperative browser loading. */
export function finishBuild<T>(steps: Generator<void, T>): T {
  let step = steps.next()
  while (!step.done) step = steps.next()
  return step.value
}

export interface BuildStats {
  /** The longest single slice of work, ms. A frame cannot be faster than this. */
  longestSliceMs: number
  /** Total work across every slice, ms — the build's real cost. */
  workMs: number
  /** How many slices the build was cut into. */
  slices: number
  /** Painted frames while building, their mean gap, and how many ran over 25 ms. */
  frames: number
  meanFrameMs: number
  slowFrames: number
}

type Scheduler = { yield(): Promise<void> }

/** Bounds on the per-frame slice. 12 ms of 16.7 still leaves the menu its frame. */
const MIN_SLICE_MS = 3
const MAX_SLICE_MS = 12

/** Hand control back for input and other tasks, without waiting for a frame. */
function yieldNow(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: Scheduler }).scheduler
  if (scheduler) return scheduler.yield()
  if (typeof MessageChannel === 'function') {
    return new Promise(resolve => {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => resolve()
      channel.port2.postMessage(null)
    })
  }
  return new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * Wait until the frame now being produced has been painted. Resolves `false`
 * if no frame came within `timeoutMs` — nothing is painting.
 */
export function afterNextPaint(timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let done = false
    requestAnimationFrame(() => setTimeout(() => {
      if (!done) { done = true; resolve(true) }
    }, 0))
    setTimeout(() => { if (!done) { done = true; resolve(false) } }, timeoutMs)
  })
}

/**
 * Run a build in bounded slices, one per painted frame, retaining deterministic
 * output.
 *
 * Between slices this used to `scheduler.yield()`, and that was why the menu
 * fell to ~12 fps while a circuit loaded: a yielded task resumes AHEAD of other
 * work, rendering included, so slice after slice ran before the frame they were
 * meant to make room for. Waiting for each frame to be painted keeps the frame
 * rate and still finishes.
 *
 * Pacing is only worth its cost when there is a picture to keep smooth. When
 * nothing is painting — a hidden tab, a minimised window — or `paced` says so
 * (first load, with no circuit on screen yet; a driver waiting to start), the
 * build runs at full speed instead. `paced` is asked again before every slice,
 * so it can change its mind mid-build.
 */
export async function runBuild<T>(steps: Generator<void, T>, current: () => boolean,
  report?: (longestSliceMs: number, stats: BuildStats) => void, sliceMs = 6,
  paced: () => boolean = () => true): Promise<T | null> {
  const stats: BuildStats = {
    longestSliceMs: 0, workMs: 0, slices: 0, frames: 0, meanFrameMs: 0, slowFrames: 0,
  }
  let frameTotal = 0
  const canPaint = typeof requestAnimationFrame === 'function'
  let painting = canPaint
  // The slice adapts to the machine. The shortest gap seen between painted
  // frames is the display's own refresh; while frames keep arriving on that
  // beat there is headroom and the slice grows, and the moment one runs late it
  // shrinks. A fast machine finishes sooner; a slow one keeps its frame rate.
  let slice = sliceMs
  let refresh = Infinity
  let lastPaint = performance.now()
  try {
    while (current()) {
      const begin = performance.now()
      let step = steps.next()
      while (!step.done && performance.now() - begin < slice) {
        step = steps.next()
      }
      const spent = performance.now() - begin
      stats.longestSliceMs = Math.max(stats.longestSliceMs, spent)
      stats.workMs += spent
      stats.slices++
      if (step.done) { report?.(stats.longestSliceMs, stats); return step.value }
      if (painting && paced()) {
        painting = await afterNextPaint(50)
        const now = performance.now()
        const interval = now - lastPaint
        lastPaint = now
        if (painting) {
          stats.frames++
          frameTotal += interval
          stats.meanFrameMs = frameTotal / stats.frames
          if (interval > 25) stats.slowFrames++
          if (interval > 4) refresh = Math.min(refresh, interval)
          if (interval <= refresh * 1.15) slice = Math.min(slice + 1, MAX_SLICE_MS)
          else if (interval > refresh * 1.5) slice = Math.max(slice * 0.7, MIN_SLICE_MS)
        } else {
          // Frames stopped. Run flat out, and wait for the next frame to
          // resume pacing the build to the screen.
          requestAnimationFrame(() => { painting = true; lastPaint = performance.now() })
        }
      } else {
        await yieldNow()
        // Unpaced time is not a frame; do not count it as a slow one.
        lastPaint = performance.now()
      }
    }
    return null
  } finally {
    steps.return(undefined as never)
  }
}
