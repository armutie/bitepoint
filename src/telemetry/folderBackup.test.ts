import { describe,expect,it } from 'vitest'
import { FolderBackups,FOLDER_CONFIG,FOLDER_STATUS,BACKUP_INTERVAL_MS,backupFilename,type BackupDirectory,type BackupStream,type FolderStatus,type FolderConfig } from './folderBackup'
import { newMetadata } from './recorder'
import type { DriveAsset,DriveMetadata,StoredChunk } from './schema'
import { checksum } from './codec'

class Memory {
  meta=new Map<string,unknown>();sessions:DriveMetadata[]=[];chunks:StoredChunk[]=[]
  asset={schemaVersion:1,columns:['tick'],dt:1/60} as DriveAsset
  async getMeta<T>(key:string){return this.meta.get(key) as T|undefined}
  async setMeta(key:string,value:unknown){this.meta.set(key,value)}
  async list(){return structuredClone(this.sessions)}
  async getAsset(){return this.asset}
  async getChunk(_id:string,index:number){return this.chunks[index]!}
  async getEvent(){return null}
}
class Directory implements BackupDirectory {
  name='Bitepoint recordings';permission:PermissionState='granted';files=new Map<string,Uint8Array>()
  writes=0;aborts=0;fail=false;requests=0
  async queryPermission(){return this.permission}
  async requestPermission(){this.requests++;return this.permission}
  async getFileHandle(name:string){return {getFile:async()=>new Blob([new Uint8Array(this.files.get(name)??new Uint8Array()).buffer]),createWritable:async():Promise<BackupStream>=>{
    const parts:Uint8Array[]=[];this.writes++
    return {write:async data=>{if(this.fail)throw Error('Disk full');parts.push(data instanceof Blob?new Uint8Array(await data.arrayBuffer()):data.slice())},
      close:async()=>{const combined=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){combined.set(p,at);at+=p.length}this.files.set(name,combined)},
      abort:async()=>{this.aborts++}}
  }}}
}
async function setup(state:'open'|'complete'='complete'){
  const db=new Memory(),directory=new Directory(),statuses:FolderStatus[]=[]
  const session=newMetadata({mode:'race',trackId:'fixture',trackLabel:'Fixture',preset:'legacy',playerSlot:0,carCount:1,easy:false,
    seed:1,difficulty:'quick',targetLaps:3,previousId:null,initialStates:[]})
  Object.assign(session,{createdAt:0,id:'fixture-recording-id',state,frames:1,chunks:1,assetId:'fixture-asset'})
  db.sessions.push(session)
  const raw=new Float64Array([0]).buffer
  db.chunks.push({sessionId:session.id,index:0,firstTick:0,rows:1,stride:1,gzip:false,checksum:await checksum(raw),payload:new Blob([raw]),terminalStates:[]})
  db.meta.set(FOLDER_CONFIG,{id:'folder1',enabled:true,directory} satisfies FolderConfig)
  let now=1
  return {db,directory,statuses,session,backup:new FolderBackups(db,s=>statuses.push(s),()=>now),clock:(value:number)=>now=value}
}

