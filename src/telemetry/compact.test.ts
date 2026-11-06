import { describe,it,expect } from 'vitest'
import { compactColumns,EGO_STRIDE,RIVAL_STRIDE,packCompact,unpackCompact,NearbyCars } from './compact'
describe('sparse compact codec',()=>{
  it('stores only present rivals while preserving Float32 values and missing lap time',()=>{
    const stride=compactColumns(7).length,rows=120,values=new Float32Array(rows*stride)
    for(let r=0;r<rows;r++){
      values[r*stride]=r;values[r*stride+1]=Math.fround(Math.PI+r);values[r*stride+18]=NaN
      if(r%3===0){values[r*stride+EGO_STRIDE]=12.345;values[r*stride+EGO_STRIDE+5]=1}
    }
    const packed=packCompact(values,rows,stride)
    expect(packed.rivals).toEqual([{index:0,count:40}]);expect(packed.bytes.byteLength).toBe(rows*EGO_STRIDE*4+40*22)
    expect(unpackCompact(packed.bytes,rows,stride,packed.rivals)).toEqual(values)
  })
  it('rejects truncated payloads and invalid duplicate/unsorted sparse rows',()=>{
    const stride=EGO_STRIDE+RIVAL_STRIDE,values=new Float32Array(2*stride)
    values[EGO_STRIDE+5]=1;values[stride+EGO_STRIDE+5]=1
    const packed=packCompact(values,2,stride)
    expect(()=>unpackCompact(packed.bytes.slice(1),2,stride,packed.rivals)).toThrow()
    new DataView(packed.bytes).setUint16(2*EGO_STRIDE*4+2,0,true)
    expect(()=>unpackCompact(packed.bytes,2,stride,packed.rivals)).toThrow()
  })
})
describe('nearby-car relevance',()=>{
  it('enters at one second and exits beyond 1.2 seconds',()=>{
    const nearby=new NearbyCars()
    expect(nearby.includes(0,60,0,60,1.01)).toBe(false)
    expect(nearby.includes(0,60,0,60,1)).toBe(true)
    expect(nearby.includes(0,70,0,70,1.19)).toBe(true)
    expect(nearby.includes(0,75,0,75,1.21)).toBe(false)
    expect(nearby.includes(1,-60,0,-60,.8)).toBe(true)
    nearby.reset();expect(nearby.includes(0,70,0,70,1.19)).toBe(false)
  })
  it('uses interpolated crossing history, including across laps, rather than current speed',()=>{
    const nearby=new NearbyCars()
    // A lap difference must not hide the physically nearby car. Use its
    // actual crossing history, regardless of either car's current speed.
    nearby.observe(0,[100,1100],1000)
    nearby.observe(.05,[102,1110],1000)
    for(let i=2;i<=20;i++)nearby.observe(i*.05,[100+i*2,1110+(i-1)*2],1000)
    // Current gap is 8 m: leader passed behind's current station (140+1000)
    // at .8 seconds, i.e. .2 seconds ago.
    expect(nearby.gapSeconds(0,1)).toBeCloseTo(.2,8)
    expect(nearby.gapSeconds(1,0)).toBeCloseTo(.2,8)
    nearby.reset();expect(nearby.gapSeconds(0,1)).toBeNull()
  })
  it('always keeps physically close cars on the same section when timing is missing',()=>{
    const nearby=new NearbyCars()
    expect(nearby.includes(0,5,3,5,null)).toBe(true)
    expect(nearby.includes(1,-19,0,-19,10)).toBe(true)
    expect(nearby.includes(2,25,0,25,null)).toBe(false)
    expect(nearby.includes(3,5,3,800,.1)).toBe(false)
  })
  it('clears stale crossing history after a pause, tick gap or teleport',()=>{
    const nearby=new NearbyCars()
    nearby.observe(0,[0,10],1000);nearby.observe(.05,[2,12],1000)
    nearby.observe(5,[4,14],1000);expect(nearby.gapSeconds(0,1)).toBeNull()
    nearby.observe(5.05,[600,16],1000);expect(nearby.gapSeconds(0,1)).toBeNull()
  })
  it('does not query road geometry for a physically irrelevant car',()=>{
    const nearby=new NearbyCars();let calls=0
    expect(nearby.includes(0,1000,0,()=>{calls++;return 0},.5)).toBe(false)
    expect(calls).toBe(0)
    expect(nearby.includes(0,10,0,1000,.5)).toBe(false)
  })
})
