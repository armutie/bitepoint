/**
 * A driver that follows a racing line, and a search for the lap it can hold.
 *
 * The point of this is that it does NOT estimate a lap time. `buildRacingLine`
 * produces a target speed from a model of the car — axle by axle, but still a
 * model, and one with no tyre curve and no transient — and if that number were
 * reported as a lap time it would be a lap time for a car that does not quite
 * exist. Instead the target is driven through the real simulation, and the
 * answer is whatever the physics allows.
 *
 * `fastestLap` then does the only honest thing available: it walks commitment
 * up until the car can no longer keep the lap clean, and reports the quickest
 * lap that stayed on the road. That is a real lower bound on the car's pace,
 * driven by the same `TimeAttackSim` a player drives, timed by the same clock,
 * and voided by the same rule.
 */
import { wheelbase, type CarParams } from './carParams'
import { currentDriveForce, type CarState } from './car'
import { clamp, wrapAngle } from './math'
import {
  atCommitment, buildRacingLine, longitudinalLimit, nearestStation,
  pedalFor, type RacingLine,
} from './racingLine'
import { steerFor, steeringFor, type SteerTable } from './steering'
import { TimeAttackSim, type CompletedLap } from './sim'
import type { Track } from './track'

/**
 * The driver's habits, as numbers.
 *
 * Mutable so `followerTune` can sweep them — nothing in the game writes to it.
 * `npx vite-node src/dev/followerTune.ts [key]` walks one knob at a time over
 * two circuits and reports what each value is worth, which is the only reason
 * to believe any of these numbers over the first guess they started as.
 */
/**
 * Which feedforward the follower uses. Separate from `TUNING` on purpose —
 * that object is swept as numbers, and a boolean in it breaks the sweep.
 */
export const FEEDFORWARD = { useTable: true }

/** Most a car may move off its line — beyond this it is not racing, it is lost. */
const OFFSET_LIMIT = 6

/** How fast the offset may change, m/s. A car changes lane, it does not teleport. */
const OFFSET_RATE = 3

