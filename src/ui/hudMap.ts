/**
 * The overhead track map, top right — pygame's `draw_minimap`, ported.
 *
 * Built once per circuit and then only two dots move, which is why this is SVG
 * rather than a canvas redrawn every frame: the road is a path the browser
 * rasterises once and composites thereafter, and a lap costs two attribute
 * writes a frame.
 *
 * Both EDGES are drawn rather than the centreline. A single line tells you the
 * shape of the circuit; two tell you where the road is wide enough to be worth
 * something, and on a map this small that is most of the information. The
 * centreline is never drawn at all — the car is not on it.
 */
import type { Track } from '../core/track'

const NS = 'http://www.w3.org/2000/svg'

/** Metres between samples of each edge. Fine enough for a kerb, coarse enough
 *  that a 3 km circuit is a few hundred points rather than a few thousand. */
const STEP = 6

export interface HudMap {
  root: SVGSVGElement
  /** Move the player's dot. `sector` tints it, matching the pills above. */
  setCar(x: number, y: number, sector: number): void
  /** Move the ghost's dot, or hide it with null. */
  setGhost(x: number, y: number | null): void
}

export function buildHudMap(track: Track): HudMap {
  const left: [number, number][] = []
  const right: [number, number][] = []
  for (let s = 0; s < track.length; s += STEP) {
    const pose = track.poseAt(s)
    const half = track.halfAt(s)
    const nx = -Math.sin(pose.yaw)
    const ny = Math.cos(pose.yaw)
    left.push([pose.x + nx * half, pose.y + ny * half])
    right.push([pose.x - nx * half, pose.y - ny * half])
  }

  // One square viewBox around the whole circuit, so a long thin track is not
  // stretched to fill the box — a distorted map is worse than a small one,
  // because the shape is the thing you recognise it by.
  const all = [...left, ...right]
  const xs = all.map((p) => p[0])
  const ys = all.map((p) => p[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const span = Math.max(maxX - minX, maxY - minY, 1)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const pad = span * 0.08

  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'hud-map')
  svg.setAttribute(
    'viewBox',
    `${cx - span / 2 - pad} ${cy - span / 2 - pad} ${span + pad * 2} ${span + pad * 2}`,
  )
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  svg.setAttribute('aria-hidden', 'true')
  // World y is up, screen y is down. Flipping the whole group rather than every
  // coordinate keeps every point below in world space, so the car's position
  // goes in exactly as the sim reports it.
  const flip = document.createElementNS(NS, 'g')
  flip.setAttribute('transform', `translate(0 ${2 * cy}) scale(1 -1)`)
  svg.append(flip)

  const path = (pts: [number, number][], cls: string): SVGPathElement => {
    const el = document.createElementNS(NS, 'path')
    el.setAttribute('d', pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`).join(' ') + 'Z')
    el.setAttribute('class', cls)
    return el
  }
  flip.append(path(left, 'hud-map-edge'), path(right, 'hud-map-edge'))

  // Start/finish, drawn across the road at s=0 — the one landmark that says
  // which way round the shape you are looking at.
  const startLine = document.createElementNS(NS, 'line')
  startLine.setAttribute('x1', String(left[0]![0]))
  startLine.setAttribute('y1', String(left[0]![1]))
  startLine.setAttribute('x2', String(right[0]![0]))
  startLine.setAttribute('y2', String(right[0]![1]))
  startLine.setAttribute('class', 'hud-map-start')
  flip.append(startLine)

  // Ghost first, so the player's dot draws over it when they are together —
  // the one you need to find at a glance is your own.
  const ghost = document.createElementNS(NS, 'circle')
  ghost.setAttribute('r', String(span * 0.014))
  ghost.setAttribute('class', 'hud-map-ghost')
  ghost.style.display = 'none'
  const car = document.createElementNS(NS, 'circle')
  car.setAttribute('r', String(span * 0.019))
  car.setAttribute('class', 'hud-map-car')
  flip.append(ghost, car)

  return {
    root: svg,
    setCar(x, y, sector) {
      car.setAttribute('cx', String(x))
      car.setAttribute('cy', String(y))
      // Tinted by the sector you are in, exactly as pygame does, so the map and
      // the pills above it are saying the same thing in the same colours.
      car.setAttribute('data-sector', String((sector % 3) + 1))
    },
    setGhost(x, y) {
      if (y === null) {
        ghost.style.display = 'none'
        return
      }
      ghost.style.display = ''
      ghost.setAttribute('cx', String(x))
      ghost.setAttribute('cy', String(y))
    },
  }
}
