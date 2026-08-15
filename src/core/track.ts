/**
 * Circuit geometry — the query half of ``racing/track.py``.
 *
 * The *generator* is deliberately absent. It draws from ``np.random.default_rng``,
 * and reproducing NumPy's PCG64 plus its bounded-integer, permutation and choice
 * algorithms closely enough to land on the same circuit is a lot of work with a
 * silent failure mode. A track is static data, so Python rolls the dice once in
 * ``export_web_assets.py`` and the browser loads the resulting polyline. The
 * circuit here is the same circuit the Python sim drives by construction.
 *
 * What *is* ported is everything the game asks of a track every tick: where am I
 * along the lap, how far off the centre, and how wide is the road here.
 */
import { pyMod } from './math'

/** The baked JSON written by ``export_web_assets.py``. */
export interface TrackData {
  id: string
  label: string
  blurb: string
  profile: string
  seed: number
  width: number
  length: number
  centerline: [number, number][]
  halfRing: number[]
  /** Per-vertex gap from painted edge to barrier wall. Absent in older bakes. */
  barrierGap?: { left: number[]; right: number[] }
  brakeMarkers: { s: number; distance: number; side: number }[]
}

/**
 * Fallback wall standoff for a track baked before `barrierGap` was exported.
 *
 * The flat 9.0 m the web renderer used to draw at unconditionally. A constant
 * gap is a worse wall than the exported one — no extra runoff on the outside
 * of a fast bend — but it is in a sane place, and it keeps an old track file
 * loading rather than crashing.
 */
const DEFAULT_BARRIER_GAP = 9.0

export interface Projection {
  /** arc-length progress along the centreline (m) */
  s: number
  /** signed offset from the centreline (m); positive is left of travel */
  lateral: number
  /** centreline tangent heading at the projection (rad) */
  heading: number
  /** index of the nearest centreline segment */
  segment: number
  /** how far along that segment the foot of the projection fell, 0..1 */
  frac: number
  /** half-width of the road *here* (m) */
  half: number
}

export interface BrakeMarker {
  s: number
  distance: number
  side: number
}

export class Track {
  readonly id: string
  readonly label: string
  readonly blurb: string
  readonly profile: string
  readonly seed: number
  readonly width: number
  readonly brakeMarkers: readonly BrakeMarker[]

  /** (N, 2) flattened as x0,y0,x1,y1,... — an open ring; last joins to first. */
  readonly cx: Float64Array
  readonly cy: Float64Array
  readonly n: number

  readonly length: number
  /**
   * The *maximum* half-width: the upper bound on how far the painted edge ever
   * gets from the centreline. Right for broad-phase bounds, wrong for "am I on
   * the road" — use ``Projection.half`` or ``halfAt`` for anything positional.
   */
  readonly half: number
  readonly halfRing: Float64Array
  /** Per-vertex standoff from the painted edge out to the wall, by side. */
  readonly barrierGapLeft: Float64Array
  readonly barrierGapRight: Float64Array
  private nearestBarrierCache: number | null = null
  private maxBarrierGapCache: number | null = null

  private readonly segVecX: Float64Array
  private readonly segVecY: Float64Array
  private readonly segLen: Float64Array
  private readonly segLen2: Float64Array
  /** cumulative arc length at the start of each segment */
  private readonly s0: Float64Array
  private readonly tanX: Float64Array
  private readonly tanY: Float64Array
  /** unit normals, left of travel: the tangent rotated +90 degrees */
  private readonly nrmX: Float64Array
  private readonly nrmY: Float64Array

  readonly curvature: Float64Array
  /** signed: positive is a left turn, matching the lateral-offset convention */
  readonly signedCurvature: Float64Array

  /** Left and right painted edges, for the renderer. */
  readonly leftX: Float64Array
  readonly leftY: Float64Array
  readonly rightX: Float64Array
  readonly rightY: Float64Array

  constructor(data: TrackData) {
    this.id = data.id
    this.label = data.label
    this.blurb = data.blurb
    this.profile = data.profile
    this.seed = data.seed
    this.width = data.width
    this.brakeMarkers = data.brakeMarkers

    const n = data.centerline.length
    this.n = n
    this.cx = new Float64Array(n)
    this.cy = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const p = data.centerline[i]!
      this.cx[i] = p[0]
      this.cy[i] = p[1]
    }

    this.halfRing = Float64Array.from(data.halfRing)
    let maxHalf = 0
    for (let i = 0; i < n; i++) maxHalf = Math.max(maxHalf, this.halfRing[i]!)
    this.half = maxHalf

    const flat = (): Float64Array => new Float64Array(n).fill(DEFAULT_BARRIER_GAP)
    this.barrierGapLeft = data.barrierGap
      ? Float64Array.from(data.barrierGap.left)
      : flat()
    this.barrierGapRight = data.barrierGap
      ? Float64Array.from(data.barrierGap.right)
      : flat()

