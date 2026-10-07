/**
 * Does the AI give you space? — the bench for the one behaviour, in isolation.
 *
 * Run with:  npx vite-node src/dev/spaceBench.ts [track] [preset] [laps] [difficulty]
 *   SPACE=0 disables traffic awareness for a diagnostic comparison.
 *   PASS=0  disables passing/defending incentives (alongside safety remains).
 *   SEED=1  repeats a particular grid reaction and driver-preference sample.
 *
 * THE PLAYER IS A SLOW DRIVER, NOT A PARKED CAR, and that choice is the whole
 * design of this bench. A car parked on pole is a legitimate thing to survive,
 * but it is a terrible thing to DEVELOP against: the field meets it at a
 * standstill five metres off the grid, and what you measure is a start-line
 * shunt rather than racecraft. Measured, it also hid everything else — the car
 * in the slot behind spent 591 of 600 seconds in the grass and never completed
 * a lap, while the other four raced perfectly well.
 *
 * So the player here drives the racing line properly, just slowly — a
 * `LineFollower` at a low commitment. Every AI catches them, at speed, on the
 * road, repeatedly, which is exactly the situation "give me room" is about.
 *
 * The number that matters is CLEARANCE: with an AI alongside the player, how
 * much room is actually between them? Not the room the plan intended — the room
 * that exists. Those are different by the follower's own tracking error, which
 * is 0.5-2 m, and that gap is most of why this behaviour was switched off.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { bakedToLine, type BakedLine } from '../core/bakedLines'
import { carLength, handlingPreset, type PresetName } from '../core/carParams'
import { difficultyByName, RaceSession } from '../core/raceSession'
import { atCommitment } from '../core/racingLine'
import { LineFollower } from '../core/referenceDriver'
import { DT } from '../core/sim'
import { Track, type TrackData } from '../core/track'

const trackId = process.argv[2] ?? 'power_8'
const preset = (process.argv[3] ?? 'legacy') as PresetName
const laps = Number(process.argv[4] ?? 3)
const difficulty = process.argv[5] ?? 'ruthless'
const OPPONENTS = 5
/** The player leads, so the whole field has to come past them. */
const PLAYER_SLOT = 0
/** How much slower the player is. 0.80 of the reference is a few seconds a lap. */
const PLAYER_COMMITMENT = Number(process.env['PLAYER_PACE'] ?? 0.80)

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

const track = new Track(JSON.parse(read(`../../public/tracks/${trackId}.json`)) as TrackData)
const baked = JSON.parse(read(`../../public/lines/${trackId}.${preset}.json`)) as BakedLine
const params = handlingPreset(preset)
const shape = bakedToLine(baked, track, params, 1.0)
if (!shape) throw new Error('baked line does not fit this circuit')

const s = new RaceSession({
  track, trackId, params, preset, shape, laps,
  opponents: OPPONENTS,
  difficulty: difficultyByName(difficulty),
  playerSlot: PLAYER_SLOT,
  seed: Number(process.env['SEED'] ?? 0x9e37),
})
if (process.env['SPACE'] === '0') s.awareness = false
if (process.env['PASS'] === '0') s.overtaking = false

/** The player: the same follower, told to take it easy. */
const player = new LineFollower(params, atCommitment(shape, params, PLAYER_COMMITMENT))

console.log(
  `${trackId}/${preset}  ${laps} laps  ${difficulty}  ` +
  `player pace ${PLAYER_COMMITMENT}  awareness ${s.awareness}  overtaking ${s.overtaking}`,
)
s.begin()

const LEN = carLength(params)
/** Lateral clearance to the player whenever somebody is genuinely alongside. */
let minClearance = Infinity
let alongsideTicks = 0
let tightTicks = 0
let playerHits = 0
let playerImpulse = 0
let offTicks = 0
let contactTicks = 0
let ticks = 0
const passed = new Set<number>()
const aheadTicks = new Uint16Array(s.size)
/** Did anybody actually move off the line, and how far? */
let maxOffset = 0
let movedTicks = 0
/** Of the ticks somebody was alongside the player, how many did they move for? */
let alongsideMoved = 0
const started = performance.now()

const done = (): boolean =>
  s.race.standings().every((k) => k === s.playerSlot || s.race.finishedAt(k) !== null)

