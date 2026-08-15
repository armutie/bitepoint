/**
 * The circuit's dressing: start/finish complex, grandstands, pit building,
 * brake boards, trees.
 *
 * Ported in spirit from ``racing/scenery.py`` and the props in ``render3d.py``,
 * with the same reasoning: this is not decoration. You place a car off
 * landmarks, and a bare green plane gives you none — a grandstand at a corner
 * is a braking reference long before it is set dressing. Everything here is
 * generated from the track geometry, deterministic for a given circuit (an LCG
 * seeded from the track seed), and the grid boxes are painted from the same
 * constants the race server stages cars on, so in a future race everybody
 * really would line up inside their own box.
 *
 * Numbers from ``racing/constants.py`` and ``scenery.py``: grid spacing 9.0,
 * stagger 2.6, stage distance 12.0, painted box 5.2 x 2.8, 8 slots; gantry
 * underside at 7.0 with a 1.7 banner; barrier gap matching world.ts.
 */
import * as THREE from 'three'

import { gridPose, GRID_SLOTS } from '../core/grid'
import {
  clearOfCircuit, footprintMargin, outsideWall, safeOutside, safeOutsideBox,
} from '../core/placement'
import type { Track } from '../core/track'
import { PALETTE } from './palette'
import type { Terrain } from './terrain'

/*
 * Where the wall is, for everything placed against it.
 *
 * This file used to assume a flat 9 m gap, which was true while the renderer
 * drew one. It no longer is: the baked gap runs from 3.7 m down a straight to
 * 35 m across the outside of a quick corner.
 *
 * The first fix for that reached for `maxBarrierGap` everywhere, and was worse
 * than the bug. Placing a grandstand "beyond the widest runoff on the lap"
 * means offsetting it 61 m sideways from the centreline, and offsetting a
 * closed curve that far is not safe on a circuit that winds back past itself —
 * on Croft Bay fifteen anchor points landed back inside the wall, against none
 * at the old flat 9 m. This is precisely the failure that
 * `scenery._clamp_off_track` exists to prevent for the wall itself.
 *
 * Using the LOCAL gap fixes most of it but not all: a 24 m car park at the
 * start line on Croft Bay still lands on the road. So the offset is only half
 * the answer, and every placement is resolved one of two ways —
 *
 *   `safeOutside`     for things that must exist (pit block, main stand): pull
 *                     in toward the wall until the spot is genuinely clear.
 *   `clearOfCircuit`  for things that are scattered anyway (trees, floodlights,
 *                     village houses): skip the ones that would land badly.
 *
 * Both live in `core/placement.ts`, where they can be tested — the bug was a
 * geometry mistake, not a rendering one.
 */

const GRID_BOX_L = 5.2
const GRID_BOX_W = 2.8

const GANTRY_H = 7.0
const GANTRY_BEAM_H = 1.7
const GANTRY_OFF = 2.4

export interface Scenery {
  root: THREE.Group
  /** Dressing that can disappear without removing the driver's landmarks. */
  decorativeRoot: THREE.Group
  dispose(): void
}

const vx = (x: number): number => x
const vz = (y: number): number => -y

function lcg(seed: number): () => number {
  let s = (seed ^ 0x2545f491) >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

/** Point in sim coordinates at arc ``s``, offset ``lat`` (positive = left). */
function at(track: Track, s: number, lat: number): { x: number; y: number; yaw: number } {
  const p = track.poseAt(s)
  return { x: p.x - Math.sin(p.yaw) * lat, y: p.y + Math.cos(p.yaw) * lat, yaw: p.yaw }
}

interface Strip {
  positions: number[]
  colors: number[]
}

const newStrip = (): Strip => ({ positions: [], colors: [] })

/** Quad with the same reversed winding world.ts uses; DoubleSide material
 *  makes the winding uncritical for the free-standing props. */
function quad(
  s: Strip,
  a: [number, number, number], b: [number, number, number],
  c: [number, number, number], d: [number, number, number],
  color: THREE.Color,
): void {
  s.positions.push(...a, ...c, ...b, ...a, ...d, ...c)
  for (let i = 0; i < 6; i++) s.colors.push(color.r, color.g, color.b)
}

/** Axis-aligned-in-local-frame box helper for strips, world coords. */
function box(
  s: Strip,
  cx: number, cz: number, yaw: number,
  w: number, d: number, y0: number, y1: number,
  color: THREE.Color,
): void {
  // Forward (local +x) and right (local +z) in three coordinates.
  const fx = Math.cos(yaw)
  const fz = -Math.sin(yaw)
  const rx = -fz
  const rz = fx
  const corner = (lx: number, lz: number, y: number): [number, number, number] => [
    cx + fx * lx + rx * lz, y, cz + fz * lx + rz * lz,
  ]
  const hw = w / 2
  const hd = d / 2
  // Four sides plus a lid.
  quad(s, corner(hw, -hd, y0), corner(hw, hd, y0), corner(hw, hd, y1), corner(hw, -hd, y1), color)
  quad(s, corner(-hw, hd, y0), corner(-hw, -hd, y0), corner(-hw, -hd, y1), corner(-hw, hd, y1), color)
  quad(s, corner(hw, hd, y0), corner(-hw, hd, y0), corner(-hw, hd, y1), corner(hw, hd, y1), color)
  quad(s, corner(-hw, -hd, y0), corner(hw, -hd, y0), corner(hw, -hd, y1), corner(-hw, -hd, y1), color)
  quad(s, corner(hw, -hd, y1), corner(hw, hd, y1), corner(-hw, hd, y1), corner(-hw, -hd, y1), color)
}

export function buildScenery(track: Track, terrain: Terrain): Scenery {
  const root = new THREE.Group()
  const decorativeRoot = new THREE.Group()
  root.add(decorativeRoot)
  const disposables: { dispose(): void }[] = []
  const rand = lcg(track.seed * 2654435761)

  // These few large forms are part of learning the circuit, not decoration:
  // the main stand and pit complex announce the final corner, while both
  // overhead structures divide long straights into readable pieces.
  const landmarks = newStrip()
  const solid = newStrip()
  const overlay = newStrip()

  buildGantry(track, landmarks)
  buildGridBoxes(track, overlay)
  buildBrakeBoards(track, landmarks)
  buildSponsorBoards(track, solid, rand)
  buildFloodlights(track, terrain, solid)
  buildTyresAndMarshals(track, terrain, solid, rand)
  buildServiceRoad(track, terrain, solid, overlay)
  buildBridge(track, landmarks)
  buildTower(track, landmarks)
  buildVillageAndRoads(track, terrain, solid, overlay, rand)
  buildCity(track, terrain, solid, rand)
  buildRiver(terrain, overlay)

  // --- grandstands and pit block around the start/finish -------------------
  // Main stand — the anchor, twice the size of anything else — on the left of
  // the pit straight looking at the line; a second along the exit; the pit
  // building opposite.
  buildStand(track, landmarks, rand, 0, 1, 80, 13)
  buildStand(track, landmarks, rand, 165, 1, 30, 9)
  buildPitBlock(track, landmarks, 0, -1)

  // Corner stands at the two sharpest corners, on the outside, where the
  // spectators would actually stand — and where you brake.
  for (const apex of terrain.corners.slice(0, 2)) {
    buildStand(track, solid, rand, apex.s, -Math.sign(apex.k) || 1, 24, 8)
  }

  decorativeRoot.add(buildCarPark(track, rand, disposables))

  const solidMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
  // DoubleSide for the same winding reason as world.ts's overlay: painted
  // marks built from mirrored offsets flip their winding on one side.
  const overlayMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  disposables.push(solidMat, overlayMat)

  for (const [strip, mat, parent] of [
    [landmarks, solidMat, root],
    [solid, solidMat, decorativeRoot],
    [overlay, overlayMat, decorativeRoot],
  ] as const) {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(strip.positions, 3))
    geom.setAttribute('color', new THREE.Float32BufferAttribute(strip.colors, 3))
    geom.computeVertexNormals()
    const mesh = new THREE.Mesh(geom, mat)
    // The player's car shadow is the grounding cue. Casting the entire
    // circuit's furniture into a moving shadow map costs far more than these
    // distant shadows contribute, particularly on integrated graphics.
    mesh.castShadow = false
    mesh.receiveShadow = false
    disposables.push(geom)
    parent.add(mesh)
  }

  decorativeRoot.add(buildCatchFence(track, disposables))
  const { hedges, treeSpots } = buildHedgerows(track, terrain, disposables)
  for (const m of hedges) decorativeRoot.add(m)
  for (const m of buildTrees(track, terrain, rand, disposables, treeSpots)) decorativeRoot.add(m)

  return {
    root,
    decorativeRoot,
    dispose(): void {
      for (const d of disposables) d.dispose()
    },
  }
}

