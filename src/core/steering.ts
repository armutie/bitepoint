/**
 * What steering the car ACTUALLY needs for a corner — measured, not derived.
 *
 * The follower's feedforward was `atan(L*k) + K*ay`: the Ackermann angle plus a
 * single constant understeer gradient. That is the textbook linear bicycle
 * model, and this car does not obey it. Measured against the car:
 *
 *     134 km/h, 1.06 g   needs 0.150   formula says 0.415   +177%
 *     116 km/h, 2.32 g   needs 1.000   formula says 0.944     -6%
 *
 * A straight line fitted to a relationship that bends over and flattens. The
 * constant was swept to be least wrong AT THE LIMIT, where laps are won, so it
 * is wildly wrong everywhere else — and whatever the feedforward gets wrong the
 * feedback has to make up, which a proportional term can only do by holding a
 * STANDING ERROR. Measured on Croft Bay the car sat 1.80 m to one side through
 * the start/finish corner for its entire length, never crossing the line once.
 *
 * That 1.8 m is most of why `commitment` has to be backed off 4.7 s: the line
 * leaves 2.74 m there, and the car spends nearly all of it being in the wrong
 * place rather than going too fast.
 *
 * So do to the steering what `ggv` did to the grip: stop deriving it and ask
 * the car. Sweep steering against speed, record the curvature that comes out,
 * and invert. The table only covers what the car can SUSTAIN, which is the
 * right domain — the speed profile already guarantees it never plans a corner
 * outside that envelope.
 */
import { Car, peakDriveForce } from './car'
import type { CarParams } from './carParams'

const DT = 1 / 60
const SUBSTEPS = 10

/** Speeds sampled (m/s). */
const SPEEDS = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80]

/** Steering commands swept at each speed. */
const COMMANDS = 24

/** Body slip past which the car is departing rather than cornering. */
const MAX_BETA = (14 * Math.PI) / 180

/** Ticks each sample is averaged over, at the moment the speed is right. */
const HOLD = 12

export interface SteerTable {
  /** Sample speeds, ascending (m/s). */
  v: Float64Array
  /**
   * Curvature reached at each (speed, command), row-major `v.length x cmd.length`.
   * Monotonic in command until the front saturates, then flat.
   */
  k: Float64Array
  /** The commands the columns correspond to, ascending, 0..1. */
  cmd: Float64Array
}

/**
 * The curvature this much lock produces AT this speed, or null if there is no
 * steady answer to be had.
 *
 * COASTS THROUGH the target rather than holding it, and that is the whole
 * design. The first version closed a throttle loop on speed and rejected any
 * sample that drifted — which works below about 200 km/h and fails completely
 * above it, because a car cornering at 3 g cannot be held at speed by an engine
 * that is already flat out. So the samples that got rejected were exactly the
 * ones at high speed and high lock, the column plateaued early, and above
 * 252 km/h nothing survived at all: a row of zeroes, which `steerFor` reads as
 * "full lock for any corner". The follower was driving on that.
 *
 * The same trap has now produced a fake 2.9 g grip plateau, a 6.08 g lateral
 * reading, and this. Coast down through the number you want.
 */
function settle(p: CarParams, speed: number, cmd: number): number | null {
  const car = new Car(p)
  car.reset(0, 0, 0)
  car.s.vx = speed * 1.25
  car.s.wheelVr = speed * 1.25
  for (let i = 0; i < 3000; i++) {
    car.step(cmd, 0, DT, SUBSTEPS)
    if (Math.hypot(car.s.vx, car.s.vy) > speed) continue
    // Passing through the target now. Sample a short window — short enough that
    // the coast has not moved the speed much, long enough to see a departure.
    let sumK = 0
    let n = 0
    for (let k = 0; k < HOLD; k++) {
      car.step(cmd, 0, DT, SUBSTEPS)
      const v = Math.hypot(car.s.vx, car.s.vy)
      const beta = Math.abs(Math.atan2(car.s.vy, Math.max(Math.abs(car.s.vx), 0.5)))
      if (beta > MAX_BETA) return null
      sumK += Math.abs(car.s.r) / Math.max(v, 1)
      n++
    }
    return n ? sumK / n : null
  }
  return null
}

