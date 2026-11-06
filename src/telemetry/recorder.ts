import type { CarState } from '../core/car'
import { CHUNK_FRAMES,uniqueId,type DriveAsset,type DriveMetadata,type RecordingStatus,type WorkerInput,type WorkerOutput } from './schema'
import { COMPACT_ENCODING } from './compact'

interface WorkerPort {
  postMessage(message:WorkerInput,transfer?:Transferable[]):void
  onmessage:((event:MessageEvent<WorkerOutput>)=>void)|null
  onerror:((event:ErrorEvent)=>void)|null
}
export class DriveRecorder {
  private port:WorkerPort|null=null
  private id:string|null=null
  private buffer:Float64Array|Float32Array=new Float64Array(0)
  private compact=false
  private stride=0
  private rows=0
  private frames=0
  private chunk=0
  private events=0
  private pending=0
  private inFrame=false
  private failed=false
  private finishingId:string|null=null
  private terminal:()=>CarState[]=()=>[]
  status:RecordingStatus={state:'ready',frames:0,savedFrames:0,bytes:0,message:'Automatic recording · local'}
  onStatus:((status:RecordingStatus)=>void)|null=null
  constructor(factory:()=>WorkerPort=()=>new Worker(new URL('./recorder.worker.ts',import.meta.url),{type:'module'}) as unknown as WorkerPort){
    try{
      this.port=factory();this.port.onmessage=e=>{
        const m=e.data
        if(m.type==='saved'){
          this.pending=Math.max(0,this.pending-1)
          if(m.sessionId===this.id){this.status.savedFrames=m.frames;this.status.bytes=m.bytes;this.emit()}
        }else if(m.type==='finished'&&m.sessionId===this.finishingId&&!this.id){this.status={...this.status,state:'saved',message:'Driving data saved locally'};this.emit()}
        else if(m.type==='error')this.error(m.message)
      };this.port.onerror=()=>this.error('Recording unavailable: the background recorder stopped. Reload to retry.')
    }catch{this.error('Recording unavailable: this browser cannot start the background recorder.')}
  }
  private emit():void{this.onStatus?.({...this.status})}
  private post(message:WorkerInput,transfer:Transferable[]=[]):void{
    if(this.failed||!this.port)return
    try{this.port.postMessage(message,transfer)}catch{this.error('Recording stopped: the background recorder could not receive data.')}
  }
  private error(message:string):void{this.failed=true;this.status={...this.status,state:'error',message};this.emit()}
  start(metadata:DriveMetadata,asset:DriveAsset,terminal:()=>CarState[]=()=>[]):void{
    if(this.failed)return
    if(this.id)throw new Error('Finish the previous driving recording before starting another')
    this.id=metadata.id;this.terminal=terminal;this.stride=asset.columns.length;this.rows=0;this.frames=0;this.chunk=0;this.events=0
    this.compact=asset.encoding===COMPACT_ENCODING
    this.buffer=this.compact?new Float32Array(this.stride*CHUNK_FRAMES):new Float64Array(this.stride*CHUNK_FRAMES)
    this.status={state:'recording',frames:0,savedFrames:0,bytes:0,message:'Recording · local'}
    this.post({type:'start',metadata,asset});this.emit()
  }
  beginFrame():Float64Array|Float32Array|null{
    if(!this.id||this.failed)return null
    if(this.inFrame)throw new Error('Unfinished telemetry transition')
    this.inFrame=true
    const row=this.buffer.subarray(this.rows*this.stride,(this.rows+1)*this.stride);row.fill(NaN);return row
  }
  endFrame():void{
    if(!this.inFrame)return;this.inFrame=false
    this.rows++;this.frames++;this.status.frames=this.frames
    if(this.rows===CHUNK_FRAMES)this.flush()
  }
  get tick():number{return this.frames}
  get active():boolean{return this.id!==null&&!this.failed}
  flush():void{
    if(!this.id||!this.rows||this.failed||this.inFrame)return
    if(this.pending>=8){this.error('Recording stopped: local storage is too slow to keep up. Open Driving recordings.');return}
    const data=this.buffer.buffer as ArrayBuffer,rows=this.rows
    this.buffer=this.compact?new Float32Array(this.stride*CHUNK_FRAMES):new Float64Array(this.stride*CHUNK_FRAMES);this.rows=0;this.pending++
    this.post({type:'chunk',sessionId:this.id,index:this.chunk++,firstTick:this.frames-rows,rows,stride:this.stride,data,terminalStates:this.terminal()},[data])
  }
  event(type:string,detail=''):void{
    if(!this.id||this.failed)return
    this.flush();this.post({type:'event',event:{sessionId:this.id,index:this.events++,tick:this.frames,at:Date.now(),type,detail}})
  }
  finish(reason:string,terminalStates:CarState[]):void{
    if(!this.id)return
    this.flush();this.post({type:'finish',sessionId:this.id,reason,terminalStates})
    this.finishingId=this.id;this.id=null;this.inFrame=false
    if(!this.failed){this.status={...this.status,state:'saving',message:'Saving driving data…'};this.emit()}
  }
}

export function newMetadata(input:Pick<DriveMetadata,'mode'|'trackId'|'trackLabel'|'preset'|'playerSlot'|'carCount'|'easy'|'seed'|'difficulty'|'targetLaps'|'previousId'|'initialStates'>&{purpose?:DriveMetadata['purpose']}):DriveMetadata{
  const now=Date.now()
  return {...input,id:uniqueId(),createdAt:now,updatedAt:now,state:'open',endReason:null,frames:0,chunks:0,bytes:0,eventCount:0,terminalStates:null,error:null,
    purpose:input.purpose??'personal',useForTraining:input.purpose!=='verification'}
}
