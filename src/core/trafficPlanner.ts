import { PackTrafficPlanner } from './packTrafficPlanner'
import type { CarState } from './car'
import { carLength, type CarParams } from './carParams'
import { clamp, wrapAngle } from './math'
import { longitudinalLimit, nearestStation, type RacingLine } from './racingLine'
import type { Projection, Track } from './track'

/** All drivers read this snapshot. No access to player controls or future inputs. */
export interface TrafficCar {
  state: CarState
  road: Projection
  speed: number
  /** A human driver cannot be assumed to follow our reference or share an apex. */
  player?: boolean
}

export interface TrafficDecision {
  lane: number | null
  reason: 'clear' | 'progress' | 'position' | 'alongside' | 'following'
  speedLimit: number
  candidates: number
}

/** Stable preferences, sampled once per race rather than every steering tick. */
export interface TrafficStyle {
  side: number
  clearance: number
  preparation: number
  cruise?: number
}

const TIMES = [0.25, 0.5, 0.8, 1.15, 1.6, 2.2, 3]
const signedGap = (a: number, b: number, length: number): number =>
  ((a - b + length * 1.5) % length) - length * 0.5
const smooth = (x: number): number => {
  const t = clamp(x, 0, 1)
  return t * t * t * (10 + t * (-15 + 6 * t))
}

/** Cached road coordinates of the supplied lap. No line optimisation at runtime. */
export class RacingRibbon {
  readonly half: Float64Array
  readonly nx: Float64Array
  readonly ny: Float64Array
  readonly roadNx: Float64Array
  readonly roadNy: Float64Array
  constructor(readonly track: Track, readonly reference: RacingLine) {
    const n = reference.x.length
    this.half = new Float64Array(n)
    this.nx = new Float64Array(n)
    this.ny = new Float64Array(n)
    this.roadNx = new Float64Array(n)
    this.roadNy = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const p = track.project(reference.x[i]!, reference.y[i]!)
      this.half[i] = p.half
      const a = (i - 3 + n) % n, b = (i + 3) % n
      const heading = Math.atan2(reference.y[b]! - reference.y[a]!, reference.x[b]! - reference.x[a]!)
      this.nx[i] = -Math.sin(heading)
      this.ny[i] = Math.cos(heading)
      this.roadNx[i] = -Math.sin(p.heading)
      this.roadNy[i] = Math.cos(p.heading)
    }
  }
}

/**
 * A bounded local planner: score reachable corridors, then give the controller
 * one coherent path and its corner speeds. Passing and covering are incentives
 * in that decision, not controllers competing to move the steering wheel.
 * The human lap is immutable. Personal offsets only alter long open straights;
 * the baseline corner geometry and recorded speed profile remain the reference.
 */
export class TrafficPlanner {
  private readonly smartPath: RacingLine
  private readonly pack: PackTrafficPlanner
  private packActive = false
  get path(): RacingLine { return this.packActive ? this.pack.path : this.smartPath }
  readonly decision: TrafficDecision = {
    lane: null, reason: 'clear', speedLimit: Infinity, candidates: 0,
  }
  private station = 0
  private initialized = false
  private offset = 0
  private pressureMemory = 0
  private passTarget: number | null = null
  private passMemory = 0
  private passSide = 0
  private nearMeLateral = 0
  private nearMeSpeed = 0
  private nearMeDeviation = 0
  private playerLane: number | null = null
  private playerSide = 0
  private playerSlot = -1
  private readonly length: number
  private readonly separation: number
  private readonly raw: Float64Array
  private readonly past: Float64Array
  private readonly near: { car: TrafficCar; along: number; drift: number; pace: number; slot: number; station: number; deviation: number }[] = []
  private readonly candidates: (number | null)[] = []

