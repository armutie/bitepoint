/**
 * Does a baked line reproduce the line that was baked?
 *
 * Run with:  npx vite-node src/dev/checkBake.ts [trackId] [preset]
 *
 * The bake writes offsets and throws the rest away, so the claim being tested is
 * that offsets are sufficient — that reconstructing gives back the same
 * geometry, the same speed profile and the same model lap, to the precision the
 * file was rounded to. If they diverge, race mode is driving a different line
 * from the one that was measured.
 */
import { buildRacingLine, lineFromOffsets, modelLapTime } from '../core/racingLine'
import { bakedToLine, toGgv, type BakedLine } from '../core/bakedLines'
import { handlingPreset, type PresetName } from '../core/carParams'
import { Track, type TrackData } from '../core/track'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const trackId = process.argv[2] ?? 'technical_8'
const preset = (process.argv[3] ?? 'classic') as PresetName
const pub = fileURLToPath(new URL('../../public/', import.meta.url))
const track = new Track(
  JSON.parse(readFileSync(`${pub}tracks/${trackId}.json`, 'utf-8')) as TrackData,
)
const p = handlingPreset(preset)

const baked = JSON.parse(
  readFileSync(`${pub}lines/${trackId}.${preset}.json`, 'utf-8'),
) as BakedLine
// Rebuild against the envelope the file was baked with, not against whatever
// the derived model would say today. Comparing to a differently-limited line
// measures the difference between two grip models, which is not the question —
// it read 9.5 METRES of drift when this still used the formula.
const ggv = toGgv(baked.ggv)
const fresh = buildRacingLine(track, p, { ggv })
const rebuilt = lineFromOffsets(track, p, Float64Array.from(baked.offsets), 1.0, ggv)

let maxOffset = 0
let maxPoint = 0
let maxSpeed = 0
for (let i = 0; i < fresh.x.length; i++) {
  maxOffset = Math.max(maxOffset, Math.abs(fresh.offset[i]! - rebuilt.offset[i]!))
  maxPoint = Math.max(maxPoint, Math.hypot(fresh.x[i]! - rebuilt.x[i]!, fresh.y[i]! - rebuilt.y[i]!))
  const a = fresh.speed[i]!
  const b = rebuilt.speed[i]!
  if (Number.isFinite(a) && Number.isFinite(b)) maxSpeed = Math.max(maxSpeed, Math.abs(a - b))
}

console.log(`${trackId} / ${preset}`)
console.log(`  stations          ${fresh.x.length} vs ${rebuilt.x.length}`)
console.log(`  max offset drift  ${(maxOffset * 1000).toFixed(4)} mm`)
console.log(`  max point drift   ${(maxPoint * 1000).toFixed(4)} mm`)
console.log(`  max speed drift   ${(maxSpeed * 3.6).toFixed(5)} km/h`)
console.log(`  model lap         ${modelLapTime(fresh).toFixed(4)} s vs ` +
  `${modelLapTime(rebuilt).toFixed(4)} s`)

// And the loader's own stale-bake guard, which is what protects a live race.
const viaLoader = bakedToLine(baked, track, p, 0.95)
console.log(`  bakedToLine @0.95 ${viaLoader ? 'ok' : 'REFUSED'}` +
  `${viaLoader ? `, model ${modelLapTime(viaLoader).toFixed(3)} s` : ''}`)
