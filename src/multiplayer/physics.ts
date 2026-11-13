import { Car, CURRENT_LOW_SPEED_CONTROLS, type CarState } from '../core/car'
import { Barriers } from '../core/barriers'
import { gridPose } from '../core/grid'
import { resolveCars } from '../core/collision'
import { DT, SUBSTEPS, OFF_TRACK_MARGIN, OFF_TRACK_GRIP, OFF_TRACK_ROLLING, withAbs } from '../core/sim'
import type { Track } from '../core/track'
import { IDLE, roomCarParams, type InputFrame, type RoomConfig } from './protocol'

/** Presentation-free vehicle world. Uses the same surface and wall ordering as Sim.
 * Scoring/recordings belong only to the authority, never to replayed predictions.
 */
export class PhysicsWorld {
  readonly cars: Car[]
  private readonly barriers: Barriers
  constructor(readonly track: Track, readonly config: RoomConfig) {
    this.barriers = new Barriers(track)
    this.cars = [0,1].map(slot => {
      const car = new Car(withAbs(roomCarParams(config),false))
      car.manual = config.manual; car.brakeAwareAuto = 2
      car.lowSpeedControls = CURRENT_LOW_SPEED_CONTROLS
      const p = gridPose(track,slot); car.setPose(p.x,p.y,p.yaw)
      return car
    })
  }
  restore(states: readonly CarState[]): void {
    this.cars.forEach((c,i) => { c.s = { ...states[i]! } })
  }
  step(actions: readonly InputFrame[], live: boolean): void {
    for (let i=0;i<2;i++) {
      const c=this.cars[i]!, a=actions[i] ?? IDLE, p=this.track.project(c.s.x,c.s.y)
      const grass=Math.abs(p.lateral)>p.half+OFF_TRACK_MARGIN
      c.tcLevel=a.tcLevel
      // Easy mode keeps full grip on the grass, as single player's easy mode does.
      c.step(live?a.steer:0,live?a.throttle:0,DT,SUBSTEPS,grass?(this.config.easy?1:OFF_TRACK_GRIP):1,grass?OFF_TRACK_ROLLING:1,live?a.shift:0)
      const after=this.track.project(c.s.x,c.s.y)
      if(this.barriers.mayTouch(after.lateral,c.p))this.barriers.resolve(c.s,c.p)
    }
    if(this.config.contact)resolveCars(this.cars)
  }
}
