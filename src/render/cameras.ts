/**
 * The camera rigs, the weight transfer you feel through them, and the road
 * feel (ported from ``racing/render3d.py`` — see the constants there).
 *
 * **Field of view.** The Python renderer computes
 * ``focal = (SCREEN_W / 2) / tan(FOV / 2)``, so its FOV is *horizontal*.
 * three.js's ``PerspectiveCamera.fov`` is *vertical*. Everything here is
 * authored as a horizontal angle and converted against the live aspect ratio;
 * passing 74 straight through as vertical gave a ~100-degree fish-eye at 16:9.
 *
 * **The halo cam** is framed off the real broadcast shot: mounted above and
 * behind the driver's head, pitched down, wide — so the helmet sits
 * bottom-centre, the halo ring sweeps the lower frame, and both front tyres
 * are in view at the edges, visibly working. It is a *body-mounted* camera:
 * every bit of bob, chatter and lean the chassis feels, it feels.
 */
import * as THREE from 'three'

import type { CarParams } from '../core/carParams'
import type { CarState } from '../core/car'

export type CameraMode = 'halo' | 'hood' | 'chase' | 'topDown'

export const CAMERA_ORDER: readonly CameraMode[] = ['halo', 'hood', 'chase', 'topDown']

export const CAMERA_LABEL: Record<CameraMode, string> = {
  halo: 'Halo',
  hood: 'Hood',
  chase: 'Chase',
  topDown: 'Overhead',
}

/** Hood-cam rig, from render3d.py. */
const CAM_FWD = 1.3
const CAM_HEIGHT = 1.15
const CAM_PITCH = (9.0 * Math.PI) / 180

/**
 * Halo-cam rig: above and behind the driver's head, looking down the car.
 *
 * The height matters more than it looks: the halo ring's crown sits at 0.91 m,
 * and the camera must be clearly *above* it so the shot looks over the ring —
 * ring in the lower third, road dominant — as the broadcast framing does.
 * Mounted at ring height it stares through the hoop and the ring eats the
 * whole lower half of the frame.
 */
const HALO_BACK = 0.52
const HALO_HEIGHT = 1.38
const HALO_PITCH = (11.5 * Math.PI) / 180

/** Horizontal fields of view, in degrees. */
const HFOV = { halo: 78, hood: 74, chase: 74, topDown: 60 }

/**
 * Attract-camera pace: how fast the menu shot travels the circuit (m/s), and
 * the rate of its height bob. The bob is scaled with the speed rather than left
 * where it was, so the camera still rises and falls once over roughly the same
 * stretch of road — decoupled, a slower fly-past would bob visibly more often
 * per corner and read as a different move rather than the same one, slower.
 */
const FLYOVER_SPEED = 35
const FLYOVER_BOB = 0.175

/** Road feel, from render3d.py. Distances in metres, angles in radians. */
const RUMBLE_BASE = 0.003
const RUMBLE_SPEED_REF = 45.0
const BUMP_FREQ = 0.5
// Kerb/grass amplitudes run below the Python constants (0.014 / 0.025 / 0.02).
// Those were tuned for a renderer whose whole world wobbled a little; applied
// to a rock-steady GPU image the full values read as violence, not texture.
// Authentic mode restores the pygame numbers exactly.
const AUTH_KERB_RUMBLE = 0.014
const AUTH_GRASS_RUMBLE = 0.025
const AUTH_CHATTER = 0.02
const ENV_SMOOTH = 0.16
const PITCH_COUP = 0.5
const LEAN_GAIN = 0.0016

/** Where the car is relative to the painted edge, for the road feel. */
export interface Surface {
  /** Signed offset from the centreline (m). */
  lateral: number
  /** Half-width of the road here (m). */
  half: number
  /** Past this much beyond the edge counts as grass rather than kerb. */
  margin: number
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera
  mode: CameraMode = 'halo'
  lookBack = false
  /** Extra horizontal FOV, in degrees, at top speed. pygame has none. */
  fovKick = 8
  /** Kerb/grass shake as a multiple of the pygame amplitudes. */
  shake = 0.55

  private aspect: number
  /** Smoothed pitch from weight transfer (radians, positive = nose down). */
  private pitch = 0
  /** Bump phase, integrated over distance travelled so it never jumps. */
  private bumpPhase = 0
  private bumpAmp = 0
  private chatterAmp = 0
  private chasePos = new THREE.Vector3()
  private chaseWant = new THREE.Vector3()
  private chaseReady = false

  /** Last computed surface flags, for the suspension animation to reuse. */
  onKerb = false
  onGrass = false
  /** Current bob, exposed so the wheel animation can share the same wave. */
  bob = 0

