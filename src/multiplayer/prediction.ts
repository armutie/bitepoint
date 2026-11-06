import type { CarState } from '../core/car'
import type { Track } from '../core/track'
import { PhysicsWorld } from './physics'
import { IDLE, type InputFrame, type RoomConfig, type Slot, type Snapshot } from './protocol'

/** Bounded whole-scene rollback for two cars, without replaying scoring or audio. */
export class Predictor {
  readonly world: PhysicsWorld
  private pending: InputFrame[]=[]
  private tick=-1
  private remote: InputFrame={...IDLE}
  private live=false
  sequence=0
  correction=0
  constructor(track: Track,config: RoomConfig,readonly slot: Slot) {this.world=new PhysicsWorld(track,config)}
  get queueSize(): number {return this.pending.length}
  get states(): CarState[] {return this.world.cars.map(c=>c.s)}
  frame(steer:number,throttle:number,shift:number,tcLevel:number): InputFrame {
    const f={seq:++this.sequence,steer,throttle,shift,tcLevel}
    this.pending.push(f)
    if(this.pending.length>120)this.pending.shift()
    this.advance(f);return f
  }
  batch(): InputFrame[] {return this.pending.slice(-30)}
  private advance(f: InputFrame): void {
    const actions=[{...this.remote,shift:0},{...this.remote,shift:0}]
    actions[this.slot]=f;this.world.step(actions,this.live)
  }
  reconcile(s:Snapshot): boolean {
    if(s.tick<=this.tick)return false
    this.tick=s.tick;this.live=s.phase==='racing'||s.phase==='finished'
    this.remote={...s.actions[1-this.slot]!,shift:0}
    this.pending=this.pending.filter(f=>f.seq>s.ack[this.slot]!)
    const before={...this.world.cars[this.slot]!.s}
    this.world.restore(s.cars)
    for(const f of this.pending)this.advance(f)
    const after=this.world.cars[this.slot]!.s
    this.correction=Math.hypot(before.x-after.x,before.y-after.y)
    return true
  }
}
