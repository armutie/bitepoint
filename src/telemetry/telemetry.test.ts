import { readFileSync } from 'node:fs'
import { describe,expect,it } from 'vitest'
import { bakedToLine,type BakedLine } from '../core/bakedLines'
import { handlingPreset } from '../core/carParams'
import { RaceSession,difficultyByName } from '../core/raceSession'
import { TimeAttackSim } from '../core/sim'
import { Track,type TrackData } from '../core/track'
import { DrivingCapture,type RequestedControls } from './capture'
import { checksum,columnBytes,compress,decompress,rowNumbers } from './codec'
import { DriveRecorder } from './recorder'
import { CAR_FIELDS,C,GLOBAL_FIELDS,G,type DriveMetadata,type DriveAsset,type RecordingEvent,type StoredChunk,type WorkerInput,type WorkerOutput } from './schema'
import { RecordingWriter } from './writer'
import type { RecordingBackend,DrivingDatabase } from './database'
import { archiveParts,ARCHIVE_MAGIC } from './archive'
import { drivingLibraryUrl } from './urls'
import { COMPACT_ENCODING,E,unpackCompact } from './compact'

const read=(p:string)=>JSON.parse(readFileSync(new URL(`../../public/${p}`,import.meta.url),'utf8'))
const track=new Track(read('tracks/power_8.json') as TrackData),params=handlingPreset('legacy')
const shape=bakedToLine(read('lines/power_8.legacy.json') as BakedLine,track,params,.93)!
const request:RequestedControls={steer:.12,pedal:.8,shift:1,tc:2,throttlePedal:.9,brakePedal:.1,throttleHeld:true,brakeHeld:true,clutchHeld:false,
  lookBack:false,inputMode:'mouse',sensitivity:.5,source:'human'}
class Port {
  messages:WorkerInput[]=[];onmessage:((e:MessageEvent<WorkerOutput>)=>void)|null=null;onerror:((e:ErrorEvent)=>void)|null=null
  postMessage(m:WorkerInput){this.messages.push(structuredClone(m))}
  reply(m:WorkerOutput){this.onmessage?.({data:m} as MessageEvent<WorkerOutput>)}
}
class Memory implements RecordingBackend {
  sessions=new Map<string,DriveMetadata>();assets=new Map<string,DriveAsset>();chunks:StoredChunk[]=[];events:RecordingEvent[]=[]
  fail=false
  async start(s:DriveMetadata,a:DriveAsset){await Promise.resolve();this.sessions.set(s.id,structuredClone(s));this.assets.set(s.assetId!,a)}
  async append(c:StoredChunk){
    if(this.fail)throw new DOMException('Full','QuotaExceededError')
    const s=this.sessions.get(c.sessionId)!
    if(c.index!==s.chunks||c.firstTick!==s.frames)throw new Error('Non-contiguous')
    this.chunks.push(c);s.chunks++;s.frames+=c.rows;s.bytes+=c.payload.size
    return {frames:s.frames,bytes:s.bytes}
  }
  async event(e:RecordingEvent){this.events.push(e);this.sessions.get(e.sessionId)!.eventCount++}
  async finish(id:string,reason:string,states:DriveMetadata['terminalStates']){const s=this.sessions.get(id)!;s.state='complete';s.endReason=reason;s.terminalStates=states}
  async list(){return [...this.sessions.values()]}
  async getAsset(id:string){return this.assets.get(id)!}
  async getChunk(id:string,index:number){return this.chunks.find(c=>c.sessionId===id&&c.index===index)!}
  async getEvent(id:string,index:number){return this.events.find(e=>e.sessionId===id&&e.index===index)??null}
}
function timeCapture(){
  const port=new Port(),recorder=new DriveRecorder(()=>port),capture=new DrivingCapture(recorder,{format:'diagnostic'})
  const sim=new TimeAttackSim(track,params,'power_8','legacy',false,{manual:true,tc:true})
  capture.start({track,sims:[sim],race:null,playerSlot:0,preset:'legacy',easy:false,mode:'time-trial',legacyTyres:false,buildId:'test'})
  return {port,recorder,capture,sim}
}
async function persist(port:Port){const db=new Memory(),messages:WorkerOutput[]=[],writer=new RecordingWriter(db,m=>messages.push(m));await Promise.all(port.messages.map(m=>writer.receive(m)));return {db,messages}}
const block=(port:Port)=>port.messages.find((m):m is Extract<WorkerInput,{type:'chunk'}>=>m.type==='chunk')!

