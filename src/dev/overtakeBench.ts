/** Repeatable overtaking measurements; no rendering or gameplay tuning. */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bakedToLine, type BakedLine } from '../core/bakedLines'
import { carLength, handlingPreset } from '../core/carParams'
import { seeded } from '../core/racecraft'
import { Race } from '../core/race'
import { RaceSession, commitmentFor, DIFFICULTIES, difficultyByName } from '../core/raceSession'
import { atCommitment } from '../core/racingLine'
import { LineFollower, type FollowerTrace } from '../core/referenceDriver'
import { DT, TimeAttackSim } from '../core/sim'
import { Track, type TrackData } from '../core/track'
import { RacingRibbon, TrafficPlanner, type TrafficCar } from '../core/trafficPlanner'

const trackId = process.argv[2] ?? 'power_8'
const out = resolve(process.argv[3] ?? 'overtake-results.json')
const suite = process.argv[4] ?? 'duels'
const read = (name: string): string => readFileSync(new URL(`../../public/${name}`, import.meta.url), 'utf8')
const track = new Track(JSON.parse(read(`tracks/${trackId}.json`)) as TrackData)
const params = handlingPreset('legacy')
const shape = bakedToLine(JSON.parse(read(`lines/${trackId}.legacy.json`)) as BakedLine, track, params, 1)!
if (!shape) throw new Error('No usable baked racing line')
const ribbon = new RacingRibbon(track, shape)
const n = shape.x.length
const road = Array.from(shape.x, (x, i) => track.project(x, shape.y[i]!).s)
const signed = (value: number): number => ((value + track.length * 1.5) % track.length) - track.length * 0.5
const atRoad = (s: number): number => {
  let best = 0, distance = Infinity
  road.forEach((r, i) => { const d = Math.abs(signed(r - s)); if (d < distance) { best = i; distance = d } })
  return best
}
function put(sim: TimeAttackSim, i: number, speed: number): void {
  const a = (i - 2 + n) % n, b = (i + 2) % n
  sim.car.reset(shape.x[i]!, shape.y[i]!, Math.atan2(shape.y[b]! - shape.y[a]!, shape.x[b]! - shape.x[a]!))
  let gear = 0
  const rpm = (g: number): number => speed / params.wheelRadius * params.gearRatios[g]! * params.finalDrive * 60 / (2 * Math.PI)
  while (gear < params.gearRatios.length - 1 && rpm(gear) > params.shiftUpRpm) gear++
  sim.beginRollingApproach({ ...sim.car.s, vx: speed, wheelVr: speed,
    r: shape.curvature[i]! * speed, gear, engineRpm: rpm(gear), shiftTimer: 0 })
}
function style(seed: number, slot: number) {
  const random = seeded((seed + slot * 2654435761) >>> 0)
  random() // The live session samples launch reaction first.
  return { side: (random() * 2 - 1) * 0.7, clearance: 0.6 + random() * 0.15,
    preparation: 2 + random() * 0.2, cruise: (random() * 2 - 1) * 0.25 }
}
function snapshot(race: Race): TrafficCar[] {
  return race.sims.map((sim) => ({ state: sim.car.s,
    road: track.project(sim.car.s.x, sim.car.s.y), speed: sim.speed }))
}

// The longest low-curvature run plus three distinct corner/exit approaches.
let straight = 0, longest = 0
for (let i = 0; i < n; i++) {
  let distance = 0
  for (let k = 0; k < n; k++) {
    const a = (i + k) % n, b = (a + 1) % n
    if (Math.abs(shape.curvature[a]!) > 0.0025) break
    distance += Math.hypot(shape.x[b]! - shape.x[a]!, shape.y[b]! - shape.y[a]!)
  }
  if (distance > longest) { longest = distance; straight = i }
}
const starts = [
  { name: 'long-straight', i: (straight + 12) % n },
  ...[0.25, 0.5, 0.75].map((fraction) => ({ name: `lap-${fraction * 100}%`, i: atRoad(track.length * fraction) })),
]