export const TUNING = {
  /**
   * Fraction of the available braking a corner must demand before the brakes
   * go on. Below this the car stays on the throttle: the corner is still far
   * enough away that it can be dealt with later, and dealing with it now is
   * the lift that used to cost the lap.
   */
  brakeAt: 0.85,
  /**
   * Correction on the controller's estimate of how hard it can brake.
   *
   * The estimate comes from the same derived model the plan uses, and measured
   * against the car that model is 13% PESSIMISTIC on braking — it thinks 2.03 g
   * where the car does 2.32 g. Urgency is the required deceleration over the
   * available one, so understating the denominator overstates every corner:
   * the car brakes earlier than it needs to, and brakes at all for corners that
   * did not need it. That is most of what "it brakes for corners that do not
   * need braking" looks like from the cockpit.
   *
   * A single number here rather than a table because the error is remarkably
   * flat with speed — 12 to 16% across the whole range. The principled version
   * is to hand the controller the measured ggv, which is a bigger change.
   *
   * LEFT AT 1.0, and the reason is worth recording. Correcting the pessimism
   * makes three of four circuits quicker — Ashford 50.80 to 50.43 — and
   * Elvington Mile a second and a half SLOWER, because braking later there
   * costs it the commitment it was holding and `fastestLap` settles lower. The
   * aggregate is worse, so the knob stays at 1 until the thing that makes
   * Elvington fragile is understood rather than compensated for.
   */
  brakeTrust: 1.0,
  /** Metres over which the car closes on the profile when it is off it. */
  trimDist: 18,
  /** Slip ratio tolerated before lifting (the tyre peaks near 0.16). */
  spinAllow: 0.08,
  /** How hard they lift past it, per unit of excess slip. */
  spinGain: 5.0,
  /** Body slip at which catching the slide starts to take over from following. */
  slideStart: 0.09,
  /** And where it has taken over completely (rad, ~23 degrees). */
  slideFull: 0.40,
  /**
   * Stations either side that the tangent and the curvature are averaged over.
   *
   * Three stations is about nine metres each way — a car length and a bit,
   * which is the scale a car can actually respond on. See the note where it is
   * used: reading the line raw made the steering saw thirty-five times a second.
   */
  geometrySmooth: 3,
  /**
   * Metres ahead the feedforward reads its curvature.
   *
   * A DISTANCE and not a time, because the swept answer is "as little as
   * possible" and a time-based one hid that: with a 2 m floor every value below
   * 0.05 s came out identical, so the sweep was comparing three copies of the
   * same number. One station is the shortest this can express, and it wins —
   * 50.53 s against 51.35 s on Ashford at twice the distance.
   */
  previewDist: 0,
  /**
   * Extra preview as a TIME, so lookahead grows with speed.
   *
   * A fixed 3 m is 0.14 s at 80 km/h and 0.05 s at 220, which is backwards:
   * the faster the car, the further ahead it needs to be looking. Measured at
   * the tightest corner on Croft Bay the car arrived at the right speed, within
   * 2 km/h, and still ran 0.9 m wide — the radius collapses from 73 m to 26 m in
   * fifteen metres of travel and the steering simply had not started.
   */
  previewTime: 0,
  /** Road-wheel angle bled off per radian/second of yaw rate. */
  yawDamp: 0.05,
  /**
   * Extra road-wheel angle per m/s² of cornering — the understeer gradient.
   *
   * `atan(L * k)` is the Ackermann angle: what a car with no tyre slip would
   * need. Real tyres slip, and this car is built to slip more at the front than
   * the rear — `rearGripBias` gives the rear 25% more grip — so it needs extra
   * lock in proportion to how hard it is cornering. Measured on steady corners
   * at 0.00161 rad per m/s², which at 2 g is 1.8 degrees.
   *
   * Supplying none of it did not look like a mistake, it looked like a HOME:
   * the car sat 1.2-1.5 m OUTSIDE the line through every corner, 97% of the
   * error being steady bias rather than wobble, and then ran out of road at a
   * commitment it could otherwise have held.
   *
   * SET BY SWEEP, NOT BY THE MEASUREMENT, and the gap is the interesting part.
   * The steady-state gradient measures 0.00161 and rises to 0.0029 near the
   * limit; swept against driven laps the best value is 0.0055, better than the
   * measured one by 3.4 s across four circuits. The extra is not steady-state
   * work — it is transient. A tyre builds its slip angle over a relaxation
   * length, so a corner needs more lock on the way in than it needs once
   * settled, and a feedforward with no memory can only pay for that by running
   * rich everywhere.
   *
   * It is a real optimum rather than a ceiling: 0.007 loses twelve seconds,
   * because past here the car turns in more than the corner asked for.
   */
  understeer: 0.0055,
  /** Extra lock while a corner is being ENTERED, on top of the measured table. */
  transientLead: 0.0039,
  /** Road-wheel angle per radian of heading error against the line's tangent. */
  headGain: 1.2,
  /** Cross-track gain, in the Stanley sense: metres of error per metre/second. */
  crossGain: 3.0,
  /**
   * HOW MUCH BEING OFF THE LINE MATTERS, as a function of what is coming.
   *
   * `crossGain` was one number everywhere, so a car a metre off line on a
   * 250 km/h straight hauled itself back as hard as one a metre off mid-corner.
   * That is the wrong priority. On a straight the line barely matters and the
   * correction costs speed; what matters is arriving at the NEXT corner on it.
   *
   * So the gain scales with the sharpest corner within `urgencyTime` seconds of
   * travel: full authority when a corner is imminent, `urgencyFloor` of it when
   * the road ahead is straight.
   *
   * The floor is 0.6 and not lower, which was measured rather than chosen. On
   * tarmac a lazier car does keep more speed after being displaced, but only
   * 2-3 km/h at a seven-metre shove — a small prize. What a lazier car also
   * does is take longer to get off the GRASS after a big one: shoved thirteen
   * metres, a floor of 0.35 spent 4.32 s off the road against 2.20 s at full
   * urgency, while 0.6 spent 2.38 s. Most of the benefit, almost none of the
   * loitering.
   */
  urgencyTime: 2.2,
  /** Curvature at which the line matters completely (1/m). */
  urgencyFull: 0.008,
  /** Share of the gain that applies even with nothing ahead. */
  urgencyFloor: 0.6,
  /** Share of the computed cornering limit a planned corner speed may use. */
  planMargin: 0.9,
}

/**
 * The point on the line nearest to (x, y), searching the two segments that meet
 * at `station`.
 *
 * Returns a point that moves continuously as the car does, which the nearest
 * STATION does not: that one steps three metres at a time, and the distance to
 * it steps with it.
 */
function closestOnSegments(
  line: RacingLine, station: number, x: number, y: number,
): { x: number; y: number; from: number; t: number } {
  const n = line.x.length
  let best = { x: line.x[station]!, y: line.y[station]!, d2: Infinity, from: station, t: 0 }
  for (const from of [(station - 1 + n) % n, station]) {
    const to = (from + 1) % n
    const ax = line.x[from]!
    const ay = line.y[from]!
    const dx = line.x[to]! - ax
    const dy = line.y[to]! - ay
    const len2 = dx * dx + dy * dy
    // A degenerate segment has no direction to project onto; its own endpoint
    // is the closest thing it has to offer.
    const t = len2 > 1e-9 ? clamp(((x - ax) * dx + (y - ay) * dy) / len2, 0, 1) : 0
    const px = ax + dx * t
    const py = ay + dy * t
    const d2 = (px - x) ** 2 + (py - y) ** 2
    if (d2 < best.d2) best = { x: px, y: py, d2, from, t }
  }
  return { x: best.x, y: best.y, from: best.from, t: best.t }
}

