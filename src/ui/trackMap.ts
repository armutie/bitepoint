/**
 * The circuit map on the select screen.
 *
 * Drawn from the outline baked into the manifest, so a card shows the actual
 * shape of the lap rather than a stock thumbnail. Two strokes — a wide dark
 * casing under a bright ribbon — so it reads as a road at thumbnail size, plus a
 * marker at the start/finish line.
 */
import type { TrackManifestEntry } from '../core/track'

const NS = 'http://www.w3.org/2000/svg'

export function buildTrackMap(entry: TrackManifestEntry, opts: { detailed?: boolean } = {}): SVGSVGElement {
  const [aw, ah] = entry.outlineAspect
  const pad = 0.09
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', `${-pad} ${-pad} ${aw + pad * 2} ${ah + pad * 2}`)
  svg.setAttribute('class', 'trackmap')
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  svg.setAttribute('aria-hidden', 'true')

  const d = entry.outline.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`).join(' ') + ' Z'

  const casing = document.createElementNS(NS, 'path')
  casing.setAttribute('d', d)
  casing.setAttribute('class', 'trackmap-casing')

  const ribbon = document.createElementNS(NS, 'path')
  ribbon.setAttribute('d', d)
  ribbon.setAttribute('class', 'trackmap-ribbon')

  svg.append(casing, ribbon)

  // Start/finish tick, across the road at the first outline point.
  const a = entry.outline[0]
  const b = entry.outline[1]
  if (a && b) {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy) || 1
    // Perpendicular to the direction of travel.
    const nx = (-dy / len) * 0.035
    const ny = (dx / len) * 0.035
    const tick = document.createElementNS(NS, 'line')
    tick.setAttribute('x1', String(a[0] - nx))
    tick.setAttribute('y1', String(a[1] - ny))
    tick.setAttribute('x2', String(a[0] + nx))
    tick.setAttribute('y2', String(a[1] + ny))
    tick.setAttribute('class', 'trackmap-start')
    svg.append(tick)
  }

  if (opts.detailed) svg.classList.add('trackmap-detailed')
  return svg
}
