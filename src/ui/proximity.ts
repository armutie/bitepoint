import type { CarState } from '../core/car'
import { carLength, type CarParams } from '../core/carParams'
import type { Track } from '../core/track'

type Pose = Pick<CarState, 'x' | 'y' | 'yaw'>
type Dimensions = CarParams

export interface ProximityRival {
  slot: number
  state: Pose
  params: Dimensions
}

export interface ProximityMarker {
  slot: number
  /** Screen bearing: zero above, pi/2 right, pi behind. */
  bearing: number
  alongside: boolean
}

/** Nearby real cars only; a ghost never constitutes an overlap warning. */
export function proximityMarkers(
  player: Pose,
  params: Dimensions,
  rivals: readonly ProximityRival[],
  lookBack = false,
  track?: Track,
): ProximityMarker[] {
  const markers: ProximityMarker[] = []
  const cos = Math.cos(player.yaw), sin = Math.sin(player.yaw)
  const playerRoad = track?.project(player.x, player.y)
  for (const rival of rivals) {
    const dx = rival.state.x - player.x, dy = rival.state.y - player.y
    const forward = dx * cos + dy * sin
    const right = dx * sin - dy * cos
    if (Math.abs(forward) > 22) continue
    const rivalRoad = track?.project(rival.state.x, rival.state.y)
    if (track && playerRoad && rivalRoad) {
      const separation = Math.abs(rivalRoad.s - playerRoad.s)
      if (Math.min(separation, track.length - separation) > 22) continue
    }
    // Project the rival's body onto our axes, including angled cars in bends.
    const yaw = rival.state.yaw - player.yaw
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw))
    const length = carLength(params)
    const otherLength = carLength(rival.params)
    const overlapLength = (length + otherLength * c + rival.params.width * s) / 2
    const overlapWidth = (params.width + rival.params.width * c + otherLength * s) / 2
    // Cover the whole road: longitudinal overlap matters even across its width.
    const lateralRange = playerRoad && rivalRoad
      ? playerRoad.half + rivalRoad.half + overlapWidth
      : 18
    if (Math.abs(right) > lateralRange) continue
    const alongside = Math.abs(forward) <= overlapLength + 0.5
      && Math.abs(right) > params.width / 2
    const viewForward = lookBack ? -forward : forward
    const viewRight = lookBack ? -right : right
    // A car clearly ahead is already visible. Keep warnings for an overlapping
    // car even when its nose has edged ahead of ours.
    if (!alongside && viewForward > 0
      && (viewForward > overlapLength || Math.abs(viewRight) < viewForward * Math.tan(Math.PI / 5))) continue
    markers.push({ slot: rival.slot, bearing: Math.atan2(viewRight, viewForward), alongside })
  }
  return markers
}

/** Two open chevrons, without a shaft, kept around the lower driving view. */
export class Proximity {
  readonly root = document.createElement('div')
  private readonly markers = new Map<number, HTMLElement>()

  constructor() {
    this.root.className = 'hud-proximity'
    this.root.setAttribute('aria-hidden', 'true')
  }

  update(markers: readonly ProximityMarker[]): void {
    const occupied: number[] = []
    for (const marker of markers) {
      let node = this.markers.get(marker.slot)
      if (!node) {
        node = document.createElement('div')
        node.className = 'hud-proximity-marker'
        node.innerHTML = '<svg viewBox="0 0 48 44"><path d="M7 13 L24 30 L41 13 M7 3 L24 20 L41 3"/></svg>'
        this.markers.set(marker.slot, node)
        this.root.append(node)
      }
      // Cars on nearly the same bearing get separate concentric marks.
      const stack = occupied.filter((angle) => Math.cos(angle - marker.bearing) > 0.98).length
      occupied.push(marker.bearing)
      const inset = Math.min(stack, 3) * 22
      const x = Math.sin(marker.bearing), y = -Math.cos(marker.bearing)
      node.style.left = `calc(50% + ${x * 50}% - ${x * inset}px)`
      node.style.top = `calc(50% + ${y * 50}% - ${y * inset}px)`
      node.style.transform = `translate(-50%, -50%) rotate(${marker.bearing - Math.PI}rad)`
      node.classList.toggle('is-alongside', marker.alongside)
      node.classList.remove('is-hidden')
    }
    for (const [slot, node] of this.markers) {
      if (!markers.some((marker) => marker.slot === slot)) node.classList.add('is-hidden')
    }
  }
}
