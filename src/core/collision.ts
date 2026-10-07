/**
 * Contact: the car's hitbox, and the impulses it trades on touching something.
 *
 * A port of ``racing/collision.py``. The car has always been *drawn* as an
 * oriented box — `carLength(p)` by `p.width` — but the physics never consulted
 * it. This makes that same box real, so a mistake at a fast corner costs you
 * something rather than merely voiding the lap.
 *
 * Two halves, and the difference between them is only what the other body can
 * give back. `resolveStatic` is a car against something immovable: the wall's
 * inverse mass and inverse inertia are simply zero. `resolvePair` shares the
 * impulse between two cars by mass, so a heavier car shrugs off a lighter one.
 *
 * Momentum is *not* conserved against a wall, and that is correct — the wall is
 * bolted to the planet, which is outside the system being modelled. Between two
 * cars it IS conserved, because both are inside it: the impulses are equal and
 * opposite, which is worth knowing because it is the strongest single assertion
 * a test can make about this file. Energy is never conserved either way:
 * restitution below 1 makes contact lossy, as it should be for steel.
 */
import type { CarState } from './car.ts'
import type { CarParams } from './carParams.ts'
import { carLength } from './carParams.ts'

/**
 * Positional correction leaves this much overlap unresolved.
 *
 * Resolving to exactly zero makes a car leaning on the wall jitter between
 * "touching" and "free" every tick; a sliver of allowed penetration settles it.
 */
export const PENETRATION_SLOP = 0.005 // m

export interface Contact {
  /** How far the two have to part, in metres. */
  depth: number
  /** Unit vector along which the car must move to separate. */
  nx: number
  ny: number
  /** Where they touch, in world space. */
  px: number
  py: number
}

/**
 * A car's hitbox as four world-space corners, flattened x,y,x,y…
 *
 * Corner order matches Python's `_UNIT_CORNERS` and the rectangle the renderers
 * draw: front-left, front-right, rear-right, rear-left. So what you see is
 * exactly what collides.
 */
export function obbCorners(
  x: number, y: number, yaw: number, length: number, width: number,
  out?: Float64Array,
): Float64Array {
  out ??= new Float64Array(8)
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const hl = length * 0.5
  const hw = width * 0.5
  const lx = [hl, hl, -hl, -hl]
  const ly = [hw, -hw, -hw, hw]
  for (let k = 0; k < 4; k++) {
    out[k * 2] = lx[k]! * c - ly[k]! * s + x
    out[k * 2 + 1] = lx[k]! * s + ly[k]! * c + y
  }
  return out
}

/** `obbCorners` for a live car state. */
export function carCorners(
  s: CarState, p: CarParams, out?: Float64Array,
): Float64Array {
  return obbCorners(s.x, s.y, s.yaw, carLength(p), p.width, out)
}

/** Body-frame (vx, vy) out to world, plus the yaw's cos/sin for the trip back. */
function toWorldVelocity(s: CarState): [number, number, number, number] {
  const c = Math.cos(s.yaw)
  const sn = Math.sin(s.yaw)
  return [s.vx * c - s.vy * sn, s.vx * sn + s.vy * c, c, sn]
}

function storeBodyVelocity(
  s: CarState, vwx: number, vwy: number, c: number, sn: number,
): void {
  s.vx = vwx * c + vwy * sn
  s.vy = -vwx * sn + vwy * c
}

/**
 * Resolve one contact between a car and immovable geometry.
 *
 * Returns the normal impulse in N·s, or zero if the car was already moving away
 * — which is how a car leaning on the wall avoids being hit again every tick.
 *
 * The lever arm is the point of the whole thing. Clipping a wall with a front
 * corner has to spin the car, while sliding flat down it should mostly just
 * scrub speed, and that difference comes entirely from where the contact sits
 * relative to the centre of mass.
 */
