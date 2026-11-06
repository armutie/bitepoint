import type { CarState } from '../core/car'
import { carLength,type PresetName } from '../core/carParams'
import { wrapAngle } from '../core/math'
import type { RaceSession } from '../core/raceSession'
import { DT,type StepResult,type TimeAttackSim } from '../core/sim'
import type { Projection,Track } from '../core/track'
import { CURRENT_PHYSICS_RULESET,LEGACY_PHYSICS_RULESET } from '../shared/ruleset'
import { C,CAR_FIELDS,G,GLOBAL_FIELDS,PHASES,SCHEMA_VERSION,SOURCES,columns,trackData,type ControlSource,type DriveAsset } from './schema'
import { DriveRecorder,newMetadata } from './recorder'
import { drivingLibraryUrl } from './urls'
import { startFolderBackups,type FolderStatus } from './folderBackup'
import { COMPACT_ENCODING,compactColumns,E,EGO_STRIDE,RIVAL_STRIDE,NearbyCars,TRAFFIC_AWARENESS } from './compact'

export interface RequestedControls {
  steer:number; pedal:number; shift:number; tc:number; throttlePedal:number; brakePedal:number
  throttleHeld:boolean; brakeHeld:boolean; clutchHeld:boolean;lookBack:boolean;inputMode:'mouse'|'keyboard';sensitivity:number;source:ControlSource
}
export interface CaptureSetup {
  track:Track;sims:readonly TimeAttackSim[];race:RaceSession|null;playerSlot:number;preset:PresetName;easy:boolean
  mode:'time-trial'|'race'|'qualifying';legacyTyres:boolean;buildId:string;purpose?:'personal'|'verification'
}
const wrapGap=(a:number,b:number,length:number)=>((a-b+length*1.5)%length)-length*.5
function worldVelocity(s:CarState):[number,number]{
  const c=Math.cos(s.yaw),sn=Math.sin(s.yaw);return [s.vx*c-s.vy*sn,s.vx*sn+s.vy*c]
}
/** Captures s_t before controls, then a_t and outcome signals after the real step. */
export class DrivingCapture {
  private setup:CaptureSetup|null=null
  private roads:Projection[]=[]
  private row:Float64Array|Float32Array|null=null
  private compact=false
  private physicalTick=0
  private nearby=new NearbyCars()
  private previousId:string|null=null
  private currentId:string|null=null
  constructor(readonly recorder:DriveRecorder,private readonly options:{format?:'learning'|'diagnostic'}={}){}
  start(setup:CaptureSetup):void{
    this.finish('new-session');this.setup=setup
    const {track,sims,race,playerSlot}=setup
    const diagnostic=this.options.format==='diagnostic'||(typeof location!=='undefined'&&new URLSearchParams(location.search).has('diagnosticDrivingData'))
    this.compact=!diagnostic&&sims.length<=8;this.physicalTick=0;this.nearby.reset()
    const metadata=newMetadata({mode:setup.mode,trackId:track.id,trackLabel:track.label,preset:setup.preset,playerSlot,carCount:sims.length,easy:setup.easy,
      seed:race?.seed??null,difficulty:race?.difficulty.name??null,targetLaps:race?.laps??null,previousId:this.previousId,initialStates:this.compact?[]:sims.map(sim=>({...sim.car.s})),purpose:setup.purpose??'personal'})
    const asset:DriveAsset={schemaVersion:this.compact?2:SCHEMA_VERSION,physicsRuleset:setup.legacyTyres?LEGACY_PHYSICS_RULESET:CURRENT_PHYSICS_RULESET,
      buildId:setup.buildId,track:trackData(track),dt:DT,columns:this.compact?compactColumns(sims.length-1):columns(sims.length),encoding:this.compact?COMPACT_ENCODING:'column-major-float64-le',missing:'NaN',phases:PHASES,sources:SOURCES,
      drivers:sims.flatMap((sim,slot)=>this.compact&&slot!==playerSlot?[]:[{slot,identity:race?.driverIdOf(slot)??slot,role:slot===playerSlot?'human' as const:'ai' as const,params:sim.car.p,manual:sim.car.manual,brakeAwareAuto:sim.car.brakeAwareAuto}]),
      ...(this.compact?{trafficAwareness:TRAFFIC_AWARENESS,nearbyDrivers:sims.flatMap((_,slot)=>slot===playerSlot?[]:[{slot,identity:race?.driverIdOf(slot)??slot}])}:{})}
    this.currentId=metadata.id;this.recorder.start(metadata,asset,()=>this.compact?[]:sims.map(sim=>({...sim.car.s})))
  }
  begin(input:RequestedControls):void{
    if(this.compact){this.beginCompact(input);return}
    this.row=this.recorder.beginFrame();if(!this.row||!this.setup)return
    const row=this.row,{track,sims,race,playerSlot}=this.setup,player=sims[playerSlot]!.car.s
    const pc=Math.cos(player.yaw),ps=Math.sin(player.yaw),pv=worldVelocity(player)
    row[G.tick]=this.recorder.tick;row[G.time]=this.recorder.tick*DT
    row[G.phase]=PHASES.indexOf(race?.phase??'solo');row[G.controlSource]=SOURCES.indexOf(input.source)
    row[G.requestedSteer]=input.steer;row[G.requestedPedal]=input.pedal;row[G.requestedShift]=input.shift;row[G.requestedTc]=input.tc
    row[G.throttlePedal]=input.throttlePedal;row[G.brakePedal]=input.brakePedal;row[G.throttleHeld]=+input.throttleHeld;row[G.brakeHeld]=+input.brakeHeld
    row[G.clutchHeld]=+input.clutchHeld;row[G.lookBack]=+input.lookBack;row[G.inputMode]=input.inputMode==='mouse'?0:1;row[G.sensitivity]=input.sensitivity
    row[G.raceTime]=race?.race.raceTime??NaN
    this.roads.length=0
    for(const sim of sims)this.roads.push(track.project(sim.car.s.x,sim.car.s.y))
    const order=race?.race.standings()??[0],pr=this.roads[playerSlot]!
    const playerProgress=race?.race.distanceTravelled(playerSlot)??(sims[playerSlot]!.lapsCompleted*track.length+pr.s)
    for(let slot=0;slot<sims.length;slot++){
      const sim=sims[slot]!,s=sim.car.s,road=this.roads[slot]!,b=GLOBAL_FIELDS.length+slot*CAR_FIELDS.length
      row[b+C.x]=s.x;row[b+C.y]=s.y;row[b+C.yaw]=s.yaw;row[b+C.vx]=s.vx;row[b+C.vy]=s.vy;row[b+C.r]=s.r
      row[b+C.steer]=s.steer;row[b+C.wheelVr]=s.wheelVr;row[b+C.slipF]=s.slipF;row[b+C.slipR]=s.slipR
      row[b+C.gear]=s.gear;row[b+C.shiftTimer]=s.shiftTimer;row[b+C.engineRpm]=s.engineRpm
      row[b+C.trackS]=road.s;row[b+C.lateral]=road.lateral;row[b+C.trackHeading]=road.heading;row[b+C.halfWidth]=road.half
      row[b+C.curvature]=track.signedCurvature[road.segment]!
      const progress=race?.race.distanceTravelled(slot)??(sim.lapsCompleted*track.length+road.s)
      row[b+C.progress]=progress;row[b+C.laps]=sim.lapsCompleted;row[b+C.timingArmed]=+sim.timingArmed;row[b+C.lapValid]=+sim.lapValid
      row[b+C.lapTime]=sim.currentLapTime;row[b+C.position]=order.indexOf(slot)+1;row[b+C.speed]=sim.speed
      if(slot!==playerSlot){
        const dx=s.x-player.x,dy=s.y-player.y,v=worldVelocity(s),dvx=v[0]-pv[0],dvy=v[1]-pv[1]
        const forward=dx*pc+dy*ps,left=-dx*ps+dy*pc,vr=dvx*pc+dvy*ps,angle=wrapAngle(s.yaw-player.yaw)
        const hl=carLength(sim.car.p)/2,hw=sim.car.p.width/2
        const extentF=carLength(sims[playerSlot]!.car.p)/2+Math.abs(Math.cos(angle))*hl+Math.abs(Math.sin(angle))*hw
        const extentS=sims[playerSlot]!.car.p.width/2+Math.abs(Math.sin(angle))*hl+Math.abs(Math.cos(angle))*hw
        row[b+C.relativeForward]=forward;row[b+C.relativeLeft]=left;row[b+C.relativeVForward]=vr;row[b+C.relativeVLeft]=-dvx*ps+dvy*pc
        row[b+C.headingDelta]=angle;row[b+C.roadGap]=wrapGap(road.s,pr.s,track.length);row[b+C.progressGap]=progress-playerProgress
        row[b+C.distance]=Math.hypot(dx,dy);row[b+C.forwardClearance]=Math.abs(forward)-extentF;row[b+C.sideClearance]=Math.abs(left)-extentS
        row[b+C.overlap]=+(Math.abs(forward)<extentF&&Math.abs(left)<extentS)
        row[b+C.timeToContact]=Math.abs(left)<extentS&&forward*vr<0?Math.max(0,Math.abs(forward)-extentF)/Math.abs(vr):NaN
        if(race){const gap=progress>=playerProgress?race.gapSeconds(slot,playerSlot):race.gapSeconds(playerSlot,slot)
          row[b+C.gapSeconds]=gap===null?NaN:gap*(progress>=playerProgress?1:-1)}
      }
    }
  }
  end(result:StepResult):void{
    if(this.compact){this.endCompact(result);return}
    if(!this.row||!this.setup)return
    const {sims,race,playerSlot}=this.setup,row=this.row
    for(let slot=0;slot<sims.length;slot++){
      const sim=sims[slot]!,b=GLOBAL_FIELDS.length+slot*CAR_FIELDS.length,a=sim.lastStepControls
      row[b+C.appliedSteer]=a.steer;row[b+C.appliedPedal]=a.pedal;row[b+C.appliedShift]=a.shift;row[b+C.appliedTc]=a.tc??NaN
      row[b+C.gripMultiplier]=a.grip;row[b+C.rollingMultiplier]=a.rolling
      row[b+C.nextTcCut]=sim.car.tcCut;row[b+C.nextAbsCut]=sim.car.absCut;row[b+C.wallImpulse]=sim.wallImpact;row[b+C.carImpulse]=race?.race.impacts[slot]??0
      row[b+C.nextOffTrack]=+sim.offTrack;row[b+C.nextLapValid]=+sim.lapValid;row[b+C.penaltySeconds]=race?.race.trackLimits[slot]?.penaltySeconds??0
      if(slot===playerSlot){row[b+C.crossedFinish]=+result.crossedFinish;row[b+C.completedLapTime]=result.lapCompleted?.time??NaN}
    }
    this.row=null;this.recorder.endFrame()
  }
  private beginCompact(input:RequestedControls):void{
    if(!this.setup)return
    const {sims,race,playerSlot,track}=this.setup
    if(input.source!=='human'||(race&&race.phase!=='racing')||(race?.launch&&race.launch.state!=='launched')){
      this.row=null;this.nearby.reset();return
    }
    const row=this.recorder.beginFrame();this.row=row;if(!row)return
    // Clear absent rivals. No requested controls, input-device flags, remote
    // vehicle state or redundant road-derived fields enter this buffer.
    row.fill(0);row[E['own.completedLapTime']]=NaN
    const own=sims[playerSlot]!.car.s
    row[E.simTick]=this.physicalTick
    for(const field of ['x','y','yaw','vx','vy','r','steer','slipF','slipR'] as const)row[E[`own.${field}`]]=own[field]
    row[E['own.lapValid']]=+sims[playerSlot]!.lapValid;row[E['own.timingArmed']]=+sims[playerSlot]!.timingArmed
    const road=track.project(own.x,own.y),velocity=worldVelocity(own),c=Math.cos(own.yaw),sn=Math.sin(own.yaw)
    if(race)this.nearby.observe(this.physicalTick*DT,sims.map((_,slot)=>race.race.distanceTravelled(slot)),track.length)
    let k=0
    for(let slot=0;slot<sims.length;slot++)if(slot!==playerSlot){
      const rival=sims[slot]!.car.s,v=worldVelocity(rival),dx=rival.x-own.x,dy=rival.y-own.y,dvx=v[0]-velocity[0],dvy=v[1]-velocity[1]
      const values=[Math.fround(dx*c+dy*sn),Math.fround(-dx*sn+dy*c),Math.fround(dvx*c+dvy*sn),Math.fround(-dvx*sn+dvy*c),Math.fround(wrapAngle(rival.yaw-own.yaw))]
      if(this.nearby.includes(k,values[0]!,values[1]!,()=>wrapGap(track.project(rival.x,rival.y).s,road.s,track.length),()=>this.nearby.gapSeconds(playerSlot,slot))){
        const base=EGO_STRIDE+k*RIVAL_STRIDE
        for(let j=0;j<5;j++)row[base+j]=values[j]!
        row[base+5]=1
      }
      k++
    }
  }
  private endCompact(result:StepResult):void{
    this.physicalTick++
    if(!this.row||!this.setup)return
    const row=this.row,{sims,race,playerSlot}=this.setup,sim=sims[playerSlot]!,a=sim.lastStepControls
    row[E['own.appliedSteer']]=a.steer;row[E['own.appliedPedal']]=a.pedal
    row[E['own.carImpulse']]=race?.race.impacts[playerSlot]??0;row[E['own.wallImpulse']]=sim.wallImpact
    row[E['own.nextOffTrack']]=+sim.offTrack;row[E['own.nextLapValid']]=+sim.lapValid
    row[E['own.completedLapTime']]=result.lapCompleted?.time??NaN;row[E['own.penaltySeconds']]=race?.race.trackLimits[playerSlot]?.penaltySeconds??0
    this.row=null;this.recorder.endFrame()
  }
  event(type:string,detail=''):void{if(this.compact)this.nearby.reset();this.recorder.event(type,detail)}
  flush():void{this.recorder.flush()}
  finish(reason:string):void{
    if(!this.setup)return
    this.recorder.finish(reason,this.compact?[]:this.setup.sims.map(s=>({...s.car.s})));this.setup=null;this.row=null
    this.previousId=this.currentId;this.currentId=null
  }
}

