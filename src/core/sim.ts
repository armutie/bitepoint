/**
 * Time attack simulation — the lap-timing half of ``racing/env.py``.
 *
 * The car is the car and the track is the track; this is the thing that puts
 * them together and decides what a lap *is*: when the clock starts, when it
 * stops, and whether the lap counted. Those rules are ported rather than
 * reinvented, because a browser lap and a Python lap have to mean the same thing
 * for the records to be comparable.
 *
 * Deliberately free of rendering, DOM and timing-of-the-real-world. It advances
 * only when someone calls ``step``, always by the same fixed ``dt``, which is
 * what makes a recorded lap replay to the identical result.
 *
 * The RL-specific parts of the env — observations, rewards, termination — are
 * absent. Nothing here needs them, and the reward shaping is the part most
 * likely to keep changing on the Python side.
 */
import { Barriers } from './barriers.ts'
import { Car, initialState, speedOf, type CarState } from './car.ts'
import type { CarParams } from './carParams.ts'
import { TC_LEVEL_DEFAULT, TC_LEVEL_MAX } from './carParams.ts'
import { gridPose, GRID_SLOTS } from './grid.ts'
import { clamp, wrapAngle } from './math.ts'
import type { Track } from './track.ts'

/** Physics tick. Matches ``RacingEnv``'s default, and is not negotiable: the
 *  handling was tuned at this rate and the fixtures are generated at it. */
export const DT = 1.0 / 60.0
export const SUBSTEPS = 10

/** Grass: low grip and heavy drag, so running wide costs you. */
export const OFF_TRACK_GRIP = 0.4
export const OFF_TRACK_ROLLING = 6.0
/**
 * How far past the painted edge counts as off. The car is a rectangle but the
 * check is on the centre point, and 1.2 m is roughly the point at which a real
 * wheel would be on the grass.
 */
export const OFF_TRACK_MARGIN = 1.2
/** Time attack starts from the rearmost painted slot for a full-grid run-up. */
export const STAGE_SLOT = GRID_SLOTS - 1

export const SECTORS = 3

export interface SimOptions {
  /**
   * Solid barrier walls. On by default, matching `play.py`.
   *
   * Python defaults this off because every trained checkpoint and recorded demo
   * comes from a world with no walls in it, and that has to stay reproducible.
   * The browser has no such constraint: it is the game, not the trainer, and
   * `play.py` — the game on the Python side — switches them on.
   */
  walls?: boolean
  /** Full grip on the grass, as the Python easy mode does on the env. */
  easyGrass?: boolean
  /** Manual gearbox: the driver shifts, and the shifts are recorded. */
  manual?: boolean
  /**
   * The wheel rotary drives traction control, and its position is recorded.
   *
   * It has to be recorded for the same reason the gear does. TC changes what
   * the tyres are allowed to do, so a lap driven while turning the knob replays
   * into a different line under a fixed TC, the ghost drifts, and
   * `verifyLapRecording` rejects a lap that was driven honestly.
   */
  tc?: boolean
  /**
   * Anti-lock braking, chosen before the lap rather than during it.
   *
   * A flag on the lap, not a channel, because unlike the TC rotary it cannot be
   * changed while driving — so one bit says everything a replay needs. It still
   * has to travel WITH the lap: ABS bleeds brake pressure, so a lap driven with
   * it replayed without would brake differently, take a different line, and be
   * rejected by `verifyLapRecording` despite being driven honestly.
   */
  abs?: boolean
}

export interface SectorSplits {
  /** Split times for each sector of the current or last lap; null until set. */
  times: (number | null)[]
}

export interface CompletedLap {
  time: number
  valid: boolean
  sectors: (number | null)[]
  /** Inputs and starting state, enough to replay this lap exactly. */
  recording: LapRecording
  /** (distance round the lap, elapsed time) samples — the reference a future
   *  lap measures its delta against. See LapTrace. */
  trace: LapTrace
  /**
   * Where the car was on every tick, for drawing the ghost. See GHOST_FIELDS.
   *
   * Beside the input trace, not instead of it. Inputs are what make a time
   * checkable; positions are what make a ghost accurate forever. See the note
   * where this is recorded in `step`.
   */
  path: Float64Array
}

