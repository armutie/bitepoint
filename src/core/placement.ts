/**
 * Putting things beside a circuit without putting them on it.
 *
 * Offsetting a closed curve sideways is not safe in general, and a racing
 * circuit is the case where it bites: push a point 60 m off the outside of a
 * corner and on a tight lap it walks across the infield and lands on a
 * different part of the track. Python solves this for the barrier wall in
 * ``scenery._clamp_off_track``; everything the renderer stands *behind* the
 * wall needs the same treatment, and used not to have it.
 *
 * These live in core rather than in the renderer because they are geometry, and
 * because the invariant they exist to hold is worth a test — which is how the
 * bug that prompted them was found in the first place. Grandstands on the road
 * through Croft Bay's second sector.
 */
import type { Track } from './track'

/**
 * Is this point clear of the circuit — outside the wall where it actually
 * landed, rather than where it was measured from?
 *
 * Uses the same `barrierLimit` the collision does, so "clear of the circuit"
 * means exactly one thing in this codebase.
 */
export function clearOfCircuit(track: Track, x: number, y: number, margin = 0): boolean {
  const p = track.project(x, y)
  return Math.abs(p.lateral) >= track.barrierLimit(p.segment, p.frac, p.lateral < 0) + margin
}

/**
 * Lateral offset putting a point `beyond` metres outside the wall. +1 is left.
 *
 * The wall's own standoff, not a constant: it runs from under 4 m down a
 * straight to 35 m across the outside of a quick corner, and a fixed offset
 * from the painted edge would cross it wherever the runoff opened up.
 */
export function outsideWall(
  track: Track, arc: number, side: number, beyond: number,
): number {
  return side * (track.halfAt(arc) + track.barrierGapAt(arc, side < 0) + beyond)
}

/** The world point at an arc position and lateral offset. */
export function pointAt(
  track: Track, arc: number, lateral: number,
): { x: number; y: number } {
  const pose = track.poseAt(arc)
  return {
    x: pose.x - Math.sin(pose.yaw) * lateral,
    y: pose.y + Math.cos(pose.yaw) * lateral,
  }
}

/**
 * `outsideWall`, pulled in until the point is genuinely clear of the circuit —
 * or null when no offset on this side is clear at all.
 *
 * Backing off is usually enough: a stand that wanted 24 m of room behind the
 * wall and cannot have it ends up tight against the wall instead of in the
 * middle of the road.
 *
 * But sometimes there is nowhere. `scenery._clamp_off_track` guarantees the
 * wall is never on the tarmac; it does not, and cannot, guarantee that a point
 * just outside one wall is not inside another. Where a circuit doubles back on
 * itself the two walls face each other across a narrow strip, and every point
 * between them is inside one of the two. Croft Bay has such a place at arc
 * 1233. The honest answer there is that no scenery fits, so callers get null
 * and skip, rather than being handed a plausible-looking spot on the road.
 */
/**
 * Clearance margin for an object of this footprint, in metres.
 *
 * The blunt instrument: a half-diagonal, so the footprint is clear whichever
 * way the object is turned. Right for a point-ish object, wrong for a long one
 * — a 46 m car park needs 24.7 m of clearance under this rule and is refused
 * everywhere, which loses scenery that would have fitted perfectly well lying
 * along the road. Prefer `safeOutsideBox` when the object's orientation is
 * known, and keep this for round-ish things and for anchors.
 */
export const footprintMargin = (length: number, width: number): number =>
  0.5 * Math.hypot(length, width)

/**
 * `safeOutside` for a box laid ALONG the road, tested at its actual corners.
 *
 * Exact where `footprintMargin` is conservative. A building placed beside a
 * circuit is turned to face the road, so its length runs with the tarmac and
 * only its depth reaches away — and where the road curves out from under its
 * far end, the corners are what tell you, not a radius around the anchor.
 *
 * Corners plus edge midpoints: a 46 m slab can clear both ends and still bow
 * through a corner apex in the middle.
 */
export function safeOutsideBox(
  track: Track, arc: number, side: number, beyond: number,
  length: number, width: number,
): number | null {
  const pose = track.poseAt(arc)
  const fx = Math.cos(pose.yaw)
  const fy = Math.sin(pose.yaw)

  for (let b = beyond; b > 0.4; b *= 0.55) {
    const off = outsideWall(track, arc, side, b)
    const c = pointAt(track, arc, off)
    let ok = true
    for (const u of [-0.5, -0.25, 0, 0.25, 0.5]) {
      for (const v of [-0.5, 0, 0.5]) {
        const du = u * length
        const dv = v * width
        // Local +x runs along the road, local +y across it.
        const x = c.x + fx * du - fy * dv
        const y = c.y + fy * du + fx * dv
        if (!clearOfCircuit(track, x, y)) {
          ok = false
          break
        }
      }
      if (!ok) break
    }
    if (ok) return off
  }
  return null
}

export function safeOutside(
  track: Track, arc: number, side: number, beyond: number, margin = 1.0,
): number | null {
  for (let b = beyond; b > 0.4; b *= 0.55) {
    const off = outsideWall(track, arc, side, b)
    const p = pointAt(track, arc, off)
    if (clearOfCircuit(track, p.x, p.y, margin)) return off
  }
  return null
}
