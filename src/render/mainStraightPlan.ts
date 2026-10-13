import type { Track } from '../core/track'
import { clearOfCircuit, pointAt, safeOutsideBox } from '../core/placement'
import type { Terrain } from './terrain'

export interface StraightSite {
  arc: number; x: number; y: number; yaw: number; side: number
  length: number; depth: number; kind: 'pit' | 'stand'
}
export interface MainStraightPlan { start: number; end: number; bridge: number; sites: StraightSite[] }

/** Reserve real footprints, including roof overhangs, before building scenery. */
export function planMainStraight(track: Track, terrain: Pick<Terrain,'runs'>): MainStraightPlan | null {
  const run = terrain.runs.find(r => r.s0 < 32 && r.len > 110)
  if (!run) return null
  const start = run.s0 + 8, end = Math.min(run.s1 - 20, start + 286)
  const sites: StraightSite[] = []
  for (let arc = start + 12; arc + 12 <= end; arc += 26) {
    for (const side of [-1, 1]) {
      const kind = side < 0 ? 'pit' : 'stand'
      // Tight infields get a smaller stand, never a squeezed footprint on another road.
      for (const depth of kind === 'pit' ? [22] : [13, 9, 6]) {
        const length = kind === 'pit' ? 26 : 24, off = safeOutsideBox(track, arc, side, depth / 2 + 3.0, length + 2, depth + 3)
        if (off === null) continue
        const p = pointAt(track, arc, off), yaw = track.poseAt(arc).yaw
        let clear = true
        for (const u of [-0.5, -0.25, 0, 0.25, 0.5]) for (const v of [-0.5, 0, 0.5]) {
          const x = p.x + Math.cos(yaw) * u * (length + 2) - Math.sin(yaw) * v * (depth + 3)
          const y = p.y + Math.sin(yaw) * u * (length + 2) + Math.cos(yaw) * v * (depth + 3)
          if (!clearOfCircuit(track, x, y, 0.25)) clear = false
        }
        if (!clear) continue
        sites.push({ arc, ...p, yaw, side, length, depth, kind }); break
      }
    }
  }
  if (!sites.some(s => s.kind === 'pit') || !sites.some(s => s.kind === 'stand')) return null
  return { start, end, bridge: start + (end - start) * 0.63, sites }
}
