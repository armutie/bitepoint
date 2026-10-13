import { describe,it,expect } from 'vitest'
import { Track,type TrackData } from '../core/track'
import { clearOfCircuit } from '../core/placement'
import { buildTerrain } from './terrain'
import { planDriverEnvironment,visibleOnApproach } from './driverEnvironmentPlan'
import croft from '../../public/tracks/power_8.json'
import silverstone from '../../public/tracks/silverstone.json'
import technical from '../../public/tracks/technical_8.json'

describe('driver-visible scenery placement',()=>{
 for(const data of [croft,silverstone,technical])it('keeps the visible scenery outside '+data.label,()=>{
  const track=new Track(data as TrackData),terrain=buildTerrain(track)
  const plan=planDriverEnvironment(track,terrain)
  expect(plan).toEqual(planDriverEnvironment(track,terrain))
  expect(plan.trees.length).toBeGreaterThan(8)
  expect(plan.buildings.length).toBeGreaterThan(2)
  for(const tree of plan.trees){
   expect(clearOfCircuit(track,tree.x,tree.y,tree.radius+0.7)).toBe(true)
   expect(visibleOnApproach(track,tree.arc,tree.x,tree.y,tree.height)).toBe(true)
   const p=track.project(tree.x,tree.y)
   const wall=track.barrierLimit(p.segment,p.frac,p.lateral<0)
   expect(Math.abs(p.lateral)-wall).toBeLessThan(12)
   expect(tree.height).toBeGreaterThanOrEqual(tree.understory?6.5:11)
   expect(plan.buildings.every(b=>Math.hypot(b.x-tree.x,b.y-tree.y)>Math.hypot(b.length,b.depth)/2+tree.radius+6)).toBe(true)
  }
  for(const b of plan.buildings){
   expect(visibleOnApproach(track,b.arc,b.x,b.y,b.height)).toBe(true)
   for(const u of [-0.5,0,0.5])for(const v of [-0.5,0,0.5]){
    const x=b.x+Math.cos(b.yaw)*u*(b.length+4)-Math.sin(b.yaw)*v*(b.depth+4)
    const y=b.y+Math.sin(b.yaw)*u*(b.length+4)+Math.cos(b.yaw)*v*(b.depth+4)
    expect(clearOfCircuit(track,x,y)).toBe(true)
   }
  }
 })
})
