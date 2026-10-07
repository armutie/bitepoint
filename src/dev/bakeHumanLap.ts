/**
 * Turn a recorded human lap into the line the AI drives.
 *
 * Run with:  npx vite-node src/dev/bakeHumanLap.ts <lapfile.json> [--write]
 *
 * The Assetto Corsa approach, and on Croft Bay it is worth three and a quarter
 * seconds over our own optimiser: same follower, same car, same circuit, and the
 * only difference is which line it is handed. It works because it stops
 * predicting. Every argument about grip envelopes, ellipse exponents and
 * commitment exists to work out what the car CAN do; a recording says what it
 * DID, and no part of a model can be wrong about that.
 *
 * `commitment` becomes a fraction of the human's speed, which is a friendlier
 * knob than a fraction of modelled grip: every value below 1 is known to be
 * driveable, because a slower pass through the same geometry cannot need more
 * grip than the original.
 *
 * `--straighten <from> <to>` replaces a stretch with a smooth line between its
 * two ends. A human on a mouse can flick, and a flick is not a racing line: at
 * the Croft Bay timing line one showed up as a 4.6 m dive and recovery on a
 * STRAIGHT road, demanding 6.5 g in each direction. That is not something the
 * car can do, so the follower cannot track it and simply loses time fighting it.
 *
 * Only safe where the road is genuinely straight or gently curved, because it
 * rebuilds the points through the centreline — the one operation that is
 * ambiguous at a hairpin. Check the road radius over the window first.
 *
 * Without `--write` this only reports. The existing line is overwritten when
 * asked, so keep a copy.
 */
import { bakedLinePath, BAKED_LINE_VERSION, type BakedLine } from '../core/bakedLines'
import { lineFromPoints, modelLapTime, planningEnvelope } from '../core/racingLine'
import { ggvAt, measureGgv } from '../core/ggv'
import { fastestLap } from '../core/referenceDriver'
import { handlingPreset, type PresetName } from '../core/carParams'
import { OFF_TRACK_MARGIN } from '../core/sim'
import { Track, type TrackData } from '../core/track'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const file = process.argv[2]!
const write = process.argv.includes('--write')
const rec = JSON.parse(readFileSync(file, 'utf-8')) as {
  trackId: string; preset: string; easy?: boolean; time: number
  path: Record<string, number>
}
const pub = fileURLToPath(new URL('../../public/', import.meta.url))
const track = new Track(
  JSON.parse(readFileSync(`${pub}tracks/${rec.trackId}.json`, 'utf-8')) as TrackData)
const p = handlingPreset(rec.preset as PresetName)

const path = Object.values(rec.path)
const STRIDE = 6
const poses = Math.floor(path.length / STRIDE)
console.log(`${rec.trackId} / ${rec.preset}${rec.easy ? ' / easy' : ''}` +
  `   human ${rec.time.toFixed(3)} s, ${poses} poses`)

// Resample the driven path by ITS OWN arc length, never by centreline distance.
const cum = new Float64Array(poses)
for (let i = 1; i < poses; i++) {
  cum[i] = cum[i - 1]! + Math.hypot(
    path[i * STRIDE]! - path[(i - 1) * STRIDE]!,
    path[i * STRIDE + 1]! - path[(i - 1) * STRIDE + 1]!)
}
const pathLen = cum[poses - 1]! + Math.hypot(
  path[0]! - path[(poses - 1) * STRIDE]!, path[1]! - path[(poses - 1) * STRIDE + 1]!)
const n = Math.max(64, Math.round(pathLen / 3))
const rx = new Float64Array(n)
const ry = new Float64Array(n)
const rv = new Float64Array(n)
let cursor = 0
for (let i = 0; i < n; i++) {
  const want = (i * pathLen) / n
  while (cursor + 1 < poses - 1 && cum[cursor + 1]! < want) cursor++
  const a = cursor
  const b = Math.min(cursor + 1, poses - 1)
  const span = cum[b]! - cum[a]!
  const f = span > 1e-9 ? (want - cum[a]!) / span : 0
  rx[i] = path[a * STRIDE]! + (path[b * STRIDE]! - path[a * STRIDE]!) * f
  ry[i] = path[a * STRIDE + 1]! + (path[b * STRIDE + 1]! - path[a * STRIDE + 1]!) * f
  rv[i] = Math.abs(path[a * STRIDE + 4]!)
    + (Math.abs(path[b * STRIDE + 4]!) - Math.abs(path[a * STRIDE + 4]!)) * f
}

/** Light smoothing: a human wanders centimetres, and over 3 m that reads as a corner. */
function smooth(src: Float64Array, span: number): Float64Array {
  const out = new Float64Array(src.length)
  for (let i = 0; i < src.length; i++) {
    let sum = 0
    for (let d = -span; d <= span; d++) sum += src[(i + d + src.length * 2) % src.length]!
    out[i] = sum / (2 * span + 1)
  }
  return out
}
const x = smooth(rx, 2)
const y = smooth(ry, 2)
const speed = smooth(rv, 2)

