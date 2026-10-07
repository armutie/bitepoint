/**
 * Session choice, followed by the circuit and handling or a supported race.
 *
 * Two things keep this from reading as a settings dialog with a game attached.
 * Circuit cards draw the **actual shape of the lap** from the outline in the
 * manifest, so choosing a track is choosing a place rather than a name in a
 * list. Car rows show bars read straight off ``CarParams``, so the comparison
 * is the real one and stays true if the presets are retuned.
 *
 * The setup panel is where a future advanced tab goes: the seam is
 * ``renderSetup``, which today writes the assist switch and could write a full
 * CarParams editor without anything around it changing.
 */
import type { CarParams, MenuPresetName, PresetInfo, PresetName } from '../core/carParams'
import { applyEasyAids, handlingPreset, PRESET_INFO } from '../core/carParams'
import type { TrackManifestEntry } from '../core/track'
import {
  DIFFICULTIES, difficultyByName, MAX_OPPONENTS, MAX_RACE_LAPS,
} from '../core/raceSession'
import { isClean, type Assists, type LeaderboardClient, type LeaderboardEntry } from '../storage/leaderboard'
import { ASSISTS_ADJUSTABLE, SHOW_REFERENCE_DRIVER } from '../features'
import { formatTime, keyOf, type LapRecord, type RecordKey } from '../storage/records'
import { carBars, carTags, powerToWeight } from './carStats'
import { buildTrackMap } from './trackMap'
import { icon, type IconName } from './icons'
import {
  DEFAULT_SETTINGS, EFFECTS, SENSITIVITY, VOLUME, fullLockOffset,
  levelOf, type Level, type Settings,
} from './settings'
import { CAMERA_LABEL, CAMERA_ORDER } from '../render/cameras'
import { VIEWPORT_LABEL, VIEWPORT_ORDER } from '../game/viewport'
import { MOUSE_DEADZONE } from '../game/input'
import { raceSelection, RACE_TRACK } from './sessionSetup'
import type { RaceEvent } from '../core/qualifying'
import { fieldLivery, liveryCss, PLAYER_LIVERY } from '../render/liveries'

/**
 * What the session is: a lap against the clock, or a race against a field.
 *
 * The session uses one selection type. The menu restricts races to the track
 * and handling supported by the current AI.
 */
export type SessionMode = 'time' | 'race'
import {
  analyseSession, type SessionAnalysis, type SessionSummary,
} from './sessionSummary'
import { usernameHint } from '../shared/playerIdentity'
import type { PlayerProfile, PlayerProfileClient } from '../storage/player'

export interface Selection {
  trackId: string
  preset: PresetName
  easy: boolean
  ghost: boolean
  /** null follows the current personal best; an id pins a leaderboard lap. */
  ghostEntryId: string | null
  mode: SessionMode
  /** Race only. Ignored in a time trial, which never ends on its own. */
  laps: number
  opponents: number
  /** Name of a `Difficulty` in `raceSession.ts`. */
  difficulty: string
}

/** What the pause screen shows about the session it interrupted. */
export interface PauseStatus {
  race: boolean
  qualifying?: boolean
  trackLabel: string
  carLabel: string
  easy: boolean
  /** The lap in progress, seconds. Meaningless until `timingArmed`. */
  currentLap: number
  bestLap: number | null
  lapValid: boolean
  timingArmed: boolean
  validLaps: number
}

/**
 * The release ships five circuits, chosen for what they ask of a setup: Ashford
 * is the balanced reference lap, Croft Bay is pure stop-and-go, Thruxton Vale is
 * the longest, and Elvington Mile is one 670 m straight — two and a half times
 * anything else here, and the only place the low-drag trim's extra 18 km/h has
 * room to pay for the cornering it gives up. Silverstone is the first circuit
 * traced from a real reference. The rest of the calendar stays
 * visible but locked: a menu that shows what is coming reads as a roadmap, one
 * that hides it reads as thin.
 * Time-trial choices are separate from the supported race pairing.
 */
export const RELEASED_TRACKS: readonly string[] =
  ['silverstone', 'power_8', 'power_4', 'balanced_8', 'power_3']
/** Both setups in `PRESET_ORDER` are drivable; the gate is kept for the next one. */
export const RELEASED_PRESETS: readonly PresetName[] = ['legacy', 'classic']
const CONTROLS_SEEN_KEY = 'car-racing:controls-seen'
const PENDING_LEADERBOARD_LAP_KEY = 'bitepoint:pending-leaderboard-lap:v1'

export interface MenuDeps {
  tracks: TrackManifestEntry[]
  presets: PresetInfo[]
  /** Personal bests, keyed by `keyOf`, for showing what there is to beat. */
  bests: Map<string, LapRecord>
  leaderboard: LeaderboardClient
  /** Null while the board is the browser-only fallback. */
  profiles: PlayerProfileClient | null
  /**
   * The picture — the canvas, not the window.
   *
   * Steering is measured from the centre of the picture, and with the viewport
   * boxed to 11:7.6 that is not the centre of the screen. The sensitivity
   * preview draws in the same frame the input reads in, so it takes the same
   * element rather than assuming the two agree.
   */
  picture: HTMLElement
}

export class Menu {
  readonly root: HTMLDivElement
  selection: Selection
  settings: Settings

  onStart: (s: Selection) => void = () => {}
  onQualify: (s: Selection) => void = () => {}
  onNewEvent: () => void = () => {}
  raceEvent: RaceEvent | null = null
  onResume: () => void = () => {}
  onRestart: () => void = () => {}
  onEndSession: () => void = () => {}
  onQuit: () => void = () => {}
  onProfileClaimed: () => void = () => {}
  onSelectionChange: (s: Selection) => void = () => {}
  onSettingsChange: (s: Settings) => void = () => {}

  private readonly deps: MenuDeps
  private readonly panel: HTMLDivElement
  /** The two full-lock lines over the picture. Built once, moved as needed. */
  private readonly lock: LockPreview
  private flowStep: 'mode' | 'circuit' | 'handling' | 'race' = 'mode'
  private timeSelection: Pick<Selection, 'trackId' | 'preset'> = { trackId: 'power_8', preset: 'legacy' }
  private mainOpen = false
  private controlsOpen = false
  private settingsOpen = false
  private profileOpen = false
  /** Board filters are browsing state; changing them must not rebuild the 3D preview. */
  private leaderboardTrackId: string
  private leaderboardEasy: boolean
  /** A local PB the driver explicitly asked to publish after choosing a name. */
  private pendingLeaderboardLap: LapRecord | null
  /**
   * Tuning: the pointer is on the sensitivity slider, so the lines are up and
   * the rest of the panel is out of the way.
   *
   * Strictly while the control is held or hovered. This was latched at first,
   * so that you could walk the cursor out to the line you had just placed —
   * but a preview that stays up after you have moved away reads as something
   * stuck rather than something offered, and no gesture is worth that.
   */
  private tuning = false
  /**
   * True between pointerdown and pointerup on the slider.
   *
   * The thumb captures the pointer, so a drag that runs past the end of the
   * track leaves the control's box and fires `pointerleave` — mid-drag, which
   * is the one moment the lines must not go anywhere.
   */
  private dragging = false
  /**
   * Pending hover delay before the lines come up. Crossing the slider on the
   * way to something else must not flash the preview; holding still for a beat
   * is the signal that you mean to read it.
   */
  private hoverTune: ReturnType<typeof setTimeout> | null = null
  /** Window-to-menu transform, refreshed whenever the preview is laid out. */
  private frame = { left: 0, top: 0, scale: 1 }
  /** The slider block the lines belong to, or null outside the settings screen. */
  private tuningControl: HTMLElement | null = null

  constructor(deps: MenuDeps, initial: Selection, settings: Settings) {
    this.deps = deps
    this.selection = initial
    if (initial.mode === 'time') this.timeSelection = { trackId: initial.trackId, preset: initial.preset }
    this.settings = settings
    this.leaderboardTrackId = initial.trackId
    this.leaderboardEasy = initial.easy
    this.pendingLeaderboardLap = restorePendingLeaderboardLap(deps.bests)
    this.root = el('div', 'menu')
    this.panel = el('div', 'menu-panel')
    this.lock = buildLockPreview()
    this.root.append(this.panel, this.lock.root)
    window.addEventListener('keydown', (event) => {
      if (!this.visible || event.key !== '?') return
      if (this.mainOpen || this.controlsOpen) {
        event.preventDefault()
        this.controlsOpen ? this.renderFlow() : this.showControls()
      }
    })
    // Both wired ONCE, on things that outlive a rebuild. Choosing any setting
    // calls showSettings again, so a listener added while building the panel
    // would be added again on every click — the panel node itself survives
    // `replaceChildren`, and so would its listeners.
    window.addEventListener('resize', () => { if (this.tuning) this.layoutLock() })
    // The drag ends wherever the mouse happens to be. If that is off the
    // slider, the hover that put the lines up is over too.
    //
    // Tested against where the pointer actually is rather than against
    // `:hover`, which the thumb's pointer capture leaves stuck on the slider
    // until the mouse next moves — release the drag out over the circuit and
    // the lines would have stayed up, which is the exact thing being fixed.
    window.addEventListener('pointerup', (e) => {
      if (!this.dragging) return
      this.dragging = false
      if (!hits(this.tuningControl, e.clientX, e.clientY)) this.setTuning(false)
    })
    this.showMain()
  }

  get visible(): boolean {
    return !this.root.classList.contains('is-hidden')
  }

  hide(): void {
    this.root.classList.add('is-hidden')
    this.hideLock()
  }

  /** Return from a settings/reference screen before Escape reaches gameplay. */
  handleEscape(): boolean {
    if (!this.visible) return false
    if (this.profileOpen) {
      void this.showLeaderboard()
      return true
    }
    if (this.controlsOpen || this.settingsOpen) this.renderFlow()
    else if (this.mainOpen && this.flowStep !== 'mode') this.backFlow()
    else return false
    return true
  }

  private show(kind: 'full' | 'dialog'): void {
    this.root.classList.remove('is-hidden')
    this.root.classList.toggle('menu-dialog', kind === 'dialog')
    this.root.classList.remove('menu-controls', 'menu-flow', 'menu-profile', 'menu-session-summary')
    this.mainOpen = false
    this.controlsOpen = false
    this.settingsOpen = false
    this.profileOpen = false
    // Every screen comes through here, so this is the one place the preview has
    // to be put away — including the case where the pointer left the slider by
    // way of a click that changed screens, which fires no `pointerleave`.
    this.hideLock()
  }

  /** Put the full-lock lines away, whatever state they were left in. */
  private hideLock(): void {
    this.setTuning(false)
    this.tuningControl = null
    this.lock.root.hidden = true
  }

  private paramsFor(preset: PresetName): CarParams {
    const p = handlingPreset(preset)
    return this.selection.easy ? applyEasyAids(p) : p
  }

  showMain(): void {
    this.flowStep = 'mode'
    this.renderFlow()
  }

  showRaceEvent(): void {
    this.flowStep = 'race'
    this.renderFlow()
  }

