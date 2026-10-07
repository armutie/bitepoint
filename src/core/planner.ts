/**
 * Where to drive, decided every tick from what is actually around the car.
 *
 * The follower is a rail-follower: there is one path and every problem becomes
 * "how far off it am I and how hard do I correct". That framing is why
 * overtaking turned into "pick a side and add an offset", why recovery turned
 * into "how urgently do I dart back", and why two cars ended up in the same
 * place — neither was reasoning about SPACE, only about deviation.
 *
 * This reasons about space. Each tick it samples a set of lateral positions the
 * car could hold through the next stretch of road, scores each against what is
 * there, and picks one. The racing line stops being a rail and becomes the
 * thing it always was — the fastest place to be when nothing else is going on —
 * expressed as a preference among candidates rather than as a constraint.
 *
 * Overtaking, defending and recovery are then not three features. They are one
 * question asked repeatedly: given the road and the cars on it, where is the
 * best place for me to be?
 *
 * It starts as a PASS-THROUGH by design. With nobody about and the car on its
 * line, the winning candidate is the line itself, so behaviour is unchanged and
 * every lap time still stands. Each deviation has to be earned by a score.
 */
/** A rival, seen from the planning car, in the road's own frame. */
export interface Rival {
  /** Metres up the road: positive is ahead of us, negative behind. */
  along: number
  /** Its lateral offset from the reference line, positive left of travel. */
  offset: number
  /** Its speed (m/s). */
  speed: number
}

export interface PlanInput {
  /** Its current lateral offset from the reference line (m, +left). */
  offset: number
  speed: number
  /** Road available either side of the LINE at the car's position (m). */
  roomLeft: number
  roomRight: number
  rivals: readonly Rival[]
  /** What was chosen last tick, so a plan can be stuck to. */
  previous: number
}

export interface Plan {
  /** Lateral offset from the reference line to aim for (m, +left). */
  offset: number
  /** Ceiling on speed, Infinity when the road ahead is clear. */
  speedLimit: number
  /** Why this was chosen — for the labs, and for explaining a bad decision. */
  why: 'line' | 'passing' | 'held up' | 'covering' | 'recovering'
}

/** Lateral positions considered, as offsets from the line (m). */
const CANDIDATES = [-5, -4, -3, -2, -1.2, -0.6, 0, 0.6, 1.2, 2, 3, 4, 5]

/** How far ahead the plan has to hold good (s of travel). */
const HORIZON = 1.6

/** Sideways room two cars want between them (m). */
const SIDE_ROOM = 2.8

/** Longitudinal overlap within which a rival is beside rather than ahead (m). */
const OVERLAP = 6

/** How fast the car can actually change lane (m/s), matching the follower. */
const SHIFT_RATE = 3

/**
 * Choose where to be.
 *
 * The scoring is deliberately a sum of few terms with obvious units, because a
 * planner nobody can reason about is one that gets "tuned" by changing numbers
 * until a lap time moves — which is how the last three constants in this
 * project ended up wrong.
 */
export function plan(input: PlanInput): Plan {
  const { offset, speed, roomLeft, roomRight, rivals, previous } = input

  // Who is close enough to matter, and where they will be when we get there.
  const reach = Math.max(speed * HORIZON, 20)
  const near = rivals.filter((r) => r.along > -OVERLAP * 2 && r.along < reach + OVERLAP)

  const blocker = rivals
    .filter((r) => r.along > 0 && r.along < reach && r.speed < speed - 0.5)
    .sort((a, b) => a.along - b.along)[0]

  let best = 0
  let bestScore = -Infinity
  let bestWhy: Plan['why'] = 'line'

  for (const cand of CANDIDATES) {
    // Off the road is not a candidate, it is a crash with a plan.
    if (cand > roomLeft || -cand > roomRight) continue
    // Nor is a place the car cannot reach in the time it has.
    const needed = Math.abs(cand - offset) / SHIFT_RATE
    if (needed > HORIZON * 1.6) continue

    let score = 0
    let why: Plan['why'] = 'line'

    // THE LINE IS FAST. Everything else has to be worth leaving it for.
    score -= Math.abs(cand) * 1.4

    // STICK TO A DECISION. Not hysteresis for its own sake: a car that
    // reconsiders every frame looks far worse than one committed to something
    // slightly wrong, and it is the specific failure the brake latch taught.
    score -= Math.abs(cand - previous) * 2.2

    // ROOM. Sitting against the edge is worth less than the same place with a
    // metre in hand, because the car does not track perfectly and never will.
    const edge = Math.min(roomLeft - cand, roomRight + cand)
    score -= Math.max(0, 1.5 - edge) * 3

    // OTHER CARS. Not a hard bar — a hard bar freezes a car that is already
    // beside someone, and being frozen beside somebody is worse than easing
    // away from them. It grows sharply as the gap closes instead.
    for (const r of near) {
      const beside = r.along > -OVERLAP && r.along < OVERLAP
      const apart = Math.abs(cand - r.offset)
      if (beside) {
        score -= Math.max(0, SIDE_ROOM - apart) ** 2 * 4
      } else if (r.along > 0 && r.along < reach) {
        // Somebody ahead: their line is worth avoiding, but only in proportion
        // to how soon we arrive in it.
        const soon = 1 - r.along / reach
        score -= Math.max(0, SIDE_ROOM - apart) * 3 * soon
      }
    }

    // GETTING PAST. A car ahead and slower is a reason to be somewhere else,
    // and the reason is only as good as the room the somewhere else has.
    if (blocker) {
      const apart = Math.abs(cand - blocker.offset)
      if (apart > SIDE_ROOM) {
        score += 4
        why = 'passing'
      }
    }

    if (score > bestScore) {
      bestScore = score
      best = cand
      bestWhy = why
    }
  }

  // Speed: hold station behind whoever is directly in the way, unless the plan
  // is to be somewhere they are not.
  let speedLimit = Infinity
  if (blocker && Math.abs(best - blocker.offset) < SIDE_ROOM) {
    const want = Math.max(8, 0.55 * speed)
    speedLimit = blocker.along >= want
      ? Infinity
      : Math.max(0, blocker.speed + (blocker.along - want) * 1.2)
    if (speedLimit < speed) bestWhy = 'held up'
  }
  return { offset: best, speedLimit, why: bestWhy }
}
