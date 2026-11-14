import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * The car's body, modelled in Blender (tools/car/build.py) and loaded as one
 * model: chassis, sidepods, airbox, floor, wings, halo, driver and decals.
 * The game still builds the wheels, suspension and steering wheel itself,
 * since those move.
 *
 * Loaded once and shared by every car that uses it. Each part keeps the name
 * of its Blender material, which is how buildCar decides what to paint it
 * with: 'paint' becomes the livery, 'carbon' the game's carbon, and so on.
 */
export interface BodyPart {
  material: string
  geometry: THREE.BufferGeometry
  /** The model's own material, for parts the game has no material of its own for (decals). */
  source: THREE.MeshStandardMaterial
}

let parts: BodyPart[] | null = null

/** The loaded body, or null to fall back to the code-built one. */
export function carBody(): BodyPart[] | null {
  return parts
}

export async function loadCarBody(): Promise<void> {
  if (parts) return
  const url = new URL('models/car-body.glb', document.baseURI).href
  const gltf = await new GLTFLoader().loadAsync(url)
  gltf.scene.updateMatrixWorld(true)
  // One merged geometry per material: the body is static, and the material
  // boundaries are all the game needs to keep.
  const byMaterial = new Map<string, { geoms: THREE.BufferGeometry[]; source: THREE.MeshStandardMaterial }>()
  gltf.scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    const source = o.material as THREE.MeshStandardMaterial
    const g = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld)
    // Keep only what every part has, so parts of one material always merge.
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name)
    }
    if (!g.getAttribute('uv')) {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2))
    }
    const key = source.name || 'paint'
    const entry = byMaterial.get(key)
    if (entry) entry.geoms.push(g)
    else byMaterial.set(key, { geoms: [g], source })
  })
  const out: BodyPart[] = []
  for (const [material, { geoms, source }] of byMaterial) {
    const geometry = mergeGeometries(geoms.map((g) => (g.index ? g.toNonIndexed() : g)))
    if (!geometry) throw new Error(`could not merge the car body's ${material} parts`)
    geometry.computeBoundingSphere()
    out.push({ material, geometry, source })
  }
  parts = out
}

/**
 * The livery line, as in tools/car/build.py: below it the body colour, above
 * it the accent, with a pinstripe of accent just under it. (x along the car,
 * height of the line), in the car's frame.
 */
const LIVERY_LINE: [number, number][] = [
  [-2.40, 2.0], [-1.82, 2.0], [-1.74, 0.74], [-1.45, 0.60], [-1.00, 0.52], [-0.45, 0.46],
  [0.05, 0.47], [0.45, 0.53], [0.80, 0.60], [0.98, 0.66], [1.06, 2.0], [2.95, 2.0],
]

/**
 * Paint that draws the livery itself, from each fragment's place on the car,
 * so any body and accent pair can be laid over the one model and the line
 * stays crisp however close the camera gets.
 */
export function liveryPaint(body: number, accent: number, ghost: boolean): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.24,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    transparent: ghost,
    opacity: ghost ? 0.4 : 1,
    depthWrite: !ghost,
  })
  const uniforms = {
    uBody: { value: new THREE.Color(body) },
    uAccent: { value: new THREE.Color(accent) },
    uLineX: { value: LIVERY_LINE.map(([x]) => x) },
    uLineY: { value: LIVERY_LINE.map(([, y]) => y) },
  }
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCarPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCarPos = position;')
    const n = LIVERY_LINE.length
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vCarPos;
uniform vec3 uBody;
uniform vec3 uAccent;
uniform float uLineX[${n}];
uniform float uLineY[${n}];
float liveryLine(float x) {
  float y = uLineY[0];
  for (int i = 0; i < ${n - 1}; i++) {
    if (x >= uLineX[i] && x <= uLineX[i + 1]) {
      float t = (x - uLineX[i]) / (uLineX[i + 1] - uLineX[i]);
      y = mix(uLineY[i], uLineY[i + 1], t * t * (3.0 - 2.0 * t));
    }
  }
  return y;
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float d = vCarPos.y - liveryLine(vCarPos.x);
  float aa = max(fwidth(d), 1e-4);
  float above = smoothstep(-aa, aa, d);
  float stripe = smoothstep(-0.0285 - aa, -0.0285 + aa, d) - smoothstep(-0.0205 - aa, -0.0205 + aa, d);
  diffuseColor.rgb *= mix(uBody, uAccent, clamp(above + stripe, 0.0, 1.0));
}`)
  }
  m.customProgramCacheKey = () => 'livery-paint'
  return m
}
