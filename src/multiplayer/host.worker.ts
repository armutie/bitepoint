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
  // Don't silently skip race time after a stalled/suspended host.
  if(elapsed>0.35){port.postMessage({type:'stalled'});authority=null;return}
  accumulator+=elapsed
  let state
  while(accumulator>=DT){state=authority.step();accumulator-=DT}
  if(state&&authority.tick%2===0)port.postMessage({type:'snapshot',snapshot:state})
},8)
