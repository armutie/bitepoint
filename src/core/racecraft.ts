/**
 * Knowing about the other cars — the first thing a field needs and the only
 * thing it currently has none of.
 *
 * Every AI drives the same line at a slightly different speed, which on its own
 * produces a queue that drives into itself. Contact resolution has been hiding
 * that: the cars shunt, the shunt is resolved, and nobody looks at why they were
 * touching. This is the layer below overtaking — not "how do I get past" but
 * "there is somebody there".
 *
 * Deliberately NOT a new controller. A corner is a speed limit some distance
 * ahead, and so is a slower car; the follower already has a brake-point search
 * that decides when a limit ahead is close enough to matter. Feeding traffic in
 * as a speed cap means a car brakes for another car with exactly the machinery,
 * and exactly the smoothness, that it brakes for a corner.
 */

/** How far round the lap each car is, and how fast, in grid-slot order. */
export interface FieldState {
  /** Total distance covered: laps * lapLength + distance round this lap. */
  distance: number[]
  speed: number[]
}

export interface Neighbour {
  /** Grid slot of the car ahead. */
  slot: number
  /** Metres of road between the two, always positive. */
  gap: number
  /** How fast that car is going (m/s). */
  speed: number
}

/**
 * The car immediately ahead of `slot`, or null if the road is clear.
 *
 * Works on total distance rather than distance round the lap, so being lapped
 * is not mistaken for leading: a car a lap down is a long way BEHIND, and the
 * one to avoid hitting is the one physically in front.
 */
export function carAhead(
  field: FieldState, slot: number, lapLength: number, within = 120,
): Neighbour | null {
  const mine = field.distance[slot]!
  let best: Neighbour | null = null
  for (let i = 0; i < field.distance.length; i++) {
    if (i === slot) continue
    // Where they are on the road relative to me, forwards only.
    let gap = field.distance[i]! - mine
    // A car many laps up or down is still physically somewhere on this circuit.
    gap = ((gap % lapLength) + lapLength) % lapLength
    if (gap <= 0 || gap > within) continue
    if (!best || gap < best.gap) best = { slot: i, gap, speed: field.speed[i]! }
  }
  return best
}

/**
 * The least room a car will sit behind another in, metres.
 *
 * A DISTANCE and not a time gap, because this is the room needed when both
 * cars have STOPPED — a standing queue behind an incident, where a time gap is
 * zero and two cars still cannot occupy the same six metres. How much room a
 * moving car needs is not a constant at all: it comes out of the arithmetic
 * below, from the speed it is closing at and the brakes it actually has.
 */
const STANDING_ROOM = 8

/**
 * The fastest this car should be going, given what is in front of it.
 *
 * A car ahead is a speed limit some distance away. So is a corner. This is
 * therefore the corner arithmetic rather than a car-following law of its own:
 * `v^2 = ahead^2 + 2*a*s` is the same equation the follower's brake-point
 * search already solves, with the single difference that this limit is moving.
 *
 * WHAT THIS REPLACED, because the contrast is the argument. The old law had
 * five invented numbers — a 0.55 s time gap, a 6 m floor, a 1.2 gain, a 4 m/s
 * crawl exemption, and an 8 m/s floor below which the car ahead was IGNORED
 * ENTIRELY. That last was labelled a stopgap in its own comment: with no way
 * past a slow car, the least-wrong answer had been to drive through it.
 * Measured on Croft Bay against a crawling player it was worth 17324 ticks of
 * contact and a race that never reached the flag.
 *
 * None of the five survive. The room a car needs is whatever its brakes say it
 * is, and the car already knows what its brakes do — `longitudinalLimit`
 * answers it, at the speed and the curvature the car is actually at, which no
 * constant can. What is left is the one quantity genuinely not derivable: how
 * close two stopped cars park.
 *
 * The result is a CAP, not a target. A car with a clear road gets Infinity and
 * is never asked to speed up to anything.
 */
export function followingLimit(
  ahead: Neighbour | null,
  /** What this car can brake at right now — from `longitudinalLimit`. */
  brakeAccel: number,
  standingRoom = STANDING_ROOM,
): number {
  if (!ahead) return Infinity
  const room = ahead.gap - standingRoom
  // Already closer than we wanted: give some back. Their speed less the overrun,
  // so a car that has got properly on top of another drops BELOW it and the gap
  // reopens, instead of merely holding station at a distance that is too small.
  if (room <= 0) return Math.max(0, ahead.speed + room)
  return Math.sqrt(ahead.speed * ahead.speed + 2 * Math.max(brakeAccel, 0.5) * room)
}

