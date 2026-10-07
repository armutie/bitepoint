/**
 * A racing line, and the speed profile to drive it — the reference driver.
 *
 * The tests used to compare cars with a centreline follower, which cannot
 * answer the question they were asked. A car that stays in the middle of the
 * road never uses the width, so it never rewards a setup for cornering: it
 * turns the difference between a high-downforce trim and a low-drag one into
 * noise, and it makes every circuit feel like a series of arcs rather than a
 * lap with an entry, an apex and an exit. Any conclusion drawn from it about
 * which car is faster is a conclusion about which car is better at driving down
 * the middle.
 *
 * So this builds a line and a target speed for it, and a controller follows
 * them through the real simulation. Nothing here estimates a lap time: the
 * speed profile is a TARGET, the physics decides what actually happens, and the
 * lap time comes out of the same timing code a player's lap does.
 *
 * Three stages:
 *
 *   1. SEED. Minimum-curvature path by constrained relaxation — pull each point
 *      toward the midpoint of its neighbours and clamp it back inside the road.
 *      Taut, quick to find, and a good starting guess.
 *
 *   2. SPEED. What the car can actually carry along a given line, on a FRICTION
 *      BUDGET: grip is one circle shared between cornering and braking or
 *      driving, so a corner does not get full braking as well. Then a backward
 *      pass for braking and a forward pass for power, both spending only what
 *      the corner leaves. The backward pass is what makes braking zones — a
 *      slow corner reaches back up the straight and pulls the speed down early.
 *
 *   3. LAP TIME. The seed is then optimised against the clock rather than
 *      against curvature, which is the part that makes the line belong to the
 *      CAR. Minimum curvature is car-agnostic: it cannot know that an engine
 *      with more to give wants the exit straightened so it can use it sooner,
 *      or that stronger brakes are worth a later, deeper entry, or that a wing
 *      makes a wider entry pay where it would not otherwise. Scoring on time,
 *      with power, braking and traction all inside the score, gets all of that
 *      for free instead of encoding any of it as a rule.
 *
 * KNOWN LIMIT, measured rather than assumed: converged, this produces a line
 * worth 56.80 s on Croft Bay where a human drove 53.70 s over the same road.
 * The speed profile is not the problem — run it along the human's own recorded
 * path and it returns 53.65 s against their 53.70, which is as close as this
 * kind of model gets. The 3.1 s is the GEOMETRY: coordinate descent on one bump
 * at a time plateaus, because a faster line often needs two corners moved
 * together and no single bump improves the score on its own.
 *
 * It is still an approximation of the car: one circle, no load transfer, no
 * per-axle split, no tyre curve. It does not have to be exact, because it only
 * produces a TARGET — `commitment` scales the whole budget, and the search in
 * `fastestLap` walks it up until the real simulation can no longer hold the
 * lap. Roughly right and then measured beats precisely wrong.
 */
import { wheelbase, type CarParams } from './carParams'
import { ggvAt, type Ggv } from './ggv'
import { G, peakDriveForce } from './car'
import type { Track } from './track'

/** Metres between stations. Fine enough to resolve an apex, coarse enough to relax fast. */
const STATION = 3.0

/**
 * Stations either side that curvature is averaged over — about a car length.
 *
 * See `smoothCurvature`. Two is 15 m of arc, which resolves any corner a car
 * can actually take while rejecting the three-metre noise that the Menger
 * estimate manufactures.
 */
const CURVATURE_SMOOTH = 2

/**
 * Stations either side the OFFSETS are averaged over before anything uses them.
 *
 * Two is a six-metre window — under two car lengths, so it cannot round off a
 * real apex, and more than enough to remove a zigzag at the optimiser's own
 * step size.
 */
const OFFSET_SMOOTH = 2

/**
 * How much of the road the car may actually use, as a margin off each edge.
 *
 * The sim voids a lap on the CENTRE point leaving the road, so the geometric
 * limit is `half + OFF_TRACK_MARGIN`. Driving to that is driving to the void
 * threshold, which no reference lap should do — this keeps a car's width in
 * hand so the line is one a player could hold.
 *
 * WAS 1.4, which on an 8 m half-width threw away a fifth of the road. A human
 * lap on Croft Bay uses 55% of the available half-width where the generated
 * line used 46%, and swept over three circuits 0.6 m is worth 3.35 s against
 * 1.4 m — quicker on every one of them, not just the one that prompted it.
 *
 * The margin is not free safety, though: this plus `OFF_TRACK_MARGIN` is the
 * entire budget the follower has for being off its line before the lap is
 * voided. `fastestLap` protects a time trial automatically by backing the
 * commitment off until laps come back clean, but a RACE runs at a fixed
 * commitment with other cars leaning on it, so this is the number to raise
 * first if the field starts throwing laps away.
 */
const EDGE_MARGIN = 0.6

export interface RacingLine {
  /** World-space points of the line, closed (last joins first). */
  x: Float64Array
  y: Float64Array
  /** Lateral offset from the centreline at each station (m, +left). */
  offset: Float64Array
  /** Curvature of the line at each station (1/m). */
  curvature: Float64Array
  /** Target speed at each station (m/s). */
  speed: Float64Array
  /**
   * The pedal to hold at each station: +1 full throttle, -1 full brake.
   *
   * This is the part that makes it a PLAN rather than a target. Given only a
   * speed to chase, a controller has to notice it is going too fast and react —
   * and a proportional reaction overshoots, lifts, overshoots again, so the car
   * arrives at a corner having braked in half a dozen stabs. It looks wrong
   * because it is wrong: a fast lap has one brake application per corner,
   * squeezed on hard and bled off into the apex, decided before the corner
   * rather than discovered during it.
   *
   * So the profile works out what force each metre of the lap actually needs —
   * from how much speed has to change over it, plus the drag and rolling
   * resistance being fought — and turns that into the pedal that delivers it.
   * The controller then holds this and only trims, which is what a driver does.
   */
  pedal: Float64Array
  /** Distance along the LINE at each station (m). */
  dist: Float64Array
  total: number
  /**
   * The grip fraction these speeds were built at.
   *
   * Carried on the line because the CONTROLLER needs it. Asked how late it can
   * leave the brakes, it has to get the same answer the profile got, and the
   * profile's answer was scaled by this — a driver working from the car's full
   * grip while following a plan drawn at 80% of it brakes later than the plan
   * expects, every corner.
   */
  commitment: number
  /**
   * Reference speeds from a lap that was actually DRIVEN, if this line came
   * from one.
   *
   * When present these replace the modelled speed profile entirely, and
   * `commitment` scales them instead of scaling grip. That is a different and
   * much stronger claim than a plan makes: a modelled speed is what the car
   * ought to manage, a recorded one is what it did. Nothing has to be predicted,
   * so no part of the grip model can be wrong about it.
   */
  recorded?: Float64Array
  /**
   * The measured envelope this line was planned against, if any.
   *
   * Carried on the line rather than passed by every caller. `atCommitment`
   * rebuilds the speed profile for each driver in a race, and if it silently
   * fell back to the derived model there, the shape would have been found under
   * one set of limits and driven under another — the two disagree by 2-6%, so
   * that is a whole commitment step of error introduced by a missing argument.
   */
  ggv?: Ggv
}

