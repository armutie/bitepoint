/**
 * Vehicle dynamics — a faithful port of ``racing/car.py``.
 *
 * A dynamic bicycle model with sim-style grip: Pacejka tyres, a friction circle
 * shared between cornering and drive/brake, aero downforce, longitudinal weight
 * transfer, a geared engine on a torque curve, and a spinning driven rear wheel
 * so flooring it out of a slow corner lights up the rears.
 *
 * This file is deliberately a translation and not an improvement. Every constant,
 * every branch and every order of operations matches the Python, because the
 * browser game, the recorded ghosts and the RL environment all have to be the
 * same task for any of them to mean anything. The reasoning behind each model
 * choice lives in the Python docstrings; the notes here cover only what the
 * translation itself needs.
 */
import { clamp, copysign, interp, wrapAngle } from './math'
import type { CarParams } from './carParams'
import { defaultParams, TC_LEVELS, wheelbase } from './carParams'

export const G = 9.81

// Pacejka lateral coefficients (stiffness / shape / curvature). This release
// tune peaks near 9.1 degrees and retains about 92% of peak force at 30 degrees.
// They remain mutable only because the public `/legacy` entry point deliberately
// restores the tyre curve from the previous release.
let PAC_B = 10.5
let PAC_C = 1.35
/**
 * Curvature factor: where the tyre PEAKS, and how hard it falls off after.
 *
 * The former 9.5 / 1.5 / 0.97 curve did not peak until roughly 61 degrees,
 * creating a broad plateau with little feedback when the tyre was over-driven.
 * These coefficients bring that peak into the useful steering range while
 * keeping the falloff progressive enough for the car to remain recoverable.
 *
 */
let PAC_E = -1.0

/**
 * Restore the tyre curve shipped before August 2026 for the public `/legacy`
 * entry point. This intentionally accepts no coefficients: release builds have
 * exactly two tyre rulesets, never an arbitrary URL-controlled model.
 */
export function useLegacyTyreModel(): void {
  PAC_B = 9.5
  PAC_C = 1.5
  PAC_E = 0.97
}


// Engine torque curve (Nm vs rpm): builds off idle, fat plateau ~4-5k, tapers to
// the limiter. Peak power ~462 kW near 7000 rpm.
const TQ_RPM: readonly number[] = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 8200]
const TQ_NM: readonly number[] = [360, 520, 650, 710, 715, 690, 630, 540, 500]
const RPM_PER_RADS = 60.0 / (2.0 * Math.PI)

function engineTorque(rpm: number): number {
  return interp(rpm, TQ_RPM, TQ_NM)
}

/** How far past the redline the fuel is fully cut, as a fraction of it. */
const LIMITER_BAND = 0.03

/**
 * Fraction of drive force surviving the limiter at this engine speed.
 *
 * A short taper rather than a hard cut. A real limiter is an abrupt fuel cut
 * and the engine audibly bounces off it, but an abrupt cut here chatters
 * against the integrator at exactly the limit; a 3% band settles the car onto
 * the redline instead and costs nothing anyone can feel.
 */
function revLimiter(rpm: number, redline: number): number {
  if (rpm <= redline) return 1.0
  return Math.max(0.0, 1.0 - (rpm - redline) / (redline * LIMITER_BAND))
}

export interface CarState {
  x: number
  y: number
  yaw: number
  /** body-frame forward velocity (m/s) */
  vx: number
  /** body-frame lateral velocity (m/s) */
  vy: number
  /** yaw rate (rad/s) */
  r: number
  /** current front-wheel angle (rad) */
  steer: number
  /** driven rear-wheel surface speed (m/s); greater than vx means wheelspin */
  wheelVr: number
  /** relaxed front slip angle (rad); lags the geometric angle */
  slipF: number
  /** relaxed rear slip angle (rad) */
  slipR: number
  /** current gear index (0 = 1st) */
  gear: number
  /** s remaining of torque cut during a gearchange */
  shiftTimer: number
  /** last engine rpm (road-speed derived; for the HUD) */
  engineRpm: number
}

