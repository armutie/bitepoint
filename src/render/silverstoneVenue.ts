import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { pointAt } from '../core/placement'
import type { Track } from '../core/track'

type Side = -1 | 1
type CrossSection = readonly [station: number, near: number, far: number]

export const SILVERSTONE_VENUE_START = 4700
export const SILVERSTONE_VENUE_END = 335

export function onSilverstoneVenue(track: Track, s: number): boolean {
  return track.id === 'silverstone-gp' && (s >= SILVERSTONE_VENUE_START || s <= SILVERSTONE_VENUE_END)
}

// Stations and surface edges interpreted from aerial imagery, in metres
// beyond the white line. The lap wraps inside the Hamilton Straight ribbons.
const STOWE_APRON: readonly CrossSection[] = [
  [4870, 0.12, 0.12], [4930, 0.12, 3.2], [5000, 0.12, 3.5],
  [5070, 0.12, 4.4], [5140, 0.12, 3.7], [5200, 0.12, 0.12],
]
const STOWE_GRAVEL: readonly CrossSection[] = [
  [4895, 1.6, 1.6], [4930, 3.2, 12.5], [4980, 3.4, 21.5], [5030, 3.9, 29.5],
  [5080, 4.3, 32.5], [5130, 3.8, 26.5], [5180, 1.7, 19.5], [5225, 1.6, 1.6],
]

const BOARDS = [
  { s: 4800, distance: 150, side: 1 }, { s: 4850, distance: 100, side: 1 },
  { s: 4900, distance: 50, side: 1 }, { s: 5380, distance: 100, side: -1 },
  { s: 5430, distance: 50, side: -1 },
] as const

type Disposable = { dispose(): void }

function aggregateTexture(): THREE.DataTexture {
  const size = 128
  const pixels = new Uint8Array(size * size * 4)
  let seed = 47319
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const grain = (seed >>> 24) / 255 - 0.5
    const rake = 3 * Math.sin(x * Math.PI / 16) + 2 * Math.cos(y * Math.PI / 32)
    const tone = 166 + 35 * grain + rake
    pixels.set([tone + 13, tone + 3, tone - 17, 255], (y * size + x) * 4)
  }
  const texture = new THREE.DataTexture(pixels, size, size)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 4
  texture.needsUpdate = true
  return texture
}

function fenceTexture(): THREE.DataTexture {
  const size = 64
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const wire = (x + y) % 16 < 1 || (x - y + size) % 16 < 1
    pixels.set([164, 170, 167, wire ? 255 : 0], (y * size + x) * 4)
  }
  const texture = new THREE.DataTexture(pixels, size, size)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

