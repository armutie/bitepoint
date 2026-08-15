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
import type { Terrain } from './terrain'

export interface World {
  root: THREE.Group
  dispose(): void
}

/** Curvature above which a stretch of road is a corner worth kerbing. */
const KERB_CURVATURE = 0.0045
const KERB_WIDTH = 1.1
const LINE_WIDTH = 0.18
const BARRIER_HEIGHT = 1.05
/** Transverse tarmac seam every N metres — the speed cue on straights. */
const SEAM_SPACING = 8.0
const SEAM_WIDTH = 0.14
/** How much darker the rubbered centre of the road is than its edges. */
const RUBBER_DARKEN = 0.86

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
function octave(size: number, C: number, rand: () => number): Float32Array {
  const grid: number[] = []
  for (let i = 0; i < C * C; i++) grid.push(rand())
  const out = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
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

function toTexture(size: number, value: (i: number) => number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let i = 0; i < size * size; i++) {
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

/**
 * Asphalt: patch-scale tonal drift, aggregate blotch, fine speckle, and a few
 * lighter repair patches with hard edges — the thing that most says "road
 * someone has maintained" rather than "grey fill".
 */
function makeAsphaltTexture(): THREE.CanvasTexture {
  const size = 512
  const rand = lcg(0x9e3779b9)
  const drift = octave(size, 6, rand)
  const blotch = octave(size, 28, rand)
  const speck = octave(size, 128, rand)

  // Hard-edged repair patches: a handful of axis-aligned rectangles.
  const patches = new Float32Array(size * size)
  for (let p = 0; p < 7; p++) {
    const px = Math.floor(rand() * size)
    const py = Math.floor(rand() * size)
    const pw = 30 + Math.floor(rand() * 90)
    const ph = 18 + Math.floor(rand() * 46)
    const lift = (rand() - 0.35) * 0.09
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        patches[((py + y) % size) * size + ((px + x) % size)] = lift
      }
    }
  }

  return toTexture(size, (i) => {
    const grit = rand() // per-pixel white noise, deterministic order
    return (
      0.8 +
      0.1 * drift[i]! +
      0.08 * blotch[i]! +
      0.05 * speck[i]! +
      0.04 * grit +
      patches[i]!
    )
  })
}

/**
 * Grass: mowing bands (the alternating light/dark stripes every circuit
 * verge has), growth blotches, and blade-scale noise. The bands are what
 * turn "green plane" into "ground that someone mows".
 */
function makeGrassTexture(): THREE.CanvasTexture {
  const size = 512
  const rand = lcg(0x51f15eed)
  const blotchA = octave(size, 10, rand)
  const blotchB = octave(size, 44, rand)
  const blade = octave(size, 200, rand)

  return toTexture(size, (i) => {
    const x = i % size
    // Mowing bands along one world axis; softened square wave so the edges
    // read as cut lines without aliasing.
    const band = Math.sin((x / size) * Math.PI * 8)
    const mow = 0.055 * Math.tanh(band * 3)
    return 0.78 + mow + 0.12 * blotchA[i]! + 0.08 * blotchB[i]! + 0.06 * blade[i]!
  })
}

/** Worn paint and panel wear for kerbs, lines and walls. */
function makeWearTexture(): THREE.CanvasTexture {
  const size = 256
  const rand = lcg(0xdecafbad)
  const wear = octave(size, 20, rand)
  const chip = octave(size, 90, rand)
  return toTexture(size, (i) => 0.86 + 0.09 * wear[i]! + 0.05 * chip[i]!)
}

/**
 * Offset a centreline point sideways by ``d`` metres, positive to the left of
 * travel — the same sign convention the sim's lateral offset uses.
 */
function offsetPoint(track: Track, i: number, d: number): { x: number; y: number } {
  const n = track.n
  const j = (i + 1) % n
  const cx = track.cx[i]!
  const cy = track.cy[i]!
  const tx = track.cx[j]! - cx
  const ty = track.cy[j]! - cy
  const len = Math.max(Math.hypot(tx, ty), 1e-9)
  return { x: cx + (-ty / len) * d, y: cy + (tx / len) * d }
}