for (let i = 0; i < 60 * 60 * 12; i++) {
  const c = player.next(s.race.sims[s.playerSlot]!.car.s)
  s.step(c.steer, c.pedal)
  ticks++
  if (process.env['TRACE_FIELD'] === '1' && ticks % 600 === 0) console.log(JSON.stringify({time: ticks/60,
    cars: s.race.sims.map((sim,i)=>({i,s:Math.round(track.project(sim.car.s.x,sim.car.s.y).s),v:+sim.speed.toFixed(1),lat:+sim.lateral.toFixed(1),plan:s.planOf(i)?.decision}))}))

  const me = s.race.sims[s.playerSlot]!.car.s
  if (process.env['TRACE_HITS'] === '1' && s.race.impacts[s.playerSlot]! > 1000) console.log(JSON.stringify({hit:ticks/60,impulse:s.race.impacts[s.playerSlot], cars:s.race.sims.map((sim,i)=>({i,s:Math.round(track.project(sim.car.s.x,sim.car.s.y).s),v:+sim.speed.toFixed(1),lat:+sim.lateral.toFixed(1),plan:s.planOf(i)?.decision}))}))
  if (s.race.impacts[s.playerSlot]! > 1) {
    playerHits++
    playerImpulse = Math.max(playerImpulse, s.race.impacts[s.playerSlot]!)
  }
  for (let k = 0; k < s.size; k++) {
    if (k === s.playerSlot) continue
    // A full car length ahead for a second, measured along unwrapped track
    // progress. The player's heading on a bend cannot count false passes.
    if (s.race.distanceTravelled(k) > s.race.distanceTravelled(s.playerSlot) + LEN + 2) {
      aheadTicks[k] = Math.min(60, aheadTicks[k]! + 1)
      if (aheadTicks[k]! >= 60) passed.add(k)
    } else aheadTicks[k] = 0
    if (s.race.finishedAt(k) !== null) continue
    if (s.race.sims[k]!.offTrack) {
      offTicks++
    }
    if (s.race.impacts[k]! > 1) contactTicks++
    const them = s.race.sims[k]!.car.s
    // Separation in the PLAYER's own frame: how far up the road, and how far to
    // the side. Measured off the cars, not off anybody's plan.
    const dx = them.x - me.x
    const dy = them.y - me.y
    const along = dx * Math.cos(me.yaw) + dy * Math.sin(me.yaw)
    const beside = -dx * Math.sin(me.yaw) + dy * Math.cos(me.yaw)
    const off = Math.abs(s.offsetOf(k))
    if (off > maxOffset) maxOffset = off
    if (off > 0.3) movedTicks++
    if (Math.abs(along) < LEN) {
      alongsideTicks++
      if (off > 0.3) alongsideMoved++
      const clear = Math.abs(beside) - params.width
      if (clear < minClearance) minClearance = clear
      if (clear < 0.5) tightTicks++
    }
  }
  if (done()) break
}

const pad = (x: string, n: number): string => x.padStart(n)
console.log(`\n  race ran ${(ticks * DT).toFixed(1)} s, all AI home: ${done() ? 'YES' : 'NO'}`)
console.log(`  AI laps: ${s.race.sims.map((x, k) => (k === s.playerSlot ? 'P' : x.lapsCompleted)).join(' ')}`)
console.log(`  player completed ${s.race.sims[s.playerSlot]!.lapsCompleted} laps` +
  `, best ${s.race.sims[s.playerSlot]!.bestLapTime?.toFixed(3) ?? 'NONE'} s`)
console.log('')
console.log(`  hit the player          ${pad(String(playerHits), 8)} ticks` +
  `   hardest ${playerImpulse.toFixed(0)} N.s`)
console.log(`  AI contact (any car)    ${pad(String(contactTicks), 8)} car-ticks`)
console.log(`  AI off track            ${pad((offTicks * DT).toFixed(2), 8)} s`)
console.log(`  alongside the player    ${pad(String(alongsideTicks), 8)} ticks` +
  `   (${(alongsideTicks * DT).toFixed(1)} s)`)
console.log(`  of those, under 0.5 m   ${pad(String(tightTicks), 8)} ticks`)
console.log(`  CLOSEST CLEARANCE       ${pad(minClearance === Infinity ? 'never alongside' : minClearance.toFixed(2) + ' m', 8)}`)
console.log(`  AI completing a pass    ${pad(String(passed.size), 8)} / ${OPPONENTS}`)
console.log(`  furthest off the line   ${pad(maxOffset.toFixed(2) + ' m', 8)}`)
console.log(`  ticks moved over        ${pad(String(movedTicks), 8)}`)
console.log(`  alongside AND moved     ${pad(String(alongsideMoved), 8)} of ${alongsideTicks}`)
console.log(`  simulation + AI         ${((performance.now() - started) / ticks).toFixed(3)} ms/tick (headless)`)

console.log(JSON.stringify(s.results()))
