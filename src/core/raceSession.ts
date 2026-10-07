/**
 * A race the game can actually run: the player, a field of AI, and one tick.
 *
 * `Race` already owns the hard parts — N sims sharing a circuit, contact,
 * the grid, the phases, the standings. What it does not own is who is driving:
 * it takes an action per car per tick and asks no questions. That is right for
 * a bench, where every car is a `LineFollower`, and not enough for the game,
 * where exactly one of them is a person.
 *
 * So this is the join. It holds the followers, knows which slot is the player's,
 * and turns "here is what the player pressed" into a full set of actions. The
 * game loop then has one call to make per tick instead of a fan-out it would
 * have to keep in step with itself.
 *
 * IT DOES NOT BUILD LINES. Searching for one is half a minute of blocked main
 * thread, so the caller hands in a shape that came out of `bakedLines`, and
 * every driver's own line is `atCommitment` off it — which is O(stations) and
 * costs nothing. See `bakedLines.ts` for why that is baked rather than found.
 */
import { atCommitment, type RacingLine } from './racingLine'
import {
  cornerIndex, Mistakes, seeded,
} from './racecraft'
import { nearestStation } from './racingLine'
import { findCorners } from './corners'
import { LineFollower } from './referenceDriver'
import type { CarParams } from './carParams'
import { Race, type RaceAction, type RacePhase } from './race'
import { GRID_SLOTS } from './grid'
import { RacingRibbon, TrafficPlanner, type TrafficCar } from './trafficPlanner'
import { RaceLaunch } from './raceLaunch'

import type { SimOptions, StepResult, TimeAttackSim } from './sim'
import type { Track } from './track'

/**
 * How hard the field tries, as a band of commitments.
 *
 * `commitment` is a real dial now — the follower holds 1.01 to 1.18 across the
 * circuits, and drops cleanly to a crawl below that — so difficulty can be one
 * number per tier rather than a table of hand-tuned opponents. The SPREAD
 * matters as much as the level: a field that all drives identically never
 * changes order, and a race where nothing changes order is a procession.
 */
export interface Difficulty {
  readonly name: string
  readonly label: string
  /** Commitment for the quickest car in the field. */
  readonly top: number
  /** How much slower the back of the grid is, in commitment. */
  readonly spread: number
  /**
   * Chance of getting any one corner wrong, and how wrong in metres.
   *
   * Non-zero at every level on purpose. A field where the quick cars are
   * perfect and only the slow ones err does not read as a field of drivers, it
   * reads as one driver and some handicaps. Even the best make mistakes; they
   * just make fewer and smaller ones.
   */
  readonly mistakeChance: number
  readonly mistakeSize: number
}

/**
 * The commitment one grid slot runs at.
 *
 * `commitment` means two different things depending on where the line came
 * from, and the difficulty bands were written for only one of them. Against a
 * MODELLED line it scales the grip the profile plans against, and going past
 * 1.0 is not just allowed but expected — 1.0 is the model's estimate of the
 * limit, not the car's, and the sim regularly holds more.
 *
 * Against a RECORDED line it scales the speed a human actually carried. There
 * is no headroom above 1.0 there: it means "go faster than the lap this was
 * taken from", which puts the car off the road. Measured on Croft Bay, the
 * bands as written sent `ruthless` off at 552 m on its first lap and kept it
 * off; `quick` survived to 1469 m.
 *
 * So the same three names map onto a band that stops below the driver's own
 * pace. Ruthless runs at 99% of it, which is quick enough given the follower
 * is more consistent than the person who set it.
 */
export function commitmentFor(d: Difficulty, t: number, recorded: boolean): number {
  const top = recorded ? RECORDED_FLOOR + (d.top - MODEL_BOTTOM) * RECORDED_SCALE : d.top
  const spread = recorded ? d.spread * RECORDED_SCALE : d.spread
  return top - spread * t
}

/** The modelled band runs 0.88-1.14; the recorded one 0.86-0.99. */
const MODEL_BOTTOM = 0.88
const RECORDED_FLOOR = 0.86
const RECORDED_SCALE = (0.99 - RECORDED_FLOOR) / (1.14 - MODEL_BOTTOM)