// ---------------------------------------------------------------------------
// Overtaking and defending
// ---------------------------------------------------------------------------

/**
 * What a driver is currently trying to do.
 *
 * Three states and no more. The literature's warning about behaviour selection
 * is that a car which reconsiders every frame looks far worse than one that
 * commits to something slightly wrong — the same lesson the brake latch taught
 * this project, where a controller that changed its mind constantly was 2.6 s
 * a lap slower than one that did not.
 */
export type Intent = 'race' | 'attack' | 'defend'

export interface Racer {
  intent: Intent
  /** Committed side: +1 left of the line, -1 right, 0 none. */
  side: number
  /** Ticks the current intent has been held. */
  held: number
}

export const newRacer = (): Racer => ({ intent: 'race', side: 0, held: 0 })

/** How much road is free either side of the line, at a car's position. */
export interface Room {
  left: number
  right: number
}

/** Close enough to have a go. */
const ATTACK_GAP = 25

/** Close enough behind to be worth covering. */
const DEFEND_GAP = 20

/** Ticks an intent must be held before it may be dropped — about a third of a second. */
const HOLD = 20

/** Lateral room a car wants beside another before it will sit there. */
const SIDE_BY_SIDE = 2.4

export function carBehind(
  field: FieldState, slot: number, lapLength: number, within = 120,
): Neighbour | null {
  const mine = field.distance[slot]!
  let best: Neighbour | null = null
  for (let i = 0; i < field.distance.length; i++) {
    if (i === slot) continue
    let gap = mine - field.distance[i]!
    gap = ((gap % lapLength) + lapLength) % lapLength
    if (gap <= 0 || gap > within) continue
    if (!best || gap < best.gap) best = { slot: i, gap, speed: field.speed[i]! }
  }
  return best
}

/**
 * Decide what this car is doing, and how far off the line it wants to be.
 *
 * Returns the offset in metres, positive to the left of travel. `racer` is
 * mutated: the intent and the chosen side persist between ticks, because
 * committing is the entire point.
 *
 * Deliberately NOT symmetric. The car in front has the right to the line, and
 * an attacker that finds the defender already on its chosen side gives way
 * rather than both of them arriving in the same place. Two cars each insisting
 * is how a race turns into a demolition derby, and neither of them is wrong.
 */
export function decide(
  racer: Racer, ahead: Neighbour | null, behind: Neighbour | null,
  room: Room, mySpeed: number, defenderSide: number,
): number {
  racer.held++
  const closing = ahead != null && mySpeed > ahead.speed + 0.5
  const wantAttack = ahead != null && ahead.gap < ATTACK_GAP && closing
  const wantDefend = behind != null && behind.gap < DEFEND_GAP

  // Attacking beats defending: a car with somebody to pass and somebody behind
  // is better off getting on with it than sitting between two problems.
  const next: Intent = wantAttack ? 'attack' : wantDefend ? 'defend' : 'race'
  if (next !== racer.intent && racer.held >= HOLD) {
    racer.intent = next
    racer.held = 0
    racer.side = 0
  }

  if (racer.intent === 'race') {
    racer.side = 0
    return 0
  }

  if (racer.intent === 'attack') {
    if (racer.side === 0) {
      // Pick the side with more road, but never the side the car ahead has
      // already taken — that is its line to defend.
      const prefer = room.left > room.right ? 1 : -1
      racer.side = defenderSide !== 0 && prefer === defenderSide ? -prefer : prefer
    }
    const available = racer.side > 0 ? room.left : room.right
    if (available < SIDE_BY_SIDE) return 0
    return racer.side * Math.min(available, SIDE_BY_SIDE + 0.6)
  }

  // Defending: take one side and stay there. ONE move, never a weave — a car
  // that keeps switching is both slower and, in every racing series that has
  // ever written a rule about it, the thing the rule forbids.
  if (racer.side === 0) racer.side = room.right >= room.left ? -1 : 1
  const available = racer.side > 0 ? room.left : room.right
  return racer.side * Math.min(available, 1.6)
}