/** Direction of the line at station `i`, averaged over `span` either side. */
function tangentAt(line: RacingLine, i: number, span: number): number {
  const n = line.x.length
  // A tangent needs two distinct points, so a span of zero still spans one.
  const w = Math.max(span, 1)
  const a = (i - w + n * 2) % n
  const b = (i + w) % n
  return Math.atan2(line.y[b]! - line.y[a]!, line.x[b]! - line.x[a]!)
}

/** Mean curvature around station `i`, over `span` either side. */
function curvatureAt(line: RacingLine, i: number, span: number): number {
  const n = line.x.length
  let sum = 0
  for (let d = -span; d <= span; d++) sum += line.curvature[(i + d + n * 2) % n]!
  return sum / (2 * span + 1)
}

export interface LapAttempt {
  lap: CompletedLap | null
  commitment: number
  /** Furthest the car ever got from the line it was following (m). */
  maxLineError: number
}

export interface ReferenceLap {
  /** Null when the car could not hold a clean lap at any commitment. */
  time: number | null
  commitment: number
  maxLineError: number
}

/**
 * The controller's working, for a debug view. See `traceFollower`.
 *
 * Populated only when `LineFollower.trace` is set, because a lap is 3600 ticks
 * and nothing in the game wants the allocation.
 */
export interface FollowerTrace {
  feedforward: number
  heading: number
  lineTerm: number
  yawDamp: number
  slide: number
  lineError: number
  /** Metres of road left between the line and the edge at this station. */
  room: number
  aReq: number
  aBrake: number
  aTrim: number
  blend: number
  lookahead: number
}

/**
 * The controller, as a thing that can be stepped from outside.
 *
 * Split out of `driveLine` so the same driver can run inside the game's own
 * loop — which is what "watch" is. A lap you spectate has to be genuinely
 * driven rather than replayed, or the camera is following a recording and every
 * bump, every bit of understeer and every correction is missing.
 *
 * FOUR JOBS, and the useful thing to know is that they are separate:
 *
 *   AIM      pure pursuit at a point on the line, with a lookahead that is
 *            floored against how far off the line the car currently is.
 *   TURN     a feedforward for the corner the car is IN, so feedback is left
 *            correcting what remains instead of doing the whole job.
 *   PACE     a brake POINT rather than a running deceleration demand: stay flat
 *            until a corner ahead needs most of the braking there is, then use
 *            it, and close back onto the profile whenever the car is under it.
 *   CATCH    once the rear is gone, stop trying to drive the line and put the
 *            front wheels where the car is actually travelling.
 *
 * Measured, going from the previous version to this one on three circuits:
 *
 *     circuit        was              now
 *     balanced_8     59.17 s @0.84    55.37 s @0.91
 *     technical_8    80.33 s @0.46    50.83 s @1.03
 *     power_8        no clean lap     59.97 s @1.03
 *
 * The commitments matter as much as the times. The old controller could only
 * hold a plan drawn at half the car's grip, so `commitment` was measuring the
 * DRIVER and every conclusion about the car drawn through it was wrong by
 * whatever the driver was losing.
 */
export class LineFollower {
  private station = 0
  private located = false
  maxLineError = 0
  /** Set once the out-lap is done, so the dive onto the line is not counted. */
  flying = false
  /** Set to an object to have the controller's working written into it. */
  trace: FollowerTrace | null = null
  /**
   * An external ceiling on target speed, in m/s — traffic ahead of this car.
   *
   * Applied where the plan's own speeds are read rather than as a separate
   * controller, so the brake-point search treats a slower car exactly as it
   * treats a slow corner: it stays flat until the limit is close enough to
   * need the brakes, then uses them. Infinity means the road is clear.
   */
  speedLimit = Infinity
  /**
   * Whether the car is currently off the road. Set by whoever owns the sim.
   *
   * Being lazy about rejoining the line is right on tarmac and wrong on grass:
   * there is no lap time out there, the grip is a fraction of the road's, and
   * every metre spent is a metre spent badly. So this overrides the urgency
   * scaling entirely — off the road, getting back on IS the priority.
   */
  offTrack = false
  /**
   * Work out the speed for each corner from the car's own grip, rather than
   * reading it from the plan.
   *
   * The plan's speeds are a CEILING: a car tracking them can never arrive
   * anywhere faster than the reference expected, so a performance advantage is
   * invisible — measured, a car with thirty percent less drag ran 232 km/h
   * beside one doing 232 km/h and could not use a metre of it. Worse, the case
   * worth handling — turning up at a corner too quickly and having to cope —
   * cannot arise, because nothing ever exceeds the plan.
   *
   * With this on the plan becomes a REFERENCE rather than a limit. Its corner
   * speeds still bind, because a human drove them and they are known to work;
   * what goes is the term that hauls the car back down to the stored number on
   * a straight. A car with a tow or less drag can then be quicker than the lap
   * it learned from, and has to brake earlier for arriving that way.
   */
  planSpeed = false
  /**
   * Metres to drive to the side of the line, positive to the left of travel.
   *
   * Set by the racecraft layer. The follower does not decide to overtake; it
   * only knows how to drive a line, and this moves the line.
   */
  lateralOffset = 0
  /**
   * Metres this driver misjudges each braking point by, per station. Positive
   * brakes early. Null is a perfect driver, which no field should be made of.
   */
  brakeBias: Float64Array | null = null
  /** What has actually been reached, since the target is approached at a rate. */
  private appliedOffset = 0