/**
 * Values stored per tick in a ghost path: x, y, yaw, steer, vx, wheelVr.
 *
 * The first four place the car and turn its front wheels; the last two spin the
 * rears at the right rate and show wheelspin as blur. Nothing else is needed to
 * draw a car, which is the whole point — a ghost is a picture, not a physics
 * object, and does not need a state vector it will never integrate.
 */
export const GHOST_FIELDS = 6

/**
 * The car with ABS switched on, or the car unchanged.
 *
 * A copy rather than a mutation: `CarParams` is shared between the sim, the
 * ghost and the menu preview, and `applyEasyAids` mutating in place is already
 * one place too many for that.
 */
export const withAbs = (p: CarParams, on: boolean | undefined): CarParams =>
  on && !p.absOn ? { ...p, absOn: true } : p

/**
 * A lap's progress through time: `s[i]` metres round the lap at `t[i]` seconds.
 *
 * This is what makes a TRUE delta possible. The question a delta answers is
 * "how long did the reference lap take to reach where I am now", which needs
 * the reference's time as a function of DISTANCE — not of wall-clock, and not
 * approximated from a positional gap divided by a speed. Ported from the env's
 * `_ghost_s` / `_ghost_t` pair and its `_reference_time_at` interpolation.
 */
export interface LapTrace {
  s: Float64Array
  t: Float64Array
}

/**
 * Everything needed to reproduce a lap frame for frame.
 *
 * Inputs alone are not enough: a lap begins mid-run, as the car crosses the
 * line at speed, so the state at that instant is part of the lap. With both, a
 * replay is not an approximation of the lap — it *is* the lap, which is what
 * makes ghosts exact and makes a submitted time checkable by re-running it.
 */
export interface LapRecording {
  trackId: string
  preset: string
  easy: boolean
  /** Car state at the moment the lap started. */
  start: CarState
  /**
   * Two entries per tick — steer, throttle — or THREE when `manual`, the third
   * being the gear request for that tick.
   *
   * A manual gearchange is a player input, so it has to be in here. Leave it
   * out and a manual lap replays under the automatic gearbox, takes different
   * gears, and the ghost drifts away from the lap that was actually driven.
   */
  inputs: Float64Array
  /**
   * Driven with a manual gearbox. Absent means automatic, which is what every
   * recording made before manual mode existed was, so old laps still load.
   */
  manual?: boolean
  /**
   * Driven with the traction-control rotary live, the last channel being its
   * position that tick. Absent means the preset's own fixed TC, which is what
   * every recording made before the rotary existed was.
   */
  tc?: boolean
  /** Driven with ABS. Absent means without, which every lap recorded before it
   *  was offered was. See SimOptions.abs. */
  abs?: boolean
}

/** Which slot each optional input sits in, and how many there are per tick. */
export interface ChannelLayout {
  count: number
  /** Slot of the gear request, or -1 when the lap was automatic. */
  gear: number
  /** Slot of the TC position, or -1 when the rotary was not in play. */
  tc: number
}

/**
 * Optional channels are appended in a fixed order, never inserted.
 *
 * The offsets have to be computed rather than assumed: a TC lap on the
 * automatic box also has three channels, and reading slot 2 as the gear there
 * would feed the traction-control position into the gearbox.
 */
export function channelLayout(r: { manual?: boolean; tc?: boolean }): ChannelLayout {
  let count = 2
  const gear = r.manual ? count++ : -1
  const tc = r.tc ? count++ : -1
  return { count, gear, tc }
}

/** Values per tick in a recording's input stream. */
export const channelsOf = (r: { manual?: boolean; tc?: boolean }): number =>
  channelLayout(r).count

