import { describe,it,expect } from 'vitest'
import data from '../../public/tracks/power_8.json'
import { Track,type TrackData } from '../core/track'
import { RaceAuthority } from './authority'
import { PhysicsWorld } from './physics'
import { Predictor } from './prediction'
import { PROTOCOL,IDLE,validInput,type InputFrame,type RoomConfig,type Snapshot } from './protocol'

const config:RoomConfig={protocol:PROTOCOL,trackId:'power_8',preset:'legacy',laps:3,manual:false,easy:false,contact:false}
const track=()=>new Track(data as TrackData)
const input=(seq:number,extra:Partial<InputFrame>={}):InputFrame=>({...IDLE,seq,throttle:0.6,...extra})

describe('multiplayer physics and input authority',()=>{
  it('a rematch puts both cars back on the grid with the lights on, without resetting the clock',()=>{
    const a=new RaceAuthority(track(),config),grid=a.snapshot().cars
    a.start()
    for(let n=1;n<=400;n++){a.receive(0,[input(n,{throttle:1})]);a.receive(1,[input(n,{throttle:1})]);a.step()}
    const before=a.snapshot()
    expect(before.cars[0]!.x).not.toBeCloseTo(grid[0]!.x)
    a.restart()
    const after=a.step()
    expect(after.round).toBe(before.round+1)
    expect(after.tick).toBe(before.tick+1)
    expect(after.phase).toBe('countdown')
    expect(after.scores.every(s=>s.laps===0&&s.finish===null)).toBe(true)
    for(let i=0;i<2;i++)expect(Math.hypot(after.cars[i]!.x-grid[i]!.x,after.cars[i]!.y-grid[i]!.y)).toBeLessThan(0.5)
  })
  it('uses the single-player forces and wall response without changing the handling',()=>{
    for(const easy of [false,true])for(const contact of [false,true]) {
      const c={...config,contact,easy},t=track(),a=new RaceAuthority(t,c),world=new PhysicsWorld(t,c)
      a.race.phase='racing'
      // Deliberately exercise grass and walls as well as the initial grid.
      const pose=t.poseAt(300)
      a.race.sims[0]!.car.setPose(pose.x-Math.sin(pose.yaw)*22,pose.y+Math.cos(pose.yaw)*22,pose.yaw)
      world.restore(a.snapshot().cars)
      for(let n=1;n<=600;n++) {
        const actions=[input(n,{steer:Math.sin(n*.014)*.17}),input(n,{steer:-.07,throttle:.45})]
        a.receive(0,[actions[0]]);a.receive(1,[actions[1]])
        const s=a.step();world.step(actions,true)
        expect(world.cars.map(c=>c.s)).toEqual(s.cars)
      }
    }
  })
  it('deduplicates reordered inputs and never repeats a manual gear edge',()=>{
    const a=new RaceAuthority(track(),{...config,manual:true});a.race.phase='racing'
    a.receive(0,[input(2,{shift:1}),input(1),input(2,{shift:1})])
    expect(a.step().ack[0]).toBe(1)
    expect(a.step().ack[0]).toBe(2)
    for(let i=0;i<50;i++){a.receive(0,[input(2,{shift:1})]);a.step()}
    expect(a.race.sims[0]!.car.s.gear).toBe(1)
  })
  it('continues the shared clock across a missing input and releases a stale throttle',()=>{
    const a=new RaceAuthority(track(),config);a.race.phase='racing'
    a.receive(0,[input(2)]);for(let i=0;i<4;i++)a.step()
    expect(a.snapshot().ack[0]).toBe(2)
    for(let i=0;i<20;i++)a.step()
    expect(a.snapshot().actions[0]!.throttle).toBeLessThanOrEqual(0)
    expect(a.tick).toBe(24)
    a.receive(0,[input(1000),input(3,{steer:NaN})]);a.step()
    expect(a.snapshot().ack[0]).toBe(2)
  })
  it('rejects nonfinite commands and protocol-range violations',()=>{
    expect(validInput(input(1,{throttle:Infinity}))).toBe(false)
    expect(validInput(input(0))).toBe(false)
    expect(validInput(input(1,{shift:2}))).toBe(false)
  })
  it('predicts and corrects an actual car-to-car impact as one scene',()=>{
    const t=track(),c={...config,contact:true},a=new RaceAuthority(t,c),pose=t.poseAt(250)
    a.race.phase='racing'
    for(const slot of [0,1] as const){const car=a.race.sims[slot]!.car,lat=slot===0?-.7:.7
      car.setPose(pose.x-Math.sin(pose.yaw)*lat,pose.y+Math.cos(pose.yaw)*lat,pose.yaw)
      car.s.vx=20;car.s.wheelVr=20;car.s.vy=slot===0?3:-3}
    const clients=[new Predictor(t,c,0),new Predictor(t,c,1)]
    clients.forEach(p=>{p.reconcile(a.snapshot());p.frame(0,0,0,2)})
    a.receive(0,[input(1,{throttle:0})]);a.receive(1,[input(1,{throttle:0})]);const s=a.step()
    expect(Array.from(a.race.impacts).some(v=>v>0)).toBe(true)
    clients.forEach(p=>{expect(p.states).toEqual(s.cars);p.reconcile(s);expect(p.correction).toBeLessThan(1e-8)})
  })
  it('reduces an analog input backlog without losing a gear edge',()=>{
    const a=new RaceAuthority(track(),config)
    a.receive(0,Array.from({length:12},(_,i)=>input(i+1,{shift:i===4?1:0})))
    const seen:number[]=[]
    for(let i=0;i<10;i++){const s=a.step();if(s.actions[0]!.shift)seen.push(s.actions[0]!.seq)}
    expect(seen).toEqual([5]);expect(a.snapshot().ack[0]).toBe(12)
  })
})

