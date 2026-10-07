/**
 * Does the plan ask for braking the car actually has? — the feasibility audit.
 *
 * Run with:  npx vite-node src/dev/profileAudit.ts [trackId...]
 *
 * A speed profile is a promise: be doing this here, and that there. Between two
 * stations that promise implies a deceleration, and nothing in `speedProfile`
 * ever checks the implied number against the car. For a long time it did not
 * hold — `corneringSpeed` is legitimately Infinity wherever downforce outgrows
 * the corner, `longitudinal` returns NaN when handed that, and `NaN < v` is
 * false, so the braking constraint was silently skipped at those stations and
 * the profile came out asking for 69 g. Croft Bay had thirty such stations a
 * lap at up to 16.6x the car's real braking.
 *
 * That is exactly the kind of fault a lap time cannot show you. The model just
 * reports a quicker lap, the follower quietly fails to hold it, and the gap
 * gets blamed on the controller. So this checks the promise directly, and it
 * should stay checkable: a NaN that silently skips a comparison is not a bug
 * that announces itself once and goes away.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { handlingPreset, type PresetName } from '../core/carParams'
import {
  atCommitment, buildRacingLine, longitudinalLimit, type RacingLine,
} from '../core/racingLine'
import { Track, type TrackData } from '../core/track'

const ids = process.argv.slice(2)
const TRACKS = ids.length ? ids : ['balanced_8', 'balanced_113', 'power_4', 'technical_8', 'power_8']
const preset = (process.env['AUDIT_PRESET'] ?? 'legacy') as PresetName
const ROUNDS = Number(process.env['AUDIT_ROUNDS'] ?? 3)
const p = handlingPreset(preset)

/** How far over the car's braking the profile goes, station by station. */
function audit(line: RacingLine): { over: number; worst: number; at: number; nonFinite: number } {
  const n = line.x.length
  let over = 0
  let worst = 0
  let at = -1
  let nonFinite = 0
  for (let i = 0; i < n; i++) {
    const b = (i + 1) % n
    const v = line.speed[i]!
    const next = line.speed[b]!
    if (!Number.isFinite(v)) { nonFinite++; continue }
    if (!Number.isFinite(next) || next >= v) continue
    const seg = Math.hypot(line.x[b]! - line.x[i]!, line.y[b]! - line.y[i]!)
    const demand = (v * v - next * next) / (2 * Math.max(seg, 1e-3))
    const have = longitudinalLimit(p, v, line.curvature[i]!, line.commitment, 'brake')
    const ratio = demand / Math.max(have, 0.1)
    // Five percent, because the profile solves a fixed point rather than an
    // equation and a converged answer still lands a little either side of it.
    if (ratio > 1.05) over++
    if (ratio > worst) { worst = ratio; at = i }
  }
  return { over, worst, at, nonFinite }
}

console.log(`preset ${preset}, ${ROUNDS} optimiser rounds\n`)
console.log('  track             stations   over   worst   at station   non-finite')
let totalOver = 0
for (const id of TRACKS) {
  const path = fileURLToPath(new URL(`../../public/tracks/${id}.json`, import.meta.url))
  let track: Track
  try {
    track = new Track(JSON.parse(readFileSync(path, 'utf-8')) as TrackData)
  } catch {
    console.log(`  ${id.padEnd(17)} (no such circuit, skipped)`)
    continue
  }
  const line = atCommitment(buildRacingLine(track, p, { optimise: ROUNDS }), p, 0.95)
  const r = audit(line)
  totalOver += r.over
  console.log(
    `  ${id.padEnd(17)} ${String(line.x.length).padStart(8)} ` +
    `${String(r.over).padStart(6)} ${r.worst.toFixed(2).padStart(7)}x ` +
    `${String(r.at).padStart(12)} ${String(r.nonFinite).padStart(12)}`,
  )
}
console.log(
  totalOver === 0
    ? '\n  CLEAN: every station asks for braking the car has.'
    : `\n  ${totalOver} stations ask for more braking than the car has.`,
)