/**
 * Did this lap have traction control switched on at any point?
 *
 * Derived from the input trace rather than stored as a flag on the recording,
 * and deliberately: the trace is the thing `verifyLapRecording` replays, so a
 * derived answer cannot disagree with the lap that was actually driven. A
 * stored boolean is a claim, and claims from a browser are not evidence.
 *
 * "Had it on" rather than "needed it": a lap driven so cleanly that TC never
 * had to intervene still had it available, and still counts.
 */
export function lapUsedTc(r: LapRecording): boolean {
  const { count, tc } = channelLayout(r)
  if (tc < 0) return false
  for (let i = tc; i < r.inputs.length; i += count) {
    if (r.inputs[i]! > 0) return true
  }
  return false
}

export interface LapVerification {
  accepted: boolean
  /** Present only for an accepted lap; always derived from the input count. */
  time?: number
  sectors?: (number | null)[]
  /** Server-derived ghost data; client-supplied paths are never trusted. */
  trace?: LapTrace
  path?: Float64Array
  reason?: string
}

export interface StepResult {
  /** The car crossed the start/finish line going forwards this tick. */
  crossedFinish: boolean
  /** A timed lap finished this tick. */
  lapCompleted: CompletedLap | null
  /** A sector boundary was crossed this tick (0-based index of the one closed). */
  sectorClosed: number | null
  offTrack: boolean
  /** False once any wheel has been off the road during the current lap. */
  lapValid: boolean
  /** True once the first line crossing has armed the clock. */
  timingArmed: boolean
}

export class TimeAttackSim {
  readonly track: Track
  readonly car: Car
  readonly trackId: string
  readonly preset: string
  readonly easy: boolean

  private readonly offTrackGrip: number
  private readonly barriers: Barriers | null
  /** The TC rotary is live, so its position is an input and gets recorded. */
  private readonly tc: boolean
  /** ABS was switched on for this session, and travels with the lap. */
  private readonly abs: boolean

  /** Peak wall impulse this tick (N·s), 0 when nothing was touched. */
  wallImpact = 0

  /** Ticks since the sim was reset. */
  steps = 0
  /** Ticks at which the current lap started. */
  private lapStartStep = 0
  private prevS = 0
  private lapProgress = 0

  timingArmed = false
  lapValid = true
  offTrack = false

  lastLapTime: number | null = null
  lastLapValid = true
  bestLapTime: number | null = null
  /** Timed laps finished this session, and how many of them stood. */
  lapsCompleted = 0
  validLaps = 0
  /**
   * Fastest each sector has EVER been done (valid laps only) — the purple
   * reference, distinct from ``bestSectors`` which are the splits of the best
   * full lap (the green/yellow reference). Ported from the env's
   * ``_fastest_sectors`` / ``_best_sectors`` pair.
   */
  fastestSectors: (number | null)[] = [null, null, null]
  /** Current lap: split minus the best lap's matching split, as each lands. */
  sectorDeltas: (number | null)[] = [null, null, null]
  /** Current lap: sector beat the fastest-ever (and the lap was still valid). */
  sectorBestFlags: boolean[] = [false, false, false]
  /** The finished lap's display set, for the HUD's hold. */
  lastSectorDeltas: (number | null)[] = [null, null, null]
  lastSectorBestFlags: boolean[] = [false, false, false]

  /**
   * The lap this one is being measured against. Set from the stored best;
   * null means there is nothing to compare to and `liveDelta` stays null.
   */
  referenceTrace: LapTrace | null = null
  /**
   * Seconds up or down on the reference AT THE SAME POINT ON THE ROAD.
   * Positive is slower. Null until the clock is armed and a reference exists.
   */
  liveDelta: number | null = null
  /** Splits of the lap in progress, of the last lap, and of the best lap. */
  currentSectors: (number | null)[] = [null, null, null]
  lastSectors: (number | null)[] = [null, null, null]
  bestSectors: (number | null)[] = [null, null, null]

