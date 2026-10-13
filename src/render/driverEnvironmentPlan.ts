import { planMainStraight } from './mainStraightPlan'
import type { Track } from '../core/track'
import type { Terrain } from './terrain'
import { clearOfCircuit, outsideWall, pointAt, safeOutsideBox } from '../core/placement'

export interface TreeSite { x:number; y:number; arc:number; height:number; radius:number; variant:number; rotation:number; understory?:boolean; prototype?:number }
export interface BuildingSite { x:number; y:number; arc:number; yaw:number; length:number; depth:number; height:number; style:number }
export interface EnvironmentPlan { trees:TreeSite[]; buildings:BuildingSite[] }
const wrap=(s:number,length:number)=>((s%length)+length)%length
/** A landmark must occupy the forward halo view during its approach. */
export function visibleOnApproach(track:Track,arc:number,x:number,y:number,height:number):boolean {
 return [150,100,55].some(back=>{
  const p=track.poseAt(arc-back),dx=x-p.x,dy=y-p.y,distance=Math.hypot(dx,dy)
  const forward=(dx*Math.cos(p.yaw)+dy*Math.sin(p.yaw))/distance
  return distance>10 && distance<240 && forward>0.83 && height/distance>0.045
 })
}
export function planDriverEnvironment(track:Track,terrain:Pick<Terrain,'runs'|'corners'>):EnvironmentPlan {
 let seed=(track.seed^0x714ba35)>>>0
 const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296}
 const main=planMainStraight(track,terrain)
 const plan:EnvironmentPlan={trees:[],buildings:[]}
 const candidates=[...terrain.runs.slice(0,5).map(r=>r.s1-12),...terrain.corners.slice(0,6).map(c=>c.s+55),...Array.from({length:Math.floor(track.length/180)},(_,i)=>220+i*180)]
 for(const candidate of candidates){
  if(plan.buildings.length>=8)break
  const arc=wrap(candidate,track.length)
  if(main && arc<main.end+45)continue
  if(Math.min(arc,track.length-arc)<175)continue
  const style=plan.buildings.length%3,length=style===1?18:26,depth=style===1?9:8,height=style===1?13:8+random()*3
  const curve=track.signedCurvatureAt(arc+18),side=-Math.sign(curve)||1
  const offset=safeOutsideBox(track,arc,side,depth/2+5,length+4,depth+4)
  if(offset===null)continue
  const p=pointAt(track,arc,offset),pose=track.poseAt(arc)
  if(!visibleOnApproach(track,arc,p.x,p.y,height))continue
  if(plan.buildings.some(b=>Math.hypot(b.x-p.x,b.y-p.y)<70))continue
  plan.buildings.push({x:p.x,y:p.y,arc,yaw:pose.yaw,length,depth,height,style})
 }
 const zones=[...terrain.runs.slice(0,3).map((r,i)=>({arc:r.mid,span:Math.min(190,r.len),side:i%2?-1:1})),
  ...terrain.corners.slice(0,6).map(c=>({arc:c.s-20,span:130,side:-Math.sign(c.k)||1}))]
 for(const zone of zones)for(let along=-zone.span/2;along<=zone.span/2;along+=17+random()*5){
  const arc=wrap(zone.arc+along,track.length)
  if(Math.min(arc,track.length-arc)<180 || random()<0.16)continue
  const height=11+random()*6,radius=4.6+random()*1.9
  const beyond=radius+2.5+random()*2.2
  const p=pointAt(track,arc,outsideWall(track,arc,zone.side,beyond))
  if(!clearOfCircuit(track,p.x,p.y,radius+0.7)||!visibleOnApproach(track,arc,p.x,p.y,height))continue
  if(plan.trees.some(t=>Math.hypot(t.x-p.x,t.y-p.y)<12))continue
  if(main?.sites.some(b=>Math.hypot(b.x-p.x,b.y-p.y)<Math.hypot(b.length,b.depth)/2+radius+4))continue
  if(plan.buildings.some(b=>Math.hypot(b.x-p.x,b.y-p.y)<Math.hypot(b.length,b.depth)/2+radius+6))continue
  // Leave the main corner grandstands visible instead of planting across their faces.
  if(terrain.corners.slice(0,2).some(c=>{
   const q=pointAt(track,c.s,outsideWall(track,c.s,-Math.sign(c.k)||1,8))
   return Math.hypot(q.x-p.x,q.y-p.y)<35
  }))continue
  plan.trees.push({x:p.x,y:p.y,arc,height,radius,variant:Math.floor(random()*3),rotation:random()*Math.PI*2})
 }
 // A few lower companions close the empty strip beneath tall crowns. They share the
 // same instanced prototypes; no random trees spread across the distant outfield.
 const tallTrees=plan.trees.slice()
 for(let i=0;i<tallTrees.length;i+=3){
  const tree=tallTrees[i]!,arc=wrap(tree.arc+8,track.length),side=Math.sign(track.project(tree.x,tree.y).lateral)||1
  const radius=2.6+random()*0.7,height=6.5+random()*2.4
  const p=pointAt(track,arc,outsideWall(track,arc,side,radius+2.8))
  if(!clearOfCircuit(track,p.x,p.y,radius+0.7)||!visibleOnApproach(track,arc,p.x,p.y,height))continue
  if(main?.sites.some(b=>Math.hypot(b.x-p.x,b.y-p.y)<Math.hypot(b.length,b.depth)/2+radius+4))continue
  if(plan.buildings.some(b=>Math.hypot(b.x-p.x,b.y-p.y)<Math.hypot(b.length,b.depth)/2+radius+6))continue
  if(plan.trees.some(t=>Math.hypot(t.x-p.x,t.y-p.y)<5))continue
  plan.trees.push({x:p.x,y:p.y,arc,height,radius,variant:tree.variant,rotation:random()*Math.PI*2,understory:true,prototype:tree.variant*2+(Math.floor(tree.arc*11+tree.height*17)%2)})
 }
 return plan
}