function solo(commitment: number) {
  const sim = new TimeAttackSim(track, params, trackId, 'legacy')
  const line = atCommitment(shape, params, commitment)
  const driver = new LineFollower(params, line)
  const planner = new TrafficPlanner(ribbon, line, params, style(1, 0))
  put(sim, starts[0]!.i, line.speed[starts[0]!.i]!)
  const times: number[] = []
  let offTicks = 0
  for (let tick = 0; tick < 60 * 240 && times.length < 3; tick++) {
    const cars = [{ state: sim.car.s, road: track.project(sim.car.s.x, sim.car.s.y), speed: sim.speed }]
    if (tick % 6 === 0) driver.setLine(planner.update(cars, 0))
    driver.flying = sim.lapsCompleted > 0
    driver.offTrack = sim.offTrack
    driver.speedLimit = planner.speedLimit(cars, 0)
    const c = driver.next(sim.car.s)
    const result = sim.step(c.steer, c.pedal)
    if (sim.offTrack) offTicks++
    if (result.lapCompleted?.valid) times.push(result.lapCompleted.time)
  }
  return { commitment, times, best: times.length ? Math.min(...times) : null, offSeconds: offTicks * DT }
}

function duel(advantage: number, seed: number, start: typeof starts[number], defending = true,
  seconds = 120, initialGap = 12, trace = false, rearCommitment = 0.99) {
  const commitments = [rearCommitment / (1 + advantage), rearCommitment]
  const race = new Race(track, [{ slot: 0, params }, { slot: 1, params }],
    { laps: 100, trackId, preset: 'legacy' })
  const lines = commitments.map((c) => atCommitment(shape, params, c))
  const planners = lines.map((line, i) => new TrafficPlanner(ribbon, line, params, style(seed, i)))
  const drivers = lines.map((line) => new LineFollower(params, line))
  if (trace) drivers[1]!.trace = {} as FollowerTrace
  const indices = [start.i, atRoad(road[start.i]! - initialGap)]
  const sharedSpeed = Math.min(...indices.map((i, slot) => lines[slot]!.speed[i]!))
  indices.forEach((i, slot) => put(race.sims[slot]!, i, sharedSpeed))
  race.phase = 'racing'
  let previous = snapshot(race).map((c) => c.road.s)
  const progress = [0, signed(previous[1]! - previous[0]!)]
  const actualInitialGap = -progress[1]!
  let held = 0, pass: number | null = null, alongside: number | null = null
  let contactTicks = 0, peakImpulse = 0, offTicks = 0, attempts = 0, limited = 0, close = 0, maxOffset = 0
  let lastGap = actualInitialGap
  const reasons: Record<string, number> = {}
  const samples: unknown[] = []
  for (let tick = 0; tick < seconds / DT; tick++) {
    const cars = snapshot(race)
    const actions = drivers.map((driver, slot) => {
      const sim = race.sims[slot]!, planner = planners[slot]!
      // Same 10 Hz staggering and 60 Hz safety checks as RaceSession.
      if (slot === 0 && !defending) { driver.setLine(lines[slot]!); driver.speedLimit = Infinity }
      else {
        if (tick === 0 || (tick + slot) % 6 === 0) driver.setLine(planner.update(cars, slot))
        driver.speedLimit = planner.speedLimit(cars, slot)
      }
      driver.flying = sim.lapsCompleted > 0
      driver.offTrack = sim.offTrack
      const c = driver.next(sim.car.s)
      return { steer: c.steer, throttle: c.pedal }
    })
    race.step(actions)
    const after = snapshot(race)
    after.forEach((car, i) => { progress[i]! += signed(car.road.s - previous[i]!); previous[i] = car.road.s })
    const gap = progress[0]! - progress[1]!
    lastGap = gap
    if (Math.abs(gap) < carLength(params) + 1 && alongside === null) alongside = (tick + 1) * DT
    if (race.impacts.some((v) => v > 1)) contactTicks++
    peakImpulse = Math.max(peakImpulse, ...race.impacts)
    if (race.sims.some((sim) => sim.offTrack)) offTicks++
    const plan = planners[1]!.decision
    reasons[plan.reason] = (reasons[plan.reason] ?? 0) + 1
    if (plan.reason === 'progress') attempts++
    if (plan.speedLimit < Infinity) limited++
    if (gap > 0 && gap < 25) close++
    maxOffset = Math.max(maxOffset, Math.abs(after[1]!.road.lateral - shape.offset[atRoad(after[1]!.road.s)]!))
    held = gap < -(carLength(params) + 1) ? held + 1 : 0
    if (trace && tick % 15 === 0) samples.push({ t: (tick + 1) * DT, gap,
      leaderSpeed: after[0]!.speed, rearSpeed: after[1]!.speed,
      leaderLateral: after[0]!.road.lateral, rearLateral: after[1]!.road.lateral,
      reason: plan.reason, lane: plan.lane, speedLimit: Number.isFinite(plan.speedLimit) ? plan.speedLimit : null,
      impact: race.impacts[1], roadS: after[1]!.road.s,
      controls: drivers[1]!.trace,
      referenceSpeed: lines[1]!.speed[atRoad(after[1]!.road.s)],
      plannedSpeed: planners[1]!.path.speed[atRoad(after[1]!.road.s)],
      curvature: planners[1]!.path.curvature[atRoad(after[1]!.road.s)],
      minimumSpeedRatio: Math.min(...Array.from({length: 30}, (_,j) => {
        const i=(atRoad(after[1]!.road.s)+j)%n;
        return planners[1]!.path.speed[i]! / lines[1]!.speed[i]!
      })) })
    if (held >= 60) { pass = (tick + 1) * DT; break }
  }
  return { advantage, rearCommitment, seed, start: start.name, defending, actualInitialGap, seconds,
    passSeconds: pass, firstAlongsideSeconds: alongside,
    cleanPass: pass !== null && contactTicks === 0 && offTicks === 0,
    contactTicks, peakImpulse, offSeconds: offTicks * DT,
    attemptSeconds: attempts * DT, limitedSeconds: limited * DT, closeSeconds: close * DT,
    maxOffset, lastGap, reasons, ...(trace ? { samples } : {}) }
}