export function telemetryBadge(recorder:DriveRecorder):HTMLAnchorElement{
  const link=document.createElement('a');link.href=drivingLibraryUrl(document.baseURI);link.target='_blank';link.rel='noopener'
  link.setAttribute('aria-label','Driving recordings');link.style.cssText='position:fixed;right:12px;bottom:9px;z-index:45;padding:4px 7px;border-radius:3px;background:#131920b0;color:#bbc9b9;font:11px system-ui;text-decoration:none;max-width:320px;pointer-events:auto'
  let folderStatus:FolderStatus|null=null
  const update=()=>{
    const attention=folderStatus?.state==='permission'||folderStatus?.state==='error'
    link.textContent=attention?`${recorder.status.message} · Folder backup needs attention`:recorder.status.message
    link.title=`${recorder.status.frames} captured frames · ${recorder.status.savedFrames} confirmed saved${folderStatus&&folderStatus.state!=='off'?` · ${folderStatus.message}`:''}`
    link.style.color=recorder.status.state==='error'||attention?'#ffbca0':'#bbc9b9';link.hidden=recorder.status.state==='ready'&&!attention
  }
  const worker=startFolderBackups(status=>{folderStatus=status;update()})
  if(import.meta.hot)import.meta.hot.dispose(()=>worker?.terminate())
  recorder.onStatus=()=>{update();if(recorder.status.state==='saved')worker?.postMessage('wake')};update();return link
}
