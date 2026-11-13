import { Track, type TrackData } from '../core/track'
import { DT } from '../core/sim'
import { RaceAuthority } from './authority'
import type { RoomConfig, Slot } from './protocol'

const port=self as unknown as {onmessage:((e:MessageEvent)=>void)|null;postMessage:(v:unknown)=>void}
let authority:RaceAuthority|null=null,last=0,accumulator=0
port.onmessage=e=>{
  const m=e.data
  if(m.type==='init') {authority=new RaceAuthority(new Track(m.track as TrackData),m.config as RoomConfig);last=performance.now();port.postMessage({type:'snapshot',snapshot:authority.snapshot()})}
  if(m.type==='input')authority?.receive(m.slot as Slot,m.frames)
  if(m.type==='start')authority?.start()
}
setInterval(()=>{
  if(!authority)return
  const now=performance.now(),elapsed=(now-last)/1000;last=now
  if(elapsed>0.35) {
    // In the lobby nothing is racing, so a stalled clock costs nothing: the
    // host may be in another window sending the invite link, where browsers
    // throttle timers. That used to end the room before anyone had joined.
    // Drop the gap and carry on; snapshots keep the guest's lobby alive.
    if(authority.race.phase==='waiting'){accumulator=0;return}
    // Once racing, don't silently skip race time after a stalled/suspended host.
    port.postMessage({type:'stalled'});authority=null;return
  }
  accumulator+=elapsed
  let state
  while(accumulator>=DT){state=authority.step();accumulator-=DT}
  // Every tick, not every other: half the staleness on the guest, and
  // corrections land in smaller pieces. Measured in netsim.test.ts.
  if(state)port.postMessage({type:'snapshot',snapshot:state})
},4)
