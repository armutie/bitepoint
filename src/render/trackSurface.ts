import type { Track } from '../core/track'

export const KERB_CURVATURE = 0.0045
export const KERB_WIDTH = 1.1
export const KERB_ACROSS = 16
export const KERB_ALONG = 3
export interface SurfacePoint { x: number; y: number; height: number }

/** Shared by concrete geometry and wheel contact; no independent bump approximation. */
export function kerbPoint(track: Track, i: number, begin: number, side: number, t: number, u: number): SurfacePoint {
  const j = (i + 1) % track.n, previous = (i + track.n - 1) % track.n
  const distance = begin + t * track.segLenAt(i)
  const wave = (frequency: number, phase: number): number =>
    0.5 + 0.5 * Math.sin(distance / track.length * Math.PI * 2 * frequency + phase + side * 2.7)
  const frequency = Math.max(1, Math.round(track.length / 65))
  const crown = 0.050 + 0.042 * wave(frequency, 0.4)
  const roundness = 0.65 + 0.85 * wave(frequency + 3, 1.8)
  const bias = (wave(frequency + 1, 4.2) - 0.5) * 0.7
  const arch = Math.pow(Math.max(0, Math.sin(Math.PI * u)), roundness) * (1 + bias * (2 * u - 1))
  const smooth = (v: number): number => v * v * (3 - 2 * v)
  const taper = (track.curvature[previous]! <= KERB_CURVATURE ? smooth(t) : 1)
    * (track.curvature[j]! <= KERB_CURVATURE ? smooth(1 - t) : 1)
  const di = side * (track.halfRing[i]! + KERB_WIDTH * u)
  const dj = side * (track.halfRing[j]! + KERB_WIDTH * u)
  const xi = track.cx[i]! + track.normalX(i) * di, yi = track.cy[i]! + track.normalY(i) * di
  const xj = track.cx[j]! + track.normalX(j) * dj, yj = track.cy[j]! + track.normalY(j) * dj
  return { x: xi + (xj - xi) * t, y: yi + (yj - yi) * t, height: 0.008 + crown * arch * taper }
}

/** Static spatial buckets of the exact rendered top triangles. */
export class TrackSurface {
  private readonly cells = new Map<string, [SurfacePoint, SurfacePoint, SurfacePoint][]>()
  constructor(track: Track) {
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
      if (track.curvature[i]! > KERB_CURVATURE) for (const side of [-1,1]) {
        for (let l=0;l<KERB_ALONG;l++) for (let c=0;c<KERB_ACROSS;c++) {
          const a=kerbPoint(track,i,begin,side,l/KERB_ALONG,c/KERB_ACROSS)
          const b=kerbPoint(track,i,begin,side,(l+1)/KERB_ALONG,c/KERB_ACROSS)
          const d=kerbPoint(track,i,begin,side,l/KERB_ALONG,(c+1)/KERB_ACROSS)
          const e=kerbPoint(track,i,begin,side,(l+1)/KERB_ALONG,(c+1)/KERB_ACROSS)
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