function ribbon(track: Track, side: Side, rows: readonly CrossSection[], height: number): THREE.BufferGeometry {
  const positions: number[] = [], uv: number[] = [], indices: number[] = []
  const row = (station: number, near: number, far: number): void => {
    const half = track.halfAt(station)
    for (const offset of [near, far]) {
      const { x, y } = pointAt(track, station, side * (half + offset))
      positions.push(x, height, -y)
      uv.push(x / 2.6, y / 2.6)
    }
  }
  row(...rows[0]!)
  for (let i = 1; i < rows.length; i++) {
    const [start, near, far] = rows[i - 1]!
    const [end, nextNear, nextFar] = rows[i]!
    const steps = Math.ceil((end - start) / 3.5)
    for (let j = 1; j <= steps; j++) {
      const t = j / steps
      const a = positions.length / 3 - 2
      row(THREE.MathUtils.lerp(start, end, t), THREE.MathUtils.lerp(near, nextNear, t), THREE.MathUtils.lerp(far, nextFar, t))
      if (side > 0) indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
      else indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

function boardAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const context = canvas.getContext('2d')!
  for (const [i, value] of ['50', '100', '150', 'SILVERSTONE'].entries()) {
    const x = i * 128
    context.fillStyle = i === 3 ? '#233341' : '#e3e1d5'
    context.fillRect(x, 0, 128, 128)
    context.fillStyle = i === 3 ? '#e8e7dd' : '#151619'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.font = i === 3 ? 'bold 19px Arial' : '900 68px Arial'
    context.fillText(value, x + 64, 67, 118)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

function assemble(
  root: THREE.Group, name: string, geometries: THREE.BufferGeometry[],
  material: THREE.Material, resources: Disposable[],
): void {
  const geometry = mergeGeometries(geometries)
  for (const part of geometries) part.dispose()
  if (!geometry) throw new Error('Cannot batch Silverstone geometry: ' + name)
  resources.push(geometry)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = name
  root.add(mesh)
}

function tint(geometry: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const value = new THREE.Color(color)
  const colors: number[] = []
  for (let i = 0; i < geometry.getAttribute('position').count; i++) colors.push(value.r, value.g, value.b)
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return geometry
}

export function buildSilverstoneVenue(track: Track): { root: THREE.Group; dispose(): void } {
  const root = new THREE.Group()
  root.name = 'silverstone-venue'
  const gravelMap = aggregateTexture()
  const atlas = boardAtlas()
  const gravel = new THREE.MeshLambertMaterial({ map: gravelMap, side: THREE.DoubleSide })
  const apron = new THREE.MeshLambertMaterial({ color: 0x474743, side: THREE.DoubleSide })
  const paint = new THREE.MeshLambertMaterial({ color: 0xc6c2aa, side: THREE.DoubleSide })
  const solid = new THREE.MeshLambertMaterial({ vertexColors: true })
  const signs = new THREE.MeshLambertMaterial({ map: atlas, side: THREE.DoubleSide })
  const meshMap = fenceTexture()
  const fence = new THREE.MeshLambertMaterial({ map: meshMap, alphaTest: 0.23, side: THREE.DoubleSide })
  const resources: Disposable[] = [gravelMap, atlas, meshMap, gravel, apron, paint, solid, signs, fence]

  assemble(root, 'stowe-asphalt-apron', [ribbon(track, 1, STOWE_APRON, 0.022)], apron, resources)
  assemble(root, 'stowe-gravel-trap', [ribbon(track, 1, STOWE_GRAVEL, 0.018)], gravel, resources)

  const pitEnd = track.length + 296
  assemble(root, 'vale-club-paved-runoff-and-pit-lane', [
    ribbon(track, -1, [[5315, 0.4, 0.4], [5370, 0.4, 3.8], [5440, 0.3, 6.5],
      [5500, 0.3, 5.5], [5530, 0.3, 0.3]], 0.021),
    ribbon(track, 1, [[5530, 0.2, 0.2], [5568, 0.2, 4.6], [5635, 0.22, 3.6], [5785, 0.22, 3.1],
      [5848, 0.2, 0.2]], 0.022),
    ribbon(track, -1, [[5835, 0.55, 0.55], [track.length - 30, 0.55, 2.7],
      [track.length, 0.55, 2.7], [pitEnd, 0.55, 2.7]], 0.023),
    ribbon(track, -1, [[5730, 4.5, 4.5], [5790, 4.1, 10], [5850, 3.15, 14],
      [track.length, 3.15, 14], [pitEnd, 3.15, 14]], 0.025),
  ], apron, resources)
  assemble(root, 'vale-and-club-gravel', [
    ribbon(track, -1, [[5365, 3.5, 3.5], [5410, 5.5, 15], [5465, 6.2, 21],
      [5502, 5.4, 19], [5529, 2.5, 2.5]], 0.018),
    ribbon(track, 1, [[5538, 3.3, 3.3], [5575, 4.5, 19], [5630, 4.1, 17.2], [5665, 3.4, 3.4]], 0.018),
    ribbon(track, 1, [[5680, 3.3, 3.3], [5715, 3.2, 16], [5778, 3.1, 15],
      [5815, 2.2, 8], [5845, 1.2, 1.2]], 0.018),
  ], gravel, resources)
  assemble(root, 'pit-fast-lane-line', [
    ribbon(track, -1, [[5810, 7.5, 7.64], [5850, 9.5, 9.64],
      [track.length, 9.5, 9.64], [pitEnd, 9.5, 9.64]], 0.034),
  ], paint, resources)

  const boardBodies: THREE.BufferGeometry[] = [], boardFaces: THREE.BufferGeometry[] = []
  const wing: THREE.BufferGeometry[] = [], bridge: THREE.BufferGeometry[] = []
  const fencePosts: THREE.BufferGeometry[] = [], fencePanels: THREE.BufferGeometry[] = []
  const placement = (station: number, lateral: number, geometry: THREE.BufferGeometry): THREE.BufferGeometry => {
    const p = pointAt(track, station, lateral)
    geometry.rotateY(track.poseAt(station).yaw)
    geometry.translate(p.x, 0, -p.y)
    return geometry
  }
  const block = (
    batch: THREE.BufferGeometry[], station: number, lateral: number, bottom: number,
    length: number, depth: number, height: number, color: number,
  ): void => {
    const geometry = new THREE.BoxGeometry(length, height, depth)
    geometry.translate(0, bottom + height / 2, 0)
    batch.push(tint(placement(station, lateral, geometry), color))
  }
  const sign = (
    station: number, lateral: number, centre: number, width: number, height: number, cell: number,
  ): void => {
    const geometry = new THREE.PlaneGeometry(width, height)
    geometry.rotateY(-Math.PI / 2)
    geometry.translate(-0.051, centre, 0)
    const uv = geometry.getAttribute('uv')
    for (let i = 0; i < uv.count; i++) {
      const v = cell === 3 ? 0.36 + uv.getY(i) * 0.28 : uv.getY(i)
      uv.setXY(i, (128 * cell + 1 + 126 * uv.getX(i)) / 512, v)
    }
    boardFaces.push(placement(station, lateral, geometry))
  }

  for (const board of BOARDS) {
    const offset = board.side * (track.halfAt(board.s) + 1.95)
    block(boardBodies, board.s, offset, 0, 0.1, 0.08, 1.43, 0x626360)
    block(boardBodies, board.s, offset, 0.74, 0.1, 1.13, 0.73, 0xbab9af)
    sign(board.s, offset, 1.105, 1.1, 0.7, board.distance / 50 - 1)
  }

  // The Wing sits behind a working apron and pit wall, with dark garage
  // openings at ground level and a continuous glazed ribbon above them.
  const grey = 0x9c9f9c, glass = 0x344954, roof = 0xa2a8a9
  for (let s = -26; s <= 280; s += 6.4) {
    const bay = Math.round((s + 26) / 6.4)
    block(wing, s, -29.5, 0, 6.35, 15.1, 4.2, 0x464747)
    block(wing, s, -21.9, 0, 0.36, 0.66, 4.0, grey)
    block(wing, s + 0.2, -21.85, 0.05, 5.6, 0.14, 2.9, bay % 7 === 3 ? 0x656a6c : 0x242b31)
    block(wing, s, -21.65, 3.06, 5.88, 0.35, 0.55, [0x64605a, 0x806740, 0x71694d, 0x52686b][Math.floor(bay / 3) % 4]!)
  }
  for (let s = -22; s <= 278; s += 10) {
    block(wing, s, -30, 4.15, 10.0, 17.1, 3.8, grey)
    block(wing, s, -21.35, 4.65, 9.7, 0.25, 2.75, glass)
    for (const along of [-3.15, 0, 3.15]) block(wing, s + along, -21.19, 4.64, 0.11, 0.13, 2.82, 0x929c9c)
  }
  // Broad, asymmetric roof silhouette, including the raised end and long eaves.
  const roofProfile = [[-39, 8.7], [15, 9.1], [65, 9.5], [114, 8.9],
    [165, 10.3], [215, 13.8], [261, 12.5], [292, 9.3]] as const
  const roofVertices: number[] = []
  const roofFace = (station: number, lateral: number, height: number): number[] => {
    const p = pointAt(track, station, lateral)
    return [p.x, height, -p.y]
  }
  for (let i = 1; i < roofProfile.length; i++) {
    const [s0, h0] = roofProfile[i - 1]!, [s1, h1] = roofProfile[i]!
    const a = roofFace(s0, -19.8, h0), b = roofFace(s1, -19.8, h1)
    const c = roofFace(s1, -40, h1 + 1.1), d = roofFace(s0, -40, h0 + 1.1)
    const e = roofFace(s0, -19.8, h0 - 0.45), f = roofFace(s1, -19.8, h1 - 0.45)
    roofVertices.push(...a, ...c, ...b, ...a, ...d, ...c, ...a, ...b, ...f, ...a, ...f, ...e)
  }
  const roofGeometry = new THREE.BufferGeometry()
  roofGeometry.setAttribute('position', new THREE.Float32BufferAttribute(roofVertices, 3))
  roofGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(roofVertices.length / 3 * 2), 2))
  roofGeometry.computeVertexNormals()
  wing.push(tint(roofGeometry, roof).setIndex(Array.from({ length: roofVertices.length / 3 }, (_, i) => i)))

  const bridgeS = 106
  block(bridge, bridgeS, -2, 6.4, 3.3, 38, 1.65, 0xbec1bb)
  block(bridge, bridgeS - 0.1, -2, 6.7, 3.46, 38.1, 0.85, 0x3e535e)
  for (const lateral of [-20.8, 15.8]) block(bridge, bridgeS, lateral, 0, 1.4, 1.1, 7.1, 0xa9afac)
  sign(bridgeS - 1.84, 0, 7.17, 12, 1.2, 3)

  for (const side of [-1, 1] as const) {
    for (let s = -40; s < 296; s += 6) {
      const offset = side * (track.halfAt(s) + track.barrierGapAt(s, side < 0) + 0.5)
      block(fencePosts, s, offset, 0.95, 0.075, 0.075, 2.2, 0x888f8d)
      const panel = new THREE.PlaneGeometry(6, 1.95)
      const uv = panel.getAttribute('uv')
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 10, uv.getY(i) * 3.25)
      panel.translate(3, 2.08, 0)
      fencePanels.push(placement(s, offset, panel))
    }
  }

  assemble(root, 'hamilton-catch-fence-posts', fencePosts, solid, resources)
  assemble(root, 'hamilton-catch-fence-mesh', fencePanels, fence, resources)
  assemble(root, 'distance-board-supports', boardBodies, solid, resources)
  assemble(root, 'numbered-distance-boards-and-bridge-sign', boardFaces, signs, resources)
  assemble(root, 'silverstone-wing', wing, solid, resources)
  assemble(root, 'hamilton-straight-footbridge', bridge, solid, resources)
  return { root, dispose() { for (const resource of resources) resource.dispose() } }
}
