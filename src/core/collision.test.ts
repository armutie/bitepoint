/**
 * Car-to-car contact: the invariants, not a trace.
 *
 * `barriers.test.ts` pins the wall against golden traces from Python, because a
 * wall is part of the circuit and the two sims must agree about it to the
 * decimal. Car-to-car is checked differently here, against the physics it is
 * supposed to obey — momentum, symmetry, and where the lever arm sits.
 *
 * The reason is that these are the properties a racing bug actually violates.
 * A field that slowly gains energy, a rub that spins both cars as though they
 * had been punted, a car wedged between two others being volleyed rather than
 * settling — none of those show up as a small numeric drift from a reference
 * lap. They show up as a broken invariant, so that is what is asserted.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { Car } from './car'
import { carLength, handlingPreset } from './carParams'
import {
  boxBoxContact, carCorners, CAR_FRICTION, CAR_RESTITUTION, obbCorners,
  PENETRATION_SLOP, resolveCars, resolvePair, type Colliding,
} from './collision'

// Staging distances come from the car, not from numbers typed here: the hitbox
// is `carLength(p)` by `p.width`, and a test that hardcodes 4.6 m silently stops
// testing anything the day the chassis changes.
const P = handlingPreset('f1')
const LEN = carLength(P)
const WID = P.width
/** How far into each other staged cars start, in metres. */
const BITE = 0.15

/** A car staged at a pose, with a body-frame velocity and a yaw rate. */
function stage(x: number, y: number, yaw: number, vx: number, vy = 0, r = 0): Car {
  const car = new Car(handlingPreset('f1'))
  car.s.x = x
  car.s.y = y
  car.s.yaw = yaw
  car.s.vx = vx
  car.s.vy = vy
  car.s.r = r
  car.s.wheelVr = vx
  return car
}

/** World-frame momentum of the whole field, (px, py) in kg·m/s. */
function momentum(cars: readonly Colliding[]): [number, number] {
  let px = 0
  let py = 0
  for (const { s, p } of cars) {
    const c = Math.cos(s.yaw)
    const sn = Math.sin(s.yaw)
    px += p.mass * (s.vx * c - s.vy * sn)
    py += p.mass * (s.vx * sn + s.vy * c)
  }
  return [px, py]
}

/** Kinetic energy of the field, translational plus rotational, in joules. */
function energy(cars: readonly Colliding[]): number {
  let e = 0
  for (const { s, p } of cars) {
    e += 0.5 * p.mass * (s.vx * s.vx + s.vy * s.vy) + 0.5 * p.inertiaZ * s.r * s.r
  }
  return e
}

describe('box-box detection', () => {
  const L = 5
  const W = 2

  it('finds no contact between boxes that are apart', () => {
    const a = obbCorners(0, 0, 0, L, W)
    const b = obbCorners(20, 0, 0, L, W)
    expect(boxBoxContact(a, b)).toBeNull()
  })

  it('finds no contact for boxes that merely share a shadow on one axis', () => {
    // Directly abeam but a lane apart: the along-car axis overlaps completely,
    // the across-car axis does not. A test that stopped at the first axis would
    // call this a hit.
    const a = obbCorners(0, 0, 0, L, W)
    const b = obbCorners(0, 6, 0, L, W)
    expect(boxBoxContact(a, b)).toBeNull()
  })

  it('parts an overlapping pair along the shorter axis', () => {
    // Side by side, overlapping laterally by 0.5 m. The lateral slide is far
    // shorter than the longitudinal one, so that is the normal it must pick.
    const a = obbCorners(0, 0, 0, L, W)
    const b = obbCorners(0, W - 0.5, 0, L, W)
    const hit = boxBoxContact(a, b)
    expect(hit).not.toBeNull()
    expect(hit!.depth).toBeCloseTo(0.5, 9)
    // Normal points from b toward a: b is at +y, so a must move to -y.
    expect(hit!.nx).toBeCloseTo(0, 9)
    expect(hit!.ny).toBeCloseTo(-1, 9)
  })

  it('reports penetration depth, not shadow width, when one box is swallowed', () => {
    // A box wholly inside another's shadow on an axis: the shadows' intersection
    // is the small box's whole width, but the distance to part them is not.
    const a = obbCorners(0, 0, 0, L, W)
    const b = obbCorners(0, 0, 0, L * 0.5, W * 0.5)
    const hit = boxBoxContact(a, b)
    expect(hit).not.toBeNull()
    // Parting them laterally: b's half-width plus a's half-width, since b's
    // centre sits on a's centreline.
    expect(hit!.depth).toBeCloseTo(W * 0.25 + W * 0.5, 9)
  })

  it('puts the contact point in the middle of a flat rub, not at a corner', () => {
    const a = obbCorners(0, 0, 0, L, W)
    const b = obbCorners(0, W - 0.4, 0, L, W)
    const hit = boxBoxContact(a, b)!
    // The two are exactly abeam, so the shared region is centred on x = 0. A
    // "deepest corner" rule would put this at one end of the car instead.
    expect(hit.px).toBeCloseTo(0, 9)
  })

  it('puts the contact point out at the corner when it is a corner poke', () => {
    // b's nose overlapping a's rear quarter: the shared region really is that
    // corner, so the contact point must be out there and carry a lever arm.
    const a = obbCorners(0, 0, 0, L, W)
    const b = obbCorners(-L + 0.4, W - 0.4, 0, L, W)
    const hit = boxBoxContact(a, b)!
    expect(hit.px).toBeLessThan(-1.0)
  })
})