export const DIFFICULTIES: readonly Difficulty[] = [
  { name: 'steady', label: 'Steady', top: 0.88, spread: 0.10, mistakeChance: 0.16, mistakeSize: 34 },
  { name: 'quick', label: 'Quick', top: 1.02, spread: 0.09, mistakeChance: 0.10, mistakeSize: 24 },
  { name: 'ruthless', label: 'Ruthless', top: 1.14, spread: 0.07, mistakeChance: 0.06, mistakeSize: 16 },
]

export const difficultyByName = (name: string): Difficulty =>
  DIFFICULTIES.find((d) => d.name === name) ?? DIFFICULTIES[1]!

/** A minute of interval history, at 60 Hz. Longer than any gap worth showing. */
const TRACE_SAMPLES = 60 * 60

/** The most opponents the painted grid has room for beside the player. */
export const MAX_OPPONENTS = GRID_SLOTS - 1

/** The longest race the menu offers. Long enough to matter, short enough to finish. */
export const MAX_RACE_LAPS = 15

export interface RaceSetup {
  /** Interactive keyboard launch; headless drivers may supply their own starts. */
  playerLaunch?: boolean
  /** Repeatable race variation. The game supplies a fresh seed for each start. */
  seed?: number
  track: Track
  trackId: string
  params: CarParams
  preset: string
  /** The optimised shape, from a baked file. Speeds are rebuilt per driver. */
  shape: RacingLine
  laps: number
  opponents: number
  difficulty: Difficulty
  easy?: boolean
  /**
   * Overrides the mix of early and late mistakes. For experiments only.
   *
   * The reason this is reachable from outside at all is that the late cap was
   * chosen by reasoning — braking late looked dangerous — rather than by
   * measurement, and that is not a good enough reason for a constant.
   */
  mistakeShape?: { earlyChance?: number; lateShare?: number }
  /**
   * Sim options for the PLAYER's car only.
   *
   * Only the player's, and that is not an oversight. The rotary traction
   * control is a thing a person turns mid-lap, so its channel has to exist on
   * their sim from the first tick; the AI has no hands and never touches it.
   * More to the point, the follower was tuned against the preset's OWN traction
   * control, and handing it the rotary instead would quietly hand it a
   * different car from the one every lap time in the benches was measured on.
   */
  sim?: Omit<SimOptions, 'slot'>
  /**
   * Where the player starts, 0 being pole.
   *
   * Defaults to the BACK of the grid, which is the only starting slot that
   * makes a race out of a field whose pace you have chosen: from pole there is
   * nobody ahead, and the whole event is a time trial with traffic in the
   * mirrors.
   */
  playerSlot?: number
  /** Driver IDs in qualifying order; AI IDs are 0..opponents-1, player is last. */
  gridOrder?: readonly number[]
}

export class RaceSession {
  readonly race: Race
  readonly seed: number
  readonly launch: RaceLaunch | null
  private readonly driverIds: readonly number[]
  private readonly reactions: number[] = []
  private startArmed = false
  /** Diagnostic switch: disable traffic decisions for baseline comparisons. */
  awareness = true
  /** Retained for existing lab callers; racing is enabled by default. */
  overtaking = true
  private readonly planners: (TrafficPlanner | null)[] = []
  private readonly traffic: TrafficCar[] = []
  private tick = 0
  /** Where each car was on the line last tick, so the search stays local. */
  private readonly stations: number[] = []
  /** Each AI's mistakes, re-rolled as it arrives at each corner. */
  private readonly mistakes: (Mistakes | null)[] = []
  /** The shape every AI is following, for working out how much road is spare. */
  private readonly shape: RacingLine
  readonly playerSlot: number
  readonly laps: number
  readonly difficulty: Difficulty
  /** One follower per car, with the player's slot left null. */
  private readonly drivers: (LineFollower | null)[]
  /** Reused each tick so a 60 Hz race does not allocate an array of actions. */
  private readonly actions: RaceAction[]
  /**
   * When each car was last at each distance — the interval trace.
   *
   * A gap in METRES is easy and slightly wrong: fifty metres is half a second
   * down the straight and two seconds through a hairpin, so the number moves
   * for reasons that have nothing to do with anybody's pace. A gap in SECONDS
   * is what a driver means by a gap, and getting it right needs a history: the
   * interval to the car ahead is how long ago THEY were where I am now.
   *
   * A ring per car of distance and race time, written once a tick. Sixty
   * seconds is far longer than any gap worth showing and costs two Float64
   * arrays of 3600 per car, which is a rounding error against one lap of
   * recorded replay.
   */
  private readonly traceDist: Float64Array[]
  private readonly traceTime: Float64Array[]
  private traceAt = 0
  private traceLen = 0
  /**
   * The fastest each sector has gone THIS RACE, by anybody.
   *
   * A race is its own event. Colouring a split against a personal best set
   * alone on an empty circuit says nothing about the race you are in — it is
   * mostly a statement about how long ago you set that best, and on a first lap
   * it makes every sector yellow before you have had a chance. Purple here
   * means what it means on television: nobody in this race has gone quicker
   * through that corner.
   */
  readonly fastestSectors: (number | null)[] = [null, null, null]
  /** The quickest valid lap of the race so far, and who set it. */
  fastestLap: { slot: number; time: number } | null = null
  /** The player's own quickest valid lap of this race. */
  playerBest: number | null = null
  /**
   * The player's last lap against their best of the race, in seconds.
   *
   * Measured against the best of their OTHER laps, not against the standing
   * best including this one — otherwise the lap that sets a new best always
   * reads 0.000, which is the one time the number had something to say. This
   * way it answers the question actually being asked: did that lap improve on
   * the race so far, and by how much. Null on the first lap, which has nothing
   * to be compared with.
   */
  lastLapDelta: number | null = null