export function resolveStatic(
  s: CarState, p: CarParams, contact: Contact, restitution: number, friction: number,
): number {
  const invM = 1.0 / p.mass
  const invI = 1.0 / p.inertiaZ
  const { nx, ny } = contact

  // The car takes the whole positional correction; the wall cannot give any.
  const push = Math.max(contact.depth - PENETRATION_SLOP, 0.0)
  s.x += nx * push
  s.y += ny * push

  const [vwx, vwy, c, sn] = toWorldVelocity(s)
  const rx = contact.px - s.x
  const ry = contact.py - s.y
  // Velocity at the contact point: the CG's, plus the spin about it. In 2D,
  // omega x r is yawRate * (-ry, rx).
  const rvx = vwx - s.r * ry
  const rvy = vwy + s.r * rx

  const vn = rvx * nx + rvy * ny
  if (vn >= 0.0) return 0.0 // already moving away from the wall — push was enough

  const rN = rx * ny - ry * nx
  const jn = (-(1.0 + restitution) * vn) / (invM + rN * rN * invI)

  // Coulomb friction across the contact, capped by the normal impulse: a slide
  // down the wall scrubs speed, a square hit mostly bounces.
  const tx = -ny
  const ty = nx
  const vt = rvx * tx + rvy * ty
  const rT = rx * ty - ry * tx
  const jt = clamp(-vt / (invM + rT * rT * invI), -friction * jn, friction * jn)

  const ix = jn * nx + jt * tx
  const iy = jn * ny + jt * ty
  storeBodyVelocity(s, vwx + ix * invM, vwy + iy * invM, c, sn)
  s.r += (rx * iy - ry * ix) * invI
  // A wheel still spinning at the pre-impact speed reads as a huge slip ratio
  // the tick after — a phantom wheelspin caused by the contact rather than the
  // throttle. Re-sync it to the road.
  s.wheelVr = s.vx
  return jn
}

/**
 * Restitution and friction for car-on-car, matching `racing/race.py`'s defaults.
 *
 * Lower restitution than the wall (0.28): two cars touching wheel to wheel is a
 * lean, not a bounce, and a springy one turns every brush into a launch.
 */
export const CAR_RESTITUTION = 0.25
export const CAR_FRICTION = 0.45

/** Min and max of a corner ring's shadow on an axis. */
function project(c: Float64Array, ax: number, ay: number): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (let k = 0; k < 4; k++) {
    const d = c[k * 2]! * ax + c[k * 2 + 1]! * ay
    if (d < lo) lo = d
    if (d > hi) hi = d
  }
  return [lo, hi]
}

/** A box's two edge normals, straight off its corner ring, into `out`. */
function boxAxes(c: Float64Array, out: Float64Array, at: number): void {
  // Front-left minus rear-left is along the car; front-left minus front-right
  // is across it. Corner order is fixed by `obbCorners`.
  let fx = c[0]! - c[6]!
  let fy = c[1]! - c[7]!
  let lx = c[0]! - c[2]!
  let ly = c[1]! - c[3]!
  const fn = Math.max(Math.hypot(fx, fy), 1e-12)
  const ln = Math.max(Math.hypot(lx, ly), 1e-12)
  fx /= fn; fy /= fn; lx /= ln; ly /= ln
  out[at] = fx; out[at + 1] = fy; out[at + 2] = lx; out[at + 3] = ly
}

/**
 * Penetration of two corner rings' shadows on an axis: `[depth, sign]`.
 *
 * `sign === 0` means a gap on this axis, so the shapes are apart. Otherwise
 * `depth` is the shorter of the two slides that would part them, and `sign`
 * is which way `a` has to move.
 *
 * This is penetration depth, not the length of the shadows' intersection. The
 * two differ exactly when one shadow sits wholly inside the other — routine
 * when a short car overlaps a long one end-on.
 */
