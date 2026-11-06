import { readFileSync, writeFileSync } from 'node:fs'
import { bakedToLine, type BakedLine } from '../core/bakedLines'
import { handlingPreset } from '../core/carParams'
import { PackTrafficPlanner } from '../core/packTrafficPlanner'
import { atCommitment } from '../core/racingLine'
import { LineFollower } from '../core/referenceDriver'
import { DT, TimeAttackSim } from '../core/sim'
import { Track, type TrackData } from '../core/track'
import { RacingRibbon, TrafficPlanner, type TrafficCar } from '../core/trafficPlanner'

const trackId = 'power_8'
const read = (name: string): string => readFileSync(new URL(`../../public/${name}`, import.meta.url), 'utf8')
const track = new Track(JSON.parse(read(`tracks/${trackId}.json`)) as TrackData)
const params = handlingPreset('legacy')
const shape = bakedToLine(JSON.parse(read(`lines/${trackId}.legacy.json`)) as BakedLine, track, params, 1)!
const ribbon = new RacingRibbon(track, shape)
const road = Array.from(shape.x, (x, i) => track.project(x, shape.y[i]!).s)
const signed = (d: number): number => ((d + track.length * 1.5) % track.length) - track.length * 0.5
const atRoad = (s: number): number => {
  let best=0, distance=Infinity
  road.forEach((r,i) => { const d=Math.abs(signed(r-s)); if(d<distance) { best=i; distance=d } })
  return best
}

const output=[]
for (const pace of [.93,.99]) for (const kind of ['solo','original','smart'] as const) {
  const gaps = kind==='solo' ? [null] : [null,40,80]
  for(const gap of gaps) {
    const sim=new TimeAttackSim(track,params,trackId,'legacy')
    const line=atCommitment(shape,params,pace)
    const driver=new LineFollower(params,line)
    const style={side:0,clearance:.65,preparation:2,cruise:-.25}
    const planner=kind==='solo' ? null : kind==='smart'
      ? new TrafficPlanner(ribbon,line,params,style) : new PackTrafficPlanner(ribbon,line,params,style)
    const laps:number[]=[]
    let off=0, unwantedBraking=0, slowed=0, minimumRatio=1
    const traces:unknown[]=[]
    for(let tick=0;tick<60*240 && laps.length<3;tick++) {
      const state=sim.car.s, projection=track.project(state.x,state.y)
      const cars:TrafficCar[]=[{state,road:projection,speed:sim.speed}]
      // Diagnostic follower stays behind at the SAME speed and on the same
      // reference. It cannot block the road ahead or create a collision.
      if(gap!==null) {
        const i=atRoad(projection.s-gap), a=(i-2+shape.x.length)%shape.x.length,b=(i+2)%shape.x.length
        const other={...state,x:shape.x[i]!,y:shape.y[i]!,
          yaw:Math.atan2(shape.y[b]!-shape.y[a]!,shape.x[b]!-shape.x[a]!)}
        cars.push({state:other,road:track.project(other.x,other.y),speed:sim.speed})
      }
      if(planner && tick%6===0) driver.setLine(planner.update(cars,0))
      driver.speedLimit=planner?.speedLimit(cars,0)??Infinity
      driver.offTrack=sim.offTrack
      const c=driver.next(state)
      const result=sim.step(c.steer,c.pedal)
      if(sim.offTrack) off++
      const i=atRoad(projection.s), ratio=sim.speed/Math.max(line.speed[i]!,1)
      if(sim.timingArmed && line.speed[i]!>35) {
        minimumRatio=Math.min(minimumRatio,ratio)
        if(ratio<.75) slowed++
        if(c.pedal<-.1 && ratio<.9) unwantedBraking++
        if(tick%30===0 && ratio<.8) traces.push({s:projection.s,speed:sim.speed,target:line.speed[i],
          pedal:c.pedal,plan:planner?.decision.reason,lane:planner?.decision.lane})
      }
      if(result.lapCompleted) laps.push(result.lapCompleted.time)
    }
    output.push({pace,kind,gap,best:Math.min(...laps),laps,offSeconds:off*DT,
      slowedSeconds:slowed*DT,brakingBelowTargetSeconds:unwantedBraking*DT,minimumRatio,traces})
  }
}
writeFileSync(process.argv[2]??'traffic-pace-results.json',JSON.stringify(output,null,2))
console.log(JSON.stringify(output.map(({traces,...row})=>row)))
