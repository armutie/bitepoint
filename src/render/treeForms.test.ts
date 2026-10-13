import {describe,it,expect} from 'vitest'
import {buildTreeForm} from './treeForms'

describe('clustered tree foliage',()=>{
 it('reduces foliage and shadow geometry while retaining valid canopy lighting',()=>{
  for(let variant=0;variant<6;variant++){
   const form=buildTreeForm(variant)
   expect(form.leaves.index!.count/3).toBeLessThanOrEqual(300)
   expect(form.farLeaves.index!.count/3).toBe(form.leaves.index!.count/6)
   expect(form.wood.index!.count/3).toBeLessThan(600)
   expect(form.height).toBeGreaterThan(10)
   for(const g of [form.leaves,form.farLeaves]){
    const positions=g.getAttribute('position'),normals=g.getAttribute('normal'),colours=g.getAttribute('color'),uv=g.getAttribute('uv')
    expect(colours.count).toBe(positions.count)
    for(let i=0;i<positions.count;i++){
     expect(Math.hypot(normals.getX(i),normals.getY(i),normals.getZ(i))).toBeCloseTo(1,5)
     expect(colours.getX(i)).toBeGreaterThanOrEqual(0.59)
     expect(colours.getX(i)).toBeLessThanOrEqual(1)
     expect(uv.getX(i)).toBeGreaterThanOrEqual(0);expect(uv.getX(i)).toBeLessThanOrEqual(1)
     expect(uv.getY(i)).toBeGreaterThanOrEqual(0);expect(uv.getY(i)).toBeLessThanOrEqual(1)
     expect(Math.abs(positions.getX(i))).toBeLessThanOrEqual(form.radius+0.001)
     expect(Math.abs(positions.getZ(i))).toBeLessThanOrEqual(form.radius+0.001)
     expect(positions.getY(i)).toBeLessThanOrEqual(form.height+0.001)
    }
   }
   for(const g of [form.wood,form.leaves,form.farLeaves]){expect(Array.from(g.getAttribute('position').array).every(Number.isFinite)).toBe(true);g.dispose()}
  }
 })
 it('varies crown proportions and avoids six scaled copies',()=>{
  const ratios:number[]=[],centres:number[]=[]
  for(let variant=0;variant<6;variant++){
   const form=buildTreeForm(variant),p=form.leaves.getAttribute('position')
   let x=0;for(let i=0;i<p.count;i++)x+=p.getX(i)
   centres.push(x/p.count);ratios.push(form.radius/form.height)
   form.wood.dispose();form.leaves.dispose();form.farLeaves.dispose()
  }
  expect(new Set(centres.map(x=>x.toFixed(2))).size).toBe(6)
  expect(Math.max(...ratios)-Math.min(...ratios)).toBeGreaterThan(0.15)
 })
})
