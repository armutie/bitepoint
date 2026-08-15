/**
 * The racing line the attract field drives: your own best lap, baked.
 *
 * The menu field used to be kinematic centreline-followers — they read the
 * road's curvature for a target speed and tracked the middle of the road. It
 * never looked driven, because it wasn't: no late apex, no line straightened
 * through a chicane, no trail braking, and always dead centre through a corner
 * no real driver takes from the middle.
 *
 * Rather than write a better AI, replay the real thing. `LapReplay` already
 * reproduces a recorded lap exactly — it is what the ghost is — so the lap is
 * run once here, off-screen, and every pose it passes through is kept. The
 * field then reads that ring of poses at different offsets. Ten cars cost ten
 * array lookups a frame, and every one of them is driving the lap you drove,
 * braking where you braked.
 */
import type { CarParams } from '../core/carParams'
import type { Track } from '../core/track'
import { GHOST_FIELDS, LapReplay, OFF_TRACK_MARGIN, type LapRecording } from '../core/sim'

export interface LinePose {
  x: number
  y: number
  yaw: number
  /** Recorded front-wheel angle, so the wheels turn where the driver turned. */
  steer: number
}

export interface AttractLine {
  poses: LinePose[]
  /** Distance travelled by the pose at each index, for spacing the field. */
  dist: Float64Array
  /** Lap length along the driven line (m) — longer than the centreline. */
  total: number
  /** Seconds per pose, i.e. the sim step the lap was recorded at. */
  dt: number
}

/**
 * Run a recorded lap and keep every pose.
 *
 * Returns null for a recording too short to be a lap — a truncated or empty
 * trace should leave the field on its fallback rather than drive one pose —
 * and null for one that leaves the circuit, which is the important case.
 *
 * A recording is a trace of INPUTS, so it only reproduces the lap it was driven
 * on while the physics it was driven under still holds. Change the gearbox, the
 * downshift point or traction control and the same steering and throttle now
 * describe a different lap: the car understeers wide at a corner it used to
 * make, and the menu fills with background cars ploughing into the scenery. It
 * looks like a rendering bug and is really a lap being honestly replayed under
 * a car that no longer exists.
 *
 * Nothing here can repair that, but it can refuse to show it. A driven lap that
 * has left the road is not a racing line, so it is not offered as one.
 */
export function bakeAttractLine(
  track: Track, params: CarParams, recording: LapRecording,
): AttractLine | null {
  const replay = new LapReplay(track, params, recording)
  const poses: LinePose[] = []
  const dists: number[] = []

  let travelled = 0
  let px = replay.car.s.x
  let py = replay.car.s.y

  while (!replay.finished) {
    replay.step()
    const s = replay.car.s
    const surface = track.project(s.x, s.y)
    if (Math.abs(surface.lateral) > surface.half + OFF_TRACK_MARGIN) return null
    travelled += Math.hypot(s.x - px, s.y - py)
    px = s.x
    py = s.y
    poses.push({ x: s.x, y: s.y, yaw: s.yaw, steer: s.steer })
    dists.push(travelled)
  }

  if (poses.length < 60) return null
  return {
    poses,
    dist: Float64Array.from(dists),
    total: travelled,
    dt: replay.duration / poses.length,
  }
}

/**
 * An attract line from a recorded path, with no physics involved at all.
 *
 * This is the locked form. `bakeAttractLine` re-drives a lap's inputs, so the
 * line it produces is only the lap that was driven while the car is still the
 * one that drove it — change the gearbox and the pinned field starts crashing,
 * or vanishes when the off-circuit check drops it. A path is where the car
 * actually was, so nothing about the car can move it.
 *
 * Returns null for a path too short to be a lap, matching `bakeAttractLine`.
 */
export function attractLineFromPath(path: Float64Array, dt: number): AttractLine | null {
  const count = Math.floor(path.length / GHOST_FIELDS)
  if (count < 60) return null

  const poses: LinePose[] = []
  const dists: number[] = []
  let travelled = 0
  let px = path[0]!
  let py = path[1]!

  for (let i = 0; i < count; i++) {
    const b = i * GHOST_FIELDS
    const x = path[b]!
    const y = path[b + 1]!
    travelled += Math.hypot(x - px, y - py)
    px = x
    py = y
    poses.push({ x, y, yaw: path[b + 2]!, steer: path[b + 3]! })
    dists.push(travelled)
  }

  return { poses, dist: Float64Array.from(dists), total: travelled, dt }
}

/**
 * The pose index at which the line has covered `metres`.
 *
 * Used to space the field by distance rather than by time. Spacing by time
 * would release the cars at even intervals and then let them bunch up in the
 * slow corners, where they all spend longer; spacing by distance puts them
 * evenly around the lap, which is what "scattered along the track" looks like.
 */
export function indexAtDistance(line: AttractLine, metres: number): number {
  const target = ((metres % line.total) + line.total) % line.total
  let lo = 0
  let hi = line.dist.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (line.dist[mid]! < target) lo = mid + 1
    else hi = mid
  }
  return lo
}