describe('pair resolution', () => {
  it('conserves the field\'s linear momentum through a rear-end', () => {
    // The strongest single statement about this file: whatever the impulse does
    // to the two cars, it must not create or destroy momentum, because both
    // bodies are inside the system. (A wall is not, which is why
    // `resolveStatic` makes no such promise.)
    const a = stage(0, 0, 0, 40)
    const b = stage(LEN - BITE, 0, 0, 20)
    const before = momentum([a, b])
    const hit = boxBoxContact(carCorners(a.s, a.p), carCorners(b.s, b.p))
    expect(hit).not.toBeNull()
    resolvePair(a, b, hit!, CAR_RESTITUTION, CAR_FRICTION)
    const after = momentum([a, b])
    expect(after[0]).toBeCloseTo(before[0], 6)
    expect(after[1]).toBeCloseTo(before[1], 6)
  })

  it('never gains energy', () => {
    const a = stage(0, 0, 0, 45)
    const b = stage(LEN - BITE, 0.3, 0, 18)
    const before = energy([a, b])
    const hit = boxBoxContact(carCorners(a.s, a.p), carCorners(b.s, b.p))!
    resolvePair(a, b, hit, CAR_RESTITUTION, CAR_FRICTION)
    expect(energy([a, b])).toBeLessThanOrEqual(before + 1e-6)
  })

  it('does nothing to two cars already moving apart', () => {
    // Overlapping, but separating: the positional push is enough, and a second
    // impulse here is what makes cars leaning on each other buzz.
    const a = stage(0, 0, 0, 20)
    const b = stage(LEN - BITE, 0, 0, 40)
    const hit = boxBoxContact(carCorners(a.s, a.p), carCorners(b.s, b.p))!
    const jn = resolvePair(a, b, hit, CAR_RESTITUTION, CAR_FRICTION)
    expect(jn).toBe(0)
    expect(a.s.vx).toBeCloseTo(20, 9)
    expect(b.s.vx).toBeCloseTo(40, 9)
  })

  it('separates the pair, leaving only the slop', () => {
    const a = stage(0, 0, 0, 40)
    const b = stage(LEN - BITE, 0, 0, 20)
    const hit = boxBoxContact(carCorners(a.s, a.p), carCorners(b.s, b.p))!
    expect(hit.depth).toBeCloseTo(BITE, 9)
    resolvePair(a, b, hit, CAR_RESTITUTION, CAR_FRICTION)
    // They were `BITE` into each other; afterwards all but the slop is gone, so
    // they sit exactly one car length apart bar the sliver left on purpose.
    expect(b.s.x - a.s.x).toBeCloseTo(LEN - PENETRATION_SLOP, 6)
  })

  it('moves the lighter car more, in inverse proportion to mass', () => {
    const heavy = stage(0, 0, 0, 40)
    const light = stage(LEN - BITE, 0, 0, 20)
    // Same chassis otherwise; only the mass differs, so the split is clean.
    ;(light.p as { mass: number }).mass = heavy.p.mass * 0.5
    const beforeHeavy = heavy.s.vx
    const beforeLight = light.s.vx
    const hit = boxBoxContact(carCorners(heavy.s, heavy.p), carCorners(light.s, light.p))!
    resolvePair(heavy, light, hit, CAR_RESTITUTION, CAR_FRICTION)
    const dHeavy = Math.abs(heavy.s.vx - beforeHeavy)
    const dLight = Math.abs(light.s.vx - beforeLight)
    expect(dLight).toBeGreaterThan(dHeavy)
    expect(dLight / dHeavy).toBeCloseTo(2.0, 3)
  })

  it('gives a flat side-by-side rub almost no yaw', () => {
    // The contact-point rule earns its keep here. Two cars exactly abeam,
    // closing laterally: the shared region is centred, the lever arm is nearly
    // zero, so they should push apart without either being spun.
    const a = stage(0, 0, 0, 60, 0.8)
    const b = stage(0, WID - BITE, 0, 60, -0.8)
    const hit = boxBoxContact(carCorners(a.s, a.p), carCorners(b.s, b.p))!
    resolvePair(a, b, hit, CAR_RESTITUTION, CAR_FRICTION)
    expect(Math.abs(a.s.r)).toBeLessThan(0.02)
    expect(Math.abs(b.s.r)).toBeLessThan(0.02)
  })

  it('spins both cars when one is poked on the corner', () => {
    // Same closing speed as the rub above, but offset so the overlap is at the
    // quarter rather than along the flank. This must yaw them.
    const a = stage(0, 0, 0, 60, 0.8)
    const b = stage(-(LEN - BITE), WID - BITE, 0, 60, -0.8)
    const hit = boxBoxContact(carCorners(a.s, a.p), carCorners(b.s, b.p))!
    resolvePair(a, b, hit, CAR_RESTITUTION, CAR_FRICTION)
    expect(Math.abs(a.s.r)).toBeGreaterThan(0.02)
    expect(Math.abs(b.s.r)).toBeGreaterThan(0.02)
  })

  it('re-syncs the driven wheel so contact does not read as wheelspin', () => {
    const a = stage(0, 0, 0, 40)
    const b = stage(LEN - BITE, 0, 0, 20)
    const hit = boxBoxContact(carCorners(a.s, a.p), carCorners(b.s, b.p))!
    resolvePair(a, b, hit, CAR_RESTITUTION, CAR_FRICTION)
    expect(a.s.wheelVr).toBeCloseTo(a.s.vx, 9)
    expect(b.s.wheelVr).toBeCloseTo(b.s.vx, 9)
  })
})