  private sector = 0
  private sectorStartTime = 0

  private recordingStart: CarState = initialState()
  private recordingInputs: number[] = []
  /** Ghost path for the lap in progress — see GHOST_FIELDS values per tick. */
  private recordingPath: number[] = []
  /** This lap's own (distance, time) samples, recorded as it is driven. */
  private traceS: number[] = []
  private traceT: number[] = []

  constructor(
    track: Track,
    params: CarParams,
    trackId: string,
    preset: string,
    easy = false,
    opts: SimOptions = {},
  ) {
    this.track = track
    this.abs = opts.abs ?? false
    this.car = new Car(withAbs(params, this.abs))
    this.trackId = trackId
    this.preset = preset
    this.easy = easy
    // Easy mode gives full grip on the grass. This lives on the sim rather than
    // the car because it is a property of the surface, not the vehicle — the
    // same split the Python makes.
    const easyGrass = opts.easyGrass ?? easy
    this.offTrackGrip = easyGrass ? 1.0 : OFF_TRACK_GRIP
    this.barriers = (opts.walls ?? true) ? new Barriers(track) : null
    this.car.manual = opts.manual ?? false
    this.tc = opts.tc ?? false
    this.reset()
  }

  /** Put the car back on the grid and throw away the lap in progress. */
  reset(): void {
    const pose = gridPose(this.track, STAGE_SLOT)
    this.car.reset(pose.x, pose.y, pose.yaw)

    this.steps = 0
    this.lapStartStep = 0
    this.prevS = this.track.project(pose.x, pose.y).s
    this.lapProgress = 0
    this.timingArmed = false
    this.lapValid = true
    this.offTrack = false
    this.sector = 0
    this.sectorStartTime = 0
    this.currentSectors = [null, null, null]
    this.recordingInputs = []
    this.recordingPath = []
  }

  /** Initialise an already-armed lap for the server verification path. */
  beginVerification(recording: LapRecording): void {
    this.car.s = { ...recording.start }
    this.steps = 0
    this.lapStartStep = 0
    this.prevS = this.track.project(recording.start.x, recording.start.y).s
    this.lapProgress = 0
    this.timingArmed = true
    this.lapValid = true
    this.offTrack = false
    this.beginLapRecording()
    this.beginSectors()
  }

  /** Seconds elapsed on the lap in progress; 0 until the clock is armed. */
  get currentLapTime(): number {
    return this.timingArmed ? (this.steps - this.lapStartStep) * DT : 0
  }

  /** Metres round the lap, clamped to it. Zero until the clock is armed. */
  get lapDistance(): number {
    if (!this.timingArmed) return 0
    const p = this.lapProgress
    return p < 0 ? 0 : p > this.track.length ? this.track.length : p
  }

  /** How far round the lap the car is, 0..1. Zero until the clock is armed. */
  get lapFraction(): number {
    if (!this.timingArmed) return 0
    const f = this.lapProgress / this.track.length
    return f < 0 ? 0 : f > 1 ? 1 : f
  }

  get speed(): number {
    return speedOf(this.car.s)
  }

  /** Signed distance from the centreline; positive is left of travel. */
  get lateral(): number {
    return this.track.project(this.car.s.x, this.car.s.y).lateral
  }

