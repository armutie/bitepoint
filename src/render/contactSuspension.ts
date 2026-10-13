import * as THREE from 'three'
import type { CarModel } from './carModel'
import type { CarState } from '../core/car'
import type { TrackSurface } from './trackSurface'

interface Spring { value: number; velocity: number }
interface State { height: Spring; pitch: Spring; roll: Spring; vx: number; x: number; y: number }
/** Critically damped analytical step: no frame-rate-dependent spring instability. */
export function settle(s: Spring, target: number, dt: number): void {
  const omega = 24, displacement = s.value - target, b = s.velocity + omega * displacement
  const decay = Math.exp(-omega * Math.max(0, dt))
  s.value = target + (displacement + b * dt) * decay
  s.velocity = (s.velocity - omega * b * dt) * decay
}

export class ContactSuspension {
  private readonly states = new WeakMap<CarModel, State>()
  private readonly rotation = new THREE.Euler(0,0,0,'YXZ')
  private readonly matrix = new THREE.Matrix4()
  update(model: CarModel, car: CarState, surface: TrackSurface, dt: number): void {
    const cos=Math.cos(car.yaw),sin=Math.sin(car.yaw)
    const contacts=model.wheels.map(wheel=>{
      // Account for the front upright's kingpin offset when it steers.
      const steering=wheel.front?car.steer:0
      const x=wheel.pivot.position.x+Math.sin(steering)*wheel.spin.position.z
      const z=wheel.pivot.position.z+wheel.steer.position.z+Math.cos(steering)*wheel.spin.position.z
      let height=0
      // Sample the tread centre and both shoulders, including steering direction.
      const shoulder=(wheel.front?0.17:0.225)*0.8
      for(const offset of [-shoulder,0,shoulder]) {
        for (const forward of [-wheel.baseY * 0.5, 0, wheel.baseY * 0.5]) {
          const sx=x+Math.sin(steering)*offset+Math.cos(steering)*forward
          const sz=z+Math.cos(steering)*offset-Math.sin(steering)*forward
          const tyreArc=Math.sqrt(wheel.baseY*wheel.baseY-forward*forward)-wheel.baseY
          height=Math.max(height,surface.heightAt(car.x+cos*sx+sin*sz,car.y+sin*sx-cos*sz)+tyreArc)
        }
      }
      return {x,z,height,wheel}
    })
    const mean=contacts.reduce((sum,c)=>sum+c.height,0)/contacts.length
    const average=(front: boolean)=>contacts.filter(c=>c.wheel.front===front).reduce((sum,c)=>sum+c.height,0)/2
    const sideAverage=(side: number)=>contacts.filter(c=>c.wheel.sideZ===side).reduce((sum,c)=>sum+c.height,0)/2
    const front=contacts.find(c=>c.wheel.front)!,rear=contacts.find(c=>!c.wheel.front)!
    const left=contacts.find(c=>c.wheel.sideZ===-1)!,right=contacts.find(c=>c.wheel.sideZ===1)!
    let state=this.states.get(model)
    const reset=!state || Math.hypot(car.x-state.x,car.y-state.y)>8
    const ax=state && dt>1e-4 && !reset ? THREE.MathUtils.clamp((car.vx-state.vx)/dt,-25,25):0
    const pitch=THREE.MathUtils.clamp(Math.atan2(average(true)-average(false),front.x-rear.x)+ax*0.00045,-0.035,0.035)
    const roll=THREE.MathUtils.clamp(-Math.atan2(sideAverage(1)-sideAverage(-1),right.z-left.z)+car.r*car.vx*0.00035,-0.04,0.04)
    if (reset) {
      state={height:{value:mean,velocity:0},pitch:{value:pitch,velocity:0},roll:{value:roll,velocity:0},vx:car.vx,x:car.x,y:car.y}
      this.states.set(model,state)
    }
    const current=state!
    const elapsed=Math.min(Math.max(dt,0),0.1)
    settle(current.height,mean,elapsed);settle(current.pitch,pitch,elapsed);settle(current.roll,roll,elapsed)
    current.vx=car.vx;current.x=car.x;current.y=car.y
    model.root.position.y=current.height.value
    this.rotation.set(current.roll.value,car.yaw,current.pitch.value,'YXZ')
    model.root.rotation.copy(this.rotation)
    this.matrix.makeRotationFromQuaternion(model.root.quaternion)
    const elements=this.matrix.elements
    // Wheels stay on the surface while springs move the sprung body around them.
    // Do not smooth contact height: that would let the tyre sink into a rising kerb.
    for(const c of contacts) {
      c.wheel.pivot.position.y=(c.height+c.wheel.baseY-current.height.value-elements[1]!*c.x-elements[9]!*c.z)/elements[5]!
    }
    model.updateSuspension()
  }
}
