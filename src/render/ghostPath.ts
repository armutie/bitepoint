/**
 * A ghost drawn from recorded positions rather than replayed inputs.
 *
 * `LapReplay` re-drives a lap's inputs through the physics, which is exactly
 * right for checking a time and exactly wrong for drawing one. A trace of
 * inputs only reproduces its lap while the car it was driven on still exists:
 * change the gearbox, the downshift point or traction control, and the same
 * steering and throttle now describe a different lap. Measured on a real 53.7 s
 * lap, forcing any traction-control position other than the one it was driven
 * on sent it off the circuit inside one lap — not because the physics moved far,
 * but because a driver is a closed loop and three thousand ticks of open-loop
 * replay amplify any divergence into a crash.
 *
 * So the ghost you watch is a recording of where the car actually was. It is the
 * lap that was driven, permanently, and no change to the car can make it wrong.
 * The input trace stays for `verifyLapRecording`, which is what makes a time
 * checkable — positions can be typed by hand and can never be the anti-cheat.
 *
 * This is what essentially every racing game does. Trackmania is the exception
 * that proves it: it re-simulates inputs, which is why its replays are tiny and
 * verifiable, and why a physics change across versions invalidates them.
 */
import { initialState, type CarState } from '../core/car'
import { DT, GHOST_FIELDS } from '../core/sim'
import { wrapAngle } from '../core/math'

export class GhostPath {
  /**
   * Shaped like `LapReplay` on purpose — `.car.s`, `.finished`, `.step()` — so
   * the two are interchangeable at the call site and a lap recorded before
   * paths existed can still fall back to replaying its inputs.
   */
  readonly car: { s: CarState }

  private index = 0

  constructor(private readonly path: Float64Array, private readonly startTime = 0) {
    this.car = { s: initialState() }
    this.apply()
  }

  get finished(): boolean {
    return (this.index + 1) * GHOST_FIELDS > this.path.length
  }

  /** Ticks the recorded lap held, i.e. its length in sim steps. */
  get ticks(): number {
    return Math.floor(this.path.length / GHOST_FIELDS)
  }

  /** Advance one tick. Holds the final pose once the path runs out. */
  step(): void {
    if (this.finished) return
    this.index++
    this.apply()
  }

  /** Match the player's elapsed clock even when its start fraction differs. */
  seekTime(time: number): void {
    const sample = Math.max(0, Math.min(this.ticks - 1, (time - this.startTime) / DT))
    this.index = Math.floor(sample)
    this.apply()
    if (this.index + 1 >= this.ticks) return
    const alpha = sample - this.index
    const next = (this.index + 1) * GHOST_FIELDS
    const s = this.car.s
    s.x += (this.path[next]! - s.x) * alpha
    s.y += (this.path[next + 1]! - s.y) * alpha
    s.yaw += wrapAngle(this.path[next + 2]! - s.yaw) * alpha
    s.steer += (this.path[next + 3]! - s.steer) * alpha
    s.vx += (this.path[next + 4]! - s.vx) * alpha
    s.wheelVr += (this.path[next + 5]! - s.wheelVr) * alpha
  }

  reset(): void {
    this.index = 0
    this.apply()
  }

  private apply(): void {
    const base = this.index * GHOST_FIELDS
    if (base + GHOST_FIELDS > this.path.length) return
    const s = this.car.s
    s.x = this.path[base]!
    s.y = this.path[base + 1]!
    s.yaw = this.path[base + 2]!
    s.steer = this.path[base + 3]!
    s.vx = this.path[base + 4]!
    s.wheelVr = this.path[base + 5]!
  }
}
