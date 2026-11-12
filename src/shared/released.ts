/**
 * What the release lets players drive, in one place.
 *
 * The menu, the local leaderboard API and the Supabase verifier all gate on
 * these lists. They used to keep their own copies, and a circuit released in
 * one but not another would show in the menu and then fail verification.
 * `releasedTrackData.ts` pairs these ids with the circuit files the servers
 * replay laps on, and its test fails if the two ever disagree.
 *
 * The release ships five circuits, chosen for what they ask of a setup: Ashford
 * is the balanced reference lap, Croft Bay is pure stop-and-go, Thruxton Vale is
 * the longest, and Elvington Mile is one 670 m straight — two and a half times
 * anything else here, and the only place the low-drag trim's extra 18 km/h has
 * room to pay for the cornering it gives up. Silverstone uses mapped GP
 * coordinates. The rest of the calendar stays visible but locked: a menu that
 * shows what is coming reads as a roadmap, one that hides it reads as thin.
 * Time-trial choices are separate from the supported race pairing.
 */
import type { PresetName } from '../core/carParams.ts'

export const RELEASED_TRACKS: readonly string[] =
  ['silverstone-gp', 'power_8', 'power_4', 'balanced_8', 'power_3']

/** Both setups in `PRESET_ORDER` are drivable; the gate is kept for the next one. */
export const RELEASED_PRESETS: readonly PresetName[] = ['legacy', 'classic']
