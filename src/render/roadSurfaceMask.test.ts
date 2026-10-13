import {describe,it,expect} from 'vitest'
import {Track,type TrackData} from '../core/track'
import {bakeRoadSurfaceMask,roadWearAt} from './roadSurfaceMask'
import croft from '../../public/tracks/power_8.json'
import silverstone from '../../public/tracks/silverstone.json'
import technical from '../../public/tracks/technical_8.json'

describe('lap-aligned asphalt zones',()=>{
 it('puts heavier rubber in a loaded bend and braking zone than a quiet straight',()=>{
  const track=new Track(croft as TrackData),mask=bakeRoadSurfaceMask(track,128,2048)
  const mean=(s:number)=>{const row=Math.floor(s/track.length*mask.height);let total=0;for(let x=0;x<mask.width;x++)total+=mask.data[(row*mask.width+x)*4]!;return total/mask.width}
  expect(mean(318)).toBeGreaterThan(mean(154)*1.5)
  expect(mean(270)).toBeGreaterThan(mean(154)*1.3)
  // Asphalt variation remains observable independently of rubber coverage.
  const tones=new Set<number>();for(let i=1;i<mask.data.length;i+=4)tones.add(mask.data[i]!)
  expect(tones.size).toBeGreaterThan(50)
 })
 it('is deterministic, covers the full road width and blends at the lap boundary',()=>{
  for(const data of [croft,silverstone,technical]){
   const track=new Track(data as TrackData),mask=bakeRoadSurfaceMask(track,64,2048)
   expect(mask.span).toBeGreaterThan(Math.max(...track.halfRing)*2)
   expect(mask.data).toEqual(bakeRoadSurfaceMask(track,64,2048).data)
   let seam=0;for(let x=0;x<mask.width;x++)for(const channel of [0,1,2])seam+=Math.abs(mask.data[x*4+channel]!-mask.data[((mask.height-1)*mask.width+x)*4+channel]!)
   expect(seam/(mask.width*3)).toBeLessThan(4)
   for(let s=0;s<track.length;s+=11){const half=track.halfAt(s),p=roadWearAt(track,s,half);expect(Math.abs(p.offset)).toBeLessThanOrEqual(half*0.65);expect(p.strength).toBeGreaterThanOrEqual(0);expect(p.strength).toBeLessThanOrEqual(1)}
  }
 })
 it('keeps traffic paths smooth through curvature joins',()=>{
  for(const data of [croft,silverstone,technical]){
   const track=new Track(data as TrackData)
   let previous=roadWearAt(track,0,track.halfAt(0)).offset
   for(let s=0.5;s<track.length;s+=0.5){
    const current=roadWearAt(track,s,track.halfAt(s)).offset
    expect(Math.abs(current-previous)).toBeLessThan(0.16)
    previous=current
   }
  }
 })
})