  constructor(
    private readonly ribbon: RacingRibbon,
    readonly reference: RacingLine,
    private readonly params: CarParams,
    private readonly style: TrafficStyle = { side: 0, clearance: 0.65, preparation: 2 },
  ) {
    this.pack = new PackTrafficPlanner(ribbon, reference, params, style)
    this.smartPath = {
      ...reference, x: reference.x.slice(), y: reference.y.slice(),
      offset: reference.offset.slice(), curvature: reference.curvature.slice(),
      speed: reference.speed.slice(),
    }
    this.length = carLength(params)
    this.separation = params.width + Math.max(style.clearance, 0.85)
    this.raw = new Float64Array(reference.x.length)
    this.past = new Float64Array(24)
  }

  update(cars: readonly TrafficCar[], slot: number, racing = true): RacingLine {
    const me = cars[slot]!
    this.nearMeLateral = me.road.lateral
    this.nearMeSpeed = me.speed
    const { reference: ref, ribbon } = this
    const n = ref.x.length
    if (!this.initialized) {
      // A rolling scenario/recovery can start anywhere, not only at station 0.
      let best = Infinity
      for (let i = 0; i < n; i++) {
        const d = (ref.x[i]! - me.state.x) ** 2 + (ref.y[i]! - me.state.y) ** 2
        if (d < best) { best = d; this.station = i }
      }
    } else this.station = nearestStation(ref, me.state.x, me.state.y, this.station)
    const at = this.station
    this.nearMeDeviation = me.road.lateral - ref.offset[at]!
    const edge = Math.max(0, me.road.half - this.params.width / 2 - 0.65)
    this.near.length = 0
    for (let i = 0; i < cars.length; i++) {
      if (i === slot) continue
      const car = cars[i]!
      const along = signedGap(car.road.s, me.road.s, ribbon.track.length)
      if (along < -65 || along > 130) continue
      const angle = wrapAngle(car.state.yaw - car.road.heading)
      const drift = clamp(car.state.vx * Math.sin(angle) + car.state.vy * Math.cos(angle), -3, 3)
      const expected = (at + Math.round(along / (ref.total / n)) + n) % n
      const otherAt = nearestStation(ref, car.state.x, car.state.y, expected)
      this.near.push({ car, along, drift, pace: ref.speed[otherAt]!, slot: i, station: otherAt,
        deviation: car.road.lateral - ref.offset[otherAt]! })
    }

    const player = this.near.find((r) => r.car.player && Math.abs(r.along) < this.length + 3)
    if (player) {
      // Compare the actual bodies in our road frame. Keep an established side
      // until the complete car has cleared; a short nose lead is not clearance.
      const normalX = -Math.sin(me.road.heading), normalY = Math.cos(me.road.heading)
      const beside = (me.state.x - player.car.state.x) * normalX
        + (me.state.y - player.car.state.y) * normalY
      const alongBody = (player.car.state.x - me.state.x) * Math.cos(me.road.heading)
        + (player.car.state.y - me.state.y) * Math.sin(me.road.heading)
      if (this.playerLane === null && Math.abs(alongBody) < this.length - 0.5
        && me.speed > 15 && Math.abs(beside) > this.params.width * 0.6) {
        this.playerSide = Math.sign(beside)
        this.playerSlot = player.slot
        this.playerLane = me.road.lateral
      }
      if (this.playerLane !== null && this.playerSlot === player.slot) {
        const boundary = player.car.road.lateral + player.drift * 0.2
          + this.playerSide * (this.separation + 0.3)
        this.playerLane = clamp(this.playerSide > 0
          ? Math.max(this.playerLane, boundary) : Math.min(this.playerLane, boundary), -edge, edge)
      }
    } else {
      this.playerLane = null
      this.playerSide = 0
      this.playerSlot = -1
    }

    const crowded = this.near.filter((r) => Math.abs(r.along) < 100
      && Math.abs(r.car.road.lateral) < r.car.road.half + 1).length > 1
    if (crowded) {
      if (!this.packActive) this.pack.reset()
      this.packActive = true
      this.passMemory = 0; this.passSide = 0; this.passTarget = null
      const path = this.pack.update(cars, slot, racing)
      Object.assign(this.decision, this.pack.decision)
      return path
    }
    if (this.packActive) this.initialized = false
    this.packActive = false

    // Find the next substantial bend, far enough ahead to prepare BEFORE braking.
    let turn = 0, turnDistance = Infinity, bend = at, distance = 0
    for (let j = 1; j < Math.min(n, 140); j++) {
      const a = (at + j - 1) % n, b = (at + j) % n
      distance += Math.hypot(ref.x[b]! - ref.x[a]!, ref.y[b]! - ref.y[a]!)
      if (distance > Math.max(100, me.speed * 5)) break
      if (Math.abs(ref.curvature[b]!) > 0.009) {
        turn = Math.sign(ref.curvature[b]!); turnDistance = distance; bend = b; break
      }
    }
    const braking = Math.max(0, (me.speed ** 2 - ref.speed[bend]! ** 2)
      / (2 * Math.max(4, longitudinalLimit(this.params, me.speed, 0, ref.commitment, 'brake'))))
    const canPrepare = Math.abs(ref.curvature[at]!) < 0.003
      && turnDistance > braking + me.speed * 0.5
    const preparation = canPrepare ? clamp(1 - Math.abs(turnDistance - braking - me.speed * this.style.preparation)
      / Math.max(60, me.speed * 3), 0, 1) : 0
    const alongside = this.near.some((r) => Math.abs(r.along) < this.length + 1
      && Math.abs(this.nearMeDeviation - r.deviation) > this.params.width * 0.5)
    const closingBehind = this.near.some((r) => r.along < -this.length - 2 && r.along > -60
      && r.car.speed > me.speed + 0.7 && -r.along / (r.car.speed - me.speed) < 9)
    this.pressureMemory = closingBehind ? 20 : Math.max(0, this.pressureMemory - 1)
    const pressure = this.pressureMemory > 0 && this.near.some((r) => r.along < -this.length - 2 && r.along > -60)
    this.near.sort((a, b) => a.along - b.along)
    const opportunity = this.near.find((r) => r.along > this.length + 1
      && r.along < Math.max(45, (r.pace - r.car.speed) * 8)
      && r.pace > r.car.speed + Math.max(0.3, r.pace * 0.006))
    if (opportunity) {
      if (this.passTarget !== opportunity.slot) this.passSide = 0
      this.passTarget = opportunity.slot; this.passMemory = 60
    }
    else this.passMemory = Math.max(0, this.passMemory - 1)
    if (this.passMemory === 0) this.passSide = 0
    const faster = opportunity ?? (this.passMemory > 0
      ? this.near.find((r) => r.slot === this.passTarget && r.along > -this.length - 12 && r.along < 65) : undefined)

    this.candidates.length = 0
    const add = (lane: number | null): void => {
      const value = lane === null ? null : clamp(lane,
        Math.max(-edge, ref.offset[at]! - 4), Math.min(edge, ref.offset[at]! + 4))
      if (!this.candidates.some((v) => v === value || (v !== null && value !== null && Math.abs(v - value) < 0.12))) {
        this.candidates.push(value)
      }
    }
    add(null)
    const previousLane = this.decision.lane === null ? null : ref.offset[at]! + this.offset
    add(previousLane)
    add(me.road.lateral)
    // Road-width samples plus exact gap boundaries avoid a fixed two-line choice.
    for (let k = -4; k <= 4; k++) add(edge * k / 4)
    for (const r of this.near) {
      add(r.car.road.lateral - this.separation)
      add(r.car.road.lateral + this.separation)
    }

    const initial = (this.initialized ? this.path.offset[at]! : me.road.lateral) - ref.offset[at]!
    // Retain the previous path's slope when replanning, so the lane change keeps
    // making progress instead of restarting a zero-slope transition every update.
    const prev = (at - 2 + n) % n, next = (at + 2) % n
    const span = Math.hypot(ref.x[next]! - ref.x[prev]!, ref.y[next]! - ref.y[prev]!)
    const slope = this.initialized
      ? clamp((this.path.offset[next]! - ref.offset[next]! - this.path.offset[prev]! + ref.offset[prev]!) / Math.max(span, 1), -0.13, 0.13)
      : clamp(Math.tan(wrapAngle(me.state.yaw - me.road.heading)), -0.13, 0.13)
    const transitionFor = (lane: number | null): number => Math.max(36, me.speed * Math.max(1.1,
      Math.sqrt(Math.abs((lane === null ? 0 : lane - ref.offset[at]!) - initial) * 5.8 / 9)))
    const latAt = (lane: number | null, d: number, lineLat: number): number => {
      const transition = transitionFor(lane)
      const t = clamp(d / transition, 0, 1)
      // Quintic Hermite, matching the established path's position and direction.
      return lineLat + (1 - smooth(t)) * initial
        + (t - 6 * t ** 3 + 8 * t ** 4 - 3 * t ** 5) * transition * slope
        + smooth(t) * (lane === null ? 0 : lane - ref.offset[at]!)
    }
    // Score the speed of the route we would actually ask the controller to
    // drive. The collision score alone can prefer a gap that requires a sharp
    // crossover through a fast bend, then makePath has to slash its speed.
    // The recorded lap has a demonstrated speed envelope; modelled speed
    // profiles are estimates and can price a shifted route inaccurately.
    // Sample only the next few seconds when traffic offers a choice.
    const routeSamples: { i: number; d: number; x: number; y: number }[] = []
    if (ref.recorded && (faster || alongside || pressure)) {
      let ahead = 0
      for (let k = 0; k < n - 1 && ahead < Math.max(140, me.speed * 3.5); k += 3) {
        const i = (at + k) % n
        if (k) {
          for (let j = k - 3; j < k; j++) {
            const a = (at + j) % n, b = (a + 1) % n
            ahead += Math.hypot(ref.x[b]! - ref.x[a]!, ref.y[b]! - ref.y[a]!)
          }
        }
        routeSamples.push({ i, d: ahead, x: 0, y: 0 })
      }
    }
    const routeTimeLoss = (lane: number | null): number => {
      let loss = 0
      for (const sample of routeSamples) {
        const i = sample.i
        const edgeAt = Math.max(0, ribbon.half[i]! - this.params.width / 2 - 0.65)
        const lat = clamp(latAt(lane, sample.d, ref.offset[i]!),
          Math.min(-edgeAt, ref.offset[i]!), Math.max(edgeAt, ref.offset[i]!))
        const shift = lat - ref.offset[i]!
        sample.x = ref.x[i]! + ribbon.nx[i]! * shift
        sample.y = ref.y[i]! + ribbon.ny[i]! * shift
      }
      for (let k = 1; k < routeSamples.length - 1; k++) {
        const a = routeSamples[k - 1]!, b = routeSamples[k]!, c = routeSamples[k + 1]!
        const ax = b.x - a.x, ay = b.y - a.y, bx = c.x - b.x, by = c.y - b.y
        const changed = 2 * (ax * by - ay * bx) / Math.max(1e-6,
          Math.hypot(ax, ay) * Math.hypot(bx, by) * Math.hypot(ax + bx, ay + by))
        const rx = ref.x[b.i]! - ref.x[a.i]!, ry = ref.y[b.i]! - ref.y[a.i]!
        const sx = ref.x[c.i]! - ref.x[b.i]!, sy = ref.y[c.i]! - ref.y[b.i]!
        const original = 2 * (rx * sy - ry * sx) / Math.max(1e-6,
          Math.hypot(rx, ry) * Math.hypot(sx, sy) * Math.hypot(rx + sx, ry + sy))
        const curvature = ref.curvature[b.i]! + changed - original
        const referenceSpeed = ref.speed[b.i]!
        const demand = Math.max(this.params.mu * (9.81 + this.params.downforceCoef * referenceSpeed ** 2 / this.params.mass) * 0.8,
          referenceSpeed ** 2 * Math.abs(ref.curvature[b.i]!))
        const possible = Math.min(referenceSpeed,
          Math.sqrt(demand / Math.max(Math.abs(curvature), 0.0001)))
        const distance = (c.d - a.d) * 0.5
        loss += distance * (1 / Math.max(8, possible) - 1 / Math.max(8, referenceSpeed))
      }
      return loss
    }
    let best = null as number | null, bestScore = -Infinity
    for (const lane of this.candidates) {
      const dest = lane ?? ref.offset[at]!
      // A committed passing side is a corridor, not a preference to flip at
      // every update. Keep the reference available as the safe abort route.
      if (faster && this.passSide !== 0 && lane !== null
        && (dest - ref.offset[at]!) * this.passSide < 0.25) continue
      let score = -Math.abs(dest - ref.offset[at]!) * 0.35
        - Math.abs(dest - (previousLane ?? ref.offset[at]!)) * 0.85
      // Break near-ties between useful routes. This never overrides collision
      // cost and never changes the recorded lap when there is no traffic.
      if (faster || alongside) score += this.style.side * Math.tanh(dest - ref.offset[at]!)
      if (lane === previousLane) score += faster ? 2 : 0.6
      const cornerLoad = clamp(me.speed ** 2 * Math.abs(ref.curvature[at]!) / 12, 0, 1)
      score -= cornerLoad * Math.abs(dest - (previousLane ?? me.road.lateral)) * 5
      if (routeSamples.length) score -= routeTimeLoss(lane) * 6
      if (pressure && !alongside && !faster && turn !== 0 && racing
        && !this.near.some((r) => r.along < 0 && r.along > -25)) {
        score += preparation * Math.min(turn * dest, 1.5) * 3
      }
      for (const r of this.near) {
        if (Math.abs(r.along) < this.length + 1
          && Math.abs(this.nearMeDeviation - r.deviation) > this.params.width * 0.5) {
          const side = Math.sign(this.nearMeDeviation - r.deviation)
          // Do not plan a crossover just because the speed prediction says
          // overlap will soon end. Wait until the cars have actually cleared.
          const room = side * (dest - r.car.road.lateral)
          score -= Math.max(0, this.separation - room) ** 2 * 250
        }
        // Reward a usable lane past a slower rival even after following has
        // equalised our actual speeds. The reference supplies free-road pace.
        if (r === faster && Math.abs(dest - r.car.road.lateral) >= this.separation - 0.05) score += 9
        for (const t of TIMES) {
          const pace = Math.min(ref.speed[at]!, me.speed + 4 * t)
          const travel = (me.speed + pace) * 0.5 * t
          const along = r.along + r.car.speed * t - travel
          if (Math.abs(along) > this.length + 2) continue
          const future = (at + Math.round(travel / (ref.total / n))) % n
          const futureEdge = Math.max(0, ribbon.half[future]! - this.params.width / 2 - 0.4)
          const lat = clamp(latAt(lane, travel, ref.offset[future]!),
            Math.min(-futureEdge, ref.offset[future]!), Math.max(futureEdge, ref.offset[future]!))
          const otherFuture = (r.station + Math.round(r.car.speed * t / (ref.total / n))) % n
          // Predict the reference's turn-in rather than extrapolating a straight
          // lateral line through a bend. Retain the rival's observed deviation.
          const other = ref.offset[otherFuture]! + r.deviation
          const gap = Math.abs(lat - other)
          const missing = Math.max(0, this.separation - gap)
          score -= missing * missing * 35 / (0.7 + t)
          // A beside car forms a boundary: a target on its far side is not
          // reachable, however attractive the empty space beyond it looks.
          if (Math.abs(r.along) < this.length + 1
            && Math.abs(this.nearMeDeviation - r.deviation) > this.params.width * 0.5
            && (this.nearMeDeviation - r.deviation) * (lat - other) < 0) score -= 1000
        }
      }
      if (score > bestScore) { bestScore = score; best = lane }
    }
    if ((!faster && !alongside && !(pressure && preparation > 0.1)) || (!racing && !alongside)) best = null
    // A small personal straight-line offset breaks the procession without
    // changing corner geometry. Rejoin well before any braking or turn-in.
    if (best === null && !faster && !alongside && !pressure && racing && this.style.cruise) {
      let straight = true, ahead = 0
      for (let j = 0; j < Math.min(n, 100); j++) {
        const i = (at + j) % n, next = (i + 1) % n
        if (Math.abs(ref.curvature[i]!) > 0.002 || ref.speed[i]! < me.speed - 1) { straight = false; break }
        ahead += Math.hypot(ref.x[next]! - ref.x[i]!, ref.y[next]! - ref.y[i]!)
        if (ahead > Math.max(100, me.speed * 3)) break
      }
      if (straight) best = clamp(ref.offset[at]! + this.style.cruise, -edge, edge)
    }
    // An off-road car first needs a reachable route back to the reference.
    if (Math.abs(me.road.lateral) > me.road.half + 0.5) best = null
    if (faster && !alongside && racing && Math.abs(me.road.lateral) <= me.road.half + 0.5) {
      if (this.passSide === 0) this.passSide = turn !== 0 ? -turn
        : Math.sign((best ?? ref.offset[at]!) - ref.offset[at]!) || (this.style.side < 0 ? -1 : 1)
      best = clamp(ref.offset[at]! + faster.deviation + this.passSide * this.separation,
        -edge, edge)
    }
    if (this.playerLane !== null) best = this.playerLane
    this.offset = best === null ? 0 : best - ref.offset[at]!
    this.decision.lane = best
    this.decision.reason = alongside ? 'alongside' : faster ? 'progress'
      : pressure && preparation > 0.1 ? 'position' : 'clear'
    this.decision.candidates = this.candidates.length
    this.makePath(at, best, initial, slope, transitionFor(best), Math.max(160, me.speed * 4.5))
    this.initialized = true
    this.speedLimit(cars, slot)
    return this.path
  }

