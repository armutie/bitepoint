/**
 * The car, built from primitives — but built to be *looked at* now.
 *
 * The halo camera changed the job. In a hood cam the car is invisible, so a
 * box-and-cylinder model was fine; from the halo the bodywork fills a third of
 * the frame for the whole lap. So: a tapered nose in three steps, front and
 * rear wings with endplates, the halo ring with its central strut, mirrors,
 * a helmet, a steering wheel, and suspension arms out to the wheels.
 *
 * The look-back view (Shift) and the chase cam then did the same to the rear:
 * a tapered engine cover with a shark fin, an airbox with a real intake mouth,
 * a beam wing under a pylon-mounted main plane, a diffuser, an exhaust, and a
 * rain light that catches the bloom — the things that say "F1" from behind.
 *
 * Modelled nose-along-+X in local space, which is what lets the renderer place
 * it with ``rotation.y = yaw`` straight from the sim. Dimensions come from
 * ``CarParams``, so the wheels sit at the real ``lf``/``lr`` and the body is
 * the real width — the thing you see is the size of the thing the physics
 * moves.
 *
 * Wheels hang from pivot groups whose rest height is recorded, so the renderer
 * can move them on their "suspension" (see the animation note in renderer.ts).
 */
import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

import type { CarParams } from '../core/carParams'

export interface WheelRig {
  /** The group that moves vertically with suspension travel. */
  pivot: THREE.Group
  /** Nested upright group; front wheels rotate this to steer. */
  steer: THREE.Group
  /**
   * Inside the pivot, and the thing that actually rolls.
   *
   * Nested rather than combined: steering is a rotation of the upright about
   * the vertical, rolling is a rotation of the wheel about its axle, and they
   * have to compose in that order or a steered wheel rolls about the wrong
   * axis. Outer group steers, inner group spins.
   */
  spin: THREE.Group
  /** Accumulated roll angle, radians. Integrated by the renderer. */
  angle: number
  /** Rest height of the pivot, so travel is applied as an offset. */
  baseY: number
  front: boolean
  /** Sign of the wheel's local z: +1 right of travel, -1 left. */
  sideZ: 1 | -1
}

export interface CarModel {
  root: THREE.Group
  /** Front upright groups, for showing the steering angle. */
  frontWheels: THREE.Object3D[]
  wheels: WheelRig[]
  /** Every material on the car, so a ghost's opacity can be driven live. */
  materials: THREE.MeshStandardMaterial[]
  /**
   * The two materials whose opacity tracks wheel speed, deliberately NOT in
   * `materials`.
   *
   * Both are faded by how fast the wheel is turning (see the blur notes in the
   * renderer), so letting the ghost-fade loop write them every frame would
   * fight that. The renderer multiplies the two factors itself.
   *
   * They fade at different rates on purpose: the spokes are bright and
   * five-fold symmetric, so they strobe early and hard; the scuffs are dark and
   * irregular, so they can stay legible far longer.
   */
  spokeMaterial: THREE.MeshStandardMaterial
  scuffMaterial: THREE.MeshStandardMaterial
  /** Reconnect live suspension rods after steering or wheel travel changes. */
  updateSuspension(): void
  dispose(): void
}

export interface CarSkin {
  body: number
  accent: number
}

export const SKINS = {
  player: { body: 0x2f6fd0, accent: 0xe8eef7 },
  ghost: { body: 0x8892a0, accent: 0xc9d2dd },
} satisfies Record<string, CarSkin>

/**
 * Half-section of a tyre, for revolving into one.
 *
 * A cylinder has a 90-degree corner where the tread meets the sidewall, and
 * nothing on a car catches a hard highlight along a straight edge like that —
 * it is the single strongest tell that a wheel is two primitives rather than a
 * moulded object. This walks the shoulder round a quarter-circle instead.
 *
 * Points are (radius, distance along the axle); `LatheGeometry` revolves them
 * about its own Y, which the caller then lays down onto the wheel's axle.
 */
