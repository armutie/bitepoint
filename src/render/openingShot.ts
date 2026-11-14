import * as THREE from 'three'

import { pointAt } from '../core/placement'
import type { Track } from '../core/track'

/**
 * The opening shot, recorded into the opening video (`recordOpening` in
 * main.ts, played by index.html): the view from the Silverstone pit wall.
 *
 * A red car comes up the Hamilton Straight flat out and passes a few metres
 * away; the camera whips round after it, lagging and shaking like an operator
 * who cannot keep up, and watches it go. Then the operator turns slowly back up
 * the straight, and a blue car and a yellow one arrive together, the yellow
 * tucked in on the blue's right with its front wing at the blue's rear wheels.
 * They scream past, and down the straight the blue moves left as the yellow
 * pulls alongside.
 *
 * Everything is a function of the shot's own clock: `step` advances it and the
 * camera's spring, `apply` points the camera. Kept apart so the recorder can
 * draw several instants inside one video frame (its motion blur).
 */
export const OPENING_TRACK = 'silverstone-gp'

/** Where the camera stands, metres past the start line. */
const CAMERA_S = 60
/** How far outside the white line, on the pit side (negative lateral). */
const CAMERA_OUT = 1.1
const CAMERA_HEIGHT = 1.45
/** Speed at the camera and acceleration down the straight (m/s, m/s^2). */
const V_PASS = 81
const ACCEL = 3

export interface OpeningCar {
  /** Seconds into the shot when the car's group is level with the camera. */
  passT: number
  /** Metres ahead of the group at that moment (negative: behind). */
  lead: number
  /** m/s faster than the group: closing on the car ahead. */
  faster: number
  /** Lateral offset (m) on the run past the camera; negative is the pit-wall side. */
  near: number
  /** Lateral offset (m) by the end of the straight: the move. */
  late: number
  livery: { body: number; accent: number }
}

const RED = { passT: 1.6, lead: 0, faster: 0, near: -2.9, late: -2.9, livery: { body: 0xb91e27, accent: 0xdedfd9 } }
const BATTLE_T = 7.2
const BLUE = { passT: BATTLE_T, lead: 0, faster: 0, near: -0.5, late: 1.3, livery: { body: 0x1f4fd1, accent: 0xe8e4da } }
/** On the blue's right, front wing level with its rear wheels, and closing. */
const YELLOW = { passT: BATTLE_T, lead: -3.9, faster: 2.6, near: -3.0, late: -1.1, livery: { body: 0xe7b416, accent: 0x1b1d22 } }
export const OPENING_CARS: readonly OpeningCar[] = [RED, BLUE, YELLOW]

/** The operator stops following the red car and turns, slowly, back up the straight. */
const LOOK_BACK_T = 3.6
/** The shot ends on the battle going away down the straight. */
export const OPENING_END = 9.6
/** The earliest the video may give way: the first pass must have happened. */
export const OPENING_MIN_T = 2.1

/** Horizontal field of view: a long lens, so a car arrives out of nothing. */
const HFOV = 46
/** All the way in, following the battle down the straight. */
const ZOOM_HFOV = 7

export interface HeroPose { x: number; y: number; yaw: number; v: number; steer: number; visible: boolean }

export class OpeningShot {
  t = 0

  readonly eye: THREE.Vector3
  /** The view up the straight the shot opens on, and turns back to. */
  private readonly home = new THREE.Vector3()
  private yaw: number
  private pitch: number
  private yawRate = 0
  private pitchRate = 0
  private readonly look = new THREE.Vector3()
  private readonly target = new THREE.Vector3()
  private readonly other = new THREE.Vector3()

  constructor(private readonly track: Track) {
    const p = pointAt(track, CAMERA_S, -(track.halfAt(CAMERA_S) + CAMERA_OUT))
    this.eye = new THREE.Vector3(p.x, CAMERA_HEIGHT, -p.y)
    const first = this.hero(RED, 0)
    this.home.set(first.x, 0.75, -first.y)
    const aim = this.aim(0)
    this.yaw = aim.yaw
    this.pitch = aim.pitch
  }

  /** Where the camera is pointing (radians, in the x/z plane): the soundtrack pans by it. */
  get heading(): number {
    return this.yaw
  }

  get done(): boolean {
    return this.t >= OPENING_END
  }

  /** Each car, by the shot's clock. Hidden well outside its own moment. */
  heroes(t = this.t): HeroPose[] {
    return OPENING_CARS.map((car) => this.hero(car, t))
  }

  private hero(car: OpeningCar, t: number): HeroPose {
    const dt = t - car.passT
    const s = CAMERA_S + car.lead + (V_PASS + car.faster) * dt + 0.5 * ACCEL * dt * dt
    const lateralAt = (at: number): number => {
      const into = smoothstep(CAMERA_S - 320, CAMERA_S - 60, at)
      const move = smoothstep(CAMERA_S + 90, CAMERA_S + 300, at)
      return 1.6 + (car.near - 1.6) * into + (car.late - car.near) * move
    }
    const point = pointAt(this.track, s, lateralAt(s))
    const ahead = pointAt(this.track, s + 4, lateralAt(s + 4))
    const yaw = Math.atan2(ahead.y - point.y, ahead.x - point.x)
    const pose = this.track.poseAt(s)
    return {
      x: point.x, y: point.y, yaw, v: V_PASS + car.faster + ACCEL * dt,
      steer: wrap(yaw - pose.yaw) * 2,
      // Nobody is a speck behind somebody else's moment.
      visible: dt > -4.5 && dt < 4,
    }
  }