/**
 * The perimeter service road: a grey ribbon running the whole way round the
 * outside of the circuit.
 *
 * This is connective tissue, not a prop. Buildings and huts standing alone on
 * grass read as scattered; the same objects fronting a road that visibly goes
 * somewhere read as an operation. The loop nets one full left turn, so the
 * outside of the circuit is consistently the right-hand side of travel.
 */
function buildServiceRoad(track: Track, terrain: Terrain, s: Strip, overlay: Strip): void {
  const road = new THREE.Color(PALETTE.TARMAC_FAR)
  const post = new THREE.Color(0x3a4048)
  const rail = new THREE.Color(0xb8bdc4)

  // Offsets from the wall, not from the painted edge. The wall's own standoff
  // varies along the lap — a metre and a half down a straight, tens of metres
  // across the outside of a quick corner — so a service road at a fixed offset
  // from the *road* would cross the barrier wherever the runoff opened up.
  const IN = 3.2
  const OUT = 5.6
  const FENCE = 5.9

  const step = 6
  let postDebt = 0
  for (let arc = 0; arc < track.length; arc += step) {
    const arc2 = Math.min(arc + step, track.length)
    const h0 = track.halfAt(arc) + track.barrierGapAt(arc, true)
    const h1 = track.halfAt(arc2) + track.barrierGapAt(arc2, true)
    const a = at(track, arc, -(h0 + IN))
    const b = at(track, arc2, -(h1 + IN))
    const c = at(track, arc2, -(h1 + OUT))
    const d = at(track, arc, -(h0 + OUT))
    const ya = terrain.height(a.x, a.y) + 0.008
    const yb = terrain.height(b.x, b.y) + 0.008
    const yc = terrain.height(c.x, c.y) + 0.008
    const yd = terrain.height(d.x, d.y) + 0.008
    quad(
      overlay,
      [vx(a.x), ya, vz(a.y)], [vx(b.x), yb, vz(b.y)],
      [vx(c.x), yc, vz(c.y)], [vx(d.x), yd, vz(d.y)],
      road,
    )

    // An offset curve can cross another part of a circuit that doubles back.
    // Test the whole short span against the collision wall and leave an honest
    // gap wherever a rail would otherwise cut through the track or barrier.
    const midArc = (arc + arc2) / 2
    const hm = track.halfAt(midArc) + track.barrierGapAt(midArc, true)
    const f0 = at(track, arc, -(h0 + FENCE))
    const fm = at(track, midArc, -(hm + FENCE))
    const f1 = at(track, arc2, -(h1 + FENCE))
    if (
      !clearOfCircuit(track, f0.x, f0.y, 0.15)
      || !clearOfCircuit(track, fm.x, fm.y, 0.15)
      || !clearOfCircuit(track, f1.x, f1.y, 0.15)
    ) continue

    const g0 = terrain.height(f0.x, f0.y)
    const g1 = terrain.height(f1.x, f1.y)
    for (const railY of [1.15, 2.05]) {
      quad(
        s,
        [vx(f0.x), g0 + railY, vz(f0.y)], [vx(f1.x), g1 + railY, vz(f1.y)],
        [vx(f1.x), g1 + railY + 0.08, vz(f1.y)], [vx(f0.x), g0 + railY + 0.08, vz(f0.y)],
        rail,
      )
    }
    postDebt += step
    if (postDebt >= 12) {
      postDebt = 0
      box(s, vx(f0.x), vz(f0.y), f0.yaw, 0.1, 0.1, g0, g0 + 2.2, post)
    }
  }
}

/**
 * A spectator footbridge over the longest straight away from the pits. The
 * one structure you pass *under* — it frames the view from half a kilometre
 * out, and every real circuit leans on one as a landmark.
 */
function buildBridge(track: Track, s: Strip): void {
  const leg = new THREE.Color(PALETTE.GANTRY_LEG)
  const deck = new THREE.Color(PALETTE.PIT_DECK)
  const wall = new THREE.Color(PALETTE.GANTRY_BANNER)

  // Longest low-curvature run whose midpoint is well away from the start.
  const step = 4
  let best: { mid: number; len: number } | null = null
  let runStart: number | null = null
  for (let arc = 0; arc <= track.length; arc += step) {
    const straight = arc < track.length && Math.abs(track.signedCurvatureAt(arc)) < 0.0022
    if (straight && runStart === null) runStart = arc
    if ((!straight || arc + step > track.length) && runStart !== null) {
      const len = arc - runStart
      const mid = runStart + len / 2
      const fromStart = Math.min(mid, track.length - mid)
      if (fromStart > 200 && (!best || len > best.len)) best = { mid, len }
      runStart = null
    }
  }
  if (!best || best.len < 70) return

  const sMid = best.mid
  const half = track.halfAt(sMid)
  const span = half + 2.6

  for (const side of [1, -1]) {
    const p = at(track, sMid, side * span)
    box(s, vx(p.x), vz(p.y), p.yaw, 1.5, 1.5, 0, 7.3, leg)
  }
  const centre = at(track, sMid, 0)
  box(s, vx(centre.x), vz(centre.y), centre.yaw, 3.4, span * 2, 6.1, 6.9, deck)
  // Solid parapets, which double as a banner surface facing both approaches.
  for (const off of [1.55, -1.55]) {
    const p = at(track, sMid + off, 0)
    box(s, vx(p.x), vz(p.y), p.yaw, 0.14, span * 2, 6.9, 8.0, wall)
  }
}

/** Race control: a tower by the pits tall enough to anchor the start complex. */
function buildTower(track: Track, s: Strip): void {
  const wall = new THREE.Color(PALETTE.PIT_WALL)
  const glass = new THREE.Color(0x1c2530)
  const deck = new THREE.Color(PALETTE.PIT_DECK)

  const off = safeOutsideBox(track, 30, -1, 18, 8, 8)
  if (off === null) return
  const p = at(track, 30, off)
  box(s, vx(p.x), vz(p.y), p.yaw, 8, 8, 0, 15.5, wall)
  for (let i = 0; i < 4; i++) {
    box(s, vx(p.x), vz(p.y), p.yaw, 8.3, 8.3, 2.6 + i * 3.3, 2.6 + i * 3.3 + 1.15, glass)
  }
  box(s, vx(p.x), vz(p.y), p.yaw, 10.5, 10.5, 15.5, 16.4, deck)
}

/** A car park behind the main grandstand, with the cars in it. Nothing says
 *  "people are here" like a hundred windscreens in rows. */