const si = process.argv.indexOf('--straighten')
if (si >= 0) {
  const from = Number(process.argv[si + 1])
  const to = Number(process.argv[si + 2])
  const L = track.length
  const span = ((to - from + L) % L) || L

  // A CUBIC HERMITE that matches position AND SLOPE at both ends.
  //
  // Two earlier attempts got this wrong in instructive ways. The first
  // interpolated between two anchors picked by ARRAY INDEX — and the window
  // straddles the start of the array, so "the point before the window" was
  // index 0, already inside it, and the repair ran over the whole lap and
  // dragged the hairpin apex twelve metres across the road.
  //
  // The second replaced the flick with a straight chord, tapered at the ends so
  // the joins could not move. That is safe but wrong in shape: the line here is
  // a car tracking out of a hairpin, so its lateral position is still climbing
  // steeply at the entry to the window. A chord ignores that and starts flat,
  // which left the flick half-uncorrected inside the taper — 6.45 g down to
  // 3.16 g, when the car can only do about 2.4 g at that speed.
  //
  // Matching the slope fixes both: it leaves the corner exit continuing exactly
  // as it was, eases it out to where the line settles on the straight, and joins
  // at both ends with no kink, so nothing outside the window has to be touched.
  const sample = (_seed: number): { at: (want: number) => number } => {
    // Read the ORIGINAL line either side of `target` to get its gradient. Both
    // reads are outside the window, so neither is contaminated by the flick.
    const at = (want: number): number => {
      let best = 0
      let bestGap = Infinity
      for (let i = 0; i < n; i++) {
        const proj = track.project(x[i]!, y[i]!)
        const raw = Math.abs(proj.s - want)
        const gap = Math.min(raw, L - raw)
        if (gap < bestGap) { bestGap = gap; best = proj.lateral }
      }
      return best
    }
    return { at }
  }
  const { at } = sample(0)
  // Endpoints sit EXACTLY on the joins, with one-sided slopes taken from the
  // clean line outside the window. Sampling the anchor six metres short of the
  // join and then starting the curve at the join put a 0.9 m step there, which
  // the curvature smoothing then smeared twelve metres back up the road and
  // turned into a 2.5 g bump in a corner exit that had been fine.
  const H = 12
  const a = { lat: at(from), slope: (at(from) - at(((from - H) % L + L) % L)) / H }
  const b = { lat: at(to), slope: (at((to + H) % L) - at(to)) / H }

  // The SPEED has to be repaired too, and forgetting that was the whole point
  // of the exercise undone. A flick costs speed — the driver scrubs it doing
  // the flick — so the recording has a plateau sitting exactly under it. Fix
  // the geometry alone and the car drives a straight line while still slowing
  // as though it were flicking: the plan's throttle fell from 0.88 to 0.17
  // across the timing line and it visibly lifted.
  //
  // Same Hermite, same joins. The result is checked against what the car can
  // actually accelerate at, below, because a speed nobody can reach is just a
  // different way of being wrong.
  const speedAt = (want: number): number => {
    let best = 0
    let bestGap = Infinity
    for (let i = 0; i < n; i++) {
      const proj = track.project(x[i]!, y[i]!)
      const raw = Math.abs(proj.s - want)
      const gap = Math.min(raw, L - raw)
      if (gap < bestGap) { bestGap = gap; best = speed[i]! }
    }
    return best
  }
  const va = { v: speedAt(from), slope: (speedAt(from) - speedAt(((from - H) % L + L) % L)) / H }
  const vb = { v: speedAt(to), slope: (speedAt((to + H) % L) - speedAt(to)) / H }

  let moved = 0
  let touched = 0
  let fastestAsked = 0
  let hardestAccel = 0
  const nx2 = Float64Array.from(x)
  const ny2 = Float64Array.from(y)
  for (let i = 0; i < n; i++) {
    const proj = track.project(x[i]!, y[i]!)
    const u = ((proj.s - from + L) % L) / span
    if (u <= 0 || u >= 1) continue
    touched++
    // Hermite basis, with the tangents scaled by the span so the slopes are in
    // metres-per-metre rather than per-window.
    const u2 = u * u
    const u3 = u2 * u
    const lateral =
      (2 * u3 - 3 * u2 + 1) * a.lat
      + (u3 - 2 * u2 + u) * span * a.slope
      + (-2 * u3 + 3 * u2) * b.lat
      + (u3 - u2) * span * b.slope
    const centre = track.poseAt(proj.s)
    moved = Math.max(moved, Math.abs(lateral - proj.lateral))
    nx2[i] = centre.x + -Math.sin(centre.yaw) * lateral
    ny2[i] = centre.y + Math.cos(centre.yaw) * lateral
    const v = (2 * u3 - 3 * u2 + 1) * va.v
      + (u3 - 2 * u2 + u) * span * va.slope
      + (-2 * u3 + 3 * u2) * vb.v
      + (u3 - u2) * span * vb.slope
    // dv/ds times v is the acceleration this asks the car for. Interpolating
    // between the two ends rather than integrating forward at whatever the car
    // could manage is deliberate: a clean run from the window's entry arrives
    // about 20 km/h faster than the human did, and all of that has to be given
    // back at the join — which is a lift in a different place. Matching both
    // ends keeps the repair local. It only has to be achievable, not optimal.
    const dvds = ((-6 * u2 + 6 * u) * (vb.v - va.v)) / span
      + (3 * u2 - 4 * u + 1) * va.slope + (3 * u2 - 2 * u) * vb.slope
    hardestAccel = Math.max(hardestAccel, Math.abs(v * dvds))
    fastestAsked = Math.max(fastestAsked, v - speed[i]!)
    speed[i] = v
    if (process.argv.includes('--debug')) {
      console.log(`      s=${proj.s.toFixed(0).padStart(4)} u=${u.toFixed(2)}` +
        ` was=${proj.lateral.toFixed(2).padStart(6)} now=${lateral.toFixed(2).padStart(6)}`)
    }
  }
  x.set(nx2)
  y.set(ny2)
  console.log(`  straightened ${from}-${to} m (${touched} of ${n} points):` +
    ` ${a.lat.toFixed(2)} m at slope ${a.slope.toFixed(3)}` +
    ` to ${b.lat.toFixed(2)} m at slope ${b.slope.toFixed(3)},` +
    ` moved the line up to ${moved.toFixed(2)} m,` +
    ` and asks for up to ${(fastestAsked * 3.6).toFixed(1)} km/h more speed,` +
    ` needing ${(hardestAccel / 9.81).toFixed(2)} g to do it`)
}

