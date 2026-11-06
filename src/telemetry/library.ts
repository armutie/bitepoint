import './library.css'
import { archiveParts } from './archive'
import { checksum,decompress,rowNumbers } from './codec'
import { DrivingDatabase } from './database'
import { C,CAR_FIELDS,G,GLOBAL_FIELDS,type DriveMetadata } from './schema'
import { FOLDER_CONFIG,FOLDER_STATUS,startFolderBackups,type FolderConfig,type FolderStatus,type BackupDirectory } from './folderBackup'
import { COMPACT_ENCODING,E,EGO_STRIDE,RIVAL_STRIDE,unpackCompact } from './compact'
const app=document.getElementById('app')!
app.innerHTML=`<main><header><a href="./">Bitepoint</a><a href="./">Back to game</a></header><h1>Driving recordings</h1>
<p>Your driving records automatically at 60 Hz: car movement, applied controls and nearby traffic. Automated rollout and grid waiting are skipped in new learning recordings. Invalid laps and restarts are kept.</p>
<div id="summary" class="summary">Loading recordings…</div><div class="tools"><button id="export" class="primary">Export all</button><button id="refresh">Refresh</button><button id="persist">Keep data on this device</button></div>
<section class="folder-backups"><h2>Automatic folder backups</h2><p>Choose a folder once. Each drive gets its own dated file, saved when the session ends and updated every minute while you drive.</p>
<div class="tools"><button id="folder-choose">Choose backup folder</button><button id="folder-access" hidden>Restore folder access</button><button id="folder-off" hidden>Turn off</button></div>
<p id="folder-status" role="status" class="note">Checking folder backups…</p><p class="note">For local training pickup, choose Downloads / Bitepoint recordings. Keep the shared map file with your recordings. If a tab closes before a backup finishes, it resumes when you next open the game or this page.</p></section>
<div id="message" class="message" role="status"></div><p id="storage" class="note"></p><div id="list" class="list"></div><section id="preview" hidden></section>
<p class="note">Local storage only. No uploads. Clearing this browser’s site data also clears its browser recordings; files already saved to your backup folder remain. Data is separate for each browser profile and address.</p></main>`
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T
const bytes=(n:number)=>n<1024**2?`${(n/1024).toFixed(1)} KB`:n>1024**3?`${(n/1024**3).toFixed(2)} GB`:`${(n/1024**2).toFixed(1)} MB`
const duration=(frames:number)=>{const sec=Math.floor(frames/60);return `${Math.floor(sec/3600)}h ${Math.floor(sec%3600/60)}m ${sec%60}s`}
const say=(text:string,error=false)=>{el('message').textContent=text;el('message').classList.toggle('error',error)}
let database:DrivingDatabase|null=null,items:DriveMetadata[]=[],busy=false
let folderConfig:FolderConfig|undefined
function folderStatus(status:FolderStatus):void{
  // Another library tab may have changed the selected folder.
  if(database)void database.getMeta<FolderConfig>(FOLDER_CONFIG).then(config=>{folderConfig=config}).catch(()=>{})
  el('folder-status').textContent=`${status.folder?`${status.folder} · `:''}${status.message}${status.lastSavedAt?` Last saved ${new Date(status.lastSavedAt).toLocaleTimeString()}.`:''}`
  el('folder-status').classList.toggle('error',status.state==='error'||status.state==='permission')
  el('folder-access').hidden=status.state!=='permission'
  el('folder-off').hidden=status.state==='off'
}
const folderWorker=startFolderBackups(folderStatus)
const directoryPicker=(window as unknown as {showDirectoryPicker?:(options:{mode:'readwrite';id:string;startIn:'downloads'})=>Promise<BackupDirectory>}).showDirectoryPicker
if(!directoryPicker){
  el<HTMLButtonElement>('folder-choose').disabled=true
  folderStatus({state:'off',folder:'',message:'Automatic folder backups need desktop Chrome or Edge. Manual export is available.'})
}
async function restoreFolderStatus():Promise<void>{
  if(!database||!directoryPicker)return
  folderConfig=await database.getMeta<FolderConfig>(FOLDER_CONFIG)
  const status=await database.getMeta<FolderStatus>(FOLDER_STATUS)
  if(status)folderStatus(status)
  el('folder-off').hidden=!folderConfig?.enabled
  el('folder-choose').textContent=folderConfig?.enabled?'Change backup folder':'Choose backup folder'
}
async function refresh():Promise<void>{
  if(busy)return
  try{
    database??=await DrivingDatabase.open();items=await database.list()
    await restoreFolderStatus()
    const frames=items.reduce((n,s)=>n+s.frames,0),size=items.reduce((n,s)=>n+s.bytes,0)
    el('summary').textContent=`${items.length} ${items.length===1?'recording':'recordings'} · ${duration(frames)} saved · ${bytes(size)}`
    el<HTMLButtonElement>('export').disabled=items.length===0
    const fragment=document.createDocumentFragment()
    for(const s of items){
      const row=document.createElement('article');row.className='session'
      const copy=document.createElement('div'),title=document.createElement('h2'),detail=document.createElement('p')
      title.textContent=`${s.trackLabel} · ${s.mode==='time-trial'?'Time trial':s.mode==='qualifying'?'Qualifying':'Race'}`
      const reason=s.endReason?.replaceAll('-',' ')??'Open / unfinished'
      detail.textContent=`${new Date(s.createdAt).toLocaleString()} · ${duration(s.frames)} · ${s.carCount} ${s.carCount===1?'car':'cars'} · ${bytes(s.bytes)} · ${reason}${s.useForTraining===false?' · Excluded from training':''}`
      copy.append(title,detail)
      const actions=document.createElement('div');actions.className='actions'
      const preview=document.createElement('button');preview.textContent='Preview';preview.disabled=s.chunks===0;preview.onclick=()=>void showPreview(s)
      const save=document.createElement('button');save.textContent='Export';save.onclick=()=>void exportData([s])
      const training=document.createElement('button');training.textContent=s.useForTraining===false?'Include':'Exclude'
      training.title=s.useForTraining===false?'Include this recording in future training':'Keep the data, but exclude it from future training'
      training.onclick=()=>{void database?.training(s.id,s.useForTraining===false).then(()=>refresh()).catch(()=>say('Could not update the training label.',true))}
      actions.append(preview,save,training);row.append(copy,actions);fragment.append(row)
    }
    if(!items.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='Your next drive will appear here automatically.';fragment.append(empty)}
    el('list').replaceChildren(fragment)
    const estimate=await navigator.storage?.estimate?.(),persistent=await navigator.storage?.persisted?.()
    el('storage').textContent=`${persistent?'Persistent storage granted.':'Browser-managed storage.'}${estimate?.quota?` This address uses ${bytes(estimate.usage??0)} of about ${bytes(estimate.quota)} available.`:''}`
  }catch{say('Could not open driving storage in this browser. Recording may be unavailable.',true);el('summary').textContent='Storage unavailable'}
}
interface SavePicker {showSaveFilePicker?:(options:unknown)=>Promise<FileSystemFileHandle>}
async function exportData(selected:DriveMetadata[]):Promise<void>{
  if(!database||busy)return
  busy=true;el<HTMLButtonElement>('export').disabled=true
  try{
    const filename=selected.length===1?`bitepoint-${selected[0]!.mode}-${selected[0]!.id.slice(0,8)}.bpt`:`bitepoint-driving-${new Date().toISOString().slice(0,10)}.bpt`
    const picker=(window as unknown as SavePicker).showSaveFilePicker
    if(picker&&selected.reduce((n,s)=>n+s.bytes,0)>32*1024*1024){
      const handle=await picker.call(window,{suggestedName:filename,types:[{description:'Bitepoint driving data',accept:{'application/octet-stream':['.bpt']}}]})
      const writable=await handle.createWritable()
      try{for await(const part of archiveParts(database,selected))await writable.write(part);await writable.close()}
      catch(error){await writable.abort().catch(()=>{});throw error}
    }else{
      if(selected.reduce((n,s)=>n+s.bytes,0)>256*1024*1024)throw new Error('This browser cannot stream a large export. Use Chrome or Edge for large recordings.')
      const parts:BlobPart[]=[];for await(const part of archiveParts(database,selected))parts.push(part)
      const url=URL.createObjectURL(new Blob(parts,{type:'application/octet-stream'})),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),60_000)
    }
    say('Export saved. Your recordings are still kept in this browser.')
  }catch(error){if(!(error instanceof DOMException&&error.name==='AbortError'))say(error instanceof Error?error.message:'Export failed. Your original recordings are still stored.',true)}
  finally{busy=false;el<HTMLButtonElement>('export').disabled=!items.length}
}
async function showPreview(s:DriveMetadata):Promise<void>{
  if(!database||busy)return
  try{
    const chunk=await database.getChunk(s.id,s.chunks-1),raw=await decompress(chunk.payload,chunk.gzip)
    if(await checksum(raw)!==chunk.checksum)throw new Error('Saved block checksum mismatch')
    const compact=chunk.format===COMPACT_ENCODING
    const values=compact?unpackCompact(raw,chunk.rows,chunk.stride,chunk.rivals??[]):rowNumbers(raw,chunk.rows,chunk.stride),row=values.subarray((chunk.rows-1)*chunk.stride)
    const panel=el('preview');panel.replaceChildren();panel.hidden=false
    const title=document.createElement('h2');title.textContent='Latest saved moment'
    const caption=document.createElement('p');caption.textContent=compact?`${(row[E.simTick]!/60).toFixed(2)} seconds into the session · Human driving · Compact record`:`${(row[G.time]??0).toFixed(2)} seconds into the recording · ${row[G.controlSource]===0?'Human driving':'Automatic driving, labelled separately'}`
    const table=document.createElement('table'),header=document.createElement('tr')
    for(const label of ['Driver','Speed','Relative position','Closing speed']){const th=document.createElement('th');th.textContent=label;header.append(th)}table.append(header)
    const lines:string[][]=[]
    if(compact){
      lines.push(['You',`${(Math.hypot(row[E['own.vx']]!,row[E['own.vy']]!)*3.6).toFixed(1)} km/h`,'—','—'])
      for(let k=0;k<(chunk.stride-EGO_STRIDE)/RIVAL_STRIDE;k++){
        const b=EGO_STRIDE+k*RIVAL_STRIDE;if(row[b+5]!==1)continue
        const forward=row[b]!,left=row[b+1]!,closing=-Math.sign(forward)*row[b+2]!
        lines.push([`Nearby car ${k+1}`,'—',`${Math.abs(forward).toFixed(1)} m ${forward>=0?'ahead':'behind'}, ${Math.abs(left).toFixed(1)} m ${left>=0?'left':'right'}`,`${(closing*3.6).toFixed(1)} km/h`])
      }
    }
    for(let i=0;!compact&&i<s.carCount;i++){
      const b=GLOBAL_FIELDS.length+i*CAR_FIELDS.length,tr=document.createElement('tr'),mine=i===s.playerSlot
      const forward=row[b+C.relativeForward]!,left=row[b+C.relativeLeft]!,velocity=row[b+C.relativeVForward]!
      const texts=[mine?'You':`Car ${i+1}`,`${(row[b+C.speed]!*3.6).toFixed(1)} km/h`,mine?'—':`${Math.abs(forward).toFixed(1)} m ${forward>=0?'ahead':'behind'}, ${Math.abs(left).toFixed(1)} m ${left>=0?'left':'right'}`,mine?'—':`${(-Math.sign(forward)*velocity*3.6).toFixed(1)} km/h`]
      for(const text of texts){const td=document.createElement('td');td.textContent=text;tr.append(td)}table.append(tr)
    }
    for(const texts of lines){const tr=document.createElement('tr');for(const text of texts){const td=document.createElement('td');td.textContent=text;tr.append(td)}table.append(tr)}
    panel.append(title,caption,table)
  }catch(error){say(error instanceof Error?error.message:'Could not preview this recording.',true)}
}
el('refresh').onclick=()=>void refresh()
el('folder-choose').onclick=()=>{
  if(!directoryPicker)return
  // Invoke the native picker before any asynchronous database work, while
  // this click still has the browser's required user activation.
  void directoryPicker.call(window,{mode:'readwrite',id:'bitepoint-driving-backups',startIn:'downloads'}).then(async directory=>{
    database??=await DrivingDatabase.open()
    folderConfig={id:crypto.randomUUID(),enabled:true,directory}
    await database.setMeta(FOLDER_CONFIG,folderConfig)
    folderStatus({state:'ready',folder:directory.name,message:'Automatic folder backups are on. Existing recordings will be backed up too.'})
    el('folder-off').hidden=false;el('folder-choose').textContent='Change backup folder'
    folderWorker?.postMessage('wake')
  }).catch(error=>{if(!(error instanceof DOMException&&error.name==='AbortError'))folderStatus({state:'error',folder:'',message:'Could not enable folder backups. Browser recordings are still saved.'})})
}
el('folder-access').onclick=()=>{
  if(!folderConfig)return
  void folderConfig.directory.requestPermission({mode:'readwrite'}).then(async permission=>{
    if(permission==='granted'){
      folderStatus({state:'ready',folder:folderConfig!.directory.name,message:'Folder access restored. Backups will catch up automatically.'})
      folderWorker?.postMessage('wake')
    }else folderStatus({state:'permission',folder:folderConfig!.directory.name,message:'Folder access is needed for file backups. Browser recordings are still saved.'})
  }).catch(()=>folderStatus({state:'permission',folder:folderConfig!.directory.name,message:'Could not restore access. Choose the backup folder again.'}))
}
el('folder-off').onclick=()=>{
  if(!database||!folderConfig)return
  folderConfig={...folderConfig,enabled:false}
  void database.setMeta(FOLDER_CONFIG,folderConfig).then(()=>{
    folderStatus({state:'off',folder:'',message:'Automatic folder backups are off. Existing files are kept.'})
    el('folder-choose').textContent='Choose backup folder';folderWorker?.postMessage('wake')
  }).catch(()=>say('Could not change the folder backup setting.',true))
}
el('export').onclick=()=>void exportData(items)
el('persist').onclick=()=>{void navigator.storage?.persist?.().then(granted=>{say(granted?'Persistent storage granted. Keep exporting backups.':'The browser kept its usual storage policy. Export backups regularly.');return refresh()}).catch(()=>say('Persistent storage is unavailable here. Exports still work.'))}
void refresh()
if(import.meta.hot)import.meta.hot.dispose(()=>folderWorker?.terminate())
