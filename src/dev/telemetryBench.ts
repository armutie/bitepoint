/** Headless capture/codec cost, separate from rendering and learning quality. */
import { readFileSync,writeFileSync } from 'node:fs'
import { bakedToLine,type BakedLine } from '../core/bakedLines'
import { handlingPreset } from '../core/carParams'
import { difficultyByName,RaceSession } from '../core/raceSession'
import { LineFollower } from '../core/referenceDriver'
import { Track,type TrackData } from '../core/track'
import { DrivingCapture } from '../telemetry/capture'
import { DriveRecorder } from '../telemetry/recorder'
import { type DriveAsset,type DriveMetadata,type StoredChunk,type RecordingEvent,type WorkerInput,type WorkerOutput } from '../telemetry/schema'
import { RecordingWriter } from '../telemetry/writer'
import { archiveParts } from '../telemetry/archive'
import type { DrivingDatabase,RecordingBackend } from '../telemetry/database'

const read=(path:string)=>JSON.parse(readFileSync(new URL(`../../public/${path}`,import.meta.url),'utf8'))
const track=new Track(read('tracks/power_8.json') as TrackData),params=handlingPreset('legacy')
const shape=bakedToLine(read('lines/power_8.legacy.json') as BakedLine,track,params,.93)!
const frames=1800
const compact=process.argv.includes('--compact')
const summaries:unknown[]=[]
let finalMessages:WorkerInput[]=[]
for(let repeat=0;repeat<3;repeat++){
  const race=new RaceSession({track,trackId:track.id,params,preset:'legacy',shape,laps:99,opponents:5,difficulty:difficultyByName('quick'),seed:19})
  race.race.phase='racing'
  const driver=new LineFollower(params,shape),messages:WorkerInput[]=[]
  const port={onmessage:null as ((e:MessageEvent<WorkerOutput>)=>void)|null,onerror:null as ((e:ErrorEvent)=>void)|null,
    postMessage(m:WorkerInput,transfer:Transferable[]=[]){messages.push(structuredClone(m,{transfer}));if(m.type==='chunk')this.onmessage?.({data:{type:'saved',sessionId:m.sessionId,frames:m.firstTick+m.rows,bytes:0,chunkIndex:m.index}} as MessageEvent<WorkerOutput>)}}
  const capture=new DrivingCapture(new DriveRecorder(()=>port),{format:compact?'learning':'diagnostic'})
  capture.start({track,sims:race.race.sims,race,playerSlot:race.playerSlot,preset:'legacy',easy:false,mode:'race',legacyTyres:false,buildId:'benchmark',purpose:'verification'})
  const timings:number[]=[],physics:number[]=[]
  for(let i=0;i<frames;i++){
    const input=driver.next(race.playerSim.car.s),a=performance.now()
    capture.begin({steer:input.steer,pedal:input.pedal,shift:0,tc:0,throttlePedal:Math.max(0,input.pedal),brakePedal:Math.max(0,-input.pedal),throttleHeld:input.pedal>0,
      brakeHeld:input.pedal<0,clutchHeld:false,lookBack:false,inputMode:'mouse',sensitivity:.5,source:compact?'human':'reference-driver'})
    const b=performance.now(),result=race.step(input.steer,input.pedal)[race.playerSlot]!,c=performance.now()
    capture.end(result);const d=performance.now()
    if(i>=120){timings.push(b-a+d-c);physics.push(c-b)}
  }
  capture.finish('benchmark-complete')
  const sorted=timings.slice().sort((a,b)=>a-b),mean=(a:number[])=>a.reduce((sum,v)=>sum+v,0)/a.length
  summaries.push({repeat,frames,carCount:race.size,captureMeanMs:mean(timings),captureP95Ms:sorted[Math.floor(sorted.length*.95)],captureMaxMs:Math.max(...timings),physicsMeanMs:mean(physics)})
  finalMessages=messages
}
class Memory implements RecordingBackend {
  sessions=new Map<string,DriveMetadata>();assets=new Map<string,DriveAsset>();chunks:StoredChunk[]=[];events:RecordingEvent[]=[]
  async start(s:DriveMetadata,a:DriveAsset){this.sessions.set(s.id,structuredClone(s));this.assets.set(s.assetId!,a)}
  async append(c:StoredChunk){const s=this.sessions.get(c.sessionId)!;this.chunks.push(c);s.chunks++;s.frames+=c.rows;s.bytes+=c.payload.size;return {frames:s.frames,bytes:s.bytes}}
  async event(e:RecordingEvent){this.events.push(e);this.sessions.get(e.sessionId)!.eventCount++}
  async finish(id:string,reason:string,states:DriveMetadata['terminalStates']){const s=this.sessions.get(id)!;s.state='complete';s.endReason=reason;s.terminalStates=states}
  async getAsset(id:string){return this.assets.get(id)!}
  async getChunk(id:string,index:number){return this.chunks.find(c=>c.sessionId===id&&c.index===index)!}
  async getEvent(id:string,index:number){return this.events.find(e=>e.sessionId===id&&e.index===index)??null}
}
const db=new Memory(),errors:WorkerOutput[]=[],writer=new RecordingWriter(db,m=>{if(m.type==='error')errors.push(m)})
const start=performance.now();for(const message of finalMessages)await writer.receive(message)
if(errors.length)throw new Error(JSON.stringify(errors))
const rawBytes=finalMessages.reduce((n,m)=>n+(m.type==='chunk'?m.rows*m.stride*(compact?4:8):0),0),compressedBytes=db.chunks.reduce((n,c)=>n+c.payload.size,0)
const output={format:compact?'learning-compact-v2':'diagnostic',samples:summaries,codecMs:performance.now()-start,rawBytes,compressedBytes,compressedMiBPerHour:compressedBytes/(frames/60)*3600/1024**2,
  caveat:'Headless six-car scripted-drive capture/transfer and codec cost. No renderer, real disk benchmark, or FPS guarantee. File contains verification/reference-driver data, not human demonstrations.'}
const prefix=process.argv[2]??'telemetry-benchmark'
writeFileSync(`${prefix}.json`,JSON.stringify(output,null,2))
const parts:BlobPart[]=[];for await(const part of archiveParts(db as unknown as DrivingDatabase,[...db.sessions.values()]))parts.push(part)
writeFileSync(`${prefix}.bpt`,new Uint8Array(await new Blob(parts).arrayBuffer()))
console.log(JSON.stringify(output,null,2))
