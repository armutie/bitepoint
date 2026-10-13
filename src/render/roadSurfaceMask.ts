import type { Track } from '../core/track'

const TAU=Math.PI*2
const clamp=(x:number,lo=0,hi=1)=>Math.max(lo,Math.min(hi,x))
const smooth=(lo:number,hi:number,x:number)=>{const t=clamp((x-lo)/(hi-lo));return t*t*(3-2*t)}
const wrap=(s:number,length:number)=>((s%length)+length)%length
const lapDelta=(s:number,centre:number,length:number)=>wrap(s-centre+length/2,length)-length/2
const gaussian=(distance:number,width:number)=>Math.exp(-distance*distance/(2*width*width))
const rng=(seed:number)=>()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
const arcCache=new WeakMap<Track,Float64Array>()
function smoothCurvature(track:Track,s:number):number {
 let arcs=arcCache.get(track)
 if(!arcs){arcs=new Float64Array(track.n+1);for(let i=0;i<track.n;i++)arcs[i+1]=arcs[i]!+track.segLenAt(i);arcCache.set(track,arcs)}
 const arc=wrap(s,track.length)
 let lo=0,hi=track.n
 while(lo<hi){const mid=(lo+hi+1)>>>1;if(arcs[mid]!<=arc)lo=mid;else hi=mid-1}
 const i=Math.min(lo,track.n-1),next=(i+1)%track.n,t=clamp((arc-arcs[i]!)/track.segLenAt(i))
 return track.signedCurvature[i]!+(track.signedCurvature[next]!-track.signedCurvature[i]!)*t
}

export interface RoadWearProfile { offset:number; strength:number }
interface TrafficPath {offset:Float64Array;curve:Float64Array;count:number}
const pathCache=new WeakMap<Track,TrafficPath>()
const sampleRing=(values:Float64Array,s:number,length:number)=>{
 const t=wrap(s,length)/length*values.length,i=Math.floor(t),f=t-i,n=values.length
 const p0=values[(i+n-1)%n]!,p1=values[i%n]!,p2=values[(i+1)%n]!,p3=values[(i+2)%n]!
 return p1+0.5*f*(p2-p0+f*(2*p0-5*p1+4*p2-p3+f*(3*(p1-p2)+p3-p0)))
}
function trafficPath(track:Track):TrafficPath {
 const existing=pathCache.get(track);if(existing)return existing
 const count=Math.ceil(track.length/2),step=track.length/count,raw=new Float64Array(count),curve=new Float64Array(count),offset=new Float64Array(count)
 for(let i=0;i<count;i++)raw[i]=smoothCurvature(track,i*step)
 // A continuous convolution avoids the terraces made by a handful of curvature probes.
 for(let i=0;i<count;i++){
  let total=0,weight=0
  for(let d=-20;d<=20;d++){const w=gaussian(d*step,18);total+=raw[(i+d+count)%count]!*w;weight+=w}
  curve[i]=total/weight
 }
 for(let i=0;i<count;i++){
  const s=i*step,k=curve[i]!,ahead=sampleRing(curve,s+65,track.length),behind=sampleRing(curve,s-65,track.length)
  offset[i]=track.halfAt(s)*(0.57*Math.tanh(k*100)-0.24*Math.tanh(ahead*100)-0.20*Math.tanh(behind*100))
 }
 const flowingOffset=new Float64Array(count)
 for(let i=0;i<count;i++){
  let total=0,weight=0
  for(let d=-20;d<=20;d++){const w=gaussian(d*step,18);total+=offset[(i+d+count)%count]!*w;weight+=w}
  flowingOffset[i]=total/weight
 }
 const path={offset:flowingOffset,curve,count};pathCache.set(track,path);return path
}
/** Smooth approximate traffic path, independent of player/AI physics. */
export function roadWearAt(track:Track,s:number,half:number):RoadWearProfile {
 const path=trafficPath(track),k=sampleRing(path.curve,s,track.length),offset=sampleRing(path.offset,s,track.length)
 return {offset:clamp(offset,-half*0.65,half*0.65),strength:smooth(0.001,0.014,Math.abs(k))}
}