describe('automatic driving telemetry',()=>{
  it('pairs the pre-step state with actual controls and preserves the final state, including untimed/invalid driving',async()=>{
    const {port,capture,sim}=timeCapture(),before={...sim.car.s}
    capture.begin(request);const result=sim.step(request.steer,request.pedal,request.shift,request.tc);capture.end(result)
    capture.finish('abandoned')
    const c=block(port),row=new Float64Array(c.data),b=GLOBAL_FIELDS.length
    expect(c.rows).toBe(1);expect(row[G.tick]).toBe(0);expect(row[b+C.x]).toBe(before.x);expect(row[b+C.timingArmed]).toBe(0)
    expect(row[b+C.appliedSteer]).toBe(.12);expect(row[b+C.appliedPedal]).toBe(.8);expect(row[b+C.appliedShift]).toBe(1)
    expect(row[G.throttlePedal]).toBe(.9);expect(row[G.brakePedal]).toBe(.1);expect(c.terminalStates[0]).toEqual(sim.car.s)
    expect(Number.isNaN(row[b+C.relativeForward])).toBe(true)
    const {db}=await persist(port),s=[...db.sessions.values()][0]!
    expect(s.frames).toBe(1);expect(s.endReason).toBe('abandoned');expect(s.terminalStates?.[0]).toEqual(sim.car.s)
  })
  it('retains exact state/control physics parity over 360 ticks and successive autosave boundaries',async()=>{
    const {port,capture,sim}=timeCapture(),other=new TimeAttackSim(track,params,'power_8','legacy',false,{manual:true,tc:true})
    for(let i=0;i<360;i++){
      const steer=Math.sin(i/70)*.18,pedal=i<240?.6:-.4,shift=i===110?1:i===280?-1:0
      capture.begin({...request,steer,pedal,shift});capture.end(sim.step(steer,pedal,shift,2));other.step(steer,pedal,shift,2)
      if(i%53===0)capture.flush()
    }
    capture.finish('restart');expect(sim.car.s).toEqual(other.car.s)
    const {db}=await persist(port);let expected=0
    for(const c of db.chunks){expect(c.firstTick).toBe(expected);const bytes=await decompress(c.payload,c.gzip);expect(await checksum(bytes)).toBe(c.checksum)
      const rows=rowNumbers(bytes,c.rows,c.stride);for(let i=0;i<c.rows;i++)expect(rows[i*c.stride+G.tick]).toBe(expected++)}
    expect(expected).toBe(360)
  })
  it('separates restarts and labels autonomous qualifying steps and pause events without recording phantom pause frames',()=>{
    const {port,capture,sim}=timeCapture()
    capture.begin({...request,source:'qualifying-intro'});capture.end(sim.step(0,.1));capture.event('pause');capture.event('resume')
    capture.finish('restart');sim.reset();capture.start({track,sims:[sim],race:null,playerSlot:0,preset:'legacy',easy:false,mode:'qualifying',legacyTyres:false,buildId:'test'})
    capture.begin(request);capture.end(sim.step(0,0));capture.finish('quit')
    const starts=port.messages.filter((m):m is Extract<WorkerInput,{type:'start'}>=>m.type==='start')
    expect(starts).toHaveLength(2);expect(starts[1]!.metadata.previousId).toBe(starts[0]!.metadata.id)
    expect(port.messages.filter(m=>m.type==='event').map(m=>m.event.type)).toEqual(['pause','resume'])
    expect(new Float64Array(block(port).data)[G.controlSource]).toBe(1)
  })
  it('records every opponent, stable identities, relative position/velocity and held grid controls',()=>{
    const race=new RaceSession({track,trackId:track.id,params,preset:'legacy',shape,laps:3,opponents:2,difficulty:difficultyByName('quick'),randomizeAi:true,seed:17})
    const port=new Port(),capture=new DrivingCapture(new DriveRecorder(()=>port),{format:'diagnostic'}),sims=race.race.sims,player=race.playerSlot
    capture.start({track,sims,race,playerSlot:player,preset:'legacy',easy:false,mode:'race',legacyTyres:false,buildId:'test'})
    const me=sims[player]!.car.s,c=Math.cos(me.yaw),sn=Math.sin(me.yaw),other=sims[0]!.car.s
    other.x=me.x+c*12-sn*2;other.y=me.y+sn*12+c*2;other.yaw=me.yaw;other.vx=10;me.vx=20
    capture.begin({...request,steer:.8,pedal:1});const result=race.step(.8,1)[player]!;capture.end(result);capture.finish('quit')
    const row=new Float64Array(block(port).data),base=GLOBAL_FIELDS.length
    expect(row[G.phase]).toBe(1);expect(row[G.requestedPedal]).toBe(1)
    expect(row[base+C.relativeForward]).toBeCloseTo(12,10);expect(row[base+C.relativeLeft]).toBeCloseTo(2,10)
    expect(row[base+C.relativeVForward]).toBeCloseTo(-10,10)
    expect(row[base+player*CAR_FIELDS.length+C.appliedPedal]).toBe(0)
    const start=port.messages[0] as Extract<WorkerInput,{type:'start'}>
    expect(start.asset.drivers).toHaveLength(3);expect(start.asset.drivers[player]!.role).toBe('human')
    expect(start.asset.drivers[0]!.identity).toBe(race.driverIdOf(0));expect(start.asset.track.centerline).toHaveLength(track.n)
  })
  it('separates physical road gaps from lapped race progress at the start line',()=>{
    const race=new RaceSession({track,trackId:track.id,params,preset:'legacy',shape,laps:3,opponents:1,difficulty:difficultyByName('quick')})
    const port=new Port(),capture=new DrivingCapture(new DriveRecorder(()=>port),{format:'diagnostic'}),me=race.playerSlot
    for(const [slot,s] of [[me,track.length-2],[0,3]]){const pose=track.poseAt(s!);race.race.sims[slot!]!.car.reset(pose.x,pose.y,pose.yaw)}
    capture.start({track,sims:race.race.sims,race,playerSlot:me,preset:'legacy',easy:false,mode:'race',legacyTyres:false,buildId:'test'})
    capture.begin(request);capture.end(race.step(0,0)[me]!);capture.finish('quit')
    const row=new Float64Array(block(port).data)
    expect(row[GLOBAL_FIELDS.length+C.roadGap]).toBeCloseTo(5,1)
    expect(row[GLOBAL_FIELDS.length+C.progressGap]).not.toBeCloseTo(5,1)
  })
  it('reports storage failure and bounds unacknowledged data without silently evicting old recordings',async()=>{
    const {port,capture,sim,recorder}=timeCapture()
    for(let i=0;i<1080;i++){capture.begin(request);capture.end(sim.step(0,.2))}
    expect(recorder.status.state).toBe('error');expect(port.messages.filter(m=>m.type==='chunk')).toHaveLength(8)
    const db=new Memory(),notifications:WorkerOutput[]=[],writer=new RecordingWriter(db,m=>notifications.push(m))
    const messages=port.messages;await writer.receive(messages[0]!);await writer.receive(messages[1]!)
    db.fail=true;await writer.receive(messages[2]!)
    expect(db.chunks).toHaveLength(1);expect(notifications.at(-1)).toMatchObject({type:'error',message:expect.stringContaining('storage is full')})
    expect(db.sessions.size).toBe(1)
  })
  it('waits for a durable finish acknowledgement before calling the recording saved',()=>{
    const {port,capture,sim,recorder}=timeCapture();capture.begin(request);capture.end(sim.step(0,0));capture.finish('quit')
    expect(recorder.status.state).toBe('saving')
    const start=port.messages[0] as Extract<WorkerInput,{type:'start'}>;port.reply({type:'finished',sessionId:start.metadata.id})
    expect(recorder.status.state).toBe('saved')
  })
})

