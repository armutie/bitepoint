/**
 * The in-race overlay: instrumentation, not a scoreboard.
 *
 * This was built the other way round first — a circular tacho, a 42px italic
 * speed, glowing pedal bars, a skewed and pulsing LAP INVALID, and status chips
 * parked permanently in the corner. Read at a glance it looked like an arcade
 * dashboard, which is what it was designed as. It now follows the pygame HUD in
 * `racing/render.py` instead: flat cards, tabular label-left/value-right rows,
 * monospace everywhere, desaturated colours off that renderer's palette, and no
 * glow, skew or pulse anywhere.
 *
 * The layout follows it too. pygame puts every telemetry item in ONE
 * bottom-centre cluster; the web version had scattered the same information
 * into three separate corners, which is most of why there was nowhere for the
 * eye to rest. Pedals, speed, gear, shift lights and steering are now one
 * instrument binnacle.
 *
 * DOM rather than drawn into the canvas, because text laid out by the browser
 * stays crisp at every pixel ratio and costs no frame time to lay out again when
 * only the numbers change.
 */
import { formatDelta, formatTime } from '../storage/records'
import { ASSISTS_ADJUSTABLE } from '../features'
import { buildHudMap, type HudMap } from './hudMap'
import type { Track } from '../core/track'
import type { TrackLimits } from '../core/trackLimits'
import { Proximity, type ProximityMarker } from './proximity'

/** Shift lights, as an LED strip: green, amber, then red at the limit. */
const SHIFT_LIGHTS = 12
/** Fraction of the redline at which the first light comes on. */
const LIGHTS_FROM = 0.6

/**
 * The race, when there is one. Absent in a time trial.
 *
 * Optional rather than a second HUD type: everything else on screen — speed,
 * gear, the tyre lights, the map — is the same job in both sessions, and a
 * parallel HUD would be that whole file again so that one card could differ.
 */
export interface HudRaceRow {
  position: number
  isPlayer: boolean
  /**
   * A stable name for this car.
   *
   * Stable is the whole point. It was derived from the position, so a car
   * called "Car 3" became "Car 2" the moment it overtook — while its colour
   * chip, which comes from the car itself, stayed put. Two identifiers for one
   * car disagreeing is worse than either alone.
   */
  name: string
  /** Seconds behind the car in front. Null when it cannot be known yet. */
  interval: number | null
  /** Metres behind the car in front — the fallback while the interval is null. */
  intervalMetres: number
  laps: number
  finished: boolean
  /** Livery colour, matching the car on track. */
  colour: string
}

export interface HudRaceState {
  position: number
  size: number
  /** Lap the player is ON, 1-based, capped at the race distance. */
  lap: number
  laps: number
  /** Seconds to the car ahead and behind, null when there is nobody or no history. */
  gapAhead: number | null
  gapBehind: number | null
  /** Seconds left on the lights, 0 once they are out. */
  countdown: number
  lights: number
  starting: boolean
  launchHint: string
  finished: boolean
  /** Last lap against the player's best of THIS RACE, or null on the first lap. */
  lastVsBest: number | null
  /**
   * Which of the player's completed splits are the fastest ANYONE has gone
   * this race. Overrides the sim's own purple, which only knows about itself.
   *
   * Two sets, because the pills show two things: the lap in progress, and — for
   * a few seconds after the line — the lap just finished. The live array is
   * wiped at the line, so reusing it during the hold would drop every purple
   * exactly when you are looking at them.
   */
  purpleSectors: readonly boolean[]
  purpleLastSectors: readonly boolean[]
  /** The whole field, leader first. */
  standings: readonly HudRaceRow[]
  /** Where the other cars are, for the map. */
  mapDots: readonly { x: number; y: number; leader?: boolean }[]
}

export interface HudState {
  /** Present only in a race. */
  race?: HudRaceState
  trackLimits?: TrackLimits
  proximity?: readonly ProximityMarker[]
  qualifying?: boolean
  qualifyingIntro?: { active: boolean; lights: number; hint: string }
  speedKmh: number
  gear: number
  rpm: number
  redlineRpm: number
  currentLap: number
  lastLap: number | null
  bestLap: number | null
  lapValid: boolean
  timingArmed: boolean
  ghostDelta: number | null
  sectors: (number | null)[]
  sectorDeltas: (number | null)[]
  sectorBestFlags: boolean[]
  lastSectors: (number | null)[]
  lastSectorDeltas: (number | null)[]
  lastSectorBestFlags: boolean[]
  lastLapValid: boolean
  bestSectors: (number | null)[]
  throttle: number
  brake: number
  /** Commanded steering, -1 (full right) to +1 (full left). */
  steer: number
  cameraLabel: string
  inputLabel: string
  viewportLabel: string
  easy: boolean
  ghost: boolean
  lapCount: number
  validLaps: number
  /** How far round the lap, 0..1. */
  lapFraction: number
  /** Where the car is, for the map. World coordinates. */
  carX: number
  carY: number
  /** 0-based sector the car is in — tints the map dot to match the pills. */
  sector: number
  /** Ghost position, or null when there is no ghost running. */
  ghostX: number | null
  ghostY: number | null
  /** Traction control position, 0 = off. */
  tcLevel: number
  /** Whether the brake-stability aid is fitted to this car. */
  abs: boolean
  /** How hard ABS is intervening right now, 0..1, already smoothed. */
  absBite: number
  /**
   * How hard TC is intervening right now, 0..1, already smoothed.
   *
   * Smoothed by the game layer rather than here: the raw per-tick figure from
   * the car strobes, because TC bites and releases many times a second on a
   * bumpy exit and the eye reads a strobing lamp as a fault rather than as work
   * being done.
   */
  tcBite: number
}

