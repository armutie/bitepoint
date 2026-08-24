/**
 * Contact: the car's hitbox, and the impulses it trades on touching something.
 *
 * A port of the half of ``racing/collision.py`` the browser needs. The car has
 * always been *drawn* as an oriented box — `carLength(p)` by `p.width` — but
 * the physics never consulted it. This makes that same box real, so a mistake
 * at a fast corner costs you something rather than merely voiding the lap.
 *
 * Only the static half is here. `resolve_pair`, which shares an impulse between
 * two cars by mass, exists in Python for wheel-to-wheel racing on the LAN
 * server; the browser has one car and a wall, so porting it would be code with
 * no caller. `resolveStatic` is that same impulse against something immovable:
 * the other body's inverse mass and inverse inertia are simply zero.
 *
 * Momentum is *not* conserved against a wall, and that is correct — the wall is
 * bolted to the planet, which is outside the system being modelled. Energy is
 * never conserved either: restitution below 1 makes contact lossy, as it should
 * be for steel.
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

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v
