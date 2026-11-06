import { finishBuild } from './buildScheduler'
import { chunkGeometrySteps } from './meshChunks'
/**
 * The circuit as three.js geometry.
 *
 * Everything here is generated from the baked track — the same centreline and
 * half-width ring the physics uses — so what you see is what you can drive on.
 * There is no second copy of the road that could drift from the first.
 *
 * **Coordinates.** The sim is 2D: x right, y "up" the page, yaw counter-clockwise
 * from +x. three.js is 3D with y as height. The mapping is
 *
 *     three.x = sim.x        three.y = height        three.z = -sim.y
 *
 * which preserves handedness, so the circuit is not mirrored. With the car model
 * built nose-along-+X, a rotation of ``yaw`` about Y then points it correctly.
 *
 * **Winding.** Because +y maps to -z, the sense of the cross product flips, so
 * quads are wound (a, c, b)/(a, d, c) — the reverse of the intuitive order — to
 * keep horizontal faces pointing up. Getting this wrong culls the entire road.
 *
 * Colours come from ``palette.ts`` (the Python renderer's authored palette).
 * Surfaces carry world-space UVs into a shared noise texture, which is most of
 * what stops them reading as untextured CAD fill.
 */
import * as THREE from 'three'

import type { Track } from '../core/track'
import { PALETTE } from './palette'
import { applyRoadWear, makeRubberTextureSteps, makeRoadScuffTextureSteps, roadWearAt } from './roadWear'
import { buildNearGrassSteps } from './nearGrass'
import { weatherKerb } from './kerbSurface'
import { kerbPoint, kerbSpans } from './trackSurface'
import type { Terrain } from './terrain'

export interface World {
  root: THREE.Group
  dispose(): void
}

/** Curvature above which a stretch of road is a corner worth kerbing. */
const LINE_WIDTH = 0.18
const BARRIER_HEIGHT = 1.05

/** sim (x, y) -> three (x, z), with a height. */
const vx = (x: number): number => x
const vz = (y: number): number => -y

interface Strip {
  positions: number[]
  colors: number[]
  uvs: number[]
}

function newStrip(): Strip {
  return { positions: [], colors: [], uvs: [] }
}

/**
 * Push a quad given its corners in order around the perimeter.
 *
 * Wound counter-clockwise seen from above — see the module note. UVs are
 * world-space (x, z) so a repeating noise texture reads as surface grain that
 * stays put as you drive over it.
 */
function quad(
  s: Strip,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
  ca: THREE.Color, cb: THREE.Color, cc: THREE.Color, cd: THREE.Color,
  uvScale: number,
): void {
  s.positions.push(ax, ay, az, cx, cy, cz, bx, by, bz)
  s.positions.push(ax, ay, az, dx, dy, dz, cx, cy, cz)
  const cols = [ca, cc, cb, ca, cd, cc]
  for (const c of cols) s.colors.push(c.r, c.g, c.b)
  const pts = [
    [ax, az], [cx, cz], [bx, bz],
    [ax, az], [dx, dz], [cx, cz],
  ] as const
  for (const [x, z] of pts) s.uvs.push(x * uvScale, z * uvScale)
}

/** Flat-coloured quad — the common case. */
function quadFlat(
  s: Strip,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
  color: THREE.Color,
  uvScale: number,
): void {
  quad(s, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, color, color, color, color, uvScale)
}