  private renderFlow(): void {
    const focused = document.activeElement
    const keyboardFocus = focused instanceof HTMLElement && focused.matches(':focus-visible')
    const focusedLabel = focused?.getAttribute('aria-label')
    this.show('full')
    this.mainOpen = true
    this.root.classList.add('menu-flow')
    this.root.dataset.step = this.flowStep
    this.panel.replaceChildren()

    const top = el('header', 'flow-top')
    const wordmark = el('button', 'flow-wordmark')
    wordmark.textContent = 'Bite Point'
    wordmark.addEventListener('click', () => this.showMain())
    const trail = el('nav', 'flow-trail')
    trail.setAttribute('aria-label', 'Session setup')
    const steps = this.flowStep === 'mode' ? ['Session']
      : this.selection.mode === 'race' ? ['Session', 'Race setup']
      : ['Session', 'Circuit', 'Handling']
    const active = this.flowStep === 'mode' ? 0 : this.flowStep === 'handling' ? 2 : 1
    steps.forEach((label, index) => {
      const step = el('button', 'flow-trail-step')
      step.textContent = `${String(index + 1).padStart(2, '0')} / ${label}`
      step.disabled = index >= active
      if (index === active) step.setAttribute('aria-current', 'step')
      step.addEventListener('click', () => {
        this.flowStep = index === 0 ? 'mode' : 'circuit'
        this.renderFlow()
      })
      trail.append(step)
    })
    top.append(wordmark, trail)

    const body = el('main', 'flow-body')
    const footer = el('footer', 'flow-footer')
    const utilities = el('div', 'flow-utilities')
    const records = el('button', 'flow-link')
    records.textContent = 'Records'
    records.addEventListener('click', () => this.openLeaderboard())
    const controls = el('button', 'flow-link')
    controls.textContent = 'Controls'
    controls.addEventListener('click', () => this.showControls())
    const settings = el('button', 'flow-link')
    settings.textContent = 'Settings'
    settings.addEventListener('click', () => this.showSettings())
    if (this.flowStep !== 'race') utilities.append(records)
    utilities.append(controls, settings)
    footer.append(utilities)

    if (this.flowStep === 'mode') {
      const intro = el('div', 'flow-intro')
      const kicker = el('p', 'flow-kicker')
      kicker.textContent = 'A driving simulation'
      const title = el('h1', 'flow-title flow-title-home')
      title.setAttribute('aria-label', 'Bite Point')
      title.innerHTML = 'Bite<br>Point<span class="flow-period">.</span>'
      intro.append(kicker, title)
      body.classList.add('flow-home')
      body.append(intro, this.renderModePicker())
      const hint = el('span', 'flow-footnote')
      hint.textContent = 'Keyboard & mouse'
      footer.append(hint)
    } else {
      const header = el('div', 'flow-heading')
      const kicker = el('p', 'flow-kicker')
      kicker.textContent = this.selection.mode === 'race' ? 'Race / event setup' : 'Time trial'
      const title = el('h1', 'flow-title')
      title.textContent = this.flowStep === 'circuit' ? 'Choose your circuit.'
        : this.flowStep === 'handling' ? 'Set your balance.' : 'Croft Bay.'
      header.append(kicker, title)
      body.append(header)

      if (this.flowStep === 'race') {
        header.append(this.renderEventProgress())
        body.append(this.renderRaceEvent())
      }
      else if (this.flowStep === 'circuit') body.append(this.renderTracks())
      else {
        const circuit = this.deps.tracks.find((track) => track.id === this.selection.trackId)
        const location = el('p', 'flow-context')
        location.textContent = circuit?.label ?? this.selection.trackId
        header.append(location)
        body.append(this.renderCars(), this.renderSetup())
      }

      const actions = el('div', 'flow-actions')
      const back = el('button', 'flow-link flow-back')
      const canReset = this.flowStep === 'race' && !!this.raceEvent?.qualifying && !this.raceEvent.completed
      back.textContent = canReset ? 'New event' : '← Back'
      back.addEventListener('click', () => {
        if (canReset) { this.onNewEvent(); this.renderFlow() }
        else this.backFlow()
      })
      const next = el('button', 'flow-continue')
      next.textContent = this.flowStep === 'circuit' ? 'Continue'
        : SHOW_REFERENCE_DRIVER ? 'Watch' : this.flowStep === 'race'
          ? this.raceEvent?.completed ? 'New event' : this.raceEvent?.qualifying ? 'To the grid' : 'Start qualifying'
          : 'Drive'
      next.addEventListener('click', () => {
        if (this.flowStep === 'circuit') {
          this.flowStep = 'handling'
          this.renderFlow()
        } else if (this.flowStep === 'race' && this.raceEvent?.completed) {
          this.onNewEvent()
          this.renderFlow()
        } else if (hasSeenControls()) this.startDrive()
        else this.showQuickStart()
      })
      actions.append(back, next)
      footer.append(actions)
    }
    this.panel.append(top, body, footer)
    if (keyboardFocus) {
      const restored = [...this.panel.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => focusedLabel && button.getAttribute('aria-label') === focusedLabel && !button.disabled)
      const heading = this.panel.querySelector<HTMLHeadingElement>('h1')
      if (restored) restored.focus({ preventScroll: true })
      else if (heading) {
        heading.tabIndex = -1
        heading.focus({ preventScroll: true })
      }
    }
  }

  private backFlow(): void {
    this.flowStep = this.flowStep === 'handling' ? 'circuit' : 'mode'
    this.renderFlow()
  }

  private chooseMode(mode: SessionMode): void {
    if (this.selection.mode === 'time') {
      this.timeSelection = { trackId: this.selection.trackId, preset: this.selection.preset }
    }
    this.selection = mode === 'race'
      ? raceSelection({ ...this.selection, mode })
      : { ...this.selection, ...this.timeSelection, mode, ghostEntryId: null }
    this.flowStep = mode === 'race' ? 'race' : 'circuit'
    this.onSelectionChange(this.selection)
    this.renderFlow()
  }

  private renderRaceEvent(): HTMLElement {
    const event = el('div', 'flow-race-event')
    const circuit = this.deps.tracks.find((track) => track.id === RACE_TRACK)
    const venue = el('section', 'flow-venue')
    venue.setAttribute('aria-label', 'Race circuit and handling')
    if (circuit) {
      const map = el('div', 'flow-venue-map')
      map.append(buildTrackMap(circuit))
      const facts = el('div', 'flow-venue-facts')
      facts.textContent = `${(circuit.length / 1000).toFixed(2)} km / ${circuit.corners} corners`
      venue.append(map, facts)
    }
    const trim = el('div', 'flow-fixed-trim')
    const label = el('span', 'flow-kicker')
    label.textContent = 'Handling'
    const name = el('strong', '')
    name.textContent = 'Low Drag'
    const note = el('span', 'flow-trim-note')
    note.textContent = 'The race setup'
    trim.append(label, name, note)
    venue.append(trim)
    const setup = el('div', 'flow-race-setup')
    if (this.raceEvent?.qualifying) setup.append(this.renderQualifyingResults())
    else setup.append(this.renderRaceOptions(), this.renderSetup())
    event.append(venue, setup)
    return event
  }

  private renderEventProgress(): HTMLElement {
    const progress = el('ol', 'flow-event-progress')
    progress.setAttribute('aria-label', 'Race event progression')
    const qualified = !!this.raceEvent?.qualifying
    for (const [index, label] of ['One-shot qualifying', 'Race'].entries()) {
      const step = el('li', 'flow-event-step')
      const current = index === (qualified ? 1 : 0) && !this.raceEvent?.completed
      step.classList.toggle('is-current', current)
      if (current) step.setAttribute('aria-current', 'step')
      const number = el('span', 'flow-event-number')
      number.textContent = index === 0 && qualified || this.raceEvent?.completed ? '✓' : `0${index + 1}`
      const title = el('span', '')
      title.textContent = label
      const status = el('span', 'flow-event-status')
      status.textContent = index === 0 ? qualified ? 'Complete' : 'One flying lap'
        : this.raceEvent?.completed ? 'Complete' : qualified ? 'Ready' : 'After qualifying'
      step.append(number, title, status)
      progress.append(step)
    }
    return progress
  }

  private renderQualifyingResults(): HTMLElement {
    const result = this.raceEvent!.qualifying!
    const section = el('section', 'flow-qualifying-results')
    const label = el('p', 'flow-kicker')
    label.textContent = 'Qualifying results'
    const summary = el('div', 'flow-grid-position')
    const place = el('strong', '')
    place.textContent = `P${result.playerPosition}`
    const time = el('span', '')
    time.textContent = result.playerTime === null ? 'No valid lap · back of the grid' : formatTime(result.playerTime)
    summary.append(place, time)
    const table = el('ol', 'flow-qualifying-order')
    for (const entry of result.entries) {
      const row = el('li', 'flow-qualifying-row')
      row.classList.toggle('is-player', entry.isPlayer)
      const position = el('span', 'flow-grid-number')
      position.textContent = String(result.entries.indexOf(entry) + 1).padStart(2, '0')
      const colour = el('i', 'flow-grid-colour')
      colour.style.background = liveryCss(entry.isPlayer ? PLAYER_LIVERY : fieldLivery(entry.driverId))
      const name = el('span', 'flow-grid-driver')
      name.textContent = entry.isPlayer ? 'You' : `Car ${entry.driverId + 1}`
      const lap = el('span', 'flow-grid-time')
      lap.textContent = entry.time === null ? 'No time' : formatTime(entry.time)
      row.append(position, colour, name, lap)
      table.append(row)
    }
    const format = el('p', 'flow-event-format')
    format.textContent = `${this.selection.laps} laps / ${this.selection.opponents} opponents / ${difficultyByName(this.selection.difficulty).label}`
    section.append(label, summary, table, format)
    return section
  }


  /** Full reference, deliberately one step away from the selection screen. */
  private showControls(): void {
    this.show('dialog')
    this.root.classList.add('menu-controls')
    this.controlsOpen = true
    markControlsSeen()
    this.panel.replaceChildren()

    const header = el('header', 'menu-header controls-header')
    const eyebrow = el('div', 'eyebrow')
    eyebrow.textContent = 'Keyboard + mouse'
    const title = el('h1', 'menu-title')
    title.textContent = 'Controls'
    header.append(eyebrow, title)

    const grid = el('div', 'controls-grid')
    for (const group of CONTROL_GROUPS) {
      const rows = group.rows.map(([key, label]) => [key,
        key === 'R' && this.selection.mode === 'race'
          ? this.raceEvent?.qualifying ? 'Clutch at start; restart race after launch' : 'End qualifying attempt'
          : label,
      ] as const)
      grid.append(controlGroup(group.title, rows))
    }

    const actions = el('div', 'menu-actions controls-actions')
    const back = el('button', 'btn btn-primary')
    back.textContent = 'Back'
    back.addEventListener('click', () => this.renderFlow())
    actions.append(back)
    this.panel.append(header, grid, actions)
  }

  /** One small first-run gate; reading the full reference also dismisses it. */
  private showQuickStart(): void {
    this.show('dialog')
    this.root.classList.add('menu-controls')
    this.controlsOpen = true
    this.panel.replaceChildren()

    const header = el('header', 'menu-header controls-header')
    const eyebrow = el('div', 'eyebrow')
    eyebrow.textContent = 'Before your first lap'
    const title = el('h1', 'menu-title')
    title.textContent = 'Four things to know'
    header.append(eyebrow, title)

    const quick = el('div', 'quick-controls')
    for (const [key, label] of QUICK_CONTROLS) quick.append(controlRow(key,
      key === 'R' && this.selection.mode === 'race'
        ? this.raceEvent?.qualifying ? 'Clutch at start' : 'End qualifying attempt' : label))
    const launch = this.selection.mode === 'race' ? el('p', 'quick-launch-tip') : null
    if (launch) launch.textContent = this.raceEvent?.qualifying
      ? 'Hold R to start the lights, then hold W. When all five red lights go out, release R while keeping W held.'
      : 'The AI drives the sector 3 run-up for five seconds. One red light appears each second; take control when all five go out. Cross the line to begin your timed lap. An invalid or abandoned lap puts you at the back.'

    const actions = el('div', 'menu-actions quick-actions')
    const back = el('button', 'btn')
    back.textContent = 'Back'
    back.addEventListener('click', () => this.renderFlow())
    const start = el('button', 'btn btn-primary')
    start.textContent = 'Drive'
    start.addEventListener('click', () => {
      markControlsSeen()
      this.startDrive()
    })
    actions.append(back, start)
    this.panel.append(header, quick)
    if (launch) this.panel.append(launch)
    this.panel.append(actions)
  }

