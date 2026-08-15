/**
 * Things that are built, tested, and deliberately not switched on yet.
 *
 * A flag rather than deleted code, because none of this was speculative — it is
 * working machinery with tests behind it, and the reason it is off is a product
 * decision rather than a technical one.
 */

/**
 * Can the driver change the car's aids?
 *
 * OFF for v1. Traction control sits at `TC_LEVEL_DEFAULT` for everyone and ABS
 * is not offered, which makes every lap the same test — so the leaderboard is
 * one list of times with nothing to qualify, no badges, no filters, and no
 * question about whether a slower lap deserves keeping.
 *
 * What stays wired underneath: the rotary's levels, the per-tick TC channel in
 * every recording, ABS travelling with a lap, the assist marks on a leaderboard
 * entry, and a storage slot per assist combination. Switching this to `true`
 * brings all of it back, because none of it was removed — see
 * `assistSlot`, `LeaderboardEntry.assists` and `Settings.abs`.
 *
 * The recordings keep carrying their TC channel while this is off. It costs a
 * third more input bytes and buys something worth more than that: laps set now
 * stay replayable byte for byte if the rotary is ever offered, instead of being
 * a generation of laps that predate it.
 */
export const ASSISTS_ADJUSTABLE = false

export const isLegacyTyrePath = (pathname: string): boolean =>
  /(?:^|\/)legacy(?:\/index\.html)?\/?$/.test(pathname)

/** The `/legacy` build keeps the tyre curve shipped before August 2026. */
export const LEGACY_TYRE_MODE =
  typeof window !== 'undefined' && isLegacyTyrePath(window.location.pathname)
