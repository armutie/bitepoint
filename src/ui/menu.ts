/**
 * Menus: pick a circuit, pick a car, drive. Plus pause and results.
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
import { isClean, type Assists, type LeaderboardClient, type LeaderboardEntry } from '../storage/leaderboard'
import { ASSISTS_ADJUSTABLE } from '../features'
import { formatTime, keyOf, type LapRecord } from '../storage/records'
import { carBars, carTags, powerToWeight } from './carStats'
import { buildTrackMap } from './trackMap'
import { icon, type IconName } from './icons'
import {
  DEFAULT_SETTINGS, EFFECTS, SENSITIVITY, VOLUME, levelOf, type Settings,
} from './settings'
import { CAMERA_LABEL, CAMERA_ORDER } from '../render/cameras'
import { VIEWPORT_LABEL, VIEWPORT_ORDER } from '../game/viewport'

export interface Selection {
  trackId: string
  preset: PresetName
  easy: boolean
  ghost: boolean
  /** null follows the current personal best; an id pins a leaderboard lap. */
  ghostEntryId: string | null
}

/** What the pause screen shows about the session it interrupted. */
export interface PauseStatus {
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
 * The release ships four circuits, chosen for what they ask of a setup: Ashford
 * is the balanced reference lap, Croft Bay is pure stop-and-go, Thruxton Vale is
 * the longest, and Elvington Mile is one 670 m straight — two and a half times
 * anything else here, and the only place the low-drag trim's extra 18 km/h has
 * room to pay for the cornering it gives up. The rest of the calendar stays
 * visible but locked: a menu that shows what is coming reads as a roadmap, one
 * that hides it reads as thin.
 */
export const RELEASED_TRACKS: readonly string[] =
  ['power_8', 'power_4', 'balanced_8', 'power_3']
/** Both setups in `PRESET_ORDER` are drivable; the gate is kept for the next one. */
export const RELEASED_PRESETS: readonly PresetName[] = ['legacy', 'classic']
const CONTROLS_SEEN_KEY = 'car-racing:controls-seen'

export interface MenuDeps {
  tracks: TrackManifestEntry[]
  presets: PresetInfo[]
  /** Personal bests, keyed by `keyOf`, for showing what there is to beat. */
  bests: Map<string, LapRecord>
  leaderboard: LeaderboardClient
}

export class Menu {
  readonly root: HTMLDivElement
  selection: Selection
  settings: Settings

  onStart: (s: Selection) => void = () => {}
  onResume: () => void = () => {}
  onRestart: () => void = () => {}
  onQuit: () => void = () => {}
  onSelectionChange: (s: Selection) => void = () => {}
  onSettingsChange: (s: Settings) => void = () => {}

  private readonly deps: MenuDeps
  private readonly panel: HTMLDivElement
  private mainOpen = false
  private controlsOpen = false
  private settingsOpen = false

  constructor(deps: MenuDeps, initial: Selection, settings: Settings) {
    this.deps = deps
    this.selection = initial
    this.settings = settings
    this.root = el('div', 'menu')
    this.panel = el('div', 'menu-panel')
    this.root.append(this.panel)
    window.addEventListener('keydown', (event) => {
      if (!this.visible || event.key !== '?') return
      if (this.mainOpen || this.controlsOpen) {
        event.preventDefault()
        this.controlsOpen ? this.showMain() : this.showControls()
      }
    })
    this.showMain()
  }

  get visible(): boolean {
    return !this.root.classList.contains('is-hidden')
  }

  hide(): void {
    this.root.classList.add('is-hidden')
  }

  /** Return from a settings/reference screen before Escape reaches gameplay. */
  handleEscape(): boolean {
    if (!this.visible || (!this.controlsOpen && !this.settingsOpen)) return false
    this.showMain()
    return true
  }

  private show(kind: 'full' | 'dialog'): void {
    this.root.classList.remove('is-hidden')
    this.root.classList.toggle('menu-dialog', kind === 'dialog')
    this.root.classList.remove('menu-controls')
    this.mainOpen = false
    this.controlsOpen = false
    this.settingsOpen = false
  }

  private paramsFor(preset: PresetName): CarParams {
    const p = handlingPreset(preset)
    return this.selection.easy ? applyEasyAids(p) : p
  }