const line = lineFromPoints(track, p, x, y, speed)
let worstRoom = Infinity
for (let i = 0; i < n; i++) {
  const proj = track.project(x[i]!, y[i]!)
  worstRoom = Math.min(worstRoom, proj.half + OFF_TRACK_MARGIN - Math.abs(proj.lateral))
}
console.log(`  ${n} points over ${pathLen.toFixed(0)} m,` +
  ` closest to the edge ${worstRoom.toFixed(2)} m`)
console.log(`  speeds ${(Math.min(...speed) * 3.6).toFixed(0)}` +
  `-${(Math.max(...speed) * 3.6).toFixed(0)} km/h,` +
  ` integrates to ${modelLapTime(line).toFixed(3)} s`)

// Where does the line ask for more grip than the car HAS AT THAT SPEED?
//
// Against the measured envelope, not a flat number. The first version of this
// flagged a 3.65 g corner as impossible — and it was a real 85 m bend taken at
// 240 km/h, where downforce gives the car about 3.6 g. A constant threshold
// cannot tell a flick from a fast corner; only the envelope can.
const ggv = planningEnvelope(p, measureGgv(p))
let worstFrac = 0
let worstAt = 0
let worstAy = 0
for (let i = 0; i < n; i++) {
  const ay = line.speed[i]! ** 2 * Math.abs(line.curvature[i]!)
  const frac = ay / Math.max(ggvAt(ggv, ggv.ay, line.speed[i]!), 1e-6)
  if (frac > worstFrac) {
    worstFrac = frac
    worstAy = ay / 9.81
    worstAt = track.project(line.x[i]!, line.y[i]!).s
  }
}
console.log(`  hardest demand on the line: ${worstAy.toFixed(2)} g at s=${worstAt.toFixed(0)} m` +
  ` — ${(worstFrac * 100).toFixed(0)}% of what the car has there` +
  `${worstFrac > 1.15 ? '   <- look at it' : ''}`)

const best = fastestLap(track, p, rec.trackId, line)
console.log(`  the follower drives it at ${(best.commitment * 100).toFixed(0)}% of the` +
  ` human's speed: ${best.time === null ? 'NO VALID LAP' : `${best.time.toFixed(3)} s`}`)

if (!write) {
  console.log('\n  (report only — pass --write to replace the baked line)')
} else {
  const baked: BakedLine = {
    version: BAKED_LINE_VERSION,
    trackId: rec.trackId,
    preset: rec.preset,
    offsets: Array.from(line.offset, (v) => Number(v.toFixed(4))),
    station: track.length / n,
    modelLap: Number(modelLapTime(line).toFixed(3)),
    // The REAL envelope, not a stub.
    //
    // It was a stub while nothing read it, and then something did: a driver
    // planning its own corner speeds needs to know what the car can hold, and
    // reading that off a placeholder would have it braking for corners that
    // are not there or arriving at ones that are.
    ggv: {
      v: Array.from(ggv.v),
      ay: Array.from(ggv.ay),
      muScale: Array.from(ggv.muScale ?? []),
      axBrake: Array.from(ggv.axBrake),
      axDrive: Array.from(ggv.axDrive),
      ellipse: ggv.ellipse,
    },
    // Full precision. Rounding these to a tenth of a millimetre moved the
    // driven lap 0.23 s, because the commitment search bisects on whether a lap
    // stays valid and an accept can flip on the last bit. The same thing caught
    // the grip envelope earlier.
    points: { x: Array.from(x), y: Array.from(y), speed: Array.from(speed) },
  }
  const out = `${pub}lines/${bakedLinePath(rec.trackId, rec.preset)}`
  writeFileSync(out, JSON.stringify(baked))
  console.log(`\n  written to ${out}`)
}
