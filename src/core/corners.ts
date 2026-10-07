/**
 * Cut a lap into straights and numbered turns.
 *
 * Every measurement in this project has been a lap average, and lap averages
 * keep hiding the answer. The follower's tracking error reads 0.87 m over a
 * lap — which sounds like a controller roughly working, and is not what is
 * happening: it is under half a metre nearly everywhere and 2.0 m through one
 * corner, and that one corner drags the whole circuit's `commitment` down by
 * 4.7 seconds.
 *
 * "An average cannot find a corner" was already written down as a trap here.
 * This is the tool that stops it being one: name the turns, then report
 * everything per turn.
 *
 * A corner is defined by what the car has to DO, not by the map — a 900 m
 * radius is a straight at 60 km/h and a real corner at 250. So the test is
 * lateral demand from the plan's own speed, with hysteresis so a corner with a
 * slight easing in the middle stays one corner instead of becoming two.
 */
import { G } from './car'
import type { RacingLine } from './racingLine'

/** Lateral demand that starts a corner, and the lower one that ends it. */
const ENTER = 0.6 * G
const EXIT = 0.35 * G

/** Corners shorter than this are noise, and get folded into their neighbour. */
const MIN_LENGTH = 25

export interface Segment {
  /** 'T3', 'S2' — turns and straights numbered separately, in lap order. */
  name: string
  corner: boolean
  /** Distance along the line, metres. `to` may be less than `from` at the wrap. */
  from: number
  to: number
  length: number
  /** Station indices, inclusive; wraps like `from`/`to`. */
  first: number
  last: number
}

/** Is station `i` inside this segment, wrap included? */
export function inSegment(s: Segment, i: number): boolean {
  return s.first <= s.last ? i >= s.first && i <= s.last : i >= s.first || i <= s.last
}

/**
 * Segment a planned line into turns and straights, in lap order.
 *
 * Numbering starts at the first corner ENTRY rather than at the timing line, so
 * a corner straddling the line comes out as one corner rather than two halves.
 * That is not a nicety here: Croft Bay's is exactly such a corner, and it is
 * the one that caps the lap.
 */
export function findCorners(line: RacingLine): Segment[] {
  const n = line.curvature.length
  const cornering = new Array<boolean>(n).fill(false)
  let on = false
  // Twice round, because a lap is a loop: the first station's state depends on
  // the last's, and one pass would start from an arbitrary guess.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const ay = line.speed[i]! ** 2 * Math.abs(line.curvature[i]!)
      if (!on && ay >= ENTER) on = true
      else if (on && ay < EXIT) on = false
      cornering[i] = on
    }
  }

  let start = 0
  while (start < n && !(cornering[start]! && !cornering[(start - 1 + n) % n]!)) start++
  if (start >= n) start = 0

  const segs: Segment[] = []
  let i = 0
  while (i < n) {
    const a = (start + i) % n
    const kind = cornering[a]!
    let len = 0
    while (len < n - i && cornering[(start + i + len) % n]! === kind) len++
    segs.push({
      name: '',
      corner: kind,
      from: line.dist[a]!,
      to: line.dist[(start + i + len - 1) % n]!,
      length: len * (line.total / n),
      first: a,
      last: (start + i + len - 1) % n,
    })
    i += len
  }

  // Fold away anything too short to be its own thing, into what came before.
  const kept: Segment[] = []
  for (const s of segs) {
    const prev = kept[kept.length - 1]
    if (s.length < MIN_LENGTH && prev) {
      prev.to = s.to
      prev.last = s.last
      prev.length += s.length
    } else kept.push(s)
  }

  let turn = 0
  let straight = 0
  for (const s of kept) s.name = s.corner ? `T${++turn}` : `S${++straight}`
  return kept
}