function field(seed: number, reverse: boolean, mistakes: boolean) {
  const difficulty = { ...difficultyByName('quick'), ...(mistakes ? {} : { mistakeChance: 0, mistakeSize: 0 }) }
  const s = new RaceSession({ track, trackId, params, preset: 'legacy', shape,
    seed, opponents: 5, playerSlot: 5, laps: 10, difficulty,
    ...(reverse ? { gridOrder: [4, 3, 2, 1, 0, 5] } : {}) })
  // The player slot is a paced follower, matching the old space benchmark.
  const player = new LineFollower(params, atCommitment(shape, params, 0.84))
  s.begin()
  const events: unknown[] = []
  const held = new Map<string, number>(), order = new Map<string, number>()
  for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) order.set(`${a},${b}`, 1)
  let contacts = 0, off = 0
  const lapContacts = [0, 0, 0, 0], lapOff = [0, 0, 0, 0], lapTicks = [0, 0, 0, 0]
  const eligibleTicks = [0, 0, 0, 0]
  const nearTicks = [0, 0, 0, 0], attemptTicks = [0, 0, 0, 0]
  for (let tick = 0; tick < 60 * 320; tick++) {
    const c = player.next(s.playerSim.car.s)
    s.step(c.steer, c.pedal)
    if (!s.race.running) continue
    const lap = Math.min(3, Math.max(...s.race.sims.slice(0, 5).map((sim) => sim.lapsCompleted)))
    lapTicks[lap]!++
    for (let a = 0; a < 5; a++) {
      if (s.race.impacts[a]! > 1) { contacts++; lapContacts[lap]!++ }
      if (s.race.sims[a]!.offTrack) { off++; lapOff[lap]!++ }
      if (s.planOf(a)!.decision.reason === 'progress') attemptTicks[lap]!++
      for (let b = a + 1; b < 5; b++) {
        const gap = s.race.distanceTravelled(a) - s.race.distanceTravelled(b)
        if (Math.abs(gap) < 25) nearTicks[lap]!++
        const fasterBehind = gap > 0 ? s.driverIdOf(b) < s.driverIdOf(a) : s.driverIdOf(a) < s.driverIdOf(b)
        if (fasterBehind && Math.abs(gap) > carLength(params) + 1 && Math.abs(gap) < 25) eligibleTicks[lap]!++
        const key = `${a},${b}`
        const side = gap > carLength(params) + 1 ? 1 : gap < -(carLength(params) + 1) ? -1 : 0
        const value = side === Math.sign(held.get(key) ?? 0) ? (held.get(key) ?? 0) + side : side
        held.set(key, value)
        if (Math.abs(value) < 60) continue
        const previousOrder = order.get(key)
        if (previousOrder !== undefined && previousOrder !== side) {
          events.push({ t: s.race.raceTime, lap: lap + 1,
            passer: s.driverIdOf(side > 0 ? a : b), passed: s.driverIdOf(side > 0 ? b : a) })
        }
        order.set(key, side)
      }
    }
    if (s.race.sims.slice(0, 5).some((sim) => sim.lapsCompleted >= 3)) break
  }
  return { seed, reverse, mistakes, events, contacts, offSeconds: off * DT,
    lapContacts, lapOffSeconds: lapOff.map((v) => v * DT), lapSeconds: lapTicks.map((v) => v * DT),
    fasterBehindPairSeconds: eligibleTicks.map((v) => v * DT),
    closePairSeconds: nearTicks.map((v) => v * DT), attemptCarSeconds: attemptTicks.map((v) => v * DT),
    results: s.results() }
}

