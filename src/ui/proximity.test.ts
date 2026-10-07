import { describe, expect, it } from 'vitest'
import { handlingPreset } from '../core/carParams'
import { Track } from '../core/track'
import { proximityMarkers } from './proximity'

const params = handlingPreset('legacy')
const player = { x: 0, y: 0, yaw: 0 }
const rival = (x: number, y: number, slot = 1, yaw = 0) => ({ slot, params, state: { x, y, yaw } })
const track = new Track({ id: 'parallel', label: 'Parallel straights', blurb: '', profile: '',
  seed: 0, width: 16, length: 236,
  centerline: [[0, 0], [100, 0], [100, 18], [0, 18]],
  halfRing: [8, 8, 8, 8], brakeMarkers: [] })

describe('race proximity', () => {
  it('hides cars clearly ahead, including a visible car directly in front', () => {
    expect(proximityMarkers(player, params, [rival(10, 3), rival(3, 0)])).toEqual([])
  })
  it('shows white warnings behind and red warnings for either overlapping side', () => {
    const markers = proximityMarkers(player, params, [rival(-12, 0), rival(1, -3, 2), rival(-1, 3, 3)])
    expect(markers.map((m) => m.alongside)).toEqual([false, true, true])
    expect(Math.abs(markers[0]!.bearing)).toBeCloseTo(Math.PI)
    expect(markers[1]!.bearing).toBeGreaterThan(0)
    expect(markers[2]!.bearing).toBeLessThan(0)
  })
  it('turns white again when the rival falls behind our rear bumper', () => {
    expect(proximityMarkers(player, params, [rival(-7, -3)])[0]!.alongside).toBe(false)
  })
  it('does not mark distant cars', () => {
    expect(proximityMarkers(player, params, [rival(-30, 0), rival(-2, 30)])).toEqual([])
  })
  it('shows red across the full road width when the cars overlap front-to-back', () => {
    const left = { x: 50, y: 7, yaw: 0 }
    const markers = proximityMarkers(left, params, [rival(51, -7)], false, track)
    expect(markers).toHaveLength(1)
    expect(markers[0]!.alongside).toBe(true)
    expect(markers[0]!.bearing).toBeGreaterThan(0)
    expect(proximityMarkers({ x: 50, y: -7, yaw: 0 }, params,
      [rival(49, 7)], false, track)[0]!.alongside).toBe(true)
  })
  it('keeps a white rear warning across the road after longitudinal overlap ends', () => {
    const markers = proximityMarkers({ x: 50, y: 7, yaw: 0 }, params,
      [rival(40, -7)], false, track)
    expect(markers).toHaveLength(1)
    expect(markers[0]!.alongside).toBe(false)
  })
  it('uses local road width instead of a circular range on especially wide straights', () => {
    const wideTrack = new Track({ id: 'wide', label: 'Wide straight', blurb: '', profile: '',
      seed: 0, width: 28, length: 280,
      centerline: [[0, 0], [100, 0], [100, 40], [0, 40]],
      halfRing: [14, 14, 14, 14], brakeMarkers: [] })
    const markers = proximityMarkers({ x: 50, y: 13, yaw: 0 }, params,
      [rival(51, -13)], false, wideTrack)
    expect(markers).toHaveLength(1)
    expect(markers[0]!.alongside).toBe(true)
  })
  it('uses circuit progress to reject a nearby car on another track section', () => {
    expect(proximityMarkers({ x: 50, y: 0, yaw: 0 }, params,
      [rival(50, 18, 1, Math.PI)], false, track)).toEqual([])
  })
  it('recognises nearby cars across the start-finish wrap', () => {
    const nearLine = { x: 0, y: 2, yaw: -Math.PI / 2 }
    const markers = proximityMarkers(nearLine, params, [rival(2, 0)], false, track)
    expect(markers).toHaveLength(1)
  })
  it('keeps distinct markers for multiple rivals, including directly behind', () => {
    const markers = proximityMarkers(player, params, [rival(-12, -1), rival(-16, 1, 2), rival(0, -3, 3)])
    expect(markers.map((m) => m.slot)).toEqual([1, 2, 3])
  })
  it('keeps bearings relative to the player when turning', () => {
    const markers = proximityMarkers({ ...player, yaw: Math.PI / 2 }, params,
      [rival(3, 0, 1, Math.PI / 2), rival(0, -12, 2, Math.PI / 2)])
    expect(markers[0]!.alongside).toBe(true)
    expect(markers[0]!.bearing).toBeCloseTo(Math.PI / 2)
    expect(markers[1]!.bearing).toBeCloseTo(Math.PI)
  })
  it('reverses the warning directions and visible cone when looking back', () => {
    const markers = proximityMarkers(player, params, [rival(-12, 0), rival(0, -3, 2)], true)
    expect(markers).toHaveLength(1)
    expect(markers[0]!.alongside).toBe(true)
    expect(markers[0]!.bearing).toBeCloseTo(-Math.PI / 2)
  })
  it('uses the rival body orientation when deciding if it still overlaps', () => {
    expect(proximityMarkers(player, params, [rival(3.9, -3, 1, Math.PI / 2)])).toEqual([])
    expect(proximityMarkers(player, params, [rival(3.9, -3)])[0]!.alongside).toBe(true)
  })
})