function stripToMesh(s: Strip, material: THREE.Material, receiveShadow: boolean): THREE.Mesh {
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(s.positions, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(s.colors, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(s.uvs, 2))
  geom.computeVertexNormals()
  const mesh = new THREE.Mesh(geom, material)
  mesh.receiveShadow = receiveShadow
  return mesh
}

/**
 * Procedural material textures, generated rather than downloaded.
 *
 * The first pass here was a single 256-px noise multiplier, and it earned the
 * criticism it got: uniform noise over a flat fill reads as *static on top of
 * the surface*, not as the surface. What sells a material is structure at
 * several scales at once — asphalt has aggregate speckle inside patch-scale
 * tonal drift inside lane-scale polish; grass has blades inside blotches
 * inside mowing bands. So each texture is a sum of octaves with deliberate
 * scales, not one octave of "grain".
 *
 * All grayscale multipliers: the authored palette stays in charge of hue.
 */

/** Deterministic LCG so every load looks identical. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

/** A tileable value-noise octave: bilinear over a wrapped C×C grid. */
function* octave(size: number, C: number, rand: () => number): Generator<void, Float32Array> {

  const grid: number[] = []
  for (let i = 0; i < C * C; i++) grid.push(rand())
  const out = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    if (y % 8 === 0) yield
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * C
      const gy = (y / size) * C
      const x0 = Math.floor(gx) % C
      const y0 = Math.floor(gy) % C
      const x1 = (x0 + 1) % C
      const y1 = (y0 + 1) % C
      const fx = gx - Math.floor(gx)
      const fy = gy - Math.floor(gy)
      const v =
        (grid[y0 * C + x0]! * (1 - fx) + grid[y0 * C + x1]! * fx) * (1 - fy) +
        (grid[y1 * C + x0]! * (1 - fx) + grid[y1 * C + x1]! * fx) * fy
      out[y * size + x] = v
    }
  }
  return out
}

function* toTexture(size: number, value: (i: number) => number): Generator<void, THREE.CanvasTexture> {

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let i = 0; i < size * size; i++) {
    if (i % 8192 === 0) yield
    const v = Math.round(255 * Math.max(0, Math.min(1, value(i))))
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v
    img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.NoColorSpace
  return tex
}

