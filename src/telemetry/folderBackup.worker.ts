import { DrivingDatabase } from './database'
import { FolderBackups,type FolderStatus } from './folderBackup'
const send=(value:FolderStatus)=>postMessage(value)
const ready=DrivingDatabase.open().then(db=>new FolderBackups(db,send))
let running=false
async function tick():Promise<void>{
  if(running)return
  running=true
  try{
    if(!navigator.locks){send({state:'error',folder:'',message:'Automatic folder backups need a browser with file and lock support.'});return}
    // A game tab and a library tab may both be open. Never let two streams
    // overwrite the same recording out of order.
    await navigator.locks.request('bitepoint-folder-backup-v1',{ifAvailable:true},async lock=>{
      if(lock)await (await ready).run()
    })
  }catch{send({state:'error',folder:'',message:'Folder backups unavailable. Browser recordings are still saved.'})}
  finally{running=false}
}
self.onmessage=()=>void tick()
setInterval(()=>void tick(),5000)
void tick()
