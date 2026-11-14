import * as THREE from 'three'

import { initialState, type CarState } from '../core/car'

/**
 * The loading run: your car from the halo camera, flat out down a dark road at
 * night, street lights passing overhead. The light streaks rushing past at the
 * roadside are the page's own loading screen (index.html) carrying on over it. Shown while the first circuit builds on a load without the opening
 * video (main.ts), so the wait is spent driving rather than looking at a void.
 *
 * Needs nothing from a circuit: a road, a few hundred metres of lamps and
 * reflectors that scroll past and wrap, and light. The car stays at the origin
 * pointing down +x; the world moves.
 */
const SPEED = 104
/** One stretch of lamps and reflectors; the world wraps after it. */
const SPAN = 480
const LAMP_GAP = 48
const DASH_GAP = 12
const ROAD_HALF = 6.5

export class NightRun {
  readonly scene = new THREE.Scene()
  readonly state: CarState = { ...initialState(), vx: SPEED, wheelVr: SPEED }
  private distance = 0
  private readonly scrolling: { object: THREE.Object3D; base: number }[] = []
  private readonly disposables: { dispose(): void }[] = []

  constructor() {
    // Gloom: near-black, thick fog, almost no light but the lamps' own. The
    // road and its edges are only there where a lamp happens to catch them.
    this.scene.background = new THREE.Color(0x010204)
    this.scene.fog = new THREE.FogExp2(0x010204, 0.016)
    this.scene.add(new THREE.HemisphereLight(0x1a2338, 0x030304, 0.18))
    // A faint cool light just over the cockpit: the car stays a silhouette you
    // can make out, while the world around it stays black.
    const carGlow = new THREE.PointLight(0x9fb4d8, 1.6, 7, 2)
    carGlow.position.set(0.6, 2.4, 0)
    this.scene.add(carGlow)

    const asphalt = this.keep(new THREE.MeshStandardMaterial({ color: 0x07080a, roughness: 0.9, metalness: 0 }))
    const ground = this.keep(new THREE.MeshStandardMaterial({ color: 0x020203, roughness: 1 }))
    const paint = this.keep(new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.8 }))
    // Emissive past 1 so the bloom picks them up: these are the lights, and
    // in the dark they are all there is.
    const lamp = this.keep(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffd2a0, emissiveIntensity: 7 }))

    const road = new THREE.Mesh(this.keep(new THREE.PlaneGeometry(4000, ROAD_HALF * 2)), asphalt)
    road.rotation.x = -Math.PI / 2
    road.position.x = 1500
    const verge = new THREE.Mesh(this.keep(new THREE.PlaneGeometry(4000, 400)), ground)
    verge.rotation.x = -Math.PI / 2
    verge.position.set(1500, -0.02, 0)
    this.scene.add(road, verge)
    for (const side of [-1, 1]) {
      const edge = new THREE.Mesh(this.keep(new THREE.PlaneGeometry(4000, 0.14)), paint)
      edge.rotation.x = -Math.PI / 2
      edge.position.set(1500, 0.01, side * (ROAD_HALF - 0.35))
      this.scene.add(edge)
    }

    const dash = this.keep(new THREE.PlaneGeometry(4, 0.13))
    for (let x = 0; x < SPAN; x += DASH_GAP) {
      const m = new THREE.Mesh(dash, paint)
      m.rotation.x = -Math.PI / 2
      m.position.y = 0.012
      this.add(m, x)
    }

    // Lamps overhead, alternating sides: just the glow, no posts, coming out
    // of the dark. Each throws a faint, short pool the car catches as it passes.
    const head = this.keep(new THREE.BoxGeometry(0.9, 0.1, 0.3))
    let n = 0
    for (let x = 0; x < SPAN; x += LAMP_GAP, n++) {
      const side = n % 2 === 0 ? -1 : 1
      const group = new THREE.Group()
      const h = new THREE.Mesh(head, lamp)
      h.position.set(0, 7.85, side * (ROAD_HALF - 0.8))
      const light = new THREE.PointLight(0xffc488, 22, 16, 2)
      light.position.set(0, 7.2, side * (ROAD_HALF - 0.8))
      group.add(h, light)
      this.add(group, x)
    }
    this.update(0)
  }

  /** Drive on by `dt` seconds. */
  update(dt: number): void {
    this.distance += SPEED * dt
    // The car stays put; everything else moves back past it and wraps.
    for (const { object, base } of this.scrolling) {
      object.position.x = wrap(base - this.distance, SPAN) - 60
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
  }

  private add(object: THREE.Object3D, base: number): void {
    this.scene.add(object)
    this.scrolling.push({ object, base })
  }

  private keep<T extends { dispose(): void }>(thing: T): T {
    this.disposables.push(thing)
    return thing
  }
}

function wrap(value: number, span: number): number {
  return ((value % span) + span) % span
}
