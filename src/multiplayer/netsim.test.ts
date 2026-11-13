import { describe, expect, it } from 'vitest'

import data from '../../public/tracks/power_8.json'
import { Track, type TrackData } from '../core/track'
import { runNetsim, type LinkProfile, type NetsimOptions, type NetsimReport } from './netsim'
import { PROTOCOL, type RoomConfig } from './protocol'

const config: RoomConfig = { protocol: PROTOCOL, trackId: 'power_8', preset: 'legacy', laps: 3, manual: false, abs: true, contact: false }

/** One-way figures. Canada to the US East or West coast is typically 15-45 ms one way. */
const PROFILES: Record<string, LinkProfile> = {
  lan: { latencyMs: 1, jitterMs: 1, loss: 0 },
  sameCity: { latencyMs: 10, jitterMs: 4, loss: 0.002 },
  canadaUsa: { latencyMs: 35, jitterMs: 10, loss: 0.01 },
  poorWifi: { latencyMs: 60, jitterMs: 30, loss: 0.03 },
}

/** Mean over several seeds, so one lucky packet pattern cannot decide a comparison. */
function averaged(track: Track, opts: NetsimOptions): NetsimReport {
  const runs = [3, 7, 19, 41].map((seed) => runNetsim(track, config, { ...opts, seed }))
  const mean = (k: keyof NetsimReport): number => +(runs.reduce((a, r) => a + r[k], 0) / runs.length).toFixed(3)
  return { guestSnapP95: mean('guestSnapP95'), guestViewErrorP95: mean('guestViewErrorP95'), hostViewErrorP95: mean('hostViewErrorP95'), guestInputDelayMs: Math.round(mean('guestInputDelayMs')) }
}

describe('what each driver sees, by connection', () => {
  const track = new Track(data as TrackData)
  it.each(Object.entries(PROFILES))('%s', (name, link) => {
    const before = averaged(track, { link, snapshotEvery: 2, hostLead: false })
    const after = averaged(track, { link, snapshotEvery: 1, hostLead: true })
    console.info(`[netsim] ${name}`, JSON.stringify({ before, after }))
    // The host's view of the guest is the measured weakness; it must improve
    // wherever there is latency to hide.
    if (link.latencyMs >= 10) expect(after.hostViewErrorP95).toBeLessThan(before.hostViewErrorP95)
    // And must never make it worse where there is none.
    expect(after.hostViewErrorP95).toBeLessThanOrEqual(before.hostViewErrorP95 + 0.05)
    // Faster snapshots must not make the guest's own car jumpier.
    expect(after.guestSnapP95).toBeLessThanOrEqual(before.guestSnapP95 + 0.05)
  })
})
