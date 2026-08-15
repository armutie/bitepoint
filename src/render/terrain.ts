/**
 * The land the circuit sits in.
 *
 * One height function, shared by the ground mesh and by everything that stands
 * on the ground — trees, hedgerows — so nothing floats and nothing sinks. The
 * shape has three rules:
 *
 *   - a **flat corridor** around the road. The physics is 2D and stays honest:
 *     the tarmac, the run-off, the barriers and all the trackside buildings
 *     live on exactly the plane the simulation thinks they do.
 *   - a **rolling outfield** beyond it — a few metres of undulation, enough
 *     that the horizon line moves as you drive and the ground stops reading as
 *     a table top.
 *   - **hills at the edges**, tens of metres high hundreds of metres out,
 *     sized so they hand off believably to the sky shader's painted ridges
 *     behind them (25 m at 600 m is about the same visual angle).
 *
 * Plus grass spectator banks: gaussian berms behind the walls on the outside
 * of the sharper corners, which is where crowds actually stand.
 */
import type { Track } from '../core/track'

/** Distance from the painted edge to where the ground may start moving. */
export const FLAT_CORRIDOR = 36
/** Where the mid-field undulation reaches full amplitude. */
const ROLL_FULL = 110
const ROLL_AMP = 7.0
/** Where the edge hills begin and how tall they get. First cut had 26 m
 *  starting at 320 m — with fog starting at 260 m the hills were being
 *  painted and then fogged straight back out. */
const HILL_START = 240
const HILL_FULL = 520
const HILL_AMP = 48

export interface Terrain {
  /** Ground height at a sim-coordinate point. */
  height(x: number, y: number): number
  /** Height plus distance-past-the-painted-edge, sharing one projection —
   *  the ground mesh needs both per vertex and projection is the cost. */
  heightAndDist(x: number, y: number): { h: number; d: number }
  /** Corner apexes by sharpness, for berms and scenery placement. */
  corners: { s: number; k: number }[]
  /** Low-curvature runs, longest first — the driver's sightlines. */
  runs: { s0: number; s1: number; len: number; mid: number }[]
  /** A river winding across the outfield, if the map earned one: centreline
   *  points, to be drawn as a terrain-conforming ribbon. */
  river: { pts: { x: number; y: number }[]; width: number } | null
}

/** Low-curvature runs of the lap, longest first. Placement currency: whatever
 *  stands past the end of a long run is stared at for its whole length. */
export function longRuns(track: Track): { s0: number; s1: number; len: number; mid: number }[] {
  const step = 4
  const runs: { s0: number; s1: number; len: number; mid: number }[] = []
  let start: number | null = null
  for (let arc = 0; arc <= track.length; arc += step) {
    const straight = arc < track.length && Math.abs(track.signedCurvatureAt(arc)) < 0.0022
    if (straight && start === null) start = arc
    if ((!straight || arc + step > track.length) && start !== null) {
      const len = arc - start
      runs.push({ s0: start, s1: arc, len, mid: start + len / 2 })
      start = null
    }
  }
  return runs.sort((a, b) => b.len - a.len)
}

/** The two-to-four sharpest corners, with a separation rule. */
export function sharpestCorners(track: Track, count: number): { s: number; k: number }[] {
  const step = 6
  const candidates: { s: number; k: number }[] = []
  for (let s = 0; s < track.length; s += step) {
    candidates.push({ s, k: track.signedCurvatureAt(s) })
  }
  candidates.sort((a, b) => Math.abs(b.k) - Math.abs(a.k))

  const picked: { s: number; k: number }[] = []
  for (const c of candidates) {
    if (picked.length >= count) break
    if (Math.abs(c.k) < 0.008) break
    const dStart = Math.min(c.s, track.length - c.s)
    if (dStart < 140) continue
    if (picked.some((p) => Math.abs(p.s - c.s) < 350)) continue
    picked.push(c)
  }
  return picked
}

