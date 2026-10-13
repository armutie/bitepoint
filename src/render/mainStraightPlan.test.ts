import { describe, it, expect } from 'vitest'
import { Track, type TrackData } from '../core/track'
import { clearOfCircuit } from '../core/placement'
import { buildTerrain } from './terrain'
import { planMainStraight } from './mainStraightPlan'
import croft from '../../public/tracks/power_8.json'
import silverstone from '../../public/tracks/silverstone.json'
import technical from '../../public/tracks/technical_8.json'

describe('main straight architecture footprints', () => {
  for (const data of [croft, silverstone, technical]) it('reserves roofs and supports clear of every road on ' + data.label, () => {
    const track = new Track(data as TrackData), terrain = buildTerrain(track), plan = planMainStraight(track, terrain)
    expect(plan).toEqual(planMainStraight(track, terrain))
    if (!plan) { expect(terrain.runs.some(r => r.s0 < 32 && r.len > 110)).toBe(false); return }
    expect(plan.sites.some(s => s.kind === 'pit')).toBe(true)
    expect(plan.sites.some(s => s.kind === 'stand')).toBe(true)
    expect(plan.bridge).toBeGreaterThan(plan.start + 30)
    expect(plan.bridge).toBeLessThan(plan.end - 30)
    for (const site of plan.sites) {
      for (const u of [-0.5, -0.25, 0, 0.25, 0.5]) for (const v of [-0.5, 0, 0.5]) {
        const x = site.x + Math.cos(site.yaw) * u * (site.length + 2) - Math.sin(site.yaw) * v * (site.depth + 3)
        const y = site.y + Math.sin(site.yaw) * u * (site.length + 2) + Math.cos(site.yaw) * v * (site.depth + 3)
        expect(clearOfCircuit(track, x, y, 0.25)).toBe(true)
      }
      for (const arc of [site.arc - site.length / 2, site.arc, site.arc + site.length / 2]) expect(Math.abs(track.signedCurvatureAt(arc))).toBeLessThan(0.003)
    }
  })
})
