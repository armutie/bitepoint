import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { finishBuild } from './buildScheduler'
import { stripGeometrySteps } from './stripGeometry'

describe('stripGeometrySteps', () => {
  it('matches three.js for the same flat triangles', () => {
    const positions: number[] = [], colors: number[] = [], uvs: number[] = []
    let seed = 7
    const r = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 20 - 10 }
    // Enough triangles to cross several chunk boundaries.
    for (let i = 0; i < 40000 * 9; i++) { positions.push(r()); colors.push(Math.abs(r()) / 10) }
    for (let i = 0; i < 40000 * 6; i++) uvs.push(r())

    const ours = finishBuild(stripGeometrySteps({ positions, colors, uvs }))
    const reference = new THREE.BufferGeometry()
    reference.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    reference.computeVertexNormals()

    const a = ours.getAttribute('normal').array, b = reference.getAttribute('normal').array
    expect(a.length).toBe(b.length)
    let worst = 0
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!))
    expect(worst).toBeLessThan(1e-5)
    expect(Array.from(ours.getAttribute('uv').array.slice(0, 6))).toEqual(Array.from(new Float32Array(uvs.slice(0, 6))))
  })

  it('leaves out uvs it was not given', () => {
    const geom = finishBuild(stripGeometrySteps({ positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], colors: [1, 1, 1, 1, 1, 1, 1, 1, 1] }))
    expect(geom.getAttribute('uv')).toBeUndefined()
    expect(Array.from(geom.getAttribute('normal').array.slice(0, 3))).toEqual([0, -1, 0])
  })
})
