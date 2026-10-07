/**
 * A multi-car race: N drivers, one circuit, a start procedure, and a flag.
 *
 * A port of ``racing/race.py``, and it keeps that file's central decision:
 * `Sim` is single-car by design and stays that way. Widening it to a field
 * would drag lap timing, sectors and personal bests into a mess of indices for
 * no benefit, because those things are inherently per-driver — you each get
 * your own clock and your own invalidated lap, and `Sim` already does all of
 * that correctly. A race is therefore *N sims sharing one Track*:
 *
 *     Race
 *      |- track          one shared circuit (sims take it in their constructor)
 *      |- sims[i]        one Sim per driver: own car, own lap clock, own PB
 *      |- phase          waiting -> countdown -> racing -> finished
 *      `- step(actions)  step every sim, then resolve car-to-car contact
 *
 * The only genuinely shared things are the tarmac, the contacts and the flag,
 * so those are what `Race` owns.
 *
 * **Ordering within a tick**: every car integrates first, then contacts are
 * resolved across the whole field. Resolving pairwise as you go would make the
 * result depend on which driver happened to be stepped first — driver 0 would
 * get a systematically different crash from driver 3. Doing it afterwards, on
 * the settled poses, treats the field symmetrically.
 *
 * **Timing is counted in ticks, not wall-clock.** The countdown and the start
 * hold advance on the physics tick, so a race is reproducible and testable, and
 * a browser that stutters delays the start rather than skipping through it.
 */
import type { CarParams } from './carParams'
import { CAR_FRICTION, CAR_RESTITUTION, resolveCars } from './collision'
import { GRID_SLOTS } from './grid'
import { DT, TimeAttackSim, type SimOptions, type StepResult } from './sim'
import type { Track } from './track'
import { TrackLimits } from './trackLimits'

export type RacePhase = 'waiting' | 'countdown' | 'racing' | 'finished'

/** Ticks the lights hold before they go out. Three seconds at 60 Hz. */
export const COUNTDOWN_TICKS = 180

export interface RaceEntry {
  /** Zero-based painted grid slot. Slot 0 is pole. */
  slot: number
  params: CarParams
  easy?: boolean
  /** Anything else the underlying `Sim` should be built with. */
  sim?: Omit<SimOptions, 'slot'>
}

export interface RaceOptions {
  /** Extra all-red hold, sampled once by the session. */
  startHoldTicks?: number
  laps?: number
  contact?: boolean
  restitution?: number
  friction?: number
  trackId?: string
  preset?: string
  /** Keep the field moving after the flag in an interactive race. */
  postFinishControl?: boolean
}

/** One driver's control command for a tick. */
export interface RaceAction {
  steer: number
  throttle: number
  shift?: number
  tcLevel?: number
}

export class Race {
  readonly track: Track
  readonly sims: TimeAttackSim[]
  readonly laps: number
  readonly trackLimits: TrackLimits[]
  private readonly contact: boolean
  private readonly restitution: number
  private readonly friction: number
  private readonly postFinishControl: boolean

  phase: RacePhase = 'waiting'
  /** Ticks elapsed in the current phase. The race clock reads off this. */
  private phaseTicks = 0
  private readonly startTicks: number
  /** Peak contact impulse each car took on the last tick, N·s. */
  impacts: Float64Array
  /**
   * Distance travelled, in metres of track, for every driver.
   *
   * Measured as absolute arc length from the start/finish line plus completed
   * laps — deliberately NOT from the sim's own lap progress. That counter
   * resets to zero the moment the clock arms on the first crossing, so a
   * distance built on it jumps backwards ~12 m at the start, and drivers stop
   * being comparable to one another exactly when the order first matters.
   *
   * Arc length has none of that. It is the same coordinate for everybody and it
   * stays continuous through the line: crossing takes `s` from ~length back to
   * ~0 exactly as the lap counter ticks up.
   */
  private readonly distance: Float64Array
  /** Finishing order, earliest first. Once classified, you cannot be un-beaten. */
  private readonly finishOrder: number[] = []
  private readonly finishTime = new Map<number, number>()
  private readonly finishDistance = new Map<number, number>()

  constructor(track: Track, entries: readonly RaceEntry[], opts: RaceOptions = {}) {
    this.startTicks = COUNTDOWN_TICKS + Math.max(0, Math.floor(opts.startHoldTicks ?? 0))
    if (entries.length < 1) throw new Error('a race needs at least one car')
    const slots = new Set(entries.map((e) => e.slot))
    if (slots.size !== entries.length) throw new Error('two cars cannot share a grid slot')
    for (const e of entries) {
      if (!Number.isInteger(e.slot) || e.slot < 0 || e.slot >= GRID_SLOTS) {
        throw new RangeError(`Grid slot ${e.slot} is outside 0..${GRID_SLOTS - 1}.`)
      }
    }

    this.track = track
    this.laps = Math.max(1, Math.floor(opts.laps ?? 3))
    this.contact = opts.contact ?? true
    this.restitution = opts.restitution ?? CAR_RESTITUTION
    this.friction = opts.friction ?? CAR_FRICTION
    this.postFinishControl = opts.postFinishControl ?? false
    this.sims = entries.map((e) => new TimeAttackSim(
      track, e.params, opts.trackId ?? 'race', opts.preset ?? 'f1', e.easy ?? false,
      { ...e.sim, slot: e.slot },
    ))
    this.trackLimits = entries.map(() => new TrackLimits())
    this.impacts = new Float64Array(this.sims.length)
    this.distance = new Float64Array(this.sims.length)
    this.updateDistances()
  }

  get size(): number {
    return this.sims.length
  }

  /** True once the lights are out — racing, or already flagged. */
  get running(): boolean {
    return this.phase === 'racing' || this.phase === 'finished'
  }