function tyreProfile(r: number, halfW: number, shoulder: number): THREE.Vector2[] {
  const STEPS = 5
  // Starts inside the rim's outer radius, so the wheel face covers the seam
  // where the lathe leaves the section open.
  const inner = r * 0.55
  const pts = [new THREE.Vector2(inner, -halfW), new THREE.Vector2(r - shoulder, -halfW)]
  for (let i = 1; i <= STEPS; i++) {
    const a = (i / STEPS) * (Math.PI / 2)
    pts.push(new THREE.Vector2(
      r - shoulder + Math.sin(a) * shoulder,
      -halfW + (1 - Math.cos(a)) * shoulder,
    ))
  }
  pts.push(new THREE.Vector2(r, halfW - shoulder))
  for (let i = 1; i <= STEPS; i++) {
    const a = (i / STEPS) * (Math.PI / 2)
    pts.push(new THREE.Vector2(
      r - shoulder + Math.cos(a) * shoulder,
      halfW - shoulder + Math.sin(a) * shoulder,
    ))
  }
  pts.push(new THREE.Vector2(inner, halfW))
  return pts
}

/**
 * Collapse every Mesh directly under `parent` into one mesh per material.
 *
 * The car is some hundred boxes, cylinders and lathes, and each was its own
 * mesh: a draw call in the colour pass, another in the shadow pass, a matrix
 * compose and a frustum test every frame — times twelve cars, counting the
 * menu's attract field. None of it moves relative to its parent after
 * assembly, so once built the parts can be baked together; only material
 * boundaries have to survive, because materials are what the ghost fade and
 * the wheel-blur write to at runtime.
 *
 * Groups (the wheel pivots under the root, the spin group under each pivot)
 * are left alone — they are exactly the transforms that DO move.
 */
function mergeStatic(
  parent: THREE.Object3D,
  disposables: { dispose(): void }[],
  castShadow: boolean,
): void {
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>()
  const merged: THREE.Mesh[] = []
  for (const child of [...parent.children]) {
    if (!(child instanceof THREE.Mesh)) continue
    child.updateMatrix()
    const baked = (child.geometry as THREE.BufferGeometry).clone().applyMatrix4(child.matrix)
    const mat = child.material as THREE.Material
    const list = byMat.get(mat)
    if (list) list.push(baked)
    else byMat.set(mat, [baked])
    parent.remove(child)
  }
  for (const [material, geoms] of byMat) {
    const geom = mergeGeometries(geoms)
    for (const g of geoms) g.dispose()
    disposables.push(geom)
    const mesh = new THREE.Mesh(geom, material)
    mesh.castShadow = castShadow
    // Baked in place: the merged mesh sits at its parent's origin forever, so
    // there is no matrix to keep recomposing.
    mesh.matrixAutoUpdate = false
    merged.push(mesh)
  }
  if (merged.length > 0) parent.add(...merged)
}