export interface LineOptions {
  /**
   * Fraction of the grip the speed profile asks for. 1.0 is the model's own
   * estimate of the limit; the search in `fastestLap` walks this up until the
   * car can no longer hold the lap.
   */
  commitment?: number
  /** Relaxation sweeps for the seed. 600 converges to well under a centimetre. */
  iterations?: number
  /**
   * Rounds of lap-time optimisation over the seed. 0 leaves the minimum-
   * curvature line, which is what a car-agnostic tool would give you.
   *
   * Defaults to 16, which is where this converges. It was 3, chosen for no
   * reason, and measured on Croft Bay that cost 4.6 s a lap:
   *
   *     rounds   0      3      8     16     24     32
   *     lap     65.66  61.40  57.28  56.80  56.80  56.80
   *
   * Every setup comparison made at 3 rounds was therefore made over a line 4.6 s
   * off the pace. Later rounds are nearly free — the bump width shrinks with the
   * round number — so almost all of the ~18 s build is spent in the first few.
   */
  optimise?: number
  /** Metres kept in hand off each painted edge. Overrides EDGE_MARGIN. */
  edgeMargin?: number
  /** Start the optimiser from these offsets instead of a computed seed. */
  seed?: Float64Array
  /**
   * These offsets have ALREADY been smoothed — use them as the line itself.
   *
   * `geometry` smooths the offsets it is given, and returns the smoothed ones
   * as `offset`, because those are the line its points and curvature describe.
   * Feed that result back in and it gets smoothed a second time, which is a
   * different, flatter line than the one that was optimised — measured on Croft
   * Bay at **321 mm** of drift and **1.77 s** of model lap. Since a baked file
   * stores exactly that returned `offset`, every race was driving a line nobody
   * had scored.
   */
  presmoothed?: boolean
  /**
   * Which line the search starts from.
   *
   * `curvature` is the minimum-curvature relaxation this has always used. It
   * makes a smooth line by SPREADING the bend out, which is exactly the wrong
   * shape for a lap: measured on Ashford the resulting plan is cornering-grip
   * limited for 75% of the lap and brakes for 24% of it, where a human on the
   * same circuit and car brakes for 4% and is flat out 81%. A line that is
   * always bending is a car that is always at its lateral limit, and a car at
   * its lateral limit has nothing left to accelerate or brake with.
   *
   * `shortest` is the taut string through the corridor — straight where it can
   * be, bending only where the road forces it. Higher peak curvature, but the
   * curvature is CONCENTRATED, which is what leaves straights to be flat out on
   * and corners short enough to be worth braking for.
   */
  seedMode?: 'curvature' | 'shortest'
  /**
   * A measured g-g-V diagram to plan against, instead of the derived model.
   *
   * Optional so every existing caller keeps the behaviour it was written and
   * tested against; supplied, the profile stops computing what the car can do
   * and looks it up. See `ggv.ts` for why that matters — the derived model is
   * 5% optimistic cornering and 13% pessimistic braking, and those signs are
   * opposite, so no single commitment can correct both.
   */
  ggv?: Ggv
}

/**
 * One trial of the search, handed out as it happens.
 *
 * The optimiser is otherwise a fifteen-second black box that reports a number,
 * and a number cannot tell you whether it stopped because it had found the line
 * or because it had run out of moves it was allowed to make. Watching it is the
 * difference — see `line-lab.html`.
 */
export interface LineProgress {
  stage: 'seed' | 'optimise' | 'done'
  round: number
  /** Station the trial bump is centred on. */
  centre: number
  /** Half-width of the bump, in stations. */
  width: number
  /** Amplitude of the bump at its centre (m). */
  step: number
  /** Which way this trial pushed: +1 left, -1 right. */
  dir: number
  /** Whether the lap got quicker, and the change was kept. */
  accepted: boolean
  /** Trials run and trials kept, so far, over the whole search. */
  trials: number
  kept: number
  /** Model lap time of the line as it now stands (s). */
  lapTime: number
  /**
   * The LIVE offsets — not a copy, for the obvious reason that copying a
   * thousand doubles thirty thousand times would cost more than the search.
   * Read it during the yield; do not keep it.
   */
  offset: Float64Array
}

/**
 * Build the line and its speed profile for one car on one circuit.
 *
 * The line depends only on the road; the speeds depend on the car. They are
 * built together because a caller always wants both, and separating them
 * invites using a line from one car with the speeds of another.
 */
export function buildRacingLine(
  track: Track, p: CarParams, opts: LineOptions = {},
): RacingLine {
  const steps = buildRacingLineSteps(track, p, opts)
  let r = steps.next()
  while (!r.done) r = steps.next()
  return r.value
}

/**
 * The same build, one trial at a time.
 *
 * `buildRacingLine` drains this and is the only thing the game calls; the
 * generator exists so a debug view can step the search and paint between
 * trials. Yielding costs about a tenth of a microsecond against an evaluation
 * that costs tens, so the two paths are the same search at the same speed.
 */