  step(steer: number, throttle: number, shiftRequest = 0, tcLevel = TC_LEVEL_DEFAULT): StepResult {
    const s = this.car.s
    // Null unless the rotary is in play, which is what leaves every preset's
    // own traction control exactly as it was.
    this.car.tcLevel = this.tc ? Math.round(clamp(tcLevel, 0, TC_LEVEL_MAX)) : null

    // Surface under the car *before* it moves, exactly as the Python does: the
    // grip you get this tick is the grip where you already are.
    const surface = this.track.project(s.x, s.y)
    const onGrass = Math.abs(surface.lateral) > surface.half + OFF_TRACK_MARGIN
    this.car.step(
      steer,
      throttle,
      DT,
      SUBSTEPS,
      onGrass ? this.offTrackGrip : 1.0,
      onGrass ? OFF_TRACK_ROLLING : 1.0,
      shiftRequest,
    )

    if (this.timingArmed) {
      this.recordingInputs.push(steer, throttle)
      if (this.car.manual) this.recordingInputs.push(Math.sign(shiftRequest))
      if (this.tc) this.recordingInputs.push(this.car.tcLevel!)
    }
    this.steps++

    // Solid barriers, resolved before anything is measured — so progress, lap
    // validity and the surface all see where the car actually ended up rather
    // than where it would have been allowed to go. Hence the re-projection when
    // a wall really did move it.
    this.wallImpact = 0
    let proj = this.track.project(s.x, s.y)
    if (this.barriers !== null && this.barriers.mayTouch(proj.lateral, this.car.p)) {
      this.wallImpact = this.barriers.resolve(s, this.car.p)
      // Unconditionally, not just when the impulse was non-zero: a car already
      // sliding away from the wall takes the positional correction and then
      // returns 0, so the impulse is not a reliable "did anything move".
      proj = this.track.project(s.x, s.y)
    }

    // The ghost's path, recorded AFTER the walls have had their say, so it is
    // where the car actually ended the tick rather than where it was heading.
    //
    // Kept beside the input trace rather than instead of it, because the two
    // answer different questions. Inputs are what makes a time checkable — the
    // server re-drives them and derives the time itself, so a faked time needs
    // a trace that genuinely drives that fast. Positions cannot do that; they
    // can be typed by hand. But positions are what you WATCH, and they are the
    // same lap forever, where a trace of inputs only reproduces its lap while
    // the car it was driven on still exists. Change the gearbox and the same
    // inputs describe a different lap, which is how ghosts started driving into
    // barriers. Verify from inputs, draw from positions.
    if (this.timingArmed) {
      this.recordingPath.push(s.x, s.y, s.yaw, s.steer, s.vx, s.wheelVr)
    }

    // Progress along the lap, handling the start/finish wrap. A big negative
    // jump in arc length means the line was crossed forwards; a big positive one
    // means it was crossed backwards.
    let ds = proj.s - this.prevS
    let crossedFinish = false
    if (ds < -this.track.length * 0.5) {
      ds += this.track.length
      crossedFinish = true
    } else if (ds > this.track.length * 0.5) {
      ds -= this.track.length
    }
    this.prevS = proj.s
    this.lapProgress += ds

    this.offTrack = Math.abs(proj.lateral) > proj.half + OFF_TRACK_MARGIN
    if (this.offTrack && this.lapValid) {
      this.lapValid = false // any wheel off the road voids the lap
    }

    // Record this lap's progress trace, exactly as the env does: only while
    // the lap is still valid, and only forward, so the series stays monotonic
    // in distance and can be interpolated.
    if (this.timingArmed && this.lapValid && this.lapProgress >= 0) {
      const d = this.lapDistance
      if (this.traceS.length === 0 || d > this.traceS[this.traceS.length - 1]!) {
        this.traceS.push(d)
        this.traceT.push(this.currentLapTime)
      }
    }

    // The live delta: my elapsed time now, minus the reference lap's elapsed
    // time at this same distance round the lap.
    this.liveDelta =
      this.timingArmed && this.referenceTrace
        ? this.currentLapTime - traceTimeAt(this.referenceTrace, this.lapDistance)
        : null

    let lapCompleted: CompletedLap | null = null
    let sectorClosed: number | null = null

    if (crossedFinish && !this.timingArmed) {
      // First crossing out of the staging spot: this is where the clock and
      // sector 1 actually start. The launch run before it does not count.
      this.timingArmed = true
      this.lapStartStep = this.steps
      this.lapProgress = 0
      this.lapValid = !this.offTrack
      this.beginLapRecording()
      this.beginSectors()
    } else if (crossedFinish && this.lapProgress > this.track.length * 0.5) {
      // A full lap: close the final sector, bank it, and start the next.
      sectorClosed = this.closeSector(this.currentLapTime)
      const time = this.currentLapTime
      const valid = this.lapValid
      const sectors = this.currentSectors.slice()

      // Close the trace on the line, so a delta at the very end of a lap
      // interpolates against a real endpoint rather than extrapolating.
      this.traceS.push(this.track.length)
      this.traceT.push(time)

      lapCompleted = {
        time,
        valid,
        sectors,
        trace: { s: Float64Array.from(this.traceS), t: Float64Array.from(this.traceT) },
        path: Float64Array.from(this.recordingPath),
        recording: {
          trackId: this.trackId,
          preset: this.preset,
          easy: this.easy,
          start: { ...this.recordingStart },
          inputs: Float64Array.from(this.recordingInputs),
          ...(this.car.manual ? { manual: true } : {}),
          ...(this.tc ? { tc: true } : {}),
          ...(this.abs ? { abs: true } : {}),
        },
      }

      this.lastLapTime = time
      this.lastLapValid = valid
      this.lastSectors = sectors
      this.lastSectorDeltas = this.sectorDeltas.slice()
      this.lastSectorBestFlags = this.sectorBestFlags.slice()
      this.lapsCompleted++
      if (valid) this.validLaps++
      if (valid && (this.bestLapTime === null || time < this.bestLapTime)) {
        this.bestLapTime = time
        this.bestSectors = sectors
      }

      this.lapStartStep = this.steps
      this.lapProgress = 0
      this.lapValid = !this.offTrack
      this.beginLapRecording()
      this.beginSectors()
    } else if (this.timingArmed) {
      // Mid-lap sector boundary.
      const boundary = (this.track.length / SECTORS) * (this.sector + 1)
      if (this.sector < SECTORS - 1 && this.lapProgress >= boundary) {
        sectorClosed = this.closeSector(this.currentLapTime)
      }
    }

    return {
      crossedFinish,
      lapCompleted,
      sectorClosed,
      offTrack: this.offTrack,
      lapValid: this.lapValid,
      timingArmed: this.timingArmed,
    }
  }

