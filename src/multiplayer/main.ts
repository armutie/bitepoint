// The main game's sheet first, for its HUD; this page's own sheet then wins.
import '../styles.css'
import './style.css'
import { loadSettings,saveSettings,fullLockFraction,cameraFeel } from '../ui/settings'
import { Track,type TrackData,loadManifest } from '../core/track'
import { type CarParams } from '../core/carParams'
import { reverseSelected,speedOf,type CarState } from '../core/car'
import { DT } from '../core/sim'
import { wrapAngle } from '../core/math'
import { Renderer } from '../render/renderer'
import { CAMERA_LABEL,CAMERA_ORDER } from '../render/cameras'
import { fieldLivery,liveryCss,PLAYER_LIVERY } from '../render/liveries'
import { COUNTDOWN_TICKS } from '../core/race'
import { Hud,type HudRaceState } from '../ui/hud'
import { proximityMarkers } from '../ui/proximity'
import { SectorClock,fastestSector } from './sectorClock'
import { InputState } from '../game/input'
import { Sound } from '../audio/sound'
import { PeerLink,RECOVERY_MS } from './connection'
import { createRoom,joinRoom,type Room } from './rooms'
import { hostLeadTicks, Predictor } from './prediction'
import { PROTOCOL,TRACKS,canonicalConfig,roomCarParams,roomTcLevel,validConfig,validSnapshot,type RoomConfig,type Ticket,type Snapshot } from './protocol'

