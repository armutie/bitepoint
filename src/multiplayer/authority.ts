import { Race } from '../core/race'
import type { Track } from '../core/track'
import { IDLE, roomCarParams, validInput, type InputFrame, type RoomConfig, type Slot, type Snapshot } from './protocol'

/** One input queue per driver. Missing packets never stop the shared race clock. */
export class RaceAuthority {
  readonly race: Race
  tick = 0
  private queues = [new Map<number,InputFrame>(),new Map<number,InputFrame>()]
  private ack = [0,0]
  private applied: InputFrame[] = [{...IDLE},{...IDLE}]
  private received = [-100,-100]
  private gapTicks = [0,0]
  constructor(track: Track,config: RoomConfig) {
    this.race=new Race(track,[0,1].map(slot=>({slot,params:roomCarParams(config),easy:config.easy,
      sim:{manual:config.manual,abs:false,tc:true,brakeAwareAuto:2}})),
      {laps:config.laps,contact:config.contact,postFinishControl:true,trackId:config.trackId,preset:config.preset})
  }
  receive(slot: Slot,batch: unknown): void {
    if(!Array.isArray(batch)||batch.length>30)return
    const q=this.queues[slot]!
    for(const f of batch)if(validInput(f)&&f.seq>this.ack[slot]!&&f.seq<=this.ack[slot]!+180&&!q.has(f.seq)) {
      q.set(f.seq,{...f}); this.received[slot]=this.tick
    }
  }
  start(): void { if(this.race.phase==='waiting')this.race.beginCountdown() }
  step(): Snapshot {
    for(const slot of [0,1] as const) {
      const q=this.queues[slot]!, expected=this.ack[slot]!+1
      let f=q.get(expected)
      if(!f&&q.size&&++this.gapTicks[slot]!>=3)f=q.get(Math.min(...q.keys()))
      // Keep bursts/clock drift from turning into a growing input delay.
      // Coalesce only analog frames; a gear edge is never silently skipped.
      if(f&&q.size>4&&f.shift===0){const next=q.get(f.seq+1);if(next&&next.shift===0)f=next}
      if(f) {
        this.ack[slot]=f.seq;this.applied[slot]={...f};this.gapTicks[slot]=0
        for(const n of q.keys())if(n<=f.seq)q.delete(n)
      } else {
        this.applied[slot]={...this.applied[slot]!,shift:0}
        if(this.tick-this.received[slot]!>18) {
          const vx=this.race.sims[slot]!.car.s.vx
          this.applied[slot]={...IDLE,seq:this.ack[slot]!,throttle:vx>0.5?-0.25:0}
        }
      }
    }
    this.race.step(this.applied);this.tick++
    return this.snapshot()
  }
  snapshot(): Snapshot {
    const positions=this.race.positions()
    return {tick:this.tick,phase:this.race.phase,countdown:this.race.countdownTicks,time:this.race.raceTime,
      cars:this.race.sims.map(s=>({...s.car.s})),ack:[...this.ack],actions:this.applied.map(a=>({...a})),
      scores:this.race.sims.map((s,i)=>({laps:s.lapsCompleted,lapTime:s.currentLapTime,last:s.lastLapTime,
        best:s.bestLapTime,valid:s.lapValid,armed:s.timingArmed,position:positions[i]!,finish:this.race.finishedAt(i)}))}
  }
}