function buildCarPark(
  track: Track, rand: () => number, disposables: { dispose(): void }[],
): THREE.Object3D {
  const group = new THREE.Group()
  // Close enough in that the whole patch sits inside the flat corridor —
  // pushed further out its far edge starts riding the outfield rolls and the
  // parked cars float.
  // 46 x 18 of tarmac on a single pose. It is the largest straight slab in the
  // scene, so it is the one most likely to be refused outright on a tight
  // circuit — which is the correct outcome. A car park in the middle of the
  // road at Croft Bay's start line is worse than no car park.
  const parkOff = safeOutsideBox(track, 8, 1, 24, 46, 18)
  if (parkOff === null) return group
  const centre = at(track, 8, parkOff)
  const yaw = centre.yaw

  const patch = newStrip()
  const grey = new THREE.Color(PALETTE.TARMAC_FAR).lerp(new THREE.Color(0x888c94), 0.35)
  box(patch, vx(centre.x), vz(centre.y), yaw, 46, 18, -0.02, 0.02, grey)
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(patch.positions, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(patch.colors, 3))
  geom.computeVertexNormals()
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true })
  disposables.push(geom, mat)
  group.add(new THREE.Mesh(geom, mat))

  const paints = [0xd8dade, 0x22242a, 0x9aa0a8, 0x8c2f2a, 0x2c4f86, 0x515760].map(
    (c) => new THREE.Color(c),
  )
  const carGeom = new THREE.BoxGeometry(4.1, 1.35, 1.72)
  carGeom.translate(0, 0.68, 0)
  const carMat = new THREE.MeshLambertMaterial({})
  disposables.push(carGeom, carMat)

  const spots: { x: number; y: number; a: number; c: THREE.Color }[] = []
  const fx = Math.cos(yaw)
  const fy = Math.sin(yaw)
  const nx = -fy
  const ny = fx
  for (let row = -1; row <= 1; row += 1) {
    for (let col = -4; col <= 4; col++) {
      if (rand() < 0.22) continue // empty bays, like a real car park
      const lx = col * 4.9 + (rand() - 0.5) * 0.5
      const lz = row * 5.8 + (rand() - 0.5) * 0.4
      spots.push({
        x: centre.x + fx * lx + nx * lz,
        y: centre.y + fy * lx + ny * lz,
        a: yaw + Math.PI / 2 + (rand() - 0.5) * 0.09,
        c: paints[Math.floor(rand() * paints.length)]!,
      })
    }
  }
  if (spots.length > 0) {
    const cars = new THREE.InstancedMesh(carGeom, carMat, spots.length)
    cars.castShadow = false
    disposables.push(cars)
    const m = new THREE.Matrix4()
    const e = new THREE.Euler()
    const q = new THREE.Quaternion()
    const one = new THREE.Vector3(1, 1, 1)
    for (let i = 0; i < spots.length; i++) {
      const sp = spots[i]!
      e.set(0, sp.a, 0)
      q.setFromEuler(e)
      m.compose(new THREE.Vector3(vx(sp.x), 0, vz(sp.y)), q, one)
      cars.setMatrixAt(i, m)
      cars.setColorAt(i, sp.c)
    }
    cars.instanceMatrix.needsUpdate = true
    if (cars.instanceColor) cars.instanceColor.needsUpdate = true
    group.add(cars)
  }
  return group
}

/**
 * A pitched roof: two sloped faces plus gable triangles. This one shape is
 * most of the difference between "box" and "building" — a flat-topped box
 * reads as a container, the same box under a gable reads as a house.
 */
function roofPrism(
  s: Strip,
  cx: number, cz: number, yaw: number,
  w: number, d: number, eaveY: number, ridgeY: number,
  color: THREE.Color,
): void {
  const fx = Math.cos(yaw)
  const fz = -Math.sin(yaw)
  const rx = -fz
  const rz = fx
  const corner = (lx: number, lz: number, y: number): [number, number, number] => [
    cx + fx * lx + rx * lz, y, cz + fz * lx + rz * lz,
  ]
  const hw = w / 2
  const hd = d / 2
  // Two slopes up to a ridge along the local x axis.
  quad(s, corner(-hw, -hd, eaveY), corner(hw, -hd, eaveY), corner(hw, 0, ridgeY), corner(-hw, 0, ridgeY), color)
  quad(s, corner(hw, hd, eaveY), corner(-hw, hd, eaveY), corner(-hw, 0, ridgeY), corner(hw, 0, ridgeY), color)
  // Gable ends, as triangles (a quad with two coincident corners).
  quad(s, corner(hw, -hd, eaveY), corner(hw, hd, eaveY), corner(hw, 0, ridgeY), corner(hw, 0, ridgeY), color)
  quad(s, corner(-hw, hd, eaveY), corner(-hw, -hd, eaveY), corner(-hw, 0, ridgeY), corner(-hw, 0, ridgeY), color)
}

/**
 * The built world beyond the fence: an access road leaving the circuit, a
 * village along it, and a paddock cluster behind the pits.
 *
 * This is the layer the props could not provide on their own. Sports
 * furniture — stands, masts, huts — says "an event is here"; houses with
 * pitched roofs on a road that visibly leaves the circuit say "here is
 * somewhere". The road matters as much as the buildings: structures scattered
 * on grass read as debris, the same structures along a road read as a place.
 */
function buildVillageAndRoads(
  track: Track, terrain: Terrain, s: Strip, overlay: Strip, rand: () => number,
): void {
  const roadCol = new THREE.Color(PALETTE.TARMAC_FAR)
  const walls = [0xd8d2c4, 0xcfc6b4, 0x9c5a40, 0xdedad0, 0xb9a88e].map((c) => new THREE.Color(c))
  const roofs = [0x71453a, 0x555a62, 0x8a4038, 0x4a4e56].map((c) => new THREE.Color(c))
  const dark = new THREE.Color(0x2a2d33)

  // --- the access road. If the terrain carved a lake, the road runs from the
  // service road at the END OF THE LAKE'S STRAIGHT out to the shore — so both
  // road and village sit inside the sightline you hold for the whole run down
  // that straight, instead of off in a corner of the map nobody looks at.
  let anchorArc = 60
  let target: { x: number; y: number } | null = null
  if (terrain.river && terrain.river.pts.length > 0) {
    // The village goes by the river: aim at its midpoint, anchored at the
    // nearest piece of service road.
    const mid = terrain.river.pts[Math.floor(terrain.river.pts.length / 2)]!
    let bestD = Infinity
    for (let arc = 0; arc < track.length; arc += 8) {
      const q = track.poseAt(arc)
      const dd = Math.hypot(q.x - mid.x, q.y - mid.y)
      if (dd < bestD) {
        bestD = dd
        anchorArc = arc
      }
    }
    target = mid
  }
  const standOff = safeOutside(track, anchorArc, -1, 5.6)
  if (standOff === null) return
  const p0 = at(track, anchorArc, standOff)
  const pose = track.poseAt(anchorArc)
  // Outward = minus the left normal on this side.
  const ox = Math.sin(pose.yaw)
  const oy = -Math.cos(pose.yaw)
  let p1: { x: number; y: number }
  let p2: { x: number; y: number }
  if (target) {
    // Stop at the shore, bending in from the service road.
    const toLx = target.x - p0.x
    const toLy = target.y - p0.y
    const dist = Math.max(Math.hypot(toLx, toLy), 1e-6)
    // Stop short of the river bank.
    const shore = dist - (terrain.river!.width / 2 + 26)
    p2 = { x: p0.x + (toLx / dist) * shore, y: p0.y + (toLy / dist) * shore }
    p1 = { x: p0.x + (toLx / dist) * shore * 0.45 + ox * 28, y: p0.y + (toLy / dist) * shore * 0.45 + oy * 28 }
  } else {
    p1 = { x: p0.x + ox * 210 + Math.cos(pose.yaw) * 60, y: p0.y + oy * 210 + Math.sin(pose.yaw) * 60 }
    p2 = { x: p0.x + ox * 430 + Math.cos(pose.yaw) * 190, y: p0.y + oy * 430 + Math.sin(pose.yaw) * 190 }
  }

  const path: { x: number; y: number }[] = []
  const N = 26
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const a = (1 - t) * (1 - t)
    const b = 2 * (1 - t) * t
    const c = t * t
    path.push({ x: a * p0.x + b * p1.x + c * p2.x, y: a * p0.y + b * p1.y + c * p2.y })
  }
  const ROAD_W = 5.2
  for (let i = 0; i < N; i++) {
    const a = path[i]!
    const b = path[i + 1]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.max(Math.hypot(dx, dy), 1e-9)
    const nx = (-dy / len) * (ROAD_W / 2)
    const ny = (dx / len) * (ROAD_W / 2)
    const ya = terrain.height(a.x, a.y) + 0.015
    const yb = terrain.height(b.x, b.y) + 0.015
    quad(
      overlay,
      [vx(a.x - nx), ya, vz(a.y - ny)], [vx(b.x - nx), yb, vz(b.y - ny)],
      [vx(b.x + nx), yb, vz(b.y + ny)], [vx(a.x + nx), ya, vz(a.y + ny)],
      roadCol,
    )
  }

  // --- houses along the far half of the road, gables facing it.
  for (let i = Math.floor(N * 0.45); i < N; i += 2) {
    const a = path[i]!
    const b = path[i + 1]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.max(Math.hypot(dx, dy), 1e-9)
    const roadYaw = Math.atan2(dy, dx)
    for (const side of [1, -1]) {
      if (rand() > 0.72) continue
      const setback = 9 + rand() * 10
      const hx = a.x + (-dy / len) * side * setback
      const hy = a.y + (dx / len) * side * setback
      // The hard rule that ends "a house inside the barriers": no building
      // exists unless a projection proves it stands well beyond the wall.
      // (The terrain field is exact this close to the road.)
      if (!clearOfCircuit(track, hx, hy, 8)) continue
      const base = terrain.height(hx, hy)
      const w = 7 + rand() * 5
      const d = 5.5 + rand() * 3
      const hWall = 2.8 + rand() * 1.2
      const yaw = roadYaw + (rand() - 0.5) * 0.15
      const wall = walls[Math.floor(rand() * walls.length)]!
      const roof = roofs[Math.floor(rand() * roofs.length)]!
      // Sunk slightly so a sloped lawn never shows a floating corner.
      box(s, vx(hx), vz(hy), yaw, w, d, base - 0.4, base + hWall, wall)
      roofPrism(s, vx(hx), vz(hy), yaw, w + 0.5, d + 0.5, base + hWall, base + hWall + 1.9 + rand(), roof)
      // A door, on the road side, offset along the wall's own direction.
      const doorLat = -side * (d / 2 + 0.02)
      const dcx = hx - Math.sin(yaw) * doorLat
      const dcy = hy + Math.cos(yaw) * doorLat
      const wx = Math.cos(yaw) * 0.55
      const wy = Math.sin(yaw) * 0.55
      quad(
        s,
        [vx(dcx - wx), base, vz(dcy - wy)], [vx(dcx + wx), base, vz(dcy + wy)],
        [vx(dcx + wx), base + 2.0, vz(dcy + wy)], [vx(dcx - wx), base + 2.0, vz(dcy - wy)],
        dark,
      )
    }
  }

  // A barn at the village end — one bigger mass so the cluster has a centre.
  // By the lake this lands at the shore: the boathouse.
  {
    const e = path[N]!
    if (clearOfCircuit(track, e.x, e.y, footprintMargin(17, 10))) {
      const base = terrain.height(e.x, e.y)
      const yaw = Math.atan2(e.y - path[N - 1]!.y, e.x - path[N - 1]!.x)
      box(s, vx(e.x), vz(e.y), yaw, 16, 9, base - 0.4, base + 5, new THREE.Color(0x8a4038))
      roofPrism(s, vx(e.x), vz(e.y), yaw, 17, 10, base + 5, base + 8, new THREE.Color(0x555a62))
    }
  }

  // A footbridge over the river at the village, because a river nobody
  // crosses is a moat. Deck rides just above the water ribbon.
  if (terrain.river && target) {
    const e = path[N]!
    const toX = target.x - e.x
    const toY = target.y - e.y
    const dl = Math.max(Math.hypot(toX, toY), 1e-6)
    const jx = toX / dl
    const jy = toY / dl
    const span = terrain.river.width + 18
    const a = { x: e.x + jx * 8, y: e.y + jy * 8 }
    const b = { x: e.x + jx * (8 + span), y: e.y + jy * (8 + span) }
    const nx = -jy * 1.3
    const ny = jx * 1.3
    const ya = terrain.height(a.x, a.y) + 1.1
    const yb = terrain.height(b.x, b.y) + 1.1
    quad(
      s,
      [vx(a.x - nx), ya, vz(a.y - ny)], [vx(b.x - nx), yb, vz(b.y - ny)],
      [vx(b.x + nx), yb, vz(b.y + ny)], [vx(a.x + nx), ya, vz(a.y + ny)],
      new THREE.Color(0x6b503a),
    )
  }

  // --- paddock cluster behind the pits: hospitality blocks off the service
  // road, stepped in height so the roofline is a skyline, not a wall.
  for (let i = 0; i < 4; i++) {
    const arc = 95 + i * 26
    const blockOff = safeOutsideBox(
      track, arc, -1, 13 + (i % 2) * 9, 14 + (i % 2) * 6, 9,
    )
    if (blockOff === null) continue
    const p = at(track, arc, blockOff)
    const base = terrain.height(p.x, p.y)
    const tall = 4 + (i % 3) * 2.2
    const wall = walls[(i + 1) % walls.length]!
    box(s, vx(p.x), vz(p.y), p.yaw, 14 + (i % 2) * 6, 9, base - 0.3, base + tall, wall)
    box(s, vx(p.x), vz(p.y), p.yaw, 15 + (i % 2) * 6, 10, base + tall, base + tall + 0.5, dark)
  }
}