/** Small embedded stones, dark interstices and separate physical surface maps. */
function* makeAsphaltTextures(): Generator<void, { color: THREE.CanvasTexture; normal: THREE.CanvasTexture; roughness: THREE.CanvasTexture }> {

  const size = 1024, cells = 256, rand = lcg(0x9e3779b9)
  const drift = (yield* octave(size, 6, rand)), blotch = (yield* octave(size, 28, rand))
  const points = Array.from({ length: cells * cells }, () => [rand(), rand(), rand()] as const)
  const colors = new Float32Array(size * size), heights = new Float32Array(size * size), roughness = new Float32Array(size * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (x === 0 && y % 4 === 0) yield
    const gx = x / size * cells, gy = y / size * cells
    const ix = Math.floor(gx), iy = Math.floor(gy)
    let nearest = Infinity, second = Infinity, stoneTone = 0.5
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const point = points[((iy + dy + cells) % cells) * cells + (ix + dx + cells) % cells]!
      const distance = (ix + dx + point[0] - gx) ** 2 + (iy + dy + point[1] - gy) ** 2
      if (distance < nearest) { second = nearest; nearest = distance; stoneTone = point[2] }
      else if (distance < second) second = distance
    }
    const i = y * size + x
    const gap = Math.min(1, Math.max(0, (second - nearest) * 3.0))
    const shoulder = gap * gap * (3 - 2 * gap)
    const stone = shoulder * (0.68 + 0.32 * Math.exp(-nearest * 1.6))
    const pores = Math.max(0, 1 - stone * 4)
    colors[i] = 0.92 + 0.06 * (drift[i]! - 0.5) + 0.045 * (blotch[i]! - 0.5)
      + 0.035 * (stoneTone - 0.5) - 0.015 * pores + 0.006 * (rand() - 0.5)
    heights[i] = stone * (0.82 + 0.18 * stoneTone)
    roughness[i] = 0.78 + 0.15 * (1 - stone) + 0.04 * stoneTone
  }
  const color = yield* toTexture(size, i => colors[i]!)
  const rough = yield* toTexture(size, i => roughness[i]!)
  // Bake millimetre-scale relief into normals, rather than relying on colour dots
  // or screen derivatives of a height map at a shallow viewing angle.
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!, image = ctx.createImageData(size, size)
  const slopeScale = 0.0012 / (2 * 2.5 / size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (x === 0 && y % 8 === 0) yield
    const i = y * size + x
    const dx = (heights[y * size + (x + 1) % size]! - heights[y * size + (x + size - 1) % size]!) * slopeScale
    const dy = (heights[((y + 1) % size) * size + x]! - heights[((y + size - 1) % size) * size + x]!) * slopeScale
    const inv = 1 / Math.hypot(dx, dy, 1)
    image.data[i * 4] = Math.round((-dx * inv * 0.5 + 0.5) * 255)
    image.data[i * 4 + 1] = Math.round((dy * inv * 0.5 + 0.5) * 255)
    image.data[i * 4 + 2] = Math.round((inv * 0.5 + 0.5) * 255)
    image.data[i * 4 + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  const normal = new THREE.CanvasTexture(canvas)
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping; normal.colorSpace = THREE.NoColorSpace
  for (const texture of [color, normal, rough]) texture.anisotropy = 8
  return { color, normal, roughness: rough }
}

/**
 * Grass: mowing bands (the alternating light/dark stripes every circuit
 * verge has), growth blotches, and blade-scale noise. The bands are what
 * turn "green plane" into "ground that someone mows".
 */
function* makeGrassTexture(): Generator<void, THREE.CanvasTexture> {

  const size = 512
  const rand = lcg(0x51f15eed)
  const blotchA = (yield* octave(size, 10, rand))
  const blotchB = (yield* octave(size, 44, rand))
  const blade = (yield* octave(size, 200, rand))

  return yield* toTexture(size, (i) => {
    const x = i % size
    // Mowing bands along one world axis; softened square wave so the edges
    // read as cut lines without aliasing.
    const band = Math.sin((x / size) * Math.PI * 8)
    const mow = 0.055 * Math.tanh(band * 3)
    return 0.78 + mow + 0.12 * blotchA[i]! + 0.08 * blotchB[i]! + 0.06 * blade[i]!
  })
}

/** Worn paint and panel wear for kerbs, lines and walls. */
function* makeWearTexture(): Generator<void, THREE.CanvasTexture> {

  const size = 256
  const rand = lcg(0xdecafbad)
  const wear = (yield* octave(size, 20, rand))
  const chip = (yield* octave(size, 90, rand))
  return yield* toTexture(size, (i) => 0.86 + 0.09 * wear[i]! + 0.05 * chip[i]!)
}

/**
 * Offset a centreline point sideways by ``d`` metres, positive to the left of
 * travel — the same sign convention the sim's lateral offset uses.
 */
function offsetPoint(track: Track, i: number, d: number): { x: number; y: number } {
  return { x: track.cx[i]! + track.edgeNormalX(i) * d, y: track.cy[i]! + track.edgeNormalY(i) * d }
}

export function buildWorld(track: Track, terrain: Terrain): World {
  return finishBuild(buildWorldSteps(track, terrain))
}

export function* buildWorldSteps(track: Track, terrain: Terrain): Generator<void, World> {

  const root = new THREE.Group()
  const disposables: { dispose(): void }[] = []
  let complete = false
  try {

  const n = track.n
  const tarmac = newStrip()
  const roadWear: number[] = []
  let roadDistance = 0
  const lines = newStrip()
  const kerbs = newStrip()
  const kerbSurface: number[] = []
  const barriers = newStrip()

  const cTarmac = new THREE.Color(PALETTE.TARMAC)
  const cLine = new THREE.Color(PALETTE.LIMIT)
  const cKerbA = new THREE.Color(track.kerbs ? 0x343532 : PALETTE.KERB_A)
  const cKerbB = new THREE.Color(track.kerbs ? 0xc9c8bb : PALETTE.KERB_B)
  const cBarrierA = new THREE.Color(PALETTE.BARRIER_A)
  const cBarrierB = new THREE.Color(PALETTE.BARRIER_B)
  const silverstone = track.id === 'silverstone-gp'
  const pitConcrete = new THREE.Color(0x92918a)
  const concreteCap = new THREE.Color(0xb0ada4)
  const steelBacking = new THREE.Color(0x575e60)
  const galvanizedRail = new THREE.Color(0x909698)
  const safetyBarrier = new THREE.Color(0x45494a)
  const safetyCap = new THREE.Color(0x616664)
  const cCrest = new THREE.Color(PALETTE.BARRIER_CREST)


  for (let i = 0; i < n; i++) {
    if (i % 12 === 0) yield
    const j = (i + 1) % n
    const hi = track.halfRing[i]!
    const hj = track.halfRing[j]!

    // Continuous aggregate surface; lap-aligned rubber is applied in the material.
    const shade = cTarmac
    const centre = shade
    const li = offsetPoint(track, i, hi)
    const lj = offsetPoint(track, j, hj)
    const ri = offsetPoint(track, i, -hi)
    const rj = offsetPoint(track, j, -hj)
    const mi = { x: track.cx[i]!, y: track.cy[i]! }
    const mj = { x: track.cx[j]!, y: track.cy[j]! }

    quad(
      tarmac,
      vx(li.x), 0, vz(li.y),
      vx(lj.x), 0, vz(lj.y),
      vx(mj.x), 0, vz(mj.y),
      vx(mi.x), 0, vz(mi.y),
      shade, shade, centre, centre,
      1 / 2.5,
    )
    quad(
      tarmac,
      vx(mi.x), 0, vz(mi.y),
      vx(mj.x), 0, vz(mj.y),
      vx(rj.x), 0, vz(rj.y),
      vx(ri.x), 0, vz(ri.y),
      centre, centre, shade, shade,
      1 / 2.5,
    )

    const begin = roadDistance
    const lenKerb = track.segLenAt(i)
    const nextDistance = begin + lenKerb
    const wi = roadWearAt(track, roadDistance, hi)
    const wj = roadWearAt(track, nextDistance, hj)
    const a = (d: number, w: typeof wi, distance: number) => [d, distance / track.length, w.strength]
    const leftI = a(hi, wi, roadDistance), leftJ = a(hj, wj, nextDistance)
    const midI = a(0, wi, roadDistance), midJ = a(0, wj, nextDistance)
    const rightI = a(-hi, wi, roadDistance), rightJ = a(-hj, wj, nextDistance)
    // Match quad's triangle winding exactly; lap coordinates stay continuous.
    for (const p of [leftI, midJ, leftJ, leftI, midI, midJ, midI, rightJ, midJ, midI, rightI, rightJ]) roadWear.push(...p)
    roadDistance = nextDistance

    // Painted edge lines, just inside the boundary.
    for (const side of [1, -1]) {
      const oi = offsetPoint(track, i, side * (hi - LINE_WIDTH / 2))
      const oj = offsetPoint(track, j, side * (hj - LINE_WIDTH / 2))
      const ii = offsetPoint(track, i, side * (hi - LINE_WIDTH * 1.5))
      const ij = offsetPoint(track, j, side * (hj - LINE_WIDTH * 1.5))
      quadFlat(
        lines,
        vx(oi.x), 0.01, vz(oi.y),
        vx(oj.x), 0.01, vz(oj.y),
        vx(ij.x), 0.01, vz(ij.y),
        vx(ii.x), 0.01, vz(ii.y),
        cLine,
        1 / 3,
      )
    }

    for (const span of kerbSpans(track, i, begin)) {
        const { side, starts, stops } = span
        const stripe = span.stripe % 2 === 0 ? cKerbA : cKerbB
      // A rounded concrete bank, sampled across its width. Broad, continuous
      // variations give different runs flatter, domed, or asymmetric shoulders.
      type KerbVertex = { x: number; y: number; z: number; along: number; across: number }
      const profile = (t: number, u: number, foot = false): KerbVertex => {
        const p = kerbPoint(track, i, begin, side, t, u, span)
        return { x: vx(p.x), z: vz(p.y), y: foot ? -0.035 : p.height, along: begin + t * lenKerb, across: u }
      }
      const face = (a: KerbVertex, b: KerbVertex, c: KerbVertex, d: KerbVertex, color: THREE.Color): void => {
        quadFlat(kerbs, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z, color, 1 / 2)
        for (const v of [a, c, b, a, d, c]) kerbSurface.push(v.along, v.across, side)
      }
      const edgePaint = stripe.clone().multiplyScalar(0.92)
      const acrossSteps = span.across, alongSteps = span.steps
      for (let l = 0; l < alongSteps; l++) {
        const t0 = span.from + (span.to - span.from) * l / alongSteps
        const t1 = span.from + (span.to - span.from) * (l + 1) / alongSteps
        for (let c = 0; c < acrossSteps; c++) {
          const u0 = c / acrossSteps, u1 = (c + 1) / acrossSteps
          face(profile(t0, u0), profile(t1, u0), profile(t1, u1), profile(t0, u1), stripe)
          face(profile(t0, u0, true), profile(t0, u1, true), profile(t1, u1, true), profile(t1, u0, true), edgePaint)
          if (starts && l === 0) face(profile(t0, u0), profile(t0, u1), profile(t0, u1, true), profile(t0, u0, true), edgePaint)
          if (stops && l === alongSteps - 1) face(profile(t1, u1), profile(t1, u0), profile(t1, u0, true), profile(t1, u1, true), edgePaint)
        }
        face(profile(t1, 0), profile(t0, 0), profile(t0, 0, true), profile(t1, 0, true), edgePaint)
        face(profile(t0, 1), profile(t1, 1), profile(t1, 1, true), profile(t0, 1, true), edgePaint)
      }
    }

    // Barrier walls: grey and blue segments under a sunlit crest rail. The
    // crest is a narrow top face — it catches the sky light and is what makes
    // the wall read as an object with thickness rather than a fence of paint.
    const standardWall = Math.floor(i / 5) % 2 === 0 ? cBarrierA : cBarrierB
    for (const side of [1, -1]) {
      // The standoff comes from the track's own baked gap, per vertex and per
      // side, not the flat 9 m this used to draw at. That is not cosmetic: the
      // wall is solid now, and `Barriers` decides you have hit it from exactly
      // these numbers. Drawn anywhere else and the car would stop a metre short
      // of a wall, or drive through one.
      const gi = side > 0 ? track.barrierGapLeft[i]! : track.barrierGapRight[i]!
      const gj = side > 0 ? track.barrierGapLeft[j]! : track.barrierGapRight[j]!
      const bi = offsetPoint(track, i, side * (hi + gi))
      const bj = offsetPoint(track, j, side * (hj + gj))
      const pitWall = begin < 330 || begin > 5840 || (side < 0 && begin > 2350 && begin < 2910)
      const armco = silverstone && !pitWall && (gi + gj) / 2 < 16
      const wall = !silverstone ? standardWall : pitWall ? pitConcrete : armco ? steelBacking : safetyBarrier
      const crest = !silverstone ? cCrest : pitWall ? concreteCap : armco ? galvanizedRail : safetyCap
      quadFlat(
        barriers,
        vx(bi.x), 0, vz(bi.y),
        vx(bj.x), 0, vz(bj.y),
        vx(bj.x), BARRIER_HEIGHT, vz(bj.y),
        vx(bi.x), BARRIER_HEIGHT, vz(bi.y),
        wall,
        1 / 4,
      )
      // The wall's thickness sits OUTSIDE the collision face: the inner face is
      // the surface the physics tests against, and the 0.42 m of concrete is
      // behind it, away from the circuit.
      const ti = offsetPoint(track, i, side * (hi + gi + 0.42))
      const tj = offsetPoint(track, j, side * (hj + gj + 0.42))
      quadFlat(
        barriers,
        vx(bi.x), BARRIER_HEIGHT, vz(bi.y),
        vx(bj.x), BARRIER_HEIGHT, vz(bj.y),
        vx(tj.x), BARRIER_HEIGHT, vz(tj.y),
        vx(ti.x), BARRIER_HEIGHT, vz(ti.y),
        crest,
        1 / 4,
      )
      if (armco) {
        const frontI = offsetPoint(track, i, side * (hi + gi - 0.018))
        const frontJ = offsetPoint(track, j, side * (hj + gj - 0.018))
        for (const bottom of [0.28, 0.63]) {
          quadFlat(
            barriers,
            vx(frontI.x), bottom, vz(frontI.y),
            vx(frontJ.x), bottom, vz(frontJ.y),
            vx(frontJ.x), bottom + 0.17, vz(frontJ.y),
            vx(frontI.x), bottom + 0.17, vz(frontI.y),
            galvanizedRail, 1 / 4,
          )
        }
      }
      // Back face of the wall, so it exists from outside the circuit too.
      quadFlat(
        barriers,
        vx(tj.x), BARRIER_HEIGHT, vz(tj.y),
        vx(ti.x), BARRIER_HEIGHT, vz(ti.y),
        vx(ti.x), 0, vz(ti.y),
        vx(tj.x), 0, vz(tj.y),
        wall,
        1 / 4,
      )
    }
  }

  // Barrier posts and ground skirts, walked by arc length. The posts are what
  // give the wall a rhythm as it streams past; the dark skirt at its base is
  // fake contact shadow, and is most of why the wall sits *on* the ground
  // instead of hovering in front of it.
  const posts = newStrip()
  const cPost = new THREE.Color(0x2a2e36)
  let postDebt = 0
  for (let i = 0; i < n; i++) {
    if (i % 12 === 0) yield
    postDebt += track.segLenAt(i)
    if (postDebt < 4.0) continue
    postDebt = 0
    const hi = track.halfRing[i]!
    for (const side of [1, -1]) {
      const gap = side > 0 ? track.barrierGapLeft[i]! : track.barrierGapRight[i]!
      const base = offsetPoint(track, i, side * (hi + gap))
      // A crossed pair of vertical quads reads as a post from every angle.
      for (const [dx, dy] of [
        [0.09, 0],
        [0, 0.09],
      ] as const) {
        quadFlat(
          posts,
          vx(base.x - dx), 0, vz(base.y - dy),
          vx(base.x + dx), 0, vz(base.y + dy),
          vx(base.x + dx), BARRIER_HEIGHT + 0.09, vz(base.y + dy),
          vx(base.x - dx), BARRIER_HEIGHT + 0.09, vz(base.y - dy),
          cPost,
          1 / 2,
        )
      }
    }
  }

  const skirts = newStrip()
  const cBlack = new THREE.Color(0x000000)
  for (let i = 0; i < n; i++) {
    if (i % 12 === 0) yield
    const j = (i + 1) % n
    const hi = track.halfRing[i]!
    const hj = track.halfRing[j]!
    for (const side of [1, -1]) {
      const gi = side > 0 ? track.barrierGapLeft[i]! : track.barrierGapRight[i]!
      const gj = side > 0 ? track.barrierGapLeft[j]! : track.barrierGapRight[j]!
      const bi = offsetPoint(track, i, side * (hi + gi))
      const bj = offsetPoint(track, j, side * (hj + gj))
      const si = offsetPoint(track, i, side * (hi + gi - 0.55))
      const sj = offsetPoint(track, j, side * (hj + gj - 0.55))
      quadFlat(
        skirts,
        vx(bi.x), 0.004, vz(bi.y),
        vx(bj.x), 0.004, vz(bj.y),
        vx(sj.x), 0.004, vz(sj.y),
        vx(si.x), 0.004, vz(si.y),
        cBlack,
        1 / 4,
      )
    }
  }

  const asphalt = yield* makeAsphaltTextures()
  const rubber = yield* makeRubberTextureSteps(track)
  yield

  const scuffs = yield* makeRoadScuffTextureSteps()
  yield
  disposables.push(rubber, scuffs)
  const wear = yield* makeWearTexture()
  disposables.push(asphalt.color, asphalt.normal, asphalt.roughness, wear)

  const surfaceMat = new THREE.MeshStandardMaterial({
    vertexColors: true, map: asphalt.color, roughness: 0.88, roughnessMap: asphalt.roughness, metalness: 0,
    normalMap: asphalt.normal, normalScale: new THREE.Vector2(0.85, 0.85), envMapIntensity: 0.80,
  })
  applyRoadWear(surfaceMat, rubber, track.length, scuffs)
  // DoubleSide is the fix for a subtle winding bug: the painted-line and kerb
  // quads are built by mirroring lateral offsets for the two sides of the
  // road, and the mirror flips the winding — so one side's paint faced
  // *downward* and was silently culled. That is why the white line showed on
  // the left edge and not the right. Thin overlays cost nothing double-sided.
  const overlayMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    map: wear,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })

  const concreteRand = lcg(0xc045e713)
  const concreteCoarse = (yield* octave(512, 32, concreteRand))
  const concrete = yield* toTexture(512, i => 0.91 + 0.045 * concreteCoarse[i]! + 0.015 * concreteRand())
  concrete.anisotropy = 8
  const kerbMat = new THREE.MeshStandardMaterial({
    vertexColors: true, map: concrete, bumpMap: concrete, bumpScale: 0.001,
    roughness: 0.96, metalness: 0, envMapIntensity: 0.18, side: THREE.DoubleSide,
  })
  weatherKerb(kerbMat)
  disposables.push(concrete, kerbMat)
  const barrierMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    map: wear,
    side: THREE.DoubleSide,
  })
  const skirtMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.3,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })
  disposables.push(surfaceMat, overlayMat, barrierMat, skirtMat)

  for (const [strip, mat, shadow] of [
    [tarmac, surfaceMat, true],
    [lines, overlayMat, true],
    [kerbs, kerbMat, true],
    [barriers, barrierMat, false],
    [posts, barrierMat, false],
    [skirts, skirtMat, false],
  ] as const) {
    yield
    if (strip.positions.length === 0) continue
    const mesh = stripToMesh(strip, mat, shadow)
    if (strip === tarmac) mesh.geometry.setAttribute('roadWear', new THREE.Float32BufferAttribute(roadWear, 3))
    if (strip === kerbs) {
      mesh.name = 'solid-kerbs'
      // Smooth lighting across profile facets and painted stripe boundaries.
      // Keep the non-indexed colors/UVs, averaging only the shared-position normals.
      const positions = mesh.geometry.getAttribute('position')
      const normals = mesh.geometry.getAttribute('normal')
      const sums = new Map<string, THREE.Vector3>()
      const key = (v: number): string => `${positions.getX(v).toFixed(5)},${positions.getY(v).toFixed(5)},${positions.getZ(v).toFixed(5)}`
      for (let v = 0; v < positions.count; v++) {
        if (v % 2048 === 0) yield
        const k = key(v), sum = sums.get(k) ?? new THREE.Vector3()
        sum.add(new THREE.Vector3(normals.getX(v), normals.getY(v), normals.getZ(v)))
        sums.set(k, sum)
      }
      for (const normal of sums.values()) normal.normalize()
      for (let v = 0; v < positions.count; v++) {
        if (v % 2048 === 0) yield
        const normal = sums.get(key(v))!
        normals.setXYZ(v, normal.x, normal.y, normal.z)
      }
      mesh.geometry.setAttribute('kerbSurface', new THREE.Float32BufferAttribute(kerbSurface, 3))
      mesh.castShadow = false
    }
    if(strip===kerbs){
      for(const geometry of yield* chunkGeometrySteps(mesh.geometry,64)){
        const part=new THREE.Mesh(geometry,mat);part.name='solid-kerbs';part.receiveShadow=true
        disposables.push(geometry);root.add(part)
      }
      mesh.geometry.dispose()
    }else{disposables.push(mesh.geometry);root.add(mesh)}
  }

  root.add(buildStartLine(track, disposables))
  root.add(yield* buildGround(track, terrain, disposables))
  yield

  const nearGrass = yield* buildNearGrassSteps(track, terrain)
  root.add(nearGrass.root)
  disposables.push(nearGrass)

  complete = true
  return { root, dispose(): void { for (const d of disposables) d.dispose() } }
  } finally { if (!complete) for (const d of disposables) d.dispose() }
}

