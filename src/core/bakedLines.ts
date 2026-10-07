/**
 * Racing lines found once, offline, and loaded at race time.
 *
 * Finding a line is a coordinate descent over roughly thirty thousand full lap
 * evaluations — half a minute of blocked arithmetic. That is fine for a
 * development view and impossible for a race: nobody waits half a minute on a
 * loading screen every time they press start, and doing it on the main thread
 * would freeze the tab while they did.
 *
 * It also does not need doing more than once. The line for a given car on a
 * given circuit is deterministic and never changes, so it is computed by
 * `npm run bake-lines` and shipped as an asset beside the circuit itself.
 * Loading one and turning it back into a driveable line is `lineFromOffsets`,
 * which is a few hundred microseconds.
 *
 * WHAT IS NOT BAKED, deliberately: the speed profile. Only the OFFSETS travel,
 * because the profile depends on commitment and every car in the field runs a
 * different one. `atCommitment` rebuilds it per driver, which is O(stations)
 * and costs nothing worth measuring.
 */
import { lineFromOffsets, lineFromPoints, type RacingLine } from './racingLine'
import type { Ggv } from './ggv'
import type { CarParams } from './carParams'
import type { Track } from './track'

/** The shape of a baked line file. */
export interface BakedLine {
  /** Schema version, so an old file is rejected rather than misread. */
  version: 2
  trackId: string
  preset: string
  /** Lateral offset from the centreline at each station (m, +left). */
  offsets: number[]
  /** Metres between stations the offsets were sampled at, for a sanity check. */
  station: number
  /** What the model thought the line was worth, for the bake log only. */
  modelLap: number
  /**
   * The grip envelope this line was PLANNED against.
   *
   * Carried in the file rather than measured at load, for two reasons.
   * Measuring costs a second of blocked arithmetic and the answer never
   * changes; and more importantly the line and its envelope have to match. The
   * offsets are the answer to "where is fastest GIVEN these limits", and
   * `atCommitment` rebuilds every driver's speeds from them at race time — so a
   * line loaded against a different envelope than it was found under is a line
   * driven to limits it was not drawn for.
   */
  ggv: BakedGgv
  /**
   * A line taken from a lap that was DRIVEN, as world coordinates and the
   * speeds the driver carried.
   *
   * Present instead of `offsets` when the line came from a recording. It has to
   * be coordinates rather than offsets: turning a driven path into offsets
   * means projecting onto the centreline, which is ambiguous at a hairpin and
   * reconstructed a physically impossible lap out of a real one. When this is
   * here, `offsets` and `ggv` are decoration — nothing is modelled.
   */
  points?: { x: number[]; y: number[]; speed: number[] }
}

/**
 * A `Ggv` as it travels in a file: plain arrays, no typed arrays.
 *
 * Only `v`, `ay` and `muScale` are read when planning — the lateral limit and
 * the calibration of the model's cornering against it. The longitudinal columns
 * travel so a baked file can still be diagnosed on its own, and because leaving
 * them out would make the file describe less than it was measured from.
 *
 * `muScale` is not optional in practice: without it the loaded line plans
 * UNCALIBRATED, which is a different and slower car than the one the offsets
 * were found for. That cost 0.3 s and looked like bake drift.
 */
export interface BakedGgv {
  v: number[]
  ay: number[]
  muScale: number[]
  axBrake: number[]
  axDrive: number[]
  ellipse: number
}

/** Bumped to 2 when the measured envelope moved into the file. */
export const BAKED_LINE_VERSION = 2

/** Where a circuit's baked line for a given car lives. */
export const bakedLinePath = (trackId: string, preset: string): string =>
  `${trackId}.${preset}.json`

/**
 * Load the baked line for a circuit and car, or null if there is not one.
 *
 * Null rather than throwing: a missing bake is a normal state for a circuit
 * added since the last one, and the caller decides whether to fall back to
 * building live or to refuse the race.
 */
export async function loadBakedLine(
  trackId: string, preset: string, base = './lines',
): Promise<BakedLine | null> {
  let res: Response
  try {
    res = await fetch(`${base}/${bakedLinePath(trackId, preset)}`)
  } catch {
    return null
  }
  if (!res.ok) return null
  const data = (await res.json()) as BakedLine
  if (data.version !== BAKED_LINE_VERSION) {
    console.warn(
      `[lines] ${trackId}/${preset} is version ${data.version},` +
      ` this build reads ${BAKED_LINE_VERSION} — ignoring it`,
    )
    return null
  }
  if (data.points && Array.isArray(data.points.x) && data.points.x.length > 32) return data
  if (!Array.isArray(data.offsets) || data.offsets.length < 32) {
    console.warn(`[lines] ${trackId}/${preset} has no usable offsets — ignoring it`)
    return null
  }
  if (data.points) return data
  if (!data.ggv || !Array.isArray(data.ggv.v) || data.ggv.v.length < 2
    || !Array.isArray(data.ggv.muScale) || data.ggv.muScale.length !== data.ggv.v.length) {
    console.warn(`[lines] ${trackId}/${preset} carries no grip envelope — ignoring it`)
    return null
  }
  return data
}

/**
 * Turn a baked file into a driveable line for one car at one commitment.
 *
 * The station count has to match what `buildRacingLine` would produce for this
 * circuit, since the offsets are positional. A mismatch means the circuit was
 * re-exported at a different length after the bake, and the honest answer is to
 * refuse rather than to drive a line that is subtly rotated round the lap.
 */
export function bakedToLine(
  baked: BakedLine, track: Track, p: CarParams, commitment: number,
): RacingLine | null {
  // A recorded line carries its own geometry and its own speeds, so there is no
  // station grid to check against and nothing to rebuild from a model.
  if (baked.points) {
    return lineFromPoints(
      track, p,
      Float64Array.from(baked.points.x),
      Float64Array.from(baked.points.y),
      Float64Array.from(baked.points.speed),
      commitment,
      // The measured envelope travels with the line so a driver planning its
      // own corner speeds asks the right car what it can hold.
      toGgv(baked.ggv),
    )
  }
  const expected = Math.max(32, Math.round(track.length / baked.station))
  if (baked.offsets.length !== expected) {
    console.warn(
      `[lines] ${baked.trackId}/${baked.preset} has ${baked.offsets.length} stations,` +
      ` this circuit wants ${expected} — the bake is stale`,
    )
    return null
  }
  return lineFromOffsets(track, p, Float64Array.from(baked.offsets), commitment, toGgv(baked.ggv))
}

/** Rehydrate a baked envelope into the typed arrays the profile reads. */
export function toGgv(baked: BakedGgv): Ggv {
  return {
    v: Float64Array.from(baked.v),
    ay: Float64Array.from(baked.ay),
    muScale: Float64Array.from(baked.muScale),
    axBrake: Float64Array.from(baked.axBrake),
    axDrive: Float64Array.from(baked.axDrive),
    ellipse: baked.ellipse,
  }
}