export function initialState(): CarState {
  return {
    x: 0, y: 0, yaw: 0,
    vx: 0, vy: 0, r: 0,
    steer: 0, wheelVr: 0,
    slipF: 0, slipR: 0,
    gear: 0, shiftTimer: 0, engineRpm: 0,
  }
}

export const speedOf = (s: CarState): number => Math.hypot(s.vx, s.vy)

/** Lateral tyre force (N) opposing slip angle ``alpha``, peak magnitude ~grip. */
function pacejka(alpha: number, grip: number): number {
  const ba = PAC_B * alpha
  return -grip * Math.sin(PAC_C * Math.atan(ba - PAC_E * (ba - Math.atan(ba))))
}

/** Combined-slip force magnitude (N) for a normalised slip, peak ~grip. */
function pacejkaMag(slip: number, grip: number): number {
  const bs = PAC_B * slip
  return grip * Math.sin(PAC_C * Math.atan(bs - PAC_E * (bs - Math.atan(bs))))
}

/** Clamp ``value`` to the budget left on the friction circle after ``used``. */
function frictionClamp(value: number, fMax: number, used: number): number {
  const budget = fMax * fMax - used * used
  if (budget <= 0.0) return 0.0
  const allowed = Math.sqrt(budget)
  return clamp(value, -allowed, allowed)
}

export class Car {
  readonly p: CarParams
  s: CarState
  /**
   * Manual gearbox. Not on `CarParams`, deliberately.
   *
   * `CarParams` is asserted field-for-field against the Python dataclass, and
   * this is not a property of the car — the same machine has the same ratios
   * whoever is choosing them. It is a property of who is driving, which is why
   * it lives here and travels in the lap recording rather than in the setup.
   */
  manual = false

  /**
   * Wheel-rotary traction control, or null to leave the preset's TC alone.
   *
   * Here rather than on `CarParams` for the same reason as `manual`: it is a
   * position the driver chose, not a property of the machine, and it travels in
   * the lap recording. Null is what Python does, so the parity fixtures — which
   * never set it — keep asserting the preset behaviour unchanged.
   */
  tcLevel: number | null = null

  /**
   * Slip the TC clamp took away on the last tick, 0 when it never bit.
   *
   * A magnitude rather than a flag because a lamp driven by a per-tick boolean
   * strobes: TC bites and releases many times a second on a bumpy exit, and the
   * eye reads that as a fault rather than as intervention. The HUD smooths this.
   */
  tcCut = 0

  constructor(params?: CarParams) {
    this.p = params ?? defaultParams()
    this.s = initialState()
  }

  reset(x: number, y: number, yaw: number): void {
    this.s = initialState()
    this.s.x = x
    this.s.y = y
    this.s.yaw = yaw
  }

  setPose(x: number, y: number, yaw: number): void {
    this.s.x = x
    this.s.y = y
    this.s.yaw = yaw
  }

  /**
   * Advance the car.
   *
   * ``steerCmd`` and ``throttle`` are in [-1, 1]; positive throttle drives,
   * negative brakes and then reverses once stopped. ``gripMult`` / ``rollingMult``
   * scale tyre grip and rolling drag for the current surface (grass off-track).
   */
  step(
    steerCmd: number,
    throttle: number,
    dt: number,
    substeps = 10,
    gripMult = 1.0,
    rollingMult = 1.0,
    shiftRequest = 0,
  ): void {
    const p = this.p
    const s = this.s
    steerCmd = clamp(steerCmd, -1.0, 1.0)
    throttle = clamp(throttle, -1.0, 1.0)
    this.tcCut = 0

    const steerSpeed = p.steerUsesRoadSpeed ? Math.hypot(s.vx, s.vy) : Math.abs(s.vx)
    const speedFrac = Math.min(steerSpeed / p.steerSpeedRef, 1.0)
    const scale = 1.0 - (1.0 - p.highSpeedSteer) * speedFrac
    const targetSteer = steerCmd * p.maxSteer * scale
    const steerRate = p.steerRateLo + (p.steerRateHi - p.steerRateLo) * speedFrac

    if (this.manual) this.manualShift(dt, shiftRequest)
    else this.autoShift(dt)
    const h = dt / substeps
    for (let i = 0; i < substeps; i++) {
      this.integrate(targetSteer, throttle, h, steerRate, gripMult, rollingMult)
    }
  }