  constructor(aspect: number) {
    this.aspect = aspect
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.15, 4000)
    this.applyHFov(HFOV.halo)
  }

  resize(aspect: number): void {
    this.aspect = aspect
    this.camera.aspect = aspect
    this.applyHFov(HFOV[this.mode])
  }

  /** Set the vertical FOV that yields ``hFovDeg`` horizontally at this aspect. */
  private applyHFov(hFovDeg: number): void {
    const h = (hFovDeg * Math.PI) / 180
    const v = 2 * Math.atan(Math.tan(h / 2) / Math.max(this.aspect, 1e-6))
    this.camera.fov = (v * 180) / Math.PI
    this.camera.updateProjectionMatrix()
  }

  cycle(): CameraMode {
    const i = CAMERA_ORDER.indexOf(this.mode)
    this.mode = CAMERA_ORDER[(i + 1) % CAMERA_ORDER.length]!
    this.chaseReady = false
    return this.mode
  }

  /**
   * Attract-mode camera: a slow chase down the racing line, for the menu.
   *
   * Both the eye and the look-at come from ``poseAt`` *positions*, never from
   * a pose's yaw. Position interpolates smoothly along the centreline; yaw is
   * the segment tangent, a step function that jumps at every vertex — and
   * extrapolating the eye 34 m backwards along a stepped angle turned each of
   * those steps into a two-metre sideways camera jump. Following the road's own
   * points is smooth by construction, and hugs the corners besides.
   */
  flyover(
    track: { length: number; poseAt(s: number): { x: number; y: number; yaw: number } },
    t: number,
  ): void {
    this.applyHFov(64)
    const s = (t * FLYOVER_SPEED) % track.length
    const eye = track.poseAt(s - 34)
    const aim = track.poseAt(s + 46)
    const height = 17 + Math.sin(t * FLYOVER_BOB) * 6
    this.camera.position.set(eye.x, height, -eye.y)
    this.camera.up.set(0, 1, 0)
    this.camera.lookAt(aim.x, 1.5, -aim.y)
  }

  /**
   * @param throttle signed pedal, positive drive and negative brake
   * @param dtWall real seconds since the last frame, so smoothing is
   *        frame-rate independent rather than "per frame" as in the Python
   */
  update(
    s: CarState,
    p: CarParams,
    throttle: number,
    dtWall: number,
    surface: Surface | null,
  ): void {
    // Speed widens the view a little in the onboard cameras — the classic
    // racing-game cue. Quadratic, so it is imperceptible at town speeds and
    // pulls the world past you hard on the straights.
    const speedNow = Math.hypot(s.vx, s.vy)
    const onboard = this.mode === 'halo' || this.mode === 'hood'
    const kick = onboard ? this.fovKick * Math.min(speedNow / 75, 1) ** 2 : 0
    this.applyHFov(HFOV[this.mode] + kick)

    // --- weight transfer -> nose pitch ---
    const target = throttle < 0 ? -throttle * p.divePitch : -throttle * p.squatPitch
    const kPitch = 1 - Math.pow(1 - p.pitchSmooth, dtWall * 60)
    this.pitch += (target - this.pitch) * kPitch

    // --- road feel ---
    const speed = Math.hypot(s.vx, s.vy)
    this.bumpPhase += BUMP_FREQ * speed * dtWall

    this.onKerb = false
    this.onGrass = false
    if (surface) {
      const over = Math.abs(surface.lateral) - surface.half
      this.onGrass = over > surface.margin
      this.onKerb = !this.onGrass && over > -0.35
    }
    const kerbAmp = AUTH_KERB_RUMBLE * this.shake
    const grassAmp = AUTH_GRASS_RUMBLE * this.shake
    const chatterAmp = AUTH_CHATTER * this.shake
    const wantBump =
      RUMBLE_BASE * Math.min(speed / RUMBLE_SPEED_REF, 1) +
      (this.onGrass ? grassAmp : this.onKerb ? kerbAmp : 0)
    const wantChatter = this.onGrass || this.onKerb ? chatterAmp : 0
    const kEnv = 1 - Math.pow(1 - ENV_SMOOTH, dtWall * 60)
    this.bumpAmp += (wantBump - this.bumpAmp) * kEnv
    this.chatterAmp += (wantChatter - this.chatterAmp) * kEnv

    const bob = this.bumpAmp * Math.sin(this.bumpPhase)
    const chatter = this.chatterAmp * Math.sin(this.bumpPhase * 2.7 + 1.3)
    const lean = LEAN_GAIN * (s.r * s.vx)
    this.bob = bob

    const cos = Math.cos(s.yaw)
    const sin = Math.sin(s.yaw)
    const fx = cos
    const fz = -sin
    const rx = sin
    const rz = cos
    const px = s.x
    const pz = -s.y

    switch (this.mode) {
      case 'halo':
      case 'hood': {
        const halo = this.mode === 'halo'
        const fwd = halo ? -HALO_BACK : CAM_FWD
        const height = halo ? HALO_HEIGHT : CAM_HEIGHT
        const basePitch = halo ? HALO_PITCH : CAM_PITCH

        const dir = this.lookBack ? -1 : 1
        const side = chatter + lean
        this.camera.position.set(
          px + fx * fwd + rx * side,
          height + bob,
          pz + fz * fwd + rz * side,
        )
        this.camera.up.set(0, 1, 0)
        const pitch = basePitch + this.pitch + PITCH_COUP * (bob / height)
        this.camera.lookAt(
          this.camera.position.x + fx * dir * 10,
          this.camera.position.y - Math.tan(pitch) * 10,
          this.camera.position.z + fz * dir * 10,
        )
        break
      }
      case 'chase': {
        const want = this.chaseWant.set(px - fx * 9.5, 3.6 + bob * 0.5, pz - fz * 9.5)
        if (!this.chaseReady) {
          this.chasePos.copy(want)
          this.chaseReady = true
        } else {
          this.chasePos.lerp(want, 1 - Math.exp(-dtWall * 9))
        }
        this.camera.position.copy(this.chasePos)
        this.camera.up.set(0, 1, 0)
        this.camera.lookAt(px + fx * 6, 0.9 - Math.tan(this.pitch) * 6, pz + fz * 6)
        break
      }
      case 'topDown': {
        this.camera.position.set(px, 95, pz)
        this.camera.up.set(fx, 0, fz)
        this.camera.lookAt(px, 0, pz)
        break
      }
    }
  }
}