/** A two-row chequered band across the road at the timing point. */
function buildStartLine(track: Track, disposables: { dispose(): void }[]): THREE.Mesh {
  const strip = newStrip()
  const black = new THREE.Color(PALETTE.START_DARK)
  const white = new THREE.Color(PALETTE.START_LIGHT)

  const half = track.halfRing[0]!
  const squares = Math.max(Math.floor((half * 2) / 0.8), 8)
  const depth = 0.8

  const j = 1 % track.n
  const tx = track.cx[j]! - track.cx[0]!
  const ty = track.cy[j]! - track.cy[0]!
  const len = Math.max(Math.hypot(tx, ty), 1e-9)
  const ux = (tx / len) * depth
  const uy = (ty / len) * depth

  for (let row = 0; row < 2; row++) {
    for (let k = 0; k < squares; k++) {
      const d0 = half - (k / squares) * half * 2
      const d1 = half - ((k + 1) / squares) * half * 2
      const color = (k + row) % 2 === 0 ? white : black
      const a = offsetPoint(track, 0, d0)
      const b = offsetPoint(track, 0, d1)
      const z0 = row
      quadFlat(
        strip,
        vx(a.x + ux * z0), 0.015, vz(a.y + uy * z0),
        vx(b.x + ux * z0), 0.015, vz(b.y + uy * z0),
        vx(b.x + ux * (z0 + 1)), 0.015, vz(b.y + uy * (z0 + 1)),
        vx(a.x + ux * (z0 + 1)), 0.015, vz(a.y + uy * (z0 + 1)),
        color,
        1 / 2,
      )
    }
  }

  // DoubleSide, or the chequer faces the wrong way: these quads traverse
  // their corners in the opposite order to the seam quads, so the whole
  // start line was being painted onto the UNDERSIDE of the road and culled —
  // the same mirrored-winding family as the missing white edge line.
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  })
  const mesh = stripToMesh(strip, mat, true)
  disposables.push(mat, mesh.geometry)
  return mesh
}

