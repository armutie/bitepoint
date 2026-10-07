import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bakedToLine, type BakedLine } from '../core/bakedLines'
import { handlingPreset } from '../core/carParams'
import { RaceSession, difficultyByName } from '../core/raceSession'
import { atCommitment } from '../core/racingLine'
import { LineFollower } from '../core/referenceDriver'
import { Track, type TrackData } from '../core/track'

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const trackId = process.argv[2] ?? 'power_8'
const preset = (process.argv[3] ?? 'legacy') as 'legacy' | 'classic'
const track = new Track(JSON.parse(read(`../../public/tracks/${trackId}.json`)) as TrackData)
const params = handlingPreset(preset)
const shape = bakedToLine(JSON.parse(read(`../../public/lines/${trackId}.${preset}.json`)) as BakedLine, track, params, 1)!
const n = shape.x.length
// Longest straight segment, starting far enough into it to be settled.
let start = 0, longest = 0
for (let i = 0; i < n; i++) {
  let length = 0
  for (let k = 0; k < n; k++) {
    const j = (i + k) % n, next = (j + 1) % n
    if (Math.abs(shape.curvature[j]!) > 0.0025) break
    length += Math.hypot(shape.x[next]! - shape.x[j]!, shape.y[next]! - shape.y[j]!)
  }
  if (length > longest) { longest = length; start = i }
}
start = (start + 6) % n
const s = new RaceSession({track, trackId, params, preset, shape, laps: 10, opponents: 1,
  playerSlot: 0, difficulty: {...difficultyByName('ruthless'), mistakeChance: 0, mistakeSize: 0}})
const player = new LineFollower(params, atCommitment(shape, params, 0.9))
player.speedLimit = Number(process.env['LEADER_SPEED'] ?? 40)
const put = (slot: number, idx: number, speed: number): void => {
  const a = (idx - 2 + n) % n, b = (idx + 2) % n
  const yaw = Math.atan2(shape.y[b]! - shape.y[a]!, shape.x[b]! - shape.x[a]!)
  const car = s.race.sims[slot]!.car
  car.reset(shape.x[idx]!, shape.y[idx]!, yaw)
  car.s.vx = speed; car.s.wheelVr = speed; car.s.r = shape.curvature[idx]! * speed
  car.s.gear = 4
}
put(1, start, 48)
put(0, (start + 10) % n, 40)
s.race.phase = 'racing'
let contact = 0, off = 0, passed = false
const begin = performance.now()
console.log(JSON.stringify({trackId, straight: longest, start, speed: shape.speed[start]}))
for (let tick = 0; tick < 60 * 18; tick++) {
  const c = player.next(s.playerSim.car.s)
  s.step(c.steer, c.pedal)
  const ai = s.race.sims[1]!
  const a = track.project(ai.car.s.x, ai.car.s.y), b = track.project(s.playerSim.car.s.x, s.playerSim.car.s.y)
  const gap = ((b.s - a.s + track.length * 1.5) % track.length) - track.length * 0.5
  if (s.race.impacts[0]! > 1) contact++
  if (ai.offTrack) off++
  if (gap < -8) passed = true
  if (process.env['TRACE'] === '1' && tick % 30 === 0) console.log(JSON.stringify({t:tick / 60,
    gap:+gap.toFixed(1),v:+ai.speed.toFixed(1), pv:+s.playerSim.speed.toFixed(1),lat:+a.lateral.toFixed(2),
    pLat:+b.lateral.toFixed(2), steer:+ai.car.s.steer.toFixed(2),off:ai.offTrack,plan:s.planOf(1)!.decision}))
}
console.log(JSON.stringify({passed, contactTicks:contact, offSeconds:off / 60, msPerTick:(performance.now()-begin)/1080}))