  constructor(setup: RaceSetup) {
    this.seed = setup.seed ?? 0x9e37
    this.launch = setup.playerLaunch ? new RaceLaunch() : null
    const field = Math.min(setup.opponents, MAX_OPPONENTS) + 1
    this.laps = Math.max(1, Math.floor(setup.laps))
    this.difficulty = setup.difficulty
    if (setup.gridOrder && (setup.gridOrder.length !== field
      || new Set(setup.gridOrder).size !== field
      || setup.gridOrder.some((id) => !Number.isInteger(id) || id < 0 || id >= field))) {
      throw new Error('Qualifying grid must contain every driver exactly once.')
    }
    this.playerSlot = setup.gridOrder
      ? setup.gridOrder.indexOf(field - 1) : setup.playerSlot ?? field - 1
    this.driverIds = setup.gridOrder ? [...setup.gridOrder]
      : Array.from({ length: field }, (_, slot) => slot === this.playerSlot
        ? field - 1 : slot > this.playerSlot ? slot - 1 : slot)

    this.shape = setup.shape
    this.race = new Race(
      setup.track,
      Array.from({ length: field }, (_, slot) => ({
        slot,
        params: setup.params,
        easy: setup.easy ?? false,
        ...(slot === this.playerSlot && setup.sim ? { sim: setup.sim } : {}),
      })),
      { laps: this.laps, trackId: setup.trackId, preset: setup.preset,
        startHoldTicks: this.launch ? 60 + Math.floor(seeded(Math.imul(this.seed ^ 0x51a7, 0x9e3779b1))() * 121) : 0,
        postFinishControl: !!setup.playerLaunch },
    )

    // Pace and driver identity survive any reordering of the qualified grid.
    this.drivers = []
    this.actions = []
    this.traceDist = Array.from({ length: field }, () => new Float64Array(TRACE_SAMPLES))
    this.traceTime = Array.from({ length: field }, () => new Float64Array(TRACE_SAMPLES))
    const ribbon = new RacingRibbon(setup.track, setup.shape)
    const opponents = field - 1
    for (let slot = 0; slot < field; slot++) {
      const identity = setup.gridOrder ? this.driverIds[slot]! : slot
      const random = seeded((this.seed + identity * 2654435761) >>> 0)
      // Staged throttle, with a distinct 50–250 ms clutch release per driver.
      // The spread makes starts competitive without linking reflexes to pace.
      this.reactions.push((3 + Math.floor(random() * 13)) / 60)
      this.actions.push({ steer: 0, throttle: 0 })
      const sim = this.race.sims[slot]!
      this.traffic.push({ state: sim.car.s, road: setup.track.project(sim.car.s.x, sim.car.s.y), speed: 0 })
      this.stations.push(0)
      if (slot === this.playerSlot) {
        this.drivers.push(null)
        this.planners.push(null)
        this.mistakes.push(null)
        continue
      }
      // Rank among the AI only, so the player's slot does not leave a gap in
      // the pace ladder.
      const rank = this.driverIds[slot]!
      const t = opponents > 1 ? rank / (opponents - 1) : 0
      const commitment = commitmentFor(setup.difficulty, t, setup.shape.recorded != null)
      const driverLine = atCommitment(setup.shape, setup.params, commitment)
      const follower = new LineFollower(setup.params, driverLine)
      this.planners.push(new TrafficPlanner(ribbon, driverLine, setup.params, {
        side: (random() * 2 - 1) * 0.7,
        clearance: 0.6 + random() * 0.15,
        preparation: 2 + random() * 0.2,
        cruise: (random() * 2 - 1) * 0.25,
      }))
      // Mistakes, rolled fresh at each corner. Seeded off the grid slot so a
      // race is reproducible without every driver erring in the same places.
      const mistakes = new Mistakes(
        driverLine.x.length,
        cornerIndex(driverLine.x.length, findCorners(driverLine).filter((c) => c.corner)),
        seeded(this.seed + identity * 2654435761),
        setup.difficulty.mistakeChance,
        setup.difficulty.mistakeSize,
        setup.mistakeShape?.earlyChance,
        setup.mistakeShape?.lateShare,
      )
      follower.brakeBias = mistakes.biases
      this.mistakes.push(mistakes)
      this.drivers.push(follower)
    }
  }

