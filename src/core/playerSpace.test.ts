import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bakedToLine, type BakedLine } from './bakedLines'
import { handlingPreset } from './carParams'
import { Race } from './race'
import { LineFollower } from './referenceDriver'
import { DT } from './sim'
import { Track, type TrackData } from './track'
import { RacingRibbon, TrafficPlanner, type TrafficCar } from './trafficPlanner'

const read=(file:string):string=>readFileSync(new URL(`../../public/${file}`,import.meta.url),'utf8')
const track=new Track(JSON.parse(read('tracks/power_8.json')) as TrackData)
const params=handlingPreset('legacy')
const shape=bakedToLine(JSON.parse(read('lines/power_8.legacy.json')) as BakedLine,track,params,.93)!
const ribbon=new RacingRibbon(track,shape)
const exit=Array.from(shape.curvature).findIndex((k,i)=>i>100 && Math.abs(k)<.004
  && Math.abs(shape.curvature[(i-12+shape.x.length)%shape.x.length]!)>.009
  && Math.abs(shape.offset[i]!)<3 && shape.speed[i]!>35)

function run(i:number, side:number) {
  const race=new Race(track,[{slot:0,params},{slot:1,params}],{laps:10})
  const player=new LineFollower(params,shape)
  const ai=new LineFollower(params,shape)
  const planner=new TrafficPlanner(ribbon,shape,params,{side:0,clearance:.65,preparation:2})
  const n=shape.x.length,a=(i-2+n)%n,b=(i+2)%n
  const yaw=Math.atan2(shape.y[b]!-shape.y[a]!,shape.x[b]!-shape.x[a]!)
  const speed=Math.min(40,shape.speed[i]!*.95)
  for(const slot of [0,1]) {
    const sim=race.sims[slot]!,shift=slot===1?side*3.3:0
    sim.car.reset(shape.x[i]!+ribbon.roadNx[i]!*shift,shape.y[i]!+ribbon.roadNy[i]!*shift,yaw)
    sim.beginRollingApproach({...sim.car.s,vx:speed,wheelVr:speed,r:shape.curvature[i]!*speed,gear:2})
  }
  race.phase='racing'
  let hits=0,off=0,maxClosing=0
  for(let tick=0;tick<240;tick++) {
    const cars:TrafficCar[]=race.sims.map((sim,slot)=>({state:sim.car.s,
      road:track.project(sim.car.s.x,sim.car.s.y),speed:sim.speed,player:slot===0}))
    if(tick%6===0) ai.setLine(planner.update(cars,1))
    ai.speedLimit=planner.speedLimit(cars,1)
    ai.offTrack=race.sims[1]!.offTrack
    const a=ai.next(cars[1]!.state),p=player.next(cars[0]!.state)
    race.step([{steer:p.steer,throttle:p.pedal},{steer:a.steer,throttle:a.pedal}])
    if(race.impacts.some((v)=>v>1)) hits++
    if(race.sims[1]!.offTrack) off++
    const me=race.sims[1]!.car.s,other=race.sims[0]!.car.s
    const projection=track.project(me.x,me.y)
    const dx=me.x-other.x,dy=me.y-other.y
    const along=dx*Math.cos(projection.heading)+dy*Math.sin(projection.heading)
    const lat=-dx*Math.sin(projection.heading)+dy*Math.cos(projection.heading)
    if(Math.abs(along)<3.5) maxClosing=Math.max(maxClosing,3.3-side*lat)
  }
  return {hits,offSeconds:off*DT,maxClosing}
}

describe('player space during established overlap',()=>{
  it.each([-1,1])('holds side %i on an exit while the player keeps their line',(side)=>{
    expect(exit).toBeGreaterThan(0)
    const result=run(exit,side)
    expect(result.hits).toBe(0)
    expect(result.offSeconds).toBe(0)
    expect(result.maxClosing).toBeLessThan(.9)
  })
})