/**
 * The river: a ribbon draped just above the terrain, following it exactly.
 * That conformance is the whole trick — a flat water plane hides behind every
 * wall and rise, but water lying ON the slopes is visible wherever the slopes
 * are, which out here is exactly where the driver looks. Physically a river
 * should not climb a hill; at 400 m, read as a valley winding across the
 * landscape, nobody has ever objected.
 */
function buildRiver(terrain: Terrain, s: Strip): void {
  if (!terrain.river) return
  const water = new THREE.Color(0x3f6f9e)
  const shore = new THREE.Color(0x8a8468)
  const pts = terrain.river.pts
  const hw = terrain.river.width / 2
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.max(Math.hypot(dx, dy), 1e-9)
    const nx = -dy / len
    const ny = dx / len
    const put = (w0: number, w1: number, lift: number, c: THREE.Color): void => {
      const a0 = { x: a.x + nx * w0, y: a.y + ny * w0 }
      const a1 = { x: a.x + nx * w1, y: a.y + ny * w1 }
      const b0 = { x: b.x + nx * w0, y: b.y + ny * w0 }
      const b1 = { x: b.x + nx * w1, y: b.y + ny * w1 }
      quad(
        s,
        [vx(a0.x), terrain.height(a0.x, a0.y) + lift, vz(a0.y)],
        [vx(b0.x), terrain.height(b0.x, b0.y) + lift, vz(b0.y)],
        [vx(b1.x), terrain.height(b1.x, b1.y) + lift, vz(b1.y)],
        [vx(a1.x), terrain.height(a1.x, a1.y) + lift, vz(a1.y)],
        c,
      )
    }
    // Sandy margins first, water over them: a river with edges, not a stripe.
    put(-hw - 5, hw + 5, 0.28, shore)
    put(-hw, hw, 0.42, water)
  }
}

/**
 * The skyline: a handful of towers far beyond the end of the longest straight
 * — the same straight that carries the footbridge, so the frame you hold the
 * longest is bridge in the mid-ground, city on the horizon. Tall enough to
 * read over the hills from half the lap.
 */
function buildCity(track: Track, terrain: Terrain, s: Strip, rand: () => number): void {
  const run = terrain.runs[0]
  if (!run || run.len < 100) return
  const end = track.poseAt(run.s1)
  const dx = Math.cos(end.yaw)
  const dy = Math.sin(end.yaw)
  const cx = end.x + dx * 640
  const cy = end.y + dy * 640

  const concrete = new THREE.Color(0xaeb4bd)
  const concreteB = new THREE.Color(0x8f97a2)
  const glass = new THREE.Color(0x27333f)

  const towers = 6
  for (let i = 0; i < towers; i++) {
    const ox = (rand() - 0.5) * 260
    const oy = (rand() - 0.5) * 200
    const tx = cx + ox
    const ty = cy + oy
    const base = terrain.height(tx, ty) - 1
    const w = 16 + rand() * 12
    const depth = w * (0.7 + rand() * 0.5)
    const h = 48 + rand() * 70
    const yaw = end.yaw + (rand() - 0.5) * 0.6
    const wall = rand() < 0.5 ? concrete : concreteB
    box(s, vx(tx), vz(ty), yaw, w, depth, base, base + h, wall)
    // Glass floor-bands every ~7 m, just proud of the wall: the horizontal
    // striping is what reads as "building with floors" instead of "monolith".
    for (let y = base + 6; y < base + h - 4; y += 7) {
      box(s, vx(tx), vz(ty), yaw, w + 0.35, depth + 0.35, y, y + 2.6, glass)
    }
    // A plant block on the roof breaks the silhouette.
    box(s, vx(tx), vz(ty), yaw, w * 0.4, depth * 0.35, base + h, base + h + 4, glass)
  }
}

/**
 * Hedgerows on the field boundaries, some carrying a line of trees — the
 * mid-ground layer between the trackside and the hills. The 95 m lattice
 * matches the field patchwork painted into the ground mesh, so the hedges sit
 * on the colour boundaries they belong to.
 */