  /** Fast safety check at physics rate; longitudinal braking only for our corridor. */
  speedLimit(cars: readonly TrafficCar[], slot: number): number {
    if (this.packActive) {
      const limit = this.pack.speedLimit(cars, slot)
      this.decision.speedLimit = limit
      return limit
    }
    const me = cars[slot]!
    let limit = Infinity
    const ref = this.reference
    const n = ref.x.length
    const at = nearestStation(ref, me.state.x, me.state.y, this.station)
    const brake = Math.max(2, longitudinalLimit(this.params, me.speed,
      this.path.curvature[at]!, ref.commitment, 'brake'))
    for (let i = 0; i < cars.length; i++) {
      if (i === slot) continue
      const other = cars[i]!
      const gap = signedGap(other.road.s, me.road.s, this.ribbon.track.length)
      if (other.player && this.playerLane !== null && Math.abs(gap) < this.length + 3) {
        const otherAt = nearestStation(ref, other.state.x, other.state.y,
          (at + Math.round(gap / (ref.total / n)) + n) % n)
        const deviation = other.road.lateral - ref.offset[otherAt]!
        for (let k = 0; k < 16; k++) {
          const future = (otherAt + k) % n
          const edge = this.ribbon.half[future]! - this.params.width * 0.5 - 0.65
          const occupied = ref.offset[future]! + deviation
          const required = occupied + this.playerSide * (this.separation + 0.3)
          if (this.playerSide * required > edge) {
            // There is no legal side corridor farther around this bend.
            // Fall behind early instead of merging into the player's body.
            limit = Math.min(limit, Math.max(0, other.speed - 8))
            break
          }
        }
      }
      if (gap <= 0 || gap > 100) continue
      const t = clamp((gap - this.length) / Math.max(me.speed - other.speed, 1), 0, 2)
      const future = (at + Math.round(me.speed * t / (ref.total / n))) % n
      const angle = wrapAngle(other.state.yaw - other.road.heading)
      const drift = clamp(other.state.vx * Math.sin(angle) + other.state.vy * Math.cos(angle), -3, 3)
      const otherAt = nearestStation(ref, other.state.x, other.state.y,
        (at + Math.round(gap / (ref.total / n))) % n)
      const otherFuture = (otherAt + Math.round(other.speed * t / (ref.total / n))) % n
      const predictedLateral = ref.offset[otherFuture]! + other.road.lateral - ref.offset[otherAt]!
        + drift * Math.min(t, 0.15)
      const actualClear = Math.abs(me.road.lateral - other.road.lateral) >= this.params.width + 0.65
      const plannedClear = Math.abs(this.path.offset[future]! - predictedLateral) >= this.params.width + 0.7
      if (plannedClear && (t > 0.45 || actualClear)) continue
      if (actualClear && gap < this.length + 2) continue
      const room = gap - this.length - 1.5
      const allowed = room > 0 ? Math.sqrt(other.speed ** 2 + 2 * brake * room)
        : Math.max(0, other.speed + room * 2)
      limit = Math.min(limit, allowed)
    }
    this.decision.speedLimit = limit
    return limit
  }