  /**
   * Advance the clock and the operator's aim, a damped spring towards what is
   * being watched. Following a car it is stiff and lively: as the car passes,
   * the angle to it swings through ninety degrees in a fraction of a second and
   * the spring lags, overshoots and catches up. Turning back up the straight it
   * is soft and fully damped: a deliberate pan, no whip.
   */
  step(dt: number): void {
    const h = Math.min(dt, 1 / 30)
    if (h <= 0) return
    this.t += h
    const t = this.t
    const want = this.aim(t)
    const calm = t > LOOK_BACK_T ? 1 - smoothstep(BATTLE_T - 1.7, BATTLE_T - 0.6, t) : 0
    const omega = 8.5 + (1.9 - 8.5) * calm
    const zeta = 0.55 + (1.0 - 0.55) * calm
    this.yawRate += (omega * omega * wrap(want.yaw - this.yaw) - 2 * zeta * omega * this.yawRate) * h
    this.pitchRate += (omega * omega * (want.pitch - this.pitch) - 2 * zeta * omega * this.pitchRate) * h
    this.yaw += this.yawRate * h
    this.pitch += this.pitchRate * h
  }

  /** Point the camera from the current state, shake included. */
  apply(camera: THREE.PerspectiveCamera, setHFov: (deg: number) => void): void {
    const t = this.t
    // The jolt of each car going by, and the strain of a fast pan.
    let jolt = 0, punch = 0
    for (const car of OPENING_CARS) {
      const at = car.passT - car.lead / V_PASS
      const since = t - at
      if (since > -0.06) jolt = Math.max(jolt, Math.exp(-Math.max(0, since) * 3.2))
      // The lens widens as a car arrives: the punch of it filling the frame.
      punch = Math.max(punch, smoothstep(at - 0.45, at + 0.12, t) * (1 - smoothstep(at + 0.25, at + 1.3, t)))
    }
    const shake = 0.0015 + 0.010 * Math.min(Math.abs(this.yawRate) / 2.5, 1) + 0.024 * jolt
    const nYaw = Math.sin(t * 37.1) * 0.6 + Math.sin(t * 23.3 + 1.7) * 0.4
    const nPitch = Math.sin(t * 41.7 + 0.4) * 0.6 + Math.sin(t * 19.9 + 2.1) * 0.4
    const nRoll = Math.sin(t * 29.3 + 0.9)
    const yaw = this.yaw + nYaw * shake
    const pitch = this.pitch + nPitch * shake * 0.8

    // Once a car is past, the operator zooms in to follow it down the
    // straight, and lets the zoom go to turn back. The battle gets the tightest
    // lens, so the move at the end of the straight can be seen.
    const redAt = RED.passT, battleAt = BATTLE_T
    const zoom = Math.max(
      0.5 * smoothstep(redAt + 0.5, redAt + 1.7, t) * (1 - smoothstep(LOOK_BACK_T, LOOK_BACK_T + 1.2, t)),
      smoothstep(battleAt + 0.5, battleAt + 2.0, t),
    )
    setHFov(HFOV + 10 * punch - (HFOV - ZOOM_HFOV) * zoom)
    camera.position.copy(this.eye)
    camera.position.y += nPitch * shake * 0.25
    this.look.set(
      this.eye.x + Math.cos(yaw) * Math.cos(pitch),
      this.eye.y + Math.sin(pitch),
      this.eye.z + Math.sin(yaw) * Math.cos(pitch),
    )
    camera.up.set(0, 1, 0)
    camera.lookAt(this.look)
    camera.rotateZ(nRoll * shake * 0.9)
  }

  /**
   * What the operator is aiming at: the red car, then the view up the straight,
   * eased onto the battle as it arrives (the pair's middle, nearer the blue).
   */
  private aim(t: number): { yaw: number; pitch: number } {
    if (t < LOOK_BACK_T) {
      const red = this.hero(RED, t)
      this.target.set(red.x, 0.75, -red.y)
    } else {
      const blue = this.hero(BLUE, t), yellow = this.hero(YELLOW, t)
      this.other.set(blue.x * 0.6 + yellow.x * 0.4, 0.75, -(blue.y * 0.6 + yellow.y * 0.4))
      this.target.copy(this.home).lerp(this.other, smoothstep(BATTLE_T - 2.6, BATTLE_T - 1.2, t))
    }
    const dx = this.target.x - this.eye.x, dz = this.target.z - this.eye.z
    return { yaw: Math.atan2(dz, dx), pitch: Math.atan2(this.target.y - this.eye.y, Math.hypot(dx, dz)) }
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return k * k * (3 - 2 * k)
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a))
}