  get size(): number {
    return this.race.size
  }

  get phase(): RacePhase {
    return this.race.phase
  }

  /** What a given car is currently driving off the line, for diagnostics. */
  offsetOf(slot: number): number {
    const p = this.planners[slot]
    return p ? (p.decision.lane ?? this.shape.offset[this.stations[slot]!]!)
      - this.shape.offset[this.stations[slot]!]! : 0
  }

  /** Current plan for the race lab and deterministic interaction checks. */
  planOf(slot: number): TrafficPlanner | null { return this.planners[slot] ?? null }

  /** How many corners each AI has judged, and how many it got wrong. */
  mistakeCount(slot: number): { judged: number; erred: number } {
    const m = this.mistakes[slot]
    return { judged: m?.judged ?? 0, erred: m?.erred ?? 0 }
  }

  /** The player's own sim — the one the HUD, the camera and the recording read. */
  get playerSim(): TimeAttackSim {
    return this.race.sims[this.playerSlot]!
  }

  /** Identity remains the same when qualifying changes a car's grid position. */
  driverIdOf(slot: number): number { return this.driverIds[slot]! }

  begin(): void {
    this.startArmed = true
    if (!this.launch) this.race.beginCountdown()
  }

  /**
   * Step every car one tick, given what the player is doing.
   *
   * The AI reads the state at the TOP of the tick, exactly as the player's own
   * input does, so nobody is reacting to a world half a tick newer than
   * everyone else's.
   */
  step(playerSteer: number, playerThrottle: number, shift = 0, tcLevel?: number,
    launchInput?: { clutch: boolean; throttle: boolean }): StepResult[] {
    if (this.launch && this.startArmed) {
      if (this.race.phase === 'waiting' && launchInput?.clutch) this.race.beginCountdown()
      this.launch.update(launchInput?.clutch ?? false, launchInput?.throttle ?? false, this.race.running)
    }
    // Snapshot actual positions before any driver makes a decision.
    for (let i = 0; i < this.race.sims.length; i++) {
      const sim = this.race.sims[i]!
      const car = this.traffic[i]!
      car.state = sim.car.s
      car.road = this.race.track.project(sim.car.s.x, sim.car.s.y)
      car.speed = sim.speed
    }
    for (let i = 0; i < this.drivers.length; i++) {
      const driver = this.drivers[i]
      const action = this.actions[i]!
      if (!driver) {
        action.steer = playerSteer
        action.throttle = playerThrottle
        if (this.launch && this.launch.state !== 'launched') action.throttle = 0
        action.shift = shift
        if (tcLevel !== undefined) action.tcLevel = tcLevel
        continue
      }
      const sim = this.race.sims[i]!
      driver.flying = sim.lapsCompleted > 0
      driver.offTrack = sim.offTrack
      const station = nearestStation(this.shape, sim.car.s.x, sim.car.s.y, this.stations[i]!)
      this.stations[i] = station
      this.mistakes[i]?.update(station)
      const planner = this.planners[i]!
      if (this.awareness) {
        // 10 Hz decisions, staggered across the field; 60 Hz control and safety.
        if (this.tick === 0 || (this.tick + i) % 6 === 0) {
          driver.setLine(planner.update(this.traffic, i, this.overtaking))
        }
        driver.speedLimit = planner.speedLimit(this.traffic, i)
      } else {
        driver.setLine(planner.reference)
        driver.lateralOffset = 0
        driver.speedLimit = Infinity
      }
      const controls = driver.next(sim.car.s)
      action.steer = controls.steer
      action.throttle = controls.pedal
      if (this.startArmed) {
        // Stage full throttle behind the grid hold, just as the player holds W
        // behind the clutch. Race.step prevents movement before lights-out.
        // On the transition tick it becomes live, so keep the clutch held
        // until this driver's reaction has elapsed.
        const greenThisTick = this.race.phase === 'countdown' && this.race.countdownTicks === 0
        if (!this.race.running && !greenThisTick) action.throttle = 1
        else if (greenThisTick || this.race.raceTime < this.reactions[i]!) action.throttle = 0
      }
      action.shift = 0
    }
    this.tick++
    let finishedBefore = 0
    for (let i = 0; i < this.race.size; i++) {
      if (this.race.finishedAt(i) !== null) finishedBefore |= 1 << i
    }
    const results = this.race.step(this.actions)
    this.recordTrace()
    this.recordBests(results, finishedBefore)
    return results
  }