  constructor(
    private readonly p: CarParams,
    private line: RacingLine,
    /** Measured steering response. Defaults to this car's own, measured once. */
    private readonly steerTable: SteerTable | null = steeringFor(p),
  ) {}

  /** Swap the line without losing where on it the car is. */
  setLine(line: RacingLine): void {
    this.line = line
  }

  next(s: CarState): { steer: number; pedal: number } {
    const line = this.line
    const n = line.x.length
    if (!this.located) {
      let best = Infinity
      for (let i = 0; i < n; i++) {
        const d = (line.x[i]! - s.x) ** 2 + (line.y[i]! - s.y) ** 2
        if (d < best) { best = d; this.station = i }
      }
      this.located = true
    }
    this.station = nearestStation(line, s.x, s.y, this.station)
    const station = this.station

    // ROAD speed, not forward speed, everywhere a speed is compared with the
    // profile. The profile's targets are speeds along the path, and `vx` is
    // only that when the car is pointing where it is going: at 30 degrees of
    // body slip it reads 13% low, at 60 degrees it halves. The old law read
    // that as "behind the target" and answered with more throttle — into the
    // slide that caused it. Traced at commitment 0.90 the car reached 90
    // degrees of slip with the pedal still at 1.00, which is that loop closing.
    const v = Math.hypot(s.vx, s.vy)
    /** Body slip: the angle between where the nose points and where it goes. */
    const beta = Math.atan2(s.vy, Math.max(Math.abs(s.vx), 0.5))

    // HOW FAR OFF THE LINE — measured to the line, not to a point on it.
    //
    // This used to be the distance to the nearest STATION. Stations are three
    // metres apart and at 180 km/h the car covers most of one per tick, so the
    // nearest one changes every few ticks and the distance to it JUMPS when it
    // does. That sawtooth went straight into the cross-track term, and it was
    // the single noisiest thing in the controller: the wheel changed direction
    // thirty-five times a second, sawing a tenth of full lock every tick, while
    // the car crossed the line only twice a second. It is not a small effect
    // either — the term is divided by the steering lock, which at speed is a
    // third of its low-speed value, so a jump is amplified fivefold on its way
    // to the wheel.
    //
    // Projecting onto the SEGMENT is continuous by construction. Both the
    // segment ahead of the nearest station and the one behind it are tried,
    // because which of the two actually holds the foot of the perpendicular
    // depends on where in its three metres the car currently is.
    const foot = closestOnSegments(line, station, s.x, s.y)
    // RACING OFF THE LINE. The target is the line shifted sideways, so a car
    // can pull out of a tow or cover an inside without needing a second line
    // to follow. Rate-limited rather than applied instantly: a step in the
    // target is a step in the cross-track term, and that goes to the wheel.
    const want = clamp(this.lateralOffset, -OFFSET_LIMIT, OFFSET_LIMIT)
    const move = clamp(want - this.appliedOffset, -OFFSET_RATE / 60, OFFSET_RATE / 60)
    this.appliedOffset += move
    const nx = -Math.sin(tangentAt(line, foot.from, TUNING.geometrySmooth))
    const ny = Math.cos(tangentAt(line, foot.from, TUNING.geometrySmooth))
    const errX = foot.x + nx * this.appliedOffset - s.x
    const errY = foot.y + ny * this.appliedOffset - s.y
    const lineError = Math.hypot(errX, errY)
    if (this.flying) this.maxLineError = Math.max(this.maxLineError, lineError)
    const side = Math.sign(errX * -Math.sin(s.yaw) + errY * Math.cos(s.yaw))

    // The corner the car is IN, for the feedforward — which is not the corner
    // it would be aiming at. On the way into a tightening corner the point
    // further down the road is already at a smaller radius than the car has
    // reached, so a feedforward taken from there winds on the lock for a corner
    // that has not arrived: the car turns in early and cuts. One station.
    let curveAt = station
    let previewed = 0
    const preview = TUNING.previewDist + TUNING.previewTime * v
    while (previewed < preview) {
      const next = (curveAt + 1) % n
      previewed += Math.hypot(line.x[next]! - line.x[curveAt]!, line.y[next]! - line.y[curveAt]!)
      curveAt = next
    }

    // FEEDFORWARD: the steering the corner needs, before any error exists.
    //
    // Pure pursuit is pure feedback — it only turns once it is already wide, so
    // through a long corner it runs a standing error proportional to how fast
    // the corner is. The bicycle model says a corner of curvature k needs a
    // road-wheel angle of atan(L*k); giving that up front leaves feedback to
    // correct what is left instead of doing the whole job.
    const speed = this.p.steerUsesRoadSpeed ? v : Math.abs(s.vx)
    const scale = 1 - (1 - this.p.highSpeedSteer) * Math.min(speed / this.p.steerSpeedRef, 1)
    const lock = Math.max(this.p.maxSteer * scale, 1e-6)

    // WHERE THE LINE GOES, and how far off it the car is — separately.
    //
    // This used to aim at a point some distance ahead on the line and steer at
    // the bearing to it. Pure pursuit, and the lookahead distance had to serve
    // two masters that cannot both be satisfied on a hairpin: long enough that
    // the geometry stays well posed when the car is off the line, short enough
    // that the aim point does not sit round the far side of the apex. Both
    // failures were traced, on the same kind of corner:
    //
    //   too short   Croft Bay, 5.7 m of lookahead against 3.3 m of error. The
    //               aim point sits nearly abeam, the bearing to it swings with
    //               every metre, and the heading term inverted exactly when it
    //               was needed to pull the car back.
    //   too long    Thruxton Vale, a 15 m hairpin with the lookahead floored at
    //               10.4 m by the error. That is 40 degrees round the arc, so
    //               the car steers at the chord, cuts the apex, and goes off the
    //               INSIDE — and the error that caused it grows the floor that
    //               caused it.
    //
    // Splitting the signal removes the dilemma, because neither half needs a
    // lookahead. Heading is measured against the line's own TANGENT, and being
    // off the line is a separate cross-track term whose gain falls with speed —
    // the standard Stanley form, which is stable at a metre and at ten.
    // BOTH GEOMETRY TERMS ARE SMOOTHED AND INTERPOLATED, and neither is cosmetic.
    //
    // SMOOTHED because the line is sampled every three metres and the lap-time
    // optimiser leaves that sampling noisy — ninety curvature sign changes
    // round Ashford against eighteen for the minimum-curvature seed, since a
    // small wiggle costs the point-mass model almost nothing to add.
    //
    // INTERPOLATED because smoothing alone does not help: the window is centred
    // on the nearest STATION, and that index steps by one every few ticks at
    // speed, so the whole window jumps and the answer jumps with it. Measured,
    // the heading term still changed direction thirty times a second after
    // smoothing, and the wheel with it. Sliding the window continuously along
    // the segment the car is actually on removes the step.
    //
    // It matters more than it sounds: both terms are divided by the steering
    // lock, which at speed is a third of its low-speed value, so a jump is
    // amplified fivefold on its way to the wheel.
    const span = TUNING.geometrySmooth
    const t0 = tangentAt(line, foot.from, span)
    const t1 = tangentAt(line, (foot.from + 1) % n, span)
    const tangent = t0 + wrapAngle(t1 - t0) * foot.t
    const curveHere =
      curvatureAt(line, curveAt, span) * (1 - foot.t)
      + curvatureAt(line, (curveAt + 1) % n, span) * foot.t
    const headErr = wrapAngle(tangent - s.yaw)
    const cross = side * Math.min(lineError, 6)
    // As a ROAD-WHEEL ANGLE throughout, then normalised once: mixing normalised
    // and unnormalised gains is how the old version ended up with a heading
    // gain of "2.0" that meant nothing in particular.
    // The corner's own lateral demand, signed the way it turns.
    const ayDemand = v * v * curveHere
    // THE FEEDFORWARD, measured rather than derived where a table is available.
    //
    // `atan(L*k) + K*ay` is the linear bicycle model, and the car's steering
    // response bends over and flattens instead. Fitted against the car, that
    // formula is 18-256% out depending on where you are on the curve; the
    // measured table is inside 5% until the front saturates. And a feedforward
    // error does not stay a feedforward error — proportional feedback can only
    // cancel it by holding a STANDING offset, which is why the car sat 1.80 m
    // to one side of the start/finish corner for its whole length without ever
    // crossing the line, and why `commitment` had to give up 4.7 s to keep it
    // on the road.
    // TWO JOBS, and the old single constant was doing both badly.
    //
    // `understeer: 0.0055` is 3.4x this car's measured steady-state gradient of
    // 0.00161. That excess was never a mis-tune — it was paying for TRANSIENT
    // work, getting the car turned in, which a feedforward with no memory
    // cannot otherwise buy. Swapping in an exact steady-state inverse and
    // nothing else therefore fixed the first job and deleted the second: the
    // static table is inside 5% where the formula was 18-256% out, and tracking
    // still got WORSE, median 0.95 m to 1.18 m.
    //
    // So separate them. The table answers "what holds this radius", measured;
    // `transientLead` answers "what gets us there", and being the only thing
    // left for a constant to do, it is now a constant with one meaning.
    const feed = this.steerTable && FEEDFORWARD.useTable
      ? Math.sign(curveHere) * steerFor(this.steerTable, v, curveHere)
        + (TUNING.transientLead * ayDemand) / lock
      : (Math.atan(wheelbase(this.p) * curveHere) + TUNING.understeer * ayDemand) / lock
    // The sharpest corner within a couple of seconds' travel, which is what
    // decides whether being off the line is a problem yet.
    let soon = Math.abs(curveHere)
    let seen = 0
    let peek = station
    const reachFor = v * TUNING.urgencyTime
    while (seen < reachFor) {
      const next = (peek + 1) % n
      seen += Math.hypot(line.x[next]! - line.x[peek]!, line.y[next]! - line.y[peek]!)
      peek = next
      soon = Math.max(soon, Math.abs(line.curvature[peek]!))
    }
    // On the grass, the line is not a preference. Nothing ahead matters more
    // than being back on the road, so the scaling is skipped rather than
    // softened — there is no version of "take your time" that applies here.
    const urgency = this.offTrack ? 1
      : TUNING.urgencyFloor
        + (1 - TUNING.urgencyFloor) * Math.min(1, soon / TUNING.urgencyFull)
    const crossTerm = Math.atan2(TUNING.crossGain * urgency * cross, Math.max(v, 4))
    const track = feed + (headErr * TUNING.headGain + crossTerm) / lock

    // CATCHING A SLIDE is a different job, and doing both at once does neither.
    //
    // Once the rear is gone, the terms above are actively wrong: the
    // feedforward keeps winding on the lock the corner wants, and the
    // line-error term keeps pulling toward a line the car cannot currently
    // reach, and between them they hold the steering into a slide that needs
    // the opposite. The recovery is the textbook one — put the front wheels
    // where the car is actually travelling, which is `beta` of lock — and it
    // takes over smoothly as the slip angle grows so that a car merely on the
    // edge still drives the line.
    const slide = clamp((Math.abs(beta) - TUNING.slideStart) / (TUNING.slideFull - TUNING.slideStart), 0, 1)
    const steer = clamp(
      track * (1 - slide) + clamp(beta / lock, -1, 1) * slide - (s.r * TUNING.yawDamp) / lock,
      -1, 1,
    )
    if (this.trace) {
      this.trace.feedforward = feed
      this.trace.heading = (headErr * TUNING.headGain) / lock
      this.trace.lineTerm = crossTerm / lock
      this.trace.yawDamp = -(s.r * TUNING.yawDamp) / lock
      this.trace.slide = slide
      this.trace.lineError = lineError
      this.trace.lookahead = 0
    }

    // The pedal decides a BRAKE POINT rather than running a deceleration.
    //
    // The previous law asked every point within forty metres what constant
    // deceleration from here would arrive at its target, and took the hardest
    // answer. That is the right sum and the wrong thing to do with it: a corner
    // forty metres away that wants a gentle 2 m/s^2 gets that 2 m/s^2 applied
    // NOW, so the car lifts half a second early and trickles into every braking
    // zone. Traced, it ran the pedal at 0.16-0.26 while sitting four to eight
    // metres a second BELOW its own target speed — slow, and slow in a way no
    // amount of commitment could fix, because the profile was never the thing
    // holding it back.
    //
    // What a driver actually does is leave the throttle alone until the corner
    // needs everything the brakes have, then use all of them. So the question
    // is not "what deceleration does that point want" but "how does what it
    // wants compare to what I have": `urgency` is the required deceleration as
    // a fraction of the available one, and it only means brake when it
    // approaches 1. A distant corner scores near zero and is ignored until it
    // is close, which is what makes it safe to look a long way ahead — and
    // looking a long way ahead is necessary, because from 290 km/h the braking
    // distance alone is over a hundred metres and the old forty-metre horizon
    // could not see the corner until it was far too late.
    //
    // The available deceleration comes from `longitudinalLimit`, at the line's
    // own commitment, so the controller and the profile cannot disagree about
    // how much stopping there is.
    /**
     * What this corner may be taken at.
     *
     * The PLAN's speed, always — a human drove it, so it is known to work, and
     * the computed alternative is about twenty percent optimistic because
     * `corneringSpeed` assumes every scrap of grip is available laterally when
     * a real corner is also braking, accelerating and changing direction.
     * Replacing the plan with computed caps was tried: only valid at a 0.82
     * margin, and five seconds a lap slower.
     *
     * So the corner limits stay. What changes with `planSpeed` is that the car
     * is no longer dragged DOWN to the plan on a straight — see `target` below.
     */
    const capAt = (i: number): number => line.speed[i]!

    const curvature = line.curvature[station]!
    const aBrake =
      longitudinalLimit(this.p, v, curvature, line.commitment, 'brake') * TUNING.brakeTrust
    const horizon = clamp((v * v) / (2 * Math.max(aBrake, 0.5)) * 1.3 + 15, 20, 400)
    let aReq = 0
    let reach = 0
    let scan = station
    while (reach < horizon) {
      const next = (scan + 1) % n
      reach += Math.hypot(line.x[next]! - line.x[scan]!, line.y[next]! - line.y[scan]!)
      scan = next
      const vt = Math.min(capAt(scan), this.speedLimit)
      // The driver's own misjudgement of this braking point: pretend the corner
      // is nearer than it is and the brakes come on early, further and they
      // come on late. Applied to the DISTANCE rather than to the speed, because
      // what a driver gets wrong is where to start, not how hard to press.
      const bias = this.brakeBias ? this.brakeBias[scan]! : 0
      if (vt < v) {
        aReq = Math.max(aReq, (v * v - vt * vt) / (2 * Math.max(reach - bias, 1)))
      }
    }

    // FEEDFORWARD, then a correction — and the order matters.
    //
    // This used to be the correction alone: an acceleration proportional to how
    // far under the target speed the car was. That is a pure proportional
    // controller chasing a moving setpoint, and it has the steady-state error
    // every such controller has. Down a straight the profile's target climbs
    // every metre, so the car settles at whatever gap makes the correction
    // equal the plan's own acceleration and then holds that gap for the rest of
    // the lap. Measured, it sat 8 km/h under target for 84% of a lap while
    // sitting a metre from the line with grip to spare — the geometry was
    // right, the speed never was.
    //
    // The plan already knows the answer. `v dv/ds` between two stations IS the
    // acceleration the profile is asking for, so ask for that first and let the
    // error term correct what is left over.
    const nextStation = (station + 1) % n
    const ds = Math.max(
      Math.hypot(
        line.x[nextStation]! - line.x[station]!,
        line.y[nextStation]! - line.y[station]!,
      ),
      1e-3,
    )
    const here = Math.min(capAt(station), this.speedLimit)
    const next = Math.min(capAt(nextStation), this.speedLimit)
    // ACCELERATION ONLY. The profile's own deceleration must not be fed
    // forward, because braking already has an authority — the brake-point
    // search above, whose whole purpose is to stay flat until the corner really
    // needs the brakes. Feeding the plan's deceleration in as well double-counts
    // it: measured, braking ticks went from 7% of the lap to 29% and the lap
    // got a second slower. The plan's job here is to say how hard to pull, and
    // the brake point's job is to say when to stop pulling.
    const aPlan = Number.isFinite(here) && Number.isFinite(next)
      ? Math.max(0, (next * next - here * here) / (2 * ds))
      : 0
    // NEVER ASK THE CAR TO SLOW DOWN HERE. Braking has its own authority — the
    // brake-point search above, which stops for corners the car genuinely
    // cannot take. This term's job is to pull toward the plan, and a plan is a
    // reference rather than a limit: a car with a tow, a slipstream or less
    // drag can be quicker down a straight than the lap it learned from, and
    // dragging it back to the stored number is the ceiling that made a
    // thirty-percent drag advantage worth exactly nothing.
    const wanted = Math.min(capAt((station + 2) % n), this.speedLimit)
    // ONCE THE REFERENCE IS REACHED, GO.
    //
    // Asking for the plan's own acceleration is right while catching it up and
    // wrong once level with it: near the top of a straight the plan is barely
    // accelerating, so a car that has caught it coasts there. That is the last
    // piece of the ceiling — with it in place a thirty-percent drag advantage
    // produced exactly the same 249 km/h as the car it was chasing.
    //
    // Braking is not being given away by this. It has its own authority in the
    // brake-point search above, which stops for the corners the plan says are
    // coming, and a car that arrives faster simply has to start earlier.
    //
    // Only where the PLAN IS ALREADY FLAT OUT, which is the test for "this is a
    // straight" that cannot disagree with the plan about what a straight is.
    // Without that clause it fired mid-corner too, and a car going flat through
    // a corner the plan deliberately part-throttles is off the road: 545
    // off-track ticks a lap.
    const flatHere = line.pedal[station]! > 0.95
    const aTrim = this.planSpeed && flatHere && v >= wanted - 0.2
      ? 99
      : Number.isFinite(wanted)
        ? aPlan + (wanted * wanted - v * v) / (2 * TUNING.trimDist)
        : 4

    // Blend rather than latch, and that is measured rather than assumed.
    //
    // The blend oscillates — braking removes the urgency that justified it, the
    // mixture slides back toward throttle, and the urgency returns — which
    // shows up as 110 brake applications for 14 corners. Latching it with a
    // Schmitt trigger does fix the count, and it was SLOWER: 2.6 s worse across
    // four circuits at its own best release threshold, because a latch cannot
    // feed a little throttle back in through a long corner and a blend can.
    // The modulation looks untidy and is doing useful work.
    const blend = clamp(
      (aReq / Math.max(aBrake, 0.5) - TUNING.brakeAt) / Math.max(1 - TUNING.brakeAt, 0.05),
      0, 1,
    )
    const aCmd = aTrim * (1 - blend) + -aReq * blend
    let pedal = clamp(pedalFor(this.p, v, aCmd, currentDriveForce(this.p, s)), -1, 1)

    // Past the tyre's slip peak the throttle makes smoke rather than thrust,
    // and it spends the lateral grip the corner is using to do it. The car has
    // traction control of its own, but the preset's speed taper has released
    // most of the way to free-spin by the time it matters — traced at
    // commitment 0.90 the rear was turning 20 m/s faster than the road with the
    // pedal still pinned. A driver does not do that; they feel it and lift.
    if (pedal > 0) {
      const slip = (s.wheelVr - s.vx) / Math.max(Math.abs(s.vx), 3)
      if (slip > TUNING.spinAllow) pedal *= clamp(1 - (slip - TUNING.spinAllow) * TUNING.spinGain, 0, 1)
    }
    if (this.trace) {
      this.trace.aReq = aReq
      this.trace.aBrake = aBrake
      this.trace.aTrim = aTrim
      this.trace.blend = blend
    }

    return { steer, pedal }
  }
}