  showMain(): void {
    this.show('full')
    this.mainOpen = true
    // Selecting a card or row rebuilds this panel, and replaceChildren drops
    // the scroll position with it — so picking a car you had scrolled down to
    // snapped the list back to the top. Carry it across.
    const priorScroll =
      (this.panel.querySelector('.menu-body') as HTMLElement | null)?.scrollTop ?? 0
    this.panel.replaceChildren()

    const header = el('header', 'menu-header')
    const eyebrow = el('div', 'eyebrow')
    // The game's name on the title screen, with the mode as the eyebrow above
    // it — the panel is the first thing anyone sees, and it was introducing
    // itself by its genre.
    eyebrow.textContent = 'Time attack'
    const title = el('h1', 'menu-title')
    title.textContent = 'Bite Point'
    header.append(eyebrow, title)

    const body = el('div', 'menu-body')
    body.append(this.renderTracks(), this.renderCars())

    const footer = el('footer', 'menu-footer')
    const drive = el('button', 'btn btn-primary btn-drive')
    drive.append(icon('play'), text('Drive'))
    drive.addEventListener('click', () => {
      if (hasSeenControls()) this.startDrive()
      else this.showQuickStart()
    })
    const settingsBtn = el('button', 'btn btn-menu-secondary')
    settingsBtn.append(icon('sliders'), text('Settings'))
    settingsBtn.addEventListener('click', () => this.showSettings())
    const leaderboardBtn = el('button', 'btn btn-menu-secondary')
    leaderboardBtn.append(icon('trophy'), text('Records'))
    leaderboardBtn.addEventListener('click', () => void this.showLeaderboard())
    const controlsBtn = el('button', 'btn btn-menu-secondary btn-controls')
    controlsBtn.append(icon('keyboard'), text('Controls'))
    controlsBtn.addEventListener('click', () => this.showControls())
    const secondaryActions = el('div', 'menu-secondary-actions')
    secondaryActions.append(leaderboardBtn, controlsBtn, settingsBtn)
    const mainActions = el('div', 'menu-footer-actions')
    mainActions.append(secondaryActions, drive)
    footer.append(this.renderSetup(), mainActions)

    this.panel.append(header, body, footer)
    // Reading scrollHeight forces the layout the assignment needs: set before
    // the browser has measured the new content, scrollTop clamps to 0.
    void body.scrollHeight
    body.scrollTop = priorScroll
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
    for (const group of CONTROL_GROUPS) grid.append(controlGroup(group.title, group.rows))

    const actions = el('div', 'menu-actions controls-actions')
    const back = el('button', 'btn btn-primary')
    back.textContent = 'Back'
    back.addEventListener('click', () => this.showMain())
    actions.append(back)
    this.panel.append(header, grid, actions)
  }

  /** One small first-run gate; reading the full reference also dismisses it. */
  private showQuickStart(): void {
    this.show('dialog')
    this.root.classList.add('menu-controls')
    this.panel.replaceChildren()

    const header = el('header', 'menu-header controls-header')
    const eyebrow = el('div', 'eyebrow')
    eyebrow.textContent = 'Before your first lap'
    const title = el('h1', 'menu-title')
    title.textContent = 'Four things to know'
    header.append(eyebrow, title)

    const quick = el('div', 'quick-controls')
    for (const [key, label] of QUICK_CONTROLS) quick.append(controlRow(key, label))

    const actions = el('div', 'menu-actions quick-actions')
    const back = el('button', 'btn')
    back.textContent = 'Back'
    back.addEventListener('click', () => this.showMain())
    const start = el('button', 'btn btn-primary')
    start.textContent = 'Drive'
    start.addEventListener('click', () => {
      markControlsSeen()
      this.startDrive()
    })
    actions.append(back, start)
    this.panel.append(header, quick, actions)
  }

  private startDrive(): void {
    this.hide()
    this.onStart(this.selection)
  }