describe('automatic folder backups',()=>{
  it('streams a completed session immediately as a dated portable archive',async()=>{
    const {backup,directory,session,statuses}=await setup();await backup.run()
    const bytes=directory.files.get(backupFilename(session))!
    expect(new TextDecoder().decode(bytes.slice(0,8))).toBe('BPTREC1\n')
    let at=8;const kinds:string[]=[]
    while(at<bytes.length){const v=new DataView(bytes.buffer),n=v.getUint32(at,true),payload=v.getUint32(at+4,true);at+=8;kinds.push(JSON.parse(new TextDecoder().decode(bytes.slice(at,at+n))).kind);at+=n+payload}
    expect(kinds).toEqual(['manifest','asset','session','chunk','session-end','archive-end'])
    expect(statuses.at(-1)?.state).toBe('saved');expect(directory.writes).toBe(1)
  })
  it('does not rewrite unchanged data and preserves the same filename at finish',async()=>{
    const {backup,directory,session}=await setup();await backup.run();await backup.run()
    expect(directory.writes).toBe(1)
    session.useForTraining=false;await backup.run()
    expect(directory.writes).toBe(2);expect(directory.files.size).toBe(1)
  })
  it('checkpoints an active drive once a minute and finishes without that delay',async()=>{
    const {backup,directory,session,clock}=await setup('open')
    await backup.run();expect(directory.writes).toBe(0)
    clock(BACKUP_INTERVAL_MS+1);await backup.run();expect(directory.writes).toBe(1)
    session.eventCount=1;clock(BACKUP_INTERVAL_MS+2);await backup.run();expect(directory.writes).toBe(1)
    session.state='complete';await backup.run();expect(directory.writes).toBe(2);expect(directory.files.size).toBe(1)
  })
  it('never requests permission in the background and retains recordings',async()=>{
    const {backup,directory,db,statuses}=await setup();directory.permission='prompt';await backup.run()
    expect(statuses.at(-1)?.state).toBe('permission');expect(directory.requests).toBe(0);expect(directory.writes).toBe(0)
    expect(db.sessions[0]!.frames).toBe(1)
    directory.permission='granted';await backup.run();expect(directory.writes).toBe(1)
  })
  it('aborts failed writes, preserves the prior file and receipt, then retries',async()=>{
    const {backup,directory,db,session,statuses}=await setup();await backup.run()
    const before=directory.files.get(backupFilename(session))!.slice(),receipts=JSON.stringify(await db.getMeta('folder-backup-receipts:folder1'))
    session.useForTraining=false;directory.fail=true;await backup.run()
    expect(statuses.at(-1)?.state).toBe('error');expect(directory.aborts).toBe(1)
    expect(directory.files.get(backupFilename(session))).toEqual(before)
    expect(JSON.stringify(await db.getMeta('folder-backup-receipts:folder1'))).toBe(receipts)
    directory.fail=false;await backup.run();expect(statuses.at(-1)?.state).toBe('saved')
    expect(JSON.stringify(await db.getMeta('folder-backup-receipts:folder1'))).not.toBe(receipts)
  })
  it('backs up into a newly chosen folder even if the old folder was current',async()=>{
    const {backup,directory,db}=await setup();await backup.run()
    const second=new Directory();db.meta.set(FOLDER_CONFIG,{id:'folder2',enabled:true,directory:second});await backup.run()
    expect(directory.writes).toBe(1);expect(second.writes).toBe(1)
  })
  it('turns off future backups without deleting any file or recording',async()=>{
    const {backup,directory,db}=await setup();await backup.run()
    const config=await db.getMeta<FolderConfig>(FOLDER_CONFIG);config!.enabled=false
    await backup.run();expect(directory.writes).toBe(1);expect(directory.files.size).toBe(1);expect(db.sessions).toHaveLength(1)
    expect((await db.getMeta<FolderStatus>(FOLDER_STATUS))?.state).toBe('off')
  })
  it('uses distinct filenames for same-second sessions',async()=>{
    const {session}=await setup()
    expect(backupFilename(session)).not.toBe(backupFilename({...session,id:'another-recording-id'}))
  })
  it('saves a shared checked map once and references it from compact session files',async()=>{
    const {backup,directory,db,session}=await setup()
    db.asset={...db.asset,schemaVersion:2,encoding:'learning-compact-v2',track:{id:'power_8',centerline:[[0,0],[1,1]]}} as DriveAsset
    await backup.run()
    expect([...directory.files.keys()].filter(n=>n.endsWith('.json'))).toHaveLength(1)
    expect(directory.writes).toBe(2)
    const bytes=directory.files.get(backupFilename(session))!,view=new DataView(bytes.buffer)
    let at=8;let asset:Record<string,unknown>|undefined
    while(at<bytes.length){const n=view.getUint32(at,true),payload=view.getUint32(at+4,true);at+=8;const record=JSON.parse(new TextDecoder().decode(bytes.slice(at,at+n)));if(record.kind==='asset')asset=record.asset;at+=n+payload}
    expect(asset?.track).toBeUndefined();expect(asset?.trackRef).toBeDefined()
    session.useForTraining=false;await backup.run();expect(directory.writes).toBe(3)
  })
})