export function* buildRacingLineSteps(
  track: Track, p: CarParams, opts: LineOptions = {},
): Generator<LineProgress, RacingLine> {
  const commitment = opts.commitment ?? 1.0
  const presmoothed = opts.presmoothed ?? false
  const iterations = opts.iterations ?? 600
  const n = Math.max(32, Math.round(track.length / STATION))

  // Centreline stations, and the room either side of each.
  const cx = new Float64Array(n)
  const cy = new Float64Array(n)
  const nx = new Float64Array(n)
  const ny = new Float64Array(n)
  const room = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const s = (i / n) * track.length
    const pose = track.poseAt(s)
    cx[i] = pose.x
    cy[i] = pose.y
    // Left normal, matching the sim's sign convention for lateral offset.
    nx[i] = -Math.sin(pose.yaw)
    ny[i] = Math.cos(pose.yaw)
    room[i] = Math.max(0, track.halfAt(s) - (opts.edgeMargin ?? EDGE_MARGIN))
  }

  // --- 1. geometry -------------------------------------------------------
  //
  // Laplacian relaxation, clamped to the road. Each sweep moves a point a
  // fraction of the way to the midpoint of its neighbours, which is gradient
  // descent on discrete curvature; the clamp is what turns "straight line" into
  // "straightest line that fits". Under-relaxed at 0.35 because a full step
  // oscillates on a hairpin, where the midpoint is outside the road on both
  // sides in turn.
  const offset = new Float64Array(n)
  if (opts.seed && opts.seed.length === n) {
    for (let i = 0; i < n; i++) {
      offset[i] = Math.max(-room[i]!, Math.min(room[i]!, opts.seed[i]!))
    }
  }
  const shortest = (opts.seedMode ?? 'curvature') === 'shortest'
  for (let pass = 0; pass < (opts.seed ? 0 : iterations); pass++) {
    for (let i = 0; i < n; i++) {
      const a = (i + n - 1) % n
      const b = (i + 1) % n
      const ax = cx[a]! + nx[a]! * offset[a]!
      const ay = cy[a]! + ny[a]! * offset[a]!
      const bx = cx[b]! + nx[b]! * offset[b]!
      const by = cy[b]! + ny[b]! * offset[b]!
      const px = cx[i]! + nx[i]! * offset[i]!
      const py = cy[i]! + ny[i]! * offset[i]!
      let next: number
      if (shortest) {
        // SHORTEST PATH: gradient descent on total length. Moving a point
        // changes the two segments it joins, and the derivative of their
        // combined length along this station's normal is the difference of the
        // two unit tangents projected onto it. A taut string, in other words —
        // it goes straight until the road stops it.
        const d1x = px - ax
        const d1y = py - ay
        const d2x = bx - px
        const d2y = by - py
        const l1 = Math.hypot(d1x, d1y) || 1
        const l2 = Math.hypot(d2x, d2y) || 1
        const grad =
          ((d1x / l1) - (d2x / l2)) * nx[i]! + ((d1y / l1) - (d2y / l2)) * ny[i]!
        // The step is in metres of offset; the gradient is dimensionless, so
        // scale it by the station spacing to keep the two commensurate.
        next = offset[i]! - grad * STATION * 0.5
      } else {
        // The midpoint of the neighbours, expressed as an offset along THIS
        // station's normal — the only direction this point is allowed to move.
        const mx = (ax + bx) / 2 - cx[i]!
        const my = (ay + by) / 2 - cy[i]!
        const want = mx * nx[i]! + my * ny[i]!
        next = offset[i]! + (want - offset[i]!) * 0.35
      }
      offset[i] = Math.max(-room[i]!, Math.min(room[i]!, next))
    }
    // Once a pass rather than once a station: the relaxation is a whole-lap
    // move and a half-updated ring is not a line anyone wants to look at.
    yield {
      stage: 'seed', round: pass, centre: 0, width: 0, step: 0, dir: 0,
      accepted: true, trials: 0, kept: 0, lapTime: 0, offset,
    }
  }

  // --- 3. lap time -------------------------------------------------------
  //
  // Coordinate descent on smooth bumps. Each trial slides a raised-cosine
  // window of stations to one side and keeps the change only if the lap got
  // quicker. Bumps rather than single points because a line is driven, not
  // sampled: moving one station makes a kink the car cannot use and the
  // curvature estimate cannot see past, while a window twenty metres wide is
  // the scale a corner is actually taken on.
  //
  // Width shrinks over the rounds — a coarse pass finds the apex, finer passes
  // trim entry and exit — and the step shrinks with it.
  const rounds = opts.optimise ?? 16
  const ggv = opts.ggv
  let best = evaluate(cx, cy, nx, ny, offset, p, commitment, ggv)
  const trial = new Float64Array(n)
  let trials = 0
  let kept = 0
  for (let round = 0; round < rounds; round++) {
    const width = Math.max(3, Math.round((n / 24) / (round + 1)))
    const step = Math.max(0.15, 1.2 / (round + 1))
    for (let centre = 0; centre < n; centre++) {
      for (const dir of [1, -1]) {
        trial.set(offset)
        for (let d = -width; d <= width; d++) {
          const i = (centre + d + n * 2) % n
          // Raised cosine: full move at the centre, nothing at the edges, so
          // the window blends into the line instead of stepping out of it.
          const w = 0.5 * (1 + Math.cos((Math.PI * d) / (width + 1)))
          trial[i] = Math.max(-room[i]!, Math.min(room[i]!, trial[i]! + dir * step * w))
        }
        const t = evaluate(cx, cy, nx, ny, trial, p, commitment, ggv)
        trials++
        const accepted = t < best
        if (accepted) {
          best = t
          kept++
          offset.set(trial)
        }
        yield {
          stage: 'optimise', round, centre, width, step, dir,
          accepted, trials, kept, lapTime: best, offset,
        }
      }
    }
  }

  const line = geometry(cx, cy, nx, ny, offset, p, commitment, ggv, presmoothed)
  yield {
    stage: 'done', round: rounds, centre: 0, width: 0, step: 0, dir: 0,
    accepted: false, trials, kept, lapTime: best, offset,
  }
  return line
}

/** The finished line for a set of offsets: points, curvature, spacing, speeds. */
function geometry(
  cx: Float64Array, cy: Float64Array, nx: Float64Array, ny: Float64Array,
  offset: Float64Array, p: CarParams, commitment: number, ggv?: Ggv,
  presmoothed = false,
): RacingLine {
  const n = offset.length
  // SMOOTH THE LINE ITSELF, not just the measurement of it.
  //
  // Smoothing the curvature estimate alone was tried first and did almost
  // nothing: the kinks are real geometry, sitting in the offsets, and blurring
  // the number you read off them leaves the line just as bent. The optimiser
  // puts them there — its minimum step is 15 cm over a bump three stations
  // wide, and 18 cm of zigzag between adjacent stations IS a 50 m corner.
  //
  // Smoothing here rather than at the end is the important part: the search
  // scores what `geometry` returns, so a kink that survives to the answer must
  // first have earned its place in the score. Smoothed here, it cannot — a
  // wiggle the car could never drive stops being worth anything to add.
  let line: Float64Array
  if (presmoothed) {
    line = offset
  } else {
    line = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let d = -OFFSET_SMOOTH; d <= OFFSET_SMOOTH; d++) {
        sum += offset[(i + d + n * 2) % n]!
      }
      line[i] = sum / (2 * OFFSET_SMOOTH + 1)
    }
  }
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    x[i] = cx[i]! + nx[i]! * line[i]!
    y[i] = cy[i]! + ny[i]! * line[i]!
  }

  // Curvature from the circle through each point and its neighbours, and the
  // spacing of the line itself — which is not the centreline's, because a line
  // that cuts a corner is shorter through it and longer round the outside.
  const curvature = new Float64Array(n)
  const seg = new Float64Array(n)
  const dist = new Float64Array(n)
  let total = 0
  for (let i = 0; i < n; i++) {
    const b = (i + 1) % n
    seg[i] = Math.hypot(x[b]! - x[i]!, y[b]! - y[i]!)
  }
  for (let i = 0; i < n; i++) {
    dist[i] = total
    total += seg[i]!
    curvature[i] = menger(
      x[(i + n - 1) % n]!, y[(i + n - 1) % n]!, x[i]!, y[i]!,
      x[(i + 1) % n]!, y[(i + 1) % n]!,
    )
  }

  // SMOOTH THE CURVATURE BEFORE ANYTHING BELIEVES IT.
  //
  // Menger curvature through three points three metres apart is a difference of
  // nearly-equal quantities, and it is violently sensitive: eighteen
  // centimetres of zigzag between adjacent stations reads as a 50 m corner. The
  // optimiser's own minimum step is fifteen centimetres, so it can leave wiggles
  // at exactly that scale — and measured on Croft Bay it does, on 23% of the
  // lap, producing line radii of 49-59 m on road that is dead straight.
  //
  // The speed profile then does the obvious thing and brakes for them. That is
  // the plan slowing to 84 km/h at a place a human takes at 216, and it is most
  // of what "it brakes where it does not need to" looks like from the cockpit.
  //
  // A car cannot drive a 3 m wavelength anyway — it is shorter than the
  // wheelbase — so averaging over about a car length throws away only signal
  // that was never real.
  smoothCurvature(curvature)
  const speed = speedProfile(curvature, seg, p, commitment, ggv)
  const pedal = pedalPlan(speed, seg, p)
  return {
    // The SMOOTHED offsets, because those are the line these points, this
    // curvature and these speeds all describe. Returning the raw ones would
    // hand the caller a line that disagrees with its own geometry.
    x, y, offset: line, curvature, speed, pedal, dist, total, commitment,
    ...(ggv ? { ggv } : {}),
  }
}

/**
 * Lap time along a finished line — the optimiser's own answer.
 *
 * This is the number a racing-line tool reports: the profile integrated, in the
 * model the profile was built in. It is not a simulated lap and does not claim
 * to be one; the model has one friction circle, no load transfer, no tyre curve
 * and no gearbox. What it IS good for is comparing two setups over the same
 * road, because both are measured by the same ruler.
 */
export function modelLapTime(line: RacingLine): number {
  const n = line.speed.length
  let t = 0
  for (let i = 0; i < n; i++) {
    const b = (i + 1) % n
    const seg = b === 0 ? line.total - line.dist[i]! : line.dist[b]! - line.dist[i]!
    t += (2 * seg) / Math.max(line.speed[i]! + line.speed[b]!, 1e-3)
  }
  return t
}