/**
 * Drive an out-lap, then a flying lap, at a fixed commitment.
 *
 * The out-lap is not a nicety. The car is staged on the CENTRELINE twelve
 * metres before the line, and the racing line at that point can be six metres
 * to one side — so the first thing the controller does is dive across the road
 * to reach it, mid-way through the timed lap it just started. On a fast circuit
 * that costs a little time; on a stop-and-go one it costs the lap, which is why
 * Croft Bay could not be lapped at any commitment at all before this. Every
 * real reference lap is a flying one.
 */
export function driveLine(
  track: Track, p: CarParams, trackId: string, line: RacingLine,
): LapAttempt {
  const sim = new TimeAttackSim(track, p, trackId, 'reference')
  const follower = new LineFollower(p, line)
  let lapsDone = 0

  for (let i = 0; i < 60 * 60 * 10; i++) {
    follower.offTrack = sim.offTrack
    const { steer, pedal } = follower.next(sim.car.s)
    const r = sim.step(steer, pedal)
    if (r.lapCompleted && lapsDone++ > 0) {
      return { lap: r.lapCompleted, commitment: 0, maxLineError: follower.maxLineError }
    }
    if (lapsDone > 0) follower.flying = true
  }
  return { lap: null, commitment: 0, maxLineError: follower.maxLineError }
}