function axisPenetration(
  ax: number, ay: number, a: Float64Array, b: Float64Array,
): [number, number] {
  const [aLo, aHi] = project(a, ax, ay)
  const [bLo, bHi] = project(b, ax, ay)
  const pushPos = bHi - aLo // slide a along +axis to clear
  const pushNeg = aHi - bLo // slide it along -axis to clear
  if (pushPos <= 0.0 || pushNeg <= 0.0) return [0.0, 0.0]
  return pushPos < pushNeg ? [pushPos, 1.0] : [pushNeg, -1.0]
}

/**
 * Separating-axis test between two oriented boxes given as corner rings.
 *
 * Null if they are apart, else the minimum translation parting them, with the
 * normal pointing from `b` toward `a`.
 *
 * Four candidate axes — two edge normals from each box. Rectangles have only
 * two distinct normals each (opposite edges are parallel), so four is the
 * complete set: if the shadows overlap on all of them, the boxes really do
 * intersect.
 */
export function boxBoxContact(a: Float64Array, b: Float64Array): Contact | null {
  const axes = new Float64Array(8)
  boxAxes(a, axes, 0)
  boxAxes(b, axes, 4)

  let depth = Infinity
  let nx = 0
  let ny = 0
  for (let i = 0; i < 8; i += 2) {
    const [d, sign] = axisPenetration(axes[i]!, axes[i + 1]!, a, b)
    if (sign === 0.0) return null // a gap on any axis means no contact at all
    if (d < depth) {
      depth = d
      nx = axes[i]! * sign
      ny = axes[i + 1]! * sign
    }
  }

  // Contact point: the centre of the region the two boxes actually share. Found
  // by intersecting their shadows on the tangent and taking that midpoint, then
  // seating it between the two touching faces along the normal.
  //
  // The tempting shortcut — "use the corner poking deepest along the normal" —
  // is wrong for the most common racing contact there is. In a flat side-by-side
  // rub every corner of the touching face is equally deep, so the choice is
  // arbitrary, and picking a FRONT corner invents a metre of lever arm that
  // spins both cars as though they had been hit on the nose. The overlap centre
  // gives a flat rub almost no yaw, while still putting the contact out at the
  // corner when it genuinely is a corner poke — because then the shared region
  // *is* that corner.
  const tx = -ny
  const ty = nx
  const [aTLo, aTHi] = project(a, tx, ty)
  const [bTLo, bTHi] = project(b, tx, ty)
  const tMid = 0.5 * (Math.max(aTLo, bTLo) + Math.min(aTHi, bTHi))
  const [aNLo] = project(a, nx, ny)
  const [, bNHi] = project(b, nx, ny)
  const nMid = 0.5 * (aNLo + bNHi)
  return { depth, nx, ny, px: tx * tMid + nx * nMid, py: ty * tMid + ny * nMid }
}

/** The pair of things `resolvePair` needs from a car: its state and its params. */
export interface Colliding {
  s: CarState
  p: CarParams
}

/**
 * Resolve one contact between two cars. Returns the normal impulse (N·s).
 *
 * Zero if they were already moving apart, which is how cars leaning on each
 * other avoid being hit again every tick.
 *
 * Both cars are pushed apart and both take an impulse, split by mass — so a
 * heavier car shrugs off a lighter one. The impulses are equal and opposite, so
 * the pair's linear momentum is unchanged by the contact itself.
 */