const root=document.querySelector<HTMLDivElement>('#app')!
root.innerHTML=`<div class="mp-stage"><canvas id="picture" aria-label="Race view"></canvas></div>
<section class="mp-panel" id="home"><a class="mp-brand" href="./">Bite Point</a><a class="mp-back" href="./">← Back</a>
<p class="mp-kicker">Multiplayer · Private rooms for two</p><h1>Race a friend</h1><div class="mp-form">
<label class="mp-wide">Driver name<input id="name" maxlength="24" autocomplete="nickname" value="Driver"></label>
<label>Circuit<select id="track"></select></label><label>Handling<select id="preset"><option value="legacy">Low drag</option><option value="classic">High downforce</option></select></label>
<label>Laps<select id="laps"><option>1</option><option selected>3</option><option>5</option></select></label>
<label>Gearbox<select id="gearbox"><option value="auto">Automatic</option><option value="manual">Manual</option></select></label>
<label>Contact<select id="contact"><option value="off">Ghost racing</option><option value="on">Car contact · experimental</option></select></label>
<label>Easy mode<select id="easy"><option value="off">Off</option><option value="on">On</option></select></label>
<button id="host" class="mp-primary mp-wide">Host a room</button></div>
<p class="mp-kicker mp-or">Or join with a code</p>
<div class="mp-join"><input id="code" aria-label="Room code" maxlength="6" placeholder="Room code" autocomplete="off"><button id="join" class="mp-secondary">Join room</button></div>
<p class="mp-small">Your steering, camera and sound settings carry over from single player.</p><div id="home-status" role="status" class="mp-status"></div></section>
<section class="mp-panel" id="lobby" hidden><span class="mp-brand">Bite Point</span><p class="mp-kicker">Lobby</p><h1 id="room-title">Room</h1>
<div id="room-details" class="mp-room-details"></div><ul class="mp-drivers" id="drivers"></ul>
<div class="mp-invite"><input readonly id="invite" aria-label="Invite link"><button id="copy" class="mp-secondary">Copy invite</button></div>
<div id="lobby-status" class="mp-status" role="status">Connecting…</div>
<div class="mp-pause-actions"><button id="start" class="mp-primary" disabled>Start race</button><button id="leave" class="mp-secondary">Leave room</button></div></section>
<div class="mp-hud" id="hud" hidden><div id="countdown" class="mp-countdown"></div><div class="mp-controls" id="controls"></div><div class="mp-net" id="network"></div></div>
<section class="mp-panel" id="pause" hidden><span class="mp-brand">Bite Point</span><p class="mp-kicker">Multiplayer</p><h1 id="pause-title">Menu</h1><p id="pause-status" class="mp-small">The race continues. Your car will slow down.</p>
<div class="mp-settings"><label>Steering<select id="input"><option value="mouse">Mouse</option><option value="keyboard">Keyboard</option></select></label><label>Mouse sensitivity<input id="sensitivity" type="range" min="0" max="1" step="0.05"></label><label>Sound<input id="volume" type="range" min="0" max="1" step="0.05"></label></div>
<div class="mp-pause-actions"><button id="resume" class="mp-primary">Resume</button><button id="quit" class="mp-secondary">Leave room</button></div></section>`
const element=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T
const field=(id:string)=>element<HTMLInputElement>(id)
let settings=loadSettings()
const trackLabels=new Map<string,string>()
field('name').value=localStorage.getItem('bitepoint:multiplayer-name')??'Driver'
field('gearbox').value=settings.gearbox
// Start from the easy mode last used in single player.
try{field('easy').value=(JSON.parse(localStorage.getItem('car-racing:selection')??'{}') as {easy?:unknown}).easy===true?'on':'off'}catch{/* no saved selection */}
field('input').value=settings.inputMode;field('volume').value=String(settings.volume);field('sensitivity').value=String(settings.mouseSensitivity)
field('code').value=new URLSearchParams(location.search).get('room')?.toUpperCase().replace(/[^A-F0-9]/g,'').slice(0,6)??''
// Opened from an invite link: only the name and Join. The host already chose
// the circuit and settings, so the rest of the form is noise.
if(field('code').value.length===6){
  element('home').classList.add('is-invite')
  element('home').querySelector('h1')!.textContent='Join the race'
  element('home').querySelector('.mp-kicker')!.textContent='Multiplayer · You have been invited'
  field('code').readOnly=true
  element('join').classList.replace('mp-secondary','mp-primary')
  queueMicrotask(()=>element('join').focus())
}
field('name').addEventListener('keydown',e=>{if(e.key==='Enter'&&element('home').classList.contains('is-invite'))element('join').click()})
let renderer:Renderer|null=null,worker:Worker|null=null,link:PeerLink|null=null,ticket:Ticket|null=null,carParams:CarParams|null=null
let track:Track|null=null,predictor:Predictor|null=null,latest:Snapshot|null=null,prepared=false,verified=false,playing=false,inMenu=false,ended=false
let fingerprint='',names:[string,string|null]=['Host',null],lastSnapshot=0,ping=0,lastPing=0,lastHud=0
let lastFrame=performance.now(),accumulator=0,previous:CarState[]|null=null
let labDriveStarted=0
const lab=import.meta.env.DEV&&new URLSearchParams(location.search).has('lab')
if(lab){const box=document.createElement('div');box.className='mp-test';box.innerHTML='<button id="lab-drive">Straight test · 6 seconds</button><output id="diagnostics" style="display:block;max-width:320px;margin-top:8px"></output>';element('hud').append(box)
  element('lab-drive').onclick=()=>{labDriveStarted=performance.now()}}
