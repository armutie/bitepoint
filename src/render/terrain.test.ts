import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { Track, type TrackData } from '../core/track'
import { buildTerrain } from './terrain'

function loadTrack(id: string): Track {
  const path = fileURLToPath(new URL(`../../public/tracks/${id}.json`, import.meta.url))
  return new Track(JSON.parse(readFileSync(path, 'utf-8')) as TrackData)
}

describe('terrain road clearance', () => {
  it('keeps Croft Bay grass below the tarmac around the sector-three berm', () => {
    const track = loadTrack('power_8')
    const terrain = buildTerrain(track)

    for (let s = 1660; s <= 1860; s += 2) {
      const pose = track.poseAt(s)
      const half = track.halfAt(s)
      for (const fraction of [-1, -0.5, 0, 0.5, 1]) {
        const lateral = half * fraction
        const x = pose.x - Math.sin(pose.yaw) * lateral
        const y = pose.y + Math.cos(pose.yaw) * lateral
        expect(terrain.height(x, y), `ground at s=${s}, lateral=${lateral}`).toBeLessThan(1e-9)
      }
    }

    // The roadward tail is clipped, but the spectator bank itself remains.
    const corner = terrain.corners.find((c) => Math.abs(c.s - 1782) < 3)!
    const pose = track.poseAt(corner.s)
    const lateral = -Math.sign(corner.k) * (track.halfAt(corner.s) + 30)
    const x = pose.x - Math.sin(pose.yaw) * lateral
    const y = pose.y + Math.cos(pose.yaw) * lateral
    expect(terrain.height(x, y)).toBeGreaterThan(4)
  })

  it('keeps the Silverstone Becketts ground cell flat beside the road', () => {
    const track = loadTrack('silverstone')
    const terrain = buildTerrain(track)

    // A coarse ground vertex about 14 m beyond the left edge used to inherit
    // 60 cm of the spectator bank. Its triangle bridged that height back across
    // the tarmac around s=4028, exposing a grass wedge on the driving surface.
    for (let s = 3980; s <= 4080; s += 2) {
      const pose = track.poseAt(s)
      const half = track.halfAt(s)
      for (const beyond of [0, 6, 12, 18]) {
        const lateral = half + beyond
        const x = pose.x - Math.sin(pose.yaw) * lateral
        const y = pose.y + Math.cos(pose.yaw) * lateral
        expect(terrain.height(x, y), `ground at s=${s}, beyond=${beyond}`).toBeLessThan(1e-9)
      }
    }

    // The fix trims only the inward tail; the bank itself remains.
    const corner = terrain.corners.find((candidate) => Math.abs(candidate.s - 4032) < 3)!
    const pose = track.poseAt(corner.s)
    const lateral = -Math.sign(corner.k) * (track.halfAt(corner.s) + 30)
    const x = pose.x - Math.sin(pose.yaw) * lateral
    const y = pose.y + Math.cos(pose.yaw) * lateral
    expect(terrain.height(x, y)).toBeGreaterThan(4)
  })
})