/** Lap time for a set of offsets — the objective the optimiser minimises. */
function evaluate(
  cx: Float64Array, cy: Float64Array, nx: Float64Array, ny: Float64Array,
  offset: Float64Array, p: CarParams, commitment: number, ggv?: Ggv,
): number {
  const line = geometry(cx, cy, nx, ny, offset, p, commitment, ggv)
  let t = 0
  for (let i = 0; i < line.speed.length; i++) {
    const b = (i + 1) % line.speed.length
    const seg = i + 1 < line.speed.length ? line.dist[b]! - line.dist[i]! : line.total - line.dist[i]!
    // Trapezoidal in speed rather than ds/v at a point: on a braking zone the
    // two differ by enough to change which line wins.
    t += (2 * seg) / Math.max(line.speed[i]! + line.speed[b]!, 1e-3)
  }
  return t
}

/**
 * The speed the car can carry along this line, on one shared friction budget.
 *
 * This is the part that makes the line belong to the car rather than to the
 * road. Cornering, braking and driving all come out of the same circle: a
 * corner taken at the limit has nothing left for the brakes, so the profile
 * cannot brake at the apex, which is why the line wants to be straight where it
 * is slowing and why an exit worth straightening gets straightened.
 */
function speedProfile(
  curvature: Float64Array, seg: Float64Array, p: CarParams, commitment: number,
  ggv?: Ggv,
): Float64Array {
  const n = curvature.length
  const g = gripModel(p, commitment)
  const speed = new Float64Array(n)
  for (let i = 0; i < n; i++) speed[i] = corneringSpeed(p, curvature[i]!, commitment, ggv)

  // Sweeps alternate backward, forward, and there are FIVE of them rather than
  // the four this used to run. Two things were wrong with four, and both
  // produced a plan asking for braking the car does not have — measured at 143
  // stations across five circuits, up to 16.6x on Croft Bay. See
  // `dev/profileAudit.ts`, which exists to keep this honest.
  //
  //   1. NaN SILENTLY SKIPS THE CONSTRAINT. `corneringSpeed` is legitimately
  //      Infinity wherever downforce outgrows the corner, `longitudinal` hands
  //      back NaN when asked what a car doing Infinity can brake at, and
  //      `NaN < speed[i]` is FALSE — so the station kept a speed nothing had
  //      checked. Not an error, not a warning, just a missing constraint. The
  //      guards below ask about a neighbour's speed instead.
  //
  //   2. IT ENDED ON A FORWARD SWEEP. A forward sweep may LOWER a station, and
  //      lowering station i+1 makes the braking demand at station i harder than
  //      it was when that demand was last checked. Ending on braking is what
  //      makes the profile's last word a promise the car can keep.
  //
  // Together those left Croft Bay planning 68.23 m/s at one station and
  // 23.32 m/s three metres later — 678 m/s², about 69 g.
  for (let pass = 0; pass < 5; pass++) {
    if (pass % 2 === 1) {
      // Forward: what the engine can add between two points.
      for (let k = 0; k < n; k++) {
        const i = k % n
        const a = (i + n - 1) % n
        const from = Number.isFinite(speed[a]!) ? speed[a]! : speed[i]!
        const acc = longitudinal(p, g, from, curvature[a]!, commitment, 'drive', ggv)
        const reach = Math.sqrt(from * from + 2 * acc * seg[a]!)
        if (reach < speed[i]!) speed[i] = reach
      }
      continue
    }
    // Backward: what you must already be doing to make the corner ahead.
    for (let k = n; k > 0; k--) {
      const i = (k - 1) % n
      const b = (i + 1) % n
      const at = Number.isFinite(speed[i]!) ? speed[i]! : speed[b]!
      const a = longitudinal(p, g, at, curvature[i]!, commitment, 'brake', ggv)
      const reach = Math.sqrt(speed[b]! * speed[b]! + 2 * a * seg[i]!)
      if (reach < speed[i]!) speed[i] = reach
    }
  }
  return speed
}

/**
 * Everything about a car's grip that does not change along the lap.
 *
 * Built once per speed profile rather than per station. The profile calls
 * `longitudinal` four times per station and the build evaluates thirty thousand
 * profiles, so a division left inside the loop is a division done a hundred
 * million times — recomputing the wheelbase and the reference loads on every
 * call measurably lengthened the build before this was hoisted.
 */
interface GripModel {
  /** Static axle loads (N). */
  aF: number; aR: number
  /** Aero coefficient per axle, so load = a + b v². */
  bF: number; bR: number
  /** Reference loads the load-sensitivity curve is measured against. */
  fz0F: number; fz0R: number
  /** Share of the lateral force each axle is asked for, from yaw balance. */
  shareF: number; shareR: number
  /** Load transferred per unit of longitudinal acceleration (N per m/s²). */
  transfer: number
  mu: number
  loadSens: number
  rearBias: number
}

function gripModel(p: CarParams, commitment: number): GripModel {
  const wb = wheelbase(p)
  const aF = (p.mass * G * p.lr) / wb
  const aR = (p.mass * G * p.lf) / wb
  return {
    aF, aR,
    bF: p.downforceCoef * (1 - p.aeroRearBias),
    bR: p.downforceCoef * p.aeroRearBias,
    fz0F: p.fzRefScale * aF,
    fz0R: p.fzRefScale * aR,
    shareF: p.lr / wb,
    shareR: p.lf / wb,
    transfer: (p.mass * p.hCg) / wb,
    mu: p.mu * commitment,
    loadSens: p.muLoadSens,
    rearBias: p.rearGripBias,
  }
}

/** Peak friction at a load, with the tyre load sensitivity the car models. */
function axleMu(g: GripModel, fz: number, fz0: number): number {
  if (g.loadSens === 0) return g.mu
  return g.mu * Math.max(0.1, 1 - g.loadSens * (fz / fz0 - 1))
}

/**
 * How hard this car can brake or drive right now, given what it is cornering.
 *
 * The controller has to answer the same question the profile answered — how
 * late can the brakes wait — and it has to get the same answer, or it brakes at
 * a point the plan did not plan for. So it asks this rather than carrying its
 * own idea of how much stopping there is, the way `pedalFor` is already shared
 * so the two cannot disagree about what a pedal position means.
 */
/**
 * The envelope the planner should actually use: measured sideways, modelled forwards.
 *
 * Measuring the whole envelope was the obvious thing and it was measured to be
 * wrong. The two axes are not equally trustworthy:
 *
 *   ay        a steady state, and it cross-checks against an independent
 *             closed-loop skidpad to within 3% from 54 to 198 km/h. The formula
 *             it replaces is 2-6% optimistic, consistently, in one direction.
 *   axDrive   a band average, which folds a gearchange and the traction limit
 *             into every speed. Honest about what the car averages, and the
 *             wrong number for a plan: the profile then asks for an exit that is
 *             slower than the car can actually manage from a corner, everywhere.
 *
 * Measured on Croft Bay, planning against the whole measured envelope drove
 * 57.867 s; measured lateral with the modelled longitudinal drove 56.550 and
 * predicted itself to within 0.058 s. So take the column that was checked and
 * leave the one that was not.
 *
 * The ellipse exponent is kept from the measurement — it is 3.0 rather than the
 * circle the formula assumes, so the car combines braking and cornering rather
 * better than the derived model believes.
 */
