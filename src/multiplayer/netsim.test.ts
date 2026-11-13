import { describe, expect, it } from 'vitest'

import data from '../../public/tracks/power_8.json'
import { Track, type TrackData } from '../core/track'
import { runNetsim, type LinkProfile, type NetsimOptions, type NetsimReport } from './netsim'
import { PROTOCOL, type RoomConfig } from './protocol'

const config: RoomConfig = { protocol: PROTOCOL, trackId: 'power_8', preset: 'legacy', laps: 3, manual: false, easy: false, contact: false }

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
  return { guestSnapP95: mean('guestSnapP95'), guestSnapMax: mean('guestSnapMax'), guestViewErrorP95: mean('guestViewErrorP95'), hostViewErrorP95: mean('hostViewErrorP95'), guestInputDelayMs: Math.round(mean('guestInputDelayMs')), impacts: Math.round(mean('impacts')) }
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
  }, 30_000)
})

describe('car contact under latency', () => {
  const track = new Track(data as TrackData)
  it.each(Object.entries(PROFILES))('%s', (name, link) => {
    // Lean toward each other: whichever sign actually makes the cars collide.
    const touches = (leanSign: 1 | -1): number => runNetsim(track, { ...config, contact: true }, { link, snapshotEvery: 1, hostLead: true, sideBySide: true, ticks: 600, leanSign, seed: 3 }).impacts
    const leanSign: 1 | -1 = touches(1) >= touches(-1) ? 1 : -1
    const opts = { link, snapshotEvery: 1, hostLead: true, sideBySide: true, ticks: 600, leanSign }
    const ghost = averaged(track, opts)
    const contact = runNetsim(track, { ...config, contact: true }, { ...opts, seed: 3 })
    const contactAvg = averagedWith(track, { ...config, contact: true }, opts)
    console.info(`[netsim-contact] ${name}`, JSON.stringify({ ghost, contact: contactAvg }))
    expect(Number.isFinite(contact.guestSnapP95)).toBe(true)
    // Prove the run is about contact at all.
    expect(contactAvg.impacts).toBeGreaterThan(0)
    // Contact is the hard case: corrections are expected, but must stay
    // bounded rather than throwing a car across the track.
    expect(contactAvg.guestSnapP95).toBeLessThan(3)
  }, 30_000)
})

function averagedWith(track: Track, c: RoomConfig, opts: NetsimOptions): NetsimReport {
  const runs = [3, 7, 19, 41].map((seed) => runNetsim(track, c, { ...opts, seed }))
  const mean = (k: keyof NetsimReport): number => +(runs.reduce((a, r) => a + r[k], 0) / runs.length).toFixed(3)
  return { guestSnapP95: mean('guestSnapP95'), guestSnapMax: mean('guestSnapMax'), guestViewErrorP95: mean('guestViewErrorP95'), hostViewErrorP95: mean('hostViewErrorP95'), guestInputDelayMs: Math.round(mean('guestInputDelayMs')), impacts: Math.round(mean('impacts')) }
}

