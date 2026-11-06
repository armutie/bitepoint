import type { CarParams, PresetName } from '../core/carParams'
import type { CarState } from '../core/car'
import type { Track, TrackData } from '../core/track'
import type { SparseRival } from './compact'

export const SCHEMA_VERSION = 1
export const SAMPLE_HZ = 60
export const CHUNK_FRAMES = 120
export const GLOBAL_FIELDS = ['tick','time','phase','controlSource','requestedSteer','requestedPedal','requestedShift','requestedTc',
  'throttlePedal','brakePedal','throttleHeld','brakeHeld','clutchHeld','lookBack','inputMode','sensitivity','raceTime'] as const
export const CAR_FIELDS = ['x','y','yaw','vx','vy','r','steer','wheelVr','slipF','slipR','gear','shiftTimer','engineRpm',
  'trackS','lateral','trackHeading','halfWidth','curvature','progress','laps','timingArmed','lapValid','lapTime','position','speed',
  'relativeForward','relativeLeft','relativeVForward','relativeVLeft','headingDelta','roadGap','progressGap','gapSeconds',
  'distance','forwardClearance','sideClearance','overlap','timeToContact',
  'appliedSteer','appliedPedal','appliedShift','appliedTc','gripMultiplier','rollingMultiplier',
  'nextTcCut','nextAbsCut','wallImpulse','carImpulse','nextOffTrack','nextLapValid','crossedFinish','completedLapTime','penaltySeconds'] as const
export const G = Object.fromEntries(GLOBAL_FIELDS.map((v,i)=>[v,i])) as Record<typeof GLOBAL_FIELDS[number],number>
export const C = Object.fromEntries(CAR_FIELDS.map((v,i)=>[v,i])) as Record<typeof CAR_FIELDS[number],number>
export const PHASES = ['solo','waiting','countdown','racing','finished'] as const
export const SOURCES = ['human','qualifying-intro','reference-driver'] as const
export type ControlSource = typeof SOURCES[number]
export interface DriverAsset {
  slot:number; identity:number; role:'human'|'ai'; params:CarParams; manual:boolean; brakeAwareAuto:boolean|2
}
export interface DriveAsset {
  schemaVersion:number; physicsRuleset:string; buildId:string; track:TrackData; drivers:DriverAsset[]
  columns:string[]; dt:number; encoding:'column-major-float64-le'|'learning-compact-v2'; missing:'NaN'; phases:readonly string[]; sources:readonly string[]
  nearbyDrivers?:{slot:number;identity:number}[]
  trafficAwareness?:'timing-gap-1s-v1'
}
export interface DriveMetadata {
  id:string; assetId?:string; driverId?:string; createdAt:number; updatedAt:number; mode:'time-trial'|'race'|'qualifying'
  trackId:string; trackLabel:string; preset:PresetName; playerSlot:number; carCount:number; easy:boolean
  seed:number|null; difficulty:string|null; targetLaps:number|null; previousId:string|null; initialStates:CarState[]
  state:'open'|'complete'|'error'; endReason:string|null; frames:number; chunks:number; bytes:number; eventCount:number
  terminalStates:CarState[]|null; error:string|null
  purpose:'personal'|'verification'; useForTraining:boolean
}
export interface RecordingEvent {sessionId:string; index:number; tick:number; at:number; type:string; detail:string}
export interface StoredChunk {
  sessionId:string; index:number; firstTick:number; rows:number; stride:number; gzip:boolean; checksum:string; payload:Blob;terminalStates:CarState[]
  format?:'learning-compact-v2';rivals?:SparseRival[]
}
export interface RecordingStatus {state:'ready'|'recording'|'saving'|'saved'|'error'; frames:number; savedFrames:number; bytes:number; message:string}
export type WorkerInput =
  | {type:'start'; metadata:DriveMetadata; asset:DriveAsset}
  | {type:'chunk'; sessionId:string; index:number; firstTick:number; rows:number; stride:number; data:ArrayBuffer;terminalStates:CarState[]}
  | {type:'event'; event:RecordingEvent}
  | {type:'finish'; sessionId:string; reason:string; terminalStates:CarState[]}
export type WorkerOutput = {type:'ready'}|{type:'saved';sessionId:string;frames:number;bytes:number;chunkIndex:number}|{type:'finished';sessionId:string}
  |{type:'error';message:string}

export function columns(carCount:number):string[]{
  return [...GLOBAL_FIELDS,...Array.from({length:carCount},(_,i)=>CAR_FIELDS.map(f=>`car${i}.${f}`)).flat()]
}
export function trackData(track:Track):TrackData{
  return {id:track.id,label:track.label,blurb:track.blurb,profile:track.profile,seed:track.seed,width:track.width,length:track.length,
    centerline:Array.from(track.cx,(x,i)=>[x,track.cy[i]!] as [number,number]),halfRing:Array.from(track.halfRing),
    ...(track.edgeNormalWindow !== undefined ? {edgeNormalWindow:track.edgeNormalWindow} : {}),
    ...(track.kerbs ? {kerbs:track.kerbs.map(kerb=>({...kerb}))} : {}),
    sectorBoundaries:[...track.sectorBoundaries],brakeMarkers:track.brakeMarkers.map(b=>({...b})),
    barrierGap:{left:Array.from(track.barrierGapLeft),right:Array.from(track.barrierGapRight)}}
}
export function uniqueId():string{
  return typeof crypto.randomUUID==='function'?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('')
}