describe('field resolution', () => {
  it('is a no-op for a field with nothing touching', () => {
    const cars = [stage(0, 0, 0, 50), stage(30, 0, 0, 50), stage(60, 0, 0, 50)]
    const impacts = resolveCars(cars)
    expect(Array.from(impacts)).toEqual([0, 0, 0])
    expect(cars[0]!.s.x).toBe(0)
  })

  it('settles a car wedged between two others instead of volleying it', () => {
    // Three abreast, the middle one overlapping both. This is the case a
    // sequential solver gets wrong: one pass pushes the middle car out of the
    // left one and straight into the right, so it ends up jammed against a
    // neighbour rather than sitting between them.
    //
    // Two passes do not fully clear a chain — they are not meant to, and Python
    // ships the same `iterations=2`. What they buy is that the field converges
    // toward the answer instead of oscillating, so what is asserted is progress
    // and symmetry, not a perfect separation this budget cannot deliver.
    const gap = WID - BITE
    const cars = [stage(0, -gap, 0, 50), stage(0, 0, 0, 50), stage(0, gap, 0, 50)]
    resolveCars(cars)

    // The middle car stays in the middle. Not to the last bit — pairs are
    // resolved one after another, so the left contact is settled against a pose
    // the right contact then changes, and a few millimetres of asymmetry fall
    // out of the ordering rather than the physics. (Python resolves pairs the
    // same way and inherits the same wobble.) Being VOLLEYED is the failure
    // this guards, and that looks like the car ending up against a neighbour.
    expect(Math.abs(cars[1]!.s.y)).toBeLessThan(BITE)
    // The outer two are pushed apart, never drawn together.
    expect(cars[0]!.s.y).toBeLessThan(-gap)
    expect(cars[2]!.s.y).toBeGreaterThan(gap)

    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const hit = boxBoxContact(
          carCorners(cars[i]!.s, cars[i]!.p), carCorners(cars[j]!.s, cars[j]!.p),
        )
        // Whatever overlap survives is strictly less than it started with.
        if (hit !== null) expect(hit.depth).toBeLessThan(BITE)
      }
    }
  })

  it('converges the same wedge given more passes', () => {
    // The companion to the test above: the residual there is a budget, not a
    // fixed point. Given more passes the chain clears to the slop, which is what
    // says the solver is converging rather than stuck.
    const gap = WID - BITE
    const cars = [stage(0, -gap, 0, 50), stage(0, 0, 0, 50), stage(0, gap, 0, 50)]
    resolveCars(cars, CAR_RESTITUTION, CAR_FRICTION, 12)
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const hit = boxBoxContact(
          carCorners(cars[i]!.s, cars[i]!.p), carCorners(cars[j]!.s, cars[j]!.p),
        )
        // Down to the slop, which is the fixed point: the solver stops pushing
        // once the remaining overlap is the sliver left on purpose.
        if (hit !== null) expect(hit.depth).toBeLessThanOrEqual(PENETRATION_SLOP + 1e-6)
      }
    }
  })

  it('conserves momentum across a whole field, not just a pair', () => {
    const cars = [
      stage(0, 0, 0, 55),
      stage(LEN - BITE, 0.4, 0.02, 40),
      stage(2 * (LEN - BITE), -0.3, -0.01, 42),
    ]
    const before = momentum(cars)
    resolveCars(cars)
    const after = momentum(cars)
    expect(after[0]).toBeCloseTo(before[0], 6)
    expect(after[1]).toBeCloseTo(before[1], 6)
  })

  it('reports the peak impulse for every car involved', () => {
    const cars = [stage(0, 0, 0, 60), stage(LEN - BITE, 0, 0, 20)]
    const impacts = resolveCars(cars)
    expect(impacts[0]).toBeGreaterThan(0)
    expect(impacts[0]).toBeCloseTo(impacts[1]!, 9)
  })
})

