import { archiveParts,type TrackReference } from './archive'
import { checksum } from './codec'
import { COMPACT_ENCODING } from './compact'
import type { DrivingDatabase } from './database'
import type { DriveMetadata } from './schema'

export const FOLDER_CONFIG='folder-backup-config-v1'
export const FOLDER_STATUS='folder-backup-status-v1'
export const BACKUP_INTERVAL_MS=60_000
export interface BackupStream {
  write(data:Uint8Array<ArrayBuffer>|Blob):Promise<void>
  close():Promise<void>
  abort():Promise<void>
}
export interface BackupDirectory {
  name:string
  queryPermission(options:{mode:'readwrite'}):Promise<PermissionState>
  requestPermission(options:{mode:'readwrite'}):Promise<PermissionState>
  getFileHandle(name:string,options:{create:true}):Promise<{createWritable():Promise<BackupStream>;getFile?:()=>Promise<Blob>}>
}
export interface FolderConfig {id:string;enabled:boolean;directory:BackupDirectory}
export interface FolderStatus {
  state:'off'|'ready'|'saving'|'saved'|'permission'|'error'
  folder:string;message:string;lastSavedAt?:number
}
interface Receipt {signature:string;savedAt:number}
type Receipts=Record<string,Receipt>
export type BackupDatabase=Pick<DrivingDatabase,'list'|'getMeta'|'setMeta'|'getAsset'|'getChunk'|'getEvent'>

export function backupFilename(s:DriveMetadata):string{
  const d=new Date(s.createdAt),pad=(n:number)=>String(n).padStart(2,'0')
  const date=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  // Full recording identity prevents same-second sessions from colliding.
  const identity=s.id.replace(/[^a-zA-Z0-9-]/g,'_')
  return `bitepoint-${date}-${s.mode}-${identity}.bpt`
}
function signature(s:DriveMetadata):string{
  return JSON.stringify([s.frames,s.chunks,s.eventCount,s.state,s.endReason,s.useForTraining,s.purpose])
}

/** File I/O is separate from the recorder's durable-write queue. */
export class FolderBackups {
  constructor(private readonly db:BackupDatabase,private readonly notify:(s:FolderStatus)=>void,private readonly now=()=>Date.now()){}
  private async status(value:FolderStatus):Promise<void>{
    this.notify(value)
    const old=await this.db.getMeta<FolderStatus>(FOLDER_STATUS)
    if(JSON.stringify(old)!==JSON.stringify(value))await this.db.setMeta(FOLDER_STATUS,value)
  }
  async run():Promise<void>{
    let config:FolderConfig|undefined
    try{
      config=await this.db.getMeta<FolderConfig>(FOLDER_CONFIG)
      if(!config?.enabled){await this.status({state:'off',folder:'',message:'Automatic folder backups are off.'});return}
      const directory=config.directory,folder=directory.name
      if(await directory.queryPermission({mode:'readwrite'})!=='granted'){
        await this.status({state:'permission',folder,message:'Folder access needs renewing. Browser recordings are still saved.'});return
      }
      const receiptKey=`folder-backup-receipts:${config.id}`,receipts=await this.db.getMeta<Receipts>(receiptKey)??{}
      const sessions=await this.db.list()
      // Do not let a large historical backfill starve an overdue live checkpoint.
      // New completions follow, with at most one streamed archive per pass.
      sessions.sort((a,b)=>Number(b.state==='open')-Number(a.state==='open')||b.createdAt-a.createdAt)
      const selected=sessions.find(s=>{
        if(!s.frames||!s.chunks)return false
        const previous=receipts[s.id]
        if(previous?.signature===signature(s))return false
        return s.state!=='open'||this.now()-(previous?.savedAt??s.createdAt)>=BACKUP_INTERVAL_MS
      })
      if(!selected){
        const latest=Math.max(0,...Object.values(receipts).map(r=>r.savedAt))
        await this.status({state:latest?'saved':'ready',folder,message:latest?'Folder backups are up to date.':'Automatic folder backups are on.',...(latest?{lastSavedAt:latest}:{})});return
      }
      await this.status({state:'saving',folder,message:'Saving recording to your folder…'})
      const trackReferences:Record<string,TrackReference>={},asset=await this.db.getAsset(selected.assetId!)
      if(asset.encoding===COMPACT_ENCODING){
        const bytes=new TextEncoder().encode(JSON.stringify(asset.track)),hash=await checksum(bytes.buffer)
        const name=`bitepoint-map-${hash.replace(':','-')}.json`,handle=await directory.getFileHandle(name,{create:true})
        const existing=await handle.getFile?.()
        if(!existing||existing.size!==bytes.length||await checksum(await existing.arrayBuffer())!==hash){
          const mapStream=await handle.createWritable()
          try{await mapStream.write(bytes);await mapStream.close()}catch(error){await mapStream.abort().catch(()=>{});throw error}
        }
        trackReferences[selected.assetId!]={file:name,checksum:hash}
      }
      const file=await directory.getFileHandle(backupFilename(selected),{create:true}),stream=await file.createWritable()
      try{
        for await(const part of archiveParts(this.db,[selected],trackReferences))await stream.write(part)
        await stream.close()
      }catch(error){await stream.abort().catch(()=>{});throw error}
      receipts[selected.id]={signature:signature(selected),savedAt:this.now()}
      await this.db.setMeta(receiptKey,receipts)
      await this.status({state:'saved',folder,message:'Recording saved to your folder.',lastSavedAt:receipts[selected.id]!.savedAt})
    }catch(error){
      const permission=error instanceof DOMException&&error.name==='NotAllowedError'
      const value:FolderStatus={state:permission?'permission':'error',folder:config?.directory.name??'',
        message:permission?'Folder access needs renewing. Browser recordings are still saved.':'Folder backup failed. Browser recordings are still saved; backups will retry.'}
      this.notify(value)
      await this.db.setMeta(FOLDER_STATUS,value).catch(()=>{})
    }
  }
}

export function startFolderBackups(notify:(status:FolderStatus)=>void):Worker|null{
  try{
    const worker=new Worker(new URL('./folderBackup.worker.ts',import.meta.url),{type:'module'})
    worker.onmessage=e=>notify(e.data as FolderStatus)
    worker.onerror=()=>notify({state:'error',folder:'',message:'Folder backups paused. Open Driving recordings to retry.'})
    return worker
  }catch{return null}
}