export function planningEnvelope(p: CarParams, measured: Ggv): Ggv {
  const muScale = new Float64Array(measured.v.length)
  for (let i = 0; i < measured.v.length; i++) {
    const v = measured.v[i]!
    // What the DERIVED model thinks it has here, by inverting its own
    // cornering speed: find the curvature it would take at exactly v.
    let lo = 1e-7
    let hi = 1
    for (let k = 0; k < 60; k++) {
      const mid = 0.5 * (lo + hi)
      if (corneringSpeed(p, mid, 1) > v) lo = mid
      else hi = mid
    }
    const derivedAy = v * v * lo
    // How much of the model's LATERAL capability is real. Not a change to the
    // tyre's total grip — see `longitudinal`, which applies it to the cornering
    // term alone. At 36 km/h this is 0.38, and the car is not missing 62% of
    // its grip: it is out of STEERING, with 3.5 degrees of body slip and
    // nothing sliding. That constraint is real for cornering and has no say
    // over braking, which is exactly why it may not touch `mu`.
    muScale[i] = derivedAy > 1e-6 ? Math.min(1, measured.ay[i]! / derivedAy) : 1
  }
  return { ...measured, muScale }
}

export function longitudinalLimit(
  p: CarParams, v: number, curvature: number, commitment: number,
  mode: 'brake' | 'drive',
): number {
  return longitudinal(p, gripModel(p, commitment), v, curvature, commitment, mode)
}

/**
 * Longitudinal acceleration left over after cornering, at this speed.
 *
 * Per AXLE, because the car is not a point mass and the two differences both
 * matter. Only the rear drives, so giving a rear-driven car the whole vehicle's
 * friction circle to accelerate on overstates traction by the reciprocal of the
 * rear's load share — measured, that was the shipped model claiming 1.80 g off
 * a slow corner where the car delivers 1.00. And braking is shared by
 * `brakeBias`, so the axle that runs out first depends on that split rather
 * than on the total.
 *
 * Load transfer is solved rather than ignored: braking moves load onto the
 * front, which is the axle taking 60% of the brake force, so ignoring it
 * understates braking exactly where the car does most of it. One fixed-point
 * pass is enough — the second correction is under a percent.
 */
/** Longitudinal fraction still available when `used` of the lateral is spent. */
function ellipseSpare(used: number, e: number): number {
  const u = Math.min(Math.abs(used), 1)
  return Math.pow(Math.max(0, 1 - Math.pow(u, e)), 1 / e)
}

function longitudinal(
  p: CarParams, g: GripModel, v: number, curvature: number, commitment: number,
  mode: 'brake' | 'drive', ggv?: Ggv,
): number {
  // A measured envelope corrects CORNERING, not the tyre and not the engine.
  //
  // This used to take the whole drive column and multiply it by the friction
  // ellipse. That is wrong above 108 km/h, where the car is ENGINE limited and
  // the tyre has grip going spare: cornering was charged against a limit the
  // tyre was never setting, and the plan gave up 1.4 s in the 160-200 km/h band
  // alone while its cornering caps agreed with the derived model to 2%.
  //
  // So keep the per-axle structure below — which takes `min(tyre spare,
  // engine)` and therefore costs nothing to corner while the engine is the
  // weaker of the two — and calibrate only the axle's LATERAL capacity, which
  // is the thing that was measured. Scaling `mu` instead was tried and it
  // charges the correction to braking and traction too, where the low-speed
  // part of it (steering lock) has no business at all.
  const lat = ggv?.muScale ? ggvAt(ggv, ggv.muScale, v) : 1
  // How the two axes trade, measured off the car rather than assumed.
  //
  // `sqrt(grip^2 - fy^2)` is a friction CIRCLE, and this car's envelope is not
  // one: fitted against its own combined-slip behaviour the exponent is about
  // 3, which is a good deal squarer. A circle therefore understates what is
  // left for braking while cornering — exactly the corner-entry overlap a
  // human lives on — so trail braking reads as impossible when it is not.
  const e = ggv?.ellipse && ggv.ellipse > 1 ? ggv.ellipse : 2
  const vv = v * v
  const drag = (p.dragCoef * vv) / p.mass
  const staticF = g.aF + g.bF * vv
  const staticR = g.aR + g.bR * vv
  // Yaw balance fixes how the cornering demand is split between the axles.
  const lateralForce = p.mass * vv * Math.abs(curvature)
  const fyF = lateralForce * g.shareF
  const fyR = lateralForce * g.shareR

  let aLong = 0
  let out = 0
  for (let pass = 0; pass < 2; pass++) {
    const dFz = g.transfer * aLong
    const fzF = Math.max(staticF - dFz, 100)
    const fzR = Math.max(staticR + dFz, 100)
    const gripR = axleMu(g, fzR, g.fz0R) * g.rearBias * fzR
    // Longitudinal capacity is the full circle; the LATERAL radius is the
    // calibrated one, so a corner eats into the budget at the measured rate.
    const latR = gripR * lat
    const spareR = gripR * ellipseSpare(fyR / Math.max(latR, 1e-6), e)

    if (mode === 'brake') {
      const gripF = axleMu(g, fzF, g.fz0F) * fzF
      const latF = gripF * lat
      const spareF = gripF * ellipseSpare(fyF / Math.max(latF, 1e-6), e)
      // Whichever axle saturates first, given the bias, caps the pair.
      const fx = Math.min(
        spareF / Math.max(p.brakeBias, 1e-6),
        spareR / Math.max(1 - p.brakeBias, 1e-6),
        p.maxBrakeForce * commitment,
      )
      out = Math.max(0.5, fx / p.mass + drag)
      aLong = -out
    } else {
      const fx = Math.min(spareR, peakDriveForce(p, v))
      out = Math.max(0.05, fx / p.mass - drag)
      aLong = out
    }
  }
  return out
}

/**
 * The speed at which this curvature uses all the grip — the FRONT axle's.
 *
 * A steady corner has to balance yaw moment, and that fixes the ratio the two
 * axles are asked in: the front takes `lr / wb` of the lateral force whatever
 * the driver does about it. `rearGripBias` then gives the rear 25% more grip
 * than the front, so the front is always the axle that runs out — and the
 * ceiling is `gripF * wb / lr / m`, not the pair's total. Measured against the
 * simulation this is within 4% from 70 to 290 km/h where treating the car as
 * one circle was 6% out at the bottom and 39% out at the top.
 *
 * The old form also had a hole worth naming. Written as `m v² k = mu (m g +
 * Cl v²)`, the bracket `m k - mu Cl` goes non-positive for any corner gentler
 * than about 176 m radius on the f1 car, and the answer is then INFINITY: aero
 * was modelled as producing grip exactly as fast as the corner consumed it,
 * forever. A third of Ashford's stations were in that state, so the optimiser
 * believed every fast sweeper was free and never straightened one.
 *
 * Load sensitivity closes it. mu falls as load rises, so grip grows more slowly
 * than v² and every corner has a finite limit. Substituting muF back in makes
 * the balance quadratic in u = v²:
 *
 *     K u = C (A + B u) - D (A + B u)²
 *
 * with A the static front load, B the front's aero coefficient, K the corner's
 * demand, and C, D the two terms of the load-sensitivity expansion. The
 * positive root is the answer.
 *
 * LIMIT: the `max(0.1, ...)` floor the car puts under muF is not modelled, so
 * this is wrong once the front is loaded past `1 + 0.9 / muLoadSens` times its
 * reference — 8.5x on the f1 car, which reaches 3.3x flat out. For a car with
 * no load sensitivity at all the quadratic degenerates and the old infinity is
 * still reachable, correctly: a linear tyre really does corner at any speed.
 */