export function resolvePair(
  a: Colliding, b: Colliding, contact: Contact, restitution: number, friction: number,
): number {
  const sa = a.s
  const sb = b.s
  const { nx, ny } = contact
  const invMa = 1.0 / a.p.mass
  const invMb = 1.0 / b.p.mass
  const invIa = 1.0 / a.p.inertiaZ
  const invIb = 1.0 / b.p.inertiaZ

  // Part them along the normal, each moving in inverse proportion to its mass.
  const push = Math.max(contact.depth - PENETRATION_SLOP, 0.0)
  const share = push / (invMa + invMb)
  sa.x += nx * share * invMa
  sa.y += ny * share * invMa
  sb.x -= nx * share * invMb
  sb.y -= ny * share * invMb

  const [vax, vay, ca, sna] = toWorldVelocity(sa)
  const [vbx, vby, cb, snb] = toWorldVelocity(sb)

  // Lever arms from each centre of mass to the contact, measured after the push.
  const rax = contact.px - sa.x
  const ray = contact.py - sa.y
  const rbx = contact.px - sb.x
  const rby = contact.py - sb.y

  // Relative velocity *at the contact point*: each car's CG velocity plus the
  // spin about it (in 2D, omega x r is yawRate * (-ry, rx)).
  const rvx = (vax - sa.r * ray) - (vbx - sb.r * rby)
  const rvy = (vay + sa.r * rax) - (vby + sb.r * rbx)

  const vn = rvx * nx + rvy * ny
  if (vn >= 0.0) return 0.0 // already separating — parting them was enough

  const raN = rax * ny - ray * nx
  const rbN = rbx * ny - rby * nx
  const denomN = invMa + invMb + raN * raN * invIa + rbN * rbN * invIb
  const jn = (-(1.0 + restitution) * vn) / denomN

  // Coulomb friction across the contact, capped by the normal impulse: a
  // side-by-side rub scrubs speed, a square hit mostly bounces.
  const tx = -ny
  const ty = nx
  const vt = rvx * tx + rvy * ty
  const raT = rax * ty - ray * tx
  const rbT = rbx * ty - rby * tx
  const denomT = invMa + invMb + raT * raT * invIa + rbT * rbT * invIb
  const jt = clamp(-vt / denomT, -friction * jn, friction * jn)

  const ix = jn * nx + jt * tx
  const iy = jn * ny + jt * ty

  // Equal and opposite: A takes +j, B takes -j.
  storeBodyVelocity(sa, vax + ix * invMa, vay + iy * invMa, ca, sna)
  storeBodyVelocity(sb, vbx - ix * invMb, vby - iy * invMb, cb, snb)
  sa.r += (rax * iy - ray * ix) * invIa
  sb.r -= (rbx * iy - rby * ix) * invIb

  // Both cars' driven wheels keep spinning at whatever speed they had before the
  // hit. Left alone that reads as a huge slip ratio next tick — a phantom
  // wheelspin caused by the contact rather than the throttle. Re-sync to road.
  sa.wheelVr = sa.vx
  sb.wheelVr = sb.vx
  return jn
}

/**
 * Resolve contacts among every pair of cars. Returns each car's peak impulse.
 *
 * Pairs are cheap enough to test exhaustively — a grid is a handful of cars,
 * not a crowd — so there is no spatial index here. A couple of passes lets a car
 * wedged between two others settle instead of being volleyed between them.
 */
export function resolveCars(
  cars: readonly Colliding[],
  restitution = CAR_RESTITUTION,
  friction = CAR_FRICTION,
  iterations = 2,
): Float64Array {
  const n = cars.length
  const impacts = new Float64Array(n)
  if (n < 2) return impacts

  const rings = cars.map((c) => carCorners(c.s, c.p))
  for (let pass = 0; pass < iterations; pass++) {
    // Corner rings are rebuilt as we go because resolving one pair moves cars,
    // which changes every contact they are involved in.
    let settled = true
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const hit = boxBoxContact(rings[i]!, rings[j]!)
        if (hit === null) continue
        settled = false
        const jn = resolvePair(cars[i]!, cars[j]!, hit, restitution, friction)
        if (jn > 0.0) {
          impacts[i] = Math.max(impacts[i]!, jn)
          impacts[j] = Math.max(impacts[j]!, jn)
        }
        carCorners(cars[i]!.s, cars[i]!.p, rings[i]!)
        carCorners(cars[j]!.s, cars[j]!.p, rings[j]!)
      }
    }
    if (settled) break
  }
  return impacts
}

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v
