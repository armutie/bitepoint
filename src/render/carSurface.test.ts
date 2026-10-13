import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { haloSurface, shell } from './carSurface'
import { buildCar, SKINS } from './carModel'
import { handlingPreset } from '../core/carParams'

describe('car surface geometry', () => {
  it('faces the body shell outwards, including its end caps', () => {
    const g = shell([[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1]])
    const n = g.getAttribute('normal')
    expect(n.getZ(20 * 25)).toBeGreaterThan(0.9)
    expect(n.getY(20 * 25 + 6)).toBeGreaterThan(0.9)
    expect(n.getX(n.count - 2)).toBeLessThan(-0.9)
    expect(n.getX(n.count - 1)).toBeGreaterThan(0.9)
    g.dispose()
  })

  it('faces both the halo upper surface and its graphics toward the camera above it', () => {
    const path = [[0, 0, 0], [1, 0, 0], [2, 0, 0]]
    const halo = haloSurface(path), decal = haloSurface(path, 0.3, 0.7, true)
    expect(halo.getAttribute('normal').getY(48 * 17 + 4)).toBeGreaterThan(0.99)
    expect(decal.getAttribute('normal').getY(48 * 2)).toBeGreaterThan(0.99)
    halo.dispose(); decal.dispose()
  })

  it('reduces field geometry without moving the wheel or suspension rigs', () => {
    const near = buildCar(handlingPreset('legacy'), SKINS.player)
    const field = buildCar(handlingPreset('legacy'), SKINS.player, { detail: 'field' })
    const triangles = (root: THREE.Object3D) => {
      let count = 0
      root.traverse(o => { if (o instanceof THREE.Mesh) count += (o.geometry.index?.count ?? o.geometry.getAttribute('position').count) / 3 })
      return count
    }
    expect(triangles(field.root)).toBeLessThan(triangles(near.root) * 0.8)
    for (let i = 0; i < 4; i++) expect(field.wheels[i]!.pivot.position.equals(near.wheels[i]!.pivot.position)).toBe(true)
    near.dispose(); field.dispose()
  })
})
