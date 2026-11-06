/** Float32 ego state and sparse nearby rivals, without raw controls or remote physics. */
export const COMPACT_ENCODING='learning-compact-v2' as const
export const EGO_FIELDS=['simTick','own.x','own.y','own.yaw','own.vx','own.vy','own.r','own.steer','own.slipF','own.slipR',
  'own.appliedSteer','own.appliedPedal','own.carImpulse','own.wallImpulse','own.nextOffTrack','own.lapValid','own.nextLapValid',
  'own.timingArmed','own.completedLapTime','own.penaltySeconds'] as const
export const RIVAL_FIELDS=['forward','left','vForward','vLeft','heading','present'] as const
export const E=Object.fromEntries(EGO_FIELDS.map((v,i)=>[v,i])) as Record<typeof EGO_FIELDS[number],number>
export const EGO_STRIDE=EGO_FIELDS.length,RIVAL_STRIDE=RIVAL_FIELDS.length
export interface SparseRival {index:number;count:number}
export const TRAFFIC_AWARENESS='timing-gap-1s-v1' as const
export function compactColumns(rivals:number):string[]{return [...EGO_FIELDS,...Array.from({length:rivals},(_,i)=>RIVAL_FIELDS.map(f=>`rival${i}.${f}`)).flat()]}
export class NearbyCars {
  private visible=new Set<number>()
  private traces:{time:number;progress:number[]}[]=[]
  private length=0
  reset():void{this.visible.clear();this.traces=[]}
  /** Small causal history, in race-distance metres; lap counts cancel in gapSeconds. */
  observe(time:number,progress:number[],length:number):void{
    const last=this.traces.at(-1)
    if(last&&(time<=last.time||time-last.time>.1||last.progress.length!==progress.length||
      progress.some((p,i)=>Math.abs(p-last.progress[i]!)>30))){this.reset()}
    this.length=length;this.traces.push({time,progress:progress.slice()})
    while(this.traces.length>1&&this.traces[1]!.time<time-2)this.traces.shift()
  }
  gapSeconds(a:number,b:number):number|null{
    const latest=this.traces.at(-1);if(!latest||this.length<=0)return null
    const pa=latest.progress[a]!,pb=latest.progress[b]!
    const gap=((pb-pa+this.length/2)%this.length+this.length)%this.length-this.length/2
    if(!Number.isFinite(gap))return null
    if(Math.abs(gap)<1e-6)return 0
    const leader=gap>0?b:a,target=latest.progress[leader]!-Math.abs(gap)
    // The most recent forward crossing, with sub-tick interpolation. Never
    // invent a time gap when history is missing, reversed or discontinuous.
    for(let i=this.traces.length-2;i>=0;i--){
      const before=this.traces[i]!,after=this.traces[i+1]!,d0=before.progress[leader]!,d1=after.progress[leader]!
      if(d0<=target&&d1>=target&&d1-d0>1e-6){
        const when=before.time+(after.time-before.time)*(target-d0)/(d1-d0)
        return Math.max(0,latest.time-when)
      }
    }
    return null
  }
  includes(id:number,forward:number,left:number,roadGap:number|(()=>number),seconds:number|null|(()=>number|null)):boolean{
    const distance=Math.hypot(forward,left)
    // Generous geometry guard excludes cars on another part of a folded track.
    // Twenty metres always remains visible at low speed, alongside and on lap 1.
    if(distance>250){this.visible.delete(id);return false}
    const road=Math.abs(typeof roadGap==='function'?roadGap():roadGap)
    const time=typeof seconds==='function'?seconds():seconds
    const limit=this.visible.has(id)?1.2:1
    const nearby=road<=250&&((distance<=20&&road<=20)||(time!==null&&Number.isFinite(time)&&time>=0&&time<=limit))
    if(nearby)this.visible.add(id);else this.visible.delete(id)
    return nearby
  }
}
export function packCompact(input:Float32Array,rows:number,stride:number):{bytes:ArrayBuffer;rivals:SparseRival[]}{
  if(!Number.isInteger(rows)||rows<1||rows>65535||stride<EGO_STRIDE||stride>EGO_STRIDE+7*RIVAL_STRIDE||(stride-EGO_STRIDE)%RIVAL_STRIDE||input.length<rows*stride)throw Error('Invalid compact block')
  const rivals:SparseRival[]=[],indices:number[][]=[]
  for(let k=0;k<(stride-EGO_STRIDE)/RIVAL_STRIDE;k++){
    const present:number[]=[]
    for(let r=0;r<rows;r++)if(input[r*stride+EGO_STRIDE+k*RIVAL_STRIDE+5]===1)present.push(r)
    if(present.length){rivals.push({index:k,count:present.length});indices.push(present)}
  }
  const bytes=new ArrayBuffer(rows*EGO_STRIDE*4+rivals.reduce((n,r)=>n+r.count*22,0)),view=new DataView(bytes);let offset=0
  for(let c=0;c<EGO_STRIDE;c++)for(let r=0;r<rows;r++){view.setFloat32(offset,input[r*stride+c]!,true);offset+=4}
  for(let k=0;k<rivals.length;k++){
    const rival=rivals[k]!,present=indices[k]!
    for(const r of present){view.setUint16(offset,r,true);offset+=2}
    for(let c=0;c<5;c++)for(const r of present){view.setFloat32(offset,input[r*stride+EGO_STRIDE+rival.index*RIVAL_STRIDE+c]!,true);offset+=4}
  }
  return {bytes,rivals}
}
export function unpackCompact(bytes:ArrayBuffer,rows:number,stride:number,rivals:SparseRival[]):Float32Array{
  const total=(stride-EGO_STRIDE)/RIVAL_STRIDE
  if(!Number.isInteger(rows)||rows<1||rows>65535||!Number.isInteger(total)||total<0||total>7||
    bytes.byteLength!==rows*EGO_STRIDE*4+rivals.reduce((n,r)=>n+r.count*22,0))throw Error('Compact block length mismatch')
  const out=new Float32Array(rows*stride),view=new DataView(bytes),seen=new Set<number>();let offset=0
  for(let c=0;c<EGO_STRIDE;c++)for(let r=0;r<rows;r++){out[r*stride+c]=view.getFloat32(offset,true);offset+=4}
  for(const rival of rivals){
    if(!Number.isInteger(rival.index)||rival.index<0||rival.index>=total||seen.has(rival.index)||!Number.isInteger(rival.count)||rival.count<1||rival.count>rows)throw Error('Invalid sparse rival')
    seen.add(rival.index);const indices:number[]=[]
    for(let i=0;i<rival.count;i++){
      const row=view.getUint16(offset,true);offset+=2
      if(row>=rows||(i>0&&row<=indices[i-1]!))throw Error('Invalid sparse row')
      indices.push(row);out[row*stride+EGO_STRIDE+rival.index*RIVAL_STRIDE+5]=1
    }
    for(let c=0;c<5;c++)for(const r of indices){out[r*stride+EGO_STRIDE+rival.index*RIVAL_STRIDE+c]=view.getFloat32(offset,true);offset+=4}
  }
  return out
}
