/**
 * How fast can the follower actually drive a good line? — the A/B harness.
 *
 * Run with:  npx vite-node src/dev/followerBench.ts [trackId...]
 *
 * The line is now measured to within a few percent of the car, so what is left
 * between the model's lap and the driven one belongs to the CONTROLLER. This
 * builds the line once per circuit and hands it to `fastestLap`, which walks
 * commitment up until the lap stops being clean, and reports the quickest lap
 * that held — the same number for both sides of any controller change.
 *
 * `maxLineError` is reported next to it because a lap time on its own cannot
 * tell a quicker driver from one that has started cutting.
 */
import { buildRacingLine, modelLapTime } from '../core/racingLine'
import { fastestLap } from '../core/referenceDriver'
import { handlingPreset, type PresetName } from '../core/carParams'
import { Track, type TrackData } from '../core/track'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ids = process.argv.slice(2)
const TRACKS = ids.length ? ids : ['balanced_8', 'technical_8', 'power_8']
const preset = (process.env['BENCH_PRESET'] ?? 'f1') as PresetName
const p = handlingPreset(preset)

/** Human reference laps, where one has been set. */
const HUMAN: Record<string, number> = { balanced_8: 48.783 }

console.log('  track            model lap    driven    commit   line err   vs model   vs human')
for (const id of TRACKS) {
  const track = new Track(JSON.parse(readFileSync(
    fileURLToPath(new URL(`../../public/tracks/${id}.json`, import.meta.url)), 'utf-8',
  )) as TrackData)
  const shape = buildRacingLine(track, p)
  const model = modelLapTime(shape)
  const best = fastestLap(track, p, id, shape)
  const human = HUMAN[id]
  console.log(
    `  ${id.padEnd(15)} ${model.toFixed(2).padStart(8)} s` +
    ` ${(best.time === null ? 'NONE' : best.time.toFixed(3) + ' s').padStart(11)}` +
    ` ${best.commitment.toFixed(3).padStart(8)}` +
    ` ${best.maxLineError.toFixed(1).padStart(8)} m` +
    ` ${(best.time === null ? '—' : `+${(best.time - model).toFixed(2)} s`).padStart(10)}` +
    ` ${(best.time === null || human === undefined
      ? '—'
      : `+${(100 * (best.time / human - 1)).toFixed(1)}%`).padStart(10)}`,
  )
}