export function buildCar(p: CarParams, skin: CarSkin, opts: { ghost?: boolean } = {}): CarModel {
  const root = new THREE.Group()
  const disposables: { dispose(): void }[] = []
  const ghost = opts.ghost ?? false

  const materials: THREE.MeshStandardMaterial[] = []
  const mat = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) => {
    const m = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.42,
      metalness: 0.12,
      transparent: ghost,
      opacity: ghost ? 0.4 : 1,
      depthWrite: !ghost,
      ...extra,
    })
    disposables.push(m)
    materials.push(m)
    return m
  }

  const bodyMat = mat(skin.body)
  const accentMat = mat(skin.accent, { roughness: 0.3 })
  const darkMat = mat(0x17191d, { roughness: 0.7, metalness: 0 })
  const tyreMat = mat(0x141619, { roughness: 0.95, metalness: 0 })
  const rimMat = mat(0x3a3e46, { roughness: 0.5, metalness: 0.35 })
  const carbonMat = mat(0x22252b, { roughness: 0.55, metalness: 0.2 })

  const halfW = p.width / 2
  const wheelR = p.wheelRadius

  const add = (
    geom: THREE.BufferGeometry, material: THREE.Material,
    x: number, y: number, z = 0,
    parent: THREE.Object3D = root,
  ): THREE.Mesh => {
    disposables.push(geom)
    const mesh = new THREE.Mesh(geom, material)
    mesh.position.set(x, y, z)
    mesh.castShadow = !ghost
    parent.add(mesh)
    return mesh
  }

  // Suspension links cannot be baked into either the body or steering pivot:
  // one end belongs to the chassis and the other to the moving upright. Keep
  // them in their own group and reshape each unit cylinder between its two
  // current endpoints whenever steering or wheel travel changes.
  const suspensionRoot = new THREE.Group()
  suspensionRoot.name = 'suspension-links'
  root.add(suspensionRoot)
  const rodUp = new THREE.Vector3(0, 1, 0)
  const rodTo = new THREE.Vector3()
  const rodDelta = new THREE.Vector3()
  const liveRods: {
    mesh: THREE.Mesh
    from: THREE.Vector3
    sampleTo: (out: THREE.Vector3) => THREE.Vector3
  }[] = []

  const placeRod = (mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3): void => {
    rodDelta.subVectors(to, from)
    mesh.position.copy(from).addScaledVector(rodDelta, 0.5)
    mesh.scale.set(1, rodDelta.length(), 1)
    mesh.quaternion.setFromUnitVectors(rodUp, rodDelta.normalize())
  }

  const addLiveRod = (
    from: THREE.Vector3,
    sampleTo: (out: THREE.Vector3) => THREE.Vector3,
    radius: number,
  ): THREE.Mesh => {
    const geom = new THREE.CylinderGeometry(radius, radius, 1, 8)
    disposables.push(geom)
    const mesh = new THREE.Mesh(geom, carbonMat)
    mesh.castShadow = !ghost
    suspensionRoot.add(mesh)
    liveRods.push({ mesh, from: from.clone(), sampleTo })
    placeRod(mesh, from, sampleTo(rodTo))
    return mesh
  }

  const updateSuspension = (): void => {
    for (const rod of liveRods) placeRod(rod.mesh, rod.from, rod.sampleTo(rodTo))
  }

  // --- floor and tub -------------------------------------------------------
  // Cut the front corners back around the tyres' steering sweep. The old
  // rectangular floor stopped only a few centimetres inboard of a straight
  // tyre, so the rear shoulder of the tyre passed through it at large lock.
  // Keep a narrow tongue under the nose rather than shortening the whole floor.
  const floorRearX = -1.65
  const floorFrontX = 1.75
  const floorOuterZ = halfW * 0.75
  const floorNeckZ = halfW * 0.42
  const floorCutX = Math.min(floorFrontX - 0.18, p.lf - wheelR - 0.08)
  const floorShoulderX = Math.min(floorFrontX - 0.02, floorCutX + 0.22)
  const floorShape = new THREE.Shape([
    new THREE.Vector2(floorRearX, -floorOuterZ),
    new THREE.Vector2(floorCutX, -floorOuterZ),
    new THREE.Vector2(floorShoulderX, -floorNeckZ),
    new THREE.Vector2(floorFrontX, -floorNeckZ),
    new THREE.Vector2(floorFrontX, floorNeckZ),
    new THREE.Vector2(floorShoulderX, floorNeckZ),
    new THREE.Vector2(floorCutX, floorOuterZ),
    new THREE.Vector2(floorRearX, floorOuterZ),
  ])
  const rawFloorGeom = new THREE.ExtrudeGeometry(floorShape, {
    depth: 0.06,
    bevelEnabled: false,
    steps: 1,
  })
  // Extrusion is along local Z; rotate it into a horizontal 6 cm floor whose
  // top and bottom retain the same heights as the previous box.
  rawFloorGeom.rotateX(Math.PI / 2)
  // ExtrudeGeometry is non-indexed while the boxes sharing this material are
  // indexed; mergeVertices makes their layouts compatible for the body bake.
  const floorGeom = mergeVertices(rawFloorGeom)
  rawFloorGeom.dispose()
  add(floorGeom, carbonMat, 0, 0.12)
  // Main tub around the cockpit.
  add(new THREE.BoxGeometry(1.5, 0.4, halfW * 0.56), bodyMat, 0.0, 0.4)
  // Sidepods sweeping back from the cockpit.
  for (const z of [-1, 1]) {
    add(new THREE.BoxGeometry(1.7, 0.3, halfW * 0.42), bodyMat, -0.55, 0.28, z * halfW * 0.66)
    // Coke-bottle: a narrower, lower run continuing inboard of the rear tyre,
    // so the flanks pinch toward the tail instead of just stopping.
    add(new THREE.BoxGeometry(0.9, 0.22, halfW * 0.3), bodyMat, -1.55, 0.25, z * halfW * 0.42)
  }

  // --- engine cover: two shrinking steps, like the nose ---------------------
  // Bulky over the engine, then a narrow tail reaching back under the wing.
  add(new THREE.BoxGeometry(1.05, 0.32, halfW * 0.4), bodyMat, -0.92, 0.5)
  add(new THREE.BoxGeometry(0.95, 0.2, halfW * 0.24), bodyMat, -1.78, 0.42)
  // Shark fin along the spine — from the look-back view it is the one shape
  // that carries the eye from the cockpit to the rear wing. Bottom edge buried
  // in the tail cover so no gap shows between them.
  add(new THREE.BoxGeometry(0.85, 0.3, 0.024), bodyMat, -1.72, 0.62)

  // --- airbox / roll hoop, with an actual intake ----------------------------
  add(new THREE.BoxGeometry(0.34, 0.3, 0.26), bodyMat, -0.55, 0.84)
  // The intake mouth above the helmet: a stubby cylinder lying nose-along, its
  // open end faced with a dark disc slightly smaller than the rim — a hole with
  // a lip, which is what an intake is.
  const intake = add(new THREE.CylinderGeometry(0.085, 0.095, 0.2, 12), bodyMat, -0.5, 1.0)
  intake.rotation.z = Math.PI / 2
  const mouth = add(new THREE.CircleGeometry(0.07, 12), darkMat, -0.398, 1.0)
  mouth.rotation.y = Math.PI / 2

  // --- nose, in three shrinking steps --------------------------------------
  add(new THREE.BoxGeometry(0.8, 0.24, 0.42), bodyMat, 0.95, 0.42)
  add(new THREE.BoxGeometry(0.72, 0.17, 0.3), bodyMat, 1.7, 0.38)
  add(new THREE.BoxGeometry(0.6, 0.12, 0.19), bodyMat, 2.32, 0.35)

  // --- front wing -----------------------------------------------------------
  const wingX = p.lf + 0.75
  add(new THREE.BoxGeometry(0.44, 0.045, p.width * 0.92), accentMat, wingX, 0.16)
  add(new THREE.BoxGeometry(0.3, 0.04, p.width * 0.8), accentMat, wingX - 0.1, 0.25)
  for (const z of [-1, 1]) {
    add(new THREE.BoxGeometry(0.5, 0.26, 0.03), bodyMat, wingX, 0.26, z * p.width * 0.46)
  }

  // --- rear wing ------------------------------------------------------------
  const rearX = -p.lr - 0.55
  // A single central swan-neck pylon from the tail cover up to the main plane,
  // replacing the old full-width support slab — from behind, daylight between
  // the main plane and the beam wing is most of what makes it read as a wing
  // assembly rather than a solid block.
  add(new THREE.BoxGeometry(0.06, 0.44, 0.05), carbonMat, rearX + 0.05, 0.72)
  // The whole assembly ends INBOARD of the rear tyres, as the real one does.
  // The endplates used to stand at ±0.70 m — over the middle of the tyres —
  // with planes 0.36 m short of them, so from behind the wing read as a narrow
  // slab floating between two unrelated fences, and once the planes were
  // widened to meet them the wing became a full-width shelf over the wheels.
  // Both wrong for the same reason: the fences were in the wrong place.
  add(new THREE.BoxGeometry(0.46, 0.05, halfW * 1.16), accentMat, rearX, 0.95)
  add(new THREE.BoxGeometry(0.4, 0.04, halfW * 1.16), accentMat, rearX + 0.06, 0.83)
  // DRS actuator pod, the little hump on the main plane's centreline.
  add(new THREE.BoxGeometry(0.14, 0.05, 0.08), darkMat, rearX, 0.99)
  // Beam wing: two low elements between the endplates' lower edges.
  add(new THREE.BoxGeometry(0.16, 0.03, halfW * 1.16), carbonMat, rearX + 0.04, 0.6)
  add(new THREE.BoxGeometry(0.16, 0.028, halfW * 1.16), carbonMat, rearX - 0.06, 0.54)
  // Endplates, deep enough to gather main plane and beam wing alike.
  for (const z of [-1, 1]) {
    add(new THREE.BoxGeometry(0.52, 0.5, 0.03), darkMat, rearX, 0.78, z * halfW * 0.58)
  }

  // --- tail: exhaust, rain light, diffuser -----------------------------------
  // Exhaust: a dark pipe poking out of the very end of the tail cover.
  const exhaust = add(new THREE.CylinderGeometry(0.042, 0.042, 0.16, 10), darkMat, -2.28, 0.47)
  exhaust.rotation.z = Math.PI / 2
  // Rain light on the tail's aft face. Emissive enough to catch the bloom —
  // from the chase cam and the mirror-check it is the car's tail light, the
  // single most recognisable thing about an F1 car from behind.
  const rainMat = mat(0xff2020, {
    emissive: 0xff1616,
    emissiveIntensity: ghost ? 0.5 : 3.0,
    roughness: 0.4,
    metalness: 0,
  })
  add(new THREE.BoxGeometry(0.04, 0.16, 0.09), rainMat, -2.27, 0.38)
  // Diffuser: the floor kicking up behind the rear axle, with three strakes.
  const diffuser = add(new THREE.BoxGeometry(0.6, 0.035, halfW), carbonMat, -1.8, 0.2)
  diffuser.rotation.z = -0.3
  for (const z of [-1, 0, 1]) {
    const strake = add(new THREE.BoxGeometry(0.55, 0.1, 0.016), carbonMat, -1.82, 0.26, z * halfW * 0.42)
    strake.rotation.z = -0.3
  }

  // --- cockpit: surround, halo, helmet, wheel, mirrors ----------------------
  add(new THREE.BoxGeometry(0.9, 0.1, halfW * 0.6), darkMat, 0.0, 0.62)

  // Helmet — bottom-centre of the halo cam frame, and most of what sells it.
  const helmet = add(new THREE.SphereGeometry(0.15, 16, 12), accentMat, -0.18, 0.78)
  helmet.scale.y = 0.92
  add(new THREE.BoxGeometry(0.06, 0.05, 0.19), darkMat, -0.05, 0.76) // visor slot

  // Steering wheel, tilted toward the driver.
  const wheel = add(new THREE.BoxGeometry(0.05, 0.16, 0.26), carbonMat, 0.3, 0.66)
  wheel.rotation.z = -0.35

  // Halo: the ring around the cockpit plus the central strut down to the nose.
  // Ring centre x=0.12 with an x-stretch of 1.3, so its front edge sits at
  // x ≈ 0.56, y = 0.88; the strut runs from there down to the chassis top at
  // (0.76, 0.52) — leaning forward as it descends, as the real one does.
  const ringGeom = new THREE.TorusGeometry(0.34, 0.032, 8, 20)
  const ring = add(ringGeom, bodyMat, 0.12, 0.88)
  ring.rotation.x = Math.PI / 2
  ring.scale.x = 1.3
  const strutLen = Math.hypot(0.2, 0.36)
  const strut = add(new THREE.CylinderGeometry(0.026, 0.03, strutLen, 8), bodyMat, 0.66, 0.7)
  strut.rotation.z = Math.atan2(0.2, 0.36)

  // Mirrors either side of the cockpit. Small and close-set: in the halo cam's
  // wide view an outboard mirror lands in the corner of frame, and an oversized
  // box there reads as a detached block rather than part of the car.
  for (const z of [-1, 1]) {
    add(new THREE.BoxGeometry(0.04, 0.06, 0.11), accentMat, 0.44, 0.66, z * halfW * 0.5)
    const stalk = add(
      new THREE.CylinderGeometry(0.014, 0.018, 0.13, 6), darkMat, 0.44, 0.58, z * halfW * 0.42,
    )
    stalk.rotation.x = z * 0.5 // leaning outward from the tub to the glass
  }

  // --- wheels and suspension ------------------------------------------------
  const wheels: WheelRig[] = []
  const frontWheels: THREE.Object3D[] = []
  /**
   * Tread widths, front and rear.
   *
   * Both axles were 0.40 m, which is neither figure: an F1 front is about
   * 305 mm and a rear about 405 mm on the same 720 mm diameter, so the rear is
   * markedly the wider tyre. That contrast is one of the most recognisable
   * things about the car from any angle, and drawing them identical threw it
   * away.
   *
   * These are then a shade wider than that scales to. Straight proportion off
   * the real car would give 0.28 and 0.37 on this 0.66 m wheel, and against an
   * onboard reference shot it looked narrow — because the halo camera sees the
   * fronts from above and inboard, foreshortening the tread. Set by eye at the
   * view the game is actually played from, which is the right judge.
   */
  const TYRE_W = { front: 0.34, rear: 0.45 }
  /** Shoulder radius. A tyre has no 90-degree corner anywhere on it. */
  const SHOULDER = 0.05

  const armGeom = new THREE.CylinderGeometry(0.018, 0.018, 1, 6)
  /**
   * Three things on a wheel, doing three different jobs.
   *
   * **Spokes** across the outboard rim face, which are what actually read as
   * rotation. Five of them, bright against the tyre.
   *
   * **The compound band**: a Medium's yellow ring, and *painted* rather than
   * proud. A torus tube stood off the sidewall and caught the light like a
   * fitting bolted to the wheel; a flat ring sitting on the rubber is what the
   * real marking is. Being a perfect circle it is rotationally symmetric, so it
   * says nothing about rotation and — the point — cannot flicker at any speed,
   * which is why it is the one part that gets to be a colour.
   *
   * **Tread patches**, on the running surface rather than the sidewall.
   *
   * These were radial bars on the sidewall first, and from any angle where the
   * wheel was not edge-on they read as spikes sticking out of the rubber —
   * because that is geometrically what they were: boxes pointing outward at
   * 0.88R, catching light along their length. A tyre has no such feature.
   *
   * What a real tyre has is uneven wear across the tread: patches that scrub
   * slightly lighter than the rubber around them, wrapped ON the surface. So
   * these are long, narrow, tapered streaks a shade off the tyre colour, laid
   * along the running surface. They cannot read as a fitting because
   * they follow the tyre's own curve, and they cross the contact patch — which
   * is where the eye is already looking when it wants to know what the wheel is
   * doing.
   *
   * One of them, on the right-hand tyres only. Repeated marks read as a pattern
   * the wheel is wearing; a single one reads as wear.
   */
  const SPOKES = 5
  // One tyre and one rim per axle, since the two are now different widths.
  const tyreGeoms = {
    front: new THREE.LatheGeometry(tyreProfile(wheelR, TYRE_W.front / 2, SHOULDER), 22),
    rear: new THREE.LatheGeometry(tyreProfile(wheelR, TYRE_W.rear / 2, SHOULDER), 22),
  }
  const rimGeoms = {
    front: new THREE.CylinderGeometry(wheelR * 0.58, wheelR * 0.58, TYRE_W.front + 0.02, 14),
    rear: new THREE.CylinderGeometry(wheelR * 0.58, wheelR * 0.58, TYRE_W.rear + 0.02, 14),
  }
  disposables.push(tyreGeoms.front, tyreGeoms.rear, rimGeoms.front, rimGeoms.rear)

  const spokeGeom = new THREE.BoxGeometry(wheelR * 1.06, 0.045, 0.022)
  // A thin stripe, not a painted panel. The sidewall runs from the rim at
  // 0.58R out to the tread at 1.0R, and the first version covered 0.70–0.88 of
  // that — over 40% of the visible rubber, which is a wheel with a yellow face
  // rather than a tyre with a marking on it. 0.80–0.865 is nearer a fifth.
  const bandGeom = new THREE.RingGeometry(wheelR * 0.8, wheelR * 0.865, 40)
  // A long, thin, uneven STREAK of tread — not a patch.
  //
  // The arc segments this replaces were uniform rectangles: constant width,
  // hard parallel edges, three identical copies. Wrapped on the tyre they read
  // as tape rather than rubber, because nothing about a worn tyre is that
  // regular. A streak is the opposite shape — long around the circumference,
  // narrow across the tread, tapered to nothing at both ends, and with edges
  // that wander.
  //
  // Built as a strip rather than lathed: each step along the arc gets its own
  // half-width from a smooth wobble times a taper, so the two edges are
  // independent and the thing never reads as a swept rectangle. Sat at the
  // tyre's exact radius; the material's polygon offset keeps it flush.
  function treadStreak(width: number, arc: number, phase: number): THREE.BufferGeometry {
    const STEPS = 28
    const pos: number[] = []
    const idx: number[] = []
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS
      const a = t * arc
      // Taper to a point at both ends — the reason it reads as a streak and
      // not a bar. The 0.65 power keeps it slim through the middle instead of
      // bulging into a leaf shape.
      const taper = Math.sin(Math.PI * t) ** 0.65
      // Two incommensurate sines, so the wobble never repeats within the arc
      // and the two edges disagree with each other.
      const wobbleA = 1 + 0.34 * Math.sin(t * 11.3 + phase) + 0.18 * Math.sin(t * 27.1 + phase * 2)
      const wobbleB = 1 + 0.34 * Math.sin(t * 9.7 + phase + 2.1) + 0.18 * Math.sin(t * 23.3 + phase)
      const hw = width * taper
      pos.push(
        wheelR * Math.cos(a), wheelR * Math.sin(a), hw * wobbleA,
        wheelR * Math.cos(a), wheelR * Math.sin(a), -hw * wobbleB,
      )
      if (i < STEPS) {
        const v = i * 2
        idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setIndex(idx)
    g.computeVertexNormals()
    return g
  }

  // ONE streak, on the RIGHT-hand tyres only.
  //
  // Two per wheel was one too many — they were never both out of shot, so the
  // eye read them as a repeating feature rather than as damage. One is a mark
  // on a tyre. And putting it on one side of the car only is the same argument
  // at the next scale up: four identical worn tyres is a texture, one worn tyre
  // is a thing that happened to this car.
  //
  // Sat toward the INBOARD shoulder rather than down the middle, which is where
  // a tyre scrubs when it is being leaned on.
  const STREAK = { at: 2.74, arc: 1.15, phase: 1.9, width: 0.041, inboard: 0.5 }
  const scuffGeoms = (['front', 'rear'] as const).map((axle) => ({
    axle,
    at: STREAK.at,
    geom: treadStreak(TYRE_W[axle] * STREAK.width, STREAK.arc, STREAK.phase),
  }))
  disposables.push(armGeom, spokeGeom, bandGeom, ...scuffGeoms.map((g) => g.geom))

  const spokeMat = new THREE.MeshStandardMaterial({
    color: 0x9aa3ad,
    roughness: 0.45,
    metalness: 0.4,
    // Always transparent: the renderer fades these out as the wheel speeds up.
    transparent: true,
    opacity: 1,
    depthWrite: !ghost,
  })
  disposables.push(spokeMat)

  // Pirelli medium, taken a long way down from signal-yellow. Under the bloom
  // this scene runs, anything near #FFF200 stops being rubber and becomes a
  // light source. Flat-lit too — no metalness, high roughness — because paint
  // on a tyre should not have a highlight travelling round it.
  const bandMat = mat(0x9c8829, {
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
  })
  // Two steps off the tyre's own 0x141619 rather than four. These only have to
  // be findable when you go looking for them — a mark you notice unprompted on
  // a tyre is a mark that has stopped being tyre.
  // Barely off the rubber's own 0x141619. A tread patch that reads as a colour
  // is a sticker; this one only shows as the surface catching light slightly
  // differently as it comes round.
  const scuffMat = new THREE.MeshStandardMaterial({
    color: 0x1e2126,
    side: THREE.DoubleSide,
    // Coplanar with the tread, so it needs help winning the depth test. This is
    // what keeps it looking painted ON rather than floating above: no gap to
    // catch a highlight, no edge standing proud of the profile.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    roughness: 0.95,
    metalness: 0,
    transparent: true,
    opacity: 1,
    depthWrite: !ghost,
  })
  disposables.push(scuffMat)
  for (const [axleX, front] of [
    [p.lf, true],
    [-p.lr, false],
  ] as const) {
    const axle = front ? 'front' : 'rear'
    const tyreHalfW = TYRE_W[axle] / 2

    for (const side of [-1, 1] as const) {
      const pivot = new THREE.Group()
      const baseY = wheelR
      // Seated by its INNER edge, so the wider rear sits further out rather
      // than growing into the bodywork.
      pivot.position.set(axleX, baseY, side * (halfW - 0.05 - (tyreHalfW - 0.15)))

      // Suspension travel and steering are different joints. The travel group
      // carries the upright vertically; the nested steering group rotates the
      // upright and wheel around the inboard kingpin rather than their centre.
      const steer = new THREE.Group()
      const inboardFaceZ = front ? -side * (tyreHalfW + 0.012) : 0
      steer.position.z = inboardFaceZ
      const spin = new THREE.Group()
      spin.position.z = -inboardFaceZ

      const tyre = new THREE.Mesh(tyreGeoms[axle], tyreMat)
      tyre.rotation.x = Math.PI / 2
      tyre.castShadow = !ghost
      const rim = new THREE.Mesh(rimGeoms[axle], rimMat)
      rim.rotation.x = Math.PI / 2
      spin.add(tyre, rim)

      // Band and scuffs on BOTH sidewalls. From the halo camera the front
      // tyres are seen from inside the car, so an outboard-only marking would
      // be on the one face you never look at.
      //
      // 1.5 mm proud of whatever this axle's sidewall is: enough to beat
      // z-fighting, far too little to read as standing off the rubber.
      for (const faceZ of [tyreHalfW + 0.0015, -(tyreHalfW + 0.0015)]) {
        const band = new THREE.Mesh(bandGeom, bandMat)
        band.position.z = faceZ
        spin.add(band)
      }

      // Tread patches wrap the running surface, so unlike the band they belong
      // to the wheel rather than to a face of it — placed once, not per side.
      // Right-hand side only: +z is the car's right, since the renderer places
      // the car at (x, 0, -y) against a sim whose +y is left.
      if (side === 1) {
        for (const streak of scuffGeoms.filter((g) => g.axle === axle)) {
          const scuff = new THREE.Mesh(streak.geom, scuffMat)
          // Built in the wheel's own frame — circle in XY, axle along Z — so
          // the only placement left is where round the rim it starts, and how
          // far across the tread it sits. Toward the car's centreline, and
          // along the spin axis so rotating the wheel does not move it.
          scuff.rotation.z = streak.at
          scuff.position.z = -side * tyreHalfW * STREAK.inboard
          spin.add(scuff)
        }
      }

      // Spokes, outboard face only — as on the real thing, where the inboard
      // side of the wheel is brake duct rather than cover.
      for (let k = 0; k < SPOKES; k++) {
        const spoke = new THREE.Mesh(spokeGeom, spokeMat)
        spoke.position.z = side * (tyreHalfW + 0.015)
        spoke.rotation.z = (k * Math.PI * 2) / SPOKES
        spin.add(spoke)
      }

      steer.add(spin)
      pivot.add(steer)

      if (front) {
        // The upright rotates on the line through its upper and lower ball
        // joints. Both joints therefore stay put as the wheel steers, exactly
        // where the chassis-fixed wishbones meet them.
        const upright = new THREE.Mesh(
          new THREE.CylinderGeometry(0.021, 0.021, 0.28, 8),
          carbonMat,
        )
        disposables.push(upright.geometry)
        upright.castShadow = !ghost
        steer.add(upright)

        for (const y of [-0.11, 0.11]) {
          const joint = new THREE.Mesh(new THREE.SphereGeometry(0.027, 8, 6), carbonMat)
          disposables.push(joint.geometry)
          joint.position.y = y
          joint.castShadow = !ghost
          steer.add(joint)
        }

        for (const plane of [
          { outerY: 0.11, innerY: 0.445 },
          { outerY: -0.11, innerY: 0.315 },
        ]) {
          const outer = new THREE.Vector3(0, plane.outerY, 0)
          for (const x of [-0.22, 0.22]) {
            addLiveRod(
              new THREE.Vector3(axleX + x, plane.innerY, side * 0.05),
              (out) => out.copy(pivot.position).add(steer.position).add(outer),
              0.014,
            )
          }
        }

        // Pushrod: chassis rocker at one end, vertically travelling upright at
        // the other. It follows suspension movement but not steering rotation.
        const pushrodOuter = new THREE.Vector3(-0.02, 0.09, 0)
        addLiveRod(
          new THREE.Vector3(axleX - 0.18, 0.56, side * 0.05),
          (out) => out.copy(pivot.position).add(steer.position).add(pushrodOuter),
          0.012,
        )

        // Track rod: its rack end is fixed to the chassis, while the steering-
        // arm end sits off the kingpin and therefore arcs with steering lock.
        const trackRodOuter = new THREE.Vector3(-0.075, -0.035, side * 0.025)
        addLiveRod(
          new THREE.Vector3(axleX - 0.16, 0.36, side * 0.09),
          (out) => out.copy(trackRodOuter)
            .applyAxisAngle(rodUp, steer.rotation.y)
            .add(steer.position)
            .add(pivot.position),
          0.01,
        )
      } else {
        const bodyPickupZ = halfW * 0.3
        const armSpan = Math.abs(pivot.position.z) - bodyPickupZ + 0.035
        const arm = new THREE.Mesh(armGeom, carbonMat)
        arm.scale.y = armSpan
        arm.position.set(0, 0, -side * armSpan * 0.5)
        arm.rotation.x = Math.PI / 2
        pivot.add(arm)
      }

      root.add(pivot)
      wheels.push({ pivot, steer, spin, angle: 0, baseY, front, sideZ: side })
      if (front) frontWheels.push(steer)
    }
  }

  // Bake the assembly down: the body to one mesh per material and each wheel's
  // rolling parts likewise (tyre, rim, band, and — kept apart by their fading
  // materials — spokes and scuffs). The live suspension links deliberately
  // stay separate because their endpoints change with the moving upright.
  mergeStatic(root, disposables, !ghost)
  for (const w of wheels) {
    mergeStatic(w.pivot, disposables, !ghost)
    mergeStatic(w.steer, disposables, !ghost)
    mergeStatic(w.spin, disposables, !ghost)
  }

  updateSuspension()

  return {
    root,
    frontWheels,
    wheels,
    materials,
    spokeMaterial: spokeMat,
    scuffMaterial: scuffMat,
    updateSuspension,
    dispose(): void {
      for (const d of disposables) d.dispose()
    },
  }
}
