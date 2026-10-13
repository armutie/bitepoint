import { RenderProfiler } from './renderProfiler'
/**
 * The three.js layer: one renderer, one scene, and the handful of things in it.
 *
 * This owns nothing about the game's rules. It is handed car states and draws
 * them, which keeps the simulation free of anything that could vary with frame
 * rate or hardware.
 *
 * **Lighting.** A directional sun with a shadow map that *follows the car* —
 * a map covering a whole 2.7 km circuit would be all resolution and no shadow,
 * so the shadow camera is a 60 m box re-centred on the car every frame. The
 * car's own shadow on the tarmac is the single strongest grounding cue there
 * is; without it the car reads as a decal sliding over the road.
 *
 * **Suspension.** The planar driving model remains unchanged. Tyre contact uses
 * the actual kerb triangles; critically damped body heave, pitch and roll
 * follow the four contacts. The cockpit camera follows that body transform.
 * The previous animation used no spring travel to
 * read. What it does have is real accelerations, and suspension travel is a
 * function of exactly those: longitudinal (dive/squat, from the frame-to-frame
 * change in vx), lateral (roll, from r·vx), and the surface under the car.
 * The wheels are moved by those numbers. It is a visual approximation driven
 * by real dynamics, not invented motion — the same principle as the camera's
 * weight-transfer pitch.
 */
import * as THREE from 'three'

import type { CarState } from '../core/car'
import type { CarParams } from '../core/carParams'
import type { Track } from '../core/track'
import { handlingPreset } from '../core/carParams'
import { wrapAngle } from '../core/math'
import { indexAtDistance, type AttractLine } from './attractLine'
import { CameraRig, type CameraMode, type Surface } from './cameras'
import { buildCar, SKINS, type CarModel, type CarSkin } from './carModel'
import { FIELD_LIVERIES } from './liveries'
import { PALETTE } from './palette'

// Shared by the visible sky, reflection capture and shadow-casting sunlight.
const SUN_OFFSET = new THREE.Vector3(140, 20, 190)
import { PostPipeline } from './post'
import { renderQuality, viewportPixelRatio, AdaptivePixelRatio } from './quality'
import { buildScenery, type Scenery } from './scenery'
import { buildTerrain } from './terrain'
import { buildWorld, type World } from './world'
import { TrackSurface } from './trackSurface'
import { ContactSuspension } from './contactSuspension'

/** Rough top speed, for normalising the post pipeline's speed input. */
const TOP_SPEED = 75

/**
 * How solid the spokes look at a given wheel rate (rad/s).
 *
 * Anything on a wheel sampled at 60 Hz aliases once it comes round faster than
 * the frame rate can follow, and past that a correctly spinning wheel reads as
 * stationary, or as turning backwards. That is the wagon-wheel effect, and it
 * makes accurate motion look like a bug. So the markings fade as they speed up,
 * which is what a camera's motion blur does to a real wheel.
 *
 * Five spokes cross the frame five times a revolution and are bright, so they
 * alias early — about 38 rad/s, call it 45 km/h — and are faded hard.
 */
function spokeBlur(omega: number): number {
  const a = Math.abs(omega)
  if (a <= 18) return 1
  if (a >= 40) return 0.06
  return 1 - 0.94 * ((a - 18) / 22)
}

/**
 * The same, for the tyre scuffs, and far gentler.
 *
 * Three marks rather than five, irregularly spaced rather than symmetric, and
 * barely lighter than the rubber they sit on — so what aliasing survives reads
 * as texture shimmering rather than a light flashing. They never disappear
 * completely: a tyre with no marking at all looks moulded.
 */
function scuffBlur(omega: number): number {
  const a = Math.abs(omega)
  if (a <= 26) return 1
  if (a >= 70) return 0.3
  return 1 - 0.7 * ((a - 26) / 44)
}

/** Suspension animation gains. Travel is clamped to ±5 cm. */

/** How many cars lap the circuit behind the menu. */
const ATTRACT_COUNT = 10

/** Liveries for the attract-mode field and for a race grid — see `liveries.ts`. */
const ATTRACT_SKINS: readonly CarSkin[] = FIELD_LIVERIES

interface AttractCar {
  model: CarModel
  /** Arc position, speed, and a lane offset — the fallback follower's state. */
  s: number
  v: number
  off: number
  /** Small pace handicap, so the battle pair actually swaps around. */
  pace: number
  /**
   * Position in this car's racing line, as a fractional pose index. Advanced
   * in real time, so a car drives its recorded lap at the speed it was driven
   * — cars sharing a line simply started at different points on it.
   */
  idx: number
  /** Which of the available laps this car is driving. */
  line: number
}

