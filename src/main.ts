/**
 * Wiring: menus, input, simulation, renderer.
 *
 * The shape to notice is that the simulation never learns anything about the
 * display. It advances in fixed DT slices driven by the loop, and rendering
 * reads its state afterwards. Everything that makes a lap reproducible depends
 * on keeping that direction of dependency.
 */
import './styles.css'

import { useLegacyTyreModel, type CarState } from './core/car'
import {
  applyEasyAids, handlingPreset, presetLabel, PRESET_INFO, PRESET_ORDER,
  TC_LEVEL_MAX, type PresetName,
} from './core/carParams'
import {
  ASSISTS_ADJUSTABLE, LEGACY_TYRE_MODE, SHOW_FPS_OVERLAY, SHOW_RACING_LINE,
  SHOW_REFERENCE_DRIVER,
} from './features'
import { buildFpsOverlay } from './dev/fpsOverlay'

/**
 * Per-tick decay of the TC lamp once intervention stops — about 180 ms to fade.
 *
 * Slow enough that a lamp being hammered by a bumpy exit reads as one steady
 * light rather than a strobe, fast enough that it is dark again before the next
 * corner and never claims TC is working when it has let go.
 */
const TC_LAMP_DECAY = 0.9
import { wrapAngle } from './core/math'
import {
  DT, lapUsedTc, LapReplay, OFF_TRACK_MARGIN, TimeAttackSim, type CompletedLap,
} from './core/sim'
import { loadManifest, loadTrack, type Track, type TrackManifestEntry } from './core/track'
import { bakedToLine, loadBakedLine } from './core/bakedLines'
import { beginQualifyingLap, eventKey, QualifyingIntro, qualifyOpponents, qualifyingGrid, RaceEvent } from './core/qualifying'
import type { RacingLine } from './core/racingLine'
import { LineFollower, referenceLapDetail } from './core/referenceDriver'
import {
  difficultyByName, MAX_OPPONENTS, MAX_RACE_LAPS, RaceSession,
} from './core/raceSession'
import { GameLoop } from './game/loop'
import { InputState } from './game/input'
import { applyViewport, nextViewport, VIEWPORT_LABEL, type ViewportMode } from './game/viewport'
import { Sound } from './audio/sound'
import { attractLineFromPath, bakeAttractLine, type AttractLine } from './render/attractLine'
import { GhostPath } from './render/ghostPath'
import { CAMERA_LABEL } from './render/cameras'
import { Renderer } from './render/renderer'
import { fieldLivery, liveryCss, PLAYER_LIVERY } from './render/liveries'
import { Hud, type HudRaceState } from './ui/hud'
import { RaceFinish } from './ui/raceFinish'
import { proximityMarkers, type ProximityRival } from './ui/proximity'
import {
  Menu, RELEASED_PRESETS, RELEASED_TRACKS, type PauseStatus, type Selection,
} from './ui/menu'
import type { SessionLap, SessionSummary } from './ui/sessionSummary'
import { cameraFeel, fullLockFraction, loadSettings, saveSettings, type Settings } from './ui/settings'
import { createLeaderboardServices, sameBoard } from './storage/leaderboard'
import { keyOf, LocalRecordStore, NamespacedStorage, type LapRecord } from './storage/records'
import { decodePath, loadAttractLaps, pinnedAttractLaps } from './data/attractLaps'

const SELECTION_KEY = 'car-racing:selection'

