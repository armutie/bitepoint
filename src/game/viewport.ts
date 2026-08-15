/**
 * How much of the screen the game actually occupies.
 *
 * An experiment, and a deliberate one. The Python game runs in a fixed
 * 1100x760 window, and a browser filling a 27-inch display is a very different
 * proposition even with the field of view matched — a fixed horizontal FOV
 * spread across a much wider screen means each degree of view covers more
 * pixels, so the same corner sweeps past your eyes differently.
 *
 * Two modes are offered:
 *
 *   full     the whole window, as it has been
 *   classic  the Python window's 1100:760 aspect, scaled up to fit
 *
 * There was a third, ``window``: exactly 1100x760 pixels, the Python window at
 * its true size. It existed to separate the two variables — ``window`` against
 * ``full`` isolates SIZE, ``classic`` against ``full`` isolates SHAPE — and
 * having answered that, a mode that paints most of a 27-inch display black to
 * show a small picture is not a setting anyone wants twice.
 *
 * It stays implemented, because a stored setting can still name it and because
 * the experiment is worth being able to re-run; it is simply not offered, and
 * `nextViewport` walks the offered list.
 */

export type ViewportMode = 'full' | 'window' | 'classic'

/** The modes the UI offers, and the cycle order for the V key. */
export const VIEWPORT_ORDER: readonly ViewportMode[] = ['full', 'classic']

/** The Python game's window, from racing/render.py. */
const REF_W = 1100
const REF_H = 760
const REF_ASPECT = REF_W / REF_H

export const VIEWPORT_LABEL: Record<ViewportMode, string> = {
  full: 'Full',
  window: '1100×760',
  classic: '11:7.6',
}

/**
 * Size the stage for a mode.
 *
 * Returns nothing; the caller re-reads the canvas size afterwards. Sizes are
 * applied to the stage rather than the canvas so the HUD, which is positioned
 * against the stage, stays inside the picture instead of floating out over the
 * black bars.
 */
export function applyViewport(stage: HTMLElement, mode: ViewportMode): void {
  const availW = window.innerWidth
  const availH = window.innerHeight

  switch (mode) {
    case 'full':
      stage.style.width = '100%'
      stage.style.height = '100%'
      break

    case 'window': {
      // Clamp, so a laptop smaller than the reference window still shows all
      // of it rather than cropping — shrunk in proportion.
      const scale = Math.min(1, availW / REF_W, availH / REF_H)
      stage.style.width = `${Math.round(REF_W * scale)}px`
      stage.style.height = `${Math.round(REF_H * scale)}px`
      break
    }

    case 'classic': {
      const byWidth = availW / REF_ASPECT <= availH
      const w = byWidth ? availW : availH * REF_ASPECT
      const h = byWidth ? availW / REF_ASPECT : availH
      stage.style.width = `${Math.round(w)}px`
      stage.style.height = `${Math.round(h)}px`
      break
    }
  }
}

export function nextViewport(mode: ViewportMode): ViewportMode {
  // A mode that is no longer offered is not in the list, so indexOf returns -1
  // and this lands on the first — which is what should happen: press V on a
  // retired mode and you rejoin the cycle rather than being stuck outside it.
  const i = VIEWPORT_ORDER.indexOf(mode)
  return VIEWPORT_ORDER[(i + 1) % VIEWPORT_ORDER.length]!
}