let offsets=[{x:0,y:0,yaw:0},{x:0,y:0,yaw:0}]
const input=new InputState(),sound=new Sound(),canvas=element<HTMLCanvasElement>('picture')
// The single-player HUD: timing card, sectors, track map, shift lights, pedals
// and the proximity arrows, fed from the race snapshots.
const hud=new Hud();hud.root.classList.add('is-hidden');document.querySelector('.mp-stage')!.append(hud.root)
const clocks=[new SectorClock(),new SectorClock()]
let lastSteer=0,shownFastest=0
input.attach(canvas);input.mode=settings.inputMode;input.fullLockFraction=fullLockFraction(settings.mouseSensitivity)
sound.setLevel(0,true)
const fmt=(seconds:number)=>`${Math.floor(seconds/60)}:${(seconds%60).toFixed(3).padStart(6,'0')}`
const cloneStates=()=>predictor!.states.map(s=>({...s}))
/** Ticks to carry the other car forward: the host draws the guest where the guest is. */
const lead=()=>ticket?.slot===0?hostLeadTicks(ping):0
const displayStates=()=>predictor!.display(lead())
function notice(id:string,message:string,error=false):void{element(id).textContent=message;element(id).classList.toggle('is-error',error)}
function fail(message:string):void{
  if(ended)return;ended=true;playing=false;input.release();worker?.terminate();worker=null;link?.close();sound.setLevel(0,true)
  element('home').hidden=true;element('lobby').hidden=true;element('hud').hidden=true;hud.root.classList.add('is-hidden');element('pause').hidden=false
  element('pause-title').textContent='Race stopped';element('pause-status').textContent=message;element('pause-status').classList.add('mp-disconnect')
  element('resume').hidden=true
}
async function leave():Promise<void>{
  worker?.terminate();input.release();sound.setLevel(0,true)
  await link?.leave().catch(()=>{})
  location.href='./'
}
function sendHello():void{if(prepared&&link?.connected)link.controlSend({type:'hello',protocol:PROTOCOL,fingerprint})}
function updateReady():void{
  element<HTMLButtonElement>('start').disabled=!(prepared&&verified&&ticket?.slot===0)
  if(verified&&prepared)notice('lobby-status',ticket?.slot===0?'Both drivers ready.':'Ready. Waiting for the host to start.')
}
function enterRace():void{
  if(playing||ended)return;playing=true;input.release();element('lobby').hidden=true;element('hud').hidden=false;hud.root.classList.remove('is-hidden')
  sound.setLevel(settings.volume,settings.volume<=0);lastFrame=performance.now();accumulator=0
}
function snapshot(s:Snapshot):void{
  if(!predictor||!validSnapshot(s))return
  const before=cloneStates()
  if(!predictor.reconcile(s))return
  const after=predictor.states
  if(latest&&playing)for(let i=0;i<2;i++) {
    const dx=before[i]!.x-after[i]!.x,dy=before[i]!.y-after[i]!.y
    if(Math.hypot(dx,dy)<3){offsets[i]!.x+=dx;offsets[i]!.y+=dy;offsets[i]!.yaw+=wrapAngle(before[i]!.yaw-after[i]!.yaw)}
    else offsets[i]={x:0,y:0,yaw:0}
  }
  previous=cloneStates();latest=s;lastSnapshot=performance.now()
  if(track&&ticket)for(let i=0;i<2;i++){
    const car=s.cars[i]!,score=s.scores[i]!
    if(clocks[i]!.update(score,track.sectorAt(track.project(car.x,car.y).s))&&i===ticket.slot&&score.last!==null)flashLap(score.last,s)
  }
  if(s.phase!=='waiting')enterRace()
}
/** The lap banner, announcing the race's fastest lap as a single-player race does. */
function flashLap(time:number,s:Snapshot):void{
  const fastest=s.scores.every(c=>c.best===null||time<=c.best)
  if(fastest&&time!==shownFastest){shownFastest=time;hud.flashLap(time,true,true,'fastest')}
  else hud.flashLap(time,true,false)
}
/** Metres covered in the race, from the host's snapshot so laps and position agree. */
function progress(s:Snapshot,i:number):number{
  const car=s.cars[i]!,score=s.scores[i]!,road=track!.project(car.x,car.y).s
  // On the grid, behind the line, a car is at the end of the lap it has not started.
  return score.laps*track!.length+(!score.armed&&score.laps===0&&road>track!.length/2?road-track!.length:road)
}
function raceHud(s:Snapshot,t:Ticket,other:{x:number;y:number}):HudRaceState{
  const me=t.slot,them=1-me,score=s.scores[me]!,mine=clocks[me]!
  const order=[0,1].sort((a,b)=>s.scores[a]!.position-s.scores[b]!.position)
  const covered=[progress(s,0),progress(s,1)]
  return {
    position:score.position,size:2,lap:score.laps+1,laps:t.config.laps,gapAhead:null,gapBehind:null,
    countdown:s.countdown/60,lights:s.phase==='countdown'?Math.min(5,Math.floor((COUNTDOWN_TICKS-s.countdown)/(COUNTDOWN_TICKS/5))):0,
    starting:s.phase==='waiting'||s.phase==='countdown',launchHint:'',finished:score.finish!==null,
    lastVsBest:score.last!==null&&score.best!==null&&score.last>score.best?score.last-score.best:null,
    purpleSectors:mine.splits.map((x,i)=>fastestSector(clocks,i,x)),
    purpleLastSectors:mine.lastSplits.map((x,i)=>fastestSector(clocks,i,x)),
    standings:order.map((slot,i)=>({position:i+1,isPlayer:slot===me,name:slot===me?'You':names[slot]??'Driver',interval:null,
      intervalMetres:i===0?0:Math.max(0,covered[order[0]!]!-covered[slot]!),laps:s.scores[slot]!.laps,finished:s.scores[slot]!.finish!==null,
      colour:liveryCss(slot===me?PLAYER_LIVERY:fieldLivery(them))})),
    mapDots:[{x:other.x,y:other.y,leader:order[0]===them}],
  }
}
async function prepare(t:Ticket):Promise<void>{
  if(!validConfig(t.config))throw new Error('This room uses a different game version. Reload both games.')
  const response=await fetch(`./tracks/${t.config.trackId}.json`);if(!response.ok)throw new Error('Could not load the circuit.')
  const data=await response.json() as TrackData;track=new Track(data)
  const bytes=new TextEncoder().encode(JSON.stringify({protocol:PROTOCOL,data,params:roomCarParams(t.config),config:canonicalConfig(t.config)}))
  fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('')
  predictor=new Predictor(track,t.config,t.slot);previous=cloneStates();carParams=roomCarParams(t.config)
  renderer=new Renderer(canvas);renderer.applySettings({effects:settings.effects,performanceMode:settings.performanceMode,...cameraFeel(settings.effects)})
  renderer.setCameraMode(settings.camera)
  hud.setTrack(track)
  await renderer.setTrack(track);renderer.setCars(carParams,false);renderer.setOpponents(carParams,1,[t.slot===0?1:0])
  if(ended)return
  if(t.slot===0){worker=new Worker(new URL('./host.worker.ts',import.meta.url),{type:'module'})
    worker.onmessage=e=>{
      if(e.data.type==='stalled'){link?.controlSend({type:'closed',reason:'The host could not keep the race running.'});fail('The host was suspended or could not keep the race running. Create a new room.');return}
      if(e.data.type==='snapshot'){snapshot(e.data.snapshot as Snapshot);// Relayed, every other snapshot (30 Hz) keeps within the room's message
        // limits; prediction carries the guest between them.
        const tick=(e.data.snapshot as Snapshot).tick
        if(verified&&(!link?.relayed||tick%2===0))link?.fastSend({type:'snapshot',snapshot:e.data.snapshot})}
    };worker.onerror=()=>fail('The race host stopped unexpectedly.');worker.postMessage({type:'init',track:data,config:t.config})}
  prepared=true;input.refreshBounds();sendHello();updateReady()
  element('controls').textContent=`W / S pedals · ${settings.inputMode==='mouse'?'Mouse':'A / D'} steering${t.config.manual?' · E / Q gears':''} · Esc menu`
}
async function connect(room:Room):Promise<void>{
  const t=room.ticket
  ticket=t;element('home').hidden=true;element('lobby').hidden=false;element('room-title').textContent=`Room ${t.code}`
  element('start').hidden=t.slot!==0
  const invite=new URL('multiplayer.html',location.href);invite.searchParams.set('room',t.code);field('invite').value=invite.href
  const label=trackLabels.get(t.config.trackId)??t.config.trackId
  element('room-details').textContent=`${label} · ${t.config.laps} laps · ${t.config.preset==='legacy'?'Low drag':'High downforce'} · ${t.config.manual?'Manual':'Automatic'}${t.config.easy?' · Easy mode':''} · ${t.config.contact?'Car contact':'Ghost racing'}`
  // `?relay` skips the direct link, to try the relay on one network.
  link=new PeerLink(room,{forceRelay:new URLSearchParams(location.search).has('relay')})
  link.onLobby=s=>{names=s.names;element('drivers').replaceChildren(...names.map((n,i)=>{
    // Numbered rows, as on the main menu: the empty seat reads as waiting, not missing.
    const li=document.createElement('li');li.classList.toggle('is-empty',!n)
    const num=document.createElement('span');num.className='mp-driver-num';num.textContent=`0${i+1}`
    const who=document.createElement('span');who.className='mp-driver-name';who.textContent=n??'Waiting for a driver…'
    const tag=document.createElement('span');tag.className='mp-driver-tag';tag.textContent=!n?'':i===t.slot?'You':i===0?'Host':'Guest'
    li.append(num,who,tag);return li}))
    if(!verified)notice('lobby-status',!names[1]?'Share the invite with the other driver.':prepared?'Connecting drivers…':'Loading circuit…')}
  link.onOpen=()=>{notice('lobby-status',prepared?'Checking both games…':'Loading circuit…');sendHello()}
  link.onError=fail
  link.onControl=value=>{
    if(!value||typeof value!=='object')return
    const m=value as {type?:string;protocol?:string;fingerprint?:string;sent?:number;reason?:string}
    if(m.type==='hello'){
      if(!prepared)return
      if(m.protocol!==PROTOCOL||m.fingerprint!==fingerprint){fail('The two games have different circuit or physics data. Reload both games.');return}
      const first=!verified;verified=true;if(first)sendHello();updateReady();if(t.slot===0&&latest)link?.fastSend({type:'snapshot',snapshot:latest})
    }
    if(m.type==='ping'&&typeof m.sent==='number')link?.controlSend({type:'pong',sent:m.sent})
    if(m.type==='pong'&&typeof m.sent==='number'){const rtt=Math.max(0,performance.now()-m.sent)
      // Smoothed, so one slow packet does not make the other car lurch.
      ping=ping?ping+(rtt-ping)*0.2:rtt}
    if(m.type==='closed')fail(typeof m.reason==='string'?m.reason.slice(0,160):'The other driver left the room.')
  }
  link.onFast=value=>{
    if(!verified||!value||typeof value!=='object')return
    const m=value as {type?:string;frames?:unknown;snapshot?:unknown}
    if(t.slot===0&&m.type==='input')worker?.postMessage({type:'input',slot:1,frames:m.frames})
    if(t.slot===1&&m.type==='snapshot'&&validSnapshot(m.snapshot))snapshot(m.snapshot)
  }
  await Promise.all([link.open(),prepare(t)])
}
async function begin(host:boolean):Promise<void>{
  if(ticket)return
  const name=field('name').value.trim();if(!name){notice('home-status','Enter your driver name.',true);return}
  element<HTMLButtonElement>('host').disabled=true;element<HTMLButtonElement>('join').disabled=true
  notice('home-status',host?'Creating room…':'Joining room…');sound.start();sound.setLevel(0,true)
  localStorage.setItem('bitepoint:multiplayer-name',name)
  try{
    const c:RoomConfig={protocol:PROTOCOL,trackId:field('track').value,preset:field('preset').value==='classic'?'classic':'legacy',
      laps:Number(field('laps').value),manual:field('gearbox').value==='manual',easy:field('easy').value==='on',contact:field('contact').value==='on'}
    const room=host?await createRoom(name,c):await joinRoom(name,field('code').value)
    await connect(room)
  }catch(e){const message=e instanceof Error?e.message:'Could not connect.'
    if(ticket)fail(message);else{notice('home-status',message.includes('JSON')||message.includes('fetch')?'Room service unavailable. Please try again.':message,true)
      element<HTMLButtonElement>('host').disabled=false;element<HTMLButtonElement>('join').disabled=false}}
}
element('host').onclick=()=>void begin(true);element('join').onclick=()=>void begin(false)
element('copy').onclick=()=>{void navigator.clipboard.writeText(field('invite').value).then(()=>notice('lobby-status','Invite copied.')).catch(()=>{field('invite').focus();field('invite').select();notice('lobby-status','Copy the selected invite link.')})}
element('leave').onclick=()=>void leave();element('quit').onclick=()=>void leave()
element('start').onclick=()=>{if(verified&&prepared&&ticket?.slot===0){worker?.postMessage({type:'start'});element<HTMLButtonElement>('start').disabled=true}}
function menu(open:boolean):void{
  if(!playing||ended)return;inMenu=open;element('pause').hidden=!open
  if(open)input.release(true);else{input.resume();sound.start()}
}
element('resume').onclick=()=>menu(false)
input.onAction=a=>{
  if(a==='pause')menu(!inMenu)
  if(a==='camera'&&renderer){const next=CAMERA_ORDER[(CAMERA_ORDER.indexOf(settings.camera)+1)%CAMERA_ORDER.length]!;settings={...settings,camera:next};renderer.setCameraMode(next)}
}
function preferences():void{
  settings={...settings,inputMode:field('input').value==='keyboard'?'keyboard':'mouse',volume:Number(field('volume').value),mouseSensitivity:Number(field('sensitivity').value)}
  saveSettings(settings);input.mode=settings.inputMode;input.fullLockFraction=fullLockFraction(settings.mouseSensitivity)
  sound.setLevel(settings.volume,settings.volume<=0)
  if(ticket)element('controls').textContent=`W / S pedals · ${settings.inputMode==='mouse'?'Mouse':'A / D'} steering${ticket.config.manual?' · E / Q gears':''} · Esc menu`
}
for(const id of ['input','volume','sensitivity'])element(id).oninput=preferences
window.addEventListener('resize',()=>{renderer?.resize();input.refreshBounds()})
window.addEventListener('pagehide',()=>{worker?.terminate();link?.close();sound.setLevel(0,true)})
function frame(now:number):void{
  const wall=Math.min((now-lastFrame)/1000,0.1);lastFrame=now
  if(predictor&&renderer&&track&&ticket&&!ended){
    accumulator+=wall
    while(accumulator>=DT){accumulator-=DT
      if(verified){previous=displayStates();const vx=predictor.states[ticket.slot]!.vx,c=input.sample(vx<=0.5);lastSteer=inMenu?0:c.steer
        const cruise=labDriveStarted>0&&now-labDriveStarted<6000
        const f=predictor.frame(inMenu?0:labDriveStarted?0:c.steer,inMenu?(vx>0.5?-0.25:0):cruise?Math.min(.7,(now-labDriveStarted)/1200):labDriveStarted?0:c.throttle,inMenu?0:input.takeShift(),roomTcLevel(ticket.config))
        if(ticket.slot===0)worker?.postMessage({type:'input',slot:0,frames:[f]})
        // Each batch repeats the unacknowledged inputs, so relayed at 30 Hz nothing is lost.
        else if(!link?.relayed||f.seq%2===0)link?.fastSend({type:'input',frames:predictor.batch()})}
    }
    const alpha=accumulator/DT,states=displayStates().map((s,i)=>{
      const p=previous?.[i]??s,o=offsets[i]!,decay=Math.exp(-wall/0.10);o.x*=decay;o.y*=decay;o.yaw*=decay
      return {...s,x:p.x+(s.x-p.x)*alpha+o.x,y:p.y+(s.y-p.y)*alpha+o.y,yaw:p.yaw+wrapAngle(s.yaw-p.yaw)*alpha+o.yaw}
    })
    const local=states[ticket.slot]!,p=carParams!,proj=track.project(local.x,local.y)
    renderer.setOpponentStates([states[1-ticket.slot]!]);renderer.rig.lookBack=input.lookBack
    renderer.render(local,null,p,inMenu?0:input.pedals.throttle,wall,{lateral:proj.lateral,half:proj.half,margin:1.2})
    if(playing){sound.update({speed:speedOf(local),vx:local.vx,wheelVr:local.wheelVr,slipF:local.slipF,slipR:local.slipR,
      onKerb:Math.abs(proj.lateral)>proj.half-0.5,onGrass:Math.abs(proj.lateral)>proj.half+1.2,
      rpm:local.engineRpm,redlineRpm:p.redlineRpm,idleRpm:p.idleRpm,gear:local.gear,throttle:inMenu?0:input.pedals.throttle-input.pedals.brake,shiftTimer:local.shiftTimer})}
    if(playing&&latest){
      const other=states[1-ticket.slot]!,score=latest.scores[ticket.slot]!,clock=clocks[ticket.slot]!
      const lookBack=input.lookBack&&(renderer.rig.mode==='halo'||renderer.rig.mode==='hood')
      hud.update({
        race:raceHud(latest,ticket,other),
        proximity:renderer.rig.mode==='topDown'?[]:proximityMarkers(local,p,[{slot:1-ticket.slot,state:other,params:p}],lookBack,track),
        speedKmh:speedOf(local)*3.6,gear:local.gear,reverse:reverseSelected(local),rpm:local.engineRpm,redlineRpm:p.redlineRpm,
        currentLap:score.armed?score.lapTime:0,lastLap:score.last,bestLap:score.best,lapValid:true,timingArmed:score.armed,ghostDelta:null,
        sectors:clock.splits,sectorDeltas:clock.deltas,sectorBestFlags:[false,false,false],
        lastSectors:clock.lastSplits,lastSectorDeltas:clock.lastDeltas,lastSectorBestFlags:[false,false,false],lastLapValid:true,bestSectors:clock.best,
        throttle:inMenu?0:input.pedals.throttle,brake:inMenu?0:input.pedals.brake,steer:lastSteer,
        cameraLabel:CAMERA_LABEL[renderer.rig.mode],inputLabel:`${input.mode==='mouse'?'Mouse':'Keys'} · ${ticket.config.manual?'Manual':'Auto'}`,
        viewportLabel:'Full screen',easy:ticket.config.easy,ghost:false,lapCount:score.laps,validLaps:score.laps,lapFraction:0,
        carX:local.x,carY:local.y,sector:track.sectorAt(proj.s),ghostX:null,ghostY:null,tcLevel:roomTcLevel(ticket.config),abs:false,absBite:0,tcBite:0,
      })
    }
    // Matches the link's recovery window: a blip shows as Reconnecting, not an ended race.
    if(verified&&latest&&now-lastSnapshot>RECOVERY_MS)fail('Race updates stopped. The room has ended.')
    if(verified&&now-lastPing>1000){lastPing=now;link?.controlSend({type:'ping',sent:now})}
    if(latest&&now-lastHud>80){lastHud=now;const score=latest.scores[ticket.slot]!
      element('countdown').textContent=score.finish!==null?`Finished P${score.position} · ${fmt(score.finish)}`:latest.phase==='finished'?'Race finished':''
      element('network').textContent=link?.reconnecting||now-lastSnapshot>500?'Reconnecting…':`${Math.round(ping)} ms · ${link?.relayed?'Relay':'Direct'}`
      if(lab)element('diagnostics').textContent=`${ticket.slot===0?'Host':'Guest'} · Tick ${latest.tick} · Input ${predictor.sequence} / ack ${latest.ack[ticket.slot]} · Queue ${predictor.queueSize} · Pedal ${latest.actions[ticket.slot]!.throttle.toFixed(2)} · Correction ${predictor.correction.toFixed(3)} m`
    }
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
void loadManifest().then(manifest=>{
  const select=element<HTMLSelectElement>('track');for(const id of TRACKS){const t=manifest.find(m=>m.id===id);if(!t)continue;trackLabels.set(id,t.label);const o=document.createElement('option');o.value=id;o.textContent=t.label;select.append(o)}
}).catch(()=>notice('home-status','Could not load the circuit list. Reload the game.',true))
if(import.meta.hot)import.meta.hot.dispose(()=>{worker?.terminate();link?.close();renderer?.dispose();input.detach();sound.dispose()})
