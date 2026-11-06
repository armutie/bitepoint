import { DrivingDatabase } from './database'
import { RecordingWriter } from './writer'
import type { WorkerInput,WorkerOutput } from './schema'
const send=(m:WorkerOutput)=>postMessage(m)
const ready=DrivingDatabase.open().then(db=>{send({type:'ready'});return new RecordingWriter(db,send)})
void ready.catch(()=>send({type:'error',message:'Recording unavailable: this browser could not open local storage.'}))
self.onmessage=e=>{void ready.then(writer=>writer.receive(e.data as WorkerInput)).catch(()=>{})}
