import type { Track } from './track'

/** Shared geometry for the painted starting grid and time-attack staging. */
export const GRID_SPACING = 9.0
export const GRID_STAGGER = 2.6
export const GRID_STAGE_DIST = 12.0
export const GRID_SLOTS = 8

export interface GridPose {
  s: number
  x: number
  y: number
  yaw: number
  lateral: number
}

/** Centre pose of a zero-based painted grid slot. */
export function gridPose(track: Track, slot: number): GridPose {
  if (!Number.isInteger(slot) || slot < 0 || slot >= GRID_SLOTS) {
    throw new RangeError(`Grid slot ${slot} is outside 0..${GRID_SLOTS - 1}.`)
  }
  const s = track.length - (GRID_STAGE_DIST + slot * GRID_SPACING)
  const centre = track.poseAt(s)
  const lateral = (slot % 2 === 0 ? 1 : -1) * GRID_STAGGER
  return {
    s,
    x: centre.x - Math.sin(centre.yaw) * lateral,
    y: centre.y + Math.cos(centre.yaw) * lateral,
    yaw: centre.yaw,
    lateral,
  }
}
