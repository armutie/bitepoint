/**
 * How good is the AI, actually? — a headless race, run for numbers.
 *
 * Run with:  npx vite-node src/dev/raceBench.ts [trackId] [laps]
 *
 * This exists because the interesting question about a field of AI drivers is
 * not whether it renders. It is whether they lap at a sane pace, whether they
 * hold their line when another car is beside them, and how much of their time
 * they lose to each other rather than to the circuit. All three are numbers, and
 * numbers are available long before any of this is drawn — so the driving can be
 * judged, and improved, without waiting on the race UI.
 *
 * The measurement that matters most is the SOLO / IN-RACE split. Each driver is
 * first sent round alone on exactly the line and commitment it will race with,
 * which gives the pace its line is worth. Racing the same drivers together and
 * comparing tells you what the field cost them — and with no racecraft layered
 * on yet, that difference is the size of the problem racecraft has to solve.
 */
import { atCommitment, buildRacingLine, modelLapTime, type RacingLine } from '../core/racingLine'
import { LineFollower } from '../core/referenceDriver'
import { handlingPreset } from '../core/carParams'
import { Race } from '../core/race'
import { DT } from '../core/sim'
import { Track, type TrackData } from '../core/track'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const trackId = process.argv[2] ?? 'balanced_8'
const laps = Number(process.argv[3] ?? 3)
/**
 * Commitments for the field, quickest first onto pole.
 *
 * A spread rather than one number, because a field that all drives identically
 * never overtakes and tells you nothing about contact. These are fractions of
 * the speed profile's own grip estimate.
 */
const COMMITMENTS = [0.98, 0.96, 0.94, 0.92, 0.90, 0.88]

const params = handlingPreset('f1')
const path = fileURLToPath(new URL(`../../public/tracks/${trackId}.json`, import.meta.url))
const track = new Track(JSON.parse(readFileSync(path, 'utf-8')) as TrackData)

/**
 * What the numbers below should be measured against, all on balanced_8.
 *
 * The human lap is the one that matters — it is what a player will be racing.
 * The trained policy is here because it is the alternative implementation of
 * this same job, so a follower slower than it would be an argument for shipping
 * the policy to the browser instead of driving analytically.
 */
const REFERENCE: Record<string, { human?: number; policy?: number }> = {
  balanced_8: { human: 48.783, policy: 65.167 },
}

console.log(`circuit ${trackId}  ${track.length.toFixed(0)} m  ${laps} laps`)
console.log('building the racing line...')
const t0 = Date.now()
const shape = buildRacingLine(track, params)
const lines: RacingLine[] = COMMITMENTS.map((c) => atCommitment(shape, params, c))
console.log(`  built in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`)

/** Drive one car alone for `laps` flying laps. Returns each lap's time. */
function solo(line: RacingLine): { times: number[]; maxError: number; offTicks: number } {
  const race = new Race(track, [{ slot: 0, params }], { laps: laps + 1, trackId, contact: false })
  const sim = race.sims[0]!
  const follower = new LineFollower(params, line)
  const times: number[] = []
  let offTicks = 0
  race.beginCountdown()
  for (let i = 0; i < 60 * 60 * 12; i++) {
    const { steer, pedal } = follower.next(sim.car.s)
    const [r] = race.step([{ steer, throttle: pedal }])
    if (sim.offTrack) offTicks++
    if (sim.lapsCompleted > 0) follower.flying = true
    if (r!.lapCompleted) times.push(r!.lapCompleted.time)
    if (race.phase === 'finished') break
  }
  return { times, maxError: follower.maxLineError, offTicks }
}

console.log('SOLO — each car alone on the line it will race with')
const soloBest: number[] = []
for (let i = 0; i < COMMITMENTS.length; i++) {
  const { times, maxError, offTicks } = solo(lines[i]!)
  const best = times.length ? Math.min(...times) : NaN
  soloBest.push(best)
  const shown = Number.isFinite(best) ? `${best.toFixed(3)} s` : 'NO CLEAN LAP'
  console.log(
    `  car ${i} @ ${COMMITMENTS[i]!.toFixed(2)}  best ${shown.padStart(12)}` +
    `  line error ${maxError.toFixed(2)} m  off-track ${(offTicks * DT).toFixed(1)} s`,
  )
}