describe('portable lossless archive',()=>{
  it('keeps the data library at the project root from normal and legacy deployments',()=>{
    for(const path of ['/bitepoint/','/bitepoint/index.html','/bitepoint/legacy/','/bitepoint/legacy/index.html','/bitepoint/legacy']){
      expect(drivingLibraryUrl('https://example.com'+path)).toBe('https://example.com/bitepoint/driving-data.html')
    }
  })
  it('round-trips exact Float64 values, missing data and gzip',async()=>{
    const input=new Float64Array([1/3,NaN,-0,1e-90,Math.PI,987654.123456789]),raw=columnBytes(input,2,3),packed=await compress(raw)
    expect(rowNumbers(await decompress(packed.payload,packed.gzip),2,3)).toEqual(input)
    expect(()=>rowNumbers(raw,3,3)).toThrow()
  })
  it('exports only the saved high-water mark with manifest, assets, events and terminal checkpoints',async()=>{
    const {port,capture,sim}=timeCapture();capture.begin(request);capture.end(sim.step(0,.2));capture.event('pause');capture.finish('quit')
    const {db}=await persist(port),selected=structuredClone(await db.list()),parts:BlobPart[]=[]
    const iterator=archiveParts(db as unknown as DrivingDatabase,selected)
    for await(const part of iterator)parts.push(part)
    const bytes=await new Blob(parts).arrayBuffer(),view=new DataView(bytes)
    expect(new TextDecoder().decode(bytes.slice(0,8))).toBe(ARCHIVE_MAGIC)
    let at=8;const kinds:string[]=[]
    while(at<bytes.byteLength){const head=view.getUint32(at,true),body=view.getUint32(at+4,true);at+=8
      const record=JSON.parse(new TextDecoder().decode(bytes.slice(at,at+head)));kinds.push(record.kind);at+=head+body}
    expect(kinds).toEqual(['manifest','asset','session','chunk','event','session-end','archive-end']);expect(at).toBe(bytes.byteLength)
  })
})

