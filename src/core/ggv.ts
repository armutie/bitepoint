/**
 * What the car can actually do, measured — the g-g-V diagram.
 *
 * The planner used to DERIVE its limits: axle loads, a load-sensitive mu, a
 * friction circle. Rebuilt axle-by-axle that got cornering to within 5% — but
 * measured against the car the two axes are wrong in OPPOSITE directions:
 *
 *     cornering   +5.5%  optimistic
 *     braking    -13.3%  pessimistic
 *
 * which is why no single `commitment` could ever fix it. Wind it up to recover
 * the braking that the model was leaving on the table and you inflate the
 * cornering limits that were already too high, and the car runs wide. One knob,
 * two errors, opposite signs.
 *
 * So stop deriving and start measuring. This sweeps the car through its speed
 * range and records the most lateral acceleration it will actually hold and the
 * most longitudinal, as a table indexed by speed. Whatever the tyre model does
 * that a formula does not capture is captured here by construction, because the
 * numbers came from the tyre model. TUM's open-source trajectory stack calls
 * this the ggv diagram and its velocity solver looks the limits up rather than
 * computing them; this is the same idea against our own car.
 *
 * TWO CONVENTIONS, both worth stating because both are easy to get wrong:
 *
 *   NO DRAG in the table. These are tyre and engine limits; drag is a separate
 *   force the profile applies itself. Baking it in would tie the table to the
 *   aero of the car that measured it.
 *
 *   SUSTAINED, not peak. A car on its way to spinning passes through a moment
 *   of enormous yaw rate with its slip angle still small, and the obvious
 *   measurement reads that as grip — it claimed 6.5 g at 300 km/h, half again
 *   what the car holds. Every sample here has to survive a third of a second.
 *
 * WHAT THIS DOES NOT FIX: transients. Every limit here is a steady state, and a
 * quick change of direction does not have time to reach one. That is the known
 * limitation of the whole quasi-steady-state family, and the honest answer to
 * it is transient optimal control, which is minutes of solve rather than
 * seconds.
 */
import { Car, G, peakDriveForce } from './car'
import type { CarParams } from './carParams'

/** Speeds the table is sampled at (m/s), before the car's own top speed trims it. */
const SPEEDS = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90]

/**
 * The fastest this car can actually go: where the best gear stops beating drag.
 *
 * Sampling past it produced the table's one remaining nonsense row. The sweep
 * starts each run at 1.3x the target, so asking for 90 m/s in a car that tops
 * out at 80.5 placed it at 117 m/s — a state it can never occupy — and read the
 * grip on the way down from there. Trimming the list is better than clamping
 * the result, because a row the car cannot reach has nothing to say.
 */
function sampleSpeeds(p: CarParams): number[] {
  const top = topSpeed(p)
  const kept = SPEEDS.filter((v) => v <= top)
  // Always keep at least the low end, however feeble the car.
  return kept.length >= 2 ? kept : SPEEDS.slice(0, 2)
}

function topSpeed(p: CarParams): number {
  let top = SPEEDS[0]!
  for (let v = 10; v < 200; v += 0.5) {
    if (peakDriveForce(p, v) > p.dragCoef * v * v + p.rollingResistance) top = v
  }
  return top
}

/** Slip angle past which the car is departing rather than cornering. */
const MAX_BETA = (14 * Math.PI) / 180

/** Ticks a corner has to be held for before its lateral counts. */
const HOLD = 20

const DT = 1 / 60

/**
 * Integration substeps, matching the game exactly.
 *
 * This read `car.step(cmd, 0, DT, SUBSTEPS)` — which passes 1.0 as SUBSTEPS, not as
 * the grip multiplier it looks like. So every number in this table was measured
 * on a car integrated ten times more coarsely than the one that races, and the
 * error grew with speed: the table climbed to 6.08 g at 288 km/h and then FELL
 * at 306, which is not something a car with downforce can do.
 */
const SUBSTEPS = 10