  private makePath(at: number, lane: number | null, initial: number, slope: number,
    transition: number, horizon: number): void {
    const { path, reference: ref, ribbon } = this
    const n = ref.x.length
    // A distant follower or a cosmetic cruising offset is not a manoeuvre.
    // Preserve the known clear-air geometry until a meaningful lateral route
    // or established overlap actually requires traffic-specific path handling.
    const targetOffset = lane === null ? 0 : lane - ref.offset[at]!
    const traffic = this.passMemory > 0 || this.playerLane !== null
      || Math.abs(initial) > 0.4 || Math.abs(targetOffset) > 0.4
      || this.near.some((r) => Math.abs(r.along) < this.length + 14
        && Math.abs(this.nearMeDeviation - r.deviation) > this.params.width * 0.5)
    const nx = traffic ? ribbon.roadNx : ribbon.nx
    const ny = traffic ? ribbon.roadNy : ribbon.ny
    // Keep recent history so geometry across the current station is continuous.
    for (let k = 1; k <= 24; k++) this.past[k - 1] = this.initialized
      ? path.offset[(at - k + n) % n]! : ref.offset[(at - k + n) % n]! + initial
    path.x.set(ref.x); path.y.set(ref.y); path.offset.set(ref.offset)
    path.curvature.set(ref.curvature); path.speed.set(ref.speed)
    const set = (i: number, lateral: number): void => {
      const edge = Math.max(0, ribbon.half[i]! - this.params.width / 2 - 0.65)
      const lo = Math.min(-edge, ref.offset[i]!), hi = Math.max(edge, ref.offset[i]!)
      const band = 1.5
      let lat = lateral
      if (!traffic) lat = clamp(lat, lo, hi)
      else if (Math.abs(lat - ref.offset[i]!) < 0.001) lat = ref.offset[i]!
      else if (lat > hi - band) lat = hi - band + band * Math.tanh((lat - hi + band) / band)
      else if (lat < lo + band) lat = lo + band + band * Math.tanh((lat - lo - band) / band)
      // Once a rival has established overlap (or is about to), reserve its
      // side through the planned bend. Rejoining the nominal line is not safe
      // until longitudinal clearance, even if a prediction ends the overlap.
      for (const r of this.near) {
        const current = this.nearMeDeviation - r.deviation
        if (Math.abs(r.along) > this.length + 14 || Math.abs(current) < this.params.width * 0.5) continue
        // Allocate two legal corridors around a common centre. Pinning one
        // car to the other's nominal apex can otherwise leave no road for it.
        const centreEdge = Math.max(0, edge - this.separation * 0.5)
        const deviation = (this.nearMeLateral - ref.offset[at]! + r.deviation) * 0.5
        const centre = clamp(ref.offset[i]! + deviation, -centreEdge, centreEdge)
        const boundary = r.car.player
          ? ref.offset[i]! + r.deviation + this.playerSide * (this.separation + 0.3)
          : centre + Math.sign(current) * this.separation * 0.5
        const reserved = current > 0 ? Math.max(lat, boundary) : Math.min(lat, boundary)
        const forward = ((i - at + n) % n) * (ref.total / n)
        const influence = 1 - smooth((forward - Math.max(45, this.nearMeSpeed * 1.5)) / 60)
        if (forward < ref.total * 0.5) lat += (reserved - lat) * influence
      }
      lat = clamp(lat, lo, hi)
      const shift = lat - ref.offset[i]!
      path.offset[i] = lat
      path.x[i] = ref.x[i]! + nx[i]! * shift
      path.y[i] = ref.y[i]! + ny[i]! * shift
    }
    for (let k = 1; k <= 24; k++) set((at - k + n) % n, this.past[k - 1]!)
    let d = 0
    for (let k = 0; k < n - 24 && d < horizon + 70; k++) {
      const i = (at + k) % n
      if (k) {
        const j = (i - 1 + n) % n
        d += Math.hypot(ref.x[i]! - ref.x[j]!, ref.y[i]! - ref.y[j]!)
      }
      const t = clamp(d / transition, 0, 1)
      let lat = ref.offset[i]! + (1 - smooth(t)) * initial
        + (t - 6 * t ** 3 + 8 * t ** 4 - 3 * t ** 5) * transition * slope
        + smooth(t) * (lane === null ? 0 : lane - ref.offset[at]!)
      if (this.playerLane !== null) lat = (1 - smooth(t)) * (ref.offset[i]! + initial)
        + (t - 6 * t ** 3 + 8 * t ** 4 - 3 * t ** 5) * transition * slope
        + smooth(t) * (ref.offset[i]! + this.playerLane - ref.offset[at]!)
      set(i, lat + (ref.offset[i]! - lat) * smooth((d - horizon) / 70))
    }
    for (let i = 0; i < n; i++) {
      const span = traffic ? 2 : 1
      const a = (i - span + n) % n, c = (i + span) % n
      const ax = path.x[i]! - path.x[a]!, ay = path.y[i]! - path.y[a]!
      const bx = path.x[c]! - path.x[i]!, by = path.y[c]! - path.y[i]!
      this.raw[i] = 2 * (ax * by - ay * bx) / Math.max(1e-6,
        Math.hypot(ax, ay) * Math.hypot(bx, by) * Math.hypot(ax + bx, ay + by))
    }
    for (let i = 0; i < n; i++) {
      if (Math.abs(path.offset[i]! - ref.offset[i]!) < 0.01) continue
      let k = 0
      for (let j = -2; j <= 2; j++) k += this.raw[(i + j + n) % n]!
      k /= 5
      path.curvature[i] = k
      // Preserve the driven lap's demonstrated lateral demand. A tighter path
      // gets a lower corner speed; a wider path never invents extra grip.
      const demand = Math.max(traffic
        ? this.params.mu * (9.81 + this.params.downforceCoef * ref.speed[i]! ** 2 / this.params.mass) * 0.8
        : this.params.mu * 9.81 * 0.75, ref.speed[i]! ** 2 * Math.abs(ref.curvature[i]!))
      path.speed[i] = Math.min(ref.speed[i]!, Math.sqrt(demand / Math.max(Math.abs(k), 0.0001)))
    }
  }
}