/**
 * The colour a completed split is shown in.
 *
 * PURPLE means different things in the two sessions, and that is the point. In
 * a time trial it is your own fastest ever through that sector. In a race it is
 * the fastest ANYBODY has gone through it today — the caller has already
 * resolved which, because only it can see the other cars.
 *
 * The other difference is what a missing delta means. Alone, a split with
 * nothing to compare against is neutral: there is genuinely no information. In
 * a race there is, and it is good news — it is your first time through, so it
 * is the best you have gone today by definition, and painting it grey (or
 * worse, yellow against a personal best set on an empty circuit) tells you off
 * for something you have not done.
 */
export function sectorPillState(
  delta: number | null,
  isPurple: boolean,
  racing: boolean,
): 'purple' | 'good' | 'warn' | 'neutral' {
  if (isPurple) return 'purple'
  if (delta === null) return racing ? 'good' : 'neutral'
  return delta <= 0 ? 'good' : 'warn'
}

/** What a highlighted lap banner is claiming. */
export type LapFlash = 'pb' | 'fastest'

/** Seconds of lights before the start, matching `race.ts`. */

/** A gap in metres, or a dash when there is nobody there. */
function gapText(metres: number | null): string {
  if (metres === null) return '—'
  if (metres < 5) return 'CONTACT'
  return metres < 1000 ? `${metres.toFixed(0)} m` : `${(metres / 1000).toFixed(1)} km`
}

export class Hud {
  readonly root: HTMLDivElement
  private readonly proximity = new Proximity()
  private readonly limitsNotice: HTMLElement
  private readonly penaltyRow: HTMLElement
  private readonly penaltyValue: HTMLElement
  private activeLimits: TrackLimits | undefined
  private shownOffence = 0
  private limitsTimer: ReturnType<typeof setTimeout> | null = null

  private readonly speed: HTMLElement
  private readonly gear: HTMLElement
  private readonly map: HTMLElement
  private hudMap: HudMap | null = null
  private mapTrackId = ''
  private readonly mfdValue: HTMLElement
  private readonly absBadge: HTMLElement
  private readonly tcLamp: HTMLElement
  private readonly tcLampText: HTMLElement
  private readonly lights: HTMLElement[]
  private readonly chips: HTMLElement
  private readonly sub: HTMLElement
  private readonly current: HTMLElement
  private readonly last: HTMLElement
  private readonly best: HTMLElement
  private readonly invalid: HTMLElement
  private readonly invalidAction: HTMLElement
  private readonly delta: HTMLElement
  private readonly sectors: HTMLElement[]
  private readonly sectorTimes: HTMLElement[] = []
  private readonly sectorDeltaEls: HTMLElement[] = []
  private readonly throttleBar: HTMLElement
  private readonly brakeBar: HTMLElement
  private readonly camera: HTMLElement
  private readonly inputChip: HTMLElement
  private readonly viewportChip: HTMLElement
  private readonly ghostChip: HTMLElement
  private readonly tcChip: HTMLElement
  private readonly absChip: HTMLElement
  private readonly easyBadge: HTMLElement
  private readonly steerRail: HTMLElement
  private readonly steerNeedle: HTMLElement
  private readonly lapBanner: HTMLElement
  private readonly lapBannerTime: HTMLElement
  private readonly lapBannerLabel: HTMLElement
  private sectorHint!: HTMLElement
  private readonly raceLights: HTMLElement
  private readonly launchHint: HTMLElement
  private readonly raceLap: HTMLElement
  private readonly raceLapNum: HTMLElement
  private readonly lastDelta: HTMLElement
  /** The race card's own Last value — see where it is built. */
  private readonly raceLast: HTMLElement
  /** Rows of the timing card that only a race uses, and only a time trial uses. */
  private readonly raceRows: HTMLElement
  private readonly timeRows: HTMLElement
  private readonly board: HTMLElement
  private readonly boardRows: HTMLElement
  private bannerTimer: ReturnType<typeof setTimeout> | null = null
  private invalidTimer: ReturnType<typeof setTimeout> | null = null
  private chipsTimer: ReturnType<typeof setTimeout> | null = null
  private lapWasInvalid = false
  /** Last chip contents, so they can show themselves only when they change. */
  private chipSig = ''
  /** While set (wall-clock ms), the pills hold the finished lap's numbers —
   *  the env holds them for 4 s so you can read what you just did. */
  private sectorHoldUntil = 0