  /** Seconds since the lights went out; zero before the start. */
  get raceTime(): number {
    return this.running ? this.phaseTicks * DT : 0
  }

  /** Ticks left on the countdown, or zero when it is not running. */
  get countdownTicks(): number {
    return this.phase === 'countdown' ? Math.max(this.startTicks - this.phaseTicks, 0) : 0
  }

  /** Display elapsed light stages, never the secret remaining hold time. */
  get lightCount(): number {
    return this.phase === 'countdown' ? Math.min(5, Math.floor(this.phaseTicks / (COUNTDOWN_TICKS / 5))) : 0
  }

  /** Start the light sequence. The field is held until it expires. */
  beginCountdown(): void {
    if (this.phase !== 'waiting') return
    this.phase = 'countdown'
    this.phaseTicks = 0
  }

  /**
   * Advance every car by one tick, then resolve contact.
   *
   * Before the lights go out every action is forced to zero, so the grid is
   * physically incapable of a jump start rather than merely discouraged from
   * one — the cars are held by the same code path that drives them. A driver
   * An interactive race keeps the field moving after the flag so no car stops
   * on the racing surface. Classification is still frozen at each crossing.
   */
  step(actions: readonly RaceAction[]): StepResult[] {
    if (actions.length !== this.sims.length) {
      throw new Error(`got ${actions.length} actions for ${this.sims.length} drivers`)
    }
    if (this.phase === 'countdown' && this.phaseTicks >= this.startTicks) {
      this.phase = 'racing' // lights out, away we go
      this.phaseTicks = 0
    }

    const live = this.running
    const results: StepResult[] = []
    for (let i = 0; i < this.sims.length; i++) {
      const a = actions[i]!
      const held = !live || (this.finishTime.has(i) && !this.postFinishControl)
      results.push(this.sims[i]!.step(
        held ? 0 : a.steer,
        held ? 0 : a.throttle,
        held ? 0 : (a.shift ?? 0),
        a.tcLevel,
      ))
    }

    if (this.contact) {
      this.impacts = resolveCars(
        this.sims.map((s) => s.car), this.restitution, this.friction,
      )
    } else {
      this.impacts.fill(0)
    }

    this.phaseTicks++
    this.updateDistances()
    for (let i = 0; i < this.sims.length; i++) {
      this.trackLimits[i]!.update(this.sims[i]!.offTrack,
        this.phase === 'racing' && !this.finishTime.has(i))
    }
    if (this.phase === 'racing') this.checkFinishers(results)
    return results
  }

  private updateDistances(): void {
    for (let i = 0; i < this.sims.length; i++) {
      if (this.finishDistance.has(i)) continue // frozen at the flag
      const sim = this.sims[i]!
      const s = this.track.project(sim.car.s.x, sim.car.s.y).s
      this.distance[i] = sim.timingArmed
        ? sim.lapsCompleted * this.track.length + s
        // Still on the run from the grid to the line: negative distance, so the
        // run-up orders correctly against a car already away.
        : s - this.track.length
    }
  }

  private checkFinishers(results: readonly StepResult[]): void {
    for (let i = 0; i < this.sims.length; i++) {
      if (this.finishTime.has(i)) continue
      if (!results[i]!.lapCompleted) continue
      if (this.sims[i]!.lapsCompleted < this.laps) continue
      this.finishTime.set(i, this.raceTime)
      this.finishDistance.set(i, this.distance[i]!)
      this.finishOrder.push(i)
    }
    if (this.finishTime.size === this.sims.length) this.phase = 'finished'
  }

  /**
   * How far a driver has come, in metres of track. Frozen once they take the
   * flag — their race is over, so the number that classifies them must stop
   * moving even though the car has not.
   */
  distanceTravelled(driver: number): number {
    return this.finishDistance.get(driver) ?? this.distance[driver]!
  }

  /** Seconds a driver took to finish, or null if they are still circulating. */
  finishedAt(driver: number): number | null {
    return this.finishTime.get(driver) ?? null
  }

  adjustedFinishTime(driver: number): number | null {
    const time = this.finishedAt(driver)
    return time === null ? null : time + this.trackLimits[driver]!.penaltySeconds
  }

  /** Classification includes penalties; the live order remains the on-road order. */
  classification(): number[] {
    const finished = [...this.finishOrder].sort((a, b) =>
      this.adjustedFinishTime(a)! - this.adjustedFinishTime(b)!)
    return [...finished, ...this.standings().filter((driver) => !this.finishTime.has(driver))]
  }

  /**
   * Driver indices, leader first.
   *
   * Drivers who have taken the flag are locked into the order they finished:
   * once you are classified, someone still circulating cannot un-beat you.
   * Everyone else is ranked by total distance travelled.
   *
   * The tempting measure — arc length round the lap — is wrong at exactly the
   * moment a race is most interesting: the instant a leader crosses the line
   * their `s` drops to nearly zero and they appear to be last. Accumulated
   * distance is continuous through the line, so it stays monotonic all the way
   * round.
   */
  standings(): number[] {
    const running: number[] = []
    for (let i = 0; i < this.sims.length; i++) {
      if (!this.finishTime.has(i)) running.push(i)
    }
    running.sort((a, b) => this.distanceTravelled(b) - this.distanceTravelled(a))
    return [...this.finishOrder, ...running]
  }

  /** Driver index -> live position, 1-based. */
  positions(): number[] {
    const out = new Array<number>(this.sims.length)
    this.standings().forEach((driver, k) => { out[driver] = k + 1 })
    return out
  }

  /** Metres of track between a driver and the leader. Zero for the leader. */
  gapToLeader(driver: number): number {
    const leader = this.standings()[0]!
    return this.distanceTravelled(leader) - this.distanceTravelled(driver)
  }
}