describe('compact human learning capture',()=>{
  it('omits launch holds and stores relative samples only for nearby rivals',async()=>{
    const race=new RaceSession({track,trackId:track.id,params,preset:'legacy',shape,laps:3,opponents:2,difficulty:difficultyByName('quick'),playerLaunch:true})
    const port=new Port(),capture=new DrivingCapture(new DriveRecorder(()=>port)),player=race.playerSlot,sims=race.race.sims
    capture.start({track,sims,race,playerSlot:player,preset:'legacy',easy:false,mode:'race',legacyTyres:false,buildId:'test'})
    capture.begin(request);capture.end(race.step(0,0)[player]!)
    race.race.phase='racing';capture.begin(request);capture.end(race.step(0,0)[player]!)
    expect(port.messages.filter(m=>m.type==='chunk')).toHaveLength(0)
    race.launch!.state='launched'
    const own=sims[player]!.car.s,c=Math.cos(own.yaw),sn=Math.sin(own.yaw)
    const near=sims[0]!.car.s,far=sims[1]!.car.s
    near.x=own.x+c*12;near.y=own.y+sn*12;near.yaw=own.yaw
    far.x=own.x+1000;far.y=own.y+1000
    capture.begin(request);capture.end(race.step(.12,.8)[player]!);capture.finish('quit')
    const {db}=await persist(port),chunk=db.chunks[0]!,raw=await decompress(chunk.payload,chunk.gzip)
    const values=unpackCompact(raw,chunk.rows,chunk.stride,chunk.rivals??[])
    expect(chunk.rows).toBe(1);expect(values[E.simTick]).toBe(2)
    expect(values[20]).toBeCloseTo(12,5);expect(values[25]).toBe(1);expect(values[31]).toBe(0)
    expect(chunk.rivals).toEqual([{index:0,count:1}])
    const asset=[...db.assets.values()][0]!
    expect(asset.drivers).toHaveLength(1);expect(asset.nearbyDrivers).toHaveLength(2)
  })
  it('omits autonomous rollout and saves only applied controls, ego state and slip',async()=>{
    const port=new Port(),recorder=new DriveRecorder(()=>port),capture=new DrivingCapture(recorder)
    const sim=new TimeAttackSim(track,params,track.id,'legacy',false)
    capture.start({track,sims:[sim],race:null,playerSlot:0,preset:'legacy',easy:false,mode:'qualifying',legacyTyres:false,buildId:'compact-test'})
    for(let i=0;i<10;i++){capture.begin({...request,source:'qualifying-intro'});capture.end(sim.step(0,.1))}
    expect(recorder.status.frames).toBe(0)
    const before={...sim.car.s};capture.begin(request);capture.end(sim.step(.12,.8));capture.finish('quit')
    const start=port.messages[0] as Extract<WorkerInput,{type:'start'}>
    expect(start.asset.encoding).toBe(COMPACT_ENCODING);expect(start.asset.columns).toHaveLength(20)
    expect(start.asset.columns.some(name=>/requested|Held|sensitivity|engineRpm|gear/.test(name))).toBe(false)
    expect(start.metadata.initialStates).toEqual([])
    const {db}=await persist(port),chunk=db.chunks[0]!,bytes=await decompress(chunk.payload,chunk.gzip)
    const row=unpackCompact(bytes,chunk.rows,chunk.stride,chunk.rivals??[])
    expect(row[E.simTick]).toBe(10);expect(row[E['own.x']]).toBe(Math.fround(before.x))
    expect(row[E['own.slipF']]).toBe(Math.fround(before.slipF));expect(row[E['own.appliedSteer']]).toBe(Math.fround(.12))
    expect(row[E['own.appliedPedal']]).toBe(Math.fround(.8));expect(chunk.terminalStates).toEqual([])
  })
  it('preserves physical tick gaps when control transfers away and back',async()=>{
    const port=new Port(),capture=new DrivingCapture(new DriveRecorder(()=>port)),sim=new TimeAttackSim(track,params,track.id,'legacy')
    capture.start({track,sims:[sim],race:null,playerSlot:0,preset:'legacy',easy:false,mode:'time-trial',legacyTyres:false,buildId:'test'})
    for(let i=0;i<5;i++){capture.begin({...request,source:i===0||i===4?'human':'reference-driver'});capture.end(sim.step(0,.1))}
    capture.finish('quit');const {db}=await persist(port),chunk=db.chunks[0]!
    const values=unpackCompact(await decompress(chunk.payload,chunk.gzip),chunk.rows,chunk.stride,chunk.rivals??[])
    expect(chunk.rows).toBe(2);expect(values[E.simTick]).toBe(0);expect(values[chunk.stride+E.simTick]).toBe(4)
  })
})