async function boot(): Promise<void> {
  const app = document.getElementById('app')
  if (!app) throw new Error('#app missing')

  if (LEGACY_TYRE_MODE) {
    document.title = 'Bite Point — Legacy tyres'
    useLegacyTyreModel()
  }

  // Canvas and HUD live inside a stage so both can be boxed to a smaller size
  // together — a HUD pinned to the window would otherwise float out over the
  // letterbox bars.
  const stage = document.createElement('div')
  stage.className = 'stage'
  if (LEGACY_TYRE_MODE) stage.dataset.legacyTyres = 'true'
  const canvas = document.createElement('canvas')
  canvas.className = 'viewport'
  stage.append(canvas)
  app.append(stage)

  const manifest = await loadManifest()
  if (manifest.length === 0) throw new Error('no circuits in the manifest')

  const recordStorage = LEGACY_TYRE_MODE
    ? new NamespacedStorage(window.localStorage, 'car-racing:legacy-tyres:')
    : window.localStorage
  const store = new LocalRecordStore(recordStorage)
  const { leaderboard, profiles } = createLeaderboardServices(store)
  await profiles?.ready()

  /**
   * Hand a recorded lap out as a file, from the console.
   *
   * A development hook rather than a button, because the thing it is for is
   * comparing a human lap against the generated one — which is analysis, not
   * play. A lap carries its own path and its (distance, time) trace, and those
   * two are what make the comparison possible at all: without the path you can
   * only compare lap times, and a lap time cannot tell you whether the line was
   * wrong or the driving was.
   *
   *     await exportLap()                       the current selection's best
   *     await exportLap('power_8', 'legacy')    a specific one
   */
  ;(window as unknown as Record<string, unknown>)['exportLap'] = async (
    trackId?: string, preset?: string, easy?: boolean,
  ): Promise<string> => {
    const key = {
      trackId: trackId ?? current.trackId,
      preset: (preset ?? current.preset) as PresetName,
      easy: easy ?? current.easy,
    }
    const record = await store.best(key)
    if (!record) return `no lap stored for ${key.trackId} / ${key.preset} (easy: ${key.easy})`
    const blob = new Blob([JSON.stringify(record)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `lap-${key.trackId}-${key.preset}${key.easy ? '-easy' : ''}-` +
      `${record.time.toFixed(3)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    return `exported ${record.time.toFixed(3)} s` +
      `${record.path ? '' : ' (WARNING: no path recorded, comparison will be limited)'}`
  }
  const renderer = new Renderer(canvas)
  const sound = new Sound()
  const hud = new Hud()
  const finish = new RaceFinish()
  const input = new InputState()
  input.attach(canvas)

  const selection = restoreSelection(manifest)
  let settings = loadSettings()
  const bests = await loadBests(store)

  const menu = new Menu(
    {
      tracks: manifest,
      presets: PRESET_ORDER.map((p) => PRESET_INFO[p]),
      bests,
      leaderboard,
      profiles,
      // The canvas, not the stage: mouse steering is measured against the
      // picture, and the sensitivity preview has to draw in the same frame.
      picture: canvas,
    },
    selection,
    settings,
  )
  stage.append(hud.root)
  app.append(menu.root)
  app.append(finish.root)
  hud.root.classList.add('is-hidden')

  let viewport: ViewportMode = settings.viewport
  const setViewport = (mode: ViewportMode): void => {
    viewport = mode
    applyViewport(stage, mode)
    renderer.resize()
    // The steering centre is relative to the picture, so it moves with it.
    input.refreshBounds()
  }

  /** Push every preference into the layer that owns it. Applied live, so the
   *  settings screen shows its own effect on the circuit behind it. */
  function applySettings(s: Settings): void {
    settings = s
    saveSettings(s)
    input.mode = s.inputMode
    input.fullLockFraction = fullLockFraction(s.mouseSensitivity)
    // Speed FOV and kerb shake are no longer settings of their own; they ride
    // on the effects level, because all three are the same question.
    renderer.applySettings({
      effects: s.effects,
      performanceMode: s.performanceMode,
      ...cameraFeel(s.effects),
    })
    sound.setLevel(s.volume, s.volume <= 0)
    renderer.setCameraMode(s.camera)
    if (s.viewport !== viewport) setViewport(s.viewport)
  }
  setViewport(viewport)
  applySettings(settings)

  // --- live game state -----------------------------------------------------
  let track: Track | null = null
  let sim: TimeAttackSim | null = null
  let watcher: LineFollower | null = null
  /**
   * The ghost, drawn from recorded positions when the lap has them.
   *
   * `GhostPath` and `LapReplay` are interchangeable here on purpose. A path is
   * the lap that was driven and cannot go wrong; replaying inputs is a
   * simulation that only holds while the car is the one the lap was set on. New
   * laps get a path, laps recorded before paths existed fall back to the
   * replay — and drive into barriers when the car has moved on, which is the
   * honest picture of a lap this car can no longer reproduce.
   */
  let ghost: { car: { s: CarState }; finished: boolean; step: () => void } | null = null
  let ghostRecord: LapRecord | null = null
  let current: Selection = selection
  let prevState: CarState | null = null
  let opponentPrev: CarState[] = []
  /** The ghost's state before its last fixed step — it interpolates for the
   *  display exactly as the player does, or it staircases at 60 Hz on any
   *  faster screen while the player glides. */
  let ghostPrev: CarState | null = null
  let lastThrottle = 0
  let lastSteer = 0
  let running = false
  let weekend: RaceEvent | null = null
  let qualifying: { event: RaceEvent; aiTimes: (number | null)[]; intro: QualifyingIntro | null } | null = null
  let finishState: 'none' | 'flag' | 'results' = 'none'
  let flagTicks = 0
  /** Completed laps in this visit to the circuit, including invalid ones. */
  let sessionLaps: SessionLap[] = []
  /** Frozen at session start so a PB observation compares against the past. */
  let sessionPersonalBestBefore: number | null = null
  /**
   * A session exists and is stopped, as opposed to there being no session.
   *
   * `running` alone cannot tell those apart, and the flyover was keyed off it,
   * so pausing threw away the scene you were driving and replaced it with the
   * menu's attract circuit. A pause should hold the picture still, not cut away
   * from it — the background field belongs to the main menu alone.
   */
  let paused = false
  /**
   * Easy's rotary position — being FELT rather than settled.
   *
   * Position 1 is the weakest setting the dial has: a 0.30 slip ceiling against
   * a tyre that peaks at 0.16, so it only catches a wheel that is already well
   * past the point of making drive. Measured, it changes almost nothing in easy
   * mode — corner exits are identical to position 4 at 0.11 slip and 1.6 degrees
   * of body slip, because the 1.45 rear grip bias means the ceiling is rarely
   * reached at all. The one place it shows is a standing start, which spins to
   * 0.30 against 0.14 and arrives 1 km/h slower.
   *
   * `TC_LEVEL_DEFAULT` (4) is the other candidate and is what this was.
   */
  const EASY_TC_LEVEL = 1
  /**
   * The race in progress, or null in a time trial.
   *
   * `sim` still points at the PLAYER's sim either way, which is what makes this
   * a small change: the HUD, the camera, the recording, the lap timing and the
   * leaderboard all read `sim` and none of them need to know whether five other
   * cars happen to be sharing the circuit.
   */
  let race: RaceSession | null = null
  /** Whose fastest lap the banner has already announced, so it fires once. */
  let shownFastestLap = 0
  /**
   * Traction-control position, which the difficulty now decides.
   *
   * Easy gets the aid, Standard gets none — the same split ABS already has, so
   * "Easy" means every aid on and "Standard" means you do it yourself, rather
   * than the previous state of affairs, in which the two ran IDENTICAL traction
   * control and only ABS and the grip bias told them apart. `tc: true` on the
   * sim keeps the rotary in force at all times, so a preset's own
   * `tractionControl` never gets a say and this is the only place it can be
   * turned off.
   *
   * Standard with no traction control is only a driveable proposition because
   * engine rpm now follows the driven wheel: wheelspin used to run away to a
   * slip ratio of eighty-four because a spinning wheel never revved the engine
   * out, and the aid was the only thing hiding it.
   */
  const tcFor = (easy: boolean): number =>
    ASSISTS_ADJUSTABLE ? settings.tcLevel : easy ? EASY_TC_LEVEL : 0
  let tcLevel = tcFor(selection.easy)
  /** Smoothed TC intervention for the lamp — see TC_LAMP_DECAY. */
  let tcBite = 0
  /** Smoothed ABS intervention for the badge. */
  let absBite = 0
  let attractTime = 0
  /** Selection + record stamp the attract line was last baked for. */
  let attractLineKey = ''

  let paramsKey = ''
  let paramsValue: ReturnType<typeof handlingPreset> | null = null
  const params = (s: Selection) => {
    const key = `${s.preset}|${s.easy ? 1 : 0}`
    if (paramsValue && paramsKey === key) return paramsValue
    const p = handlingPreset(s.preset)
    paramsKey = key
    paramsValue = s.easy ? applyEasyAids(p) : p
    return paramsValue
  }

  /**
   * SINGLE-FLIGHT track loading, shared by the menu preview and by Drive.
   *
   * The old shape had each caller fetch-and-build independently, and the
   * worst real-user path — click a circuit card, then Drive before the ~1 s
   * preview build lands — ran the full terrain+scenery build TWICE, back to
   * back, on the main thread: 3.9 s of frozen UI, measured. Now there is one
   * job per track id; whoever asks first starts it, whoever asks second
   * awaits the same promise, and a job superseded by a different selection
   * quietly declines to apply itself.
   */
  let trackJob: { id: string; promise: Promise<Track> } | null = null
  let lastBuildMs = 0
  let buildCount = 0
  function ensureTrack(trackId: string): Promise<Track> {
    if (track && track.id === trackId) return Promise.resolve(track)
    if (trackJob && trackJob.id === trackId) return trackJob.promise
    const job = {
      id: trackId,
      promise: loadTrack(trackId).then((loaded) => {
        // Only the job that is still current gets to touch the scene.
        if (trackJob === job) {
          const t0 = performance.now()
          track = loaded
          renderer.setTrack(loaded)
          hud.setTrack(loaded)
          lastBuildMs = performance.now() - t0
          buildCount++
          trackJob = null
        }
        return loaded
      }),
    }
    trackJob = job
    return job.promise
  }

  function preview(trackId: string): void {
    void ensureTrack(trackId).then(() => refreshAttractLine())
  }

  /**
   * Give the menu's field the player's own laps to drive.
   *
   * Your best plus the bests it beat, so the cars behind the menu are not ten
   * copies of one lap: they are your progress, lapping together, with the
   * quick ones visibly catching the old ones.
   *
   * Keyed to the current selection, because a racing line belongs to the lap it
   * was set on: the line round Ashford in the F1 car is not the line round
   * Croft Bay, nor the one the Go-Kart takes. Nothing recorded for this
   * combination means no lines, and the field falls back to its followers.
   */
  function refreshAttractLine(): void {
    const sel = menu.selection
    if (!track || track.id !== sel.trackId) return
    const rk = { trackId: sel.trackId, preset: sel.preset, easy: sel.easy }
    const key = keyOf(rk)
    const best = bests.get(key)
    // Baking replays a whole lap — some 3000 ticks of physics each. That is
    // fine once, and not fine on every click in a menu where selecting a car
    // you already had selected is a normal thing to do. `recordedAt` is in the
    // stamp so beating your own time still rebakes.
    const stamp = `${key}|${best?.recordedAt ?? ''}`
    if (stamp === attractLineKey) return
    attractLineKey = stamp

    const laps = best ? [best] : []
    void Promise.all([loadAttractLaps(), store.past(rk)]).then(([allPinned, older]) => {
      // The selection can change while this resolves; the stamp says whether
      // these laps are still the ones being asked for.
      if (attractLineKey !== stamp || !track) return
      const p = params(sel)

      // Pinned laps win outright when there are any. The menu background is set
      // dressing, not a scoreboard: it should not change because you went
      // faster, and it should be the same for everyone who opens the game.
      //
      // They are played back, never simulated — a pinned lap is a path, so no
      // change to the car can send the field into the barriers. Personal bests
      // are still baked from their inputs, which is why they still can.
      const pinned = pinnedAttractLaps(allPinned, sel.trackId, sel.preset, sel.easy)
      const lines = (pinned.length > 0
        ? pinned.map((l) => attractLineFromPath(decodePath(l.path), DT))
        : [...laps, ...older].map((r) => bakeAttractLine(track!, p, r.recording))
      ).filter((l): l is AttractLine => l !== null)
      renderer.setAttractLines(lines)
    })
  }

  function eventFor(sel: Selection): RaceEvent {
    if (!weekend || weekend.key !== eventKey(sel)) {
      weekend = new RaceEvent(sel, crypto.getRandomValues(new Uint32Array(1))[0]!)
    }
    menu.raceEvent = weekend
    return weekend
  }

  async function start(sel: Selection, oneShot = false): Promise<void> {
    const event = sel.mode === 'race' ? eventFor(sel) : null
    if (event && !oneShot && !event.qualifying) {
      menu.showRaceEvent()
      return
    }
    qualifying = null
    if (finishState === 'results') paused = true
    finishState = 'none'
    finish.hide()
    current = sel
    persistSelection(sel)
    sessionLaps = []
    sessionPersonalBestBefore = null

    // Drive is authoritative. Normally the job already applied the scene; but
    // if a later preview superseded this job mid-flight, the scene could hold
    // a DIFFERENT circuit — and simulating one track while rendering another
    // is the worst bug this function could have. Force-apply on mismatch.
    const loaded = await ensureTrack(sel.trackId)
    if (!track || track.id !== sel.trackId) {
      const t0 = performance.now()
      track = loaded
      renderer.setTrack(loaded)
      hud.setTrack(loaded)
      lastBuildMs = performance.now() - t0
      buildCount++
    }

    const p = params(sel)
    const simOpts = {
      manual: false,
      // Always on, not "on when TC is on". The rotary can be turned mid-lap, so
      // the channel has to exist from the first tick or a lap that started at
      // TC off and ended at TC 4 would have no room to say so.
      tc: true,
      // A pre-lap choice, so it is read once here and stamped on the recording
      // rather than sampled per tick like the rotary.
      abs: ASSISTS_ADJUSTABLE && settings.abs,
    }

    // Qualifying and the race share the baked reference. If it is unavailable,
    // return to event setup rather than launching a different session type.
    race = null
    shownFastestLap = 0
    /** The line the field follows, for `?line`. Drawn after the reset below. */
    let raceLine: { x: number; y: number }[] | null = null
    let qualifyingShape: RacingLine | null = null
    renderer.setOpponents(p, 0)
    renderer.setOpponentStates([])
    opponentPrev = []
    if (sel.mode === 'race' && sel.opponents > 0) {
      const baked = await loadBakedLine(sel.trackId, sel.preset)
      const shape = baked ? bakedToLine(baked, loaded, p, 1.0) : null
      if (shape) {
        if (oneShot && event) {
          const aiTimes = await qualifyOpponents(loaded, p, shape, sel, event.seed, afterPresent)
          qualifying = { event, aiTimes, intro: null }
          qualifyingShape = shape
        } else {
          if (event) event.completed = false
          race = new RaceSession({
            playerLaunch: true,
            seed: event?.seed ?? crypto.getRandomValues(new Uint32Array(1))[0]!,
            ...(event?.qualifying ? { gridOrder: event.qualifying.gridOrder } : {}),
            track: loaded,
            trackId: sel.trackId,
            params: p,
            preset: sel.preset,
            shape,
            laps: sel.laps,
            opponents: Math.min(sel.opponents, MAX_OPPONENTS),
            difficulty: difficultyByName(sel.difficulty),
            easy: sel.easy,
            sim: simOpts,
          })
          renderer.setOpponents(p, race.size - 1, Array.from({ length: race.size }, (_, slot) => slot)
            .filter((slot) => slot !== race!.playerSlot).map((slot) => race!.driverIdOf(slot)))
          // The reset below clears the previous session's line.
          if (SHOW_RACING_LINE) {
            raceLine = Array.from(shape.x, (lx, i) => ({ x: lx, y: shape.y[i]! }))
          }
          race.begin()
        }
      } else {
        console.warn(
          `[race] no baked racing line for ${sel.trackId}/${sel.preset}` +
          ' — the race event cannot start.',
        )
        menu.showRaceEvent()
        return
      }
    }

    sim = race
      ? race.playerSim
      : new TimeAttackSim(loaded, p, sel.trackId, sel.preset, sel.easy, simOpts)
    if (qualifyingShape && qualifying) {
      beginQualifyingLap(sim, qualifyingShape)
      qualifying.intro = new QualifyingIntro(sim, qualifyingShape)
    }
    tcLevel = tcFor(sel.easy)
    tcBite = 0
    absBite = 0

    watcher = null
    renderer.setDebugLine(null)
    // `?line`: draw the line the field is following, so it is visible from the
    // cockpit whether a car is genuinely moving off it to make room — which a
    // bench can assert and only this can show.
    if (raceLine) renderer.setDebugLine(raceLine)
    if (SHOW_REFERENCE_DRIVER) {
      // Baked if there is one. Watching used to block the main thread for the
      // best part of a minute here, because it searched for the racing line
      // from scratch every single time the button was pressed — and the answer
      // is the same answer every time, which is exactly why it is baked.
      const bakedRef = await loadBakedLine(sel.trackId, sel.preset)
      const refShape = bakedRef ? bakedToLine(bakedRef, loaded, p, 1.0) : null
      const detail = referenceLapDetail(loaded, p, sel.trackId, refShape ?? undefined)
      watcher = new LineFollower(p, detail.line)
      renderer.setDebugLine(
        Array.from(detail.line.x, (lx, i) => ({ x: lx, y: detail.line.y[i]! })),
      )
      console.info(
        `[reference] ${sel.trackId} / ${sel.preset}: ` +
        `${detail.time === null ? 'no clean lap' : `${detail.time.toFixed(3)} s`}` +
        ` at commitment ${detail.commitment.toFixed(3)}`,
      )
    }
    prevState = { ...sim.car.s }

    const boardKey = { trackId: sel.trackId, preset: sel.preset, easy: sel.easy }
    const personalBest = await store.best(boardKey)
    sessionPersonalBestBefore = personalBest?.time ?? null
    ghostRecord = personalBest
    if (sel.mode === 'time' && sel.ghostEntryId) {
      try {
        const selected = await leaderboard.ghost(sel.ghostEntryId)
        if (!sameBoard(selected, boardKey)) throw new Error('Ghost belongs to another leaderboard.')
        ghostRecord = selected
      } catch (error) {
        console.warn('[leaderboard] selected ghost unavailable; using personal best', error)
        current = { ...current, ghostEntryId: null }
        menu.selection = current
        persistSelection(current)
      }
    }

    // No guard here, deliberately. A ghost that drives into a wall is showing
    // you something true — that this recording no longer reproduces its lap
    // under the current car — and hiding it just turns a visible problem into a
    // ghost that quietly is not there. The fix for a crashing ghost is to stop
    // replaying inputs for the picture, not to suppress the picture.
    // A RACE IS ITS OWN EVENT, and is not seeded from a personal best.
    //
    // Seeding it would colour every split against a lap set alone on an empty
    // circuit, which says nothing about the race you are in — on the first lap
    // it paints the whole board yellow before you have had a chance to do
    // anything. Left empty, the sim's own bookkeeping becomes race-local for
    // free: your first lap sets your reference, and every split after it is
    // measured against how you have actually gone today.
    if (personalBest && sel.mode === 'time') {
      sim.bestLapTime = personalBest.time
      sim.bestSectors = personalBest.sectors
      // The purple reference: fastest-ever sectors, falling back to the best
      // lap's splits for records saved before the field existed.
      sim.fastestSectors = (personalBest.fastestSectors ?? personalBest.sectors).slice()
    }
    // Delta follows the chosen opponent; with no pinned board entry that is PB.
    sim.referenceTrace = sel.mode === 'time' ? ghostRecord?.trace ?? null : null
    // The ghost model is built even with no lap to replay yet. It costs a car's
    // worth of geometry on a screen that is already building the session — and
    // it means the first personal best of a fresh profile does not construct
    // and upload a whole car in the middle of the lap that follows it. It
    // stays invisible until a replay actually runs.
    renderer.setCars(p, true)
    renderer.ghostVisible = sel.mode === 'time' && sel.ghost
    ghost = null

    input.release()
    hud.root.classList.remove('is-hidden')
    // Drive is the user gesture the browser wants before it will let an
    // AudioContext make a sound. Built here rather than at boot, so a player
    // who never presses it never has one.
    if (settings.volume > 0) sound.start()
    running = true
    paused = false
  }

  /** What the pause screen reports, or null before a car is on a circuit. */
  function pauseStatus(): PauseStatus | null {
    if (!sim) return null
    return {
      race: race !== null,
      qualifying: qualifying !== null,
      trackLabel: manifest.find((t) => t.id === current.trackId)?.label ?? current.trackId,
      carLabel: presetLabel(current.preset),
      easy: current.easy,
      currentLap: sim.currentLapTime,
      bestLap: sim.bestLapTime,
      lapValid: race !== null || sim.lapValid,
      timingArmed: sim.timingArmed,
      validLaps: sim.validLaps,
    }
  }

  function restartLap(): void {
    if (qualifying) {
      completeQualifying(null)
      return
    }
    if (!sim) return
    // A race restarts as a RACE. Resetting only the player's sim would put them
    // back on the grid while the field carried on round, which is not a restart
    // of anything — it is a penalty. Rebuilding the session puts everyone back
    // on the grid and re-runs the lights.
    if (race) {
      void start(current)
      return
    }
    sim.reset()
    prevState = { ...sim.car.s }
    ghost = null
    ghostPrev = null
    input.release()
    hud.resetLap()
  }

  function quitToMenu(): void {
    if (qualifying) {
      completeQualifying(null)
      return
    }
    finishState = 'none'
    finish.hide()
    running = false
    // Leaving the session, not stopping it: the menu gets its flyover back.
    paused = false
    // Put the field away. Eight cars is a few thousand parts, and the menu's
    // own attract field is about to be drawn over the top of them.
    race = null
    renderer.setOpponentStates([])
    renderer.setOpponents(params(current), 0)
    hud.root.classList.add('is-hidden')
    // Beat your best and the field behind the menu starts driving the new lap.
    // Rebaking here rather than at the moment the record lands keeps a full
    // replay's worth of physics off the frame you crossed the line on.
    refreshAttractLine()
    menu.showMain()
  }

  function completeQualifying(lap: CompletedLap | null): void {
    if (!qualifying) return
    const attempt = qualifying
    qualifying = null
    attempt.event.qualifying = qualifyingGrid(attempt.aiTimes, lap?.valid ? lap.time : null)
    quitToMenu()
    sound.idle()
    input.release()
    menu.showRaceEvent()
  }

  /**
   * Everything the HUD needs to describe a race, gathered once a frame.
   *
   * Built here rather than inside the HUD because it needs the LIVERIES, and
   * the mapping from a grid slot to the colour that car is painted lives with
   * whoever built the field — the HUD only needs to be told the answer.
   */
  function raceHudState(r: RaceSession): HudRaceState {
    const order = r.race.standings()
    const leader = order[0]
    // Grid slot to the index of its livery: opponents are every slot but the
    // player's, in ascending order, which is exactly how `setOpponents` built
    // the models. Getting this wrong paints the board in colours that do not
    // match the cars, which is worse than having no colours at all.
    const liveryIndex = (slot: number): number => r.driverIdOf(slot)
    return {
      position: r.playerPosition(),
      size: r.size,
      lap: r.playerSim.lapsCompleted + 1,
      laps: r.laps,
      gapAhead: r.intervalAhead(),
      gapBehind: r.intervalBehind(),
      countdown: r.race.countdownTicks / 60,
      lights: r.race.lightCount,
      starting: r.race.phase === 'waiting' || r.race.phase === 'countdown' || !!r.launch && r.launch.state !== 'launched',
      launchHint: r.race.phase === 'waiting' && r.launch
        ? 'HOLD R TO START THE LIGHTS'
        : r.launch?.state === 'ready' && r.race.running
        ? 'LIGHTS OUT · RELEASE R · KEEP W HELD' : r.launch?.message ?? '',
      finished: r.playerFinished,
      lastVsBest: r.lastLapDelta,
      // Purple is the race's, not the player's: their split against the
      // fastest anybody has managed through that sector today.
      purpleSectors: r.playerSim.currentSectors.map(
        (split, i) => split !== null && r.isRaceFastestSector(i, split),
      ),
      purpleLastSectors: r.playerSim.lastSectors.map(
        (split, i) => split !== null && r.isRaceFastestSector(i, split),
      ),
      standings: order.map((slot, i) => ({
        position: i + 1,
        isPlayer: slot === r.playerSlot,
        // Named by the grid slot they started in, which never changes.
        name: slot === r.playerSlot ? 'You' : `Car ${liveryIndex(slot) + 1}`,
        interval: i === 0 ? null : r.gapSeconds(order[i - 1]!, slot),
        intervalMetres: i === 0
          ? 0
          : r.race.gapToLeader(slot) - r.race.gapToLeader(order[i - 1]!),
        laps: r.race.sims[slot]!.lapsCompleted,
        finished: r.race.finishedAt(slot) !== null,
        colour: slot === r.playerSlot
          ? liveryCss(PLAYER_LIVERY)
          : liveryCss(fieldLivery(liveryIndex(slot))),
      })),
      mapDots: r.race.sims
        .map((s, slot) => ({ s, slot }))
        .filter(({ slot }) => slot !== r.playerSlot)
        .map(({ s, slot }) => ({
          x: s.car.s.x,
          y: s.car.s.y,
          leader: slot === leader,
        })),
    }
  }

  function showRaceResults(r: RaceSession): void {
    const liveryIndex = (slot: number): number => r.driverIdOf(slot)
    if (weekend) weekend.completed = true
    finish.showResults({
      position: r.race.classification().indexOf(r.playerSlot) + 1,
      field: r.size,
      raceTime: r.race.adjustedFinishTime(r.playerSlot)!,
      penaltySeconds: r.race.trackLimits[r.playerSlot]!.penaltySeconds,
      bestLap: r.playerSim.bestLapTime,
      track: manifest.find((t) => t.id === current.trackId)?.label ?? current.trackId,
      car: presetLabel(current.preset),
      laps: r.laps,
      rows: r.results().map((entry) => ({
        position: entry.position,
        name: entry.isPlayer ? 'You' : `Car ${liveryIndex(entry.slot) + 1}`,
        colour: entry.isPlayer
          ? liveryCss(PLAYER_LIVERY)
          : liveryCss(fieldLivery(liveryIndex(entry.slot))),
        isPlayer: entry.isPlayer,
        finishedAt: entry.finishedAt,
        penaltySeconds: entry.penaltySeconds,
        bestLap: entry.best,
      })),
    })
    finishState = 'results'
    running = false
    input.release()
    hud.root.classList.add('is-hidden')
    sound.idle()
  }

  /** Stop on the frozen circuit long enough to read the run, when there is one. */
  function endSession(): void {
    // A debrief with no clean timing has nothing useful to say. Leave it out
    // rather than turning a quick test or abandoned run into an extra screen.
    if (!sessionLaps.some((lap) => lap.valid)) {
      quitToMenu()
      return
    }
    running = false
    paused = true
    input.release()
    const summary: SessionSummary = {
      trackLabel: manifest.find((t) => t.id === current.trackId)?.label ?? current.trackId,
      carLabel: presetLabel(current.preset),
      easy: current.easy,
      personalBestBefore: sessionPersonalBestBefore,
      laps: sessionLaps.map((lap) => ({ ...lap, sectors: lap.sectors.slice() })),
    }
    menu.showSessionSummary(summary)
  }

  async function onLapCompleted(lap: CompletedLap): Promise<void> {
    if (!sim) return
    if (qualifying) {
      completeQualifying(lap)
      return
    }
    if (current.mode === 'time') {
      sessionLaps.push({
        number: sessionLaps.length + 1,
        time: lap.time,
        valid: lap.valid,
        sectors: lap.sectors.slice(),
      })
    }
    let isBest = false
    // A RACE LAP IS NOT A TIME-ATTACK LAP, and must not be filed as one.
    //
    // It was driven on a circuit with five other cars on it — held up, towed
    // along in a slipstream, or run wide avoiding somebody. Whichever it was,
    // it is not a comparable measurement of a car on a circuit, which is the
    // one thing a leaderboard is for. Letting these through would quietly
    // corrupt every board with laps that nobody could reproduce alone, and the
    // menu promises they will not.
    //
    // The banner still fires: your lap time is still worth seeing, it just does
    // not go on the wall.
    if (lap.valid && current.mode === 'time') {
      const record: LapRecord = {
        trackId: current.trackId,
        preset: current.preset,
        easy: current.easy,
        // Read back out of the trace that was just recorded, not from the
        // rotary's position now. The knob can be turned mid-lap, and the lap
        // belongs to whatever it actually did, not to where it finished.
        tc: lapUsedTc(lap.recording),
        time: lap.time,
        sectors: lap.sectors,
        // The sim's fastest-ever set is cumulative: it was seeded from the
        // stored record and updated live, so saving it never loses a purple.
        fastestSectors: sim.fastestSectors.slice(),
        trace: lap.trace,
        path: lap.path,
        // Stamped here rather than inside the sim: the sim must not read a
        // clock, or a replay would not be a replay.
        recordedAt: new Date().toISOString(),
        recording: lap.recording,
      }

      // Persistence yields to the event loop. Promote an outright PB before
      // that yield so its ghost starts on the timing tick that already opened
      // the next lap, even when the driver never pauses or visits the menu.
      const becomesLiveBest =
        current.ghostEntryId === null && (!ghostRecord || record.time < ghostRecord.time)
      if (becomesLiveBest) {
        ghostRecord = record
        sim.referenceTrace = lap.trace
        ghost = new GhostPath(lap.path)
        ghostPrev = { ...ghost.car.s }
        renderer.ensureGhost(params(current))
        renderer.ghostVisible = race === null && current.ghost
      }

      // And the yield is a real one: past the frame, into browser idle time.
      // Saving a lap serializes a few hundred KB and localStorage writes are
      // synchronous, which measured ~30 ms in one tick — run it on the line
      // crossing and the reward for a personal best was two dropped frames at
      // the exact moment the next lap starts. The next lap is already running,
      // so the result banner landing a frame or two later costs nothing.
      await afterPresent()

      isBest = await store.submit(record)
      // Remote acceptance is deliberately off the driving path. The API
      // replays and derives the time; a slow or unavailable board must never
      // stall the next lap, which has already begun.
      void leaderboard.submit(record, 'Driver').catch((error: unknown) => {
        console.warn('[leaderboard] lap submission failed', error)
      })
      if (isBest) {
        // `isBest` now means best IN ITS ASSIST SLOT, so a clean lap can be
        // saved while being slower than the assisted lap the menu is showing.
        // Only overwrite the card's time when it is genuinely the fastest.
        const shown = bests.get(keyOf(record))
        if (!shown || record.time < shown.time) bests.set(keyOf(record), record)
      }
    }
    // The flow NEVER stops: the next lap is already running (the sim rolled
    // straight into it at the line). The result is a banner that fades.
    // In a race the banner fires for the FASTEST LAP of the race rather than a
    // personal best — a race sets no personal best, and beating the field is
    // the achievement the moment actually contains. Guarded so it announces a
    // given lap once, not on every frame that lap is still the quickest.
    if (race) {
      const fastest = race.fastestLap
      const mine = fastest !== null && fastest.slot === race.playerSlot
      if (mine && fastest.time !== shownFastestLap) {
        shownFastestLap = fastest.time
        hud.flashLap(lap.time, true, true, 'fastest')
      } else {
        hud.flashLap(lap.time, true, false)
      }
      return
    }
    hud.flashLap(lap.time, lap.valid, isBest)
  }

  // --- loop ----------------------------------------------------------------
  const fpsProbe = SHOW_FPS_OVERLAY ? buildFpsOverlay(stage) : null
  const fixedUpdate = (): void => {
      if (!running || !sim || !track) return
      prevState = { ...sim.car.s }
      if (race) opponentPrev = race.race.sims.map((car) => ({ ...car.car.s }))

      // Watching: the reference driver has the controls, and the loop below is
      // otherwise untouched — same physics, same timing, same recording. Called
      // exactly once a tick, because `next` advances its own place on the line.
      let controls
      const introControls = qualifying?.intro?.next()
      if (introControls) {
        controls = { steer: introControls.steer, throttle: introControls.pedal,
          pedalIntent: Math.sign(introControls.pedal) }
      } else if (watcher) {
        watcher.offTrack = sim.offTrack
        const c = watcher.next(sim.car.s)
        watcher.flying = sim.lapsCompleted > 0
        controls = { steer: c.steer, throttle: c.pedal, pedalIntent: Math.sign(c.pedal) }
      } else {
        controls = input.sample()
      }
      lastThrottle = controls.throttle
      lastSteer = controls.steer
      const before = sim.timingArmed
      // In a race the whole field steps together, and the player's result comes
      // back out of it. `sim` is the player's own sim either way, so everything
      // downstream — timing, recording, the HUD, the leaderboard — is untouched.
      const wasPlayerFinished = race?.playerFinished ?? false
      const requestedShift = input.takeShift()
      const shift = introControls ? 0 : requestedShift
      const result = race
        ? race.step(controls.steer, controls.throttle, shift, tcLevel,
          { clutch: input.launchClutch, throttle: input.launchThrottle })[race.playerSlot]!
        : sim.step(controls.steer, controls.throttle, shift, tcLevel)

      if (race?.playerFinished && !wasPlayerFinished) {
        finishState = 'flag'
        flagTicks = 0
        finish.showFlag(race.playerPosition(), race.size,
          race.race.trackLimits[race.playerSlot]!.penaltySeconds)
      }

      // Asymmetric smoothing for the lamp: snap on, fade off. TC intervening is
      // news and should be instant; TC having stopped is not, and a lamp that
      // dropped as sharply as it lit would strobe through every bump.
      tcBite = Math.max(sim.car.tcCut, tcBite * TC_LAMP_DECAY)
      // Same smoothing for the ABS badge, and for the same reason: the aid
      // engages and releases many times through one braking zone.
      absBite = Math.max(sim.car.absCut, absBite * TC_LAMP_DECAY)

      // Start the ghost the instant the player's lap does, so the two are
      // always comparing the same stretch of road.
      if (
        current.mode === 'time' && ghostRecord && current.ghost
        && (result.lapCompleted || (!before && result.timingArmed))
      ) {
        if (ghostRecord.path) {
          ghost = new GhostPath(ghostRecord.path)
        } else {
          // No path: a lap recorded before positions were stored, or one whose
          // path was shed to fit the storage quota. It has to be re-driven from
          // its inputs, and that only reproduces the lap while the car it was
          // set on still exists — so this is the ghost that can wander off, and
          // it says so rather than leaving you to wonder.
          //
          // Its OWN setup and easy mode, not the ones you are driving. The
          // board no longer splits by setup, so the fastest lap here may be on
          // the other trim; and easy mode changes grip, so replaying an easy
          // lap on standard grip diverges within a corner.
          const p = handlingPreset(ghostRecord.recording.preset as PresetName)
          ghost = new LapReplay(
            track,
            ghostRecord.recording.easy ? applyEasyAids(p) : p,
            ghostRecord.recording,
          )
          console.warn(
            `[ghost] this lap has no recorded path (set ${ghostRecord.recordedAt.slice(0, 10)}` +
            `, ${ghostRecord.preset ?? ghostRecord.recording.preset}), so it is being re-driven from` +
            ' its inputs. If the car has changed since, it will not reproduce the lap. Drive a new one.',
          )
        }
        ghostPrev = { ...ghost.car.s }
      }
      if (ghost && !ghost.finished) {
        ghostPrev = { ...ghost.car.s }
        ghost.step()
      }

      // One thump per contact, driven off the fixed step rather than the frame
      // — at 144 Hz the render loop would fire three for the same hit.
      if (sim.wallImpact > 0) sound.impact(sim.wallImpact)

      if (result.lapCompleted && !wasPlayerFinished) void onLapCompleted(result.lapCompleted)
      if (finishState === 'flag' && ++flagTicks >= 180 && race
        && (race.phase === 'finished' || race.race.raceTime >= race.race.adjustedFinishTime(race.playerSlot)!)) {
        showRaceResults(race)
      }
  }

  const drawFrame = (alpha: number, dtWall: number): void => {
      if (finishState === 'results') return
      if (!running && !paused && track) {
        // Attract mode: fly the selected circuit behind the menu. Only when
        // there is no session — a paused one keeps its own scene, held still.
        attractTime += dtWall
        renderer.renderFlyover(track, attractTime, dtWall)
        // The menu is silent. The attract field is ten cars lapping with
        // nobody driving them, and scoring that would be background music.
        sound.idle()
        return
      }
      if (sim && prevState) {
        // Paused draws the physics state exactly, with no interpolation.
        //
        // `alpha` keeps sweeping 0..1 with the physics stopped — the loop still
        // drains its accumulator every frame, the fixed step just returns early
        // — so interpolating would rock the car back and forth across one tick
        // forever. A pause has to be a still frame, not a very short loop.
        const drawn = paused ? sim.car.s : interpolate(prevState, sim.car.s, alpha)
        const p = params(current)
        // Where the car sits relative to the painted edge, so the camera can
        // rumble on the kerbs and shake on the grass.
        const proj = sim.track.project(sim.car.s.x, sim.car.s.y)
        // The ghost freezes on the same terms the player does. `alpha` sweeps
        // 0..1 whether or not the physics is running, so an interpolated ghost
        // on a held frame rocks back and forth across one tick — the player car
        // was fixed for this and the ghost was not, which is why only the ghost
        // jittered while paused.
        const ghostDrawn =
          ghost && !ghost.finished
            ? ghostPrev && !paused
              ? interpolate(ghostPrev, ghost.car.s, alpha)
              : ghost.car.s
            : null
        // Nearby cars must use the camera's interpolated timeline too; raw
        // physics positions jump against the smooth camera and appear blurry.
        const proximityRivals: ProximityRival[] = []
        if (race) {
          const states = race.race.sims.map((car, i) => !paused && opponentPrev[i]
            ? interpolate(opponentPrev[i]!, car.car.s, alpha) : car.car.s)
          renderer.setOpponentStates(
            states.filter((_, i) => i !== race!.playerSlot) as CarState[],
          )
          for (let i = 0; i < states.length; i++) {
            if (i !== race.playerSlot) proximityRivals.push({
              slot: i, state: states[i]!, params: race.race.sims[i]!.car.p,
            })
          }
        }
        renderer.rig.lookBack = input.lookBack
        renderer.render(
          drawn,
          ghostDrawn,
          p,
          lastThrottle,
          // No wall time while paused either. Everything the renderer advances
          // by it — the camera settling toward the car, the suspension, the
          // wheels rolling — would otherwise keep creeping on a stopped car.
          paused ? 0 : dtWall,
          { lateral: proj.lateral, half: proj.half, margin: OFF_TRACK_MARGIN },
        )

        // A held frame is silent, and it stops here.
        //
        // Silent because a stopped car holding its last tyre scrub and engine
        // note is a drone, not a pause. Stopping here because the HUD below
        // reads its pedal bars from the live input, and pausing calls
        // `input.release()` — so updating it would empty the bars the instant
        // you paused, which is the one thing a held frame must not do.
        if (paused) {
          sound.idle()
          return
        }

        // Audio reads the SIM state, not the interpolated drawing state: slip
        // angles and wheel speeds only exist on the physics tick, and lerping
        // them would smear exactly the transients that carry the information.
        const cs = sim.car.s
        // During the grid hold the vehicle model is stationary. Spin the
        // cockpit rev display and sound from the held throttle behind the
        // keyboard clutch; release still uses the vehicle's real RPM.
        const launchRev = race?.launch?.state === 'ready'
          ? p.idleRpm + Math.max(0, lastThrottle) * (p.redlineRpm * 0.78 - p.idleRpm)
          : cs.engineRpm
        sound.update({
          speed: Math.hypot(cs.vx, cs.vy),
          vx: cs.vx,
          wheelVr: cs.wheelVr,
          slipF: cs.slipF,
          slipR: cs.slipR,
          onKerb: renderer.rig.onKerb,
          onGrass: renderer.rig.onGrass,
          rpm: launchRev,
          redlineRpm: p.redlineRpm,
          throttle: lastThrottle,
          // Straight from the physics: the sim really does cut torque for
          // 0.15 s on an upshift, so the hole in the sound is the gearchange
          // rather than an effect timed to look like one.
          shiftTimer: cs.shiftTimer,
        })

        // WHOSE PEDALS. The bars read the human's input, which is the right
        // answer while a human is driving and a flat zero while the reference
        // driver is — and a telemetry strip that reads zero through a braking
        // zone is worse than no strip, because it looks like the car is
        // coasting. Watching, the bars show what the AI actually commanded.
        //
        // `lastThrottle` is the signed pedal the controller returned: positive
        // is throttle, negative is brake, exactly as `pedalFor` produces it.
        const pedals = watcher || qualifying?.intro?.active
          ? { throttle: Math.max(0, lastThrottle), brake: Math.max(0, -lastThrottle) }
          : input.pedals
        hud.update({
          qualifying: qualifying !== null,
          ...(qualifying?.intro ? { qualifyingIntro: {
            active: qualifying.intro.active, lights: qualifying.intro.lights, hint: qualifying.intro.hint,
          } } : {}),
          ...(race ? { trackLimits: race.race.trackLimits[race.playerSlot]! } : {}),
          proximity: race && renderer.rig.mode !== 'topDown'
            ? proximityMarkers(drawn, p, proximityRivals,
              input.lookBack && (renderer.rig.mode === 'halo' || renderer.rig.mode === 'hood'), race.race.track)
            : [],
          ...(race ? { race: raceHudState(race) } : {}),
          speedKmh: Math.hypot(sim.car.s.vx, sim.car.s.vy) * 3.6,
          gear: sim.car.s.gear,
          rpm: launchRev,
          redlineRpm: p.redlineRpm,
          carX: sim.car.s.x,
          carY: sim.car.s.y,
          // Keep the map tint on the same authored timing sectors as the sim.
          sector: sim.track.sectorAt(sim.lapFraction * sim.track.length),
          ghostX: ghostDrawn ? ghostDrawn.x : null,
          ghostY: ghostDrawn ? ghostDrawn.y : null,
          tcLevel,
          tcBite,
          absBite,
          currentLap: sim.currentLapTime,
          lastLap: sim.lastLapTime,
          bestLap: sim.bestLapTime,
          lapValid: race !== null || sim.lapValid,
          timingArmed: sim.timingArmed,
          ghostDelta: sim.liveDelta,
          sectors: sim.currentSectors,
          sectorDeltas: sim.sectorDeltas,
          sectorBestFlags: sim.sectorBestFlags,
          lastSectors: sim.lastSectors,
          lastSectorDeltas: sim.lastSectorDeltas,
          lastSectorBestFlags: sim.lastSectorBestFlags,
          lastLapValid: race !== null || sim.lastLapValid,
          bestSectors: sim.bestSectors,
          throttle: pedals.throttle,
          brake: pedals.brake,
          steer: lastSteer,
          cameraLabel: CAMERA_LABEL[renderer.rig.mode],
          inputLabel: input.mode === 'mouse' ? 'Mouse' : 'Keys',
          viewportLabel: VIEWPORT_LABEL[viewport],
          easy: current.easy,
          // What the car was actually built with, not what was requested — the
          // sim resolves the aid, so reading it back is the only way the HUD
          // cannot drift from the thing it is describing.
          abs: sim.car.p.absOn,
          ghost: current.mode === 'time' && current.ghost,
          lapCount: sim.lapsCompleted,
          validLaps: sim.validLaps,
          lapFraction: sim.lapFraction,
        })
      }
  }

  const loop = new GameLoop(fixedUpdate, fpsProbe
    ? (alpha, dtWall): void => {
      const t0 = performance.now()
      drawFrame(alpha, dtWall)
      fpsProbe.frame(dtWall * 1000, performance.now() - t0)
    } : drawFrame)

  // --- events --------------------------------------------------------------
  input.onAction = (action) => {
    if (finishState === 'results') {
      if (action === 'restart') restartLap()
      else if (action === 'pause') quitToMenu()
      return
    }
    if (finishState === 'flag') return
    switch (action) {
      case 'restart':
        if (running && race?.launch && race.launch.state !== 'launched') break
        if (running) restartLap()
        break
      case 'pause':
        if (running) {
          running = false
          paused = true
          input.release()
          menu.showPause(pauseStatus())
        } else if (menu.handleEscape()) {
          break
        } else if (menu.visible && paused) {
          menu.hide()
          running = true
          paused = false
        }
        break
      case 'camera':
        applySettings({ ...settings, camera: renderer.rig.cycle() })
        break
      case 'ghost':
        if (current.mode === 'race') break
        current = { ...current, ghost: !current.ghost }
        renderer.ghostVisible = current.ghost
        persistSelection(current)
        break
      case 'viewport':
        applySettings({ ...settings, viewport: nextViewport(viewport) })
        break
      case 'tcUp':
      case 'tcDown': {
        // Only while driving. Turning TC up from the pause screen would be a
        // lap that says one thing and drove another.
        if (!running || !ASSISTS_ADJUSTABLE) break
        const next = tcLevel + (action === 'tcUp' ? 1 : -1)
        tcLevel = Math.min(Math.max(next, 0), TC_LEVEL_MAX)
        // Remembered for next session, but the lap keeps its own per-tick
        // record — this is the wheel's resting position, not the lap's ruleset.
        applySettings({ ...settings, tcLevel })
        break
      }
    }
  }

  menu.onStart = (sel) => void start(sel)
  menu.onQualify = (sel) => void start(sel, true)
  menu.onNewEvent = () => {
    weekend = new RaceEvent(menu.selection, crypto.getRandomValues(new Uint32Array(1))[0]!)
    menu.raceEvent = weekend
  }
  menu.onResume = () => {
    if (sim) running = true
    paused = false
    hud.root.classList.remove('is-hidden')
  }
  menu.onRestart = () => {
    if (qualifying) {
      completeQualifying(null)
      return
    }
    restartLap()
    running = true
    paused = false
  }
  menu.onEndSession = () => endSession()
  menu.onQuit = () => quitToMenu()
  finish.onRestart = () => restartLap()
  finish.onQuit = () => quitToMenu()
  menu.onProfileClaimed = () => void menu.showLeaderboard()
  menu.onSettingsChange = (s) => applySettings(s)
  menu.onSelectionChange = (sel) => {
    if (sel.mode === 'race') eventFor(sel)
    persistSelection(sel)
    // The car matters as much as the circuit here: switching cars changes which
    // recorded lap the field should be driving.
    if (!running) {
      preview(sel.trackId)
      refreshAttractLine()
    }
  }

  // Coalesced to one per frame. A window drag fires `resize` far faster than
  // the display refreshes, and each one reached `EffectComposer.setSize` and
  // reallocated both render targets; doing that several times inside a single
  // frame is work whose result is thrown away before anything is drawn with it.
  let resizePending = false
  window.addEventListener('resize', () => {
    if (resizePending) return
    resizePending = true
    requestAnimationFrame(() => {
      resizePending = false
      setViewport(viewport)
    })
  })

  // Stop the loop while the tab is hidden, and restart it clean.
  //
  // Nothing was watching for this, so a hidden tab kept whatever the browser
  // still gave it and came back holding stale timing. `start()` resets both the
  // clock and the accumulator, so returning costs one ordinary frame instead of
  // a catch-up: with `MAX_FRAME` at 0.25 s that catch-up was fifteen fixed
  // steps, which measures 0.7 ms and is NOT what makes the return feel rough --
  // but running nothing at all while nobody is looking is still the right
  // behaviour, and it is what stops a backgrounded tab burning a core.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) loop.stop()
    else if (!loop.isRunning) loop.start()
  })

  renderer.resize()
  // Show the opening circuit straight away, so the menu never opens on a void.
  void preview(selection.trackId)
  loop.start()

  // Dev-only handle for driving the game from an automated browser session.
  // Stripped from production builds by the bundler's dead-code elimination.
  if (import.meta.env.DEV) {
    Object.defineProperty(window, '__game', {
      value: {
        get sim() { return sim },
        get race() { return race },
        get track() { return track },
        get running() { return running },
        get ghostRecord() { return ghostRecord },
        get stats() { return renderer.stats() },
        get fov() { return renderer.cameraFov },
        get fovKick() { return renderer.fovKick },
        get lastBuildMs() { return lastBuildMs },
        get buildCount() { return buildCount },
        /** Visual-QA seam: render a debrief without driving five real laps. */
        showSessionSummary(summary: SessionSummary) { menu.showSessionSummary(summary) },
      },
      configurable: true,
    })
  }
}

/**
 * Resolve once the current frame has presented and the browser has gone idle —
 * the place where a few milliseconds of synchronous work cannot cost a vsync.
 * The timeout bounds the wait on a busy main thread; Safari has no
 * requestIdleCallback, and a timer past the next frame serves the same end.
 */
const afterPresent = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: 250 })
    } else {
      setTimeout(resolve, 32)
    }
  })

/** Position and heading between two physics states, for smooth drawing. */
function interpolate(a: CarState, b: CarState, alpha: number): CarState {
  const t = Math.min(Math.max(alpha, 0), 1)
  return {
    ...b,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    // Lerping raw yaw would spin the car the long way round at the ±pi seam.
    yaw: a.yaw + wrapAngle(b.yaw - a.yaw) * t,
    steer: a.steer + (b.steer - a.steer) * t,
  }
}

async function loadBests(store: LocalRecordStore): Promise<Map<string, LapRecord>> {
  const map = new Map<string, LapRecord>()
  for (const r of await store.all()) map.set(keyOf(r), r)
  return map
}

/** A stored number that has to be a whole number in range, or the default. */
function clampInt(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : NaN
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

function restoreSelection(manifest: TrackManifestEntry[]): Selection {
  // Whatever was stored (or whatever the manifest offers) is clamped to the
  // released circuits. The default car is whatever leads
  // `RELEASED_PRESETS` — currently `legacy`/F1-Test, the tune the lap records
  // were set on.
  //
  // Easy is ON for a first session. It is no longer a different car — since the
  // rear grip bias went back to the standard 1.25 it is the same chassis with
  // the aids switched on — so the cost of defaulting to it is a beginner
  // getting TC and ABS rather than a beginner learning a car nobody else
  // drives. Someone who turns it off is choosing that, and the choice is stored.
  const fallback: Selection = {
    trackId: RELEASED_TRACKS.find((id) => manifest.some((t) => t.id === id)) ?? manifest[0]!.id,
    preset: RELEASED_PRESETS[0]!,
    easy: true,
    ghost: true,
    ghostEntryId: null,
    // Time trial is the default session. Race is a thing you choose, not a
    // thing a first-time player is dropped into against a field.
    mode: 'time',
    laps: 3,
    opponents: 5,
    difficulty: 'quick',
  }
  try {
    const raw = window.localStorage.getItem(SELECTION_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Selection>
    const trackId =
      RELEASED_TRACKS.includes(parsed.trackId ?? '') && manifest.some((t) => t.id === parsed.trackId)
        ? parsed.trackId!
        : fallback.trackId
    const stored = migrateStoredPreset(parsed.preset)
    const preset = RELEASED_PRESETS.includes(stored as PresetName)
      ? (stored as PresetName)
      : fallback.preset
    return {
      trackId,
      preset,
      easy: parsed.easy ?? fallback.easy,
      ghost: parsed.ghost ?? true,
      ghostEntryId: typeof parsed.ghostEntryId === 'string' ? parsed.ghostEntryId : null,
      mode: parsed.mode === 'race' ? 'race' : fallback.mode,
      laps: clampInt(parsed.laps, 1, MAX_RACE_LAPS, fallback.laps),
      opponents: clampInt(parsed.opponents, 0, MAX_OPPONENTS, fallback.opponents),
      difficulty: difficultyByName(parsed.difficulty ?? '').name,
    }
  } catch {
    return fallback
  }
}

/**
 * Follow the lap records off the `f1` key.
 *
 * `f1` used to name the car now keyed `legacy`, and `LocalRecordStore` re-keyed
 * the stored lap times to match. The stored *selection* has to move with them,
 * or a player who last drove that car reopens the menu on something else.
 *
 * This used to be one-shot behind a flag, because `f1` then went on to name the
 * Experimental build and a standing rewrite would have made that car impossible
 * to keep selected across a reload. Experimental is off the menu now, so `f1`
 * is never a valid selection again and the rewrite can just stand.
 */
function migrateStoredPreset(stored: string | undefined): string | undefined {
  return stored === 'f1' ? 'legacy' : stored
}

function persistSelection(s: Selection): void {
  try {
    window.localStorage.setItem(SELECTION_KEY, JSON.stringify(s))
  } catch {
    // A blocked or full localStorage costs the convenience, not the game.
  }
}

void boot()