function buildHedgerows(
  track: Track, terrain: Terrain, disposables: { dispose(): void }[],
): { hedges: THREE.Object3D[]; treeSpots: { x: number; y: number }[] } {
  const spots: { x: number; y: number; s: number }[] = []
  const treeSpots: { x: number; y: number }[] = []

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < track.n; i++) {
    minX = Math.min(minX, track.cx[i]!)
    maxX = Math.max(maxX, track.cx[i]!)
    minY = Math.min(minY, track.cy[i]!)
    maxY = Math.max(maxY, track.cy[i]!)
  }
  const pad = 430
  const cell = 95

  const edgeHash = (a: number, b: number, salt: number): number => {
    let h = (a * 374761393 + b * 668265263 + (track.seed + salt) * 69069) >>> 0
    h = ((h ^ (h >> 13)) * 1274126177) >>> 0
    return ((h ^ (h >> 16)) >>> 0) / 0xffffffff
  }

  const walk = (vertical: boolean): void => {
    const lo0 = vertical ? Math.floor((minX - pad) / cell) : Math.floor((minY - pad) / cell)
    const hi0 = vertical ? Math.ceil((maxX + pad) / cell) : Math.ceil((maxY + pad) / cell)
    const lo1 = vertical ? minY - pad : minX - pad
    const hi1 = vertical ? maxY + pad : maxX + pad
    for (let line = lo0; line <= hi0; line++) {
      const fixed = line * cell
      for (let t = lo1; t < hi1; t += 9) {
        const cellIdx = Math.floor(t / cell)
        const r = edgeHash(line, cellIdx, vertical ? 11 : 23)
        if (r > 0.42) continue // most boundaries have no hedge
        // Gaps within a hedge line: at 6 m spacing with 3.6 m boxes the row
        // fused into a continuous rampart that read as a black wall across
        // the horizon. Real hedgerows are broken things.
        if (edgeHash(line, cellIdx * 977 + Math.floor(t / 9), 31) < 0.3) continue
        const x = vertical ? fixed : t + 3
        const y = vertical ? t + 3 : fixed
        // Through the terrain's cached distance field — exact near the road,
        // interpolated far away, which is all a 95 m threshold needs.
        const d = terrain.heightAndDist(x, y).d
        if (d < 95 || d > 460) continue
        spots.push({ x, y, s: 0.6 + edgeHash(line, cellIdx + 1000 + Math.floor(t), 7) * 0.5 })
        // Some hedges carry a tree line.
        if (r < 0.13 && Math.floor(t) % 27 < 9) treeSpots.push({ x, y })
      }
    }
  }
  walk(true)
  walk(false)

  if (spots.length === 0) return { hedges: [], treeSpots }

  const hedgeGeom = new THREE.BoxGeometry(3.4, 1.15, 1.6)
  hedgeGeom.translate(0, 0.57, 0)
  // Kept close to the tree greens: the first colour went near-black in side
  // light, and a row of them at distance read as a wall, not a hedge.
  const hedgeMat = new THREE.MeshLambertMaterial({ color: 0x35703e })
  disposables.push(hedgeGeom, hedgeMat)
  const hedges = new THREE.InstancedMesh(hedgeGeom, hedgeMat, spots.length)
  disposables.push(hedges)
  const m = new THREE.Matrix4()
  for (let i = 0; i < spots.length; i++) {
    const sp = spots[i]!
    m.makeScale(sp.s, sp.s, sp.s)
    m.setPosition(vx(sp.x), terrain.height(sp.x, sp.y), vz(sp.y))
    hedges.setMatrixAt(i, m)
  }
  hedges.instanceMatrix.needsUpdate = true
  return { hedges: [hedges], treeSpots }
}

/**
 * Sponsor hoardings riding the barrier crest along the straights — the single
 * most "circuit" texture there is (look at any onboard: the walls are a strip
 * of colour blocks streaming past). No text: at speed a coloured panel with a
 * white margin *reads* as advertising without a single glyph.
 */
function buildSponsorBoards(track: Track, s: Strip, rand: () => number): void {
  const colours = [0xc23a30, 0xf0f0f4, 0x2e6cbe, 0x1f8a4c, 0xe8be28, 0x22252b].map(
    (c) => new THREE.Color(c),
  )
  const white = new THREE.Color(0xf2f3f6)
  const boardW = 4.4
  let debt = 0
  for (let arc = 0; arc < track.length; arc += 2) {
    debt += 2
    if (debt < 26) continue
    if (Math.abs(track.signedCurvatureAt(arc)) > 0.0025) continue // straights only
    debt = 0
    for (const side of [1, -1]) {
      if (rand() > 0.75) continue
      // Hung on the wall's actual face, wherever that is here — the whole point
      // of a hoarding is that it is *on* the barrier streaming past you.
      const half = track.halfAt(arc) + track.barrierGapAt(arc, side < 0)
      const c = at(track, arc, side * (half - 0.06))
      const fx = Math.cos(c.yaw)
      const fy = Math.sin(c.yaw)
      const a = { x: c.x - fx * (boardW / 2), y: c.y - fy * (boardW / 2) }
      const b = { x: c.x + fx * (boardW / 2), y: c.y + fy * (boardW / 2) }
      // White backing panel proud of the wall, colour block inside it.
      quad(
        s,
        [vx(a.x), 1.05, vz(a.y)], [vx(b.x), 1.05, vz(b.y)],
        [vx(b.x), 2.0, vz(b.y)], [vx(a.x), 2.0, vz(a.y)],
        white,
      )
      const inset = 0.32
      const ai = { x: a.x + fx * inset, y: a.y + fy * inset }
      const bi = { x: b.x - fx * inset, y: b.y - fy * inset }
      const col = colours[Math.floor(rand() * colours.length)]!
      const n2x = -Math.sin(c.yaw) * side * 0.03
      const n2y = Math.cos(c.yaw) * side * 0.03
      quad(
        s,
        [vx(ai.x - n2x), 1.18, vz(ai.y - n2y)], [vx(bi.x - n2x), 1.18, vz(bi.y - n2y)],
        [vx(bi.x - n2x), 1.87, vz(bi.y - n2y)], [vx(ai.x - n2x), 1.87, vz(ai.y - n2y)],
        col,
      )
    }
  }
}

/** Floodlight masts: verticality, and something for the eye to range off.
 *  Placed beyond the service road, standing on the terrain. */
function buildFloodlights(track: Track, terrain: Terrain, s: Strip): void {
  const leg = new THREE.Color(PALETTE.GANTRY_LEG)
  const head = new THREE.Color(PALETTE.STAND_ROOF)
  const lamp = new THREE.Color(0xf4f6f0)
  let n = 0
  for (let arc = 90; arc < track.length - 60; arc += 170) {
    const side = n++ % 2 === 0 ? 1 : -1
    const p = at(track, arc, outsideWall(track, arc, side, 7.2))
    // A pylon that walked back onto a distant part of the lap would be a
    // floodlight in the middle of the road. Skip rather than shuffle it: the
    // spacing is decorative, and one missing mast reads as nothing at all.
    if (!clearOfCircuit(track, p.x, p.y, 4)) continue
    const base = terrain.height(p.x, p.y)
    box(s, vx(p.x), vz(p.y), p.yaw, 0.24, 0.24, base, base + 9.5, leg)
    box(s, vx(p.x), vz(p.y), p.yaw, 1.5, 0.5, base + 9.5, base + 10.3, head)
    // A pale face angled at the road, so it reads as a light and not a box.
    const nx = -Math.sin(p.yaw) * side
    const ny = Math.cos(p.yaw) * side
    const a = at(track, arc - 0.7, outsideWall(track, arc - 0.7, side, 7.2))
    const b = at(track, arc + 0.7, outsideWall(track, arc + 0.7, side, 7.2))
    quad(
      s,
      [vx(a.x - nx * 0.26), base + 9.55, vz(a.y - ny * 0.26)],
      [vx(b.x - nx * 0.26), base + 9.55, vz(b.y - ny * 0.26)],
      [vx(b.x - nx * 0.1), base + 10.25, vz(b.y - ny * 0.1)],
      [vx(a.x - nx * 0.1), base + 10.25, vz(a.y - ny * 0.1)],
      lamp,
    )
  }
}

/** Tyre stacks arcing round the outside of the sharp corners, plus a marshal
 *  hut with its flag at the two sharpest — the corner-worker furniture that
 *  says somebody expects cars to arrive too fast here. */