  constructor() {
    this.root = el('div', 'hud')

    // Timing card, top left — pygame's exact table: a lap subline, a divider,
    // then one row per time with the label left and the value right. Uniform
    // rows are the point; a 42px hero number and two 15px footnotes read as a
    // title with small print, which is not what a timing screen is.
    const card = el('div', 'hud-card')
    this.sub = el('div', 'hud-card-sub')
    this.current = el('span', 'hud-value hud-value-lead')
    this.delta = el('span', 'hud-value')
    this.last = el('span', 'hud-value')
    this.best = el('span', 'hud-value hud-best')
    const rows = el('div', 'hud-rows')
    rows.append(
      labelled('This', this.current),
      labelled('Delta', this.delta),
      labelled('Last', this.last),
      labelled('Best', this.best),
    )
    this.timeRows = rows
    card.append(this.sub, rows)

    // Sector pills, top centre — the pygame state machine, ported whole:
    // a completed split shows its time with a signed delta beneath (vs the
    // matching split of your best lap); the live sector COUNTS UP; pending
    // pills preview your last lap dimmed. Fill colour is the classic timing
    // language: purple = fastest ever, green = up on your best, yellow = down.
    const sectorWrap = el('div', 'hud-sectors-wrap')
    const sectorRow = el('div', 'hud-sectors')
    this.sectors = [0, 1, 2].map((i) => {
      const chip = el('div', 'hud-sector')
      chip.dataset['n'] = String(i + 1)
      const label = el('span', 'hud-sector-label')
      label.textContent = `S${i + 1}`
      const time = el('span', 'hud-sector-time')
      const delta = el('span', 'hud-sector-delta')
      chip.append(label, time, delta)
      sectorRow.append(chip)
      // Held rather than re-found: `setPill` runs for all three pills every
      // frame, and querying the subtree each time is a tree walk for a node
      // that has been in hand since construction.
      this.sectorTimes.push(time)
      this.sectorDeltaEls.push(delta)
      return chip
    })
    this.sectorHint = el('div', 'hud-sector-hint')
    // Three words, not a sentence: the dashed clock above already says the lap
    // has not started, so this only has to say what starts it.
    this.sectorHint.textContent = 'cross the line'
    sectorWrap.append(sectorRow, this.sectorHint)

    // The overhead map, top right, as pygame has it. Empty until a circuit is
    // known — `setTrack` fills it, because the map is per-circuit and the HUD
    // outlives any one session.
    this.map = el('div', 'hud-map-wrap')

    this.invalid = el('div', 'hud-invalid')
    const invalidLabel = el('span', 'hud-invalid-label')
    invalidLabel.textContent = 'Lap invalid'
    this.invalidAction = el('span', 'hud-invalid-action')
    this.invalidAction.textContent = 'Press R to restart'
    this.invalid.append(invalidLabel, this.invalidAction)

    // Transient lap result — replaces the modal that used to stop the flow.
    // The next lap is already running while this fades.
    this.lapBanner = el('div', 'lap-banner')
    this.lapBannerLabel = el('div', 'lap-banner-label')
    this.lapBannerTime = el('div', 'lap-banner-time')
    this.lapBanner.append(this.lapBannerLabel, this.lapBannerTime)

    // One instrument binnacle, bottom centre, exactly as pygame groups it:
    // shift lights over pedals, speed and gear, with the steering trace below.
    // The circular tacho this replaces was the single most arcade-looking thing
    // on screen; a flat LED strip says the same about revs and is what you
    // actually see in a car with a wheel worth having.
    const tele = el('div', 'hud-tele')

    const lights = el('div', 'hud-lights')
    this.lights = Array.from({ length: SHIFT_LIGHTS }, () => {
      const led = el('span', 'hud-led')
      lights.append(led)
      return led
    })

    const main = el('div', 'hud-tele-main')
    const pedals = el('div', 'hud-pedals')
    this.brakeBar = el('div', 'hud-bar-fill hud-brake')
    this.throttleBar = el('div', 'hud-bar-fill hud-throttle')
    // "T" and "B", not "Gas" and "Brake": the bars never move, never swap
    // colour and never change order, so a word under each is a word you read
    // once and then never again.
    pedals.append(bar(this.brakeBar, 'B'), bar(this.throttleBar, 'T'))

    const readout = el('div', 'hud-readout')
    this.speed = el('span', 'hud-speed')
    const unit = el('span', 'hud-unit')
    unit.textContent = 'km/h'
    readout.append(this.speed, unit)
    this.gear = el('div', 'hud-gear')

    // ABS badge, as `racing/render.py` has it: a tiny word, lit while the aid
    // is working and dim while it is merely armed.
    //
    // Stacked above the gear rather than floated into the corner, where it
    // collided with the shift lights. It costs no height: the row is as tall as
    // the pedal column (~78px) and the gear is only 52, so the badge, its gap
    // and the gear still come to ~70. A car with no ABS hides the badge and the
    // gear re-centres, which is the instrument exactly as it was.
    this.absBadge = el('div', 'hud-abs')
    this.absBadge.textContent = 'ABS'
    const gearStack = el('div', 'hud-gear-stack')
    gearStack.append(this.absBadge, this.gear)

    // The traction-control panel: its position, and a lamp for when it bites.
    //
    // Built always, shown only while the aids are something the driver can
    // change. An indicator for a setting nobody can set is a number that never
    // moves, which is worse than no panel — the eye learns to skip it, and it
    // takes room from the instruments that do move.
    //
    // Built rather than skipped so it stays live code: `update` keeps writing
    // to it every frame, so the thing that comes back when ASSISTS_ADJUSTABLE
    // flips is code that has been running all along rather than code that has
    // been sitting unexecuted since the day it was switched off.
    const mfd = el('div', 'hud-mfd')
    const mfdLabel = el('div', 'hud-mfd-label')
    mfdLabel.textContent = 'TC'
    this.mfdValue = el('div', 'hud-mfd-value')
    this.tcLamp = el('div', 'hud-tc')
    this.tcLampText = el('span', 'hud-tc-text')
    const tcDot = el('span', 'hud-tc-dot')
    this.tcLamp.append(tcDot, this.tcLampText)
    mfd.append(mfdLabel, this.mfdValue, this.tcLamp)

    main.append(pedals, readout, gearStack)
    if (ASSISTS_ADJUSTABLE) main.append(mfd)

    // Steering readout. This is the wheel, not a region you must keep the
    // cursor inside — the cursor steers anywhere on screen.
    //
    // The needle rides a full-width rail moved with `transform` rather than
    // being positioned with `left`: a transform stays on the compositor, where
    // a `left` write invalidates layout — and this moves every frame. The
    // rail's own width is the track's, so a percentage translate of the rail
    // is a fraction of the track, exactly what `left: N%` meant.
    const steerTrack = el('div', 'hud-steer-track')
    const steerCentre = el('div', 'hud-steer-centre')
    this.steerRail = el('div', 'hud-steer-rail')
    this.steerNeedle = el('div', 'hud-steer-needle')
    this.steerRail.append(this.steerNeedle)
    steerTrack.append(steerCentre, this.steerRail)

    tele.append(lights, main, steerTrack)

    // Status chips: what the last keypress did, then out of the way. These are
    // settings state, not driving information — permanently on screen they were
    // four words you had already read.
    this.camera = el('div', 'hud-chip')
    this.inputChip = el('div', 'hud-chip')
    this.viewportChip = el('div', 'hud-chip')
    this.ghostChip = el('div', 'hud-chip')
    this.tcChip = el('div', 'hud-chip')
    this.absChip = el('div', 'hud-chip')
    this.easyBadge = el('div', 'hud-chip hud-easy')
    this.easyBadge.textContent = 'Easy'
    this.chips = el('div', 'hud-chips')
    this.chips.append(
      this.viewportChip, this.inputChip, this.camera, this.ghostChip,
      this.tcChip, this.absChip, this.easyBadge,
    )

    // The race lives IN the timing card, not under it. The card is already the
    // place you look for "how am I doing", and a race answers that with a
    // position and the two gaps rather than with a delta to a ghost — so the
    // rows swap over and the card keeps its position, its size and its
    // meaning. A second panel below it was two cards competing to be the one
    // you read first.
    // ONE race panel, not two.
    //
    // It was a card of three numbers with an order board underneath, and the
    // position appeared in both — two panels competing to be the one you read
    // first, saying overlapping things. A broadcast timing tower does not do
    // that: it is a header saying which lap, the order under it, and an
    // interval on every row. That is strictly more information in less space,
    // because the row you are on IS your position and the interval beside it IS
    // your gap.
    // The lap counter is the first thing you look for in a race and it was set
    // in the same 10px uppercase as everything else on the sub-line. It gets to
    // be a number you can read at a glance without taking your eyes off the
    // road for long enough to matter.
    this.raceLapNum = el('span', 'hud-lap-num')
    this.raceLap = el('div', 'hud-lap is-hidden')
    const lapWord = el('span', 'hud-lap-word')
    lapWord.textContent = 'LAP'
    this.raceLap.append(lapWord, this.raceLapNum)

    this.boardRows = el('div', 'hud-board-rows')
    this.board = el('div', 'hud-board is-hidden')
    this.board.append(this.boardRows)
    this.lastDelta = el('span', 'hud-value')
    // Its own element, NOT the time trial's `last`. Appending one node to two
    // rows does not copy it, it moves it — the race card quietly took the time
    // trial's value span with it, and a time trial has been showing a LAST row
    // with a label and nothing beside it ever since. Both are written on every
    // frame; only one set of rows is ever on screen.
    this.raceLast = el('span', 'hud-value')
    this.raceRows = el('div', 'hud-rows is-hidden')
    this.raceRows.append(labelled('Last', this.raceLast), labelled('vs best', this.lastDelta))
    // All of it lives INSIDE the timing card, under its sub-line.
    card.append(this.raceLap, this.board, this.raceRows)
    this.penaltyValue = el('span', 'hud-value')
    this.penaltyRow = labelled('Time penalty', this.penaltyValue)
    this.penaltyRow.classList.add('hud-penalty', 'is-hidden')
    card.append(this.penaltyRow)
    this.limitsNotice = el('div', 'hud-track-limits is-hidden')
    this.limitsNotice.setAttribute('role', 'status')

    // The lights, centre screen, only while they are on.
    // `hud-start-lights`, not `hud-lights`: the shift-light strip in the
    // binnacle has owned that name since before there was a race to start, and
    // sharing it dragged the rev strip out of the binnacle and blew its
    // spacing up to gantry size.
    this.raceLights = el('div', 'hud-start-lights is-hidden')
    for (let i = 0; i < 5; i++) this.raceLights.append(el('span', 'hud-start-light'))
    this.launchHint = el('div', 'hud-launch-hint is-hidden')


    this.root.append(
      card, sectorWrap, this.map, this.invalid, this.lapBanner,
      this.raceLights, this.launchHint, tele, this.chips, this.proximity.root, this.limitsNotice,
    )
  }

