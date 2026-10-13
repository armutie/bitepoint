import * as THREE from 'three'
import type { Track } from '../core/track'
import type { Terrain } from './terrain'

function randomSource(seed: number): () => number {
  let state = seed >>> 0
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0xffffffff }
}

function turfTexture(): THREE.CanvasTexture {
  const size = 512, canvas = document.createElement('canvas')
  canvas.width = size; canvas.height = size
  const ctx = canvas.getContext('2d')!, rand = randomSource(0x863bef21)
  const image = ctx.createImageData(size, size)
  for (let i = 0; i < size * size; i++) {
    const grain = (rand() - 0.5) * 22
    image.data[i * 4] = 58 + grain
    image.data[i * 4 + 1] = 77 + grain
    image.data[i * 4 + 2] = 32 + grain * 0.6
    image.data[i * 4 + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  // Fine overlapping cut blades, with a few dry stems, rather than lawn stripes.
  for (let i = 0; i < 16000; i++) {
    const x = rand() * size, y = rand() * size
    const length = 4 + rand() * 18, lean = (rand() - 0.5) * 10
    const dry = rand() < 0.08
    ctx.strokeStyle = dry ? `rgba(151,135,73,${0.12 + rand() * 0.25})` : `rgba(${44 + rand() * 55},${66 + rand() * 58},${22 + rand() * 24},${0.2 + rand() * 0.4})`
    ctx.lineWidth = 0.6 + rand() * 1.1
    // Wrapped strokes make a seamless close-detail texture.
    for (const dx of [0, -size, size]) for (const dy of [0, -size, size]) {
      ctx.beginPath(); ctx.moveTo(x + dx, y + dy)
      ctx.quadraticCurveTo(x + dx + lean * 0.3, y + dy - length * 0.6, x + dx + lean, y + dy - length)
      ctx.stroke()
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8
  return texture
}

function shadeAt(x: number, y: number): number {
  return 0.92 + 0.09 * Math.sin(x * 0.23 + Math.sin(y * 0.15)) + 0.07 * Math.sin(y * 0.43 - x * 0.11) + 0.045 * Math.sin(x * 1.73 + y * 1.21)
}

/** Detailed verge surface and short tufts, restricted to the corridor inside the walls. */
export function buildNearGrass(track: Track, terrain: Terrain): { root: THREE.Group; dispose(): void } {
  const root = new THREE.Group(); root.name = 'trackside-grass'
  const owned: { dispose(): void }[] = []
  const texture = turfTexture()
  const groundMat = new THREE.MeshStandardMaterial({ map: texture, vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.2, side: THREE.DoubleSide })
  groundMat.onBeforeCompile = shader => {
    shader.vertexShader = 'varying vec2 turfWorld;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nturfWorld = (modelMatrix * vec4(position, 1.0)).xz;')
    shader.fragmentShader = `varying vec2 turfWorld;
      float turfHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float turfNoise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(turfHash(i), turfHash(i + vec2(1.0, 0.0)), f.x), mix(turfHash(i + vec2(0.0, 1.0)), turfHash(i + vec2(1.0)), f.x), f.y);
      }
    ` + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      float turfPatch = turfNoise(turfWorld * 0.24);
      float turfClump = turfNoise(turfWorld * 1.7);
      diffuseColor.rgb *= 0.73 + 0.40 * turfPatch + 0.14 * turfClump;
      diffuseColor.rgb *= mix(vec3(1.0), vec3(1.18, 0.98, 0.74), smoothstep(0.64, 0.90, turfPatch) * 0.35);
    `)
  }
  groundMat.customProgramCacheKey = () => 'near-turf-v1'
  const bladeMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
  // Reduce blade height smoothly beyond close range; the detailed turf remains.
  bladeMat.onBeforeCompile = shader => {
    shader.vertexShader = 'attribute float grassBase;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec3 bladeWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      float bladeFade = 1.0 - smoothstep(18.0, 48.0, distance(cameraPosition.xz, bladeWorld.xz));
      transformed.y = grassBase + (position.y - grassBase) * bladeFade;
    `)
  }
  bladeMat.customProgramCacheKey = () => 'near-grass-v1'
  owned.push(texture, groundMat, bladeMat)
  const positions: number[] = [], colors: number[] = [], uvs: number[] = []
  const rand = randomSource(track.seed ^ 0x7561ab)
  const green = new THREE.Color(), bladeGreen = new THREE.Color()
  const point = (i: number, d: number) => {
    const j = (i + 1) % track.n, x = track.cx[i]!, y = track.cy[i]!
    const dx = track.cx[j]! - x, dy = track.cy[j]! - y, len = Math.hypot(dx, dy)
    return { x: x - dy / len * d, y: y + dx / len * d }
  }
  const addGround = (p: { x: number; y: number }) => {
    positions.push(p.x, terrain.height(p.x, p.y) - 0.018, -p.y)
    const shade = shadeAt(p.x, p.y)
    green.setRGB(shade, shade, shade * 0.94)
    colors.push(green.r, green.g, green.b); uvs.push(p.x / 2.4, -p.y / 2.4)
  }
  let bladePositions: number[] = [], bladeColors: number[] = [], bases: number[] = [], chunkLength = 0
  const flush = () => {
    if (!bladePositions.length) return
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(bladePositions, 3))
    geom.setAttribute('color', new THREE.Float32BufferAttribute(bladeColors, 3))
    geom.setAttribute('grassBase', new THREE.Float32BufferAttribute(bases, 1))
    geom.computeVertexNormals(); geom.computeBoundingSphere()
    const mesh = new THREE.Mesh(geom, bladeMat); mesh.receiveShadow = true
    root.add(mesh); owned.push(geom)
    bladePositions = []; bladeColors = []; bases = []; chunkLength = 0
  }
  for (let i = 0; i < track.n; i++) {
    const j = (i + 1) % track.n, len = track.segLenAt(i)
    for (const side of [-1, 1]) {
      const gapI = side > 0 ? track.barrierGapLeft[i]! : track.barrierGapRight[i]!
      const gapJ = side > 0 ? track.barrierGapLeft[j]! : track.barrierGapRight[j]!
      // Keep blades clear of painted edges and corner kerbs.
      const insetI = track.curvature[i]! > 0.0045 ? 1.22 : 0.25
      const insetJ = track.curvature[j]! > 0.0045 ? 1.22 : 0.25
      const a = point(i, side * (track.halfRing[i]! + insetI))
      const b = point(j, side * (track.halfRing[j]! + insetJ))
      const c = point(j, side * (track.halfRing[j]! + gapJ - 0.12))
      const d = point(i, side * (track.halfRing[i]! + gapI - 0.12))
      if (gapI <= insetI + 0.2 || gapJ <= insetJ + 0.2) continue
      for (const p of [a, c, b, a, d, c]) addGround(p)
      const vergeWidth = Math.min(2.8, gapI - insetI - 0.3)
      const count = Math.floor(len * vergeWidth * 2.4)
      for (let t = 0; t < count; t++) {
        const along = rand(), across = rand() * vergeWidth
        const px = a.x + (b.x - a.x) * along + (d.x - a.x) * across / (gapI - insetI - 0.12)
        const py = a.y + (b.y - a.y) * along + (d.y - a.y) * across / (gapI - insetI - 0.12)
        const projection = track.project(px, py)
        if (Math.abs(projection.lateral) < projection.half + 0.22) continue
        const base = terrain.height(px, py) - 0.012
        const height = 0.025 + rand() * 0.045
        const tone = shadeAt(px, py) * (0.78 + rand() * 0.45)
        bladeGreen.setRGB(0.045 * tone, 0.078 * tone, 0.018 * tone)
        if (rand() < 0.07) bladeGreen.setRGB(0.15 * tone, 0.13 * tone, 0.048 * tone)
        const angle = rand() * Math.PI, leanX = (rand() - 0.5) * 0.045, leanZ = (rand() - 0.5) * 0.045
        for (let blade = 0; blade < 5; blade++) {
          const theta = angle + blade * Math.PI / 3, w = 0.009 + rand() * 0.012
          const dx = Math.cos(theta) * w, dz = Math.sin(theta) * w
          bladePositions.push(px - dx, base, -py - dz, px + dx, base, -py + dz, px + leanX, base + height * (0.7 + rand() * 0.3), -py + leanZ)
          for (let vertex = 0; vertex < 3; vertex++) {
            const light = vertex === 2 ? 1.18 : 0.8
            bladeColors.push(bladeGreen.r * light, bladeGreen.g * light, bladeGreen.b * light); bases.push(base)
          }
        }
      }
    }
    chunkLength += len
    if (chunkLength > 40) flush()
  }
  flush()
  const ground = new THREE.BufferGeometry()
  ground.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  ground.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  ground.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  ground.computeVertexNormals()
  const mesh = new THREE.Mesh(ground, groundMat); mesh.receiveShadow = true
  root.add(mesh); owned.push(ground)
  return { root, dispose: () => owned.forEach(item => item.dispose()) }
}
