import * as THREE from 'three'

/** Vertex lists as the builders collect them: flat triangles, no index. */
export interface StripArrays {
  positions: number[]
  colors: number[]
  uvs?: number[]
}

const CHUNK = 30000

/**
 * Turn collected vertex lists into a geometry, a slice at a time.
 *
 * Doing this in one go — `new Float32BufferAttribute` over a few hundred
 * thousand numbers, then `computeVertexNormals` — was the longest single stall
 * when a circuit loaded (90-160 ms for the road alone). The normals are the
 * flat per-face ones `computeVertexNormals` gives a non-indexed geometry, so
 * the result is the same.
 */
export function* stripGeometrySteps(strip: StripArrays): Generator<void, THREE.BufferGeometry> {
  const positions = yield* copySteps(strip.positions)
  const colors = yield* copySteps(strip.colors)
  const uvs = strip.uvs ? yield* copySteps(strip.uvs) : null
  const normals = new Float32Array(positions.length)
  for (let t = 0; t < positions.length; t += 9) {
    if (t % (CHUNK * 3) === 0) yield
    const ax = positions[t]!, ay = positions[t + 1]!, az = positions[t + 2]!
    const bx = positions[t + 3]!, by = positions[t + 4]!, bz = positions[t + 5]!
    const cx = positions[t + 6]!, cy = positions[t + 7]!, cz = positions[t + 8]!
    // (c - b) x (a - b), as three.js does.
    const ux = cx - bx, uy = cy - by, uz = cz - bz
    const vx = ax - bx, vy = ay - by, vz = az - bz
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len > 0) { nx /= len; ny /= len; nz /= len }
    for (let k = 0; k < 9; k += 3) {
      normals[t + k] = nx; normals[t + k + 1] = ny; normals[t + k + 2] = nz
    }
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  if (uvs) geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  return geom
}

function* copySteps(from: number[]): Generator<void, Float32Array> {
  const out = new Float32Array(from.length)
  for (let i = 0; i < from.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, from.length)
    for (let j = i; j < end; j++) out[j] = from[j]!
    yield
  }
  return out
}
