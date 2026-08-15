/**
 * The laps the menu's background field drives — pinned, and locked.
 *
 * These used to come straight out of `localStorage`, which made the field two
 * kinds of unstable. It changed under you every time you beat your own time —
 * the background of the menu is not a leaderboard and should not move — and it
 * broke outright whenever the car changed.
 *
 * Pinning fixed the first. This file fixes the second, by storing the laps as
 * PATHS rather than as recordings. A recording is a trace of inputs, so it only
 * reproduces its lap while the car that drove it still exists; re-driving one
 * under a changed car is what filled the menu with cars ploughing into the
 * scenery. A path is where the car actually was, so no change to the gearbox,
 * the downshift point or traction control can move it. Nothing is simulated to
 * draw this field — it is played back.
 *
 * That is also why there is no off-circuit guard here any more. There is
 * nothing left that could wander off.
 *
 * Fetched rather than imported, exactly as the tracks are: a few hundred KB is
 * fine as a static file the browser caches and not fine welded into the entry
 * bundle. To replace these, see `docs/attract-laps.md`.
 */

/** One pinned lap: a circuit, a car, and where that car went. */
export interface PinnedLap {
  trackId: string
  preset: string
  easy: boolean
  time: number
  /** Ghost path, base64 Float32 — see GHOST_FIELDS values per pose. */
  path: string
}

let cache: Promise<PinnedLap[]> | null = null

/**
 * Load the pinned laps once, and never let a failure become a broken menu.
 *
 * A missing or malformed file is not worth an error path: the field falls back
 * to personal bests, which is what it does for an unpinned circuit anyway. The
 * promise is cached including its failure, so a 404 is one request rather than
 * one per redraw of the car list.
 */
export function loadAttractLaps(base = '.'): Promise<PinnedLap[]> {
  cache ??= fetch(`${base}/attract-laps.json`)
    .then((res) => (res.ok ? (res.json() as Promise<PinnedLap[]>) : []))
    .catch(() => [])
  return cache
}

/** The pinned laps for one circuit and car, or none. */
export function pinnedAttractLaps(
  laps: PinnedLap[], trackId: string, preset: string, easy: boolean,
): PinnedLap[] {
  return laps.filter(
    (l) => l.trackId === trackId && l.preset === preset && l.easy === easy,
  )
}

/** Base64 Float32 back to the path `attractLineFromPath` wants. */
export function decodePath(encoded: string): Float64Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return Float64Array.from(new Float32Array(bytes.buffer, 0, bytes.byteLength / 4))
}
