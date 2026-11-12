import { finishBuild } from './buildScheduler'
import type { Track, TrackKerb } from '../core/track'

export const KERB_CURVATURE = 0.0045
export const KERB_WIDTH = 1.1
export const KERB_ACROSS = 16
export const KERB_ALONG = 3
export interface SurfacePoint { x: number; y: number; height: number }

interface KerbSpan {
  side: number
  from: number
  to: number
  starts: boolean
  stops: boolean
  stripe: number
  steps: number
  across: number
  run?: TrackKerb
  lapOffset?: number
}

/** The mesh and wheel contact use the same cut points, including stripe seams. */
export function kerbSpans(track: Track, i: number, begin: number): KerbSpan[] {
  const length = track.segLenAt(i)
  if (!track.kerbs) {
    if (track.curvature[i]! <= KERB_CURVATURE) return []
    const starts = track.curvature[(i + track.n - 1) % track.n]! <= KERB_CURVATURE
    const stops = track.curvature[(i + 1) % track.n]! <= KERB_CURVATURE
    return [1, -1].map(side => ({
      side, from: 0, to: 1, starts, stops, stripe: Math.floor(i / 2), steps: KERB_ALONG, across: KERB_ACROSS,
    }))
  }

  const spans: KerbSpan[] = []
  const stripeLength = 3
  for (const run of track.kerbs) {
    const lapOffset = run.end > track.length && begin < run.end - track.length ? track.length : 0
    const end = Math.min(begin + length, run.end - lapOffset)
    let start = Math.max(begin, run.start - lapOffset)
    while (start < end - 1e-8) {
      const stripe = Math.floor((start + lapOffset - run.start + 1e-8) / stripeLength)
      const stop = Math.min(end, run.start - lapOffset + (stripe + 1) * stripeLength)
      spans.push({
        side: run.side, from: (start - begin) / length, to: (stop - begin) / length,
        starts: Math.abs(start + lapOffset - run.start) < 1e-7,
        stops: Math.abs(stop + lapOffset - run.end) < 1e-7,
        stripe, steps: Math.max(1, Math.ceil((stop - start) / 1.5)), across: 8, run, lapOffset,
      })
      start = stop
    }
  }
  return spans
}

/** Shared by concrete geometry and wheel contact; no independent bump approximation. */
export function kerbPoint(track: Track, i: number, begin: number, side: number, t: number, u: number, span?: KerbSpan): SurfacePoint {
  const j = (i + 1) % track.n, previous = (i + track.n - 1) % track.n
  const distance = begin + t * track.segLenAt(i)
  const smooth = (v: number): number => v * v * (3 - 2 * v)
  const run = span?.run
  const station = distance + (span?.lapOffset ?? 0)
  const taper = run
    ? smooth(Math.max(0, Math.min(1, (station - run.start) / 3, (run.end - station) / 3)))
    : (track.curvature[previous]! <= KERB_CURVATURE ? smooth(t) : 1)
      * (track.curvature[j]! <= KERB_CURVATURE ? smooth(1 - t) : 1)
  const width = run?.width ?? KERB_WIDTH
  const di = side * (track.halfRing[i]! + width * u)
  const dj = side * (track.halfRing[j]! + width * u)
  const xi = track.cx[i]! + track.edgeNormalX(i) * di, yi = track.cy[i]! + track.edgeNormalY(i) * di
  const xj = track.cx[j]! + track.edgeNormalX(j) * dj, yj = track.cy[j]! + track.edgeNormalY(j) * dj
  const crossSection = Math.max(0, Math.sin(Math.PI * u))
  let height: number
  if (run) height = run.height * crossSection
  else {
    const wave = (frequency: number, phase: number): number =>
      0.5 + 0.5 * Math.sin(distance / track.length * Math.PI * 2 * frequency + phase + side * 2.7)
    const frequency = Math.max(1, Math.round(track.length / 65))
    const crown = 0.050 + 0.042 * wave(frequency, 0.4)
    const roundness = 0.65 + 0.85 * wave(frequency + 3, 1.8)
    const bias = (wave(frequency + 1, 4.2) - 0.5) * 0.7
    height = crown * Math.pow(crossSection, roundness) * (1 + bias * (2 * u - 1))
  }
  return { x: xi + (xj - xi) * t, y: yi + (yj - yi) * t, height: 0.008 + height * taper }
}

/** Static spatial buckets of the exact rendered top triangles. */
export class TrackSurface {
  private readonly cells = new Map<string, [SurfacePoint, SurfacePoint, SurfacePoint][]>()
  constructor(track: Track, deferred = false) {
    if (!deferred) finishBuild(this.populate(track))
  }
  static *buildSteps(track: Track): Generator<void, TrackSurface> {
    const surface = new TrackSurface(track, true)
    yield* surface.populate(track)
    return surface
  }
  private *populate(track: Track): Generator<void, void> {
    let begin = 0
    const add = (a: SurfacePoint, b: SurfacePoint, c: SurfacePoint): void => {
      const triangle: [SurfacePoint, SurfacePoint, SurfacePoint] = [a,b,c]
      for (let x = Math.floor(Math.min(a.x,b.x,c.x)/4); x <= Math.floor(Math.max(a.x,b.x,c.x)/4); x++) {
        for (let y = Math.floor(Math.min(a.y,b.y,c.y)/4); y <= Math.floor(Math.max(a.y,b.y,c.y)/4); y++) {
          const key = x + ',' + y, cell = this.cells.get(key) ?? []
          cell.push(triangle); this.cells.set(key,cell)
        }
      }
    }
    for (let i=0;i<track.n;i++) {
      if (i % 4 === 0) yield
      for (const span of kerbSpans(track, i, begin)) {
        const point = (l: number, c: number): SurfacePoint => {
          const t = span.from + (span.to - span.from) * l / span.steps
          return kerbPoint(track, i, begin, span.side, t, c / span.across, span)
        }
        for (let l=0;l<span.steps;l++) for (let c=0;c<span.across;c++) {
          const a = point(l, c), b = point(l + 1, c)
          const d = point(l, c + 1), e = point(l + 1, c + 1)
          add(a,e,b); add(a,d,e)
        }
      }
      begin += track.segLenAt(i)
    }
  }
  heightAt(x: number, y: number): number {
    let height = 0
    const cell = this.cells.get(Math.floor(x/4)+','+Math.floor(y/4))
    if (!cell) return height
    for (const [a,b,c] of cell) {
      const bx=b.x-a.x, by=b.y-a.y, cx=c.x-a.x, cy=c.y-a.y
      const det=bx*cy-by*cx
      if (Math.abs(det)<1e-10) continue
      const u=((x-a.x)*cy-(y-a.y)*cx)/det, v=(bx*(y-a.y)-by*(x-a.x))/det
      if (u>=-1e-7 && v>=-1e-7 && u+v<=1+1e-7) height=Math.max(height,a.height+(b.height-a.height)*u+(c.height-a.height)*v)
    }
    return height
  }
}