  private engineRpmAt(vx: number, gear: number): number {
    const total = this.p.gearRatios[gear]! * this.p.finalDrive
    return (Math.abs(vx) / this.p.wheelRadius) * total * RPM_PER_RADS
  }

  /**
   * Manual gearbox: the driver picks, and gets to be wrong.
   *
   * No rev limiter protection and no refusal to downshift — an over-rev is the
   * player's business, and a box that silently declines the gear you asked for
   * is worse than one that lets you money-shift. The only bar is the one the
   * hardware really has: you cannot select a gear that does not exist, and you
   * cannot shift while the clutch is already out for the last one.
   */
  private manualShift(dt: number, request: number): void {
    const s = this.s
    s.engineRpm = this.engineRpmAt(s.vx, s.gear)
    if (s.shiftTimer > 0.0) {
      s.shiftTimer = Math.max(0.0, s.shiftTimer - dt)
      return
    }
    const next = s.gear + Math.sign(request)
    if (request !== 0 && next >= 0 && next < this.p.gearRatios.length) {
      s.gear = next
      s.shiftTimer = this.p.shiftTime
    }
  }

  /** Pick a gear once per tick (road-speed rpm plus wide hysteresis). */
  private autoShift(dt: number): void {
    const p = this.p
    const s = this.s
    s.engineRpm = this.engineRpmAt(s.vx, s.gear)
    if (s.shiftTimer > 0.0) {
      s.shiftTimer = Math.max(0.0, s.shiftTimer - dt)
      return
    }
    if (s.engineRpm > p.shiftUpRpm && s.gear < p.gearRatios.length - 1) {
      s.gear += 1
      s.shiftTimer = p.shiftTime
    } else if (s.engineRpm < p.shiftDownRpm && s.gear > 0) {
      // Hold second rather than grabbing first at speed. Lugging briefly is a
      // far smaller cost than arriving at a corner exit in the one gear that
      // cannot put the power down.
      if (s.gear === 1 && Math.abs(s.vx) > p.firstGearSpeed) return
      s.gear -= 1
      s.shiftTimer = p.shiftTime
    }
  }