export class Renderer {
  readonly canvas: HTMLCanvasElement
  readonly rig: CameraRig

  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly post: PostPipeline
  private readonly sun: THREE.DirectionalLight
  private world: World | null = null
  private scenery: Scenery | null = null
  /**
   * The attract field's cars live under one group so the whole field can be
   * DETACHED from the scene while driving, not merely hidden. `visible=false`
   * skips drawing but not matrix updates — three.js recomposes every attached
   * object's matrices every frame, moved or not, and ten cars of suspension
   * arms and wheel rigs were paying that all lap for a field nobody could see.
   */
  private readonly attractGroup = new THREE.Group()
  private attract: AttractCar[] = []
  private attractTrack: Track | null = null
  private attractLines: AttractLine[] = []
  /** The field is all one preset, so one radius serves every car in it. */
  private attractWheelRadius = 0.33
  private playerCar: CarModel | null = null
  private ghostCar: CarModel | null = null
  /** The AI field, one model per opponent. Empty outside a race. */
  private opponents: CarModel[] = []
  private opponentStates: readonly CarState[] = []
  private debugLine: THREE.Line | null = null
  private readonly environment: THREE.WebGLRenderTarget
  private profiler: RenderProfiler | null = null
  toggleProfiling(): void {
    if(this.profiler){this.profiler.dispose();this.profiler=null}
    else this.profiler=new RenderProfiler(this.renderer.getContext() as WebGL2RenderingContext)
  }

  private sky: THREE.Mesh
  private performanceMode = false
  private pixelRatio = 1
  private adaptive=new AdaptivePixelRatio(1)
  private viewportWidth=0
  private viewportHeight=0

