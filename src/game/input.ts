/**
 * Driver input — keyboard and mouse, with the feel ported from ``play.py``.
 *
 * Two things here are not obvious and both matter:
 *
 * **The pedals are analog.** Holding throttle ramps it up over ~29 ticks and
 * releasing drops it over ~13; the brake is slower on and faster off again. So a
 * quick dab at speed is a light squeeze rather than an instant lock-up, which is
 * the difference between a car you can trail-brake and a switch.
 *
 * **Steering is rate-limited here too**, on top of the rate limit the car
 * already applies to the wheel. The extra layer is what stops a keyboard reading
 * as a pair of on/off switches, and the 0.8 decay on release centres the wheel
 * rather than snapping it.
 *
 * The rates are the Python ones to the digit, so a lap driven here is driven
 * with the same controls as a lap driven there.
 */
import { clamp } from '../core/math'

/** Per-tick pedal rates, from play.py. */
const THROTTLE_ON = 0.035
const THROTTLE_OFF = -0.08
const BRAKE_ON = 0.03
const BRAKE_OFF = -0.1
/** Per-tick steering slew and the centring decay when nothing is held. */
const STEER_SLEW = 0.15
const STEER_RETURN = 0.8

/**
 * Straight-ahead deadzone for mouse steering, as a fraction of the half-width.
 *
 * play.py uses 18 px either side of centre on an 1100 px window, i.e. 18/550.
 * Expressed as a fraction so it means the same thing on any viewport, where a
 * fixed pixel count would be a much wider deadzone on a small screen.
 */
const MOUSE_DEADZONE = 18 / 550

export interface Controls {
  steer: number
  throttle: number
  /** Raw pedal intent (-1, 0, +1), which is what a demo recording wants. */
  pedalIntent: number
}

export type InputMode = 'keyboard' | 'mouse'

export class InputState {
  /**
   * Mouse by default, as in the Python game's usual setup. Keyboard steering is
   * a slewed approximation of an analog axis and reads quite differently — the
   * wheel ramps in at a fixed rate rather than going where you put it.
   */
  mode: InputMode = 'mouse'
  lookBack = false
  /**
   * Fraction of the half-width at which the wheel hits full lock. 1.0 means
   * you drag to the very edge of the picture; 0.15 is a short flick.
   */
  fullLockFraction = 1.0

  private held = new Set<string>()
  /** Cursor position in window coordinates. */
  private mouseX = 0
  /** Latched gear request, consumed by the next physics tick. */
  private pendingShift = 0
  /** Scroll not yet worth a detent of the TC knob — see WHEEL_PER_STEP. */
  private wheelAccum = 0
  /** The picture, so cursor position can be made relative to it. */
  private target: HTMLElement | null = null
  /** Cached bounds of that element — see refreshBounds. */
  private left = 0
  private width = 1

  private steer = 0
  private throttleCmd = 0
  private brakeCmd = 0

  /** Callbacks for one-shot keys, so the game layer decides what they mean. */
  onAction: (action: string) => void = () => {}

  private readonly listeners: (() => void)[] = []

  /**
   * Re-read the picture's position and size.
   *
   * Cached rather than measured every tick, because getBoundingClientRect
   * forces layout and this runs at 60 Hz. Call after anything that moves or
   * resizes the stage.
   */
  refreshBounds(): void {
    if (!this.target) return
    const rect = this.target.getBoundingClientRect()
    this.left = rect.left
    this.width = Math.max(rect.width, 1)
  }

  attach(target: HTMLElement): void {
    this.target = target
    this.refreshBounds()
    const keydown = (e: KeyboardEvent): void => {
      if (e.repeat) {
        e.preventDefault()
        return
      }
      const code = e.code
      this.held.add(code)
      const action = ONE_SHOT[code]
      const shift = SHIFT_KEYS[code]
      if (shift) {
        // Keyboard paddles, so a manual box is drivable without a mouse.
        this.pendingShift = shift
        e.preventDefault()
      } else if (action) {
        this.onAction(action)
        e.preventDefault()
      } else if (DRIVING_KEYS.has(code)) {
        e.preventDefault()
      }
    }
    const keyup = (e: KeyboardEvent): void => {
      this.held.delete(e.code)
    }
    // A window that loses focus mid-corner should not keep the throttle pinned.
    const blur = (): void => {
      this.held.clear()
      this.pendingShift = 0
    }
    const mousemove = (e: MouseEvent): void => {
      this.mouseX = e.clientX
    }
    // The mouse buttons are PADDLES now: left up, right down. They used to be
    // throttle and brake, which put both pedals and the wheel on one hand while
    // the other did nothing — and made a downshift impossible without letting
    // go of the steering. Pedals are W and S.
    const mousedown = (e: MouseEvent): void => {
      if (e.button === 0) this.pendingShift = 1
      else if (e.button === 2) this.pendingShift = -1
      else return
      e.preventDefault()
    }
    // The traction-control knob. On the picture rather than the window, exactly
    // as the paddles are: with the menu open the scroll belongs to the menu,
    // and a wheel that quietly changed TC from behind a settings screen would
    // be a lap driven on a setting nobody chose.
    const wheel = (e: WheelEvent): void => {
      const scale = WHEEL_SCALE[e.deltaMode] ?? 1
      this.wheelAccum += e.deltaY * scale
      while (Math.abs(this.wheelAccum) >= WHEEL_PER_STEP) {
        const dir = Math.sign(this.wheelAccum)
        this.wheelAccum -= dir * WHEEL_PER_STEP
        // Scroll away from you is up, which is the way every volume knob and
        // every other wheel-adjusted control on a computer already works.
        this.onAction(dir < 0 ? 'tcUp' : 'tcDown')
      }
      e.preventDefault()
    }
    const contextmenu = (e: Event): void => {
      // Right button is a downshift; a context menu on the brakes into a
      // hairpin is not useful.
      e.preventDefault()
    }

    window.addEventListener('keydown', keydown)
    window.addEventListener('keyup', keyup)
    window.addEventListener('blur', blur)
    // Movement is tracked on the window, not the canvas: with the picture
    // letterboxed the cursor spends plenty of time on the black bars, and it
    // should still be steering there — the whole screen is the wheel.
    window.addEventListener('mousemove', mousemove)
    target.addEventListener('mousedown', mousedown)
    // Not passive: the whole point is to stop the page scrolling under the game.
    target.addEventListener('wheel', wheel, { passive: false })
    target.addEventListener('contextmenu', contextmenu)

    this.listeners.push(() => {
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('keyup', keyup)
      window.removeEventListener('blur', blur)
      window.removeEventListener('mousemove', mousemove)
      target.removeEventListener('mousedown', mousedown)
      target.removeEventListener('wheel', wheel)
      target.removeEventListener('contextmenu', contextmenu)
    })
  }