// --- the race ---------------------------------------------------------------
console.log('\nRACE — the same six, together, with contact')
const race = new Race(
  track,
  COMMITMENTS.map((_, i) => ({ slot: i, params })),
  { laps, trackId },
)
const followers = lines.map((line) => new LineFollower(params, line))
const lapTimes: number[][] = COMMITMENTS.map(() => [])
const contactTicks = new Float64Array(COMMITMENTS.length)
const offTicks = new Float64Array(COMMITMENTS.length)
let peakImpulse = 0

race.beginCountdown()
for (let i = 0; i < 60 * 60 * 15; i++) {
  const actions = race.sims.map((sim, k) => {
    const { steer, pedal } = followers[k]!.next(sim.car.s)
    return { steer, throttle: pedal }
  })
  const results = race.step(actions)
  for (let k = 0; k < race.size; k++) {
    if (race.impacts[k]! > 0) contactTicks[k] = contactTicks[k]! + 1
    peakImpulse = Math.max(peakImpulse, race.impacts[k]!)
    if (race.sims[k]!.offTrack) offTicks[k] = offTicks[k]! + 1
    if (race.sims[k]!.lapsCompleted > 0) followers[k]!.flying = true
    const lap = results[k]!.lapCompleted
    if (lap) lapTimes[k]!.push(lap.time)
  }
  if (race.phase === 'finished') break
}

const order = race.standings()
console.log(`  flag at ${race.raceTime.toFixed(1)} s, phase "${race.phase}"`)
console.log('  pos  car  commit     best lap    vs solo   contacts   off-track  finished')
for (let pos = 0; pos < order.length; pos++) {
  const k = order[pos]!
  const best = lapTimes[k]!.length ? Math.min(...lapTimes[k]!) : NaN
  const delta = Number.isFinite(best) && Number.isFinite(soloBest[k]!)
    ? best - soloBest[k]!
    : NaN
  const fin = race.finishedAt(k)
  console.log(
    `  ${String(pos + 1).padStart(3)}  ${String(k).padStart(3)}` +
    `  ${COMMITMENTS[k]!.toFixed(2)}` +
    `  ${(Number.isFinite(best) ? best.toFixed(3) + ' s' : '—').padStart(11)}` +
    `  ${(Number.isFinite(delta) ? (delta >= 0 ? '+' : '') + delta.toFixed(3) : '—').padStart(8)}` +
    `  ${String(contactTicks[k]).padStart(8)}` +
    `  ${(offTicks[k]! * DT).toFixed(1).padStart(9)} s` +
    `  ${fin === null ? 'no' : fin.toFixed(1) + ' s'}`,
  )
}
/** How the follower compares to a reference lap, said the right way round. */
const pct = (got: number, ref: number): string => {
  const d = ((got / ref) - 1) * 100
  return `${Math.abs(d).toFixed(1)}% ${d >= 0 ? 'slower' : 'FASTER'}`
}

const ref = REFERENCE[trackId]
if (ref) {
  const quickest = Math.min(...soloBest.filter((v) => Number.isFinite(v)))
  console.log('')
  console.log('AGAINST THE REFERENCES')
  console.log(`  model line (point mass, commitment 1.00)  ${modelLapTime(shape).toFixed(3)} s`)
  if (ref.human !== undefined) {
    console.log(
      `  human personal best                       ${ref.human.toFixed(3)} s` +
      `   follower ${pct(quickest, ref.human)}`,
    )
  }
  if (ref.policy !== undefined) {
    console.log(
      `  trained RL policy (run042)                ${ref.policy.toFixed(3)} s` +
      `   follower ${pct(quickest, ref.policy)}`,
    )
  }
  console.log(`  best the follower managed solo            ${quickest.toFixed(3)} s`)
}

console.log(`\n  peak contact impulse ${peakImpulse.toFixed(0)} N·s`)
console.log(`  laps completed: ${race.sims.map((s) => s.lapsCompleted).join(', ')}`)