  private trackSurface: TrackSurface | null = null
  private readonly contactSuspension = new ContactSuspension()
  private readonly cameraTilt = new THREE.Quaternion()
  private readonly cameraYawInverse = new THREE.Quaternion()
  private readonly cameraOffset = new THREE.Vector3()

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    })
    this.pixelRatio = renderQuality(false, window.devicePixelRatio).pixelRatio
    this.renderer.setPixelRatio(this.pixelRatio)
    // Manual reset: the composer renders several passes per frame, and
    // auto-reset would leave info holding only the last full-screen quad.
    this.renderer.info.autoReset = false
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.36
    this.scene = new THREE.Scene()
    // Fog must start beyond the terrain hills (they peak around 520 m) or it
    // quietly erases them — which is exactly what the first tune did.
    this.scene.fog = new THREE.Fog(PALETTE.SKY_BOT, 540, 2900)

    this.sky = buildSky()
    this.scene.add(this.sky)
    // Capture the same sky used by the backdrop into a filtered reflection map.
    // One small precomputation gives paint, rubber and carbon coherent outdoor light.
    const environmentScene = new THREE.Scene()
    const environmentSky = buildSky()
    environmentScene.add(environmentSky)
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(10000,10000),
      new THREE.MeshBasicMaterial({color:0x525c48}))
    ground.rotation.x = -Math.PI/2; ground.position.y = -4
    environmentScene.add(ground)
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.environment = pmrem.fromScene(environmentScene, 0.04, 0.1, 3000)
    this.scene.environment = this.environment.texture
    this.scene.environmentIntensity = 0.85
    pmrem.dispose(); environmentSky.geometry.dispose()
    ;(environmentSky.material as THREE.Material).dispose()
    ground.geometry.dispose(); ground.material.dispose()

    // Ambient held low on purpose: the ratio of sun to ambient is what makes
    // faces facing the light pop and shadow sides fall away. With ambient near
    // the sun's level everything is lit the same and the world reads flat.
    const hemi = new THREE.HemisphereLight(0xc3ccdc, 0x81735e, 1.25)
    this.scene.add(hemi)

    this.sun = new THREE.DirectionalLight(0xffd49a, 2.5)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(1024, 1024)
    const sc = this.sun.shadow.camera
    sc.left = -30
    sc.right = 30
    sc.top = 30
    sc.bottom = -30
    sc.near = 20
    sc.far = 800
    this.sun.shadow.bias = -0.00008
    this.sun.shadow.normalBias = 0.015
    this.scene.add(this.sun, this.sun.target)

    this.rig = new CameraRig(1)
    this.post = new PostPipeline(this.renderer, this.scene, this.rig.camera)
    this.post.setSunDirection(SUN_OFFSET)
    this.resize()
  }

  /** Swap in a circuit, disposing whatever was there. */
  setDebugLine(points: { x: number; y: number }[] | null): void {
    if (this.debugLine) {
      this.scene.remove(this.debugLine)
      this.debugLine.geometry.dispose()
      ;(this.debugLine.material as THREE.Material).dispose()
      this.debugLine = null
    }
    if (!points || points.length < 2) return
    const positions = new Float32Array((points.length + 1) * 3)
    for (let i = 0; i <= points.length; i++) {
      const point = points[i % points.length]!
      positions.set([point.x, 0.12, -point.y], i * 3)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this.debugLine = new THREE.Line(geometry,
      new THREE.LineBasicMaterial({ color: 0xff3b6b, depthTest: true }))
    this.scene.add(this.debugLine)
  }

  /** Swap in a circuit, disposing whatever was there. */
  setTrack(track: Track): void {
    this.setDebugLine(null)
    this.trackSurface = new TrackSurface(track)
    if (this.world) {
      this.scene.remove(this.world.root)
      this.world.dispose()
    }
    if (this.scenery) {
      this.scene.remove(this.scenery.root)
      this.scenery.dispose()
    }
    const terrain = buildTerrain(track)
    this.world = buildWorld(track, terrain)
    this.scenery = buildScenery(track, terrain)
    this.scene.add(this.world.root, this.scenery.root)
    // The circuit never moves, so its matrices are computed once, here, and
    // never again. three.js re-walks the whole scene every render and, with
    // `matrixAutoUpdate` on, re-composes every object's matrix from its
    // position/quaternion/scale — for the few hundred static objects of road,
    // wall and scenery that was the single largest JS cost in a CPU profile
    // of a driving session, all of it recomputing values that never change.
    this.scene.updateMatrixWorld(true)
    this.world.root.traverse((o) => { o.matrixAutoUpdate = false; o.matrixWorldAutoUpdate = false })
    this.scenery.root.traverse((o) => { o.matrixAutoUpdate = false })
    this.buildAttractField(track)
  }

  /**
   * The attract-mode field: ten cars lapping the circuit behind the menu.
   *
   * Where they drive depends on what is available. Given baked racing lines
   * (see `setAttractLines`) the field is dealt across them, so a menu can show
   * your current best and the bests it beat lapping together — and because
   * each car drives its own lap at the speed it was driven, the quicker laps
   * genuinely reel the older ones in. With nothing recorded to replay — a
   * fresh player, or a circuit never driven — they fall back to the kinematic
   * centreline-followers this used to be: they read the road's curvature for a
   * target speed, they never crash, and ten of them cost microseconds.
   */
  private buildAttractField(track: Track): void {
    for (const c of this.attract) {
      this.attractGroup.remove(c.model.root)
      c.model.dispose()
    }
    this.attract = []
    this.attractTrack = track

    const p = handlingPreset('f1')
    this.attractWheelRadius = p.wheelRadius
    const L = track.length
    for (let i = 0; i < ATTRACT_COUNT; i++) {
      const model = buildCar(p, ATTRACT_SKINS[i % ATTRACT_SKINS.length]!, { detail: 'field' })
      model.root.visible = false
      this.attractGroup.add(model.root)
      // Fallback state: evenly round the lap, alternating lanes, and a pace
      // spread wide enough that the order keeps changing.
      this.attract.push({
        model,
        s: ((i + 0.5) / ATTRACT_COUNT) * L,
        v: 30,
        off: (i % 2 === 0 ? -1 : 1) * (0.7 + (i % 3) * 0.6),
        pace: 0.97 + (i % 5) * 0.014,
        idx: 0,
        line: 0,
      })
    }
    this.seedAttractLines()
  }

  /**
   * Hand the field the laps to drive, newest first. Empty falls back to the
   * followers.
   *
   * Called whenever the circuit or the car changes, since a racing line only
   * means anything for the lap it was set on.
   */
  setAttractLines(lines: AttractLine[]): void {
    this.attractLines = lines
    this.seedAttractLines()
  }

  /**
   * Deal the field across the available laps and space each group by distance.
   *
   * Dealt round-robin rather than in blocks, so with two laps and ten cars the
   * five on each are spread right round the circuit instead of the new lap
   * occupying one half of it and the old lap the other.
   *
   * Each lap's group is then offset by a fraction of its own spacing. Without
   * that, every group spaces itself identically from the line — five cars at
   * 0, 1/5, 2/5 … — and two laps put ten cars on top of each other in five
   * overlapping pairs. Staggering interleaves them: 0, 1/10, 2/10 … right
   * round the circuit.
   */
  private seedAttractLines(): void {
    const lines = this.attractLines
    if (!lines.length) return
    for (let i = 0; i < this.attract.length; i++) {
      const car = this.attract[i]!
      car.line = i % lines.length
      const line = lines[car.line]!
      // How many cars share this lap, and which of them this one is.
      const shared = Math.ceil((this.attract.length - car.line) / lines.length)
      const nth = Math.floor(i / lines.length)
      const phase = (nth + car.line / lines.length) / shared
      car.idx = indexAtDistance(line, phase * line.total)
    }
  }

  private updateAttract(dtWall: number): void {
    if (this.attractLines.length) {
      this.driveAttractLines(dtWall)
      return
    }
    const track = this.attractTrack
    if (!track) return
    for (const car of this.attract) {
      // Speed from the road ahead: the tightest curvature in the braking
      // window sets the target, approached with sensible accel/brake rates.
      const look = 24 + car.v * 1.4
      let k = 1e-4
      for (let d = 8; d <= look; d += 10) {
        k = Math.max(k, Math.abs(track.signedCurvatureAt(car.s + d)))
      }
      const vTarget = Math.min(Math.max(Math.sqrt(15 / k), 16), 62) * car.pace
      const dv = vTarget - car.v
      car.v += Math.max(-26 * dtWall, Math.min(dv, 11 * dtWall))
      car.s = (car.s + car.v * dtWall) % track.length

      const pose = track.poseAt(car.s)
      // A gentle weave inside the lane keeps them from looking rail-mounted.
      const off = car.off + Math.sin(car.s * 0.011 + car.off * 7) * 0.7
      const x = pose.x - Math.sin(pose.yaw) * off
      const y = pose.y + Math.cos(pose.yaw) * off
      car.model.root.visible = true
      car.model.root.position.set(x, 0, -y)
      car.model.root.rotation.y = pose.yaw
      // Steer the front wheels with the road, so close passes look driven.
      const steer = Math.max(-0.35, Math.min(track.signedCurvatureAt(car.s + 12) * 9, 0.35))
      for (const w of car.model.frontWheels) w.rotation.y = steer
      car.model.updateSuspension()
      this.rollWheels(car.model, car.v, car.v, this.attractWheelRadius, dtWall)
    }
  }

  /**
   * Walk each car along the lap it was dealt.
   *
   * The index is fractional and advanced by wall time over the recording's own
   * step, so every replay runs at the speed it was driven however fast the menu
   * is being rendered. Poses interpolate between samples, and yaw interpolates
   * through `wrapAngle` — lerping raw yaw would spin a car the long way round
   * at the ±pi seam, once per lap, in whichever corner happens to sit there.
   */
  private driveAttractLines(dtWall: number): void {
    for (const car of this.attract) {
      const line = this.attractLines[car.line]
      if (!line) continue
      const n = line.poses.length
      car.idx = (car.idx + dtWall / line.dt) % n
      const i = Math.floor(car.idx)
      const a = line.poses[i]!
      const b = line.poses[(i + 1) % n]!
      const t = car.idx - i

      const yaw = a.yaw + wrapAngle(b.yaw - a.yaw) * t
      car.model.root.visible = true
      car.model.root.position.set(a.x + (b.x - a.x) * t, 0, -(a.y + (b.y - a.y) * t))
      car.model.root.rotation.y = yaw
      // The driver's own steering input, not a guess from the road's curvature.
      const steer = a.steer + (b.steer - a.steer) * t
      for (const w of car.model.frontWheels) w.rotation.y = steer
      car.model.updateSuspension()
      // Speed from the line itself: the gap between two consecutive poses is
      // one recorded tick's worth of travel, so this is the speed the lap was
      // actually driven at, corner by corner. Both axles get it — a replay has
      // no wheelspin to show, only road speed.
      const v = Math.hypot(b.x - a.x, b.y - a.y) / line.dt
      this.rollWheels(car.model, v, v, this.attractWheelRadius, dtWall)
    }
  }

  setCars(params: CarParams, withGhost: boolean): void {
    if (this.playerCar) {
      this.scene.remove(this.playerCar.root)
      this.playerCar.dispose()
      this.playerCar = null
    }
    if (this.ghostCar) {
      this.scene.remove(this.ghostCar.root)
      this.ghostCar.dispose()
      this.ghostCar = null
    }
    this.playerCar = buildCar(params, SKINS.player)
    this.scene.add(this.playerCar.root)
    if (withGhost) {
      this.ghostCar = buildCar(params, SKINS.ghost, { ghost: true, detail: 'field' })
      this.scene.add(this.ghostCar.root)
    }
  }

  /**
   * Build (or clear) the AI field for a race.
   *
   * Separate from `setCars` because the two have different lifetimes: the
   * player's car and the ghost belong to the SESSION, and the opponents belong
   * to one race. Rebuilding the player's car to add an opponent would drop the
   * camera rig's target mid-frame.
   *
   * Liveries come from the attract field's, which already exist precisely so
   * that a grid of identical cars is distinguishable — with the player's own
   * blue deliberately not among them.
   */
  setOpponents(params: CarParams, count: number, driverIds?: readonly number[]): void {
    for (const car of this.opponents) {
      this.scene.remove(car.root)
      car.dispose()
    }
    this.opponents = []
    for (let i = 0; i < count; i++) {
      const identity = driverIds?.[i] ?? i
      const car = buildCar(params, ATTRACT_SKINS[identity % ATTRACT_SKINS.length]!, { detail: 'field' })
      this.scene.add(car.root)
      this.opponents.push(car)
    }
  }

  /**
   * Where the opponents are this frame, in the same slot order as `setOpponents`.
   *
   * Set rather than passed to `render` because the player's slot is skipped by
   * the caller: the renderer should not have to know which index of a race is
   * the person playing it.
   */
  setOpponentStates(states: readonly CarState[]): void {
    this.opponentStates = states
  }

  /** Add the ghost model without rebuilding the player's car at the line. */
  ensureGhost(params: CarParams): void {
    if (this.ghostCar) return
    this.ghostCar = buildCar(params, SKINS.ghost, { ghost: true })
    this.scene.add(this.ghostCar.root)
  }

  /**
   * Whether the player WANTS the ghost shown — kept apart from the mesh's
   * `visible`, which also depends on whether a replay is currently running.
   * The old code derived the preference from `root.visible` itself
   * (`visible = ghost !== null && visible`), which latches: one frame with no
   * replay running — the staging run, or right after R — wrote false, and
   * false stayed false forever. That was the "sometimes no ghost" bug.
   */
  private wantGhost = true
  /** Eased ghost opacity, driven by the gap to the player each frame. */
  private ghostOpacity = 0.4

  get ghostVisible(): boolean {
    return this.wantGhost
  }

  set ghostVisible(v: boolean) {
    this.wantGhost = v
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    const ceiling=viewportPixelRatio(w,h,renderQuality(this.performanceMode,window.devicePixelRatio).pixelRatio)
    if(w!==this.viewportWidth||h!==this.viewportHeight||this.adaptive.ceiling!==ceiling){
      this.viewportWidth=w;this.viewportHeight=h;this.adaptive=new AdaptivePixelRatio(ceiling);this.pixelRatio=ceiling
    }
    this.pixelRatio=Math.min(this.pixelRatio,ceiling)
    this.renderer.setPixelRatio(this.pixelRatio)
    this.renderer.setSize(w, h, false)
    this.post.setSize(w, h, this.pixelRatio)
    this.rig.resize(w / h)
  }

  /**
   * @param player the car state to draw the player at (already interpolated)
   * @param ghost the ghost's state, or null when there is no ghost running
   * @param throttle signed pedal, for the camera's weight transfer
   * @param dtWall real seconds since the last frame
   * @param surface where the car sits relative to the painted edge
   */
  render(
    player: CarState,
    ghost: CarState | null,
    params: CarParams,
    throttle: number,
    dtWall: number,
    surface: Surface | null = null,
  ): void {
    if(!document.hidden&&!this.performanceMode){const ratio=this.adaptive.observe(dtWall);if(ratio!==null){this.pixelRatio=ratio;this.resize()}}
    const profileStart=performance.now(); this.profiler?.begin()
    this.renderer.info.reset()
    if (this.scenery) {
      this.scenery.root.visible = true
      this.scenery.decorativeRoot.visible = !this.performanceMode
    }
    this.rig.update(player, params, throttle, dtWall, surface)

    // The attract field belongs to the menu; while driving it stands down —
    // detached entirely, so its thousand-odd parts cost no matrix work either.
    if (this.attractGroup.parent) this.scene.remove(this.attractGroup)

    if (this.playerCar) {
      placeCar(this.playerCar, player)
      // The Python hood cam draws no car at all — and the mount is inside the
      // bodywork. Every other view shows it; the halo cam exists to.
      this.playerCar.root.visible = this.rig.mode !== 'hood'
      this.animateSuspension(this.playerCar, player, dtWall)
      this.playerCar.updateCockpitSteering(Math.hypot(player.vx, player.vy), dtWall)
      this.rollWheels(this.playerCar, player.vx, player.wheelVr, params.wheelRadius, dtWall)
    }
    // The AI field. Drawn with the same suspension travel and wheel roll as the
    // player's car, because a grid of cars whose wheels do not turn reads as
    // scenery sliding past rather than as cars being driven.
    for (let i = 0; i < this.opponents.length; i++) {
      const car = this.opponents[i]!
      const s = this.opponentStates[i]
      car.root.visible = s !== undefined
      if (!s) continue
      placeCar(car, s)
      this.animateSuspension(car, s, dtWall)
      car.updateCockpitSteering(Math.hypot(s.vx, s.vy), dtWall)
      this.rollWheels(car, s.vx, s.wheelVr, params.wheelRadius, dtWall)
    }

    if (this.ghostCar) {
      // Computed fresh every frame from preference AND replay state — never
      // read back from itself.
      this.ghostCar.root.visible = this.wantGhost && ghost !== null
      if (ghost) {
        placeCar(this.ghostCar, ghost)
        this.animateSuspension(this.ghostCar, ghost, dtWall)
        this.ghostCar.updateCockpitSteering(Math.hypot(ghost.vx, ghost.vy), dtWall)
        // Fade the ghost as the gap closes: at under ~0.05 s you are driving
        // inside it, and a solid car there is a windscreen sticker. The gap is
        // measured in TIME (distance over the player's speed), matching the
        // delta the HUD shows.
        const dist = Math.hypot(ghost.x - player.x, ghost.y - player.y)
        const gap = dist / Math.max(Math.hypot(player.vx, player.vy), 5)
        const target = gap <= 0.05 ? 0.09 : gap >= 0.3 ? 0.4 : 0.09 + ((gap - 0.05) / 0.25) * 0.31
        // Eased, so crossing the threshold breathes instead of popping.
        this.ghostOpacity += (target - this.ghostOpacity) * Math.min(1, dtWall * 8)
        for (const m of this.ghostCar.materials) m.opacity = this.ghostOpacity
        // The ghost's wheels turn too — a replay with locked wheels reads as a
        // cardboard cut-out being dragged round the lap. Its spoke fade is the
        // blur multiplied by whatever the ghost's own transparency is.
        this.rollWheels(
          this.ghostCar, ghost.vx, ghost.wheelVr, params.wheelRadius, dtWall,
          this.ghostOpacity,
        )
      }
    }

    if (this.playerCar) {
      const root = this.playerCar.root, camera = this.rig.camera
      if (this.rig.mode === 'halo' || this.rig.mode === 'hood') {
        this.cameraYawInverse.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, -player.yaw)
        this.cameraTilt.copy(root.quaternion).multiply(this.cameraYawInverse)
        this.cameraOffset.set(camera.position.x-player.x,camera.position.y,camera.position.z+player.y).applyQuaternion(this.cameraTilt)
        camera.position.set(player.x+this.cameraOffset.x,root.position.y+this.cameraOffset.y,-player.y+this.cameraOffset.z)
        camera.quaternion.premultiply(this.cameraTilt)
      } else camera.position.y += root.position.y
    }
    this.followWithSun(player.x, -player.y)
    this.sky.position.copy(this.rig.camera.position)

    const speed = Math.hypot(player.vx, player.vy)
    this.post.render(speed / TOP_SPEED)
    this.profiler?.end(performance.now()-profileStart,dtWall,this.renderer)
  }

  /** Draw the circuit with the attract camera, for the menu to sit over. */
  renderFlyover(track: Track, t: number, dtWall: number): void {
    const profileStart=performance.now(); this.profiler?.begin()
    this.renderer.info.reset()
    // The menu is allowed to remain fully dressed; Performance Mode is about
    // keeping the car responsive while the player is actually driving.
    if (this.scenery) {
      this.scenery.root.visible = true
      this.scenery.decorativeRoot.visible = true
    }
    if (this.playerCar) this.playerCar.root.visible = false
    if (this.ghostCar) this.ghostCar.root.visible = false
    if (!this.attractGroup.parent) this.scene.add(this.attractGroup)
    this.updateAttract(dtWall)
    this.rig.flyover(track, t)
    const eye = this.rig.camera.position
    this.followWithSun(eye.x, eye.z)
    this.sky.position.copy(eye)
    this.post.render(0)
    this.profiler?.end(performance.now()-profileStart,dtWall,this.renderer)
  }

  setClassicFraming(enabled: boolean): void {
    this.rig.classicFraming = enabled
  }

  /** Compile new car/scenery materials during session setup, before driving. */
  async prepare(): Promise<void> { await this.renderer.compileAsync(this.scene,this.rig.camera) }

  setCameraMode(mode: CameraMode): void {
    this.rig.mode = mode
  }

  /** Apply the player's camera/image preferences. */
  applySettings(s: {
    effects: number
    fovKick: number
    shake: number
    performanceMode: boolean
  }): void {
    this.rig.fovKick = s.fovKick
    this.rig.shake = s.shake
    this.post.setEffects(s.effects)
    this.post.setPerformanceMode(s.performanceMode)

    const quality = renderQuality(s.performanceMode, window.devicePixelRatio)
    const ratioChanged = quality.pixelRatio !== this.pixelRatio
    const shadowChanged = quality.shadowMapSize !== this.sun.shadow.mapSize.width
    this.performanceMode = s.performanceMode
    this.adaptive=new AdaptivePixelRatio(viewportPixelRatio(this.canvas.clientWidth||window.innerWidth,this.canvas.clientHeight||window.innerHeight,quality.pixelRatio))
    this.pixelRatio = this.adaptive.value
    if (shadowChanged) {
      this.sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize)
      this.sun.shadow.map?.dispose()
      this.sun.shadow.map = null
    }
    if (ratioChanged) this.resize()
  }

  /**
   * Keep the sun's shadow box centred on the action. The light direction never
   * changes — only the box slides, so shadows stay put in the world.
   */
  private followWithSun(x: number, z: number): void {
    this.sun.position.set(x + SUN_OFFSET.x, SUN_OFFSET.y, z + SUN_OFFSET.z)
    this.sun.target.position.set(x, 0, z)
  }

  /** Independent tyre contact and damped body movement for every car. */
  private animateSuspension(model: CarModel, s: CarState, dt: number): void {
    if (this.trackSurface) this.contactSuspension.update(model, s, this.trackSurface, dt)
    else model.updateSuspension()
  }

  /**
   * Roll the wheels, and blur the spokes when they are turning too fast to see.
   *
   * Kept apart from `animateSuspension` because that one carries frame-to-frame
   * state (`prevVx`) for its acceleration estimate, and calling it for the
   * ghost as well as the player would have each car differentiating the other's
   * speed. This is stateless per call.
   *
   * The two axles are given different speeds on purpose. The FRONT is undriven
   * and turns at road speed; the REAR turns at `wheelVr`, the driven-wheel
   * speed the tyre model already integrates. That is what makes wheelspin
   * visible — light them up out of a hairpin and the rears visibly outrun the
   * car — and it costs nothing, because the number was already there.
   */
  private rollWheels(
    model: CarModel, frontSpeed: number, rearSpeed: number,
    radius: number, dtWall: number, baseOpacity = 1,
  ): void {
    for (const rig of model.wheels) {
      rig.angle += ((rig.front ? frontSpeed : rearSpeed) / radius) * dtWall
      // Negative: about +z a positive angle carries the top of the wheel
      // backwards, and the car would drive along with its wheels in reverse.
      rig.spin.rotation.z = -rig.angle
    }
    const omega = Math.max(Math.abs(frontSpeed), Math.abs(rearSpeed)) / radius
    model.spokeMaterial.opacity = baseOpacity * spokeBlur(omega)
    model.scuffMaterial.opacity = baseOpacity * scuffBlur(omega)
  }

  /** Live camera FOV, for probes that check authentic mode is actually on. */
  get cameraFov(): number { return this.rig.camera.fov }

  get fovKick(): number { return this.rig.fovKick }

  /** three.js's own frame counters, for performance probes. */
  stats(): {
    calls: number; triangles: number; geometries: number; textures: number; programs: number
    pixelRatio: number; postProcessing: boolean; performanceMode: boolean
  } {
    const info = this.renderer.info
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      pixelRatio: this.pixelRatio,
      postProcessing: this.post.active,
      performanceMode: this.performanceMode,
    }
  }

  dispose(): void {
    this.profiler?.dispose()
    if (this.world) this.world.dispose()
    if (this.scenery) this.scenery.dispose()
    for (const c of this.attract) c.model.dispose()
    this.playerCar?.dispose()
    this.ghostCar?.dispose()
    this.sky.geometry.dispose()
    ;(this.sky.material as THREE.Material).dispose()
    this.environment.dispose()
    this.post.dispose()
    this.renderer.dispose()
  }
}