// ---------------------------------------------------------------------------
// Driver character
// ---------------------------------------------------------------------------

/**
 * A repeatable noise source, so a driver is the same driver every lap.
 *
 * `Math.random` would give a car a different personality each time round,
 * which is not variation, it is twitching. Seeded per grid slot, a driver gets
 * the same braking points every lap and a DIFFERENT set from its rivals — which
 * is what makes a field feel like people rather than copies.
 */
export function seeded(seed: number): () => number {
  let s = (seed >>> 0) || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

/**
 * A driver's mistakes, rolled fresh each time it comes to a corner.
 *
 * The first version of this gave every driver a FIXED misjudgement per corner,
 * seeded once — so it always braked three metres early at turn two, every lap
 * of every race. That is a personality, not a mistake, and it makes a driver
 * MORE predictable rather than less: three identical laps in a row.
 *
 * What a real driver does is get it right nearly every time and occasionally
 * not. So each corner is a fresh roll: mostly nothing, sometimes a few metres
 * early or late, and the lap that follows is a little different from the last
 * one. That is what makes a car look like somebody is driving it.
 *
 * Still capped harder on the late side. Braking early costs a tenth; braking
 * late runs the car wide, and past a few metres a mistake stops being a mistake
 * and becomes a retirement.
 */
export class Mistakes {
  private readonly bias: Float64Array
  private current = -1

  constructor(
    stations: number,
    /** Which corner each station belongs to, or the next one ahead of it. */
    private readonly cornerOf: Int32Array,
    private readonly rng: () => number,
    /** Chance of getting any one corner wrong. */
    private readonly chance: number,
    /** How wrong, in metres, when it happens. */
    private readonly size: number,
    /** Chance a mistake is EARLY rather than late. */
    private readonly earlyChance = 0.7,
    /** How much of `size` a LATE mistake may be. */
    private readonly lateShare = LATE_SHARE,
  ) {
    this.bias = new Float64Array(stations)
  }

  /**
   * Call once a tick with where the car is. Rolls when it reaches a new corner.
   *
   * Rolled on ARRIVAL rather than every tick, so a driver commits to its
   * mistake instead of changing its mind about it halfway down the braking
   * zone — which would be a twitch, not an error.
   */
  update(station: number): void {
    const corner = this.cornerOf[station]!
    if (corner === this.current) return
    this.current = corner
    if (corner < 0) return
    this.judged++
    const wrong = this.rng() < this.chance
    if (wrong) this.erred++
    // Two thirds of mistakes are braking early, which is the survivable one.
    // EARLY mistakes are big, LATE ones are small, and that asymmetry is not a
    // safety fudge — it is what the two errors actually are. Braking far too
    // early is an ordinary error that costs a tenth or two and nothing else;
    // braking far too late does not cost a tenth, it ends the lap. A driver who
    // makes both kinds at the same scale is not a worse driver, it is a car
    // that keeps crashing.
    const e = !wrong ? 0
      : this.rng() < this.earlyChance
        ? (0.4 + 0.6 * this.rng()) * this.size
        : -(0.4 + 0.6 * this.rng()) * this.size * this.lateShare
    for (let i = 0; i < this.bias.length; i++) {
      if (this.cornerOf[i] === corner) this.bias[i] = e
    }
  }

  get biases(): Float64Array {
    return this.bias
  }

  /** Corners judged, and how many of those were got wrong — for diagnostics. */
  judged = 0
  erred = 0
}

/**
 * For each station, the corner it is in or the next one ahead of it.
 *
 * "Ahead of it" matters: the braking for a corner happens on the straight
 * BEFORE the corner, so a station that is not in a corner still needs to know
 * which one it is about to arrive at, or the mistake is rolled after the point
 * at which it would have made any difference.
 */
export function cornerIndex(
  stations: number, corners: readonly { first: number; last: number }[],
): Int32Array {
  const out = new Int32Array(stations).fill(-1)
  for (let c = 0; c < corners.length; c++) {
    const seg = corners[c]!
    let i = seg.first
    for (;;) {
      out[i] = c
      if (i === seg.last) break
      i = (i + 1) % stations
    }
  }
  // Walk backwards so every straight points at the corner it leads to.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = stations - 1; i >= 0; i--) {
      if (out[i] === -1) out[i] = out[(i + 1) % stations]!
    }
  }
  return out
}

