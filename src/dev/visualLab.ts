import { Renderer } from '../render/renderer'
import { Car } from '../core/car'
import { handlingPreset } from '../core/carParams'
import { Track } from '../core/track'
import type { CameraMode } from '../render/cameras'
const canvas=document.querySelector<HTMLCanvasElement>('#view')!
const renderer=new Renderer(canvas)
renderer.toggleProfiling()
const params=handlingPreset('legacy')
const track=new Track(await (await fetch('./tracks/power_8.json')).json())
renderer.setTrack(track); renderer.setCars(params,true); renderer.setOpponents(params,7)
const car=new Car(params), ghost=new Car(params), rivals=Array.from({length:7},()=>new Car(params))
const input=(id:string)=>document.querySelector<HTMLInputElement>('#'+id)!
let distance=110, last=performance.now(), frames:number[]=[],renderTimes:number[]=[],sampleId=0
const setPose=(c:Car,s:number,lat=0)=>{const p=track.poseAt(s);c.setPose(p.x-Math.sin(p.yaw)*lat,p.y+Math.cos(p.yaw)*lat,p.yaw)}
input('position').oninput=()=>{distance=Number(input('position').value)}
document.querySelector<HTMLSelectElement>('#camera')!.onchange=e=>renderer.setCameraMode((e.target as HTMLSelectElement).value as CameraMode)
const settings=()=>renderer.applySettings({effects:input('clean').checked?0:1,fovKick:0,shake:0,performanceMode:input('performance').checked})
input('performance').onchange=settings;input('clean').onchange=settings;input('classic').onchange=()=>renderer.setClassicFraming(input('classic').checked);settings()
const updateCamera=renderer.rig.update.bind(renderer.rig)
renderer.rig.update=(...args)=>{
 updateCamera(...args)
 if(input('pit').checked){
  const p=track.poseAt(distance),q=track.poseAt(distance+10),wall=track.halfAt(distance)+track.barrierGapAt(distance,true)
  const eye=-wall-5,aim=-wall-14
  renderer.rig.camera.position.set(p.x-Math.sin(p.yaw)*eye,2.3,-p.y-Math.cos(p.yaw)*eye)
  renderer.rig.camera.up.set(0,1,0);renderer.rig.camera.lookAt(q.x-Math.sin(q.yaw)*aim,2.2,-q.y-Math.cos(q.yaw)*aim)
 }
 if(input('contact').checked){
  const s=args[0],cos=Math.cos(s.yaw),sin=Math.sin(s.yaw)
  const localX=-params.lr,localZ=-params.width/2
  const x=s.x+cos*localX+sin*localZ,z=-s.y-sin*localX+cos*localZ
  renderer.rig.camera.position.set(x-cos*1.5-sin*1.4,0.6,z+sin*1.5-cos*1.4)
  renderer.rig.camera.up.set(0,1,0);renderer.rig.camera.lookAt(x,0.24,z)
 }
}
window.addEventListener('resize',()=>renderer.resize())
function frame(now:number){
 const dt=Math.min((now-last)/1000,0.05);last=now
 if(input('tour').checked)distance=(distance+30*dt)%track.length
 setPose(car,distance,Number(input('lateral').value));car.s.steer=Number(input('steer').value);car.s.vx=input('tour').checked?30:0;car.s.wheelVr=car.s.vx
 setPose(ghost,distance+12,2)
 rivals.forEach((c,i)=>{setPose(c,distance+10+Math.floor(i/2)*12,i%2?2.8:-2.8);c.s.vx=car.s.vx;c.s.wheelVr=car.s.vx})
 renderer.setOpponentStates(input('field').checked?rivals.map(c=>c.s):[])
 const renderStart=performance.now()
 renderer.render(car.s,input('ghost').checked?ghost.s:null,params,0,dt)
 renderTimes.push(performance.now()-renderStart)
 frames.push(dt*1000)
 if(frames.length>=120){const f=frames.slice().sort((a,b)=>a-b),cpu=renderTimes.slice().sort((a,b)=>a-b),s=renderer.stats();document.querySelector('#stats')!.textContent=JSON.stringify({sampleId:++sampleId,renderCpuMedianMs:+cpu[60]!.toFixed(2),renderCpuP95Ms:+cpu[114]!.toFixed(2),frameMedianMs:+f[60]!.toFixed(1),frameP95Ms:+f[114]!.toFixed(1),...s});frames=[];renderTimes=[]}
 requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
if(import.meta.hot)import.meta.hot.dispose(()=>renderer.dispose())