/**
 * The land the circuit sits in — no longer a flat sheet.
 *
 * A subdivided plane displaced by the shared terrain heightfield (flat play
 * corridor, rolling outfield, edge hills, spectator berms), and painted with a
 * patchwork of fields in vertex colours. Both changes attack the same "props
 * on a table" read: relief gives the ground a horizon of its own, and the
 * field tones break the single-material sheet the eye slides straight off.
 */
function* buildGround(
  track: Track, terrain: Terrain, disposables: { dispose(): void }[],
): Generator<void, THREE.Mesh> {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < track.n; i++) {
    minX = Math.min(minX, track.cx[i]!)
    maxX = Math.max(maxX, track.cx[i]!)
    minY = Math.min(minY, track.cy[i]!)
    maxY = Math.max(maxY, track.cy[i]!)
  }
  const pad = 600
  const w = maxX - minX + pad * 2
  const h = maxY - minY + pad * 2
  const segs = 150

  const geom = new THREE.PlaneGeometry(w, h, segs, segs)
  geom.rotateX(-Math.PI / 2)

  const cx0 = vx((minX + maxX) / 2)
  const cz0 = vz((minY + maxY) / 2)
  const pos = geom.getAttribute('position') as THREE.BufferAttribute
  const uv = geom.getAttribute('uv') as THREE.BufferAttribute
  const colors = new Float32Array(pos.count * 3)

  const grassCol = new THREE.Color(PALETTE.GRASS)
  // Field tones: wheat, pale pasture, dark crop, fallow brown. Mostly white
  // (= untinted circuit grass) so the patchwork starts beyond the corridor.
  const fieldTones = [
    new THREE.Color(1.45, 1.28, 0.72), // wheat (relative to the grass base)
    new THREE.Color(1.18, 1.22, 0.85),
    new THREE.Color(0.72, 0.85, 0.7),
    new THREE.Color(1.3, 1.05, 0.72),
  ]
  const cellTone = (gx: number, gy: number): THREE.Color | null => {
    let hsh = (gx * 374761393 + gy * 668265263 + track.seed * 97) >>> 0
    hsh = ((hsh ^ (hsh >> 13)) * 1274126177) >>> 0
    const r = ((hsh ^ (hsh >> 16)) >>> 0) / 0xffffffff
    if (r < 0.42) return null // keep plain grass
    return fieldTones[Math.floor(r * 31) % fieldTones.length]!
  }

  const white = new THREE.Color(1, 1, 1)
  const tmp = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    if (i % 256 === 0) yield
    const wx = pos.getX(i) + cx0
    const wz = pos.getZ(i) + cz0
    // three -> sim for the height query.
    const sx = wx
    const sy = -wz
    const { h: elev, d } = terrain.heightAndDist(sx, sy)
    pos.setY(i, elev)
    uv.setXY(i, wx / 26, wz / 26)

    // Field patchwork: 95 m cells, faded in past the corridor so the verges
    // the game is played on stay circuit-green.
    const tone = cellTone(Math.floor(sx / 95), Math.floor(sy / 95))
    const mixIn = tone ? Math.max(0, Math.min(1, (d - 70) / 45)) : 0
    tmp.copy(white)
    if (tone && mixIn > 0) tmp.lerp(tone, mixIn)
    colors[i * 3] = tmp.r
    colors[i * 3 + 1] = tmp.g
    colors[i * 3 + 2] = tmp.b
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geom.computeVertexNormals()

  const grass = yield* makeGrassTexture()
  const mat = new THREE.MeshLambertMaterial({
    color: grassCol,
    map: grass,
    vertexColors: true,
  })
  disposables.push(geom, mat, grass)

  const mesh = new THREE.Mesh(geom, mat)
  mesh.position.set(cx0, -0.03, cz0)
  mesh.receiveShadow = true
  return mesh
}