  private integrate(
    targetSteer: number,
    throttle: number,
    h: number,
    steerRate: number,
    gripMult: number,
    rollingMult: number,
  ): void {
    const p = this.p
    const s = this.s
    const wb = wheelbase(p)

    // Rate-limit the steering toward the target.
    const maxD = steerRate * h
    s.steer += clamp(targetSteer - s.steer, -maxD, maxD)
    const delta = s.steer

    // Longitudinal force command: geared drive, or braking/reverse.
    let fxDrive: number
    if (throttle >= 0.0) {
      const total = p.gearRatios[s.gear]! * p.finalDrive
      const rpmRoad = this.engineRpmAt(s.vx, s.gear)
      const rpm = Math.min(Math.max(rpmRoad, p.idleRpm), p.redlineRpm)
      let wheelForce = (engineTorque(rpm) * p.torqueScale * total) / p.wheelRadius
      // Rev limiter, and it is not decoration — without it the clamp above
      // means the engine keeps making its redline torque at ANY engine speed.
      // Held in 2nd this car reached 15,800 rpm and 190 km/h, still pulling,
      // because nothing ever told it to stop. The gears limited acceleration
      // but never top speed, so every ratio was effectively a top gear.
      wheelForce *= revLimiter(rpmRoad, p.redlineRpm)
      if (s.shiftTimer > 0.0) wheelForce = 0.0 // clutch/torque cut mid-change
      fxDrive = throttle * wheelForce
    } else if (s.vx > 0.5) {
      fxDrive = throttle * p.maxBrakeForce
      if (p.absOn) {
        // Rear stepping out under brakes: shed brake in proportion to how far the
        // rear slip angle has run past the threshold, down to a floor. Feeds the
        // reduced brake into the transfer estimate below, so the rear re-loads.
        const excess = Math.max(0.0, Math.abs(s.slipR) - p.absSlip)
        fxDrive *= Math.max(p.absFloor, 1.0 - p.absGain * excess)
      }
    } else {
      fxDrive = throttle * p.maxEngineForce * 0.5 // gentle reverse
    }

    // Resistive longitudinal forces (profile drag + rolling).
    const drag = p.dragCoef * s.vx * Math.abs(s.vx)
    const rr =
      Math.abs(s.vx) > 0.05 ? p.rollingResistance * rollingMult * copysign(1.0, s.vx) : 0.0

    // Static axle loads plus aero downforce (grows with speed^2).
    const downforce = p.downforceCoef * s.vx * s.vx
    let fzF = (p.mass * G * p.lr) / wb + downforce * (1.0 - p.aeroRearBias)
    let fzR = (p.mass * G * p.lf) / wb + downforce * p.aeroRearBias

    // Longitudinal weight transfer. By default the estimate uses the commanded
    // force; with trueLoadTransfer it first clamps that command to what the tyres
    // can actually deliver on the pre-transfer loads.
    let fxEst = fxDrive
    if (p.trueLoadTransfer) {
      const gripFEst = gripMult * p.mu * fzF
      const gripREst = gripMult * p.mu * p.rearGripBias * fzR
      if (fxDrive < 0.0) {
        const brake = -fxDrive
        fxEst = -(
          Math.min(p.brakeBias * brake, gripFEst) +
          Math.min((1.0 - p.brakeBias) * brake, gripREst)
        )
      } else {
        fxEst = Math.min(fxDrive, gripREst)
      }
    }
    const aLong = (fxEst - drag - rr) / p.mass
    const dFz = (p.mass * aLong * p.hCg) / wb
    fzF = Math.max(fzF - dFz, 100.0)
    fzR = Math.max(fzR + dFz, 100.0)

    // Peak friction with tyre load sensitivity (mu falls as load rises).
    let muF = p.mu
    let muR = p.mu
    if (p.muLoadSens !== 0.0) {
      const fz0F = (p.fzRefScale * p.mass * G * p.lr) / wb
      const fz0R = (p.fzRefScale * p.mass * G * p.lf) / wb
      muF = p.mu * Math.max(0.1, 1.0 - p.muLoadSens * (fzF / fz0F - 1.0))
      muR = p.mu * Math.max(0.1, 1.0 - p.muLoadSens * (fzR / fz0R - 1.0))
    }
    const gripF = muF * gripMult * fzF
    const gripR = muR * gripMult * p.rearGripBias * fzR

    // Slip angles. Guard forward speed and fade lateral grip out near standstill.
    const vxSafe = Math.max(Math.abs(s.vx), 1.0)
    const alphaFGeo = Math.atan2(s.vy + p.lf * s.r, vxSafe) - delta
    const alphaRGeo = Math.atan2(s.vy - p.lr * s.r, vxSafe)
    // Relaxation length: the slip angle the tyre actually feels lags the
    // geometric one by a first-order filter over distance travelled.
    const relax = Math.min((vxSafe * h) / p.relaxLen, 1.0)
    s.slipF += (alphaFGeo - s.slipF) * relax
    s.slipR += (alphaRGeo - s.slipR) * relax
    const alphaF = s.slipF
    const alphaR = s.slipR
    // Fade grip out only at a true standstill, keyed on planar speed rather than
    // forward speed: a car sliding fully sideways has vx ~ 0 but is moving fast
    // and must still feel the tyres scrubbing it.
    const gripFade = clamp((Math.hypot(s.vx, s.vy) - 0.5) / 1.5, 0.0, 1.0)

    let fyF = pacejka(alphaF, gripF) * gripFade
    let fxF: number
    let fxR: number
    let fyR: number

    if (fxDrive >= 0.0) {
      // Driven rear from combined slip: the wheel's slip ratio and slip angle
      // share one Pacejka budget, so spinning it bleeds lateral grip and steps
      // the rear out — and self-limits, since the spin also caps the thrust.
      fxF = 0.0
      const kappa = (s.wheelVr - s.vx) / Math.max(Math.abs(s.vx), p.slipVxFloor)
      const sy = Math.tan(alphaR)
      const sigma = Math.hypot(kappa, sy)
      if (sigma < 1e-6) {
        fxR = 0.0
        fyR = 0.0
      } else {
        const fmag = pacejkaMag(sigma, gripR)
        fxR = fmag * (kappa / sigma)
        fyR = -fmag * (sy / sigma) * gripFade
      }
      // Spin up the rear wheel: I*dw/dt = (engine - road) torque. Stiff at this
      // step size, so integrate the wheel semi-implicitly.
      const a = (h * p.wheelRadius * p.wheelRadius) / p.wheelInertia
      const k = (gripR * PAC_B * PAC_C) / Math.max(Math.abs(s.vx), p.slipVxFloor)
      s.wheelVr += (a * (fxDrive - fxR)) / (1.0 + a * k)
      // The rotary, when the driver is holding one, otherwise the preset's own
      // traction control. Position 0 is off and clamps nothing at all.
      let slipAllow: number | null = null
      if (this.tcLevel !== null) {
        slipAllow = this.tcLevel > 0 ? TC_LEVELS[this.tcLevel]! : null
      } else if (p.tractionControl) {
        // Speed-tapered slip ceiling: tight off the line, releasing toward
        // free-spin as speed builds so slides stay alive in faster corners.
        let t = (Math.abs(s.vx) - p.tcFullSpeed) / (p.tcOffSpeed - p.tcFullSpeed)
        t = Math.min(Math.max(t, 0.0), 1.0)
        slipAllow = p.tcSlip + (1.0 - p.tcSlip) * t
        // Low gears get a flat ceiling the speed taper cannot lift.
        if (s.gear <= p.tcGearMax) slipAllow = Math.min(slipAllow, p.tcGearSlip)
      }
      if (slipAllow !== null) {
        const room = Math.max(Math.abs(s.vx), p.slipVxFloor)
        const ceiling = s.vx + slipAllow * room
        if (s.wheelVr > ceiling) {
          // Report the slip removed, not the wheel speed removed, so the lamp
          // reads the same at 40 km/h as at 140.
          this.tcCut = Math.max(this.tcCut, (s.wheelVr - ceiling) / room)
          s.wheelVr = ceiling
        }
      }
    } else {
      fyR = pacejka(alphaR, gripR) * gripFade
      // Braking: the front shares its grip budget between brake and cornering via
      // a friction ellipse, so you can still trail-brake and rotate, just with
      // less of each. The rear keeps lateral-first so it stays planted.
      const bias = p.brakeBias
      const fxFWant = fxDrive * bias
      const mag = Math.hypot(fxFWant, fyF)
      if (mag > gripF) {
        const scl = gripF / mag
        fxF = fxFWant * scl
        fyF = fyF * scl
      } else {
        fxF = fxFWant
      }
      fxR = frictionClamp(fxDrive * (1.0 - bias), gripR, fyR)
      s.wheelVr = s.vx // ABS-style: no stored spin while braking
    }

    const fxLong = fxF + fxR - drag - rr

    // Body-frame accelerations (bicycle model).
    const ax = fxLong / p.mass + s.vy * s.r - (fyF * Math.sin(delta)) / p.mass
    const ay = (fyF * Math.cos(delta) + fyR) / p.mass - s.vx * s.r
    const rDot = (p.lf * fyF * Math.cos(delta) - p.lr * fyR) / p.inertiaZ

    s.vx += ax * h
    s.vy += ay * h
    s.r += rDot * h

    if (throttle < 0.0 && s.vx > -0.5 && s.vx < 0.5) {
      s.vx = 0.0 // don't let braking drag the car into spurious reverse
    }

    // Integrate global pose.
    s.x += (s.vx * Math.cos(s.yaw) - s.vy * Math.sin(s.yaw)) * h
    s.y += (s.vx * Math.sin(s.yaw) + s.vy * Math.cos(s.yaw)) * h
    s.yaw = wrapAngle(s.yaw + s.r * h)
  }
}