/** The fastest this car can go: where the best gear stops beating drag. */
function topSpeed(p: CarParams): number {
  let top = SPEEDS[0]!
  for (let v = 10; v < 200; v += 0.5) {
    if (peakDriveForce(p, v) > p.dragCoef * v * v + p.rollingResistance) top = v
  }
  return top
}

export function measureSteering(p: CarParams): SteerTable {
  // Never sample a speed the car cannot reach: the run starts above the
  // target, so asking for 90 m/s in a car that tops out at 80 places it at a
  // speed it can never occupy and reads the answer on the way down from there.
  const top = topSpeed(p)
  const speeds = SPEEDS.filter((v) => v <= top)
  const cmd = new Float64Array(COMMANDS)
  for (let c = 0; c < COMMANDS; c++) cmd[c] = (c + 1) / COMMANDS
  const k = new Float64Array(speeds.length * COMMANDS)
  for (let i = 0; i < speeds.length; i++) {
    let last = 0
    for (let c = 0; c < COMMANDS; c++) {
      const got = settle(p, speeds[i]!, cmd[c]!)
      // Where the car will not hold a steady corner, the best honest statement
      // is that no MORE curvature is available than the last one that held.
      last = got === null ? last : Math.max(last, got)
      k[i * COMMANDS + c] = last
    }
  }
  return { v: Float64Array.from(speeds), k, cmd }
}

/**
 * The steering command that produces curvature `k` at `speed`.
 *
 * Interpolated in both axes. If the corner is tighter than anything the car
 * reached at that speed, this returns full lock — which is the truth: the front
 * is saturated or out of travel and there is no command that turns tighter.
 */
export function steerFor(t: SteerTable, speed: number, curvature: number): number {
  const k = Math.abs(curvature)
  const n = t.v.length
  const m = t.cmd.length
  let i = 0
  while (i + 1 < n && t.v[i + 1]! < Math.abs(speed)) i++
  const j = Math.min(i + 1, n - 1)
  const span = t.v[j]! - t.v[i]!
  const f = span > 1e-9 ? Math.min(1, Math.max(0, (Math.abs(speed) - t.v[i]!) / span)) : 0

  /** Command needed on one speed row, by scanning its curvature column. */
  const onRow = (row: number): number => {
    const base = row * m
    if (k <= t.k[base]!) {
      // Below the first sample: the response is near enough linear down here.
      const k0 = t.k[base]!
      return k0 > 1e-9 ? (k / k0) * t.cmd[0]! : t.cmd[0]!
    }
    for (let c = 1; c < m; c++) {
      const lo = t.k[base + c - 1]!
      const hi = t.k[base + c]!
      if (k <= hi) {
        const d = hi - lo
        const u = d > 1e-9 ? (k - lo) / d : 0
        return t.cmd[c - 1]! + u * (t.cmd[c]! - t.cmd[c - 1]!)
      }
    }
    return t.cmd[m - 1]!
  }
  return onRow(i) + f * (onRow(j) - onRow(i))
}

/**
 * The steering table for a car, measured once and remembered.
 *
 * Keyed on the params object rather than baked into a file: it is a property of
 * the CAR, not of a circuit, and it costs under half a second to measure. The
 * game already reuses one `CarParams` per setup, so this is measured once per
 * session per car and never again.
 */
const cache = new WeakMap<CarParams, SteerTable>()

export function steeringFor(p: CarParams): SteerTable {
  let t = cache.get(p)
  if (!t) {
    t = measureSteering(p)
    cache.set(p, t)
  }
  return t
}