/**
 * Parity: these exact numbers against Python's, from
 * ``python export_web_assets.py --fixtures``.
 *
 * The invariants above say the physics is sane. They cannot say it is the SAME
 * physics — two sims can each conserve momentum perfectly while disagreeing
 * about which way the tangent points or where the contact sits, and a race that
 * runs differently in the browser than in training is a race the training does
 * not describe. So the numbers themselves are pinned.
 */
interface ContactFixture {
  contact: { restitution: number; friction: number; iterations: number }
  cases: {
    name: string
    startA: number[]
    startB: number[]
    contact: { depth: number; nx: number; ny: number; px: number; py: number }
    jn: number
    a: Record<string, number>
    b: Record<string, number>
  }[]
  field: { starts: number[][]; impacts: number[]; cars: Record<string, number>[] }
}

const fx = JSON.parse(
  readFileSync(fileURLToPath(new URL('./__fixtures__/carContact.json', import.meta.url)), 'utf-8'),
) as ContactFixture

/** Python names the driven-wheel field `wheel_v_r`; here it is `wheelVr`. */
function expectState(actual: Car, want: Record<string, number>, label: string): void {
  for (const [key, value] of Object.entries(want)) {
    const got = actual.s[key === 'wheel_v_r' ? 'wheelVr' : (key as 'x')]
    expect(got, `${label}.${key}`).toBeCloseTo(value, 9)
  }
}

const staged = (v: number[]): Car => stage(v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!)

describe('parity with racing/collision.py', () => {
  it('agrees on the restitution and friction a race is run with', () => {
    expect(CAR_RESTITUTION).toBe(fx.contact.restitution)
    expect(CAR_FRICTION).toBe(fx.contact.friction)
  })

  for (const c of fx.cases) {
    it(`matches Python on ${c.name}`, () => {
      const a = staged(c.startA)
      const b = staged(c.startB)
      const hit = boxBoxContact(carCorners(a.s, a.p), carCorners(b.s, b.p))
      expect(hit, 'the pose must actually touch').not.toBeNull()
      expect(hit!.depth).toBeCloseTo(c.contact.depth, 9)
      expect(hit!.nx).toBeCloseTo(c.contact.nx, 9)
      expect(hit!.ny).toBeCloseTo(c.contact.ny, 9)
      expect(hit!.px).toBeCloseTo(c.contact.px, 9)
      expect(hit!.py).toBeCloseTo(c.contact.py, 9)

      const jn = resolvePair(a, b, hit!, fx.contact.restitution, fx.contact.friction)
      expect(jn).toBeCloseTo(c.jn, 6)
      expectState(a, c.a, `${c.name}.a`)
      expectState(b, c.b, `${c.name}.b`)
    })
  }

  it('matches Python on a three-abreast field, pass ordering included', () => {
    const cars = fx.field.starts.map(staged)
    const impacts = resolveCars(cars, fx.contact.restitution, fx.contact.friction,
      fx.contact.iterations)
    expect(Array.from(impacts)).toHaveLength(fx.field.impacts.length)
    impacts.forEach((v, i) => expect(v).toBeCloseTo(fx.field.impacts[i]!, 6))
    cars.forEach((c, i) => expectState(c, fx.field.cars[i]!, `field[${i}]`))
  })
})
