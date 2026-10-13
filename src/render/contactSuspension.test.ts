import * as THREE from 'three'
import { describe, it, expect } from 'vitest'
import data from '../../public/tracks/power_8.json'
import { Track, type TrackData } from '../core/track'
import { initialState } from '../core/car'
import { ContactSuspension, settle } from './contactSuspension'
import { TrackSurface, kerbPoint, KERB_CURVATURE } from './trackSurface'
import type { CarModel, WheelRig } from './carModel'

const track = new Track(data as TrackData)
const surface = new TrackSurface(track)
const index = track.curvature.findIndex((k,i)=>k>KERB_CURVATURE && track.curvature[(i+track.n-1)%track.n]!>KERB_CURVATURE)
const begin = Array.from({length:index},(_,i)=>track.segLenAt(i)).reduce((a,b)=>a+b,0)
const model = (): CarModel => {
  const root=new THREE.Group()
  const wheels: WheelRig[]=[]
  for(const front of [true,false]) for(const side of [-1,1] as const) {
    const pivot=new THREE.Group(),steer=new THREE.Group(),spin=new THREE.Group()
    pivot.position.set(front?1.3:-1.3,0.33,side*0.8)
    root.add(pivot);pivot.add(steer);steer.add(spin)
    wheels.push({pivot,steer,spin,angle:0,baseY:0.33,front,sideZ:side})
  }
  return {root,wheels,updateSuspension:()=>{}} as unknown as CarModel
}
describe('surface contact suspension',()=>{
  it('samples the same triangles as the rendered kerb, on both sides',()=>{
    for(const side of [-1,1]) {
      const a=kerbPoint(track,index,begin,side,1/3,6/16)
      const b=kerbPoint(track,index,begin,side,2/3,6/16)
      const c=kerbPoint(track,index,begin,side,2/3,7/16)
      expect(surface.heightAt((a.x+b.x+c.x)/3,(a.y+b.y+c.y)/3)).toBeCloseTo((a.height+b.height+c.height)/3,7)
    }
    expect(surface.heightAt(track.cx[index]!,track.cy[index]!)).toBe(0)
  })
  it('settles without overshoot and gives the same result at 30 and 144 fps',()=>{
    const results=[30,60,144].map(fps=>{
      const spring={value:0,velocity:0}
      for(let frame=0;frame<fps;frame++) {settle(spring,0.08,1/fps);expect(spring.value).toBeGreaterThanOrEqual(0);expect(spring.value).toBeLessThanOrEqual(0.08)}
      return spring.value
    })
    expect(results[0]).toBeCloseTo(results[2]!,10)
    expect(results[0]).toBeCloseTo(0.08,6)
  })
  it('keeps all four tyre centres supported while the body tilts on a kerb',()=>{
    const car=initialState(),vehicle=model(),suspension=new ContactSuspension()
    const p=track.poseAt(begin+track.segLenAt(index)*0.5)
    const lateral=track.halfRing[index]!-0.4
    car.x=p.x-Math.sin(p.yaw)*lateral;car.y=p.y+Math.cos(p.yaw)*lateral;car.yaw=p.yaw
    vehicle.root.position.set(car.x,0,-car.y)
    for(let frame=0;frame<60;frame++) suspension.update(vehicle,car,surface,1/60)
    vehicle.root.updateMatrixWorld(true)
    const heights=vehicle.wheels.map(w=>w.pivot.getWorldPosition(new THREE.Vector3()).y-w.baseY)
    expect(Math.max(...heights)).toBeGreaterThan(0.02)
    expect(Math.min(...heights)).toBeCloseTo(0,6)
    expect(heights.every(h=>h>=-1e-7 && h<0.12)).toBe(true)
    expect(vehicle.root.position.y).toBeGreaterThan(0)
    expect(Math.abs(vehicle.root.rotation.x)).toBeLessThanOrEqual(0.04)
    expect(Math.abs(vehicle.root.rotation.z)).toBeLessThanOrEqual(0.035)
  })
  it('resets vertical motion when restarting or teleporting the car',()=>{
    const vehicle=model(),car=initialState(),suspension=new ContactSuspension()
    const p=kerbPoint(track,index,begin,1,0.5,0.5)
    car.x=p.x;car.y=p.y;suspension.update(vehicle,car,surface,1/60)
    car.x=track.cx[0]!;car.y=track.cy[0]!;car.vx=0
    suspension.update(vehicle,car,surface,1/60)
    expect(vehicle.root.position.y).toBeCloseTo(0,7)
    expect(vehicle.root.rotation.x).toBeCloseTo(0,7)
    expect(vehicle.root.rotation.z).toBeCloseTo(0,7)
  })
})
