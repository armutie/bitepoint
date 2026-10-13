import * as THREE from 'three'
import { describe,it,expect } from 'vitest'
import { chunkGeometry } from './meshChunks'

describe('immutable scenery chunks',()=>{
  it('retains positions, authored normals, UVs and kerb coordinates across chunk boundaries',()=>{
    const source=new THREE.BufferGeometry()
    source.setAttribute('position',new THREE.Float32BufferAttribute([1,0,1,2,0,1,1,0,2,100,0,100,102,0,100,100,0,102],3))
    source.setAttribute('normal',new THREE.Float32BufferAttribute([0,1,0,0.1,0.99,0,0,1,0,0,1,0,0,1,0,0,1,0],3))
    source.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,1,0,0,1,0.2,0.3,0.4,0.5,0.6,0.7],2))
    source.setAttribute('kerbSurface',new THREE.Float32BufferAttribute(Array.from({length:18},(_,i)=>i/10),3))
    const chunks=chunkGeometry(source,64)
    expect(chunks).toHaveLength(2)
    for(const name of Object.keys(source.attributes))expect(chunks.flatMap(g=>Array.from(g.getAttribute(name).array))).toEqual(Array.from(source.getAttribute(name).array))
    expect(chunks.every(g=>g.boundingSphere!.radius<3)).toBe(true)
    for(const geometry of chunks)geometry.dispose();source.dispose()
  })
  it('expands indexed triangles without changing their order or topology',()=>{
    const source=new THREE.PlaneGeometry(10,10,2,2);source.rotateX(-Math.PI/2)
    const expected=source.toNonIndexed(),chunks=chunkGeometry(source,64)
    expect(chunks.reduce((n,g)=>n+g.getAttribute('position').count,0)).toBe(expected.getAttribute('position').count)
    const vertices=chunks.flatMap(g=>Array.from(g.getAttribute('position').array)).sort((a,b)=>a-b)
    expect(vertices).toEqual(Array.from(expected.getAttribute('position').array).sort((a,b)=>a-b))
    for(const g of chunks)g.dispose();source.dispose();expected.dispose()
  })
})