describe('prediction under transport impairment',()=>{
  it.each([0,2,3,5])('replays and converges with %i-tick one-way delay, jitter, loss and reordering',delay=>{
    const c={...config,contact:true},t=track(),a=new RaceAuthority(t,c)
    a.race.phase='racing'
    const clients=[new Predictor(t,c,0),new Predictor(t,c,1)]
    clients.forEach(p=>p.reconcile(a.snapshot()))
    const upstream:{at:number;slot:0|1;batch:InputFrame[]}[]=[],downstream:{at:number;slot:0|1;s:Snapshot}[]=[]
    const corrections:number[]=[]
    for(let tick=1;tick<=900;tick++) {
      for(const slot of [0,1] as const) {
        const p=clients[slot]!
        p.frame(Math.sin(tick*.007+slot)*.025,.48,0,2)
        if(tick%17!==0)upstream.push({at:tick+delay+(delay?tick%3:0),slot,batch:p.batch()})
      }
      for(let i=upstream.length-1;i>=0;i--)if(upstream[i]!.at<=tick){const m=upstream.splice(i,1)[0]!;a.receive(m.slot,m.batch)}
      const s=a.step()
      if(tick%2===0&&tick%22!==0)for(const slot of [0,1] as const)downstream.push({at:tick+delay+(delay?tick%5:0),slot,s})
      for(let i=downstream.length-1;i>=0;i--)if(downstream[i]!.at<=tick){const m=downstream.splice(i,1)[0]!,p=clients[m.slot]!
        if(p.reconcile(m.s)&&tick>60)corrections.push(p.correction)}
      for(const p of clients)expect(p.states.every(s=>Number.isFinite(s.x)&&Number.isFinite(s.vx))).toBe(true)
    }
    expect(corrections.length).toBeGreaterThan(300)
    const sorted=corrections.sort((x,y)=>x-y)
    console.info('[multiplayer-netcode]',JSON.stringify({baseRttMs:Math.round(delay/60*2000),correctionMedianM:+sorted[Math.floor(sorted.length*.5)]!.toFixed(4),correctionP95M:+sorted[Math.floor(sorted.length*.95)]!.toFixed(4),correctionMaxM:+sorted.at(-1)!.toFixed(4)}))
    // A bounded physics correction, not a promise that every high-ping contact
    // is visually perfect. This flags metre-scale regressions in the test run.
    expect(sorted[Math.floor(sorted.length*.95)]).toBeLessThan(2)
    for(const slot of [0,1] as const)a.receive(slot,clients[slot]!.batch())
    for(let i=0;i<60;i++)a.step()
    const final=a.snapshot()
    clients.forEach(p=>{p.reconcile(final);expect(p.queueSize).toBe(0);expect(p.states).toEqual(final.cars)})
    expect(clients[0]!.reconcile({...final,tick:final.tick-1})).toBe(false)
  })
})