  private beginLapRecording(): void {
    this.recordingStart = { ...this.car.s }
    this.recordingInputs = []
    // The path opens with the starting pose, so it lines up with `LapReplay`:
    // both begin at the state the lap started in and advance one tick at a
    // time. Without it the two are interchangeable but a tick apart, and a
    // ghost silently ran most of a metre ahead of the lap it was drawing.
    this.recordingPath = [
      this.car.s.x, this.car.s.y, this.car.s.yaw,
      this.car.s.steer, this.car.s.vx, this.car.s.wheelVr,
    ]
    this.traceS = []
    this.traceT = []
  }

  private beginSectors(): void {
    this.sector = 0
    this.sectorStartTime = 0
    this.currentSectors = [null, null, null]
    this.sectorDeltas = [null, null, null]
    this.sectorBestFlags = [false, false, false]
  }

  /** Close the current sector at ``now`` and advance. Returns its index. */
  private closeSector(now: number): number {
    const closed = this.sector
    const split = now - this.sectorStartTime
    this.currentSectors[closed] = split
    // Delta against the best full lap's matching split; purple against the
    // fastest that sector has ever gone — only a valid lap may set it.
    const ref = this.bestSectors[closed] ?? null
    this.sectorDeltas[closed] = ref !== null ? split - ref : null
    const fastest = this.fastestSectors[closed] ?? null
    if (this.lapValid && (fastest === null || split < fastest)) {
      this.fastestSectors[closed] = split
      this.sectorBestFlags[closed] = true
    }
    this.sectorStartTime = now
    this.sector = Math.min(this.sector + 1, SECTORS - 1)
    return closed
  }
}