  /** Board for the exact circuit, car, aids, and physics ruleset selected. */
  async showLeaderboard(): Promise<void> {
    this.show('full')
    this.panel.replaceChildren()

    const track = this.deps.tracks.find((t) => t.id === this.selection.trackId)
    const header = el('header', 'menu-header')
    const eyebrow = el('div', 'eyebrow')
    eyebrow.textContent = 'Your laps'
    const title = el('h1', 'menu-title')
    title.textContent = 'Records'
    const meta = el('div', 'leaderboard-meta')
    // No setup here: every trim shares this board, and each row says its own.
    meta.textContent = [track?.label ?? this.selection.trackId,
      this.selection.easy ? 'Easy' : 'Standard', 'all setups'].join(' · ')
    header.append(eyebrow, title, meta)

    const body = el('div', 'menu-body leaderboard-body')
    const loading = el('div', 'leaderboard-empty')
    loading.textContent = 'Loading laps…'
    body.append(loading)
    this.panel.append(header, body, this.leaderboardFooter())

    const key = { trackId: this.selection.trackId, easy: this.selection.easy }
    try {
      const page = await this.deps.leaderboard.list(key)
      // Do not paint a request that resolved after the user moved to another board.
      if (key.trackId !== this.selection.trackId || key.easy !== this.selection.easy) return
      body.replaceChildren()
      const scope = el('div', 'leaderboard-scope')
      scope.textContent = page.scope === 'global'
        ? 'Online records · select any available replay as your ghost'
        : 'Laps saved on this browser'
      body.append(scope)
      if (ASSISTS_ADJUSTABLE) body.append(this.assistFilterBar())

      // Filtered, then re-ranked. Keeping the outright rank would put "04" at
      // the top of the clean board, which reads as a bug rather than as a
      // position on a different list.
      const shown = page.entries
        .filter((e) => matchesFilter(e.assists, this.assistFilter))
        .map((e, i) => ({ ...e, rank: i + 1 }))

      if (page.entries.length === 0) {
        const empty = el('div', 'leaderboard-empty')
        empty.textContent = 'No laps yet. Set the first one.'
        body.append(empty)
      } else if (shown.length === 0) {
        const empty = el('div', 'leaderboard-empty')
        empty.textContent = this.assistFilter === 'clean'
          ? 'No laps without assists yet.'
          : 'No laps match that filter.'
        body.append(empty)
      } else {
        const list = el('div', 'leaderboard-list')
        for (const entry of shown) list.append(this.leaderboardRow(entry))
        body.append(list)
        if (ASSISTS_ADJUSTABLE) {
          const legend = el('div', 'leaderboard-legend')
          legend.textContent = 'Unmarked laps used no assists.'
          body.append(legend)
        }
      }
    } catch (error) {
      body.replaceChildren()
      const failed = el('div', 'leaderboard-empty is-error')
      failed.textContent = error instanceof Error ? error.message : 'Records unavailable.'
      body.append(failed)
    }
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
      this.selection = { ...this.selection, ghost: true, ghostEntryId: entry.id }
      this.onSelectionChange(this.selection)
      void this.showLeaderboard()
    })
    row.append(rank, driver, marks, time, ghost)
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
    personal.textContent = this.selection.ghostEntryId === null ? 'Following personal best' : 'Use personal best'
    personal.disabled = this.selection.ghostEntryId === null
    personal.addEventListener('click', () => {
      this.selection = { ...this.selection, ghost: true, ghostEntryId: null }
      this.onSelectionChange(this.selection)
      void this.showLeaderboard()
    })
    const back = el('button', 'btn btn-primary')
    back.textContent = 'Back'
    back.addEventListener('click', () => this.showMain())
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
      actionButton('reset', 'Restart lap', 'R', '', () => {
        this.hide()
        this.onRestart()
      }),
      actionButton('menu', 'Menu', '', '', () => this.onQuit()),
    )
    this.panel.append(actions, this.renderHelp(DRIVING_KEYS))
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
    header.append(title)
    if ((Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).some(off)) {
      const all = el('button', 'reset-btn reset-all')
      all.append(icon('reset'), text('Reset all'))
      all.title = 'Put every setting back to default'
      all.addEventListener('click', () => set(DEFAULT_SETTINGS))
      header.append(all)
    }

    const body = el('div', 'menu-body settings-body')

    const driving = el('section', 'menu-section')
    driving.append(sectionTitle('Driving', ''))
    driving.append(
      setRow('Sensitivity', levels(
        SENSITIVITY, s.mouseSensitivity, (v) => set({ mouseSensitivity: v }),
      ), off('mouseSensitivity'), revert('mouseSensitivity')),
    )
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
    back.addEventListener('click', () => this.showMain())
    const acts = el('div', 'settings-actions')
    acts.append(back)
    footer.append(el('div', ''), acts)

    this.panel.append(header, body, footer)
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
        this.showMain()
      })
      list.append(card)
    }

    // The rest of the calendar, locked.
    const teaser = el('div', 'card is-locked')
    const name = el('div', 'card-title')
    name.textContent = 'More circuits'
    const blurb = el('div', 'card-blurb')
    blurb.textContent = 'Additional layouts are in development.'
    const tag = el('div', 'card-pb is-empty')
    tag.textContent = 'Coming soon'
    teaser.append(name, blurb, tag)
    list.append(teaser)

    section.append(list)
    return section
  }

  private renderCars(): HTMLElement {
    const section = el('section', 'menu-section')
    section.append(sectionTitle('Car', `${this.deps.presets.length}`))
    const list = el('div', 'menu-list')

    for (const info of this.deps.presets) {
      const locked = !RELEASED_PRESETS.includes(info.name)
      const row = el('button', 'row')
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
          this.showMain()
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
        this.showMain()
      }),
    )
    return wrap
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
      ['Mouse / A D / ← →', 'Steer'],
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

const text = (s: string): Text => document.createTextNode(s)

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
  if (changed) reset.addEventListener('click', onReset)
  else reset.tabIndex = -1
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