    // Closed-loop segment geometry (the last segment wraps to the first point).
    this.segVecX = new Float64Array(n)
    this.segVecY = new Float64Array(n)
    this.segLen = new Float64Array(n)
    this.segLen2 = new Float64Array(n)
    this.tanX = new Float64Array(n)
    this.tanY = new Float64Array(n)
    this.nrmX = new Float64Array(n)
    this.nrmY = new Float64Array(n)

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const dx = this.cx[j]! - this.cx[i]!
      const dy = this.cy[j]! - this.cy[i]!
      this.segVecX[i] = dx
      this.segVecY[i] = dy
      // Guard degenerate segments exactly as the Python does, so a zero-length
      // join cannot produce a NaN normal.
      const len = Math.max(Math.hypot(dx, dy), 1e-9)
      this.segLen[i] = len
      this.segLen2[i] = len * len
      const tx = dx / len
      const ty = dy / len
      this.tanX[i] = tx
      this.tanY[i] = ty
      this.nrmX[i] = -ty
      this.nrmY[i] = tx
    }

    this.s0 = new Float64Array(n)
    let acc = 0
    for (let i = 0; i < n; i++) {
      this.s0[i] = acc
      acc += this.segLen[i]!
    }
    this.length = acc

    // Per-segment curvature (turn rate, rad/m): how fast the heading swings.
    this.curvature = new Float64Array(n)
    this.signedCurvature = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const a0 = Math.atan2(this.tanY[i]!, this.tanX[i]!)
      const a1 = Math.atan2(this.tanY[j]!, this.tanX[j]!)
      const dang = pyMod(a1 - a0 + Math.PI, 2.0 * Math.PI) - Math.PI
      this.curvature[i] = Math.abs(dang) / this.segLen[i]!
      this.signedCurvature[i] = dang / this.segLen[i]!
    }

    this.leftX = new Float64Array(n)
    this.leftY = new Float64Array(n)
    this.rightX = new Float64Array(n)
    this.rightY = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const h = this.halfRing[i]!
      this.leftX[i] = this.cx[i]! + this.nrmX[i]! * h
      this.leftY[i] = this.cy[i]! + this.nrmY[i]! * h
      this.rightX[i] = this.cx[i]! - this.nrmX[i]! * h
      this.rightY[i] = this.cy[i]! - this.nrmY[i]! * h
    }
  }

  /** Pose (x, y, yaw) at the start/finish line. */
  startPose(): { x: number; y: number; yaw: number } {
    return {
      x: this.cx[0]!,
      y: this.cy[0]!,
      yaw: Math.atan2(this.tanY[0]!, this.tanX[0]!),
    }
  }

  /**
   * Index of the segment containing arc length ``s``.
   *
   * Mirrors ``searchsorted(s0, s, side='right') - 1`` with the same clamping.
   */
  private segmentAt(s: number): number {
    const w = pyMod(s, this.length)
    let lo = 0
    let hi = this.n // first index with s0[index] > w
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.s0[mid]! <= w) lo = mid + 1
      else hi = mid
    }
    const i = lo - 1
    return Math.max(0, Math.min(i, this.n - 1))
  }

  /** Centreline pose (x, y, yaw) at arc length ``s`` (wrapped to the lap). */
  poseAt(s: number): { x: number; y: number; yaw: number } {
    const w = pyMod(s, this.length)
    const i = this.segmentAt(w)
    const frac = (w - this.s0[i]!) / this.segLen[i]!
    return {
      x: this.cx[i]! + this.segVecX[i]! * frac,
      y: this.cy[i]! + this.segVecY[i]! * frac,
      yaw: Math.atan2(this.tanY[i]!, this.tanX[i]!),
    }
  }

  /**
   * Signed road curvature (rad/m, positive is left) at arc length ``s``.
   *
   * Piecewise-constant per segment, which is exact here: the track is authored as
   * straights and circular arcs, so curvature really is constant within a
   * segment, bar the step at each join.
   */
  signedCurvatureAt(s: number): number {
    return this.signedCurvature[this.segmentAt(s)]!
  }

  /** Half-width of the road at arc length ``s`` (wrapped to the lap). */
  halfAt(s: number): number {
    return this.halfRing[this.segmentAt(s)]!
  }

  /** Length of segment ``i`` in metres — for renderers pacing things by arc. */
  segLenAt(i: number): number {
    return this.segLen[i]!
  }

  /** Unit normal of segment ``i``, left of travel. */
  normalX(i: number): number {
    return this.nrmX[i]!
  }

  normalY(i: number): number {
    return this.nrmY[i]!
  }

  /**
   * Nearest point on the centreline to (x, y).
   *
   * A straight scan over every segment, as in the Python. At ~700 segments and
   * two projections a frame this is a few tens of microseconds, so the spatial
   * index it could have is not worth the divergence risk. Ties resolve to the
   * lowest index, matching ``np.argmin``.
   */
  project(x: number, y: number): Projection {
    let best = Infinity
    let bi = 0
    let bt = 0

    for (let i = 0; i < this.n; i++) {
      const apx = x - this.cx[i]!
      const apy = y - this.cy[i]!
      let t = (apx * this.segVecX[i]! + apy * this.segVecY[i]!) / this.segLen2[i]!
      if (t < 0) t = 0
      else if (t > 1) t = 1
      const px = this.cx[i]! + this.segVecX[i]! * t
      const py = this.cy[i]! + this.segVecY[i]! * t
      const dx = x - px
      const dy = y - py
      const d2 = dx * dx + dy * dy
      if (d2 < best) {
        best = d2
        bi = i
        bt = t
      }
    }

    const px = this.cx[bi]! + this.segVecX[bi]! * bt
    const py = this.cy[bi]! + this.segVecY[bi]! * bt
    return {
      s: this.s0[bi]! + bt * this.segLen[bi]!,
      lateral: (x - px) * this.nrmX[bi]! + (y - py) * this.nrmY[bi]!,
      heading: Math.atan2(this.tanY[bi]!, this.tanX[bi]!),
      segment: bi,
      frac: bt,
      half: this.halfRing[bi]!,
    }
  }

  /**
   * How far off the centreline the wall stands at a point on a segment.
   *
   * Interpolated along the segment rather than taken per-vertex, and the road's
   * own half-width with it: a wall whose standoff stepped every 4 m would leave
   * a 4 m-wide ledge at every step for a car sliding along it to trip over, and
   * where the track tapers the wall has to taper with it.
   *
   * Ported from ``Barriers._limit`` in racing/barrier.py.
   */
  barrierLimit(segment: number, frac: number, right: boolean): number {
    const j = (segment + 1) % this.n
    const gaps = right ? this.barrierGapRight : this.barrierGapLeft
    const half = this.halfRing[segment]!
    const gap = gaps[segment]!
    return (
      half + (this.halfRing[j]! - half) * frac + gap + (gaps[j]! - gap) * frac
    )
  }

  /**
   * The wall's standoff from the painted edge at arc length ``s``.
   *
   * For scenery that hangs on the wall — sponsor boards along its crest, the
   * catch fence behind it. Those used to be placed against a flat 9 m constant,
   * which was fine while the drawn wall was also flat; against the real baked
   * gap, which runs from about 1.6 m to 36 m where a fast corner is given
   * runoff, a constant would leave boards floating in the infield.
   */
  barrierGapAt(s: number, right: boolean): number {
    const seg = this.segmentAt(s)
    const j = (seg + 1) % this.n
    const gaps = right ? this.barrierGapRight : this.barrierGapLeft
    const frac = (pyMod(s, this.length) - this.s0[seg]!) / this.segLen[seg]!
    const g = gaps[seg]!
    return g + (gaps[j]! - g) * Math.min(Math.max(frac, 0), 1)
  }

  /**
   * The furthest the wall ever stands from the painted edge.
   *
   * The conservative bound for "is this clear of the circuit" tests. Scenery
   * uses it rather than the local gap on purpose: a building wants to be beyond
   * the wall *everywhere*, and a lap that winds back past itself can bring a
   * distant corner's runoff near a spot the local lookup knows nothing about.
   */
  get maxBarrierGap(): number {
    if (this.maxBarrierGapCache === null) {
      let worst = 0
      for (let i = 0; i < this.n; i++) {
        worst = Math.max(worst, this.barrierGapLeft[i]!, this.barrierGapRight[i]!)
      }
      this.maxBarrierGapCache = worst
    }
    return this.maxBarrierGapCache
  }

  /** The closest the wall comes to the centreline anywhere on the lap. */
  get nearestBarrier(): number {
    if (this.nearestBarrierCache === null) {
      let best = Infinity
      for (let i = 0; i < this.n; i++) {
        const h = this.halfRing[i]!
        // Per-vertex min over (half + gap) on both sides, not max-half plus
        // min-gap: with a varying width those are different numbers, and the
        // latter over-estimates — which would let the broad-phase gate wave
        // away a contact that is really happening.
        best = Math.min(best, h + this.barrierGapLeft[i]!, h + this.barrierGapRight[i]!)
      }
      this.nearestBarrierCache = best
    }
    return this.nearestBarrierCache
  }

  isInside(x: number, y: number, margin = 0.0): boolean {
    const p = this.project(x, y)
    return Math.abs(p.lateral) <= p.half + margin
  }
}

/** Entry in ``public/tracks/manifest.json``. */
export interface TrackManifestEntry {
  id: string
  label: string
  blurb: string
  profile: string
  seed: number
  length: number
  corners: number
  file: string
  /** Lap shape, normalised into a unit box, for the circuit-select map. */
  outline: [number, number][]
  /** Width and height of that box, so a circuit is never drawn stretched. */
  outlineAspect: [number, number]
}

export async function loadManifest(base = './tracks'): Promise<TrackManifestEntry[]> {
  const res = await fetch(`${base}/manifest.json`)
  if (!res.ok) throw new Error(`could not load track manifest: ${res.status}`)
  return (await res.json()) as TrackManifestEntry[]
}

export async function loadTrack(id: string, base = './tracks'): Promise<Track> {
  const res = await fetch(`${base}/${id}.json`)
  if (!res.ok) throw new Error(`could not load track ${id}: ${res.status}`)
  return new Track((await res.json()) as TrackData)
}