export interface RoadSurfaceMask { data:Uint8Array; width:number; height:number; span:number }
/** Packed lap map: R rubber, G surface tone, B polish, A rough deposit character. */
export function bakeRoadSurfaceMask(track:Track,width=512,height=4096):RoadSurfaceMask {
 const span=Math.max(...track.halfRing)*2+2,data=new Uint8Array(width*height*4),random=rng(track.seed^0x4f17d32a)
 const patches=Array.from({length:Math.max(12,Math.round(track.length/48))},()=>({
  s:random()*track.length,lat:(random()-0.5)*span*0.8,length:7+random()*30,width:0.8+random()*4.2,tone:(random()<0.76?-1:1)*(0.12+random()*0.19),skew:(random()-0.5)*0.05,
 }))
 // Each mark is one finite arc with tapered ends, rather than a lap-long wandering lane.
 const marks:{s:number;length:number;entry:number;c1:number;c2:number;exit:number;width:number;opacity:number;pathScale:number;rough:number;paired:boolean}[]=[]
 for(let i=0;i<track.length*0.25;i++){
  const s=random()*track.length,length=12+random()*110,half=track.halfAt(s),activity=roadWearAt(track,s+length/2,half).strength
  if(random()>0.27+activity*0.66)continue
  const broad=random()<0.16,entry=(random()-0.5)*half*1.15
  const wayward=random()<(activity>0.55?0.52:0.24)
  const exit=clamp(entry+(random()-0.5)*(wayward?half*0.95:1.1),-half*0.85,half*0.85)
  marks.push({s,length,entry,c1:entry+(random()-0.5)*(wayward?3.2:0.6),c2:exit+(random()-0.5)*(wayward?2.8:0.6),exit,
   width:broad?0.30+random()*0.9:0.035+random()*0.19,opacity:0.13+random()**2*0.53,pathScale:0.40+random()*0.70,
   rough:random()<0.20?0.65+random()*0.30:0.05+random()*0.18,paired:!broad&&random()<0.38})
 }
 for(let i=0;i<track.length/28;i++){
  const s=random()*track.length,half=track.halfAt(s)
  const entry=(random()-0.5)*half*1.85,exit=clamp(entry+(random()-0.5)*half*0.65,-half*0.92,half*0.92)
  marks.push({s,length:12+random()*45,entry,c1:entry+(random()-0.5)*2.5,c2:exit+(random()-0.5)*2.5,exit,
   width:0.035+random()*0.48,opacity:0.12+random()*0.30,pathScale:0,rough:random()<0.3?0.75:0.14,paired:false})
 }
 const brakeEnds:number[]=[]
 for(const marker of track.brakeMarkers){const end=wrap(marker.s+marker.distance,track.length);if(!brakeEnds.some(s=>Math.abs(lapDelta(s,end,track.length))<12))brakeEnds.push(end)}
 const rubber=new Float32Array(width),polish=new Float32Array(width),grit=new Float32Array(width),deposit=new Float32Array(width)
 for(let y=0;y<height;y++){
  // Include the periodic endpoint so filtering across the lap seam blends identical rows.
  const s=y/(height-1)*track.length,phase=s/track.length*TAU,half=track.halfAt(s),profile=roadWearAt(track,s,half)
  let braking=0
  for(const end of brakeEnds)braking=Math.max(braking,gaussian(lapDelta(s,end-38,track.length),32))
  const exit=roadWearAt(track,s-35,half).strength*(1-profile.strength)
  const load=clamp(0.10+profile.strength*0.62+braking*0.25+exit*0.18)
  const centre=profile.offset+Math.sin(phase*3)*0.28*(1-profile.strength)
  const broadWidth=1.6+profile.strength*0.9+braking*0.35
  const active=patches.map(p=>({p,ds:lapDelta(s,p.s,track.length)})).filter(({p,ds})=>Math.abs(ds)<p.length*3)
  for(let x=0;x<width;x++){
   const lateral=(x/(width-1)-0.5)*span
   const broad=gaussian(lateral-centre,broadWidth)*load*(0.18+0.065*Math.sin(phase*8+Math.sin(phase*3)))
   rubber[x]=broad;polish[x]=gaussian(lateral-centre,broadWidth*1.1)*load*0.42
   grit[x]=broad*0.12;deposit[x]=broad
  }
  const stroke=(lateral:number,strokeWidth:number,opacity:number,rough:number)=>{
   const cx=(0.5+lateral/span)*(width-1),radius=Math.ceil(strokeWidth/span*(width-1)*3)
   for(let x=Math.max(0,Math.floor(cx-radius));x<=Math.min(width-1,Math.ceil(cx+radius));x++){
    const distance=(x-cx)/(width-1)*span,coverage=gaussian(distance,strokeWidth)*opacity
    rubber[x]=1-(1-rubber[x]!)*(1-coverage);polish[x]=Math.max(polish[x]!,coverage*1.6)
    grit[x]=grit[x]!+coverage*rough;deposit[x]=deposit[x]!+coverage
   }
  }
  for(const mark of marks){
   const ds=wrap(s-mark.s,track.length);if(ds>=mark.length)continue
   const t=ds/mark.length,envelope=smooth(0,0.12,t)*(1-smooth(0.76,1,t))
   const u=1-t,lateral=u*u*u*mark.entry+3*u*u*t*mark.c1+3*u*t*t*mark.c2+t*t*t*mark.exit
   const path=profile.offset*mark.pathScale+lateral
   const opacity=mark.opacity*envelope*(mark.pathScale>0?0.35+load*0.65:1)
   if(mark.paired){for(const tyre of [-0.78,0.78])stroke(path+tyre,mark.width,opacity,mark.rough)}
   else stroke(path,mark.width,opacity,mark.rough)
  }
  for(let x=0;x<width;x++){
   const lateral=(x/(width-1)-0.5)*span
   let tone=1.01+0.026*Math.sin(phase*5+Math.sin(lateral*0.48))+0.012*Math.sin(phase*31+lateral*1.6+Math.sin(phase*7))
   for(const {p,ds} of active)tone+=p.tone*gaussian(ds,p.length)*gaussian(lateral-p.lat-ds*p.skew,p.width)
   const i=(y*width+x)*4
   data[i]=Math.round(clamp(rubber[x]!)*255)
   data[i+1]=Math.round(clamp((tone-0.72)/0.55)*255)
   data[i+2]=Math.round(clamp(polish[x]!+rubber[x]!*0.4)*255)
   data[i+3]=Math.round(clamp(grit[x]!/Math.max(deposit[x]!,0.001))*255)
  }
 }
 return {data,width,height,span}
}
