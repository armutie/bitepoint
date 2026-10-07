/**
 * Per-tick trace of one LineFollower lap — diagnosis, not a benchmark.
 *
 * Run with:  npx vite-node src/dev/traceFollower.ts [trackId] [commitment]
 */
import { atCommitment, buildRacingLine, nearestStation } from '../core/racingLine'
import { LineFollower } from '../core/referenceDriver'
import { handlingPreset } from '../core/carParams'
import { TimeAttackSim, DT } from '../core/sim'
import { Track, type TrackData } from '../core/track'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const trackId = process.argv[2] ?? 'balanced_8'
const commitment = Number(process.argv[3] ?? 0.9)
const params = handlingPreset('f1')
const path = fileURLToPath(new URL(`../../public/tracks/${trackId}.json`, import.meta.url))
const track = new Track(JSON.parse(readFileSync(path, 'utf-8')) as TrackData)

const shape = buildRacingLine(track, params)
const line = atCommitment(shape, params, commitment)
const sim = new TimeAttackSim(track, params, trackId, 'reference')
const follower = new LineFollower(params, line)

interface Row {
  t: number; s: number; v: number; tgt: number; err: number; off: boolean
  steer: number; pedal: number; beta: number; r: number; slipF: number; slipR: number
  spin: number; gear: number
}
const rows: Row[] = []
let st = 0
for (let i = 0; i < 60 * 60 * 3; i++) {
  const c = sim.car.s
  const { steer, pedal } = follower.next(c)
  st = nearestStation(line, c.x, c.y, st)
  const proj = track.project(c.x, c.y)
  rows.push({
    t: i * DT, s: proj.s, v: Math.hypot(c.vx, c.vy), tgt: line.speed[st]!,
    err: Math.hypot(line.x[st]! - c.x, line.y[st]! - c.y), off: sim.offTrack,
    steer, pedal, beta: Math.atan2(c.vy, Math.max(c.vx, 0.1)), r: c.r,
    slipF: c.slipF, slipR: c.slipR, spin: c.wheelVr - c.vx, gear: c.gear,
  })
  sim.step(steer, pedal)
  if (sim.lapsCompleted >= 2) break
}

const first = rows.findIndex((x) => x.off)
console.log(`ticks ${rows.length}, laps ${sim.lapsCompleted}, first off-track at tick ${first} (${first < 0 ? '-' : rows[first]!.t.toFixed(2) + ' s'})`)
const hdr = '   t     s      v    tgt    err  steer  pedal   beta      r  slipF  slipR   spin g off'
const show = (r: Row): string =>
  `${r.t.toFixed(2).padStart(6)}${r.s.toFixed(0).padStart(6)}${r.v.toFixed(1).padStart(7)}` +
  `${(Number.isFinite(r.tgt) ? r.tgt.toFixed(1) : 'inf').padStart(7)}${r.err.toFixed(1).padStart(7)}` +
  `${r.steer.toFixed(2).padStart(7)}${r.pedal.toFixed(2).padStart(7)}` +
  `${(r.beta * 57.3).toFixed(1).padStart(7)}${r.r.toFixed(2).padStart(7)}` +
  `${(r.slipF * 57.3).toFixed(1).padStart(7)}${(r.slipR * 57.3).toFixed(1).padStart(7)}` +
  `${r.spin.toFixed(1).padStart(7)}${String(r.gear + 1).padStart(2)}${r.off ? '  OFF' : ''}`

const from = Math.max(0, first - 90)
console.log(`\n--- around the first departure (tick ${from}..${first + 60}) ---`)
console.log(hdr)
for (let i = from; i < Math.min(rows.length, first + 60); i += 3) console.log(show(rows[i]!))

console.log('\n--- every 0.5 s for the first 40 s ---')
console.log(hdr)
for (let i = 0; i < Math.min(rows.length, 2400); i += 30) console.log(show(rows[i]!))

const offTicks = rows.filter((r) => r.off).length
const maxErr = Math.max(...rows.map((r) => r.err))
const maxBeta = Math.max(...rows.map((r) => Math.abs(r.beta)))
const maxSpin = Math.max(...rows.map((r) => r.spin))
console.log(`\noff-track ${(offTicks * DT).toFixed(1)} s of ${(rows.length * DT).toFixed(1)} s` +
  `  maxErr ${maxErr.toFixed(1)} m  max|beta| ${(maxBeta * 57.3).toFixed(0)} deg  max wheelspin ${maxSpin.toFixed(1)} m/s`)