/** How much of a mistake may be LATE rather than early. */
const LATE_SHARE = 0.2

// ---------------------------------------------------------------------------
// Giving room
// ---------------------------------------------------------------------------

/** A car to stay out of the way of, seen from the one deciding. */
export interface Nearby {
  /** Metres up the road: positive is ahead of us, negative behind. */
  along: number
  /** Their ACTUAL lateral position on the road (m, +left of the centreline). */
  lateral: number
}

/**
 * How much road two cars want between their centres, metres.
 *
 * Body width plus air. The air is not politeness — it is the follower's own
 * inaccuracy. It holds its line to within roughly 0.5-2 m, so two cars asked to
 * sit exactly `width` apart are really somewhere between touching and fine, and
 * which one you get is not a decision anybody made.
 */
export const sideRoom = (width: number): number => width + 1.1

/**
 * Where to be, sideways, so as not to be in anybody's way.
 *
 * This is NOT overtaking, and the distinction is the whole reason it can be
 * simple. Overtaking needs an intent to hold, a side chosen in advance, and a
 * story about who is entitled to what — `decide` does all three, and three of
 * the four faults that switched it off are faults in exactly that machinery.
 * Avoidance has no intent. Somebody is there; be somewhere else.
 *
 * TWO THINGS MAKE IT WORK WHERE THE OFFSET NUDGE DID NOT.
 *
 * ACTUAL POSITIONS, NOT PLANNED ONES. The old separation clamp compared where
 * two cars INTENDED to be — line offset plus a racecraft nudge — and the
 * follower does not go exactly where it intends. Its 0.5-2 m of tracking error
 * ate most of a 2.6 m separation before anybody had done anything wrong. What
 * two cars need is room between the cars.
 *
 * NOBODY MOVES FOR A CAR BEHIND THEM. A car alongside or ahead is somebody to
 * leave room for; a car purely behind is their own problem. Making it
 * symmetric means a leader is shoved off its line by a car that has not even
 * drawn level, which is both wrong and the fastest way to two cars arriving in
 * the same place from opposite directions.
 *
 * Returns where to aim and whether it FAILED — `blocked` means somebody ahead
 * is still inside our room after using all the road there is, which is the only
 * situation where giving way has to cost speed rather than just position.
 */
export function giveRoom(
  /** Our own actual lateral position (m, +left). */
  mine: number,
  cars: readonly Nearby[],
  /** How far either side of the centreline the car may go (m). */
  edge: number,
  room: number,
  /** Longitudinal window within which a car counts as level with us. */
  overlap: number,
  /** Most a car will shift off its line to make room (m). */
  maxShift = 3,
): { lateral: number; blocked: boolean } {
  // ONE CAR, NOT ALL OF THEM. Pushing away from every car in turn compounds:
  // each push moves the position the next push is measured from, so a bunched
  // field walks a car clean across the road. Measured, that reached 6.35 m off
  // line — not giving room, just wandering. Room is given to the car it is
  // actually next to, which is the nearest one there is a conflict with.
  let worst: Nearby | null = null
  for (const car of cars) {
    // Behind and not level: not our problem to move for.
    if (car.along < -overlap) continue
    if (Math.abs(mine - car.lateral) >= room) continue
    if (!worst || Math.abs(car.along) < Math.abs(worst.along)) worst = car
  }
  let want = mine
  if (worst) {
    const apart = mine - worst.lateral
    // Away from them, on the side we are already on. `|| 1` breaks the tie when
    // two cars are exactly abreast, which on a grid is not rare.
    want = worst.lateral + (Math.sign(apart) || 1) * room
  }
  // AND NOT FAR. Giving room is a shift, not an excursion: past about a car's
  // width off the line the car is no longer racing, and whatever it was trying
  // to avoid is better dealt with by lifting.
  const shift = Math.max(-maxShift, Math.min(maxShift, want - mine))
  const capped = Math.max(-edge, Math.min(edge, mine + shift))
  let blocked = false
  // Did using all the road actually get us clear of anyone AHEAD? A car level
  // with us is already beside us and the answer is to ease away, not to brake;
  // a car in FRONT that we cannot get around is the one that costs speed.
  for (const car of cars) {
    if (car.along <= 0) continue
    if (Math.abs(capped - car.lateral) < room) blocked = true
  }
  return { lateral: capped, blocked }
}