/** Deterministic 2D value noise (not tileable — this is world space). */
function makeNoise(seed: number): (x: number, y: number) => number {
  const hash = (ix: number, iy: number): number => {
    let h = (ix * 374761393 + iy * 668265263 + seed * 69069) >>> 0
    h = (h ^ (h >> 13)) >>> 0
    h = (h * 1274126177) >>> 0
    return ((h ^ (h >> 16)) >>> 0) / 0xffffffff
  }
  return (x: number, y: number): number => {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = x - ix
    const fy = y - iy
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    return (
      (hash(ix, iy) * (1 - sx) + hash(ix + 1, iy) * sx) * (1 - sy) +
      (hash(ix, iy + 1) * (1 - sx) + hash(ix + 1, iy + 1) * sx) * sy
    )
  }
}

const smooth = (a: number, b: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function buildTerrain(track: Track): Terrain {
  const noise = makeNoise(track.seed ^ 0x5eed7e44)
  const corners = sharpestCorners(track, 4)
  const runs = longRuns(track)

  // Water, third attempt — and the geometry lesson is worth recording. A
  // ground-level pond can never clear the barriers from a 1.38 m camera. An
  // elevated reservoir fails differently: its containing rim must stand above
  // its waterline, and from below you cannot see into a bowl whose rim is
  // above the water — you see the dam, never the lake. What IS visible from a
  // low camera is anything that CONFORMS TO THE VISIBLE SLOPES. So: a RIVER.
  // A wide ribbon draped over the terrain, crossing the sightline of the
  // second-longest straight out on the rising ground — wherever a hillside
  // faces the driver, the water on it does too.
  let river: { pts: { x: number; y: number }[]; width: number } | null = null
  const wrapDist = (a: number, b: number): number => {
    const d = Math.abs(a - b) % track.length
    return Math.min(d, track.length - d)
  }
  for (const run of runs.slice(1)) {
    if (run.len < 90) break
    if (runs[0] && wrapDist(run.mid, runs[0].mid) < 250) continue
    const end = track.poseAt(run.s1)
    const hx = Math.cos(end.yaw)
    const hy = Math.sin(end.yaw)
    // The river runs roughly ACROSS the straight's sightline, 360 m out,
    // winding with a couple of sine harmonics so it reads as a river and not
    // a canal. Samples that come near ANY part of the circuit are dropped,
    // and the longest surviving stretch becomes the river.
    const cx = end.x + hx * 360
    const cy = end.y + hy * 360
    const px = -hy
    const py = hx
    const all: { x: number; y: number; ok: boolean }[] = []
    for (let t = -620; t <= 620; t += 14) {
      const meander = 55 * Math.sin(t / 130) + 30 * Math.sin(t / 47 + 2.1)
      const x = cx + px * t + hx * meander
      const y = cy + py * t + hy * meander
      const proj = track.project(x, y)
      all.push({ x, y, ok: Math.abs(proj.lateral) - proj.half > 95 })
    }
    let best: { s: number; e: number } | null = null
    let s0: number | null = null
    for (let i = 0; i <= all.length; i++) {
      const ok = i < all.length && all[i]!.ok
      if (ok && s0 === null) s0 = i
      if (!ok && s0 !== null) {
        if (!best || i - s0 > best.e - best.s) best = { s: s0, e: i }
        s0 = null
      }
    }
    if (best && best.e - best.s >= 18) {
      river = { pts: all.slice(best.s, best.e).map((p) => ({ x: p.x, y: p.y })), width: 26 }
      break
    }
  }

  // Spectator banks behind the walls on the outside of the 3rd and 4th
  // sharpest corners (the two sharpest carry grandstands instead). Positive
  // lateral is left; the outside of a corner is minus the curvature's sign.
  const berms: { x: number; y: number; amp: number; sigma: number }[] = []
  for (const c of corners.slice(2)) {
    const out = -Math.sign(c.k) || 1
    const half = track.halfAt(c.s)
    const pose = track.poseAt(c.s)
    const lat = out * (half + 30)
    berms.push({
      x: pose.x - Math.sin(pose.yaw) * lat,
      y: pose.y + Math.cos(pose.yaw) * lat,
      amp: 4.2,
      sigma: 12,
    })
  }

  // --- distance-field cache -----------------------------------------------
  // heightAndDist is called ~35,000 times per track build (every ground
  // vertex, every hedge probe, every tree), and each exact nearest-segment
  // projection costs ~11 µs — most of the ~1.2 s load stall. The distance
  // past the road edge is a smooth field, so it is sampled once on a coarse
  // grid (~6k projections) and bilinearly interpolated. EXCEPT near the
  // track: within 70 m the exact projection is still used, because the flat
  // corridor is a gameplay guarantee and an interpolated boundary would let
  // terrain creep under barriers and buildings. Far from the road, a metre
  // or two of error moves a hill nobody is standing next to.
  const CELL = 20
  const PAD = 640
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < track.n; i++) {
    minX = Math.min(minX, track.cx[i]!)
    maxX = Math.max(maxX, track.cx[i]!)
    minY = Math.min(minY, track.cy[i]!)
    maxY = Math.max(maxY, track.cy[i]!)
  }
  const gx0 = minX - PAD
  const gy0 = minY - PAD
  const gnx = Math.ceil((maxX - minX + PAD * 2) / CELL) + 1
  const gny = Math.ceil((maxY - minY + PAD * 2) / CELL) + 1
  const dGrid = new Float32Array(gnx * gny)
  for (let iy = 0; iy < gny; iy++) {
    for (let ix = 0; ix < gnx; ix++) {
      const proj = track.project(gx0 + ix * CELL, gy0 + iy * CELL)
      dGrid[iy * gnx + ix] = Math.abs(proj.lateral) - proj.half
    }
  }
  const approxDist = (x: number, y: number): number => {
    const fx = Math.min(Math.max((x - gx0) / CELL, 0), gnx - 1.001)
    const fy = Math.min(Math.max((y - gy0) / CELL, 0), gny - 1.001)
    const ix = Math.floor(fx)
    const iy = Math.floor(fy)
    const tx = fx - ix
    const ty = fy - iy
    return (
      (dGrid[iy * gnx + ix]! * (1 - tx) + dGrid[iy * gnx + ix + 1]! * tx) * (1 - ty) +
      (dGrid[(iy + 1) * gnx + ix]! * (1 - tx) + dGrid[(iy + 1) * gnx + ix + 1]! * tx) * ty
    )
  }

  const heightAndDist = (x: number, y: number): { h: number; d: number } => {
    let d = approxDist(x, y)
    if (d < 70) {
      const proj = track.project(x, y)
      d = Math.abs(proj.lateral) - proj.half
    }

    let h = 0
    if (d > FLAT_CORRIDOR) {
      const roll =
        (noise(x / 90, y / 90) - 0.5) * 2 * ROLL_AMP +
        (noise(x / 34, y / 34) - 0.5) * 2.2
      h += roll * smooth(FLAT_CORRIDOR, ROLL_FULL, d)

      const hill =
        (noise(x / 420 + 7.3, y / 420 - 2.1) * 0.75 + noise(x / 160, y / 160) * 0.25) * HILL_AMP
      h += hill * smooth(HILL_START, HILL_FULL, d)
    }

    // Berms ride on top with their own falloff, and are allowed inside the
    // corridor's outer half — a bank belongs just behind the wall. They are
    // far enough out that the wall base itself stays within centimetres.
    // Never lift the grass through the driving surface. Croft Bay's
    // sector-three bank previously left an 8 mm tail under the tarmac edge.
    const bermEdgeFade = smooth(1, 12, d)
    for (const b of berms) {
      const r2 = (x - b.x) ** 2 + (y - b.y) ** 2
      h += b.amp * Math.exp(-r2 / (b.sigma * b.sigma)) * bermEdgeFade
    }

    return { h, d }
  }

  return {
    height: (x, y) => heightAndDist(x, y).h,
    heightAndDist,
    corners,
    runs,
    river,
  }
}