  /** Clear per-lap transient state. */
  /**
   * The race card and the start lights.
   *
   * Gaps are shown in METRES rather than seconds, which is the honest unit
   * mid-race: a time gap needs both cars to have crossed the same point, and
   * the number people actually want mid-corner is how much road is between
   * them. Under a car length it says CONTACT, because at that range the exact
   * figure has stopped being the useful information.
   */
  private updateRace(r: HudRaceState | undefined): void {
    const racing = r !== undefined
    // Swap the card's rows over rather than showing both. In a race "Delta" has
    // nothing to compare against and "Best" is a number nobody is racing for.
    this.timeRows.classList.toggle('is-hidden', racing)
    this.raceRows.classList.toggle('is-hidden', !racing)
    this.raceLap.classList.toggle('is-hidden', !racing)
    this.board.classList.toggle('is-hidden', !racing)
    if (!r) return

    setText(this.sub, r.finished
      ? `RACE · FINISHED P${r.position}/${r.size}`
      : `RACE · P${r.position}/${r.size}`)
    this.raceLap.classList.toggle('is-hidden', false)
    setText(this.raceLapNum, `${Math.min(r.lap, r.laps)}/${r.laps}`)
    setText(this.lastDelta, r.lastVsBest === null
      ? '—'
      : `${r.lastVsBest > 0 ? '+' : '-'}${Math.abs(r.lastVsBest).toFixed(3)}`)
    this.lastDelta.classList.toggle('is-good', r.lastVsBest !== null && r.lastVsBest < 0)
    this.lastDelta.classList.toggle('is-warn', r.lastVsBest !== null && r.lastVsBest > 0)
    this.renderBoard(r)

  }