export interface Ggv {
  /** Sample speeds, ascending (m/s). */
  v: Float64Array
  /** Sustained lateral acceleration available at each speed (m/s²). */
  ay: Float64Array
  /** Braking available, tyres only, drag excluded (m/s²). */
  axBrake: Float64Array
  /** Acceleration available, engine and tyres, drag excluded (m/s²). */
  axDrive: Float64Array
  /**
   * Per-speed correction on the model's tyre grip, so that its lateral limit
   * equals the measured one. Absent on a raw measurement; added for planning.
   */
  muScale?: Float64Array
  /**
   * Friction-ellipse exponent: `ax = axMax * (1 - (ay/ayMax)^e)^(1/e)`.
   *
   * 2 is a circle, which is what the old model assumed. Fitted against the
   * car's own combined-slip behaviour instead.
   */
  ellipse: number
}

/** Linear interpolation into one column of the table, clamped at both ends. */
export function ggvAt(g: Ggv, column: Float64Array, speed: number): number {
  const n = g.v.length
  const v = Math.abs(speed)
  if (v <= g.v[0]!) return column[0]!
  if (v >= g.v[n - 1]!) return column[n - 1]!
  let i = 0
  while (i + 1 < n && g.v[i + 1]! < v) i++
  const t = (v - g.v[i]!) / (g.v[i + 1]! - g.v[i]!)
  return column[i]! + (column[i + 1]! - column[i]!) * t
}

const dragAccel = (p: CarParams, v: number): number =>
  (p.dragCoef * v * v + p.rollingResistance) / p.mass

/** The most lateral acceleration the car HOLDS passing through `speed`. */
function lateralLimit(p: CarParams, speed: number): { ay: number; steer: number } {
  let best = { ay: 0, steer: 0 }
  for (let cmd = 0.05; cmd <= 1.0001; cmd += 0.025) {
    const car = new Car(p)
    car.reset(0, 0, 0)
    car.s.vx = speed * 1.3
    car.s.wheelVr = speed * 1.3
    for (let i = 0; i < 5000; i++) {
      car.step(cmd, 0, DT, SUBSTEPS)
      if (Math.hypot(car.s.vx, car.s.vy) > speed) continue
      let worst = Infinity
      let departed = false
      for (let k = 0; k < HOLD; k++) {
        car.step(cmd, 0, DT, SUBSTEPS)
        const vv = Math.hypot(car.s.vx, car.s.vy)
        const beta = Math.abs(Math.atan2(car.s.vy, Math.max(Math.abs(car.s.vx), 0.5)))
        if (beta > MAX_BETA) { departed = true; break }
        worst = Math.min(worst, Math.abs(car.s.r * vv))
      }
      if (!departed && Number.isFinite(worst) && worst > best.ay) best = { ay: worst, steer: cmd }
      break
    }
  }
  return best
}

/**
 * Longitudinal limit SUSTAINED across a band around `speed`, drag removed.
 *
 * A band average rather than a sample at a point, and that distinction is worth
 * two and a half metres a second of lap pace.
 *
 * The obvious measurement takes the acceleration at the instant the car passes
 * the target speed, skipping any tick inside a gearchange on the grounds that
 * the torque cut is a hole rather than the engine. That is the right way to
 * describe an ENGINE and the wrong way to describe a LAP. The car really does
 * spend 0.15 s a shift with nothing driving it, and a profile built on the
 * peaks asks for an acceleration only reached between them. Measured flat out
 * through the gears, the car peaks at 1.31 g through 50-60 m/s and AVERAGES
 * 0.53 g — and the follower duly sat 8 km/h under its target for 84% of a lap,
 * trying to deliver a number that was never available for more than a moment.
 *
 * So: run the band, take the mean. Shifts, and the time they cost, are inside
 * the number where they belong.
 */
