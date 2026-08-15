import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { defaultParams } from '../core/carParams'
import { buildCar, SKINS } from './carModel'

function endpoints(mesh: THREE.Mesh): [THREE.Vector3, THREE.Vector3] {
  mesh.updateWorldMatrix(true, false)
  return [
    new THREE.Vector3(0, -0.5, 0).applyMatrix4(mesh.matrixWorld),
    new THREE.Vector3(0, 0.5, 0).applyMatrix4(mesh.matrixWorld),
  ]
}

describe('formula car suspension', () => {
  it('keeps every chassis pickup fixed while the wheel end follows travel', () => {
    const model = buildCar(defaultParams(), SKINS.player)
    const links = model.root.getObjectByName('suspension-links')
    expect(links).toBeInstanceOf(THREE.Group)

    const rods = links!.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh)
    expect(rods).toHaveLength(12)
    const before = rods.map(endpoints)

    for (const wheel of model.wheels) {
      if (wheel.front) wheel.pivot.position.y += 0.04
    }
    model.updateSuspension()
    const after = rods.map(endpoints)

    for (let i = 0; i < rods.length; i++) {
      const initial = before[i]!
      const current = after[i]!
      // Cylinders are authored from local -Y (chassis) to +Y (upright).
      expect(current[0].distanceTo(initial[0])).toBeLessThan(1e-6)
      expect(current[1].distanceTo(initial[1])).toBeCloseTo(0.04, 5)
    }

    model.dispose()
  })

  it('moves only the track-rod wheel ends when steering', () => {
    const model = buildCar(defaultParams(), SKINS.player)
    const links = model.root.getObjectByName('suspension-links')!
    const rods = links.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh)
    const before = rods.map(endpoints)

    for (const upright of model.frontWheels) upright.rotation.y = 0.3
    model.updateSuspension()
    const after = rods.map(endpoints)

    for (let i = 0; i < rods.length; i++) {
      expect(after[i]![0].distanceTo(before[i]![0])).toBeLessThan(1e-6)
    }
    const movedWheelEnds = after.filter((pair, i) => pair[1].distanceTo(before[i]![1]) > 1e-3)
    expect(movedWheelEnds).toHaveLength(2)

    model.dispose()
  })
})