  private updateStartLights(s: HudState): void {
    const starting = s.race?.starting ?? s.qualifyingIntro?.active ?? false
    const count = s.race?.lights ?? s.qualifyingIntro?.lights ?? 0
    const hint = s.race?.launchHint ?? s.qualifyingIntro?.hint ?? ''
    this.raceLights.classList.toggle('is-hidden', !starting)
    this.launchHint.classList.toggle('is-hidden', !hint)
    setText(this.launchHint, hint)
    for (let i = 0; i < this.raceLights.children.length; i++) {
      this.raceLights.children[i]!.classList.toggle('is-lit', i < count)
    }
  }

  /**
   * The order board.
   *
   * Rows are created once and then only their text changes, because a race
   * rebuilding eight rows of DOM sixty times a second is sixty times more
   * layout than it needs and it makes the numbers flicker as they are replaced.
   */
  private renderBoard(r: HudRaceState): void {
    while (this.boardRows.children.length < r.standings.length) {
      const row = el('div', 'hud-board-row')
      row.append(
        el('span', 'hud-board-pos'),
        el('span', 'hud-board-chip'),
        el('span', 'hud-board-name'),
        el('span', 'hud-board-gap'),
      )
      this.boardRows.append(row)
    }
    for (let i = 0; i < this.boardRows.children.length; i++) {
      const row = this.boardRows.children[i] as HTMLElement
      const entry = r.standings[i]
      row.classList.toggle('is-hidden', entry === undefined)
      if (!entry) continue
      row.classList.toggle('is-player', entry.isPlayer)
      const [pos, chip, name, gap] = row.children as unknown as HTMLElement[]
      setText(pos!, String(entry.position))
      chip!.style.background = entry.colour
      setText(name!, entry.name)
      // Gap to the LEADER on every row, which is the one comparison that is the
      // same question for everybody. The gaps to the cars either side of you
      // are in the card, because those are the two that are yours.
      // The interval to the car IN FRONT on every row, which is the number
      // that says whether a place is about to change. Metres until enough
      // history exists for a real interval, because a wrong second is worse
      // than an honest metre.
      setText(gap!, entry.finished
        ? 'FIN'
        : entry.position === 1
          ? 'LEADER'
          : entry.interval !== null
            ? `+${entry.interval.toFixed(1)}`
            : gapText(entry.intervalMetres))
    }
  }

