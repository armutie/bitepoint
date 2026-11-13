import type { CarState } from '../core/car'
import type { Track } from '../core/track'
import { PhysicsWorld } from './physics'
import { IDLE, type InputFrame, type RoomConfig, type Slot, type Snapshot } from './protocol'
import { DT } from '../core/sim'

/**
 * How far ahead the host should draw the guest's car. The guest's inputs take
 * about half a round trip to arrive and then wait about one tick in the
 * authority's queue, so the authoritative guest car is that far behind the
 * guest's own screen. Measured in netsim.test.ts: at Canada-USA latency the
 * host's view of the guest goes from 2.9 m out (p95) to 0.7 m.
 * Below 10 ms there is nothing to hide, and a tick of lead would overshoot.
 */
export function hostLeadTicks(rttMs: number): number {
  if (!(rttMs >= 10)) return 0
  return Math.round(rttMs / 2 / (DT * 1000)) + 1
}

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
  private scratch: PhysicsWorld|null=null
  /**
   * Car states to draw, with the other driver's car carried `lead` ticks
   * further forward on its last known input.
   *
   * The guest needs no lead: replaying its own unacknowledged inputs already
   * carries the host's car forward by about a round trip. The host replays
   * almost nothing, so without a lead it draws the guest where the guest was
   * a network trip ago — behind where the guest sees themselves. Display only:
   * the simulated world is untouched.
   */
  display(lead=0): CarState[] {
    const states=this.states.map(s=>({...s}))
    if(lead<=0||!this.live)return states
    this.scratch??=new PhysicsWorld(this.world.track,this.world.config)
    this.scratch.restore(states)
    const actions=[{...this.remote,shift:0},{...this.remote,shift:0}]
    for(let i=0;i<Math.min(lead,30);i++)this.scratch.step(actions,true)
    const other=1-this.slot
    states[other]={...this.scratch.cars[other]!.s}
    return states
  }
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