  /**
   * Fold every car's splits into the race's own bests.
   *
   * Polled rather than pushed, because a sim announces a finished LAP but not a
   * finished SECTOR — and re-reading a split that is already folded is
   * harmless, since the fold is a minimum.
   *
   * Only valid laps count, matching the rule the sim uses for its own bests: a
   * purple set by cutting a corner is not a purple.
   */
  private recordBests(results: readonly StepResult[], finishedBefore: number): void {
    for (let i = 0; i < this.race.sims.length; i++) {
      if (finishedBefore & (1 << i)) continue
      const sim = this.race.sims[i]!
      const fold = (splits: readonly (number | null)[]): void => {
        for (let k = 0; k < this.fastestSectors.length; k++) {
          const split = splits[k]
          if (split === null || split === undefined) continue
          const best = this.fastestSectors[k] ?? null
          if (best === null || split < best) this.fastestSectors[k] = split
        }
      }
      if (sim.lapValid) fold(sim.currentSectors)
      // The LAST lap's splits as well, and not for belt and braces: the final
      // sector is written and `currentSectors` is wiped for the new lap inside
      // the same tick, so polling the live array alone never sees sector three
      // at all. It stayed null for a whole race.
      if (sim.lastLapValid) fold(sim.lastSectors)
      const lap = results[i]?.lapCompleted
      if (!lap || !lap.valid) continue
      if (this.fastestLap === null || lap.time < this.fastestLap.time) {
        this.fastestLap = { slot: i, time: lap.time }
      }
      if (i === this.playerSlot) {
        // Read the reference BEFORE folding this lap into it.
        this.lastLapDelta = this.playerBest === null ? null : lap.time - this.playerBest
        if (this.playerBest === null || lap.time < this.playerBest) this.playerBest = lap.time
      }
    }
  }

  /** True when `split` is the fastest anyone has gone through sector `i`. */
  isRaceFastestSector(i: number, split: number): boolean {
    const best = this.fastestSectors[i] ?? null
    return best !== null && split <= best + 1e-6
  }

  /** One sample per car per tick, into the ring. */
  private recordTrace(): void {
    const t = this.race.raceTime
    for (let i = 0; i < this.traceDist.length; i++) {
      this.traceDist[i]![this.traceAt] = this.race.distanceTravelled(i)
      this.traceTime[i]![this.traceAt] = t
    }
    this.traceAt = (this.traceAt + 1) % TRACE_SAMPLES
    if (this.traceLen < TRACE_SAMPLES) this.traceLen++
  }