export function corneringSpeed(
  p: CarParams, curvature: number, commitment: number, ggv?: Ggv,
): number {
  const k = Math.abs(curvature)
  if (k < 1e-6) return Infinity
  if (ggv) {
    // v² k = ay(v). The right-hand side is a table rather than a formula, so
    // this is solved by iteration instead of algebra — and it converges in a
    // handful of steps because ay grows far more slowly than v², which makes
    // the map a contraction.
    let v = Math.sqrt(ggvAt(ggv, ggv.ay, 0) * commitment / k)
    for (let i = 0; i < 12; i++) {
      const next = Math.sqrt((ggvAt(ggv, ggv.ay, v) * commitment) / k)
      if (Math.abs(next - v) < 1e-4) { v = next; break }
      v = next
    }
    return v
  }
  const wb = wheelbase(p)
  const mu = p.mu * commitment
  const s = p.muLoadSens
  // Front axle: static load, aero share, and the demand a corner makes of it.
  const A = (p.mass * G * p.lr) / wb
  const B = p.downforceCoef * (1 - p.aeroRearBias)
  const K = (k * p.lr * p.mass) / wb
  const R0 = p.fzRefScale * A

  if (s === 0) {
    // No load sensitivity: grip is linear in load and the balance is linear too.
    const denom = K - mu * B
    if (denom <= 0) return Infinity
    return Math.sqrt((mu * A) / denom)
  }

  const C = mu * (1 + s)
  const D = (mu * s) / R0
  const a2 = D * B * B
  const b2 = K - C * B + 2 * D * A * B
  const c2 = A * (D * A - C)
  if (a2 <= 0) {
    const denom = K - C * B
    if (denom <= 0) return Infinity
    return Math.sqrt(Math.max(0, -c2 / denom))
  }
  const disc = b2 * b2 - 4 * a2 * c2
  if (disc <= 0) return 0
  const u = (-b2 + Math.sqrt(disc)) / (2 * a2)
  return u > 0 ? Math.sqrt(u) : 0
}

/**
 * The pedal that delivers a wanted longitudinal acceleration at this speed.
 *
 * Shared by the plan baked into the line and by the controller driving it, so
 * the two cannot disagree about what "brake at 8 m/s^2" means in pedal terms.
 */
export function pedalFor(
  p: CarParams, v: number, accel: number, driveForce?: number,
): number {
  const speed = Math.max(Math.abs(v), 0.5)
  // Drag and rolling resistance are being fought whatever the pedal is doing;
  // at 280 km/h drag alone is a couple of m/s^2, so a pedal that ignores it
  // falls off the pace down every straight.
  const needed = p.mass * accel + p.dragCoef * speed * speed + p.rollingResistance
  // Sized against the force actually on offer when the caller knows it. The
  // baked plan does not — it is describing a lap, not a moment, and the best
  // gear is the right answer there. A CONTROLLER does know, and using the peak
  // instead means asking for a fraction of a force the current gear cannot
  // make: the pedal comes out too small and the car quietly runs slow.
  return needed >= 0
    ? Math.min(1, needed / Math.max(driveForce ?? peakDriveForce(p, speed), 1))
    // A negative throttle is exactly `throttle * maxBrakeForce` — see car.ts.
    : Math.max(-1, needed / p.maxBrakeForce)
}

/**
 * The pedal that produces the planned change in speed over each segment.
 *
 * v dv/ds is the acceleration the profile is asking for; the rest is what it
 * takes to get it. Drag and rolling resistance are added rather than ignored
 * because at 280 km/h drag alone is a couple of m/s^2 — hold the pedal that
 * only accounts for the speed change and the car slowly falls off the profile
 * down every straight, which the feedback then has to fight.
 */
function pedalPlan(speed: Float64Array, seg: Float64Array, p: CarParams): Float64Array {
  const n = speed.length
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const b = (i + 1) % n
    const v = Math.max(speed[i]!, 0.5)
    const ds = Math.max(seg[i]!, 1e-3)
    out[i] = pedalFor(p, v, (speed[b]! * speed[b]! - v * v) / (2 * ds))
  }
  return out
}

/**
 * Rebuild a finished line from offsets that were found earlier.
 *
 * The search is half a minute; this is a fraction of a millisecond, because all
 * it does is the arithmetic that turns offsets into points, curvature, spacing
 * and a speed profile. That gap is the whole reason race mode bakes its lines:
 * a race cannot spend thirty seconds finding a line the moment the lights are
 * about to go out, and it does not have to, because the line for a given car on
 * a given circuit is the same line every time.
 *
 * Offsets are clamped back inside the road, so a baked file that predates a
 * change to the circuit or to `EDGE_MARGIN` degrades to a legal line rather
 * than putting the field through a wall.
 */
/**
 * A line built from raw world coordinates — a lap that was driven.
 *
 * Not expressed as offsets from the centreline, and that is the point. Turning
 * a driven path into offsets means projecting each pose onto the centreline,
 * and that projection is ambiguous wherever the road doubles back: at a hairpin
 * the nearest centreline point can be round the other side of the corner. Doing
 * it that way reconstructed a line demanding 436% of the car's grip out of a lap
 * that had actually been driven, and 165% after two attempts to patch it. The
 * recording knows where the car was; keep the coordinates.
 *
 * `offset` is still filled in, because the follower and the HUD report how much
 * road is left — but nothing about the geometry depends on it.
 */
export function lineFromPoints(
  track: Track, p: CarParams, x: Float64Array, y: Float64Array,
  recorded: Float64Array, commitment = 1.0, ggv?: Ggv,
): RacingLine {
  const n = x.length
  const curvature = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = (i - 2 + n) % n
    const c = (i + 2) % n
    const area = (x[i]! - x[a]!) * (y[c]! - y[a]!) - (y[i]! - y[a]!) * (x[c]! - x[a]!)
    const d1 = Math.hypot(x[i]! - x[a]!, y[i]! - y[a]!)
    const d2 = Math.hypot(x[c]! - x[i]!, y[c]! - y[i]!)
    const d3 = Math.hypot(x[c]! - x[a]!, y[c]! - y[a]!)
    curvature[i] = d1 * d2 * d3 > 1e-9 ? (2 * area) / (d1 * d2 * d3) : 0
  }
  smoothCurvature(curvature)
  const seg = new Float64Array(n)
  const dist = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const b = (i + 1) % n
    seg[i] = Math.hypot(x[b]! - x[i]!, y[b]! - y[i]!)
    if (i + 1 < n) dist[i + 1] = dist[i]! + seg[i]!
  }
  const offset = new Float64Array(n)
  for (let i = 0; i < n; i++) offset[i] = track.project(x[i]!, y[i]!).lateral
  const speed = new Float64Array(n)
  for (let i = 0; i < n; i++) speed[i] = recorded[i]! * commitment
  return {
    x, y, offset, curvature, speed, pedal: pedalPlan(speed, seg, p),
    dist, total: dist[n - 1]! + seg[n - 1]!, commitment, recorded,
    ...(ggv ? { ggv } : {}),
  }
}

export function lineFromOffsets(
  track: Track, p: CarParams, offsets: Float64Array, commitment = 1.0, ggv?: Ggv,
): RacingLine {
  // `presmoothed`, because every caller passes offsets that came OUT of a line
  // — a baked file, or a line being refined — and those have been smoothed
  // already. Smoothing them again returns a line that is not the one asked for.
  return buildRacingLine(track, p, {
    seed: offsets, optimise: 0, commitment, presmoothed: true, ...(ggv ? { ggv } : {}),
  })
}

/**
 * The same line at a different commitment — speeds only, geometry untouched.
 *
 * The search in `fastestLap` tries a dozen commitments, and re-optimising the
 * whole line for each costs a dozen times what it needs to. The line barely
 * moves with commitment: a car at 90% of its grip wants the same apex as one at
 * 100%, just slower through it. So the shape is found once and only the speed
 * profile is rebuilt, which is a hundredth of the work.
 */