/**
 * Server-side verification for a submitted leaderboard replay.
 *
 * Determinism is necessary but not sufficient: merely counting inputs would
 * accept an arbitrary short trace. This starts a live timing session at the
 * submitted line state, runs the authoritative surface/wall/lap rules, and
 * accepts only a clean finish reached on the final submitted tick.
 */
export function verifyLapRecording(
  track: Track,
  params: CarParams,
  recording: LapRecording,
): LapVerification {
  if (recording.trackId !== track.id) return rejected('Track metadata does not match.')
  const layout = channelLayout(recording)
  const channels = layout.count
  if (recording.inputs.length % channels !== 0) {
    return rejected('Input trace is incomplete.')
  }
  const ticks = recording.inputs.length / channels
  if (ticks < Math.ceil(10 / DT) || ticks > Math.ceil(20 * 60 / DT)) {
    return rejected('Lap duration is outside the accepted range.')
  }
  for (const value of Object.values(recording.start)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return rejected('Start state is not finite.')
  }
  // Per channel, not one blanket range. The channels no longer share a scale —
  // TC is a rotary position, not a pedal — and checking each one for what it
  // actually is also catches a gear channel of 0.5, which the old blanket
  // [-1, 1] test waved through.
  for (let i = 0; i < recording.inputs.length; i++) {
    const value = recording.inputs[i]!
    if (!Number.isFinite(value)) return rejected('Input is not finite.')
    const slot = i % channels
    if (slot === layout.tc) {
      if (!Number.isInteger(value) || value < 0 || value > TC_LEVEL_MAX) {
        return rejected('Traction control position is not a position on the wheel.')
      }
    } else if (slot === layout.gear) {
      if (value !== -1 && value !== 0 && value !== 1) return rejected('Gear request is not a paddle.')
    } else if (value < -1 || value > 1) {
      return rejected('Input is outside [-1, 1].')
    }
  }

  const start = track.project(recording.start.x, recording.start.y)
  const lineDistance = Math.min(start.s, track.length - start.s)
  const headingError = Math.abs(wrapAngle(recording.start.yaw - start.heading))
  if (lineDistance > 5 || Math.abs(start.lateral) > start.half + OFF_TRACK_MARGIN) {
    return rejected('Lap does not start on the timing line.')
  }
  if (headingError > Math.PI / 2 || recording.start.vx <= 0) {
    return rejected('Lap starts in the wrong direction.')
  }

  const sim = new TimeAttackSim(
    track, params, recording.trackId, recording.preset, recording.easy,
    {
      manual: recording.manual ?? false,
      tc: recording.tc ?? false,
      abs: recording.abs ?? false,
    },
  )
  sim.beginVerification(recording)

  for (let tick = 0; tick < ticks; tick++) {
    const base = tick * channels
    const result = sim.step(
      recording.inputs[base]!,
      recording.inputs[base + 1]!,
      layout.gear < 0 ? 0 : recording.inputs[base + layout.gear]!,
      layout.tc < 0 ? TC_LEVEL_DEFAULT : recording.inputs[base + layout.tc]!,
    )
    if (result.lapCompleted) {
      if (tick !== ticks - 1) return rejected('Input trace continues after the finish.')
      if (!result.lapCompleted.valid) return rejected('Lap left the circuit.')
      return {
        accepted: true,
        time: result.lapCompleted.time,
        sectors: result.lapCompleted.sectors,
        trace: result.lapCompleted.trace,
        path: result.lapCompleted.path,
      }
    }
  }
  return rejected('Input trace does not complete a lap.')
}

const rejected = (reason: string): LapVerification => ({ accepted: false, reason })

/**
 * The reference lap's elapsed time at a given distance round the lap.
 *
 * Linear interpolation over a series that is monotonic in distance —
 * `np.interp` with its clamping at both ends, which is what the env uses.
 */
