/**
 * Fixed-timestep game loop.
 *
 * The physics must advance in equal DT slices regardless of what the display is
 * doing — that is what makes a lap reproducible, a ghost exact, and a recorded
 * input trace re-drivable on a server. Rendering then happens as often as the
 * browser likes, interpolating between the last two physics states so a 144 Hz
 * screen does not show 60 Hz judder.
 */
import { DT } from '../core/sim'

/** Never simulate more than this much wall time in one frame. */
const MAX_FRAME = 0.25

export class GameLoop {
  private accumulator = 0
  private lastTime = 0
  private handle = 0
  private running = false

  /**
   * @param fixedUpdate advance the simulation by exactly DT
   * @param render draw, given how far we are between the last two fixed states
   */
  constructor(
    private readonly fixedUpdate: () => void,
    private readonly render: (alpha: number, dtWall: number) => void,
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now() / 1000
    this.accumulator = 0
    const frame = (): void => {
      if (!this.running) return
      const now = performance.now() / 1000
      // Clamping is what stops a backgrounded tab from returning with 40 s of
      // debt and locking the page up trying to catch up.
      const dtWall = Math.min(now - this.lastTime, MAX_FRAME)
      this.lastTime = now
      this.accumulator += dtWall

      while (this.accumulator >= DT) {
        this.fixedUpdate()
        this.accumulator -= DT
      }

      this.render(this.accumulator / DT, dtWall)
      this.handle = requestAnimationFrame(frame)
    }
    this.handle = requestAnimationFrame(frame)
  }

  stop(): void {
    this.running = false
    if (this.handle) cancelAnimationFrame(this.handle)
    this.handle = 0
  }

  get isRunning(): boolean {
    return this.running
  }
}
