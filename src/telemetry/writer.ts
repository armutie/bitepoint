import { checksum,columnBytes,compress } from './codec'
import type { RecordingBackend } from './database'
import type { WorkerInput,WorkerOutput } from './schema'
import { COMPACT_ENCODING,packCompact } from './compact'
/** Serialized off-thread writes preserve boundaries even when compression is asynchronous. */
export class RecordingWriter {
  private queue=Promise.resolve()
  private failed=false
  private compact=new Set<string>()
  constructor(private readonly backend:RecordingBackend,private readonly notify:(message:WorkerOutput)=>void){}
  receive(message:WorkerInput):Promise<void>{
    this.queue=this.queue.then(async()=>{
      if(this.failed)return
      if(message.type==='start'){
        if(message.asset.encoding===COMPACT_ENCODING)this.compact.add(message.metadata.id)
        const bytes=new TextEncoder().encode(JSON.stringify(message.asset)).buffer
        message.metadata.assetId=await checksum(bytes);await this.backend.start(message.metadata,message.asset)
      }else if(message.type==='chunk'){
        const compact=this.compact.has(message.sessionId)?packCompact(new Float32Array(message.data),message.rows,message.stride):null
        const bytes=compact?.bytes??columnBytes(new Float64Array(message.data),message.rows,message.stride)
        const packed=await compress(bytes)
        const result=await this.backend.append({sessionId:message.sessionId,index:message.index,firstTick:message.firstTick,
          rows:message.rows,stride:message.stride,terminalStates:message.terminalStates,checksum:await checksum(bytes),...packed,
          ...(compact?{format:COMPACT_ENCODING,rivals:compact.rivals}:{})})
        this.notify({type:'saved',sessionId:message.sessionId,chunkIndex:message.index,...result})
      }else if(message.type==='event')await this.backend.event(message.event)
      else {await this.backend.finish(message.sessionId,message.reason,message.terminalStates);this.compact.delete(message.sessionId);this.notify({type:'finished',sessionId:message.sessionId})}
    }).catch(error=>{
      this.failed=true;this.notify({type:'error',message:error instanceof DOMException&&error.name==='QuotaExceededError'
        ?'Recording stopped: browser storage is full. Export your driving data.':'Recording stopped: local storage could not save driving data. Open Driving recordings.'})
    })
    return this.queue
  }
}