  private updateTrackLimits(limits: TrackLimits | undefined): void {
    if (limits !== this.activeLimits) {
      this.activeLimits = limits
      this.shownOffence = 0
      if (this.limitsTimer) clearTimeout(this.limitsTimer)
      this.limitsTimer = null
      this.limitsNotice.classList.add('is-hidden')
    }
    this.penaltyRow.classList.toggle('is-hidden', !limits?.penaltySeconds)
    setText(this.penaltyValue, `+${limits?.penaltySeconds ?? 0}s`)
    const event = limits?.lastEvent
    if (!event || event.offence === this.shownOffence) return
    this.shownOffence = event.offence
    this.limitsNotice.textContent = event.seconds > 0
      ? `+${event.seconds}s time penalty · Track limits`
      : `${event.offence === 1 ? 'First' : 'Second'} track limits warning`
    this.limitsNotice.classList.toggle('is-penalty', event.seconds > 0)
    this.limitsNotice.classList.remove('is-hidden')
    if (this.limitsTimer) clearTimeout(this.limitsTimer)
    this.limitsTimer = setTimeout(() => {
      this.limitsNotice.classList.add('is-hidden')
      this.limitsTimer = null
    }, 4500)
  }

  resetLap(): void {
    this.sectorHoldUntil = 0
    this.lapWasInvalid = false
    this.invalid.classList.remove('is-on')
    this.invalidAction.classList.remove('is-on')
    if (this.invalidTimer) clearTimeout(this.invalidTimer)
    this.invalidTimer = null
  }

  /** Show a lap result without stopping anything. Fades on its own, and the
   *  sector pills hold the finished lap's numbers while it does. */
  flashLap(time: number, valid: boolean, isBest: boolean, kind: LapFlash = 'pb'): void {
    // "Personal best" is the wrong words in a race — the lap does not set one,
    // and the thing worth shouting about is having gone quicker than everyone
    // else out there. Same banner, same fade, different claim.
    const label = !valid
      ? 'Lap invalid'
      : !isBest
        ? 'Lap time'
        : kind === 'fastest' ? 'Fastest lap' : 'Personal best'
    this.lapBannerLabel.textContent = label
    this.lapBannerTime.textContent = formatTime(time)
    this.lapBanner.className = `lap-banner is-on ${!valid ? 'is-void' : isBest ? 'is-best' : ''}`
    if (this.bannerTimer) clearTimeout(this.bannerTimer)
    this.bannerTimer = setTimeout(() => this.lapBanner.classList.remove('is-on'), 3400)
    this.sectorHoldUntil = performance.now() + 4000
  }

  /** One pill in one of its states. The class carries the fill colour. */
  private setPill(
    i: number,
    state: 'purple' | 'good' | 'warn' | 'neutral' | 'live' | 'pend',
    timeText: string,
    deltaText: string,
    invalid: boolean,
  ): void {
    const node = this.sectors[i]!
    const cls = `hud-sector is-${state}${invalid ? ' is-invalid' : ''}`
    if (node.className !== cls) node.className = cls
    setText(this.sectorTimes[i]!, timeText)
    setText(this.sectorDeltaEls[i]!, deltaText)
  }

  /**
   * Point the map at a circuit. Cheap to call every session: it rebuilds only
   * when the circuit actually changes, and building samples the whole road.
   */
  setTrack(track: Track | null): void {
    if (!track) {
      this.map.replaceChildren()
      this.hudMap = null
      this.mapTrackId = ''
      return
    }
    if (track.id === this.mapTrackId) return
    this.hudMap = buildHudMap(track)
    this.mapTrackId = track.id
    this.map.replaceChildren(this.hudMap.root)
  }