/**
 * Everything a development view wants: the line, the lap, and the path driven.
 *
 * The path is the lap's own `path` — the same pose stream a player's lap
 * records — so it plays back through exactly the machinery the menu's attract
 * field already uses. Watching the reference driver is then the same act as
 * watching a recorded lap, which is the point: if the driver is doing something
 * daft, it is visible rather than inferred from a number.
 */
export function referenceLapDetail(
  track: Track, p: CarParams, trackId: string, prebuilt?: RacingLine,
): { line: RacingLine; time: number | null; commitment: number; path: Float64Array | null } {
  // The SEARCH is the half-minute, not the driving: `fastestLap` runs a dozen
  // simulated laps and they cost milliseconds each. So a caller that already
  // has the shape — from a baked file — gets the whole thing effectively
  // instantly, and only a circuit with no bake pays for the search.
  const shape = prebuilt ?? buildRacingLine(track, p)
  const best = fastestLap(track, p, trackId, shape)
  if (best.time === null) return { line: shape, time: null, commitment: 0, path: null }
  const line = atCommitment(shape, p, best.commitment)
  const { lap } = driveLine(track, p, trackId, line)
  return {
    line,
    time: best.time,
    commitment: best.commitment,
    path: lap ? lap.path : null,
  }
}

export function fastestLap(
  track: Track, p: CarParams, trackId: string, prebuilt?: RacingLine,
): ReferenceLap {
  let best: ReferenceLap | null = null
  const keep = (v: ReferenceLap): void => {
    if (!best || v.time! < best.time!) best = v
  }

  // Optimised once. See `atCommitment` — the shape barely moves with grip, and
  // re-optimising per attempt made the search a dozen times its own cost.
  const shape = prebuilt ?? buildRacingLine(track, p)

  const attempt = (commitment: number): boolean => {
    const line = atCommitment(shape, p, commitment)
    const { lap, maxLineError } = driveLine(track, p, trackId, line)
    if (!lap || !lap.valid) return false
    keep({ time: lap.time, commitment, maxLineError })
    return true
  }

  let lo = 0.35
  let hi = 0.35
  // Past 1.0 deliberately: 1.0 is this model's estimate of the limit, not the
  // car's, and the simulation regularly holds more than the model expects.
  for (const c of [0.4, 0.55, 0.7, 0.85, 0.95, 1.05, 1.15, 1.25, 1.35]) {
    if (attempt(c)) lo = c
    else { hi = c; break }
  }
  // Bisect the gap between the last lap that held and the first that did not.
  if (hi > lo) {
    for (let i = 0; i < 4; i++) {
      const mid = (lo + hi) / 2
      if (attempt(mid)) lo = mid
      else hi = mid
    }
  }

  return best ?? { time: null, commitment: 0, maxLineError: 0 }
}