export function traceTimeAt(trace: LapTrace, distance: number): number {
  const { s, t } = trace
  const n = s.length
  if (n === 0) return 0
  if (distance <= s[0]!) return t[0]!
  if (distance >= s[n - 1]!) return t[n - 1]!
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (s[mid]! <= distance) lo = mid
    else hi = mid
  }
  const s0 = s[lo]!
  const s1 = s[lo + 1]!
  if (s1 === s0) return t[lo]!
  return t[lo]! + ((t[lo + 1]! - t[lo]!) * (distance - s0)) / (s1 - s0)
}

/**
 * Replay a recorded lap.
 *
 * Because the recording carries the car's exact state at the line as well as
 * every input after it, this reproduces the lap rather than approximating it —
 * the ghost you chase is the lap that was actually driven. The same routine is
 * what a leaderboard would run to check a submitted time: derive the lap time
 * from the inputs instead of trusting a number.
 */
export class LapReplay {
  readonly car: Car
  private readonly track: Track
  private readonly start: CarState
  private readonly inputs: Float64Array
  private readonly offTrackGrip: number
  private readonly barriers: Barriers | null
  private readonly channels: number
  private readonly layout: ChannelLayout
  private index = 0

  constructor(
    track: Track, params: CarParams, recording: LapRecording, opts: SimOptions = {},
  ) {
    this.track = track
    // ABS travels with the lap exactly as the gearbox and the rotary do.
    this.car = new Car(withAbs(params, recording.abs))
    this.start = { ...recording.start }
    this.car.s = { ...this.start }
    this.inputs = recording.inputs
    this.offTrackGrip = recording.easy ? 1.0 : OFF_TRACK_GRIP
    // The gearbox travels with the lap. A manual lap replayed under the
    // automatic box would take different gears and drift off the line.
    this.car.manual = recording.manual ?? false
    // The rotary travels with the lap for the same reason the gearbox does: a
    // lap driven with TC off replayed under TC on takes a different line.
    this.layout = channelLayout(recording)
    this.channels = this.layout.count
    // Walls default on here for the same reason the surface lookup is shared:
    // a replay has to run the world the lap was driven in. Resolve them in the
    // live sim but not the replay and a lap that so much as brushed a barrier
    // would take a different line on playback, and the ghost would drift.
    this.barriers = (opts.walls ?? true) ? new Barriers(track) : null
  }

  get finished(): boolean {
    return this.index * this.channels >= this.inputs.length
  }

  /** Duration of the recorded lap in seconds. */
  get duration(): number {
    return (this.inputs.length / this.channels) * DT
  }

  /** Advance one tick. Holds position once the recording runs out. */
  step(): void {
    if (this.finished) return
    const base = this.index * this.channels
    const steer = this.inputs[base]!
    const throttle = this.inputs[base + 1]!
    const { gear, tc } = this.layout
    const shiftRequest = gear < 0 ? 0 : this.inputs[base + gear]!
    this.car.tcLevel = tc < 0 ? null : this.inputs[base + tc]!
    // The surface lookup has to match the one the live sim ran, or a lap that
    // put a wheel on the grass would replay with more grip than it was driven
    // with and drift away from the line it actually took.
    const s = this.car.s
    const surface = this.track.project(s.x, s.y)
    const onGrass = Math.abs(surface.lateral) > surface.half + OFF_TRACK_MARGIN
    this.car.step(
      steer,
      throttle,
      DT,
      SUBSTEPS,
      onGrass ? this.offTrackGrip : 1.0,
      onGrass ? OFF_TRACK_ROLLING : 1.0,
      shiftRequest,
    )
    if (this.barriers !== null) {
      const after = this.track.project(s.x, s.y)
      if (this.barriers.mayTouch(after.lateral, this.car.p)) {
        this.barriers.resolve(s, this.car.p)
      }
    }
    this.index++
  }

  reset(): void {
    this.car.s = { ...this.start }
    this.index = 0
  }
}
