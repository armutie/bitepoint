import * as THREE from 'three'
import {describe,it,expect} from 'vitest'
import {buildCar,SKINS} from './carModel'
import {defaultParams} from '../core/carParams'

describe('race-field rendering budget',()=>{
 it('keeps the moving wheels and coloured silhouette within a small mesh/triangle budget',()=>{
  const car=buildCar(defaultParams(),SKINS.player,{detail:'field'});let draws=0,triangles=0
  car.root.traverse(o=>{if(o instanceof THREE.Mesh){draws++;triangles+=(o.geometry.index?.count??o.geometry.getAttribute('position').count)/3}})
  expect(draws).toBeLessThanOrEqual(6);expect(triangles).toBeLessThan(8000)
  expect(car.wheels).toHaveLength(4);expect(car.frontWheels).toHaveLength(2)
  for(const wheel of car.wheels){expect(wheel.spin.parent).toBe(wheel.steer);expect(wheel.steer.parent).toBe(wheel.pivot)}
  car.dispose()
 })
})
