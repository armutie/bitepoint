/**
 * The settings-screen pictograms.
 *
 * Inline SVG rather than a font or a sprite sheet: there are nine of them, they
 * are drawn once each, and they inherit `currentColor` so a segment lighting up
 * needs no second copy in an "on" colour.
 *
 * Each icon says what the setting *looks like* rather than naming it — the
 * viewport icons are literally the shape of the picture you get, and the camera
 * icons are the shot. That is the point: a settings screen for a driving game
 * should be lookable-at rather than readable.
 */

const NS = 'http://www.w3.org/2000/svg'

export type IconName =
  | 'mouse' | 'keyboard'
  | 'halo' | 'hood' | 'chase' | 'topDown'
  | 'full' | 'window' | 'classic'
  | 'reset' | 'play' | 'menu' | 'trophy' | 'sliders'

/**
 * Paths per icon, on a 16x16 grid. `stroke` entries are outlined at the shared
 * width; `fill` entries are solid — used for the part of a viewport icon that
 * is picture rather than letterbox.
 */
const ICONS: Record<IconName, { stroke?: string[]; fill?: string[] }> = {
  // A mouse body with the scroll wheel at the top.
  mouse: { stroke: ['M8 1.5h0a4 4 0 0 1 4 4v5a4 4 0 0 1-8 0v-5a4 4 0 0 1 4-4z', 'M8 4v2.5'] },
  // A keyboard: three rows of keys, the bottom one a space bar.
  keyboard: {
    stroke: ['M1.5 4.5h13v7h-13z', 'M4 7h.01', 'M7 7h.01', 'M10 7h.01', 'M12 7h.01', 'M5 9.5h6'],
  },

  // Halo cam: the driver's head, and the ring arcing over it.
  halo: { stroke: ['M8 13.5a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6z', 'M2.8 9.5a5.2 5.2 0 0 1 10.4 0', 'M8 4.3v-1'] },
  // Hood cam: the nose of the car below, the horizon above.
  hood: { stroke: ['M1.5 4.5h13', 'M2 14l2.5-5h7l2.5 5'] },
  // Chase cam: the car from behind, with the road rushing past it.
  chase: { stroke: ['M4 8.5h8v4h-8z', 'M2 5.5h3', 'M11 5.5h3', 'M6.5 5.5h3'] },
  // Overhead: the car seen from directly above, inside the frame.
  topDown: { stroke: ['M1.5 1.5h13v13h-13z', 'M6.5 4.5h3v7h-3z', 'M6.5 6.5h3', 'M6.5 9.5h3'] },

  // The three picture shapes, drawn as the picture they produce.
  full: { fill: ['M1.5 2.5h13v11h-13z'] },
  window: { stroke: ['M1.5 2.5h13v11h-13z'], fill: ['M4.5 5h7v6h-7z'] },
  // Pillarbox, not letterbox. `classic` fits a 11:7.6 picture into a wider
  // screen, so the height fills and the black is down the SIDES. The icon had
  // it the other way round, which described a mode that does not exist.
  classic: { stroke: ['M1.5 2.5h13v11h-13z'], fill: ['M4.5 2.5h7v11h-7z'] },

  // Reset: a circular arrow back to the start.
  reset: { stroke: ['M13 8a5 5 0 1 1-1.6-3.7', 'M13.2 1.8v3h-3'] },
  play: { fill: ['M5 3l8 5-8 5z'] },
  menu: { stroke: ['M2.5 4h11', 'M2.5 8h11', 'M2.5 12h11'] },
  trophy: { stroke: ['M5 2.5h6v2.8a3 3 0 0 1-6 0z', 'M8 8.3v3.2', 'M5.5 13.5h5', 'M5 4H2.5v1.2A2.8 2.8 0 0 0 5.2 8', 'M11 4h2.5v1.2A2.8 2.8 0 0 1 10.8 8'] },
  sliders: { stroke: ['M2.5 4h3', 'M8.5 4h5', 'M2.5 8h7', 'M12.5 8h1', 'M2.5 12h1', 'M6.5 12h7', 'M5.5 2.5v3', 'M9.5 6.5v3', 'M3.5 10.5v3'] },
}

/** One icon, sized to the current font. Decorative — label the button, not this. */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')

  const spec = ICONS[name]
  for (const d of spec.stroke ?? []) svg.append(path(d, 'none', 'currentColor'))
  for (const d of spec.fill ?? []) svg.append(path(d, 'currentColor', 'none'))
  return svg
}

function path(d: string, fill: string, stroke: string): SVGPathElement {
  const p = document.createElementNS(NS, 'path')
  p.setAttribute('d', d)
  p.setAttribute('fill', fill)
  p.setAttribute('stroke', stroke)
  if (stroke !== 'none') {
    p.setAttribute('stroke-width', '1.4')
    p.setAttribute('stroke-linecap', 'round')
    p.setAttribute('stroke-linejoin', 'round')
  }
  return p
}
