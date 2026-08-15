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

/** Shift lights, as an LED strip: green, amber, then red at the limit. */
const SHIFT_LIGHTS = 12
/** Fraction of the redline at which the first light comes on. */
const LIGHTS_FROM = 0.6

export interface HudState {
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

export class Hud {
  readonly root: HTMLDivElement

  private readonly speed: HTMLElement
  private readonly gear: HTMLElement
  private readonly map: HTMLElement
  private hudMap: HudMap | null = null
  private mapTrackId = ''
  private readonly mfdValue: HTMLElement
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
  private readonly throttleBar: HTMLElement
  private readonly brakeBar: HTMLElement
  private readonly camera: HTMLElement
  private readonly inputChip: HTMLElement
  private readonly viewportChip: HTMLElement
  private readonly ghostChip: HTMLElement
  private readonly easyBadge: HTMLElement
  private readonly steerNeedle: HTMLElement
  private readonly lapBanner: HTMLElement
  private readonly lapBannerTime: HTMLElement
  private readonly lapBannerLabel: HTMLElement
  private sectorHint!: HTMLElement
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

    main.append(pedals, readout, this.gear)
    if (ASSISTS_ADJUSTABLE) main.append(mfd)

    // Steering readout. This is the wheel, not a region you must keep the
    // cursor inside — the cursor steers anywhere on screen.
    const steerTrack = el('div', 'hud-steer-track')
    const steerCentre = el('div', 'hud-steer-centre')
    this.steerNeedle = el('div', 'hud-steer-needle')
    steerTrack.append(steerCentre, this.steerNeedle)

    tele.append(lights, main, steerTrack)

    // Status chips: what the last keypress did, then out of the way. These are
    // settings state, not driving information — permanently on screen they were
    // four words you had already read.
    this.camera = el('div', 'hud-chip')
    this.inputChip = el('div', 'hud-chip')
    this.viewportChip = el('div', 'hud-chip')
    this.ghostChip = el('div', 'hud-chip')
    this.easyBadge = el('div', 'hud-chip hud-easy')
    this.easyBadge.textContent = 'Easy'
    this.chips = el('div', 'hud-chips')
    this.chips.append(this.viewportChip, this.inputChip, this.camera, this.ghostChip, this.easyBadge)

    this.root.append(card, sectorWrap, this.map, this.invalid, this.lapBanner, tele, this.chips)
  }

  /** Clear per-lap transient state. */
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
  flashLap(time: number, valid: boolean, isBest: boolean): void {
    this.lapBannerLabel.textContent = !valid ? 'Lap invalid' : isBest ? 'Personal best' : 'Lap time'
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
    node.className = `hud-sector is-${state}${invalid ? ' is-invalid' : ''}`
    node.dataset['n'] = String(i + 1)
    ;(node.querySelector('.hud-sector-time') as HTMLElement).textContent = timeText
    ;(node.querySelector('.hud-sector-delta') as HTMLElement).textContent = deltaText
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
    this.speed.textContent = String(Math.round(s.speedKmh))
    this.gear.textContent = s.speedKmh < 1 && s.gear === 0 ? 'N' : String(s.gear + 1)

    if (this.hudMap) {
      this.hudMap.setCar(s.carX, s.carY, s.sector)
      this.hudMap.setGhost(s.ghostX ?? 0, s.ghostY)
    }

    this.mfdValue.textContent = s.tcLevel > 0 ? String(s.tcLevel) : 'OFF'
    // Amber says "the wheel does something here", so it is only honest while
    // the wheel does. Fixed aids read as an instrument, not a control.
    this.mfdValue.classList.toggle('is-live', ASSISTS_ADJUSTABLE)

    // The lamp reads OFF rather than disappearing. A missing indicator and an
    // indicator saying nothing is happening look identical at a glance, and
    // those two are the opposite of each other when the car steps sideways.
    this.tcLampText.textContent = s.tcLevel > 0 ? 'ACTIVE' : 'OFF'
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

    this.sub.textContent =
      `Lap ${s.lapCount + 1} · ${Math.round(s.lapFraction * 100)}% · ${s.validLaps} valid`
    this.current.textContent = s.timingArmed ? formatTime(s.currentLap) : '--:--.---'
    this.current.classList.toggle('is-void', !s.lapValid && s.timingArmed)
    this.last.textContent = formatTime(s.lastLap)
    this.best.textContent = formatTime(s.bestLap)

    // The delta is a row like the others now, so it keeps its slot rather than
    // appearing and collapsing the card under it.
    this.delta.textContent = s.ghostDelta === null ? '--.---' : formatDelta(s.ghostDelta)
    this.delta.className =
      'hud-value' +
      (s.ghostDelta === null ? ' is-idle' : s.ghostDelta <= 0 ? ' is-ahead' : ' is-behind')

    // --- the sector pills, pygame's state machine ---
    // During the hold, show the finished lap's whole set; otherwise the live
    // lap: completed splits with deltas, the current sector counting up,
    // pending sectors previewing the last lap dimmed.
    const holding = performance.now() < this.sectorHoldUntil
    const splits = holding ? s.lastSectors : s.sectors
    const deltas = holding ? s.lastSectorDeltas : s.sectorDeltas
    const purples = holding ? s.lastSectorBestFlags : s.sectorBestFlags
    const invalid = holding ? !s.lastLapValid : s.timingArmed && !s.lapValid
    const cur = holding ? 3 : s.timingArmed ? splits.findIndex((x) => x === null) : -1
    // Time already banked this lap, so the live pill counts only its own sector.
    let done = 0
    for (const sp of splits) if (sp !== null) done += sp

    for (let i = 0; i < 3; i++) {
      const split = splits[i] ?? null
      if (split !== null) {
        const d = deltas[i] ?? null
        const state = purples[i] ? 'purple' : d === null ? 'neutral' : d <= 0 ? 'good' : 'warn'
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

    const lapInvalid = s.timingArmed && !s.lapValid
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
    this.throttleBar.style.height = `${Math.round(s.throttle * 100)}%`
    this.brakeBar.style.height = `${Math.round(s.brake * 100)}%`
    this.steerNeedle.style.left = `${(0.5 - s.steer * 0.5) * 100}%`

    this.camera.textContent = s.cameraLabel
    this.inputChip.textContent = s.inputLabel
    this.viewportChip.textContent = s.viewportLabel
    this.ghostChip.textContent = `Ghost ${s.ghost ? 'on' : 'off'}`
    this.easyBadge.style.display = s.easy ? '' : 'none'
    // Show the chips only when one of them changes — press C and the camera
    // name confirms itself, then the corner goes back to being sky.
    const sig = `${s.viewportLabel}|${s.inputLabel}|${s.cameraLabel}|${s.ghost}|${s.easy}`
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