  private startDrive(): void {
    if (this.selection.mode === 'race') this.selection = raceSelection(this.selection)
    this.hide()
    if (this.selection.mode === 'race' && !this.raceEvent?.qualifying) this.onQualify(this.selection)
    else this.onStart(this.selection)
  }

  private openLeaderboard(): void {
    this.leaderboardTrackId = this.selection.trackId
    this.leaderboardEasy = this.selection.easy
    void this.showLeaderboard()
  }

  /** One timing board, with circuit and rules visible where they are changed. */
  async showLeaderboard(): Promise<void> {
    this.show('full')
    this.panel.replaceChildren()

    const header = el('header', 'menu-header leaderboard-header')
    const heading = el('div', 'leaderboard-heading')
    const eyebrow = el('div', 'eyebrow')
    eyebrow.textContent = 'Time attack'
    const title = el('h1', 'menu-title')
    title.textContent = 'Leaderboard'
    heading.append(eyebrow, title)
    header.append(heading)
    const login = this.leaderboardLogin()
    if (login) header.append(login)

    const filters = this.leaderboardFilters()

    const body = el('div', 'menu-body leaderboard-body')
    const loading = el('div', 'leaderboard-empty')
    loading.textContent = 'Loading laps…'
    body.append(loading)
    this.panel.append(header, filters, body, this.leaderboardFooter())

    const key = { trackId: this.leaderboardTrackId, easy: this.leaderboardEasy }
    try {
      await this.publishPendingLeaderboardLap()
      const page = await this.deps.leaderboard.list(key)
      // Do not paint a request that resolved after the user moved to another board.
      if (key.trackId !== this.leaderboardTrackId || key.easy !== this.leaderboardEasy) return
      body.replaceChildren()
      const scope = el('div', 'leaderboard-scope')
      scope.textContent = page.scope === 'global'
        ? 'Global laps · all setups · select a replay to race its ghost'
        : 'This browser · all setups'
      body.append(scope)
      if (ASSISTS_ADJUSTABLE) body.append(this.assistFilterBar())

      // Filtered, then re-ranked. Keeping the outright rank would put "04" at
      // the top of the clean board, which reads as a bug rather than as a
      // position on a different list.
      const rows: Array<
        | { kind: 'remote'; time: number; entry: LeaderboardEntry }
        | { kind: 'local'; time: number; record: LapRecord }
      > = page.entries
        .filter((entry) => matchesFilter(entry.assists, this.assistFilter))
        .map((entry) => ({ kind: 'remote', time: entry.time, entry }))
      const local = this.localLeaderboardLap(key, page.scope)
      if (local && matchesFilter(assistsForLap(local), this.assistFilter)) {
        rows.push({ kind: 'local', time: local.time, record: local })
      }
      rows.sort((a, b) => a.time - b.time)

      if (rows.length === 0 && page.entries.length === 0 && !local) {
        const empty = el('div', 'leaderboard-empty')
        empty.textContent = 'No laps yet. Set the first one.'
        body.append(empty)
      } else if (rows.length === 0) {
        const empty = el('div', 'leaderboard-empty')
        empty.textContent = this.assistFilter === 'clean'
          ? 'No laps without assists yet.'
          : 'No laps match that filter.'
        body.append(empty)
      } else {
        const list = el('div', 'leaderboard-list')
        const lastRemote = page.entries.at(-1)
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index]!
          if (row.kind === 'remote') {
            list.append(this.leaderboardRow({ ...row.entry, rank: index + 1 }))
          } else {
            const belowVisibleBoard =
              page.entries.length >= 50 && !!lastRemote && row.record.time >= lastRemote.time
            const rank = belowVisibleBoard ? `${page.entries.length}+` : String(index + 1).padStart(2, '0')
            list.append(this.unsavedLeaderboardRow(row.record, rank))
          }
        }
        body.append(list)
        if (ASSISTS_ADJUSTABLE) {
          const legend = el('div', 'leaderboard-legend')
          legend.textContent = 'Unmarked laps used no assists.'
          body.append(legend)
        }
      }
    } catch (error) {
      body.replaceChildren()
      const local = this.localLeaderboardLap(key, 'global')
      if (local) {
        const offline = el('div', 'leaderboard-scope is-offline')
        offline.textContent = 'Leaderboard unavailable · your lap is safe on this device'
        const list = el('div', 'leaderboard-list')
        list.append(this.unsavedLeaderboardRow(local, '—'))
        body.append(offline, list)
        return
      }
      const failed = el('div', 'leaderboard-empty is-error')
      failed.textContent = error instanceof Error ? error.message : 'Leaderboard unavailable.'
      body.append(failed)
    }
  }

  /** Publish only a lap the driver explicitly chose; keep it queued on failure. */
  private async publishPendingLeaderboardLap(): Promise<void> {
    const lap = this.pendingLeaderboardLap
    const profile = this.deps.profiles?.current
    if (!lap || !profile?.locked) return
    try {
      await this.deps.leaderboard.submit(lap, profile.username)
      this.pendingLeaderboardLap = null
      rememberPendingLeaderboardLap(null)
    } catch (error) {
      // The local lap remains visible with a Retry action. A board outage must
      // not turn choosing a name into losing the time that prompted it.
      console.warn('[leaderboard] queued lap submission failed', error)
    }
  }

  /** A private PB overlays the global board until it has a public owner. */
  private localLeaderboardLap(key: RecordKey, scope: 'global' | 'personal'): LapRecord | null {
    if (scope !== 'global' || !this.deps.profiles) return null
    const local = this.deps.bests.get(keyOf(key)) ?? null
    if (!local) return null
    if (!this.deps.profiles.current?.locked) return local
    return this.pendingLeaderboardLap && keyOf(this.pendingLeaderboardLap) === keyOf(key) ? local : null
  }

  /** Identity is an action in the header, never a panel above the times. */
  private leaderboardLogin(): HTMLButtonElement | null {
    const profiles = this.deps.profiles
    if (!profiles) return null
    const button = el('button', 'btn leaderboard-login')
    button.type = 'button'
    const current = profiles.current
    if (current) {
      button.classList.add('is-signed-in')
      const label = el('span', 'leaderboard-login-label')
      label.textContent = current.locked ? 'Racing as' : 'Local name'
      const name = el('strong', 'leaderboard-login-name')
      name.textContent = current.username
      button.append(label, name)
      button.title = current.locked
        ? 'Driver profile · protected with Google'
        : 'Not saved to the leaderboard · sign in with Google to reserve it'
    } else {
      button.textContent = 'Log in to save laps'
    }
    button.addEventListener('click', () => this.showProfile())
    return button
  }

  /** Circuit and mode belong to the board itself, not to remembered context. */
  private leaderboardFilters(): HTMLElement {
    const wrap = el('div', 'leaderboard-controls')

    const circuit = el('label', 'leaderboard-control leaderboard-circuit')
    const circuitLabel = el('span', 'leaderboard-control-label')
    circuitLabel.textContent = 'Circuit'
    const select = el('select', 'leaderboard-select')
    select.setAttribute('aria-label', 'Leaderboard circuit')
    for (const id of RELEASED_TRACKS) {
      const track = this.deps.tracks.find((item) => item.id === id)
      if (!track) continue
      const option = document.createElement('option')
      option.value = track.id
      option.textContent = track.label
      option.selected = track.id === this.leaderboardTrackId
      select.append(option)
    }
    select.addEventListener('change', () => {
      this.leaderboardTrackId = select.value
      void this.showLeaderboard()
    })
    circuit.append(circuitLabel, select)

    const mode = el('div', 'leaderboard-control leaderboard-mode-control')
    const modeLabel = el('span', 'leaderboard-control-label')
    modeLabel.textContent = 'Mode'
    const choices = el('div', 'leaderboard-mode')
    choices.setAttribute('role', 'group')
    choices.setAttribute('aria-label', 'Leaderboard mode')
    for (const [easy, label] of [[false, 'Standard'], [true, 'Easy']] as const) {
      const button = el('button', 'leaderboard-mode-option')
      button.type = 'button'
      button.textContent = label
      const selected = this.leaderboardEasy === easy
      button.classList.toggle('is-selected', selected)
      button.setAttribute('aria-pressed', String(selected))
      button.addEventListener('click', () => {
        if (this.leaderboardEasy === easy) return
        this.leaderboardEasy = easy
        void this.showLeaderboard()
      })
      choices.append(button)
    }
    mode.append(modeLabel, choices)
    wrap.append(circuit, mode)
    return wrap
  }

  /**
   * Which laps the leaderboard is showing.
   *
   * Deliberately NOT persisted and not part of `Selection`: it is a way of
   * looking at one list, not a choice about the car or the circuit, and a
   * filter that silently survives a reload is a leaderboard that looks empty
   * for reasons nobody remembers setting.
   */
  private assistFilter: AssistFilter = 'all'

  private leaderboardRow(entry: LeaderboardEntry): HTMLElement {
    const row = el('div', 'leaderboard-row')
    row.classList.toggle('is-selected', this.selection.ghostEntryId === entry.id)
    const rank = el('span', 'leaderboard-rank')
    rank.textContent = String(entry.rank).padStart(2, '0')
    const driver = el('span', 'leaderboard-driver')
    driver.textContent = entry.playerName
    const time = el('span', 'leaderboard-time')
    time.textContent = formatTime(entry.time)
    const marks = el('span', 'leaderboard-assists')
    // Only what was used gets a mark. A row of greyed-out badges saying what
    // someone did NOT use is four things to read on every line to learn
    // nothing; an empty space already means a clean lap, and the legend under
    // the list says so once.
    // The setup is shown on every lap, because the board no longer separates
    // them: without this you cannot tell whether the time above yours came from
    // a different wing, which is the one thing the merge takes away.
    const setup = entry.preset ? PRESET_INFO[entry.preset as MenuPresetName] : undefined
    if (setup) marks.append(assistBadge(setup.label, 'is-setup', `Set on ${setup.label}`))
    if (ASSISTS_ADJUSTABLE) {
      if (entry.assists?.tc) marks.append(assistBadge('TC', 'is-tc', 'Traction control was used'))
      if (entry.assists?.abs) marks.append(assistBadge('ABS', 'is-abs', 'Anti-lock braking was on'))
    }
    const ghost = el('button', 'btn leaderboard-ghost')
    const selected = this.selection.ghostEntryId === entry.id
    ghost.textContent = selected ? 'Ghost selected' : 'Race ghost'
    ghost.disabled = !entry.ghostAvailable || selected
    ghost.title = entry.ghostAvailable ? 'Use this verified replay as your ghost' : 'Replay unavailable'
    ghost.addEventListener('click', () => {
      this.selection = {
        ...this.selection,
        trackId: this.leaderboardTrackId,
        easy: this.leaderboardEasy,
        ghost: true,
        ghostEntryId: entry.id,
      }
      this.onSelectionChange(this.selection)
      void this.showLeaderboard()
    })
    row.append(rank, driver, marks, time, ghost)
    return row
  }

  /** One honest local row: placed by its time, but clearly not public yet. */
  private unsavedLeaderboardRow(record: LapRecord, rankLabel: string): HTMLElement {
    const row = el('div', 'leaderboard-row is-unsaved')
    const rank = el('span', 'leaderboard-rank')
    rank.textContent = rankLabel
    const driver = el('span', 'leaderboard-driver')
    driver.textContent = 'Your lap'
    const marks = el('span', 'leaderboard-assists')
    const setup = PRESET_INFO[record.preset as MenuPresetName]
    if (setup) marks.append(assistBadge(setup.label, 'is-setup', `Set on ${setup.label}`))
    marks.append(assistBadge('UNSAVED', 'is-unsaved', 'This lap exists only on this device'))
    if (ASSISTS_ADJUSTABLE) {
      const assists = assistsForLap(record)
      if (assists.tc) marks.append(assistBadge('TC', 'is-tc', 'Traction control was used'))
      if (assists.abs) marks.append(assistBadge('ABS', 'is-abs', 'Anti-lock braking was on'))
    }
    const time = el('span', 'leaderboard-time')
    time.textContent = formatTime(record.time)
    const save = el('button', 'btn leaderboard-ghost leaderboard-save')
    save.type = 'button'
    const signedIn = this.deps.profiles?.current?.locked === true
    save.textContent = signedIn ? 'Retry save' : 'Sign in to save'
    save.addEventListener('click', () => {
      this.pendingLeaderboardLap = record
      rememberPendingLeaderboardLap(record)
      if (signedIn) void this.showLeaderboard()
      else this.showProfile(record)
    })
    row.append(rank, driver, marks, time, save)
    return row
  }

  private assistFilterBar(): HTMLElement {
    const bar = el('div', 'leaderboard-filter')
    for (const [id, label, title] of ASSIST_FILTERS) {
      const b = el('button', 'chip')
      b.textContent = label
      b.title = title
      const on = this.assistFilter === id
      b.classList.toggle('is-selected', on)
      b.setAttribute('aria-pressed', String(on))
      b.addEventListener('click', () => {
        this.assistFilter = id
        void this.showLeaderboard()
      })
      bar.append(b)
    }
    return bar
  }

  private leaderboardFooter(): HTMLElement {
    const footer = el('footer', 'menu-footer leaderboard-footer')
    const actions = el('div', 'menu-footer-actions')
    const personal = el('button', 'btn')
    const followingPersonal =
      this.selection.trackId === this.leaderboardTrackId &&
      this.selection.easy === this.leaderboardEasy &&
      this.selection.ghostEntryId === null
    personal.textContent = followingPersonal ? 'Following personal best' : 'Use personal best'
    personal.disabled = followingPersonal
    personal.addEventListener('click', () => {
      this.selection = {
        ...this.selection,
        trackId: this.leaderboardTrackId,
        easy: this.leaderboardEasy,
        ghost: true,
        ghostEntryId: null,
      }
      this.onSelectionChange(this.selection)
      void this.showLeaderboard()
    })
    const back = el('button', 'btn btn-primary')
    back.textContent = 'Back'
    back.addEventListener('click', () => this.renderFlow())
    actions.append(personal, back)
    footer.append(actions)
    return footer
  }

  /**
   * The pause screen: where you are, then what you can do about it.
   *
   * It used to be a flavour headline over three buttons and the full ten-key
   * map — all words, none of them about the session you had just stopped. The
   * useful thing to know at Esc is whether the lap in progress is still alive,
   * so that is now the screen: the lap clock, the time to beat, and a loud
   * INVALID when you have put a wheel on the grass, which is also what makes
   * Restart the obvious button rather than one of three equals.
   *
   * The keymap shrinks to the controls you cannot see anywhere else. Resume and
   * Restart carry their own shortcut, so the strip no longer has to name them,
   * and the camera and picture keys are already visible as HUD chips.
   */
  showPause(status: PauseStatus | null = null): void {
    this.show('dialog')
    this.panel.replaceChildren()

    const eyebrow = el('div', 'eyebrow')
    eyebrow.textContent = 'Paused'
    this.panel.append(eyebrow)

    if (status) {
      const meta = el('div', 'pause-meta')
      meta.append(chip(status.trackLabel), sep(), chip(status.carLabel))
      if (status.easy) {
        const easy = el('span', 'tag tag-warn')
        easy.textContent = 'EASY'
        meta.append(easy)
      }

      const stats = el('div', 'pause-stats')
      // The lap you are in, big — it is the one at stake. Before the first
      // crossing there is no lap running, so it reads as blank rather than 0.
      const lap = pauseStat(
        'This lap',
        status.timingArmed ? formatTime(status.currentLap) : '—',
        'is-lead',
      )
      if (status.timingArmed && !status.lapValid) {
        lap.classList.add('is-void')
        const void_ = el('span', 'pause-void')
        void_.textContent = 'Invalid'
        lap.append(void_)
      }
      stats.append(
        lap,
        pauseStat('Best', status.bestLap !== null ? formatTime(status.bestLap) : '—', ''),
        pauseStat('Clean laps', String(status.validLaps), ''),
      )
      this.panel.append(meta, stats)
    }

    const actions = el('div', 'menu-actions pause-actions')
    actions.append(
      actionButton('play', 'Resume', 'Esc', 'btn-primary', () => {
        this.hide()
        this.onResume()
      }),
      actionButton('reset', status?.qualifying ? 'End qualifying' : status?.race ? 'Restart race' : 'Restart lap', 'R', '', () => {
        this.hide()
        this.onRestart()
      }),
      actionButton('menu', 'End session', '', '', () => this.onEndSession()),
    )
    this.panel.append(actions, this.renderHelp(DRIVING_KEYS))
  }

  /** A focused identity screen, opened only when the driver asks to save laps. */
  private showProfile(lap?: LapRecord, editName = false): void {
    if (lap) {
      this.pendingLeaderboardLap = lap
      rememberPendingLeaderboardLap(lap)
    }
    this.show('dialog')
    this.root.classList.add('menu-profile')
    this.profileOpen = true
    this.panel.replaceChildren()

    const header = el('header', 'menu-header profile-header')
    const eyebrow = el('div', 'eyebrow')
    eyebrow.textContent = 'Driver profile'
    const title = el('h1', 'menu-title')
    title.textContent = 'Save your laps'
    header.append(eyebrow, title)

    const actions = el('div', 'menu-actions profile-actions')
    const back = el('button', 'btn')
    back.type = 'button'
    back.textContent = 'Back to leaderboard'
    back.addEventListener('click', () => void this.showLeaderboard())
    actions.append(back)

    const profiles = this.deps.profiles!
    const currentProfile = profiles.current
    if (currentProfile?.locked) {
      const signOutStatus = el('span', 'profile-signout-status')
      signOutStatus.setAttribute('role', 'status')
      const signOut = el('button', 'btn profile-account-action')
      signOut.type = 'button'
      signOut.textContent = 'Log out'
      signOut.addEventListener('click', () => {
        signOut.disabled = true
        signOut.textContent = 'Logging out…'
        signOutStatus.textContent = ''
        void profiles.signOut().then(() => this.showLeaderboard()).catch((reason: unknown) => {
          signOutStatus.textContent = reason instanceof Error ? reason.message : 'Could not log out.'
          signOut.textContent = 'Log out'
          signOut.disabled = false
        })
      })
      actions.append(signOutStatus, signOut)
    } else if (currentProfile && !editName) {
      const changeName = el('button', 'btn profile-account-action')
      changeName.classList.add('is-change-name')
      changeName.type = 'button'
      changeName.textContent = 'Change name'
      changeName.addEventListener('click', () => this.showProfile(undefined, true))
      actions.append(changeName)
    }

    const profile = this.profilePanel(editName)
    this.panel.append(header, profile, actions)
    ;(profile.querySelector('.profile-input') as HTMLInputElement | null)?.focus()
  }

  /** A public name is asked for here, never at boot and never before driving. */
  private profilePanel(editName = false): HTMLElement {
    const profiles = this.deps.profiles!
    const wrap = el('section', 'leaderboard-profile')
    const current = profiles.current
    if (current && !editName) {
      const label = el('span', 'leaderboard-profile-label')
      label.textContent = 'Racing as'
      const username = el('strong', 'leaderboard-profile-name')
      username.textContent = current.username
      const status = el('span', 'leaderboard-profile-status')
      status.textContent = current.locked
        ? 'Protected with Google · available on your other devices'
        : 'Only on this device · not reserved'
      wrap.append(label, username, status)
      if (profiles.supportsGoogle && !current.locked) {
        const recovery = profileRecovery(
          'Save to leaderboard',
          profiles.claimError ?? 'Sign in to reserve this name and publish your laps.',
        )
        const recoveryCopy = recovery.querySelector<HTMLElement>('.profile-recovery-copy')!
        const lock = googleSignInButton()
        lock.addEventListener('click', () => {
          lock.disabled = true
          recoveryCopy.textContent = 'Opening Google…'
          void profiles.lockWithGoogle().then(() => this.showProfile()).catch((reason: unknown) => {
            recoveryCopy.textContent = reason instanceof Error ? reason.message : 'Google is unavailable.'
            lock.disabled = false
          })
        })
        recovery.append(lock)
        wrap.append(recovery)
      }
      return wrap
    }

    const copy = el('div', 'leaderboard-profile-copy')
    const title = el('strong', 'leaderboard-profile-title')
    title.textContent = editName
      ? 'Change driver name'
      : this.pendingLeaderboardLap ? 'Save this lap' : 'Choose a driver name'
    const blurb = el('span', 'leaderboard-profile-blurb')
    blurb.textContent = editName
      ? 'This name is local. It is not reserved until you sign in with Google.'
      : this.pendingLeaderboardLap
        ? `${formatTime(this.pendingLeaderboardLap.time)} is safe on this device. Choose a local name; Google sign-in publishes it.`
        : 'Choose a local driver name. Nothing is published until you sign in with Google.'
    copy.append(title, blurb)

    const form = document.createElement('form')
    form.className = 'leaderboard-profile-form'
    const username = el('input', 'profile-input') as HTMLInputElement
    username.name = 'username'
    username.placeholder = 'Username'
    username.autocomplete = 'username'
    username.maxLength = 16
    username.spellcheck = false
    username.setAttribute('aria-label', 'Username')
    if (editName && current) username.value = current.username

    form.append(username)

    const submit = el('button', 'btn btn-primary profile-submit')
    submit.type = 'submit'
    submit.textContent = editName ? 'Change name' : 'Use name'
    form.append(submit)

    const hint = el('span', 'leaderboard-profile-hint')
    hint.textContent = usernameHint
    const error = el('span', 'leaderboard-profile-error')
    error.setAttribute('role', 'alert')
    error.textContent = profiles.claimError ?? ''

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      error.textContent = ''
      submit.disabled = true
      void profiles.claim(username.value).then((profile) => {
        this.showProfileClaimed(wrap, profile)
      }).catch((reason: unknown) => {
        error.textContent = reason instanceof Error ? reason.message : 'Profile unavailable.'
        submit.disabled = false
      })
    })

    const help = el('div', 'leaderboard-profile-help')
    help.append(hint, error)
    wrap.append(copy, form, help)
    if (profiles.supportsGoogle && !editName) {
      const recovery = profileRecovery(
        'Already have a profile?',
        'Bring back a driver name you protected with Google.',
      )
      const recoveryCopy = recovery.querySelector<HTMLElement>('.profile-recovery-copy')!
      const signIn = googleSignInButton()
      signIn.addEventListener('click', () => {
        signIn.disabled = true
        recoveryCopy.textContent = 'Opening Google…'
        void profiles.signInWithGoogle().catch((reason: unknown) => {
          error.textContent = reason instanceof Error ? reason.message : 'Google is unavailable.'
          signIn.disabled = false
        })
      })
      recovery.append(signIn)
      wrap.append(recovery)
    }
    return wrap
  }

  private showProfileClaimed(wrap: HTMLElement, profile: PlayerProfile): void {
    wrap.classList.add('is-claimed')
    const copy = el('div', 'leaderboard-profile-copy')
    const title = el('strong', 'leaderboard-profile-title')
    title.textContent = profile.locked ? `${profile.username} is yours` : `${profile.username} saved locally`
    const blurb = el('span', 'leaderboard-profile-blurb')
    blurb.textContent = profile.locked
      ? 'Protected with Google and available on your other devices.'
      : this.pendingLeaderboardLap
        ? 'Your lap is still only on this device. Sign in with Google to reserve the name and publish it.'
        : 'Nothing is published yet. Sign in with Google to reserve this name.'
    copy.append(title, blurb)

    const profiles = this.deps.profiles!
    if (profiles.supportsGoogle && !profile.locked) {
      const recovery = profileRecovery(
        'Save to leaderboard',
        'Reserve this name and publish your laps with Google.',
      )
      const recoveryCopy = recovery.querySelector<HTMLElement>('.profile-recovery-copy')!
      const lock = googleSignInButton()
      lock.addEventListener('click', () => {
        lock.disabled = true
        recoveryCopy.textContent = 'Opening Google…'
        void profiles.lockWithGoogle().then(() => this.showProfile()).catch((reason: unknown) => {
          recoveryCopy.textContent = reason instanceof Error ? reason.message : 'Google is unavailable.'
          lock.disabled = false
        })
      })
      recovery.append(lock)
      wrap.replaceChildren(copy, recovery)
    } else {
      wrap.replaceChildren(copy)
    }

    const done = el('button', 'btn btn-primary')
    done.textContent = profile.locked && this.pendingLeaderboardLap
      ? 'Save lap to leaderboard'
      : 'Continue to leaderboard'
    done.addEventListener('click', () => this.onProfileClaimed())
    this.panel.querySelector('.profile-actions')?.replaceChildren(done)
  }

  /**
   * A debrief, not a dashboard: one picture of the run and only facts that
   * help explain it. Empty sessions never arrive here; `main.ts` sends those
   * straight to the menu so a quick setup check does not demand another click.
   */
  showSessionSummary(summary: SessionSummary): void {
    this.show('dialog')
    this.root.classList.add('menu-session-summary')
    this.panel.replaceChildren()

    const analysis = analyseSession(summary)
    const header = el('header', 'menu-header session-header')
    const eyebrow = el('div', 'eyebrow')
    eyebrow.textContent = 'Session complete'
    const title = el('h1', 'menu-title')
    title.textContent = 'Run review'
    const meta = el('div', 'pause-meta')
    meta.append(chip(summary.trackLabel), sep(), chip(summary.carLabel))
    if (summary.easy) {
      const easy = el('span', 'tag tag-warn')
      easy.textContent = 'EASY'
      meta.append(easy)
    }
    header.append(eyebrow, title, meta)

    const chart = sessionChart(summary, analysis)
    const facts = el('div', 'session-facts')
    const fastest = analysis.fastest
    facts.append(
      sessionFact(
        'Fastest',
        fastest ? formatTime(fastest.time) : '—',
        fastest ? `Lap ${fastest.number}` : 'No clean lap',
        'is-lead',
      ),
      sessionFact(
        'Ideal lap',
        analysis.theoreticalBest !== null ? formatTime(analysis.theoreticalBest) : '—',
        analysis.theoreticalGain !== null && analysis.theoreticalGain >= 0.005
          ? `${analysis.theoreticalGain.toFixed(2)}s left`
          : analysis.theoreticalBest !== null ? 'Sectors aligned' : 'Not enough data',
        '',
      ),
      sessionFact(
        'Clean laps',
        `${analysis.validLaps.length} / ${summary.laps.length}`,
        analysis.validLaps.length === summary.laps.length ? 'Every lap stood' : 'Completed laps',
        '',
      ),
    )

    const sectors = el('div', 'session-sectors')
    for (let index = 0; index < analysis.bestSectors.length; index++) {
      const best = analysis.bestSectors[index]
      const item = el('div', 'session-sector')
      const label = el('span', `session-sector-label s${index + 1}`)
      label.textContent = `S${index + 1}`
      const time = el('span', 'session-sector-time')
      time.textContent = best ? formatTime(best.time) : '—'
      const lap = el('span', 'session-sector-lap')
      lap.textContent = best ? `Lap ${best.lap}` : 'No time'
      item.append(label, time, lap)
      sectors.append(item)
    }

    const body = el('div', 'session-body')
    body.append(chart, facts, sectors)
    if (analysis.observation) {
      const observation = el('p', 'session-observation')
      observation.textContent = analysis.observation
      body.append(observation)
    }

    const actions = el('div', 'menu-actions session-actions')
    const continueButton = el('button', 'btn')
    continueButton.textContent = 'Keep driving'
    continueButton.addEventListener('click', () => {
      this.hide()
      this.onResume()
    })
    const done = el('button', 'btn btn-primary')
    done.textContent = 'Main menu'
    done.addEventListener('click', () => this.onQuit())
    actions.append(continueButton, done)

    this.panel.append(header, body, actions)
  }

  /**
   * The settings screen.
   *
   * Three rules, and the whole layout falls out of them.
   *
   * **Show, don't caption.** Every control is a row of icons or three short
   * words, and changes apply live against the circuit behind the panel — so
   * the screen explains itself by *being* the thing it changes. The paragraph
   * that used to sit under the title described controls that are now visible
   * at a glance, so it is gone.
   *
   * **The look is one choice, not four.** Modern and Authentic are a picker at
   * the top rather than a button off to the side, and Custom lights up on its
   * own the moment a knob disagrees with both. The row therefore always states
   * where you are, which a button that only ever said "apply" could not.
   *
   * **Anything you changed, you can put back.** A reset appears beside any row
   * that differs from its default, and next to the title if anything does at
   * all. Nothing is destructive, so nothing needs confirming.
   */
  showSettings(): void {
    this.show('full')
    this.settingsOpen = true
    this.panel.replaceChildren()

    const s = this.settings
    const set = (patch: Partial<Settings>): void => {
      this.settings = { ...this.settings, ...patch }
      this.onSettingsChange(this.settings)
      this.showSettings()
    }
    /** True when a field is not what it ships as — i.e. the reset has work. */
    const off = <K extends keyof Settings>(k: K): boolean => s[k] !== DEFAULT_SETTINGS[k]
    const revert = <K extends keyof Settings>(k: K) => () =>
      set({ [k]: DEFAULT_SETTINGS[k] } as Partial<Settings>)

    const header = el('header', 'menu-header set-header')
    const title = el('h1', 'menu-title')
    title.textContent = 'Settings'
    // Built always and hidden when idle, like the per-row resets — the slider
    // changes a setting without rebuilding the panel, so a Reset all that only
    // existed if something was already off default would never appear.
    const all = el('button', 'reset-btn reset-all')
    all.append(icon('reset'), text('Reset all'))
    all.title = 'Put every setting back to default'
    all.addEventListener('click', () => set(DEFAULT_SETTINGS))
    header.append(title, all)
    /** Re-read the live settings, not the build-time snapshot in `s`. */
    const syncResetAll = (): void => {
      const keys = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]
      all.classList.toggle('is-idle', !keys.some((k) => this.settings[k] !== DEFAULT_SETTINGS[k]))
    }
    syncResetAll()

    const body = el('div', 'menu-body settings-body')

    // The section stays lit while the sensitivity lines are up; the rest of the
    // panel dims out of the way. See `.menu.is-tuning`.
    const driving = el('section', 'menu-section is-tuning-focus')
    driving.append(sectionTitle('Driving', ''))
    driving.append(this.sensitivityRow(syncResetAll))
    // ABS sits here rather than on the wheel with traction control, because
    // unlike TC it cannot be changed while driving — so it is a choice you make
    // before the lap, and one bit travels with the recording. Not offered in
    // v1: every lap is the same test, which is what keeps the leaderboard one
    // plain list of times. See ASSISTS_ADJUSTABLE.
    if (ASSISTS_ADJUSTABLE) driving.append(
      setRow('ABS', segmented(
        [
          { id: 'off', label: 'Off' },
          { id: 'on', label: 'On' },
        ],
        s.abs ? 'on' : 'off',
        (v) => set({ abs: v === 'on' }),
      ), off('abs'), revert('abs')),
    )

    const view = el('section', 'menu-section')
    view.append(sectionTitle('View', ''))
    view.append(
      // Named, not just drawn. Four camera icons at 15px are four small
      // rectangles with a dot in a different place, and the difference between
      // Halo and Hood is not a shape anyone can read — the tooltip only helps
      // someone who already suspects there is something to hover. Steering
      // spells its two out; there is no reason this should not.
      setRow('Camera', segmented(
        CAMERA_ORDER.map((c) => ({
          id: c as string, icon: c as IconName, label: CAMERA_LABEL[c],
        })),
        s.camera,
        (v) => set({ camera: v as Settings['camera'] }),
      ), off('camera'), revert('camera')),
      // Bloom, grain and blur, plus the speed FOV and kerb shake that used to
      // be sliders of their own — all of it is how excitable the camera is.
      setRow('Effects', levels(
        EFFECTS, s.effects, (v) => set({ effects: v }),
      ), off('effects'), revert('effects')),
      setRow('Frame', segmented(
        VIEWPORT_ORDER.map((v) => ({
          id: v as string, icon: v as IconName, label: VIEWPORT_LABEL[v],
        })),
        s.viewport,
        (v) => set({ viewport: v as Settings['viewport'] }),
      ), off('viewport'), revert('viewport')),
    )

    const system = el('section', 'menu-section')
    system.append(sectionTitle('System', ''))
    system.append(
      setRow('Graphics', segmented(
        [
          { id: 'quality', label: 'Quality' },
          { id: 'performance', label: 'Performance' },
        ],
        s.performanceMode ? 'performance' : 'quality',
        (v) => set({ performanceMode: v === 'performance' }),
      ), off('performanceMode'), revert('performanceMode')),
      // Its own row rather than folded into Effects: the picture and the sound
      // are the two things a player turns down for completely different
      // reasons, and tying them together means you cannot silence the car
      // without also flattening the image.
      setRow('Sound', levels(
        VOLUME, s.volume, (v) => set({ volume: v }),
      ), off('volume'), revert('volume')),
    )

    body.append(driving, view, system)

    const footer = el('footer', 'menu-footer')
    const back = el('button', 'btn btn-primary')
    back.textContent = 'Back'
    back.addEventListener('click', () => this.renderFlow())
    const acts = el('div', 'settings-actions')
    acts.append(back)
    footer.append(el('div', ''), acts)

    this.panel.append(header, body, footer)
  }

  /**
   * Sensitivity: a slider, and two lines on the picture at full lock.
   *
   * The setting is a distance — how far from the middle of the screen the wheel
   * reaches its stop — so the control shows that distance at full size rather
   * than describing it. Drag, and the lines walk in or out to where your hand
   * will actually have to go. Nothing else in here can be previewed this
   * honestly, which is why nothing else in here is a slider.
   *
   * Deliberately does NOT go through `set`, which rebuilds the whole panel: a
   * slider that replaced itself on every input event would drop the drag on the
   * first pixel. It does the same three things by hand instead — store, notify,
   * and update the two resets that would otherwise have gone stale.
   */
  private sensitivityRow(syncResetAll: () => void): HTMLElement {
    const control = el('div', 'lock-control')
    const range = document.createElement('input')
    range.type = 'range'
    range.className = 'range'
    range.min = '0'
    range.max = '1'
    // Fine enough that the lines move smoothly, coarse enough that a value is
    // reproducible — a player who wants Medium-but-slightly-less can find it
    // again, and 100 stops is more than the eye can separate on a line anyway.
    range.step = '0.01'
    range.setAttribute('aria-label', 'Steering sensitivity')

    const ticks = el('div', 'range-ticks')
    const tickFor = (name: Level, value: number): HTMLElement => {
      const t = el('button', 'range-tick')
      t.type = 'button'
      // The thumb's centre travels from half a thumb in to half a thumb short
      // of the far end, so a tick placed at a flat percentage of the track sits
      // beside the value it names rather than under it.
      t.style.left = `calc(${value * 100}% + ${((0.5 - value) * THUMB).toFixed(2)}px)`
      t.textContent = name[0]!.toUpperCase() + name.slice(1)
      t.title = `${t.textContent} — full lock ${Math.round(fullLockOffset(value) * 100)}% of the way to the edge`
      t.addEventListener('click', () => apply(value))
      return t
    }
    for (const [name, value] of Object.entries(SENSITIVITY) as [Level, number][]) {
      ticks.append(tickFor(name, value))
    }

    const hint = el('p', 'lock-hint')
    hint.textContent = 'The lines are full lock. Slide them in for a flick of the wrist, out for more travel.'

    // The slider and its ticks are one thing you point at; the sentence under
    // them is not. Hovering a line of explanatory text is not reaching for a
    // control, and a hit zone that runs to the bottom of the paragraph puts the
    // lines on screen for a mouse that was only passing through the column.
    const grip = el('div', 'lock-grip')
    grip.append(range, ticks)
    control.append(grip, hint)

    const row = setRow('Sensitivity', control, false, () => apply(DEFAULT_SETTINGS.mouseSensitivity))
    const reset = row.querySelector('.reset-btn') as HTMLElement

    const apply = (v: number): void => {
      this.settings = { ...this.settings, mouseSensitivity: v }
      this.onSettingsChange(this.settings)
      show(v)
      syncResetAll()
    }
    /** Paint the control at a value, without telling anyone it changed. */
    const show = (v: number): void => {
      range.value = String(v)
      // The filled part of the track is drawn from this, so it cannot disagree
      // with the thumb the way a second element would.
      range.style.setProperty('--v', String(v))
      range.setAttribute(
        'aria-valuetext',
        `full lock ${Math.round(fullLockOffset(v) * 100)} percent of the way from the centre of the screen to its edge`,
      )
      reset.classList.toggle('is-idle', v === DEFAULT_SETTINGS.mouseSensitivity)
      this.layoutLock()
    }
    show(this.settings.mouseSensitivity)

    range.addEventListener('input', () => {
      // Arrow keys on a slider a mouse click left focused: the value moves, so
      // the lines have to be there to say what moved.
      this.setTuning(true)
      apply(Number(range.value))
    })
    range.addEventListener('pointerdown', () => {
      this.dragging = true
      // A click is already a decision; do not wait out the hover delay.
      this.setTuning(true)
    })

    this.tuningControl = grip
    // The lines belong to the slider, so they come up on the slider and not on
    // the row around it. A short dwell is required so a mouse that is only
    // crossing the column does not flash the picture.
    grip.addEventListener('pointerenter', () => this.armTuningHover())
    grip.addEventListener('focusin', () => this.setTuning(true))
    // Off again as soon as you leave, except mid-drag and except while the
    // slider is being driven from the keyboard.
    grip.addEventListener('pointerleave', () => {
      if (!this.dragging && !keyboardFocused(grip)) this.setTuning(false)
    })
    // The ticks are inside the grip and focusable, so Tab off the slider lands
    // on one of them — still the same control, still worth showing.
    grip.addEventListener('focusout', (e) => {
      if (grip.contains(e.relatedTarget as Node) || grip.matches(':hover')) return
      this.setTuning(false)
    })
    return row
  }

  /**
   * Lines up, panel back — or the other way round.
   *
   * The preview exists only while the slider is in hand. Left on the screen the
   * rest of the time it is decoration over a menu, and decoration that looks
   * like an instrument is worse than none.
   */
  private setTuning(on: boolean): void {
    this.clearTuningHover()
    if (this.tuning === on || (on && !this.settingsOpen)) return
    this.tuning = on
    this.root.classList.toggle('is-tuning', on)
    this.lock.root.hidden = !on
    if (on) this.layoutLock()
  }

  /** Wait out a pass-through before treating the hover as a read. */
  private armTuningHover(): void {
    if (this.tuning || this.hoverTune !== null || !this.settingsOpen) return
    this.hoverTune = setTimeout(() => {
      this.hoverTune = null
      this.setTuning(true)
    }, 400)
  }

  private clearTuningHover(): void {
    if (this.hoverTune === null) return
    clearTimeout(this.hoverTune)
    this.hoverTune = null
  }

  /**
   * Lay the preview over the picture and put the lines where full lock is.
   *
   * Re-read from the DOM every time rather than cached: the frame setting
   * boxes the canvas, the window resizes, and a stale rect would draw the lines
   * somewhere the wheel does not actually reach full lock.
   */
  private layoutLock(): void {
    const f = this.readFrame()
    const r = this.deps.picture.getBoundingClientRect()
    const p = this.lock
    p.root.style.left = `${(r.left - f.left) / f.scale}px`
    p.root.style.top = `${(r.top - f.top) / f.scale}px`
    p.root.style.width = `${r.width / f.scale}px`
    p.root.style.height = `${r.height / f.scale}px`

    const half = r.width / f.scale / 2
    const lock = fullLockOffset(this.settings.mouseSensitivity) * half
    // Held a pixel inside the picture at the far end of the slider, where full
    // lock genuinely is the last pixel of the screen. A line drawn exactly on
    // the edge is half of it off the edge, and the preview reads as broken at
    // one end of its own travel — a pixel of untruth costs less than that.
    const edge = (x: number): number => Math.min(Math.max(x, 1), half * 2 - 1)
    p.left.style.left = `${edge(half - lock)}px`
    p.right.style.left = `${edge(half + lock)}px`
    p.dead.style.left = `${half - MOUSE_DEADZONE * half}px`
    p.dead.style.width = `${MOUSE_DEADZONE * half * 2}px`
    // Tags face inward, where there is always picture to write on — except at
    // the sensitive end, where the lines close in on each other and the two
    // labels would collide. Then they face out, which is where the room went.
    // Measured on the glass, so the comparison is against real label widths.
    p.root.classList.toggle('is-tight', lock * 2 * f.scale < TAG_ROOM)
  }

  /**
   * The transform between window pixels and the menu's own coordinates.
   *
   * On anything from 901 to 1920 px wide the whole menu is laid out on a
   * surface a third larger than the window and scaled back down — the density
   * the interface was designed at, see the media query in `styles.css`. A
   * transformed ancestor is also the containing block for anything fixed
   * inside it, so the preview is positioned in that surface's pixels while
   * every rect it works from is measured in the window's. Undo it here, once,
   * and the rest of the drawing can be written in the units it is thinking in.
   *
   * Read rather than assumed: whatever that media query becomes, this stays
   * true, and the lines cannot quietly start claiming full lock is somewhere it
   * is not.
   */
  private readFrame(): { left: number; top: number; scale: number } {
    const box = this.root.getBoundingClientRect()
    const scale = this.root.offsetWidth > 0 ? box.width / this.root.offsetWidth : 1
    this.frame = { left: box.left, top: box.top, scale: scale || 1 }
    return this.frame
  }


  /**
   * Time attack or race, as the first thing on the screen.
   *
   * It was a switch in the setup strip at the bottom, next to Easy mode, which
   * said it was an option applied to a time trial. It is not — it changes what
   * the session IS, what the rest of this panel asks you, what the HUD shows
   * and whether a lap counts for anything. A choice that big is the first thing
   * you make, not the last.
   */
  private renderModePicker(): HTMLElement {
    const wrap = el('div', 'flow-modes')
    for (const mode of [
      { id: 'time' as const, label: 'Time Trial', description: 'One car. The clock. Your ghost.' },
      { id: 'race' as const, label: 'Race', description: 'Take the grid. Race the field.' },
    ]) {
      const choice = el('button', 'flow-mode')
      const number = el('span', 'flow-mode-number')
      number.textContent = mode.id === 'time' ? '01' : '02'
      const words = el('span', 'flow-mode-words')
      const title = el('span', 'flow-mode-title')
      title.textContent = mode.label
      const description = el('span', 'flow-mode-description')
      description.textContent = mode.description
      words.append(title, description)
      const selector = el('span', 'flow-mode-selector')
      selector.setAttribute('aria-hidden', 'true')
      choice.append(number, words, selector)
      choice.addEventListener('click', () => this.chooseMode(mode.id))
      wrap.append(choice)
    }
    return wrap
  }

  private renderTracks(): HTMLElement {
    const section = el('section', 'menu-section')
    const released = RELEASED_TRACKS
      .map((id) => this.deps.tracks.find((t) => t.id === id))
      .filter((t): t is TrackManifestEntry => t !== undefined)
    section.append(sectionTitle('Circuit', `${released.length}`))
    const list = el('div', 'menu-grid')

    for (const t of released) {
      const card = el('button', 'card')
      card.setAttribute('aria-label', t.label)
      const selected = t.id === this.selection.trackId
      card.classList.toggle('is-selected', selected)
      card.setAttribute('aria-pressed', String(selected))

      const map = el('div', 'card-map')
      map.append(buildTrackMap(t))

      const info = el('div', 'card-info')
      const name = el('div', 'card-title')
      name.textContent = t.label
      const meta = el('div', 'card-meta')
      meta.innerHTML =
        `<span>${(t.length / 1000).toFixed(2)}<i>km</i></span>` +
        `<span>${t.corners}<i>corners</i></span>`

      // `keyOf`, never a hand-built string. This was spelled out by hand and
      // silently stopped matching the moment the key gained a field, so a real
      // personal best read as "no time set" — the lap was stored the whole
      // time, under a key nothing looked up.
      // Whatever your fastest lap here was, on either setup — the board no
      // longer splits on which wing was bolted on.
      const best = this.deps.bests.get(keyOf({ trackId: t.id, easy: this.selection.easy }))
      const pb = el('div', 'card-pb')
      pb.textContent = best ? formatTime(best.time) : 'no time set'
      pb.classList.toggle('is-empty', !best)

      info.append(name, meta, pb)
      card.append(map, info)
      card.addEventListener('click', () => {
        this.selection = { ...this.selection, trackId: t.id, ghostEntryId: null }
        this.onSelectionChange(this.selection)
        this.renderFlow()
      })
      list.append(card)
    }

    section.append(list)
    return section
  }

  private renderCars(): HTMLElement {
    const section = el('section', 'menu-section')
    section.append(sectionTitle('Handling', `${this.deps.presets.length}`))
    const list = el('div', 'menu-list')

    for (const info of this.deps.presets) {
      const locked = !RELEASED_PRESETS.includes(info.name)
      const row = el('button', 'row')
      row.setAttribute('aria-label', info.label)
      row.classList.toggle('is-locked', locked)
      const selected = info.name === this.selection.preset
      row.classList.toggle('is-selected', selected)
      row.setAttribute('aria-pressed', String(selected))
      if (locked) row.disabled = true

      const p = this.paramsFor(info.name)

      // Name left, power-to-weight right. It reads the same on both rows and
      // that is deliberate now: these are two setups of one car, so the figure
      // that describes the machine is shared and the table below carries what
      // is actually being chosen between.
      const head = el('div', 'row-head')
      const name = el('div', 'row-title')
      name.textContent = info.label
      const ptw = el('div', 'row-ptw')
      ptw.innerHTML = `${powerToWeight(p)}<i>kW/t</i>`
      head.append(name, ptw)

      const tagRow = el('div', 'row-tags')
      if (locked) {
        const soon = el('span', 'tag tag-soon')
        soon.textContent = 'COMING SOON'
        tagRow.append(soon)
      }
      for (const tag of carTags(p)) {
        const chip = el('span', 'tag')
        chip.textContent = tag
        if (tag === 'NO TC') chip.classList.add('tag-warn')
        tagRow.append(chip)
      }

      // Bars, not figures: two trims of one car, so the question is which way
      // this one leans. See `carBars` for why none of the scales start at zero.
      const specs = el('div', 'row-specs')
      for (const bar of carBars(p, info.name)) {
        const b = el('div', 'spec')
        const label = el('span', 'spec-label')
        label.textContent = bar.label
        const track = el('span', 'spec-bar')
        const fill = el('span', 'spec-bar-fill')
        fill.style.width = `${(bar.fill * 100).toFixed(1)}%`
        track.append(fill)
        // The one bar that reads the same on both is dimmed rather than hidden:
        // "the engine is not what you are choosing" is worth saying once.
        b.classList.toggle('is-shared', !!bar.shared)
        b.append(label, track)
        specs.append(b)
      }

      row.append(head, specs, tagRow)
      if (!locked) {
        row.addEventListener('click', () => {
          this.selection = { ...this.selection, preset: info.name, ghostEntryId: null }
          this.onSelectionChange(this.selection)
          this.renderFlow()
        })
      }
      list.append(row)
    }

    section.append(list)
    return section
  }

  /**
   * Driving aids. The hook for a later advanced tab — adding a
   * CarParams editor means extending this method and nothing else.
   */
  private renderSetup(): HTMLElement {
    const wrap = el('div', 'menu-toggles')
    wrap.append(
      switchToggle('Easy mode', 'Aids wound up, grip on the grass. Times kept apart.', this.selection.easy, (v) => {
        this.selection = { ...this.selection, easy: v, ghostEntryId: null }
        this.onSelectionChange(this.selection)
        this.renderFlow()
      }),
    )
    return wrap
  }

  /** Laps, opponents and how hard they try. Race mode only. */
  private renderRaceOptions(): HTMLElement {
    const section = el('section', 'menu-section menu-section-wide')
    const heading = el('h2', 'menu-section-title')
    heading.textContent = 'Set the field'
    const note = el('p', 'menu-section-note')
    note.textContent =
      'One flying lap sets your grid position.'
    const wrap = el('div', 'menu-race')
    const set = (patch: Partial<Selection>): void => {
      this.selection = { ...this.selection, ...patch }
      this.onSelectionChange(this.selection)
      this.renderFlow()
    }
    wrap.append(
      stepper('Laps', this.selection.laps, 1, MAX_RACE_LAPS, (v) => { set({ laps: v }) }),
      stepper(
        'Opponents', this.selection.opponents, 1, MAX_OPPONENTS,
        (v) => { set({ opponents: v }) },
      ),
      labelledRow(
        'Difficulty',
        segmented(
          DIFFICULTIES.map((d) => ({ id: d.name, label: d.label })),
          difficultyByName(this.selection.difficulty).name,
          (id) => { set({ difficulty: id }) },
        ),
      ),
    )
    section.append(heading, note, wrap)
    return section
  }

  private renderHelp(keys: readonly (readonly [string, string])[]): HTMLElement {
    const help = el('div', 'menu-help')
    for (const [k, v] of keys) {
      const item = el('span', 'menu-help-item')
      const key = el('kbd', '')
      key.textContent = k
      item.append(key, text(` ${v}`))
      help.append(item)
    }
    return help
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

function googleSignInButton(): HTMLButtonElement {
  const button = el('button', 'google-signin')
  button.type = 'button'
  button.setAttribute('aria-label', 'Sign in with Google')

  const image = document.createElement('img')
  image.src = `${import.meta.env.BASE_URL}google-signin-dark.svg`
  image.alt = ''
  image.setAttribute('aria-hidden', 'true')
  button.append(image)
  return button
}

function profileRecovery(labelText: string, copyText: string): HTMLElement {
  const recovery = el('div', 'profile-recovery')
  const textWrap = el('div', 'profile-recovery-text')
  const label = el('span', 'profile-recovery-label')
  label.textContent = labelText
  const copy = el('span', 'profile-recovery-copy')
  copy.textContent = copyText
  textWrap.append(label, copy)
  recovery.append(textWrap)
  return recovery
}

function keycap(label: string): HTMLElement {
  const key = el('kbd', '')
  key.textContent = label
  return key
}

function controlRow(key: string, label: string): HTMLElement {
  const row = el('div', 'control-row')
  const name = el('span', 'control-label')
  name.textContent = label
  row.append(keycap(key), name)
  return row
}

function controlGroup(
  title: string,
  rows: readonly (readonly [string, string])[],
): HTMLElement {
  const section = el('section', 'control-group')
  const heading = el('h2', 'control-group-title')
  heading.textContent = title
  section.append(heading)
  for (const [key, label] of rows) section.append(controlRow(key, label))
  return section
}

function hasSeenControls(): boolean {
  try {
    return window.localStorage.getItem(CONTROLS_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

function markControlsSeen(): void {
  try {
    window.localStorage.setItem(CONTROLS_SEEN_KEY, '1')
  } catch {
    // A blocked store may repeat the one-time card; controls still work.
  }
}

function sectionTitle(text: string, count: string): HTMLElement {
  const h = el('h2', 'menu-section-title')
  const label = el('span', '')
  label.textContent = text
  const n = el('span', 'menu-section-count')
  n.textContent = count
  h.append(label, n)
  return h
}

const CONTROL_GROUPS = [
  {
    title: 'Driving',
    rows: [
      ['Mouse', 'Steer'],
      ['W / ↑', 'Throttle'],
      ['S / ↓', 'Brake'],
    ],
  },
  {
    title: 'View',
    rows: [
      ['C', 'Camera'],
      ['V', 'View size'],
      ['Shift', 'Look back'],
    ],
  },
  {
    title: 'Session',
    rows: [
      ['R', 'Restart lap'],
      ['G', 'Ghost'],
      ['Esc', 'Pause'],
      ['?', 'This reference'],
    ],
  },
] as const

const QUICK_CONTROLS = [
  ['Mouse', 'Steer'],
  ['W / S', 'Throttle / brake'],
  ['R', 'Restart lap'],
  ['Esc', 'Pause'],
] as const

/**
 * Ways of looking at one board.
 *
 * Two assists give four combinations, but only three of them are questions
 * anyone asks: what is the fastest lap, what is the fastest lap nobody was
 * helped on, and — because ABS is the one this car would not have had, F1
 * having banned it in 1994 — what is the fastest lap without it.
 */
export type AssistFilter = 'all' | 'noAbs' | 'clean'

const ASSIST_FILTERS: readonly [AssistFilter, string, string][] = [
  ['all', 'All laps', 'Every lap, whatever was switched on'],
  ['noAbs', 'No ABS', 'Laps braked without anti-lock; traction control allowed'],
  ['clean', 'No assists', 'Laps with neither traction control nor ABS'],
]

/** An entry with nothing said about its assists is never filtered out: silence
 *  is missing information, not a claim that the lap was clean. */
function matchesFilter(a: Assists | undefined, f: AssistFilter): boolean {
  if (f === 'all' || !a) return true
  return f === 'clean' ? isClean(a) : !a.abs
}

function assistBadge(label: string, extra: string, title: string): HTMLElement {
  const b = el('span', `assist ${extra}`)
  b.textContent = label
  b.title = title
  return b
}

const DRIVING_KEYS = [
  ['Mouse', 'steer'],
  ['W / S', 'throttle, brake'],
  ['Shift', 'look back'],
] as const

/** A button that shows its own keyboard shortcut, so the keymap need not. */
function actionButton(
  name: IconName, label: string, key: string, extra: string, onClick: () => void,
): HTMLButtonElement {
  const b = el('button', `btn btn-action ${extra}`.trim())
  b.append(icon(name), text(label))
  if (key) {
    const k = el('kbd', '')
    k.textContent = key
    b.append(k)
  }
  b.addEventListener('click', onClick)
  return b
}

/** A session figure: the number, where it came from, and no decorative copy. */
function sessionFact(label: string, value: string, note: string, extra: string): HTMLElement {
  const wrap = el('div', `session-fact ${extra}`.trim())
  const l = el('span', 'session-fact-label')
  l.textContent = label
  const v = el('span', 'session-fact-value')
  v.textContent = value
  const n = el('span', 'session-fact-note')
  n.textContent = note
  wrap.append(l, v, n)
  return wrap
}

/**
 * A compact timing trace. Invalid laps keep their place on the x-axis but do
 * not stretch the time scale or connect two clean laps across a broken one.
 */
function sessionChart(summary: SessionSummary, analysis: SessionAnalysis): HTMLElement {
  const figure = el('figure', 'session-chart')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 640 190')
  svg.setAttribute('role', 'img')
  svg.setAttribute(
    'aria-label',
    `${summary.laps.length} completed laps; ${analysis.validLaps.length} clean. ` +
      (analysis.fastest
        ? `Fastest was lap ${analysis.fastest.number} at ${formatTime(analysis.fastest.time)}.`
        : 'No clean lap.'),
  )

  const W = 640
  const H = 190
  const LEFT = 64
  const RIGHT = 18
  const TOP = 16
  const BOTTOM = 30
  const plotW = W - LEFT - RIGHT
  const plotH = H - TOP - BOTTOM
  const times = analysis.validLaps.map((lap) => lap.time)
  const rawMin = times.length > 0 ? Math.min(...times) : 0
  const rawMax = times.length > 0 ? Math.max(...times) : 1
  // A minimum one-second window keeps a 0.03 s wobble from looking dramatic.
  const span = Math.max(1, rawMax - rawMin)
  const min = rawMin - span * 0.18
  const max = rawMax + span * 0.18
  const x = (number: number): number => summary.laps.length <= 1
    ? LEFT + plotW / 2
    : LEFT + ((number - 1) / (summary.laps.length - 1)) * plotW
  // Conventional timing plot: the smaller number sits lower. Improvement
  // therefore falls toward the bottom of the chart, just as the clock does.
  const y = (time: number): number => TOP + ((max - time) / (max - min)) * plotH

  for (let step = 0; step < 3; step++) {
    const value = min + ((max - min) * step) / 2
    const py = y(value)
    svg.append(
      svgNode('line', {
        x1: LEFT, y1: py, x2: W - RIGHT, y2: py, class: 'session-grid-line',
      }),
    )
    const label = svgNode('text', {
      x: LEFT - 10, y: py + 4, class: 'session-axis-time', 'text-anchor': 'end',
    })
    label.textContent = formatTime(value)
    svg.append(label)
  }

  const baseline = summary.personalBestBefore
  if (baseline !== null && baseline >= min && baseline <= max) {
    const py = y(baseline)
    svg.append(svgNode('line', {
      x1: LEFT, y1: py, x2: W - RIGHT, y2: py, class: 'session-pb-line',
    }))
    const label = svgNode('text', {
      x: W - RIGHT - 4, y: py - 6, class: 'session-pb-label', 'text-anchor': 'end',
    })
    label.textContent = 'PB BEFORE'
    svg.append(label)
  }

  for (let index = 1; index < summary.laps.length; index++) {
    const before = summary.laps[index - 1]!
    const after = summary.laps[index]!
    if (!before.valid || !after.valid) continue
    svg.append(svgNode('line', {
      x1: x(before.number), y1: y(before.time),
      x2: x(after.number), y2: y(after.time),
      class: 'session-lap-line',
    }))
  }

  const labelEvery = Math.max(1, Math.ceil(summary.laps.length / 12))
  for (const lap of summary.laps) {
    const px = x(lap.number)
    if ((lap.number - 1) % labelEvery === 0 || lap.number === summary.laps.length) {
      const label = svgNode('text', {
        x: px, y: H - 8, class: 'session-axis-lap', 'text-anchor': 'middle',
      })
      label.textContent = String(lap.number)
      svg.append(label)
    }

    if (!lap.valid) {
      // Invalid is not a quick time. Keep it on the upper failure rail rather
      // than letting its cross occupy the faster, lower edge of the plot.
      const py = TOP
      const size = 4
      svg.append(
        svgNode('line', {
          x1: px - size, y1: py - size, x2: px + size, y2: py + size,
          class: 'session-invalid-mark',
        }),
        svgNode('line', {
          x1: px + size, y1: py - size, x2: px - size, y2: py + size,
          class: 'session-invalid-mark',
        }),
      )
      continue
    }

    const best = analysis.fastest?.number === lap.number
    const point = svgNode('circle', {
      cx: px, cy: y(lap.time), r: best ? 5 : 3.5,
      class: best ? 'session-lap-point is-best' : 'session-lap-point',
    })
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    title.textContent = `Lap ${lap.number}: ${formatTime(lap.time)}${best ? ', fastest' : ''}`
    point.append(title)
    svg.append(point)
  }

  const caption = el('figcaption', 'session-chart-caption')
  caption.textContent = 'Lap time'
  figure.append(svg, caption)
  return figure
}

function svgNode(name: string, attributes: Record<string, string | number>): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name)
  for (const [attribute, value] of Object.entries(attributes)) {
    node.setAttribute(attribute, String(value))
  }
  return node
}

/** One pause-screen figure: a quiet label over the number that matters. */
function pauseStat(label: string, value: string, extra: string): HTMLElement {
  const wrap = el('div', `pause-stat ${extra}`.trim())
  const l = el('span', 'pause-stat-label')
  l.textContent = label
  const v = el('span', 'pause-stat-value')
  v.textContent = value
  wrap.append(l, v)
  return wrap
}

function chip(label: string): HTMLElement {
  const s = el('span', 'pause-chip')
  s.textContent = label
  return s
}

function sep(): HTMLElement {
  const s = el('span', 'pause-sep')
  s.textContent = '·'
  return s
}

function assistsForLap(lap: LapRecord): Assists {
  return { tc: lap.tc ?? false, abs: lap.recording.abs ?? false }
}

/** Keep the save intent across the Google round trip without duplicating the replay. */
function rememberPendingLeaderboardLap(lap: LapRecord | null): void {
  try {
    if (!lap) {
      window.localStorage.removeItem(PENDING_LEADERBOARD_LAP_KEY)
      return
    }
    window.localStorage.setItem(PENDING_LEADERBOARD_LAP_KEY, JSON.stringify({
      key: keyOf(lap),
      recordedAt: lap.recordedAt,
    }))
  } catch {
    // The in-memory queue still works until the page is reloaded.
  }
}

function restorePendingLeaderboardLap(bests: Map<string, LapRecord>): LapRecord | null {
  try {
    const raw = window.localStorage.getItem(PENDING_LEADERBOARD_LAP_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as { key?: unknown; recordedAt?: unknown }
    if (typeof value.key !== 'string' || typeof value.recordedAt !== 'string') return null
    const lap = bests.get(value.key)
    if (lap?.recordedAt === value.recordedAt) return lap
    window.localStorage.removeItem(PENDING_LEADERBOARD_LAP_KEY)
  } catch {
    // Corrupt or unavailable storage is equivalent to no queued publication.
  }
  return null
}

const text = (s: string): Text => document.createTextNode(s)

/**
 * Does something inside `el` hold the keyboard, as the browser sees it?
 *
 * `:focus-visible` rather than plain focus, and the difference is the whole
 * point: clicking a slider focuses it, so "keep the preview up while the
 * control has focus" meant the lines stayed on screen after a drag, on a
 * control the mouse had already left. The browser is already deciding which
 * focus is worth showing a ring for; this asks it the same question.
 */
function keyboardFocused(el: HTMLElement): boolean {
  const active = document.activeElement
  return active instanceof HTMLElement && el.contains(active) && active.matches(':focus-visible')
}

/** Is a point inside an element's box? Null never contains anything. */
function hits(el: HTMLElement | null, x: number, y: number): boolean {
  if (!el) return false
  const r = el.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

/** Slider thumb width, matching `.range` in the stylesheet — see `tickFor`. */
const THUMB = 16
/** Pixels between the two lines below which the tags stop facing inward. */
const TAG_ROOM = 240

/**
 * The full-lock preview: what sensitivity looks like, drawn on the picture.
 *
 * Two lines either side of centre at the exact place the wheel hits its stop,
 * the straight-ahead deadzone between them, and nothing else. It is
 * `pointer-events: none` throughout: a drawing of the control, never part of
 * it, and never in the way of the mouse it is describing.
 */
interface LockPreview {
  root: HTMLDivElement
  left: HTMLDivElement
  right: HTMLDivElement
  dead: HTMLDivElement
}

function buildLockPreview(): LockPreview {
  const root = el('div', 'lock-preview')
  root.hidden = true
  root.setAttribute('aria-hidden', 'true')

  const dead = el('div', 'lock-dead')
  const centre = el('div', 'lock-centre')

  const bar = (side: string): HTMLDivElement => {
    const b = el('div', `lock-bar lock-bar-${side}`)
    const tag = el('span', 'lock-tag')
    tag.textContent = 'Full lock'
    b.append(tag)
    return b
  }
  const left = bar('l')
  const right = bar('r')

  root.append(dead, centre, left, right)
  return { root, left, right, dead }
}

/**
 * One settings row: what it is on the left, the control on the right, and a
 * reset that appears only once there is something to undo.
 *
 * The reset keeps its space when idle rather than being removed, so touching a
 * control never nudges the row beside it — a settings screen that twitches as
 * you use it feels broken however correct it is.
 */
function setRow(
  label: string, control: HTMLElement, changed: boolean, onReset: () => void,
): HTMLElement {
  const row = el('div', 'set-row')
  const name = el('span', 'set-label')
  name.textContent = label
  const reset = el('button', 'reset-btn')
  reset.classList.toggle('is-idle', !changed)
  reset.append(icon('reset'))
  reset.title = `Reset ${label.toLowerCase()}`
  reset.setAttribute('aria-label', reset.title)
  // Wired whatever the row is worth at build time. `is-idle` hides it with
  // visibility, which already takes it out of the tab order and out of reach of
  // the mouse, and a row whose control updates live rather than rebuilding
  // (sensitivity) flips that class on a button that has to still be listening.
  reset.addEventListener('click', onReset)
  // Label and reset occupy the first grid row; the control spans the row below.
  // Appending the control first made CSS grid auto-place Reset on a third line.
  row.append(name, reset, control)
  return row
}

interface SegOption {
  id: string
  label?: string
  icon?: IconName
  /** Tooltip and screen-reader name — required when there is no visible label. */
  title?: string
  /** Shown as a state, not a choice: it lights up but cannot be picked. */
  inert?: boolean
}

/** A segmented picker: one row of mutually exclusive chips. */
function segmented(
  options: SegOption[], value: string, onChange: (id: string) => void,
): HTMLElement {
  const group = el('div', 'segmented')
  for (const o of options) {
    const b = el('button', 'seg')
    const on = o.id === value
    b.classList.toggle('is-on', on)
    b.classList.toggle('is-inert', !!o.inert)
    if (o.icon) b.append(icon(o.icon))
    if (o.label) b.append(text(o.label))
    const name = o.title ?? o.label ?? o.id
    b.title = name
    b.setAttribute('aria-label', name)
    b.setAttribute('aria-pressed', String(on))
    if (o.inert) {
      // Still readable, still announced — just not a button you can press.
      b.disabled = true
    } else {
      b.addEventListener('click', () => onChange(o.id))
    }
    group.append(b)
  }
  return group
}

/**
 * A segmented picker over a named numeric scale — Low / Medium / High, and Off
 * where the scale has one. The stored value is a number, so the lit segment is
 * whichever level it is nearest: a file from a build with sliders still opens
 * on something sensible instead of nothing.
 */
function levels<K extends string>(
  scale: Record<K, number>, value: number, onChange: (v: number) => void,
): HTMLElement {
  const current = levelOf(value, scale)
  return segmented(
    (Object.keys(scale) as K[]).map((k) => ({ id: k, label: k[0]!.toUpperCase() + k.slice(1) })),
    current,
    (id) => onChange(scale[id as K]),
  )
}

/** A control with a label to its left, laid out like the steppers. */
function labelledRow(label: string, control: HTMLElement): HTMLElement {
  const row = el('div', 'menu-stepper')
  const title = el('span', 'menu-stepper-label')
  title.textContent = label
  row.append(title, control)
  return row
}

/**
 * A number with a minus and a plus, and the value between them.
 *
 * A stepper rather than a slider or a text field: the ranges here are small
 * (one to fifteen laps, one to seven opponents), every value is meaningful, and
 * a stepper is the only one of the three that cannot produce an invalid state
 * to validate afterwards.
 */
function stepper(
  label: string, value: number, lo: number, hi: number, onChange: (v: number) => void,
): HTMLElement {
  const row = el('div', 'menu-stepper')
  const title = el('span', 'menu-stepper-label')
  title.textContent = label
  const minus = el('button', 'menu-stepper-btn')
  minus.type = 'button'
  minus.textContent = '−'
  minus.setAttribute('aria-label', `Decrease ${label.toLowerCase()}`)
  minus.disabled = value <= lo
  const shown = el('span', 'menu-stepper-value')
  shown.textContent = String(value)
  const plus = el('button', 'menu-stepper-btn')
  plus.type = 'button'
  plus.textContent = '+'
  plus.setAttribute('aria-label', `Increase ${label.toLowerCase()}`)
  plus.disabled = value >= hi
  minus.addEventListener('click', () => { onChange(Math.max(lo, value - 1)) })
  plus.addEventListener('click', () => { onChange(Math.min(hi, value + 1)) })
  row.append(title, minus, shown, plus)
  return row
}

function switchToggle(
  label: string, blurb: string, value: boolean, onChange: (v: boolean) => void,
): HTMLElement {
  const wrap = el('label', 'switch')
  wrap.classList.toggle('is-on', value)
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = value
  input.addEventListener('change', () => {
    // The knob's position is driven entirely by this class, and it used to be
    // written only at build time. Toggles whose handler rebuilt the menu
    // (Easy) appeared to work; toggles whose handler did not (Ghost,
    // Authentic) changed state silently and never moved. Own your own state.
    wrap.classList.toggle('is-on', input.checked)
    onChange(input.checked)
  })
  const knob = el('span', 'switch-knob')
  const text = el('span', 'switch-text')
  const t = el('span', 'switch-title')
  t.textContent = label
  const b = el('span', 'switch-blurb')
  b.textContent = blurb
  text.append(t, b)
  wrap.append(input, knob, text)
  return wrap
}