function longitudinalLimit(p: CarParams, speed: number, mode: 'brake' | 'drive'): number {
  const lo = speed * 0.9
  const hi = speed * 1.1
  const car = new Car(p)
  car.reset(0, 0, 0)
  const from = mode === 'brake' ? hi : lo
  car.s.vx = from
  car.s.wheelVr = from
  let ticks = 0
  for (let i = 0; i < 6000; i++) {
    car.step(0, mode === 'brake' ? -1 : 1, DT, SUBSTEPS)
    ticks++
    if (mode === 'brake' ? car.s.vx <= lo : car.s.vx >= hi) break
    // A car that cannot climb out of the band under full throttle is at its
    // top speed; reporting a mean over a timeout would report roughly zero.
    if (ticks > 3000) return 0
  }
  const elapsed = ticks * DT
  if (elapsed <= 0) return 0
  const a = (hi - lo) / elapsed
  const drag = dragAccel(p, speed)
  return Math.max(0, mode === 'brake' ? a - drag : a + drag)
}

/** One point on the combined envelope: cornering and braking at once. */
function combined(
  p: CarParams, speed: number, steer: number, brake: number,
): { ay: number; ax: number } | null {
  const car = new Car(p)
  car.reset(0, 0, 0)
  car.s.vx = speed * 1.2
  car.s.wheelVr = speed * 1.2
  let settled = false
  for (let i = 0; i < 6000; i++) {
    car.step(steer, 0, DT, SUBSTEPS)
    if (Math.hypot(car.s.vx, car.s.vy) <= speed) { settled = true; break }
  }
  if (!settled) return null
  let ax = 0
  let ay = 0
  let n = 0
  let prev = Math.hypot(car.s.vx, car.s.vy)
  for (let i = 0; i < 16; i++) {
    car.step(steer, -brake, DT, SUBSTEPS)
    const v = Math.hypot(car.s.vx, car.s.vy)
    if (Math.abs(Math.atan2(car.s.vy, Math.max(Math.abs(car.s.vx), 0.5))) > MAX_BETA) return null
    // Let the brake and the load transfer arrive before sampling.
    if (i > 5) { ax += (prev - v) / DT; ay += Math.abs(car.s.r * v); n++ }
    prev = v
  }
  if (n === 0) return null
  return { ay: ay / n, ax: Math.max(0, ax / n - dragAccel(p, speed)) }
}

/**
 * Measure the whole diagram for one car.
 *
 * Seconds of simulation, so this is offline work — it runs in `bake-lines` and
 * ships as numbers, exactly like the racing line itself.
 */
export function measureGgv(p: CarParams): Ggv {
  const speeds = sampleSpeeds(p)
  const v = Float64Array.from(speeds)
  const ay = new Float64Array(v.length)
  const axBrake = new Float64Array(v.length)
  const axDrive = new Float64Array(v.length)
  const steers: number[] = []
  for (let i = 0; i < v.length; i++) {
    const lat = lateralLimit(p, v[i]!)
    ay[i] = lat.ay
    steers.push(lat.steer)
    axBrake[i] = longitudinalLimit(p, v[i]!, 'brake')
    axDrive[i] = longitudinalLimit(p, v[i]!, 'drive')
  }

  // Fit the ellipse exponent over as much of the envelope as the car holds.
  const fits: { ayFrac: number; axFrac: number }[] = []
  for (const speed of [25, 40, 55, 70]) {
    const idx = speeds.indexOf(speed)
    if (idx < 0 || ay[idx]! < 1e-6 || axBrake[idx]! < 1e-6) continue
    for (const sf of [0.45, 0.65, 0.8, 0.9, 1.0]) {
      for (const brake of [0.25, 0.5, 0.8, 1.0]) {
        const c = combined(p, speed, steers[idx]! * sf, brake)
        if (!c) continue
        const axFrac = Math.min(c.ax / axBrake[idx]!, 1)
        if (axFrac < 0.05) continue
        fits.push({ ayFrac: Math.min(c.ay / ay[idx]!, 1), axFrac })
      }
    }
  }
  let ellipse = 2
  let bestErr = Infinity
  for (let e = 1.0; e <= 3.001; e += 0.01) {
    let err = 0
    for (const f of fits) {
      err += (Math.pow(Math.max(0, 1 - Math.pow(f.ayFrac, e)), 1 / e) - f.axFrac) ** 2
    }
    if (err < bestErr) { bestErr = err; ellipse = e }
  }

  return { v, ay, axBrake, axDrive, ellipse }
}

/** The g at a speed, for a readable dump. */
export const inG = (a: number): number => a / G
