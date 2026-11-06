import type { DrivingDatabase } from './database'
import type { DriveMetadata } from './schema'
export const ARCHIVE_MAGIC='BPTREC1\n'
export interface TrackReference {file:string;checksum:string}
/** Streaming framed archive: u32 JSON length, u32 payload length, UTF-8 JSON, optional compressed block. */
export async function* archiveParts(db:Pick<DrivingDatabase,'getAsset'|'getChunk'|'getEvent'>,sessions:DriveMetadata[],trackReferences:Record<string,TrackReference>={}):AsyncGenerator<Uint8Array<ArrayBuffer>|Blob>{
  yield new TextEncoder().encode(ARCHIVE_MAGIC)
  async function* record(header:unknown,payload?:Blob):AsyncGenerator<Uint8Array<ArrayBuffer>|Blob>{
    const json=new TextEncoder().encode(JSON.stringify(header)),prefix=new Uint8Array(8),v=new DataView(prefix.buffer)
    v.setUint32(0,json.byteLength,true);v.setUint32(4,payload?.size??0,true)
    yield prefix;yield json;if(payload)yield payload
  }
  yield* record({kind:'manifest',version:1,exportedAt:Date.now(),sessions:sessions.length,description:'Local learning/diagnostic telemetry; SI units, versioned encoding, missing values NaN.'})
  const assets=new Set<string>()
  for(const session of sessions){
    if(!session.assetId)throw new Error('Recording configuration unavailable')
    if(!assets.has(session.assetId)){
      const asset=await db.getAsset(session.assetId),reference=trackReferences[session.assetId]
      if(reference){const {track:_,...rest}=asset;yield* record({kind:'asset',id:session.assetId,asset:{...rest,trackRef:reference}})}
      else yield* record({kind:'asset',id:session.assetId,asset})
      assets.add(session.assetId)
    }
    yield* record({kind:'session',session})
    // A fixed high-water mark makes exports safe while the game continues to append.
    for(let i=0;i<session.chunks;i++){
      const {payload,...header}=await db.getChunk(session.id,i)
      yield* record({kind:'chunk',...header},payload)
    }
    for(let i=0;i<session.eventCount;i++){const event=await db.getEvent(session.id,i);if(event&&event.tick<=session.frames)yield* record({kind:'event',event})}
    yield* record({kind:'session-end',id:session.id,frames:session.frames,chunks:session.chunks})
  }
  yield* record({kind:'archive-end'})
}