function buildTyresAndMarshals(
  track: Track, terrain: Terrain, s: Strip, rand: () => number,
): void {
  const tyre = new THREE.Color(0x1b1d21)
  const band = new THREE.Color(0xe8eaee)
  const hutWall = new THREE.Color(0xdadde2)
  const hutRoof = new THREE.Color(0xd06018)
  const flag = new THREE.Color(0xe8a020)

  const corners = terrain.corners
  for (let ci = 0; ci < corners.length; ci++) {
    const corner = corners[ci]!
    const out = -Math.sign(corner.k) || 1
    // A loose arc of stacks through the corner, between kerb and wall.
    const count = 5 + Math.floor(rand() * 3)
    for (let i = 0; i < count; i++) {
      const arc = corner.s + (i - count / 2) * 9 + (rand() - 0.5) * 4
      const half = track.halfAt(arc)
      const p = at(track, arc, out * (half + 2.8 + rand() * 1.6))
      box(s, vx(p.x), vz(p.y), p.yaw, 0.72, 0.72, 0, 0.72, tyre)
      box(s, vx(p.x), vz(p.y), p.yaw, 0.74, 0.74, 0.72, 0.9, band)
    }
    // Marshal post at the two sharpest only.
    if (ci < 2) {
      const half = track.halfAt(corner.s)
      const p = at(track, corner.s - 30, out * (half + 5.5))
      box(s, vx(p.x), vz(p.y), p.yaw, 2.0, 2.0, 0, 2.1, hutWall)
      box(s, vx(p.x), vz(p.y), p.yaw, 2.3, 2.3, 2.1, 2.35, hutRoof)
      box(s, vx(p.x), vz(p.y), p.yaw, 0.08, 0.08, 0, 3.8, tyre)
      const fx = Math.cos(p.yaw)
      const fy = Math.sin(p.yaw)
      quad(
        s,
        [vx(p.x), 3.75, vz(p.y)], [vx(p.x + fx * 0.85), 3.62, vz(p.y + fy * 0.85)],
        [vx(p.x + fx * 0.85), 3.3, vz(p.y + fy * 0.85)], [vx(p.x), 3.35, vz(p.y)],
        flag,
      )
    }
  }
}

/**
 * Taller catch fencing behind the pit-straight concrete wall. It follows the
 * wall's baked per-point offset and is clipped anywhere the closed circuit
 * folds close enough that the fence would land inside another barrier.
 */
function buildCatchFence(track: Track, disposables: { dispose(): void }[]): THREE.Object3D {
  const group = new THREE.Group()
  const posts = newStrip()
  const panels = newStrip()
  const post = new THREE.Color(0x2c2f36)
  const dark = new THREE.Color(0x14161a)
  const spans: [number, number][] = [
    [-30, 30],
    [125, 175],
  ]
  const BEHIND_WALL = 0.55

  for (const [s0, s1] of spans) {
    for (let arc = s0; arc <= s1; arc += 4) {
      const half = track.halfAt(arc) + track.barrierGapAt(arc, false)
      const p = at(track, arc, half + BEHIND_WALL)
      if (!clearOfCircuit(track, p.x, p.y, 0.1)) continue

      box(posts, vx(p.x), vz(p.y), p.yaw, 0.09, 0.09, 1.05, 3.4, post)
      if (arc >= s1) continue

      const arc2 = Math.min(arc + 4, s1)
      const half2 = track.halfAt(arc2) + track.barrierGapAt(arc2, false)
      const q = at(track, arc2, half2 + BEHIND_WALL)
      const midArc = (arc + arc2) / 2
      const halfMid = track.halfAt(midArc) + track.barrierGapAt(midArc, false)
      const m = at(track, midArc, halfMid + BEHIND_WALL)
      if (
        !clearOfCircuit(track, q.x, q.y, 0.1)
        || !clearOfCircuit(track, m.x, m.y, 0.1)
      ) continue

      quad(
        panels,
        [vx(p.x), 1.1, vz(p.y)], [vx(q.x), 1.1, vz(q.y)],
        [vx(q.x), 3.35, vz(q.y)], [vx(p.x), 3.35, vz(p.y)],
        dark,
      )
    }
  }

  const postMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
  const panelMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  disposables.push(postMat, panelMat)
  for (const [strip, material] of [
    [posts, postMat],
    [panels, panelMat],
  ] as const) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(strip.positions, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(strip.colors, 3))
    geometry.computeVertexNormals()
    disposables.push(geometry)
    group.add(new THREE.Mesh(geometry, material))
  }
  return group
}

/** Start-line gantry: two legs and a banner beam over the track. */
function buildGantry(track: Track, s: Strip): void {
  const half = track.halfRing[0]!
  const leg = new THREE.Color(PALETTE.GANTRY_LEG)
  const banner = new THREE.Color(PALETTE.GANTRY_BANNER)
  const stripe = new THREE.Color(PALETTE.GANTRY_STRIPE)

  const off = half + GANTRY_OFF
  const pose = track.poseAt(0)
  for (const side of [1, -1]) {
    const p = at(track, 0, side * off)
    box(s, vx(p.x), vz(p.y), pose.yaw, 0.5, 0.5, 0, GANTRY_H + GANTRY_BEAM_H, leg)
  }

  const l = at(track, 0, off)
  const r = at(track, 0, -off)
  const a: [number, number, number] = [vx(l.x), GANTRY_H, vz(l.y)]
  const b: [number, number, number] = [vx(r.x), GANTRY_H, vz(r.y)]
  const c: [number, number, number] = [vx(r.x), GANTRY_H + GANTRY_BEAM_H, vz(r.y)]
  const d: [number, number, number] = [vx(l.x), GANTRY_H + GANTRY_BEAM_H, vz(l.y)]
  quad(s, a, b, c, d, banner)
  // White stripe across the banner's lower edge.
  const c2: [number, number, number] = [vx(r.x), GANTRY_H + 0.34, vz(r.y)]
  const d2: [number, number, number] = [vx(l.x), GANTRY_H + 0.34, vz(l.y)]
  quad(s, a, b, c2, d2, stripe)
}

/** Painted grid boxes behind the line — the ones the race server stages on. */
function buildGridBoxes(track: Track, s: Strip): void {
  const paint = new THREE.Color(PALETTE.GRID_PAINT)
  const lw = 0.12
  for (let i = 0; i < GRID_SLOTS; i++) {
    const centre = gridPose(track, i)
    const yaw = centre.yaw
    const edge = (
      lx0: number, lz0: number, lx1: number, lz1: number, w: number,
    ): void => {
      // Edge from local (lx0,lz0) to (lx1,lz1), painted w wide, on the road.
      const fx = Math.cos(yaw)
      const fy = Math.sin(yaw)
      const nx = -fy
      const ny = fx
      const p0 = { x: centre.x + fx * lx0 + nx * lz0, y: centre.y + fy * lx0 + ny * lz0 }
      const p1 = { x: centre.x + fx * lx1 + nx * lz1, y: centre.y + fy * lx1 + ny * lz1 }
      const dx = p1.x - p0.x
      const dy = p1.y - p0.y
      const len = Math.max(Math.hypot(dx, dy), 1e-9)
      const ox = (-dy / len) * (w / 2)
      const oy = (dx / len) * (w / 2)
      quad(
        s,
        [vx(p0.x - ox), 0.012, vz(p0.y - oy)],
        [vx(p1.x - ox), 0.012, vz(p1.y - oy)],
        [vx(p1.x + ox), 0.012, vz(p1.y + oy)],
        [vx(p0.x + ox), 0.012, vz(p0.y + oy)],
        paint,
      )
    }
    const hl = GRID_BOX_L / 2
    const hw = GRID_BOX_W / 2
    edge(hl, -hw, hl, hw, lw) // front line
    edge(hl, -hw, -hl, -hw, lw) // sides
    edge(hl, hw, -hl, hw, lw)
  }
}

