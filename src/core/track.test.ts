/**
 * Parity: the TypeScript track geometry against the Python track geometry.
 *
 * The TS ``Track`` is handed only the centreline and the half-width ring, and
 * rebuilds segment vectors, arc lengths, normals and curvature itself. That is
 * the right call — exporting derived data would just add something else that can
 * drift — but it means the rebuild has to be pinned, which is what this does.
 *
 * ``project`` gets the most attention because the game leans on it hardest: it
 * decides whether a wheel is off the road (and therefore whether the lap counts)
 * and where the car is round the lap (and therefore when the lap ends).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { Track, type TrackData } from './track'

interface TrackFixture {
  id: string
  length: number
  half: number
  n: number
  queries: { x: number; y: number; s: number; lateral: number; heading: number; segment: number; half: number }[]
  poses: { s: number; x: number; y: number; yaw: number }[]
  curvatures: { s: number; k: number; half: number }[]
}

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL('./__fixtures__/tracks.json', import.meta.url)), 'utf-8'),
) as TrackFixture[]

function loadBaked(id: string): Track {
  const path = fileURLToPath(new URL(`../../public/tracks/${id}.json`, import.meta.url))
  return new Track(JSON.parse(readFileSync(path, 'utf-8')) as TrackData)
}

describe('track geometry matches Python', () => {
  for (const fx of fixtures) {
    describe(fx.id, () => {
      const track = loadBaked(fx.id)

      it('derives the same lap length, width and vertex count', () => {
        expect(track.n).toBe(fx.n)
        expect(Math.abs(track.length - fx.length)).toBeLessThan(1e-9)
        expect(Math.abs(track.half - fx.half)).toBeLessThan(1e-12)
      })

      it('projects every query point to the same place', () => {
        for (const q of fx.queries) {
          const p = track.project(q.x, q.y)
          // The segment index must match exactly. It is a discrete choice, so a
          // near-miss here is not a small error — it means the two sides picked
          // different pieces of road, and everything downstream is wrong.
          expect(p.segment, `segment at (${q.x}, ${q.y})`).toBe(q.segment)
          expect(Math.abs(p.s - q.s), 's').toBeLessThan(1e-9)
          expect(Math.abs(p.lateral - q.lateral), 'lateral').toBeLessThan(1e-9)
          expect(Math.abs(p.heading - q.heading), 'heading').toBeLessThan(1e-12)
          expect(Math.abs(p.half - q.half), 'half').toBeLessThan(1e-12)
        }
      })

      it('agrees on pose_at, including beyond and behind the lap', () => {
        for (const e of fx.poses) {
          const p = track.poseAt(e.s)
          expect(Math.abs(p.x - e.x), `x at s=${e.s}`).toBeLessThan(1e-9)
          expect(Math.abs(p.y - e.y), `y at s=${e.s}`).toBeLessThan(1e-9)
          expect(Math.abs(p.yaw - e.yaw), `yaw at s=${e.s}`).toBeLessThan(1e-12)
        }
      })

      it('agrees on curvature and half-width along the lap', () => {
        for (const e of fx.curvatures) {
          expect(Math.abs(track.signedCurvatureAt(e.s) - e.k), `k at s=${e.s}`).toBeLessThan(1e-12)
          expect(Math.abs(track.halfAt(e.s) - e.half), `half at s=${e.s}`).toBeLessThan(1e-12)
        }
      })
    })
  }
})

describe('sector timing lines', () => {
  it('keeps equal thirds as the fallback for existing baked tracks', () => {
    const track = loadBaked('balanced_8')
    expect(track.sectorBoundaries[0]).toBeCloseTo(track.length / 3, 9)
    expect(track.sectorBoundaries[1]).toBeCloseTo((track.length * 2) / 3, 9)
  })

  it('uses Silverstone\'s authored FIA sector positions', () => {
    const track = loadBaked('silverstone')
    expect(track.sectorBoundaries).toEqual([1799.6, 4247.2])
    expect(track.sectorAt(1799.5)).toBe(0)
    expect(track.sectorAt(1799.6)).toBe(1)
    expect(track.sectorAt(4247.1)).toBe(1)
    expect(track.sectorAt(4247.2)).toBe(2)
  })
})