  detach(): void {
    for (const off of this.listeners) off()
    this.listeners.length = 0
  }

  /** Drop all held state — use when the game is paused or a menu opens. */
  release(): void {
    this.held.clear()
    this.pendingShift = 0
    this.wheelAccum = 0
    this.steer = 0
    this.throttleCmd = 0
    this.brakeCmd = 0
  }

  /**
   * Take the pending gear request, clearing it. -1, 0 or +1.
   *
   * Latched rather than sampled: a click happens on a browser event, the
   * gearbox reads on a fixed physics tick, and at 144 Hz those are not the same
   * moment. Without the latch a shift that landed between ticks would simply be
   * dropped, which on a downshift into a hairpin is the worst possible place to
   * lose an input.
   */
  takeShift(): number {
    const s = this.pendingShift
    this.pendingShift = 0
    return s
  }

  /** Advance the analog controls by one tick and return what the car gets. */
  sample(): Controls {
    const up = this.held.has('ArrowUp') || this.held.has('KeyW')
    const down = this.held.has('ArrowDown') || this.held.has('KeyS')
    this.lookBack = this.held.has('ShiftLeft') || this.held.has('ShiftRight')

    const left = this.held.has('ArrowLeft') || this.held.has('KeyA')
    const right = this.held.has('ArrowRight') || this.held.has('KeyD')

    // Mouse is the released control scheme. A/D and the arrow keys remain a
    // quiet fallback: holding either temporarily takes the wheel, without
    // adding another mode for a new player to choose or configure.
    if (this.mode === 'mouse' && !left && !right) {
      // Relative to the picture, not the window. With the stage letterboxed
      // these differ, and using window coordinates puts the straight-ahead
      // point off to one side of the screen.
      const local = this.mouseX - this.left
      const half = this.width / 2
      const dead = half * MOUSE_DEADZONE
      // Positive steer is left, matching the sim's sign convention, so this is
      // centre-minus-cursor rather than the other way round.
      const dx = half - local
      const mag = Math.max(Math.abs(dx) - dead, 0)
      // Sensitivity shortens the travel between the deadzone and full lock.
      const span = Math.max((half - dead) * this.fullLockFraction, 1)
      this.steer = clamp(Math.sign(dx) * (mag / span), -1, 1)
    } else {
      const target = (left ? 1 : 0) + (right ? -1 : 0)
      this.steer += clamp(target - this.steer, -STEER_SLEW, STEER_SLEW)
      if (target === 0) this.steer *= STEER_RETURN
    }

    this.throttleCmd = clamp(this.throttleCmd + (up ? THROTTLE_ON : THROTTLE_OFF), 0, 1)
    this.brakeCmd = clamp(this.brakeCmd + (down ? BRAKE_ON : BRAKE_OFF), 0, 1)

    return {
      steer: this.steer,
      throttle: this.throttleCmd - this.brakeCmd,
      pedalIntent: (up ? 1 : 0) - (down ? 1 : 0),
    }
  }

  /** Current pedal positions, for drawing the pedal bars on the HUD. */
  get pedals(): { throttle: number; brake: number } {
    return { throttle: this.throttleCmd, brake: this.brakeCmd }
  }
}

/** Gear paddles on the keyboard, mirroring the mouse buttons. */
const SHIFT_KEYS: Record<string, number> = {
  KeyE: 1,
  KeyQ: -1,
}

/** Keys that trigger an action once per press rather than being held. */
const ONE_SHOT: Record<string, string> = {
  KeyR: 'restart',
  Escape: 'pause',
  KeyC: 'camera',
  KeyG: 'ghost',
  KeyV: 'viewport',
}

/** Keys the browser should not also scroll the page with. */
const DRIVING_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
])

/**
 * Scroll distance that counts as one detent of the traction-control knob.
 *
 * A mouse notch reports about 100 pixels, so one notch is one position. A
 * trackpad reports a stream of small deltas instead, and without accumulating
 * them a single flick would run TC from off to maximum — hence a threshold
 * rather than one step per event.
 */
const WHEEL_PER_STEP = 60

/** Wheel deltas come in pixels, lines or pages; normalise to roughly pixels. */
const WHEEL_SCALE = [1, 16, 100]