/** Brake boards at 50 m (amber) and 20 m (red), on the outside of the corner. */
function buildBrakeBoards(track: Track, s: Strip): void {
  const post = new THREE.Color(PALETTE.BRAKE_POST)
  for (const m of track.brakeMarkers) {
    const accent = new THREE.Color(
      m.distance >= 50 ? PALETTE.BRAKE_ACCENT_FAR : PALETTE.BRAKE_ACCENT_NEAR,
    )
    const half = track.halfAt(m.s)
    const p = at(track, m.s, m.side * (half + 2.3))
    box(s, vx(p.x), vz(p.y), p.yaw, 0.1, 0.1, 0, 1.3, post)
    // The board: a panel facing oncoming traffic (its width runs across the
    // travel direction), with a dark frame behind it for depth.
    const nx = -Math.sin(p.yaw)
    const ny = Math.cos(p.yaw)
    const w = 0.62
    const a = { x: p.x - nx * w, y: p.y - ny * w }
    const b = { x: p.x + nx * w, y: p.y + ny * w }
    quad(
      s,
      [vx(a.x), 1.3, vz(a.y)],
      [vx(b.x), 1.3, vz(b.y)],
      [vx(b.x), 2.1, vz(b.y)],
      [vx(a.x), 2.1, vz(a.y)],
      accent,
    )
  }
}

/**
 * A grandstand: a raked bleacher whose risers are blocks of crowd colour,
 * under a cantilever roof. The alternating blocks are what make it read as
 * *people* at speed — a flat grey wedge reads as a warehouse.
 */
function buildStand(
  track: Track, s: Strip, rand: () => number,
  sArc: number, side: number, length: number, rows = 9,
): void {
  const concrete = new THREE.Color(PALETTE.STAND_CONCRETE)
  const roof = new THREE.Color(PALETTE.STAND_ROOF)
  const crowd = PALETTE.CROWD.map((c) => new THREE.Color(c))

  // The stand FOLLOWS THE ROAD, like real ones do. The first version was a
  // straight slab anchored at one pose; anchored at the start line, its rear
  // half spanned the last forty metres of the lap, and where the road curved
  // in behind the line the straight slab swung across the track. Every point
  // is now placed by (arc offset along the road, depth away from it), so the
  // stand bends with whatever the road does underneath it.
  // Every point of the stand is resolved separately, so it can taper in where
  // the road crowds it. A null here means this slice has nowhere to go at all;
  // it falls back to hugging the wall rather than tearing a hole in the mesh,
  // and the whole stand is skipped up front if its anchor cannot be placed.
  const P = (dz: number, depth: number): { x: number; y: number } => {
    const arc = sArc + dz
    return at(
      track, arc,
      safeOutside(track, arc, side, 5.5 + depth) ?? outsideWall(track, arc, side, 0.4),
    )
  }
  if (safeOutside(track, sArc, side, 5.5) === null) return

  const riser = 0.46
  const tread = 0.85
  const baseH = 1.15
  const hl = length / 2
  const segZ = 4
  const depthBack = rows * tread

  // Front wall, ground to the first row, segmented along the road.
  for (let dz = -hl; dz < hl; dz += segZ) {
    const dz2 = Math.min(dz + segZ, hl)
    const a = P(dz, 0)
    const b = P(dz2, 0)
    quad(
      s,
      [vx(a.x), 0, vz(a.y)], [vx(b.x), 0, vz(b.y)],
      [vx(b.x), baseH, vz(b.y)], [vx(a.x), baseH, vz(a.y)],
      concrete,
    )
  }

  for (let r = 0; r < rows; r++) {
    const depth = r * tread
    const y0 = baseH + r * riser
    const y1 = y0 + riser
    // Riser face in crowd blocks ~1.3 m wide.
    const blocks = Math.max(Math.floor(length / 1.3), 1)
    for (let k = 0; k < blocks; k++) {
      const z0 = -hl + (k / blocks) * length
      const z1 = -hl + ((k + 1) / blocks) * length
      const c = crowd[Math.floor(rand() * crowd.length)]!
      const a = P(z0, depth)
      const b = P(z1, depth)
      quad(
        s,
        [vx(a.x), y0, vz(a.y)], [vx(b.x), y0, vz(b.y)],
        [vx(b.x), y1, vz(b.y)], [vx(a.x), y1, vz(a.y)],
        c,
      )
    }
    // Tread behind the riser, segmented.
    for (let dz = -hl; dz < hl; dz += segZ) {
      const dz2 = Math.min(dz + segZ, hl)
      const a = P(dz, depth)
      const b = P(dz2, depth)
      const c = P(dz2, depth + tread)
      const d = P(dz, depth + tread)
      quad(
        s,
        [vx(a.x), y1, vz(a.y)], [vx(b.x), y1, vz(b.y)],
        [vx(c.x), y1, vz(c.y)], [vx(d.x), y1, vz(d.y)],
        concrete,
      )
    }
  }

  // End walls, or the stand is a stage set seen from the side.
  for (const dz of [-hl, hl]) {
    const topH = baseH + rows * riser
    const f = P(dz, 0)
    const bk = P(dz, depthBack)
    quad(
      s,
      [vx(f.x), 0, vz(f.y)], [vx(f.x), baseH, vz(f.y)],
      [vx(bk.x), topH, vz(bk.y)], [vx(bk.x), 0, vz(bk.y)],
      concrete,
    )
  }

  // Roof and fascia, segmented so they curve with the seating.
  const roofY = baseH + rows * riser + 2.7
  for (let dz = -hl - 0.6; dz < hl + 0.6; dz += segZ) {
    const dz2 = Math.min(dz + segZ, hl + 0.6)
    const a = P(dz, -1.2)
    const b = P(dz2, -1.2)
    const c = P(dz2, depthBack + 0.6)
    const d = P(dz, depthBack + 0.6)
    quad(
      s,
      [vx(a.x), roofY, vz(a.y)], [vx(b.x), roofY, vz(b.y)],
      [vx(c.x), roofY, vz(c.y)], [vx(d.x), roofY, vz(d.y)],
      roof,
    )
    quad(
      s,
      [vx(a.x), roofY, vz(a.y)], [vx(b.x), roofY, vz(b.y)],
      [vx(b.x), roofY - 0.5, vz(b.y)], [vx(a.x), roofY - 0.5, vz(a.y)],
      roof,
    )
  }
  for (const dz of [-hl + 1.5, 0, hl - 1.5]) {
    const p = P(dz, depthBack - 0.4)
    const yaw = track.poseAt(sArc + dz).yaw
    box(s, vx(p.x), vz(p.y), yaw, 0.3, 0.3, 0, roofY, concrete)
  }
}

/**
 * The pit building: a long block with a lighter deck and garage mouths.
 *
 * It FOLLOWS THE ROAD, for exactly the reason `buildStand` does. This was a
 * straight 58 m slab on a single anchor pose, and at the start line that is a
 * building whose rear half spans the last thirty metres of the lap: where the
 * road curves in behind the line, the slab keeps going straight and swings
 * across the track. On Croft Bay it put the pit building in the middle of the
 * road at the end of sector 3 — measured at 4.9 m off the centreline where the
 * wall stands at 39 m.
 *
 * Guarding the anchor is not enough to catch that, because the anchor is fine.
 * Every slice has to be placed on its own (arc offset, depth), so the building
 * bends with whatever the road does underneath it.
 */
function buildPitBlock(track: Track, s: Strip, sArc: number, side: number): void {
  const wall = new THREE.Color(PALETTE.PIT_WALL)
  const deck = new THREE.Color(PALETTE.PIT_DECK)
  const dark = new THREE.Color(PALETTE.GANTRY_LEG)

  if (safeOutside(track, sArc, side, 7) === null) return

  const LENGTH = 58
  const DEPTH = 9
  const STEP = 4
  /** A point on the building, by distance along the road and depth from it. */
  const P = (dz: number, depth: number): { x: number; y: number } => {
    const arc = sArc + dz
    return at(track, arc, safeOutside(track, arc, side, depth) ?? outsideWall(track, arc, side, 0.4))
  }

  // Swept in slices: the near face at the wall, the far face DEPTH back.
  for (let dz = -LENGTH / 2; dz < LENGTH / 2; dz += STEP) {
    const dz2 = Math.min(dz + STEP, LENGTH / 2)
    const a0 = P(dz, 2.5)
    const a1 = P(dz2, 2.5)
    const b0 = P(dz, 2.5 + DEPTH)
    const b1 = P(dz2, 2.5 + DEPTH)
    // Track-facing wall, back wall, and the roof deck over both.
    quad(
      s,
      [vx(a0.x), 0, vz(a0.y)], [vx(a1.x), 0, vz(a1.y)],
      [vx(a1.x), 4.4, vz(a1.y)], [vx(a0.x), 4.4, vz(a0.y)],
      wall,
    )
    quad(
      s,
      [vx(b1.x), 0, vz(b1.y)], [vx(b0.x), 0, vz(b0.y)],
      [vx(b0.x), 4.4, vz(b0.y)], [vx(b1.x), 4.4, vz(b1.y)],
      wall,
    )
    quad(
      s,
      [vx(a0.x), 4.4, vz(a0.y)], [vx(a1.x), 4.4, vz(a1.y)],
      [vx(b1.x), 4.4, vz(b1.y)], [vx(b0.x), 4.4, vz(b0.y)],
      deck,
    )

    // Garage mouths, set into the track-facing wall on the same sweep.
    const g0 = P(dz + 0.6, 2.42)
    const g1 = P(dz2 - 0.6, 2.42)
    if (Math.round(dz / STEP) % 2 === 0) {
      quad(
        s,
        [vx(g0.x), 0.1, vz(g0.y)], [vx(g1.x), 0.1, vz(g1.y)],
        [vx(g1.x), 2.9, vz(g1.y)], [vx(g0.x), 2.9, vz(g0.y)],
        dark,
      )
    }
  }
}