/** sim (x, y, yaw) -> three placement. See the coordinate note in world.ts. */
function placeCar(model: CarModel, s: CarState): void {
  model.root.position.set(s.x, 0, -s.y)
  model.root.rotation.y = s.yaw
  // The steering angle is already the road-wheel angle in radians.
  for (const w of model.frontWheels) w.rotation.y = s.steer
}

/**
 * The sky: gradient, a sun disc that matches the shadow direction, procedural
 * clouds, and two hill ridges on the horizon.
 *
 * The hills follow the Python renderer's reasoning exactly — at a couple of
 * kilometres there is no translational parallax worth modelling, hills turn
 * with your heading and nothing else, which is precisely what a view-direction
 * shader does. Ridge heights are sums of *integer* harmonics of azimuth, so
 * they are continuous across the ±pi seam by construction. Cloud noise is
 * sampled on a projected sky plane rather than azimuth, for the same reason —
 * a non-periodic noise in azimuth would show a vertical seam at one heading.
 */
function buildSky(): THREE.Mesh {
  const geom = new THREE.SphereGeometry(2200, 32, 20)
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      horizon: { value: new THREE.Color(PALETTE.SKY_BOT) },
      zenith: { value: new THREE.Color(PALETTE.SKY_TOP) },
      // The sky disc and shadows share the same low sun direction.
      sunDir: { value: SUN_OFFSET.clone().normalize() },
      cloudLit: { value: new THREE.Color(0xffe3bc) },
      cloudShade: { value: new THREE.Color(0x8f9eaf) },
      hillFar: { value: new THREE.Color(0x9faeb8) },
      hillNear: { value: new THREE.Color(0x687268) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 world = modelMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 horizon;
      uniform vec3 zenith;
      uniform vec3 sunDir;
      uniform vec3 cloudLit;
      uniform vec3 cloudShade;
      uniform vec3 hillFar;
      uniform vec3 hillNear;
      varying vec3 vDir;

      float h21(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
          mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }
      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int k = 0; k < 4; k++) {
          v += a * vnoise(p);
          p = p * 2.03 + 17.1;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        vec3 dir = normalize(vDir);
        float h = dir.y;
        float az = atan(dir.z, dir.x);

        // Base gradient.
        float t = clamp(pow(max(h, 0.0), 0.38), 0.0, 1.0);
        vec3 col = mix(horizon, zenith, t);

        float d = max(dot(dir, sunDir), 0.0);
        // Blue sky remains clear; warmth is localized around the light source.
        col += vec3(1.0, 0.61, 0.28) * pow(d, 18.0) * 0.065;
        if (h > 0.015) {
          vec2 p = dir.xz / (h + 0.30) * 2.15;
          float density = fbm(p);
          float sunBank = pow(d, 70.0);
          // A broken cloud bank veils the sun, without drawing a hard circle.
          float bankShape = smoothstep(0.34, 0.60, fbm(p * 2.8 + 3.7));
          float cover = max(smoothstep(0.43, 0.65, density), sunBank * bankShape);
          float toward = fbm(p + normalize(sunDir.xz + 1e-3) * 0.12);
          float lit = clamp(0.48 + (density - toward) * 3.2, 0.0, 1.0);
          float band = smoothstep(0.015, 0.065, h) * (1.0 - smoothstep(0.7, 0.98, h));
          float opacity = cover * band * 0.94;
          vec3 cloud = mix(cloudShade, cloudLit, lit);
          col = mix(col, cloud, opacity);
          // HDR transmission and bright cloud edges feed the camera bloom.
          float brokenLight = smoothstep(0.30, 0.66, fbm(p * 5.4 + 12.0));
          float silver = pow(d, 280.0) * pow(max(4.0 * opacity * (1.0 - opacity), 0.0), 2.4);
          float transmitted = pow(d, 950.0) * pow(1.0 - opacity, 3.0);
          col += vec3(1.0, 0.86, 0.65) * (silver * 0.75 * brokenLight + transmitted * 2.0);
          // Short, irregular shafts through gaps: cloud structure breaks up the fan.
          vec3 sunRight = normalize(cross(vec3(0.0, 1.0, 0.0), sunDir));
          vec3 sunUp = cross(sunDir, sunRight);
          vec2 rayPlane = vec2(dot(dir, sunRight), dot(dir, sunUp));
          float rayRadius = length(rayPlane);
          float rayAngle = atan(rayPlane.y, rayPlane.x);
          float shafts = pow(max(0.0, sin(rayAngle * 8.0 + sin(rayAngle * 3.0) * 1.7)), 9.0);
          float rayReach = smoothstep(0.022, 0.045, rayRadius) * (1.0 - smoothstep(0.07, 0.20, rayRadius));
          float gaps = smoothstep(0.24, 0.65, fbm(p * 3.0 + 9.2));
          col += vec3(1.0, 0.85, 0.62) * shafts * rayReach * gaps * 0.13 * (1.0 - opacity * 0.55);
        }

        // Hill ridges. Integer harmonics of azimuth: seam-free by construction.
        float far = 0.035
          + 0.016 * sin(3.0 * az + 1.7)
          + 0.011 * sin(5.0 * az + 0.4)
          + 0.007 * sin(8.0 * az + 3.1);
        float near = 0.020
          + 0.014 * sin(4.0 * az + 0.9)
          + 0.010 * sin(7.0 * az + 2.2)
          + 0.006 * sin(11.0 * az + 5.0);

        if (h < far) {
          // Haze toward the horizon line, so the ridge sits in atmosphere.
          float k = clamp((far - h) / 0.05, 0.0, 1.0);
          col = mix(col, hillFar, k * 0.85);
        }
        if (h < near) {
          float k = clamp((near - h) / 0.04, 0.0, 1.0);
          col = mix(col, hillNear, k * 0.9);
        }

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
  const mesh = new THREE.Mesh(geom, mat)
  mesh.renderOrder = -1
  return mesh
}
