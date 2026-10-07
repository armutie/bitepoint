import { difficultyByName, MAX_OPPONENTS, MAX_RACE_LAPS } from '../core/raceSession'
import type { Selection } from './menu'

export const RACE_TRACK = 'power_8'
export const RACE_PRESET = 'legacy'

/** The supported race pairing, including selections restored from older menus. */
export function raceSelection(selection: Selection): Selection {
  const whole = (value: number, maximum: number, fallback: number): number =>
    Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.round(value))) : fallback
  return {
    ...selection,
    mode: 'race',
    trackId: RACE_TRACK,
    preset: RACE_PRESET,
    ghostEntryId: null,
    laps: whole(selection.laps, MAX_RACE_LAPS, 3),
    opponents: whole(selection.opponents, MAX_OPPONENTS, 5),
    difficulty: difficultyByName(selection.difficulty).name,
  }
}