export function atCommitment(
  line: RacingLine, p: CarParams, commitment: number, ggv = line.ggv,
): RacingLine {
  const n = line.x.length
  const seg = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const b = (i + 1) % n
    seg[i] = Math.hypot(line.x[b]! - line.x[i]!, line.y[b]! - line.y[i]!)
  }
  // A recorded line has nothing to recompute. `commitment` becomes a fraction
  // of the speed a human actually carried, which is both a simpler knob and a
  // safer one — every value below 1 is known to be driveable, because a slower
  // pass through the same geometry cannot need more grip than the original did.
  if (line.recorded) {
    const speed = new Float64Array(n)
    for (let i = 0; i < n; i++) speed[i] = line.recorded[i]! * commitment
    return { ...line, speed, pedal: pedalPlan(speed, seg, p), commitment }
  }
  const speed = speedProfile(line.curvature, seg, p, commitment, ggv)
  return { ...line, speed, pedal: pedalPlan(speed, seg, p), commitment }
}

/** Boundary conditions for a windowed solve. */
export interface WindowSeeds {
  /**
   * Speed at the station just PAST the window (m/s).
   *
   * The backward sweep's boundary, and the one number that makes a window
   * behave like part of a lap instead of a road that ends.
   */
  exitSpeed: number
  /**
   * Speed the car has at the FIRST station (m/s) — the forward sweep's boundary.
   *
   * Required, for the same reason `exitSpeed` is, and the symmetry is not
   * decoration. On a straight `corneringSpeed` is genuinely infinite: nothing
   * about the road limits you there, only what the engine could get you to from
   * where you were. The full-lap profile resolves that on its forward sweep,
   * which always has a previous station to accelerate from. The first station
   * of a window does not — so without this, a window that opens on a straight
   * reports an infinite speed and a NaN pedal, and every candidate scores the
   * same.
   *
   * A CAP rather than a target: the solve may still find the car has to be
   * slower. Handing it the car's ACTUAL speed is what lets a car that arrived
   * badly be told it cannot make the next corner, and a car arriving in a tow
   * keep the speed the tow gave it, instead of both being handed a plan drawn
   * for a car that arrived exactly on the line.
   */
  entrySpeed: number
}

/**
 * The speed profile over a STRETCH of road, rather than a whole lap.
 *
 * `atCommitment` is the honest way to price a LINE and the wrong way to price a
 * CANDIDATE. A race planner asks "what would this path be worth" several times
 * a tick for every car on the circuit, and the full-lap answer costs some nine
 * hundred stations of grip arithmetic plus three fresh arrays every time it is
 * asked — for a number thrown away before the car has moved a metre.
 *
 * It is also far more answer than the question needs. What to do about the next
 * corner does not depend on what happens two corners later. It depends on this
 * stretch of road, and on one number: how fast the car will be at the far end.
 *
 * So this solves an OPEN stretch instead of a closed ring, into buffers it owns
 * and reuses, and takes that number as a boundary condition.
 *
 * THE SEED IS NOT OPTIONAL, and forgetting it is the failure mode to watch for.
 * The backward sweep is the entire reason a plan brakes at all: it carries
 * "what must I already be doing to make what is ahead" back from each limit.
 * Cut a window out of the lap and its last station has nothing ahead of it, so
 * a car not told otherwise concludes it may arrive at the window's edge at any
 * speed it likes — and brakes late, once per window, all the way round. That
 * reads as a mysterious periodic stutter rather than as a missing argument,
 * which is why `exitSpeed` is required rather than defaulted.
 */
export class SpeedWindow {
  /** Speeds at window stations `0..count-1` (m/s). Valid until the next solve. */
  readonly speed: Float64Array
  /** The pedal to hold over the same stations. Valid until the next solve. */
  readonly pedal: Float64Array
  /** Geometry scratch, filled by `fromLine`. */
  private readonly k: Float64Array
  private readonly seg: Float64Array
  /** Stations the last solve filled. */
  count = 0

  constructor(readonly capacity: number) {
    this.speed = new Float64Array(capacity)
    this.pedal = new Float64Array(capacity)
    this.k = new Float64Array(capacity)
    this.seg = new Float64Array(capacity)
  }

  /**
   * Solve for geometry the caller supplies — a candidate path of its own shape.
   *
   * `curvature[j]` is the curvature at window station j; `seg[j]` is the
   * distance from station j to the next, so `seg[count-1]` is what bridges the
   * last station to wherever `exitSpeed` was measured.
   *
   * Always MODELLED. A recorded lap says what speed a human carried on the path
   * they drove and says nothing whatever about a path they did not, so the
   * moment a candidate leaves the recorded line there is no measurement left to
   * use — see `fromLine`, the only place recorded speeds are honoured.
   */
  solve(
    p: CarParams, commitment: number,
    curvature: ArrayLike<number>, seg: ArrayLike<number>, count: number,
    seeds: WindowSeeds, ggv?: Ggv,
  ): void {
    if (count > this.capacity) {
      throw new RangeError(`window of ${count} stations exceeds capacity ${this.capacity}`)
    }
    this.count = count
    if (count === 0) return
    const v = this.speed
    const g = gripModel(p, commitment)
    for (let j = 0; j < count; j++) {
      v[j] = corneringSpeed(p, curvature[j]!, commitment, ggv)
    }
    if (seeds.entrySpeed < v[0]!) v[0] = seeds.entrySpeed
    // BACKWARD, FORWARD, BACKWARD, FORWARD, BACKWARD. The order is load-bearing
    // twice over, and the count was measured rather than chosen.
    //
    // One sweep each way is enough to PROPAGATE the constraints: braking limits
    // only ever travel backwards, engine limits only forwards. The repeats are
    // for the NONLINEARITY — how hard the car can brake depends on how fast it
    // is going, so the first sweep evaluates that at the cornering speed, which
    // is the one speed the car is known not to be doing on the way in, and each
    // later one at something closer to the answer.
    //
    // ENDING ON BRAKING is the part that is not stylistic. A forward sweep may
    // LOWER a station, and lowering station j+1 makes the braking demand at
    // station j harder than it was when that demand was last checked. Finish on
    // a forward sweep and the profile can end up asking for a deceleration the
    // car does not have — which is exactly what the full-lap `speedProfile`
    // does today, at 65-70 stations a lap on Croft Bay and up to 17x over the
    // car's actual braking. See `atCommitment`; that is a real bug, and this
    // deliberately does not reproduce it.
    //
    // FIVE, not three: audited against the car's own braking limit, three
    // sweeps leave 290 stations a lap demanding up to 1.27x the braking
    // available, and five leave 96 at 1.06x — none at all on Ashford. Iterating
    // the limit locally at each station instead was tried and is WORSE (444 at
    // 3.19x): driving the evaluation speed down inside one station overshoots,
    // because the neighbours it is being solved against have not moved yet.
    for (let pass = 0; pass < 5; pass++) {
      if (pass % 2 === 1) {
        for (let j = 1; j < count; j++) {
          const a = longitudinal(p, g, v[j - 1]!, curvature[j - 1]!, commitment, 'drive', ggv)
          const reach = Math.sqrt(v[j - 1]! * v[j - 1]! + 2 * a * seg[j - 1]!)
          if (reach < v[j]!) v[j] = reach
        }
        continue
      }
      let ahead = seeds.exitSpeed
      for (let j = count - 1; j >= 0; j--) {
        // NEVER ASK THE GRIP MODEL ABOUT AN INFINITE SPEED. `corneringSpeed` is
        // legitimately unbounded wherever downforce outgrows the corner, and
        // `longitudinal` hands back NaN when fed that — whereupon `NaN < v` is
        // false, the braking constraint is silently skipped, and the station
        // keeps a speed nothing ever checked. That single missing guard is the
        // whole of the full-lap bug described above. Ask about the speed the
        // car will actually be doing there instead.
        const at = Number.isFinite(v[j]!) ? v[j]! : ahead
        const a = longitudinal(p, g, at, curvature[j]!, commitment, 'brake', ggv)
        const reach = Math.sqrt(ahead * ahead + 2 * a * seg[j]!)
        if (reach < v[j]!) v[j] = reach
        ahead = v[j]!
      }
    }
    this.fillPedal(p, seg, count, seeds.exitSpeed)
  }

