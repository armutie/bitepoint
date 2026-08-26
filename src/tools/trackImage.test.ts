import { describe, expect, it } from 'vitest'
import { Track } from '../core/track'
import {
  bakeTrack,
  extractLoopFromMask,
  isClockwise,
  perimeter,
  pixelMatches,
  type ImagePoint,
  type TrackExtraction,
} from './trackImage'

describe('track image masking', () => {
  it('keeps sector colours while rejecting map annotations', () => {
    expect(pixelMatches(255, 25, 25, 'coloured')).toBe(true)
    expect(pixelMatches(255, 220, 0, 'coloured')).toBe(true)
    expect(pixelMatches(0, 190, 245, 'coloured')).toBe(true)
    expect(pixelMatches(0, 235, 25, 'coloured')).toBe(false)
    expect(pixelMatches(250, 0, 240, 'coloured')).toBe(false)
    expect(pixelMatches(240, 240, 240, 'coloured')).toBe(false)
    expect(pixelMatches(240, 240, 240, 'bright')).toBe(true)
    expect(pixelMatches(28, 31, 42, 'dark-road')).toBe(true)
    expect(pixelMatches(0, 0, 0, 'black-line')).toBe(true)
    expect(pixelMatches(240, 240, 240, 'black-line')).toBe(false)
    expect(pixelMatches(158, 158, 158, 'black-line')).toBe(false)
  })
})

describe('track image topology', () => {
  it('reduces a thick reference ribbon to one closed centreline', () => {
    const width = 180
    const height = 120
    const mask = new Uint8Array(width * height)
    const cx = 90
    const cy = 60
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const radius = Math.hypot((x - cx) / 1.45, y - cy)
        if (radius >= 37 && radius <= 45) mask[y * width + x] = 1
      }
    }
    // Disconnected label-like noise must not become part of the circuit.
    for (let y = 8; y < 13; y++) for (let x = 8; x < 18; x++) mask[y * width + x] = 1

    const result = extractLoopFromMask(mask, width, height, { closeRadius: 1, smoothing: 3 })
    expect(result.loop.length).toBeGreaterThan(180)
    expect(perimeter(result.loop)).toBeGreaterThan(250)
    expect(Math.min(...result.loop.map((point) => point.x))).toBeGreaterThan(20)
    expect(Math.max(...result.loop.map((point) => point.x))).toBeLessThan(160)
  })

  it('closes an interrupted guide as a straight start line', () => {
    const width = 180
    const height = 120
    const mask = new Uint8Array(width * height)
    for (let y = 16; y <= 104; y++) {
      for (let x = 20; x <= 160; x++) {
        const onHorizontal = (y <= 23 || y >= 97) && x >= 20 && x <= 160
        const onVertical = (x <= 27 || x >= 153) && y >= 16 && y <= 104
        if (onHorizontal || onVertical) mask[y * width + x] = 1
      }
    }
    for (let y = 12; y <= 28; y++) for (let x = 86; x <= 94; x++) mask[y * width + x] = 0

    const extraction = extractLoopFromMask(mask, width, height, { closeRadius: 0, smoothing: 4 })
    const result = bakeTrack(extraction, {
      id: 'open_ring',
      label: 'Open Ring',
      blurb: '',
      targetLength: 2400,
      roadWidth: 14,
      corners: 4,
      start: { x: 90, y: 20 },
      clockwise: true,
      sampleSpacing: 4,
    })
    const points = result.track.centerline
    const turns: number[] = []
    for (let i = -10; i <= 10; i++) {
      const a = points[(i - 1 + points.length) % points.length]!
      const b = points[(i + points.length) % points.length]!
      const c = points[(i + 1 + points.length) % points.length]!
      const h0 = Math.atan2(b[1] - a[1], b[0] - a[0])
      const h1 = Math.atan2(c[1] - b[1], c[0] - b[0])
      turns.push(Math.abs(Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0))))
    }
    expect(Math.max(...turns)).toBeLessThan(0.01)
  })
})

describe('track baking', () => {
  it('sets start, direction, dimensions, and game-ready geometry', () => {
    const loop: ImagePoint[] = [
      { x: 10, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 50 },
      { x: 10, y: 50 },
    ]
    const extraction: TrackExtraction = {
      width: 100,
      height: 60,
      mask: new Uint8Array(6000),
      skeleton: new Uint8Array(6000),
      loop,
      diagnostics: { selectedPixels: 0, skeletonPixels: 0, loopPixels: 4 },
    }
    const result = bakeTrack(extraction, {
      id: 'test_ring',
      label: 'Test Ring',
      blurb: '',
      targetLength: 2400,
      roadWidth: 14,
      corners: 4,
      start: { x: 89, y: 49 },
      clockwise: false,
      sampleSpacing: 4,
    })

    expect(result.track.length).toBeCloseTo(2400, 3)
    expect(result.track.centerline).toHaveLength(600)
    expect(result.track.halfRing.every((half) => half === 7)).toBe(true)
    expect(result.manifest.outline).toHaveLength(150)
    expect(isClockwise(loop)).not.toBe(isClockwise(result.track.centerline.map(([x, y]) => ({ x, y: -y }))))
    const runtime = new Track(result.track)
    expect(runtime.length).toBeCloseTo(2400, 3)
    expect(Number.isFinite(runtime.cx[0])).toBe(true)
  })
})
