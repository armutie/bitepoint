import type { DriveAsset,DriveMetadata,RecordingEvent,StoredChunk } from './schema'
export const DATABASE='bitepoint-driving-data-v1'
const request=<T>(r:IDBRequest<T>):Promise<T>=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
const complete=(tx:IDBTransaction):Promise<void>=>{
  const promise=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('Recording transaction aborted'));tx.onerror=()=>{}})
  // A request can reject before the caller reaches await done; keep the transaction rejection handled too.
  void promise.catch(()=>{});return promise
}
export interface RecordingBackend {
  start(metadata:DriveMetadata,asset:DriveAsset):Promise<void>
  append(chunk:StoredChunk):Promise<{frames:number;bytes:number}>
  event(event:RecordingEvent):Promise<void>
  finish(id:string,reason:string,states:DriveMetadata['terminalStates']):Promise<void>
}
export class DrivingDatabase implements RecordingBackend {
  private constructor(readonly db:IDBDatabase){}
  static async open():Promise<DrivingDatabase>{
    const r=indexedDB.open(DATABASE,1)
    r.onupgradeneeded=()=>{
      const db=r.result
      db.createObjectStore('sessions',{keyPath:'id'}).createIndex('createdAt','createdAt')
      db.createObjectStore('assets',{keyPath:'id'})
      db.createObjectStore('chunks',{keyPath:['sessionId','index']}).createIndex('sessionId','sessionId')
      db.createObjectStore('events',{keyPath:['sessionId','index']}).createIndex('sessionId','sessionId')
      db.createObjectStore('meta')
    }
    const db=await request(r);db.onversionchange=()=>db.close();return new DrivingDatabase(db)
  }
  async start(metadata:DriveMetadata,asset:DriveAsset):Promise<void>{
    const tx=this.db.transaction(['sessions','assets','meta'],'readwrite'),done=complete(tx)
    const meta=tx.objectStore('meta'),existing=await request(meta.get('driverId')) as string|undefined
    const driverId=existing??metadata.id;meta.put(driverId,'driverId')
    const assets=tx.objectStore('assets'),old=await request(assets.get(metadata.assetId!)) as {asset:DriveAsset}|undefined
    if(old&&JSON.stringify(old.asset)!==JSON.stringify(asset)){tx.abort();await done;throw new Error('Recording configuration hash collision')}
    if(!old)assets.add({id:metadata.assetId,asset})
    tx.objectStore('sessions').add({...metadata,driverId});await done
  }
  async append(chunk:StoredChunk):Promise<{frames:number;bytes:number}>{
    const tx=this.db.transaction(['sessions','chunks'],'readwrite'),done=complete(tx)
    const sessions=tx.objectStore('sessions'),s=await request(sessions.get(chunk.sessionId)) as DriveMetadata|undefined
    if(!s||s.state!=='open'||chunk.index!==s.chunks||chunk.firstTick!==s.frames){tx.abort();await done;throw new Error('Non-contiguous recording')}
    tx.objectStore('chunks').add(chunk);s.frames+=chunk.rows;s.chunks++;s.bytes+=chunk.payload.size;s.updatedAt=Date.now();sessions.put(s)
    await done;return {frames:s.frames,bytes:s.bytes}
  }
  async event(event:RecordingEvent):Promise<void>{
    const tx=this.db.transaction(['events','sessions'],'readwrite'),done=complete(tx)
    const store=tx.objectStore('sessions'),s=await request(store.get(event.sessionId)) as DriveMetadata|undefined
    if(s){tx.objectStore('events').add(event);s.eventCount=Math.max(s.eventCount,event.index+1);s.updatedAt=Date.now();store.put(s)}
    await done
  }
  async finish(id:string,reason:string,states:DriveMetadata['terminalStates']):Promise<void>{
    const tx=this.db.transaction('sessions','readwrite'),done=complete(tx),store=tx.objectStore('sessions')
    const s=await request(store.get(id)) as DriveMetadata|undefined
    if(s){s.state='complete';s.endReason=reason;s.terminalStates=states;s.updatedAt=Date.now();store.put(s)}
    await done
  }
  async list():Promise<DriveMetadata[]>{
    const tx=this.db.transaction('sessions','readonly');return (await request(tx.objectStore('sessions').getAll()) as DriveMetadata[]).sort((a,b)=>b.createdAt-a.createdAt)
  }
  async getMeta<T>(key:string):Promise<T|undefined>{
    return await request(this.db.transaction('meta','readonly').objectStore('meta').get(key)) as T|undefined
  }
  async setMeta(key:string,value:unknown):Promise<void>{
    const tx=this.db.transaction('meta','readwrite'),done=complete(tx)
    tx.objectStore('meta').put(value,key);await done
  }
  async training(id:string,enabled:boolean):Promise<void>{
    const tx=this.db.transaction('sessions','readwrite'),done=complete(tx),store=tx.objectStore('sessions')
    const s=await request(store.get(id)) as DriveMetadata|undefined
    if(s){s.useForTraining=enabled;store.put(s)}await done
  }
  async getAsset(id:string):Promise<DriveAsset>{
    const v=await request(this.db.transaction('assets','readonly').objectStore('assets').get(id)) as {asset:DriveAsset}|undefined
    if(!v)throw new Error('Recording configuration missing');return v.asset
  }
  async getChunk(id:string,index:number):Promise<StoredChunk>{
    const c=await request(this.db.transaction('chunks','readonly').objectStore('chunks').get([id,index])) as StoredChunk|undefined
    if(!c)throw new Error(`Recording chunk ${index} missing`);return c
  }
  async getEvent(id:string,index:number):Promise<RecordingEvent|null>{
    return await request(this.db.transaction('events','readonly').objectStore('events').get([id,index])) as RecordingEvent??null
  }
}