  /**
   * Seconds between two cars: how long ago `ahead` was where `behind` is now.
   *
   * Null when the trace does not reach back far enough — at the start, or for a
   * gap bigger than the ring holds. A null is honest; extrapolating would put a
   * confident wrong number on screen.
   */
  gapSeconds(ahead: number, behind: number): number | null {
    const target = this.race.distanceTravelled(behind)
    const dist = this.traceDist[ahead]
    const time = this.traceTime[ahead]
    if (!dist || !time || this.traceLen === 0) return null
    // Walk back from the newest sample until the car ahead was behind `target`.
    let prev = -1
    for (let k = 1; k <= this.traceLen; k++) {
      const i = (this.traceAt - k + TRACE_SAMPLES * 2) % TRACE_SAMPLES
      if (dist[i]! <= target) { prev = i; break }
    }
    if (prev < 0) return null
    // Linear interpolation between the straddling samples, so the number does
    // not step by a tick as the car ahead moves between them.
    const next = (prev + 1) % TRACE_SAMPLES
    const d0 = dist[prev]!
    const d1 = dist[next]!
    const span = d1 - d0
    const frac = span > 1e-6 ? (target - d0) / span : 0
    const when = time[prev]! + (time[next]! - time[prev]!) * frac
    return Math.max(0, this.race.raceTime - when)
  }

  /** Seconds to the car ahead of the player, or null when leading. */
  intervalAhead(): number | null {
    const order = this.race.standings()
    const at = order.indexOf(this.playerSlot)
    if (at <= 0) return null
    return this.gapSeconds(order[at - 1]!, this.playerSlot)
  }

  /** Seconds to the car behind the player, or null when last. */
  intervalBehind(): number | null {
    const order = this.race.standings()
    const at = order.indexOf(this.playerSlot)
    if (at < 0 || at >= order.length - 1) return null
    return this.gapSeconds(this.playerSlot, order[at + 1]!)
  }

  /** Live position of the player, 1-based. */
  playerPosition(): number {
    return this.race.standings().indexOf(this.playerSlot) + 1
  }

  /** Metres of track to the car ahead on the road, or null when leading. */
  gapAhead(): number | null {
    const order = this.race.standings()
    const at = order.indexOf(this.playerSlot)
    if (at <= 0) return null
    return this.race.gapToLeader(this.playerSlot) - this.race.gapToLeader(order[at - 1]!)
  }

  /** Metres of track to the car behind, or null when last. */
  gapBehind(): number | null {
    const order = this.race.standings()
    const at = order.indexOf(this.playerSlot)
    if (at < 0 || at >= order.length - 1) return null
    return this.race.gapToLeader(order[at + 1]!) - this.race.gapToLeader(this.playerSlot)
  }

  /**
   * Whether the PLAYER's race is over — which is not the same as the field's.
   *
   * `Race` flags only once every car has finished, and that is the right rule
   * for a bench where every car is a follower that always gets round. It is the
   * wrong rule for a game: a player who spins into a wall and stops would hang
   * the race forever, waiting for a car that is never going to move. So the
   * game asks this instead, and a race ends for the person playing it the
   * moment they take the flag.
   */
  get playerFinished(): boolean {
    return this.race.finishedAt(this.playerSlot) !== null
  }

  /**
   * The classification as it stands, leader first.
   *
   * Cars still circulating are included, ranked on distance, so this is
   * readable mid-race as a live order and after the player finishes as a
   * result — which is what a results screen wants, since the field is usually
   * still out there when the player crosses the line.
   */
  results(): {
    slot: number
    position: number
    isPlayer: boolean
    laps: number
    finishedAt: number | null
    penaltySeconds: number
    best: number | null
  }[] {
    return this.race.classification().map((slot, i) => {
      const sim = this.race.sims[slot]!
      return {
        slot,
        position: i + 1,
        isPlayer: slot === this.playerSlot,
        laps: sim.lapsCompleted,
        finishedAt: this.race.adjustedFinishTime(slot),
        penaltySeconds: this.race.trackLimits[slot]!.penaltySeconds,
        best: sim.bestLapTime,
      }
    })
  }

  /** Every car's state, for the renderer. The player's slot is included. */
  states(): { x: number; y: number; yaw: number; vx: number; wheelVr: number }[] {
    return this.race.sims.map((s) => s.car.s)
  }
}