/**
 * Trees, instanced, in two species — because a single cone repeated is what
 * made the first pass read as a toy train set.
 *
 * Conifers are two stacked cones (the silhouette break is what sells them);
 * broadleafs are a squashed sphere on a taller trunk. Both get non-uniform
 * scale — height varying more than width — so a stand of them has skyline,
 * plus per-instance canopy colour. Four draw calls for every tree on the map.
 */
function buildTrees(
  track: Track, terrain: Terrain, rand: () => number,
  disposables: { dispose(): void }[],
  extraSpots: { x: number; y: number }[] = [],
): THREE.Object3D[] {
  interface Spot { x: number; y: number; sw: number; sh: number; color: THREE.Color }
  const conifers: Spot[] = []
  const broadleafs: Spot[] = []
  const greens = PALETTE.TREES.map((c) => new THREE.Color(c))

  // Hedgerow tree lines arrive from outside; they are always broadleafs, as
  // field-boundary trees are.
  for (const e of extraSpots) {
    broadleafs.push({
      x: e.x, y: e.y,
      sw: 0.8 + rand() * 0.5,
      sh: 0.9 + rand() * 0.6,
      color: greens[Math.floor(rand() * greens.length)]!,
    })
  }

  // FORESTS first: big elliptical stands of trees, filled on a jittered grid.
  // Five trees standing alone read as parsley; a hundred trees in a mass with
  // a taller core and ragged noise-eaten edge read as woodland. The masses
  // also sit on the hills, so they shape the skyline.
  const forestCount = 7
  for (let f = 0; f < forestCount; f++) {
    const arc = (track.length * (f + rand() * 0.7)) / forestCount
    const dStart = Math.min(arc, track.length - arc)
    if (dStart < 150) continue
    const side = rand() < 0.5 ? 1 : -1
    const centre = at(track, arc, outsideWall(track, arc, side, 60 + rand() * 200))
    if (terrain.heightAndDist(centre.x, centre.y).d < 110) continue
    const rx = 45 + rand() * 45
    const ry = 35 + rand() * 35
    const rot = rand() * Math.PI
    const cr = Math.cos(rot)
    const sr = Math.sin(rot)
    // Predominant species per forest, as in real woodland.
    const coniferForest = rand() < 0.55

    for (let gx = -rx; gx <= rx; gx += 8) {
      for (let gy = -ry; gy <= ry; gy += 8) {
        const jx = gx + (rand() - 0.5) * 6
        const jy = gy + (rand() - 0.5) * 6
        // Elliptical falloff with a noisy edge, so the boundary is ragged.
        const e = (jx / rx) ** 2 + (jy / ry) ** 2
        if (e > 0.55 + rand() * 0.45) continue
        const x = centre.x + jx * cr - jy * sr
        const y = centre.y + jx * sr + jy * cr
        if (!clearOfCircuit(track, x, y, 4)) continue
        // Taller toward the core: the canopy doming is what reads as mass.
        const core = 1 - e * 0.55
        const spot: Spot = {
          x, y,
          sw: (0.7 + rand() * 0.4) * (0.85 + core * 0.3),
          sh: (0.8 + rand() * 0.5) * (0.8 + core * 0.5),
          color: greens[Math.floor(rand() * greens.length)]!,
        }
        ;(rand() < (coniferForest ? 0.78 : 0.25) ? conifers : broadleafs).push(spot)
      }
    }
  }

  // A few loners between the woods — hedgerow oaks, not a plantation.
  for (let s = 0; s < track.length; s += 24) {
    if (rand() > 0.28) continue
    const dStart = Math.min(s, track.length - s)
    if (dStart < 130) continue
    const side = rand() < 0.5 ? 1 : -1
    const lat = outsideWall(track, s, side, 9 + rand() * 24)
    const p = at(track, s + (rand() - 0.5) * 16, lat + (rand() - 0.5) * 12)
    if (!clearOfCircuit(track, p.x, p.y, 3)) continue
    const tall = rand() < 0.12
    const spot: Spot = {
      x: p.x, y: p.y,
      sw: 0.7 + rand() * 0.5,
      sh: (tall ? 1.35 : 0.75) + rand() * 0.55,
      color: greens[Math.floor(rand() * greens.length)]!,
    }
    ;(rand() < 0.45 ? conifers : broadleafs).push(spot)
  }

  const out: THREE.Object3D[] = []
  const trunkMat = new THREE.MeshLambertMaterial({ color: PALETTE.TRUNK })
  const canopyMat = new THREE.MeshLambertMaterial({})
  disposables.push(trunkMat, canopyMat)

  const emit = (spots: Spot[], trunkGeom: THREE.BufferGeometry, canopyGeom: THREE.BufferGeometry): void => {
    if (spots.length === 0) {
      trunkGeom.dispose()
      canopyGeom.dispose()
      return
    }
    disposables.push(trunkGeom, canopyGeom)
    const trunks = new THREE.InstancedMesh(trunkGeom, trunkMat, spots.length)
    const canopies = new THREE.InstancedMesh(canopyGeom, canopyMat, spots.length)
    trunks.castShadow = false
    canopies.castShadow = false
    disposables.push(trunks, canopies)
    const m = new THREE.Matrix4()
    for (let i = 0; i < spots.length; i++) {
      const t = spots[i]!
      m.makeScale(t.sw, t.sh, t.sw)
      // Stand on the terrain, not on sea level — out here the ground rolls.
      m.setPosition(vx(t.x), terrain.height(t.x, t.y), vz(t.y))
      trunks.setMatrixAt(i, m)
      canopies.setMatrixAt(i, m)
      canopies.setColorAt(i, t.color)
    }
    trunks.instanceMatrix.needsUpdate = true
    canopies.instanceMatrix.needsUpdate = true
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true
    out.push(trunks, canopies)
  }

  // Conifer: trunk plus two stacked cones, merged by hand into one geometry.
  {
    const trunk = new THREE.CylinderGeometry(0.14, 0.22, 1.4, 6)
    trunk.translate(0, 0.7, 0)
    const lower = new THREE.ConeGeometry(1.9, 2.8, 7)
    lower.translate(0, 2.6, 0)
    const upper = new THREE.ConeGeometry(1.25, 2.4, 7)
    upper.translate(0, 4.4, 0)
    emit(conifers, trunk, mergeGeoms(lower, upper))
  }
  // Broadleaf: taller trunk under a squashed blob.
  {
    const trunk = new THREE.CylinderGeometry(0.16, 0.26, 2.4, 6)
    trunk.translate(0, 1.2, 0)
    const blob = new THREE.SphereGeometry(1.9, 8, 6)
    blob.scale(1, 0.78, 1)
    blob.translate(0, 3.4, 0)
    emit(broadleafs, trunk, blob)
  }

  return out
}

/** Concatenate two position/normal geometries — enough merging for trees. */
function mergeGeoms(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const na = a.toNonIndexed()
  const nb = b.toNonIndexed()
  const pa = na.getAttribute('position') as THREE.BufferAttribute
  const pb = nb.getAttribute('position') as THREE.BufferAttribute
  const pos = new Float32Array((pa.count + pb.count) * 3)
  pos.set(pa.array as Float32Array, 0)
  pos.set(pb.array as Float32Array, pa.count * 3)
  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  merged.computeVertexNormals()
  a.dispose()
  b.dispose()
  na.dispose()
  nb.dispose()
  return merged
}
