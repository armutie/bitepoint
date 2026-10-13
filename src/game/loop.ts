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
  private simulationPaused = false

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
    const frame = (): void => {
      if (!this.running) return
      const now = performance.now() / 1000
      // Clamping is what stops a backgrounded tab from returning with 40 s of
      // debt and locking the page up trying to catch up.
      const dtWall = Math.min(now - this.lastTime, MAX_FRAME)
      this.lastTime = now
      if (!this.simulationPaused) this.advance(dtWall)

      this.render(this.accumulator / DT, dtWall)
      this.handle = requestAnimationFrame(frame)
    }
    this.handle = requestAnimationFrame(frame)
  }

  private advance(elapsed: number): void {
    this.accumulator += elapsed
    while (this.accumulator >= DT) {
      this.fixedUpdate()
      this.accumulator -= DT
    }
  }

  /** Active simulation time between the last completed tick and now. */
  get simulationRemainder(): number {
    return this.accumulator
  }

  /** Capture the input event's time, then hold physics and its fractional phase. */
  pauseSimulation(): void {
    if (this.simulationPaused) return
    if (this.running) {
      const now = performance.now() / 1000
      const elapsed = Math.min(Math.max(0, now - this.lastTime), MAX_FRAME)
      this.lastTime = now
      // Complete any due tick before controls are released. Only the remaining
      // fraction belongs to the display clock; it is not another physics step.
      this.advance(elapsed)
    }
    this.simulationPaused = true
  }

  /** Paused wall time never enters the simulation clock or its accumulator. */
  resumeSimulation(resetFraction = false): void {
    this.simulationPaused = false
    this.lastTime = performance.now() / 1000
    if (resetFraction) this.accumulator = 0
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
