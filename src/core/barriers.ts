/**
 * The barrier wall as something you can hit. A port of ``racing/barrier.py``.
 *
 * The test is not a mesh collision, and deliberately so. The wall is *defined*
 * as an offset from the painted edge — `track.barrierLimit(...)` — so a corner
 * of the car is inside the wall exactly when its lateral offset from the
 * centreline exceeds that. Three consequences, all of which a box-by-box mesh
 * test would have made work for:
 *
 * - **No joins to leak through.** The wall is a continuous closed curve rather
 *   than a chain of abutting boxes, so there is no seam for a car to catch on
 *   or slip into, and no internal-edge case where a separating-axis test hands
 *   back a normal pointing *along* the wall and snags a car sliding down it.
 * - **No tunnelling.** Being inside the wall is a test on position, not on
 *   overlap with a thin slab, so it holds however far the car moved this tick.
 *   Flat out that is ~1.5 m, comfortably more than a barrier is thick.
 * - **What you hit is what was drawn.** Both come from the same `barrierGap`
 *   array, baked by `export_web_assets.py` from the very function pygame's
 *   walls come from. They cannot drift apart, because there is only one of
 *   them.
 */
import type { CarState } from './car.ts'
import type { CarParams } from './carParams.ts'
import { carLength } from './carParams.ts'
import { carCorners, resolveStatic, type Contact } from './collision.ts'
import type { Track } from './track.ts'

/**
 * Concrete and carbon fibre: barely elastic, and grippy enough that a car
 * sliding along the wall scrubs speed hard instead of skating down it.
 * Restitution stays low on purpose — a wall that flings you back across the
 * track is a worse outcome than a wall that stops you, and much less like the
 * real thing.
 */
export const WALL_RESTITUTION = 0.28
export const WALL_FRICTION = 0.55
/**
 * Two passes lets a car shoved into the *other* wall of a narrow section
 * settle, rather than being volleyed between them for a frame.
 */
const ITERATIONS = 2

export class Barriers {
  private readonly track: Track
  /** Scratch corner ring, reused every tick rather than reallocated. */
  private readonly ring = new Float64Array(8)

  constructor(track: Track) {
    this.track = track
  }

  /**
   * Could a car at this lateral offset be touching a wall at all?
   *
   * A cheap, conservative gate, and worth having: without it the four-corner
   * projection runs every tick, and the answer is "no" for the whole of any
   * normal lap. The bound uses the closest the wall comes to the centreline
   * anywhere, so it can only ever err toward doing the full test.
   */
  mayTouch(lateral: number, p: CarParams): boolean {
    const reach = 0.5 * Math.hypot(carLength(p), p.width)
    return Math.abs(lateral) + reach >= this.track.nearestBarrier
  }

  /** The car's deepest penetration into either wall, or null if clear. */
  contact(s: CarState, p: CarParams): Contact | null {
    const ring = carCorners(s, p, this.ring)

    let deepest = -1
    let depth = 0
    let deepSeg = 0
    let deepLateral = 0
    // Centroid of the corners that are in — see the note on `point` below.
    let sumX = 0
    let sumY = 0
    let count = 0

    for (let k = 0; k < 4; k++) {
      const cx = ring[k * 2]!
      const cy = ring[k * 2 + 1]!
      const proj = this.track.project(cx, cy)
      const limit = this.track.barrierLimit(proj.segment, proj.frac, proj.lateral < 0.0)
      const over = Math.abs(proj.lateral) - limit
      if (over <= 0.0) continue
      sumX += cx
      sumY += cy
      count++
      if (deepest < 0 || over > depth) {
        deepest = k
        depth = over
        deepSeg = proj.segment
        deepLateral = proj.lateral
      }
    }
    if (deepest < 0) return null

    // Push back toward the track, along the road normal at the deepest corner.
    const sign = deepLateral < 0 ? 1 : -1
    // Contact at the centroid of the corners that are in: a flat slide down the
    // wall has no business spinning the car, while a corner poke very much
    // does, and the centroid is that corner exactly when the corner is all that
    // touched.
    return {
      depth,
      nx: sign * this.track.normalX(deepSeg),
      ny: sign * this.track.normalY(deepSeg),
      px: sumX / count,
      py: sumY / count,
    }
  }

  /**
   * Resolve the car against the wall. Returns the peak impulse (N·s), 0 if
   * clear.
   */
  resolve(s: CarState, p: CarParams): number {
    let peak = 0.0
    for (let i = 0; i < ITERATIONS; i++) {
      const hit = this.contact(s, p)
      if (hit === null) break
      peak = Math.max(peak, resolveStatic(s, p, hit, WALL_RESTITUTION, WALL_FRICTION))
    }
    return peak
  }
}
