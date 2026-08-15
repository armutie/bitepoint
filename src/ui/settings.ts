/**
 * Player settings — the things that are preferences rather than race choices.
 *
 * Every knob here is a short named scale, not a continuous slider. The sliders
 * that used to be here (speed FOV, kerb shake, and sensitivity as a percentage)
 * asked the player to tune a number they cannot see the effect of from the menu,
 * and the honest answer for all three is "a bit more" or "a bit less". So:
 * Low/Medium/High, and the fiddly numbers move together underneath.
 *
 * Speed FOV and kerb shake are gone as separate controls and now ride on
 * `effects` — they are camera effects, and splitting them out only made three
 * ways to say "calmer picture". See `cameraFeel`.
 *
 * Values are still stored as numbers rather than level names, so the renderer
 * keeps its 0..1 contract and a settings file written by an older build still
 * loads: anything off-scale snaps to the nearest level.
 */
import { TC_LEVEL_DEFAULT, TC_LEVEL_MAX } from '../core/carParams'
import type { CameraMode } from '../render/cameras'
import { VIEWPORT_ORDER, type ViewportMode } from '../game/viewport'

export interface Settings {
  /**
   * 0..1. Higher means full lock arrives sooner: at 1 the wheel is on the
   * stop a sixth of the way to the screen edge, at 0 you must drag the cursor
   * all the way out.
   */
  mouseSensitivity: number
  /** Camera-effects master: 0 = clean render (pygame), 1 = full film look. */
  effects: number
  /** Master audio level: 0 is properly off, nothing scheduled. */
  volume: number
  /** Reduce GPU load without changing physics, controls, or lap validity. */
  performanceMode: boolean
  camera: CameraMode
  viewport: ViewportMode
  inputMode: 'mouse' | 'keyboard'
  /**
   * Manual gearbox. Paddles are the mouse buttons, or Q and E.
   *
   * A race choice more than a preference — it changes lap times — but it lives
   * here rather than in the car because the car is the same machine either way.
   * The recording carries it, so a manual lap replays as one.
   */
  gearbox: 'auto' | 'manual'
  /**
   * Where the traction-control rotary was left, 0 = off.
   *
   * Persisted so the wheel is where you left it next session, exactly as a real
   * one would be. Not a difficulty setting: it is recorded per tick in the lap
   * and keys the leaderboard, so a lap driven on it is a TC lap whatever this
   * says when the game opens.
   */
  tcLevel: number
  /**
   * Anti-lock braking. Off by default, and that is a deliberate default rather
   * than a shrug: F1 has banned ABS since 1994, so this car would not have it.
   *
   * Chosen before the lap rather than turned on the wheel like traction
   * control, because it cannot be adjusted while driving — so it is a setting,
   * and one bit travels with the recording rather than a channel per tick.
   */
  abs: boolean
}

export type Level = 'low' | 'medium' | 'high'
export type EffectsLevel = 'off' | Level

/** Mouse sensitivity, as the three settings anyone actually wants. */
export const SENSITIVITY: Record<Level, number> = { low: 0.25, medium: 0.5, high: 0.8 }

/** Camera effects. `off` is the pygame image: clean render, fixed FOV, no shake. */
export const EFFECTS: Record<EffectsLevel, number> = { off: 0, low: 0.35, medium: 0.7, high: 1 }

/**
 * Sound, and it starts at Low.
 *
 * The one default in here that is not the best-looking option. Audio is the
 * thing a player is most likely to want gone, it is new, and a game that comes
 * up loud on first load has already lost the argument. Low is enough to hear
 * the tyres working; High is for when you want to be told everything.
 */
export const VOLUME: Record<EffectsLevel, number> = { off: 0, low: 0.4, medium: 0.7, high: 1 }

export const DEFAULT_SETTINGS: Settings = {
  mouseSensitivity: SENSITIVITY.medium,
  effects: EFFECTS.high,
  volume: VOLUME.low,
  performanceMode: false,
  camera: 'halo',
  viewport: 'full',
  inputMode: 'mouse',
  gearbox: 'auto',
  tcLevel: TC_LEVEL_DEFAULT,
  abs: false,
}

/**
 * The camera motion that rides on the effects level.
 *
 * At `off` this is exactly pygame: a fixed field of view and no added shake.
 * `medium` is where the two former sliders sat by default.
 */
export function cameraFeel(effects: number): { fovKick: number; shake: number } {
  if (effects <= EFFECTS.off) return { fovKick: 0, shake: 0 }
  if (effects <= EFFECTS.low) return { fovKick: 4, shake: 0.35 }
  if (effects <= EFFECTS.medium) return { fovKick: 8, shake: 0.55 }
  return { fovKick: 12, shake: 0.8 }
}

/**
 * Fraction of the half-width at which the wheel reaches full lock.
 *
 * Sensitivity 0 -> 1.0 (drag to the very edge of the picture); 1 -> 0.15 (a
 * short flick). Inverted because "more sensitive" means "less travel".
 */
export const fullLockFraction = (sensitivity: number): number =>
  1.0 - 0.85 * Math.max(0, Math.min(1, sensitivity))

const KEY = 'car-racing:settings'

export function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<Settings>
    // Field-by-field, so a stored file from an older build cannot inject
    // nonsense or leave a new field undefined.
    return {
      mouseSensitivity: snap(parsed.mouseSensitivity, SENSITIVITY, DEFAULT_SETTINGS.mouseSensitivity),
      effects: snap(parsed.effects, EFFECTS, DEFAULT_SETTINGS.effects),
      volume: snap(parsed.volume, VOLUME, DEFAULT_SETTINGS.volume),
      performanceMode: parsed.performanceMode === true,
      camera: (['halo', 'hood', 'chase', 'topDown'] as const).includes(parsed.camera as CameraMode)
        ? (parsed.camera as CameraMode)
        : DEFAULT_SETTINGS.camera,
      // Against what is OFFERED, not against every mode that exists. A stored
      // setting naming a retired mode would otherwise apply while showing
      // nothing selected in the picker, which reads as the picker being broken.
      viewport: VIEWPORT_ORDER.includes(parsed.viewport as ViewportMode)
        ? (parsed.viewport as ViewportMode)
        : DEFAULT_SETTINGS.viewport,
      // v1 has one advertised control scheme and one gearbox. Clamp older
      // saved choices so a hidden option cannot remain active.
      inputMode: 'mouse',
      gearbox: 'auto',
      tcLevel:
        typeof parsed.tcLevel === 'number' && Number.isInteger(parsed.tcLevel)
          ? Math.min(Math.max(parsed.tcLevel, 0), TC_LEVEL_MAX)
          : DEFAULT_SETTINGS.tcLevel,
      abs: parsed.abs === true,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: Settings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // A blocked or full localStorage costs the preference, not the game.
  }
}

/** The level a stored number belongs to — the nearest one, so old files land. */
export function levelOf<K extends string>(value: number, scale: Record<K, number>): K {
  const entries = Object.entries(scale) as [K, number][]
  let best = entries[0]!
  for (const e of entries) if (Math.abs(e[1] - value) < Math.abs(best[1] - value)) best = e
  return best[0]
}

function snap<K extends string>(v: unknown, scale: Record<K, number>, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return scale[levelOf(v, scale)]
}
