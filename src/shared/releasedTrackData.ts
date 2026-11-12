/**
 * The released circuits as built `Track`s, for the servers that replay laps.
 *
 * Kept apart from `released.ts` so the browser bundle, which loads circuits on
 * demand, does not pull every circuit file in just to read the id list.
 * Imports carry `.ts` extensions and JSON import attributes so the Supabase
 * Edge Function (Deno) can load this file unchanged.
 */
import balanced8 from '../../public/tracks/balanced_8.json' with { type: 'json' }
import power3 from '../../public/tracks/power_3.json' with { type: 'json' }
import power4 from '../../public/tracks/power_4.json' with { type: 'json' }
import power8 from '../../public/tracks/power_8.json' with { type: 'json' }
import silverstoneGp from '../../public/tracks/silverstone-gp.json' with { type: 'json' }
import { Track, type TrackData } from '../core/track.ts'

export const RELEASED_TRACK_MAP: ReadonlyMap<string, Track> = new Map(
  [balanced8, power3, power4, power8, silverstoneGp]
    .map((data) => new Track(data as TrackData))
    .map((track) => [track.id, track]),
)
