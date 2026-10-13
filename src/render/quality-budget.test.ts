import {describe,it,expect} from 'vitest'
import {viewportPixelRatio,AdaptivePixelRatio} from './quality'
describe('automatic graphics budget',()=>{
 it('caps large-window scene pixels without reducing small viewports',()=>{
  expect(viewportPixelRatio(1280,720,1)).toBe(1)
  for(const [w,h] of [[1920,1080],[2560,1440],[3840,2160]]){const r=viewportPixelRatio(w!,h!,1);expect(w!*h!*r*r).toBeCloseTo(1_250_000,3)}
  expect(viewportPixelRatio(640,480,0.6)).toBe(0.6)
 })
 it('lowers resolution under sustained overload and recovers slowly within its ceiling',()=>{
  const budget=new AdaptivePixelRatio(0.8)
  for(let i=0;i<160;i++)budget.observe(0.035)
  expect(budget.value).toBeLessThan(0.8)
  for(let i=0;i<3600;i++)budget.observe(1/60)
  expect(budget.value).toBeCloseTo(0.8,5)
 })
 it('does not resize for isolated stalls or background-tab scheduling',()=>{
  const budget=new AdaptivePixelRatio(1)
  for(let i=0;i<100;i++){budget.observe(1/60);budget.observe(0.25)}
  expect(budget.value).toBe(1)
  budget.observe(0.060);for(let i=0;i<120;i++)budget.observe(1/60)
  expect(budget.value).toBe(1)
 })
})
