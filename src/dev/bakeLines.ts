/**
 * Find every racing line once and write it beside the circuits.
 *
 * Run with:  npm run bake-lines            (all circuits, all menu cars)
 *            npm run bake-lines -- balanced_8 classic
 *
 * Race mode cannot afford to search for a line at the moment the lights go out
 * — it is half a minute of blocked main thread — and it does not have to,
 * because the answer is the same every time. This produces
 * `public/lines/<track>.<car>.json`, which `bakedLines.ts` loads and
 * `lineFromOffsets` turns back into a driveable line in well under a
 * millisecond.
 *
 * The measured grip envelope is written alongside the offsets, because the two
 * belong together: the offsets are the answer to "where is fastest given THESE
 * limits", and `atCommitment` rebuilds each driver's speeds from them at race
 * time. Measuring it is a second per car, so it is cached across circuits.
 *
 * Only the OFFSETS are written. The speed profile depends on commitment and
 * every car in a field runs a different one, so it is rebuilt per driver at
 * load time by `atCommitment`.
 *
 * Rerun this whenever a circuit is re-exported, `EDGE_MARGIN` or `STATION`
 * changes, or the grip model in `racingLine.ts` changes — all four move the
 * line, and a stale bake is refused at load rather than driven.
 */
import { buildRacingLine, modelLapTime, planningEnvelope } from '../core/racingLine'
import { measureGgv } from '../core/ggv'
import {
  BAKED_LINE_VERSION, bakedLinePath, type BakedGgv, type BakedLine,
} from '../core/bakedLines'
import { handlingPreset, PRESET_INFO, type PresetName } from '../core/carParams'
import { Track, type TrackData, type TrackManifestEntry } from '../core/track'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const publicDir = fileURLToPath(new URL('../../public/', import.meta.url))
const outDir = `${publicDir}lines/`

const manifest = JSON.parse(
  readFileSync(`${publicDir}tracks/manifest.json`, 'utf-8'),
) as TrackManifestEntry[]

const args = process.argv.slice(2)
/** Cars the menu can actually put on a grid — there is no point baking the rest. */
const allPresets = Object.keys(PRESET_INFO) as PresetName[]
const tracks = args.length ? [args[0]!] : manifest.map((t) => t.id)
const presets = args.length > 1 ? [args[1]! as PresetName] : allPresets

/** One measurement per car, reused across every circuit it is baked for. */
const envelopes = new Map<PresetName, ReturnType<typeof planningEnvelope>>()
const envelopeFor = (preset: PresetName): ReturnType<typeof planningEnvelope> => {
  let e = envelopes.get(preset)
  if (!e) {
    const p = handlingPreset(preset)
    e = planningEnvelope(p, measureGgv(p))
    envelopes.set(preset, e)
  }
  return e
}

// Full precision, not rounded.
//
// Four decimals looked harmless — five parts per million on a grip figure — and
// it moved the line 78 mm and the driven lap 0.2 s. The commitment search
// bisects on whether a lap stays valid, so an accept/reject can flip on the
// last bit and land a whole step away. The offsets are rounded because they are
// the ANSWER; the envelope is an INPUT, and an input that differs gives a
// different answer to the one that was measured.
const asBaked = (g: ReturnType<typeof planningEnvelope>): BakedGgv => ({
  v: Array.from(g.v),
  ay: Array.from(g.ay),
  muScale: Array.from(g.muScale ?? []),
  axBrake: Array.from(g.axBrake),
  axDrive: Array.from(g.axDrive),
  ellipse: g.ellipse,
})

mkdirSync(outDir, { recursive: true })

console.log(`baking ${tracks.length} circuit(s) x ${presets.length} car(s) into ${outDir}\n`)
const started = Date.now()
let written = 0

for (const trackId of tracks) {
  const track = new Track(
    JSON.parse(readFileSync(`${publicDir}tracks/${trackId}.json`, 'utf-8')) as TrackData,
  )
  for (const preset of presets) {
    const p = handlingPreset(preset)
    const t0 = Date.now()
    const ggv = envelopeFor(preset)
    const line = buildRacingLine(track, p, { ggv })
    const baked: BakedLine = {
      version: BAKED_LINE_VERSION,
      trackId,
      preset,
      // Six decimals is a tenth of a millimetre — far past anything the search
      // resolves, and it keeps the file a third of the size of raw doubles.
      offsets: Array.from(line.offset, (v) => Number(v.toFixed(6))),
      station: track.length / line.offset.length,
      modelLap: Number(modelLapTime(line).toFixed(3)),
      ggv: asBaked(ggv),
    }
    writeFileSync(`${outDir}${bakedLinePath(trackId, preset)}`, JSON.stringify(baked))
    written++
    console.log(
      `  ${trackId.padEnd(15)} ${preset.padEnd(9)}` +
      ` ${line.offset.length} stations  model ${baked.modelLap.toFixed(2)} s` +
      `  ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    )
  }
}

console.log(`\n${written} file(s) in ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`)