export function buildWorld(track: Track, terrain: Terrain): World {
  const root = new THREE.Group()
  const disposables: { dispose(): void }[] = []

  const n = track.n
  const tarmac = newStrip()
  const lines = newStrip()
  const kerbs = newStrip()
  const seams = newStrip()
  const barriers = newStrip()

  const cTarmac = new THREE.Color(PALETTE.TARMAC)
  const cTarmacAlt = new THREE.Color(PALETTE.TARMAC).lerp(new THREE.Color(PALETTE.TARMAC_FAR), 0.35)
  const cLine = new THREE.Color(PALETTE.LIMIT)
  const cKerbA = new THREE.Color(PALETTE.KERB_A)
  const cKerbB = new THREE.Color(PALETTE.KERB_B)
  const cSeam = new THREE.Color(PALETTE.SEAM)
  const cBarrierA = new THREE.Color(PALETTE.BARRIER_A)
  const cBarrierB = new THREE.Color(PALETTE.BARRIER_B)
  const cCrest = new THREE.Color(PALETTE.BARRIER_CREST)

  let seamDebt = 0

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const hi = track.halfRing[i]!
    const hj = track.halfRing[j]!

    // Road surface, in two halves with the centre darkened: the rubbered-in
    // line. Grip has no lateral variation in the sim — this is honest paint,
    // not hidden physics. Subtle band shading gives straights a rhythm.
    const shade = Math.floor(i / 6) % 2 === 0 ? cTarmac : cTarmacAlt
    const centre = shade.clone().multiplyScalar(RUBBER_DARKEN)
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
      1 / 5,
    )
    quad(
      tarmac,
      vx(mi.x), 0, vz(mi.y),
      vx(mj.x), 0, vz(mj.y),
      vx(rj.x), 0, vz(rj.y),
      vx(ri.x), 0, vz(ri.y),
      centre, centre, shade, shade,
      1 / 5,
    )

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

    // Transverse seams on the straights, spaced by arc length. Skipped in the
    // corners where the kerbs already carry the speed read.
    seamDebt += track.segLenAt(i)
    if (seamDebt >= SEAM_SPACING && track.curvature[i]! <= KERB_CURVATURE) {
      seamDebt = 0
      const a = offsetPoint(track, i, hi - LINE_WIDTH * 1.6)
      const b = offsetPoint(track, i, -(hi - LINE_WIDTH * 1.6))
      const t = { x: track.cx[j]! - track.cx[i]!, y: track.cy[j]! - track.cy[i]! }
      const tl = Math.max(Math.hypot(t.x, t.y), 1e-9)
      const ux = (t.x / tl) * SEAM_WIDTH
      const uy = (t.y / tl) * SEAM_WIDTH
      quadFlat(
        seams,
        vx(a.x), 0.006, vz(a.y),
        vx(a.x + ux), 0.006, vz(a.y + uy),
        vx(b.x + ux), 0.006, vz(b.y + uy),
        vx(b.x), 0.006, vz(b.y),
        cSeam,
        1 / 3,
      )
    }

    // Kerbs on the corners only, striped along the road, with a raised crest.
    if (track.curvature[i]! > KERB_CURVATURE) {
      const stripe = Math.floor(i / 2) % 2 === 0 ? cKerbA : cKerbB
      for (const side of [1, -1]) {
        const oi = offsetPoint(track, i, side * hi)
        const oj = offsetPoint(track, j, side * hj)
        const ki = offsetPoint(track, i, side * (hi + KERB_WIDTH))
        const kj = offsetPoint(track, j, side * (hj + KERB_WIDTH))
        quadFlat(
          kerbs,
          vx(oi.x), 0.02, vz(oi.y),
          vx(oj.x), 0.02, vz(oj.y),
          vx(kj.x), 0.09, vz(kj.y),
          vx(ki.x), 0.09, vz(ki.y),
          stripe,
          1 / 2,
        )
      }
    }

    // Barrier walls: grey and blue segments under a sunlit crest rail. The
    // crest is a narrow top face — it catches the sky light and is what makes
    // the wall read as an object with thickness rather than a fence of paint.
    const wall = Math.floor(i / 5) % 2 === 0 ? cBarrierA : cBarrierB
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
        cCrest,
        1 / 4,
      )
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

  const asphalt = makeAsphaltTexture()
  const wear = makeWearTexture()
  disposables.push(asphalt, wear)

  const surfaceMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: asphalt })
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
    [seams, overlayMat, true],
    [kerbs, overlayMat, true],
    [barriers, barrierMat, false],
    [posts, barrierMat, false],
    [skirts, skirtMat, false],
  ] as const) {
    if (strip.positions.length === 0) continue
    const mesh = stripToMesh(strip, mat, shadow)
    disposables.push(mesh.geometry)
    root.add(mesh)
  }

  root.add(buildStartLine(track, disposables))
  root.add(buildGround(track, terrain, disposables))

  return {
    root,
    dispose(): void {
      for (const d of disposables) d.dispose()
    },
  }
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
function buildGround(
  track: Track, terrain: Terrain, disposables: { dispose(): void }[],
): THREE.Mesh {
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

  const grass = makeGrassTexture()
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