  update(s: HudState): void {
    this.proximity.update(s.proximity ?? [])
    this.updateRace(s.race)
    this.updateStartLights(s)
    this.updateTrackLimits(s.race ? s.trackLimits : undefined)
    this.invalid.classList.toggle('is-hidden', s.race !== undefined)
    setText(this.speed, String(Math.round(s.speedKmh)))
    setText(this.gear, s.speedKmh < 1 && s.gear === 0 ? 'N' : String(s.gear + 1))

    if (this.hudMap) {
      this.hudMap.setCar(s.carX, s.carY, s.sector)
      this.hudMap.setGhost(s.ghostX ?? 0, s.ghostY)
      this.hudMap.setOpponents(s.race?.mapDots ?? [])
    }

    setText(this.mfdValue, s.tcLevel > 0 ? String(s.tcLevel) : 'OFF')
    setDisplay(this.absBadge, s.abs)
    this.absBadge.classList.toggle('is-live', s.absBite > 0.02)
    // Amber says "the wheel does something here", so it is only honest while
    // the wheel does. Fixed aids read as an instrument, not a control.
    this.mfdValue.classList.toggle('is-live', ASSISTS_ADJUSTABLE)

    // The lamp reads OFF rather than disappearing. A missing indicator and an
    // indicator saying nothing is happening look identical at a glance, and
    // those two are the opposite of each other when the car steps sideways.
    setText(this.tcLampText, s.tcLevel > 0 ? 'ACTIVE' : 'OFF')
    this.tcLamp.classList.toggle('is-off', s.tcLevel === 0)
    // Opacity rather than on/off, so a light brush of TC looks like a light
    // brush. Floored well above zero once it bites at all, or the first hint of
    // intervention is invisible on a bright track.
    this.tcLamp.style.setProperty(
      '--bite',
      s.tcBite > 0 ? String(Math.min(0.35 + s.tcBite * 4, 1)) : '0',
    )

    // Shift lights: nothing at all until the engine is worth watching, then the
    // strip fills across and every light goes red together at the limit.
    const revFrac = s.redlineRpm > 0 ? Math.min(s.rpm / s.redlineRpm, 1) : 0
    const lit = Math.round(
      Math.max(0, (revFrac - LIGHTS_FROM) / (1 - LIGHTS_FROM)) * SHIFT_LIGHTS,
    )
    const limit = revFrac > 0.97
    for (let i = 0; i < SHIFT_LIGHTS; i++) {
      const led = this.lights[i]!
      led.classList.toggle('is-on', i < lit)
      led.classList.toggle('is-limit', limit)
    }

    // In a race `updateRace` owns this line — it says which lap of how many,
    // which is the question a race asks. Writing both would mean whichever ran
    // last wins, and that was the time-attack one.
    if (!s.race) {
      setText(
        this.sub,
        s.qualifying ? 'ONE-SHOT QUALIFYING'
          : `Lap ${s.lapCount + 1} · ${Math.round(s.lapFraction * 100)}% · ${s.validLaps} valid`,
      )
    }
    setText(this.current, s.timingArmed ? formatTime(s.currentLap) : '--:--.---')
    this.current.classList.toggle('is-void', !s.race && !s.lapValid && s.timingArmed)
    setText(this.last, formatTime(s.lastLap))
    setText(this.raceLast, formatTime(s.lastLap))
    setText(this.best, formatTime(s.bestLap))

    // The delta is a row like the others now, so it keeps its slot rather than
    // appearing and collapsing the card under it.
    setText(this.delta, s.ghostDelta === null ? '--.---' : formatDelta(s.ghostDelta))
    const deltaCls =
      'hud-value' +
      (s.ghostDelta === null ? ' is-idle' : s.ghostDelta <= 0 ? ' is-ahead' : ' is-behind')
    if (this.delta.className !== deltaCls) this.delta.className = deltaCls

    // --- the sector pills, pygame's state machine ---
    // During the hold, show the finished lap's whole set; otherwise the live
    // lap: completed splits with deltas, the current sector counting up,
    // pending sectors previewing the last lap dimmed.
    const holding = performance.now() < this.sectorHoldUntil
    const splits = holding ? s.lastSectors : s.sectors
    const deltas = holding ? s.lastSectorDeltas : s.sectorDeltas
    const purples = holding ? s.lastSectorBestFlags : s.sectorBestFlags
    const invalid = !s.race && (holding ? !s.lastLapValid
      : s.timingArmed && !s.lapValid)
    const cur = holding ? 3 : s.timingArmed ? splits.findIndex((x) => x === null) : -1
    // Time already banked this lap, so the live pill counts only its own sector.
    let done = 0
    for (const sp of splits) if (sp !== null) done += sp

    for (let i = 0; i < 3; i++) {
      const split = splits[i] ?? null
      if (split !== null) {
        const d = deltas[i] ?? null
        const racePurples = holding ? s.race?.purpleLastSectors : s.race?.purpleSectors
        const state = sectorPillState(
          d,
          s.race ? (racePurples?.[i] ?? false) : (purples[i] ?? false),
          s.race !== undefined,
        )
        const dtxt = d === null ? '' : `${d > 0 ? '+' : '-'}${Math.abs(d).toFixed(3)}`
        this.setPill(i, state, split.toFixed(2), dtxt, invalid)
      } else if (i === cur) {
        this.setPill(i, 'live', Math.max(s.currentLap - done, 0).toFixed(2), 'LIVE', invalid)
      } else {
        const preview = s.lastSectors[i]
        this.setPill(i, 'pend', preview != null ? preview.toFixed(2) : '--.--', '', false)
      }
    }
    this.sectorHint.classList.toggle('is-on', !s.timingArmed)
    setText(this.sectorHint, s.qualifying ? 'CROSS THE LINE TO START QUALIFYING' : 'cross the line')
    setText(this.invalidAction, s.qualifying ? 'FINISH THE LAP · START AT THE BACK' : 'PRESS R TO RESTART')

    const lapInvalid = !s.race && s.timingArmed && !s.lapValid
    if (lapInvalid && !this.lapWasInvalid) {
      this.invalid.classList.add('is-on')
      this.invalidAction.classList.add('is-on')
      if (this.invalidTimer) clearTimeout(this.invalidTimer)
      this.invalidTimer = setTimeout(() => {
        this.invalidAction.classList.remove('is-on')
        this.invalidTimer = null
      }, 2600)
    } else if (!lapInvalid && this.lapWasInvalid) {
      this.invalid.classList.remove('is-on')
      this.invalidAction.classList.remove('is-on')
      if (this.invalidTimer) clearTimeout(this.invalidTimer)
      this.invalidTimer = null
    }
    this.lapWasInvalid = lapInvalid
    // Transforms, not height/left: these three move every frame, and a
    // transform is compositor-only where a geometry write forces layout.
    this.throttleBar.style.transform = `scaleY(${s.throttle})`
    this.brakeBar.style.transform = `scaleY(${s.brake})`
    this.steerRail.style.transform = `translateX(${(0.5 - s.steer * 0.5) * 100}%)`

    setText(this.camera, s.cameraLabel)
    setText(this.inputChip, s.inputLabel)
    setText(this.viewportChip, s.viewportLabel)
    setText(this.ghostChip, `Ghost ${s.ghost ? 'on' : 'off'}`)
    setText(this.tcChip, s.tcLevel > 0 ? `TC level ${s.tcLevel}` : 'TC off')
    setText(this.absChip, `ABS ${s.abs ? 'on' : 'off'}`)
    setDisplay(this.easyBadge, s.easy)
    // Show the chips only when one of them changes — press C and the camera
    // name confirms itself, then the corner goes back to being sky. The aids
    // are in the signature too, so switching difficulty says what that bought
    // you rather than leaving it to be discovered at the first corner.
    const sig = `${s.viewportLabel}|${s.inputLabel}|${s.cameraLabel}|${s.ghost}`
      + `|${s.easy}|${s.tcLevel}|${s.abs}`
    if (sig !== this.chipSig) {
      this.chipSig = sig
      this.chips.classList.add('is-on')
      if (this.chipsTimer) clearTimeout(this.chipsTimer)
      this.chipsTimer = setTimeout(() => this.chips.classList.remove('is-on'), 2200)
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

/**
 * Write text only when it actually changed.
 *
 * Assigning `textContent` replaces the element's child text node whether or not
 * the string differs, which invalidates layout for that node every time. The
 * HUD rewrote 29 of them per frame while only a handful — speed, the running
 * lap, the delta — differ between one frame and the next; the rest are lap
 * times, sector splits and setting names that change a few times a minute.
 */
function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value
}

/** Show or hide, writing the style only on the transition — same reasoning. */
function setDisplay(node: HTMLElement, shown: boolean): void {
  const value = shown ? '' : 'none'
  if (node.style.display !== value) node.style.display = value
}

function labelled(label: string, value: HTMLElement): HTMLElement {
  const row = el('div', 'hud-row')
  const l = el('span', 'hud-label')
  l.textContent = label
  row.append(l, value)
  return row
}

function bar(fill: HTMLElement, label: string): HTMLElement {
  const wrap = el('div', 'hud-bar-wrap')
  const outer = el('div', 'hud-bar')
  outer.append(fill)
  const l = el('span', 'hud-bar-label')
  l.textContent = label
  wrap.append(outer, l)
  return wrap
}
