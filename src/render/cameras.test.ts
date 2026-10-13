import {describe,it,expect} from 'vitest'
import {CameraRig,type CameraMode} from './cameras'
import {Car} from '../core/car'
import {handlingPreset} from '../core/carParams'

describe('firm onboard camera',()=>{
 for(const mode of ['halo','hood'] as CameraMode[])it(mode+' does not shift with steering or lateral acceleration',()=>{
  const p=handlingPreset('legacy'),car=new Car(p)
  car.setPose(30,-22,0.65);car.s.vx=65
  const snapshots=[-1.5,0,1.5].map(rate=>{
   const rig=new CameraRig(16/9);rig.mode=mode
   rig.update({...car.s,r:rate,steer:rate*0.1},p,0,1/60,null)
   return {position:rig.camera.position.clone(),rotation:rig.camera.quaternion.clone()}
  })
  for(const snapshot of snapshots){
   expect(snapshot.position.distanceTo(snapshots[1]!.position)).toBeLessThan(1e-9)
   expect(snapshot.rotation.angleTo(snapshots[1]!.rotation)).toBeLessThan(1e-7)
  }
 })
 it('retains bounded road vibration on a kerb without steering-driven sway',()=>{
  const p=handlingPreset('legacy'),car=new Car(p),rig=new CameraRig(16/9)
  car.setPose(30,-22,0.65);car.s.vx=50
  let minHeight=Infinity,maxHeight=-Infinity,minSide=Infinity,maxSide=-Infinity
  for(let i=0;i<90;i++){
   rig.update({...car.s,r:Math.sin(i*0.3)},p,0,1/60,{lateral:8.1,half:8,margin:1})
   const sideways=(rig.camera.position.x-car.s.x)*Math.sin(car.s.yaw)+(rig.camera.position.z+car.s.y)*Math.cos(car.s.yaw)
   expect(Math.abs(sideways)).toBeLessThan(0.02)
   minSide=Math.min(minSide,sideways);maxSide=Math.max(maxSide,sideways)
   minHeight=Math.min(minHeight,rig.camera.position.y);maxHeight=Math.max(maxHeight,rig.camera.position.y)
  }
  expect(maxHeight-minHeight).toBeGreaterThan(0.005)
  expect(maxSide-minSide).toBeGreaterThan(0.005)
 })
})