const data: Record<string, unknown> = { trackId, preset: 'legacy', physicsHz: 60,
  metadata: { pass: 'Full car length + 1m clear for 1 second; time includes that confirmation.',
    advantage: 'Target speed-profile advantage, not extra engine power. Solo times measure actual advantage.',
    duels: 'Two real cars with contact, traffic planners and followers; rolling same-speed start, no mistakes.',
    starts: starts.map((s) => ({ ...s, roadS: road[s.i], curvature: shape.curvature[s.i], speed: shape.speed[s.i] })) } }
const began = performance.now()
if (suite === 'pilot' || suite === 'duels' || suite === 'threshold') {
  const advantages = suite === 'threshold' ? [0.06, 0.07, 0.09, 0.10] : suite === 'pilot' ? [0.03, 0.08] : [0, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12]
  const solos = [...new Set([0.99, ...advantages.map((v) => 0.99 / (1 + v))])].map(solo)
  data['solo'] = solos
  data['gameBands'] = DIFFICULTIES.map((d) => ({ name: d.name,
    commitments: Array.from({ length: 5 }, (_, i) => commitmentFor(d, i / 4, true)) }))
  const rows: ReturnType<typeof duel>[] = []
  for (const advantage of advantages) {
    for (const start of starts) for (const seed of (suite === 'pilot' ? [1] : [1, 2, 3])) {
      rows.push(duel(advantage, seed, start, true))
    }
    console.log(JSON.stringify({ advantage, passes: rows.filter((r) => r.advantage === advantage && r.passSeconds !== null).length,
      clean: rows.filter((r) => r.advantage === advantage && r.cleanPass).length }))
    data['duels'] = rows; writeFileSync(out, JSON.stringify(data, null, 2))
  }
} else if (suite === 'bands') {
  const rows = []
  const solos = []
  for (const difficulty of DIFFICULTIES) {
    const fast = commitmentFor(difficulty, 0, true)
    solos.push(...[0, 0.25, 1].map((rank) => solo(commitmentFor(difficulty, rank, true))))
    for (const rank of [0.25, 1]) {
      const slow = commitmentFor(difficulty, rank, true)
      for (const start of starts) for (const seed of [1, 2, 3]) {
        rows.push({ difficulty: difficulty.name, rank, ...duel(fast / slow - 1, seed, start, true, 120, 12, false, fast) })
      }
    }
    console.log(JSON.stringify({ difficulty: difficulty.name, passes: rows.filter((r) => r.difficulty === difficulty.name && r.passSeconds !== null).length }))
    data['duels'] = rows; data['solo'] = solos; writeFileSync(out, JSON.stringify(data, null, 2))
  }
} else if (suite === 'debug') {
  data['traces'] = [duel(0.93/0.885-1,1,starts[0]!,true,120,12,true,0.93)]
} else if (suite === 'repeat') {
  const first = duel(0.08, 2, starts[0]!, true)
  const second = duel(0.08, 2, starts[0]!, true)
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('Benchmark is not deterministic')
  data['repeatCheck'] = first
} else if (suite === 'diagnostics') {
  data['duels'] = [0.03, 0.08].flatMap((a) => starts.flatMap((start) => [1, 2, 3].map((seed) => duel(a, seed, start, false))))
  data['traces'] = [duel(0.03, 1, starts[0]!, true, 120, 12, true), duel(0.08, 1, starts[1]!, true, 120, 12, true)]
} else if (suite === 'field') {
  const fields = []
  for (const reverse of [false, true]) for (const mistakes of [false, true]) for (const seed of [1, 2, 3]) {
    const result = field(seed, reverse, mistakes)
    fields.push(result)
    console.log(JSON.stringify({ seed, reverse, mistakes, events: result.events.length, contacts: result.contacts }))
    data['fields'] = fields; writeFileSync(out, JSON.stringify(data, null, 2))
  }
} else throw new Error(`Unknown suite ${suite}`)
data['elapsedMs'] = performance.now() - began
writeFileSync(out, JSON.stringify(data, null, 2))
console.log(`Saved ${out} (${((performance.now() - began) / 1000).toFixed(1)}s headless)`)

