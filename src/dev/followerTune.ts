/**
 * Sweep one of the driver's habits at a time and see what it is worth.
 *
 * Run with:  npx vite-node src/dev/followerTune.ts [key] [values...]
 *   e.g.     npx vite-node src/dev/followerTune.ts brakeAt 0.5 0.65 0.75 0.85 0.95
 *
 * With no arguments it sweeps every knob over a sensible range. The lines are
 * built ONCE and reused across every value, so the only thing changing between
 * rows is the controller — which is the whole point.
 */
import { buildRacingLine, type RacingLine } from '../core/racingLine'
import { fastestLap, TUNING } from '../core/referenceDriver'
import { handlingPreset } from '../core/carParams'
import { Track, type TrackData } from '../core/track'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TRACKS = (process.env['TUNE_TRACKS'] ?? 'balanced_8,balanced_113,power_4,technical_8')
  .split(',')
const p = handlingPreset('f1')

const built = TRACKS.map((id) => {
  const track = new Track(JSON.parse(readFileSync(
    fileURLToPath(new URL(`../../public/tracks/${id}.json`, import.meta.url)), 'utf-8',
  )) as TrackData)
  return { id, track, shape: buildRacingLine(track, p) as RacingLine }
})

type Key = keyof typeof TUNING
const SWEEPS: Partial<Record<Key, number[]>> = {
  brakeAt: [0.75, 0.85, 0.92, 0.98],
  brakeTrust: [1.0, 1.07, 1.13, 1.2, 1.3],
  trimDist: [18, 26, 36, 50, 70],
  spinAllow: [0.02, 0.04, 0.06, 0.08, 0.10],
  slideStart: [0.04, 0.06, 0.09, 0.12, 0.16],
  spinGain: [2.5, 5.0, 8.0, 14.0],
  previewDist: [3, 6, 12, 20],
  understeer: [0.0032, 0.0042, 0.0055, 0.007, 0.009],
  headGain: [0.5, 0.7, 0.9, 1.2, 1.6],
  crossGain: [2.2, 3.0, 4.0, 5.5, 7.0],
  geometrySmooth: [0, 1, 2, 3, 5],
  yawDamp: [0.0, 0.05, 0.09, 0.15, 0.25],
}

const argKey = process.argv[2] as Key | undefined
const keys: Key[] = argKey ? [argKey] : (Object.keys(SWEEPS) as Key[])
const argVals = process.argv.slice(3).map(Number)

/** Total of the best clean lap on every circuit; Infinity if any had none. */
function score(): { total: number; parts: string[] } {
  let total = 0
  const parts: string[] = []
  for (const b of built) {
    const r = fastestLap(b.track, p, b.id, b.shape)
    if (r.time === null) { total = Infinity; parts.push('NONE') }
    else { total += r.time; parts.push(`${r.time.toFixed(2)} @${r.commitment.toFixed(2)}`) }
  }
  return { total, parts }
}

for (const key of keys) {
  const values = argVals.length ? argVals : SWEEPS[key]!
  const original = TUNING[key]
  console.log(`\n${key}  (default ${original})   ${TRACKS.join('  ')}   total`)
  let best = { v: original, total: Infinity }
  for (const v of values) {
    TUNING[key] = v
    const { total, parts } = score()
    if (total < best.total) best = { v, total }
    console.log(
      `  ${String(v).padStart(6)}   ${parts.map((x) => x.padStart(14)).join('  ')}` +
      `   ${(Number.isFinite(total) ? total.toFixed(2) : '—').padStart(8)}` +
      `${v === original ? '   <- default' : ''}`,
    )
  }
  TUNING[key] = original
  console.log(`  best ${key} = ${best.v}` +
    `${best.v === original ? ' (default already best)' : `  — worth ${(score().total - best.total).toFixed(2)} s`}`)
}
