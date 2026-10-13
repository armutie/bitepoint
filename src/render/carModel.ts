import { buildFieldCar } from './fieldCar'
/** Smooth formula-car bodywork with separate wheel, steering and suspension rigs.
 * Authored nose-along +X; axle positions and width follow the simulation dimensions.
 * Near detail is used for the player; the field shares the silhouette at fewer subdivisions.
 */
import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

import { shell, surfaceTexture, teamDecal, haloSurface } from './carSurface'

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
  /** Animate only the cockpit wheel; road-wheel steering stays exact. */
  updateCockpitSteering(speed: number, dt: number): void
  dispose(): void
}

export interface CarSkin {
  body: number
  accent: number
}

export const SKINS = {
  player: { body: 0x174c91, accent: 0xf1eee4 },
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
    mesh.receiveShadow = castShadow
    // Baked in place: the merged mesh sits at its parent's origin forever, so
    // there is no matrix to keep recomposing.
    mesh.matrixAutoUpdate = false
    merged.push(mesh)
  }
  if (merged.length > 0) parent.add(...merged)
}

export function buildCar(p: CarParams, skin: CarSkin, opts: { ghost?: boolean; detail?: 'near' | 'field' } = {}): CarModel {
  if(opts.detail==='field')return buildFieldCar(p,skin,opts.ghost??false)
  const root = new THREE.Group()
  const disposables: { dispose(): void }[] = []
  const ghost = opts.ghost ?? false
  const detailed = true
  const bodyShell = (sections: Parameters<typeof shell>[0], rings = 40) => shell(sections, detailed ? rings : Math.min(rings, 16))

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

  const carbonTexture = surfaceTexture('carbon')
  const rubberTexture = surfaceTexture('rubber')
  disposables.push(carbonTexture, rubberTexture)
  const bodyMat = new THREE.MeshPhysicalMaterial({ color: skin.body, roughness: 0.29,
    metalness: 0, clearcoat: 1, clearcoatRoughness: 0.18,
    transparent: ghost, opacity: ghost ? 0.4 : 1, depthWrite: !ghost })
  materials.push(bodyMat); disposables.push(bodyMat)
  const accentMat = mat(skin.accent, { roughness: 0.3 })
  const darkMat = mat(0x17191d, { roughness: 0.7, metalness: 0 })
  const tyreMat = mat(0x24262a, { roughness: 0.76, metalness: 0, roughnessMap: rubberTexture, bumpMap: rubberTexture, bumpScale: 0.00035 })
  const rimMat = mat(0x3a3e46, { roughness: 0.5, metalness: 0.35 })
  const carbonMat = mat(0x30343b, { roughness: 0.43, metalness: 0, map: carbonTexture, bumpMap: carbonTexture, bumpScale: 0.00025 })

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

  const updateCockpitSteering = (speed: number, dt: number): void => {
    // Gradually calm the visual motion from 30 to 200 km/h. This has no
    // influence on the physics rack or front tyre angles.
    const t = Math.max(0, Math.min(1, (Math.abs(speed) - 8) / 48))
    const fast = t * t * (3 - 2 * t)
    const input = Math.max(-1, Math.min(1, (frontWheels[0]?.rotation.y ?? 0) / p.maxSteer))
    const target = -input * (Math.PI * 5 / 6) * (1 - 0.45 * fast)
    const elapsed = Math.max(0, Math.min(dt, 0.1))
    const eased = (target - cockpitWheel.rotation.x) * (1 - Math.exp(-elapsed / (0.035 + 0.075 * fast)))
    const maxStep = (11 - 7 * fast) * elapsed
    cockpitWheel.rotation.x += Math.max(-maxStep, Math.min(maxStep, eased))
    updateWheelDisplay(speed, elapsed)
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
  // Continuous skins replace stacked boxes. The cockpit stays open between the shoulders.
  add(bodyShell([[-0.85,0.30,0.15,0.25],[-0.25,0.32,0.17,0.29],[0.45,0.36,0.17,0.25],[0.85,0.40,0.14,0.18]]), bodyMat, 0,0)
  for (const side of [-1, 1]) {
    add(bodyShell([[-0.70,0.50,0.13,0.12],[-0.38,0.58,0.10,0.12],[0.12,0.57,0.10,0.105],[0.53,0.50,0.12,0.10]]), accentMat,0,0,side*0.29)
    add(bodyShell([[-1.62,0.23,0.06,0.075],[-1.12,0.33,0.12,0.16],[-0.55,0.38,0.19,0.205],[0.05,0.41,0.16,0.19],[0.37,0.40,0.075,0.14]]),bodyMat,0,0,side*0.50)
    const inlet = add(new THREE.SphereGeometry(1,24,12),darkMat,0.33,0.42,side*0.50)
    inlet.scale.set(0.018,0.059,0.128)
    // A narrow painted shoulder stripe follows the body without a floating decal plane.
    add(bodyShell([[-1.25,0.452,0.008,0.025],[-0.55,0.578,0.008,0.028],[0.05,0.568,0.008,0.024],[0.28,0.512,0.006,0.018]],24),accentMat,0,0,side*0.52)
  }
  add(bodyShell([[-2.20,0.35,0.09,0.055],[-1.5,0.42,0.14,0.12],[-0.88,0.57,0.24,0.22],[-0.65,0.67,0.25,0.20]]),bodyMat,0,0)
  const intake = add(new THREE.SphereGeometry(1,24,16),bodyMat,-0.64,0.96)
  intake.scale.set(0.16,0.17,0.13)
  const mouth = add(new THREE.CircleGeometry(0.08,24),darkMat,-0.485,0.995)
  mouth.rotation.y=Math.PI/2
  add(bodyShell([[0.35,0.49,0.17,0.30],[0.72,0.48,0.17,0.28],[1.20,0.44,0.13,0.23],[1.75,0.37,0.09,0.15],[2.30,0.27,0.06,0.105],[2.65,0.235,0.04,0.10]]),accentMat,0,0)
  add(bodyShell([[0.38,0.662,0.004,0.045],[0.72,0.652,0.004,0.045],[1.20,0.572,0.004,0.04],[1.75,0.462,0.004,0.03],[2.30,0.332,0.003,0.027],[2.60,0.282,0.003,0.025]],32),bodyMat,0,0)

  // --- front wing -----------------------------------------------------------
  const wingX = p.lf + 0.75
  add(new THREE.BoxGeometry(0.44, 0.045, p.width * 0.92), carbonMat, wingX, 0.16)
  add(new THREE.BoxGeometry(0.3, 0.04, p.width * 0.8), carbonMat, wingX - 0.1, 0.25)
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

  // Recessed seat, padded cockpit edge and a carbon halo with a clear central opening.
  const seat = add(new THREE.SphereGeometry(1,32,16),darkMat,-0.06,0.505)
  seat.scale.set(0.52,0.07,0.25)
  const tube = (points: number[][], radius: number, material: THREE.Material, parent = root): THREE.Mesh =>
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(v => new THREE.Vector3(v[0]!,v[1]!,v[2]!))),64,radius,12,false),material,0,0,0,parent)
  tube([[-0.55,0.66,-0.245],[-0.12,0.64,-0.265],[0.38,0.59,-0.21],[0.46,0.59,0],[0.38,0.59,0.21],[-0.12,0.64,0.265],[-0.55,0.66,0.245]],0.024,darkMat)
  const haloPoints = [[-0.61,0.70,-0.42],[-0.30,0.78,-0.46],[0.06,0.84,-0.46],[0.36,0.865,-0.37],[0.49,0.875,-0.18],[0.51,0.875,0],[0.49,0.875,0.18],[0.36,0.865,0.37],[0.06,0.84,0.46],[-0.30,0.78,0.46],[-0.61,0.70,0.42]]
  add(haloSurface(haloPoints),carbonMat,0,0)
  add(haloSurface(haloPoints,0.445,0.555,true),accentMat,0,0)
  tube([[0.51,0.875,0],[0.58,0.76,0],[0.68,0.65,0]],0.024,carbonMat)
  for (const side of [-1,1]) {
    const mount=add(new THREE.SphereGeometry(1,20,12),bodyMat,-0.59,0.70,side*0.39)
    mount.scale.set(0.11,0.055,0.095)
  }
  const helmetMat = mat(0xe9ac28,{roughness:0.28,metalness:0})
  const helmet = add(new THREE.SphereGeometry(0.18,40,28),helmetMat,-0.13,0.72)
  helmet.scale.set(1.08,1.05,0.96)
  const visorMat = mat(0x192b38,{roughness:0.16,metalness:0.65})
  const visor=add(new THREE.SphereGeometry(0.183,32,12,0.10,Math.PI-0.20,1.13,0.44),visorMat,-0.13,0.72)
  visor.rotation.y=Math.PI/2; visor.scale.copy(helmet.scale)
  const helmetStripe=add(new THREE.SphereGeometry(0.1815,32,24,0,0.20),accentMat,-0.13,0.72)
  helmetStripe.rotation.y=Math.PI/2-0.10; helmetStripe.scale.copy(helmet.scale)
  // Wheel and gloves turn together, independently of the merged body shell.
  const cockpitWheel = new THREE.Group(); cockpitWheel.name = 'cockpit-steering'; cockpitWheel.position.set(0.29,0.79,0); root.add(cockpitWheel)
  // Rounded butterfly plate and separate grips, with readable controls on the rear face.
  const outline = new THREE.Shape()
  outline.moveTo(-0.155,0.070); outline.quadraticCurveTo(-0.18,0.055,-0.165,-0.055)
  outline.quadraticCurveTo(-0.155,-0.085,-0.11,-0.063); outline.lineTo(-0.05,-0.038)
  outline.lineTo(0.05,-0.038); outline.lineTo(0.11,-0.063)
  outline.quadraticCurveTo(0.155,-0.085,0.165,-0.055); outline.quadraticCurveTo(0.18,0.055,0.155,0.070)
  outline.lineTo(0.075,0.047); outline.lineTo(-0.075,0.047); outline.closePath()
  const rawPlate = new THREE.ExtrudeGeometry(outline,{depth:0.026,bevelEnabled:detailed,bevelSize:0.005,bevelThickness:0.005,bevelSegments:2,steps:1})
  rawPlate.rotateY(Math.PI/2)
  const plate=mergeVertices(rawPlate);rawPlate.dispose();add(plate,carbonMat,-0.018,0,0,cockpitWheel)
  const gloveMat=detailed?mat(0x334b68,{roughness:0.86,metalness:0}):darkMat
  const buttonMats=detailed?[mat(0xc4b761,{roughness:0.58,metalness:0}),mat(0x9d554a,{roughness:0.58,metalness:0}),mat(0x71999d,{roughness:0.58,metalness:0})]:[accentMat,accentMat,accentMat]
  for(const side of [-1,1]) {
    const grip=add(new THREE.SphereGeometry(1,20,12),darkMat,0.001,-0.007,side*0.155,cockpitWheel);grip.scale.set(0.035,0.083,0.029)
    const glove=add(new THREE.SphereGeometry(1,20,12),gloveMat,-0.027,-0.012,side*0.158,cockpitWheel);glove.scale.set(0.044,0.063,0.035)
    const thumb=add(new THREE.SphereGeometry(1,16,10),gloveMat,-0.041,0.019,side*0.132,cockpitWheel);thumb.scale.set(0.018,0.032,0.020)
    for(const y of [-0.030,-0.010,0.010]) {
      const seam=add(new THREE.BoxGeometry(0.003,0.002,0.035),accentMat,-0.069,y,side*0.161,cockpitWheel);seam.rotation.x=side*0.15
    }
    for(let i=0;i<3;i++) {
      const control=add(new THREE.CylinderGeometry(0.007,0.007,0.009,10),buttonMats[i]!, -0.026,0.030-i*0.022,side*(0.084+i*0.005),cockpitWheel)
      control.rotation.z=Math.PI/2
    }
    const dial=add(new THREE.CylinderGeometry(0.014,0.014,0.012,14),darkMat,-0.029,-0.048,side*0.061,cockpitWheel);dial.rotation.z=Math.PI/2
    add(new THREE.BoxGeometry(0.002,0.010,0.002),accentMat,-0.036,-0.044,side*0.061,cockpitWheel)
  }
  let displayAge=1,displaySpeed=-1
  const displayCanvas=!detailed||typeof document==='undefined'?null:document.createElement('canvas')
  if(displayCanvas){displayCanvas.width=256;displayCanvas.height=128}
  const displayTexture=displayCanvas?new THREE.CanvasTexture(displayCanvas):null
  if(displayTexture){displayTexture.colorSpace=THREE.SRGBColorSpace;displayTexture.anisotropy=4;disposables.push(displayTexture)}
  const dashMat=mat(0xe4edda,{...(displayTexture?{map:displayTexture,emissiveMap:displayTexture}:{}),roughness:0.38,metalness:0,emissive:0xb6c4a3,emissiveIntensity:0.24})
  add(new THREE.BoxGeometry(0.010,0.057,0.107),darkMat,-0.026,0.012,0,cockpitWheel)
  const display=add(new THREE.PlaneGeometry(0.096,0.048),dashMat,-0.032,0.012,0,cockpitWheel);display.rotation.y=-Math.PI/2
  const updateWheelDisplay=(speed:number,dt:number)=>{
    if(!displayCanvas||!displayTexture)return
    displayAge+=dt;const kmh=Math.round(Math.abs(speed)*3.6)
    if(displayAge<0.12||kmh===displaySpeed)return
    displayAge=0;displaySpeed=kmh;const c=displayCanvas.getContext('2d')!
    c.fillStyle='#142527';c.fillRect(0,0,256,128)
    c.fillStyle='#9bbcad';c.font='600 18px sans-serif';c.textAlign='center';c.fillText('BITE POINT',128,23)
    c.fillStyle='#e4efda';c.font='700 56px monospace';c.fillText(String(kmh).padStart(3,'0'),113,81)
    c.font='600 15px sans-serif';c.fillStyle='#94bdb9';c.fillText('KM/H',205,72)
    c.fillStyle='#677e67';c.fillRect(18,105,220,6);c.fillStyle='#c2b85d';c.fillRect(18,105,220*Math.min(1,kmh/320),6)
    displayTexture.needsUpdate=true
  }
  updateWheelDisplay(0,1)
  // Dark inner faces and padding make the shoulder shells read as a cockpit opening.
  for(const side of [-1,1]) {
    const inner=add(bodyShell([[-0.49,0.565,0.077,0.029],[-0.18,0.586,0.078,0.023],[0.18,0.56,0.064,0.023],[0.39,0.532,0.048,0.025]],24),carbonMat,0,0,side*0.211)
    inner.name='cockpit-inner-wall'
    tube([[-0.47,0.651,side*0.22],[-0.20,0.662,side*0.228],[0.14,0.635,side*0.216],[0.36,0.595,side*0.19]],0.017,darkMat)
  }
  for (const side of [-1,1]) {
    const mirror=add(new THREE.SphereGeometry(1,28,16),bodyMat,0.30,0.71,side*0.66)
    mirror.scale.set(0.075,0.046,0.135)
    const glass=add(new THREE.SphereGeometry(1,20,12),visorMat,0.234,0.71,side*0.66)
    glass.scale.set(0.007,0.033,0.102)
    tube([[0.30,0.55,side*0.36],[0.31,0.58,side*0.52],[0.30,0.69,side*0.65]],0.012,carbonMat)
  }
  const labelTexture=teamDecal('BITE POINT')
  if(labelTexture) {
    disposables.push(labelTexture)
    const labelMat=mat(0xffffff,{map:labelTexture,transparent:true,alphaTest:0.1,roughness:0.5,metalness:0,polygonOffset:true,polygonOffsetFactor:-2})
    add(haloSurface(haloPoints,0.10,0.29,true),labelMat,0,0)
    add(haloSurface(haloPoints,0.71,0.90,true),labelMat,0,0)
    for(const side of [-1,1]) {
      const label=add(new THREE.PlaneGeometry(0.34,0.085),labelMat,-0.04,0.69,side*0.31)
      label.rotation.x=-Math.PI/2; label.rotation.z=-Math.PI/2
    }
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
    front: new THREE.LatheGeometry(tyreProfile(wheelR, TYRE_W.front / 2, SHOULDER), detailed ? 64 : 32),
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
  mergeStatic(cockpitWheel, disposables, !ghost)
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
    updateCockpitSteering,
    dispose(): void {
      for (const d of disposables) d.dispose()
    },
  }
}