  /**
   * The same window taken off a line's own geometry — the "hold the line"
   * candidate, and the thing every other candidate is scored against.
   *
   * The commitment comes FROM the line rather than being passed in, and that is
   * deliberate. The seed is read out of `line.speed`, so a caller allowed to
   * name a different commitment could seed a 0.9 window off a 1.0 profile and
   * get a plan wrong only at its far end — the hardest kind of wrong to see.
   * Every driver in a race already holds its own line from `atCommitment`; hand
   * this that line.
   *
   * `entrySpeed` defaults to the line's own speed at `from`, which is what makes
   * this reproduce the full-lap profile. Pass the car's real speed instead when
   * you want the plan for the car that actually turned up.
   */
  fromLine(
    line: RacingLine, p: CarParams, from: number, count: number, entrySpeed?: number,
  ): void {
    const n = line.x.length
    if (count > n) {
      throw new RangeError(`window of ${count} stations exceeds the lap's ${n}`)
    }
    if (count > this.capacity) {
      throw new RangeError(`window of ${count} stations exceeds capacity ${this.capacity}`)
    }
    this.count = count
    if (count === 0) return
    const exit = (from + count) % n
    for (let j = 0; j < count; j++) {
      const i = (from + j) % n
      const b = (i + 1) % n
      this.k[j] = line.curvature[i]!
      this.seg[j] = Math.hypot(line.x[b]! - line.x[i]!, line.y[b]! - line.y[i]!)
    }
    // A RECORDED line has nothing to solve — see `atCommitment`. Its speeds are
    // what a human actually carried, and `commitment` scales those rather than
    // scaling grip. Modelling them here would swap a measurement for a
    // prediction and disagree with the full-lap profile the rest of the field
    // is driving, on the one circuit whose line came from a real lap.
    const entry = entrySpeed ?? line.speed[from % n]!
    if (line.recorded) {
      const c = line.commitment
      for (let j = 0; j < count; j++) {
        this.speed[j] = line.recorded[(from + j) % n]! * c
      }
      if (entry < this.speed[0]!) this.speed[0] = entry
      this.fillPedal(p, this.seg, count, line.recorded[exit]! * c)
      return
    }
    this.solve(p, line.commitment, this.k, this.seg, count, {
      exitSpeed: line.speed[exit]!,
      entrySpeed: entry,
    }, line.ggv)
  }

  /** `pedalPlan`'s arithmetic, over an open stretch that ends at a seed. */
  private fillPedal(
    p: CarParams, seg: ArrayLike<number>, count: number, exitSpeed: number,
  ): void {
    for (let j = 0; j < count; j++) {
      const next = j + 1 < count ? this.speed[j + 1]! : exitSpeed
      const v = Math.max(this.speed[j]!, 0.5)
      const ds = Math.max(seg[j]!, 1e-3)
      this.pedal[j] = pedalFor(p, v, (next * next - v * v) / (2 * ds))
    }
  }
}

/**
 * The line driven perfectly — a pose per tick, on rails.
 *
 * No car and no controller: the point on the line advances at exactly the speed
 * the profile asks for, and the body points exactly along it. What you see is
 * the LINE and the SPEED PROFILE and nothing else, which is what you want when
 * the question is whether they are any good.
 *
 * This is the opposite tool to `LineFollower`, and both are worth having. On
 * rails answers "is this line sensible and is this speed profile sane". The
 * follower answers "can a car with actual tyres do it", which is a different
 * question and a much less flattering one — the follower runs metres wide where
 * the rails car is exact, and that gap is the honest measure of how much the
 * profile is asking for.
 *
 * Returns the same six-values-per-tick stream a recorded lap stores, so it
 * plays back through machinery that already exists. The lap time is simply the
 * number of ticks: distance over speed, integrated, with nothing in the way.
 */
export function railsPath(line: RacingLine, dt: number): Float64Array {
  const n = line.x.length
  const out: number[] = []
  let travelled = 0

  // A whole lap, plus a guard against a profile so slow it never finishes.
  for (let tick = 0; tick < 60 * 60 * 10 && travelled < line.total; tick++) {
    // Where on the line this distance falls, and how far between stations.
    let i = 0
    while (i + 1 < n && line.dist[i + 1]! <= travelled) i++
    const j = (i + 1) % n
    const segLen = (j === 0 ? line.total : line.dist[j]!) - line.dist[i]!
    const frac = segLen > 1e-9 ? (travelled - line.dist[i]!) / segLen : 0

    const x = line.x[i]! + (line.x[j]! - line.x[i]!) * frac
    const y = line.y[i]! + (line.y[j]! - line.y[i]!) * frac
    // Heading from the segment the car is on, not from a station: on a straight
    // the two agree, and in a corner the segment is what it is actually moving
    // along.
    const yaw = Math.atan2(line.y[j]! - line.y[i]!, line.x[j]! - line.x[i]!)
    const v = line.speed[i]! + (line.speed[j]! - line.speed[i]!) * frac
    // Front wheels turned the way the corner needs, so it does not look like a
    // car being slid sideways along a path.
    const steer = Math.atan(3.25 * (line.curvature[i]! + (line.curvature[j]! - line.curvature[i]!) * frac))

    out.push(x, y, yaw, steer, v, v)
    travelled += v * dt
  }
  return Float64Array.from(out)
}

/**
 * Average curvature over about a car length, in place.
 *
 * Deliberately inside `geometry`, so the OPTIMISER scores the same smoothed
 * curvature the profile will drive. Smoothing only at the end would let the
 * search keep collecting kinks it was never charged for, and then quietly
 * remove them from the answer it was scored on.
 */
function smoothCurvature(k: Float64Array): void {
  const n = k.length
  const src = Float64Array.from(k)
  const span = CURVATURE_SMOOTH
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let d = -span; d <= span; d++) sum += src[(i + d + n * 2) % n]!
    k[i] = sum / (2 * span + 1)
  }
}

/** Menger curvature: the reciprocal radius of the circle through three points. */
function menger(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
): number {
  const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  const ab = Math.hypot(bx - ax, by - ay)
  const bc = Math.hypot(cx - bx, cy - by)
  const ca = Math.hypot(ax - cx, ay - cy)
  const denom = ab * bc * ca
  return denom < 1e-9 ? 0 : (2 * area2) / denom
}

/** The station whose line point is nearest to (x, y). */
export function nearestStation(line: RacingLine, x: number, y: number, from = 0): number {
  const n = line.x.length
  let best = from
  let bestD = Infinity
  // Local search around the last known station — the car moves a few metres a
  // tick, and scanning the whole ring every tick is the slow part of a lap.
  for (let d = -12; d <= 40; d++) {
    const i = (from + d + n * 2) % n
    const dd = (line.x[i]! - x) ** 2 + (line.y[i]! - y) ** 2
    if (dd < bestD) {
      bestD = dd
      best = i
    }
  }
  return best
}
