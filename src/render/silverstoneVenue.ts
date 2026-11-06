import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { clearOfCircuit, pointAt } from '../core/placement'
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
  { s: 4800, distance: 150, sides: [-1, 1], blue: false },
  { s: 4850, distance: 100, sides: [-1, 1], blue: false },
  { s: 4900, distance: 50, sides: [-1, 1], blue: false },
  { s: 5380, distance: 100, sides: [-1, 1], blue: true },
  { s: 5430, distance: 50, sides: [-1, 1], blue: true },
  { s: 223, distance: 150, sides: [1], blue: false },
] as const
const SIGN_CELL = 256
const SIGN_COLUMNS = 4
const SIGN_ROWS = 2


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
  canvas.width = SIGN_CELL * SIGN_COLUMNS
  canvas.height = SIGN_CELL * SIGN_ROWS
  const c = canvas.getContext('2d')!
  for (const [i, value] of ['50', '100', '150', 'SILVERSTONE', '50', '100'].entries()) {
    const x = (i % SIGN_COLUMNS) * SIGN_CELL, y = Math.floor(i / SIGN_COLUMNS) * SIGN_CELL
    const blue = i >= 4, bridge = i === 3
    c.fillStyle = blue ? '#245b91' : bridge ? '#354760' : '#f1efe4'
    c.fillRect(x, y, SIGN_CELL, SIGN_CELL)
    c.strokeStyle = blue ? '#17426d' : bridge ? '#465c75' : '#c6c5ba'
    c.lineWidth = 5
    c.strokeRect(x + 6, y + 8, 244, 240)
    c.fillStyle = blue || bridge ? '#fff9e9' : '#16181a'
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.font = bridge ? 'bold 37px Arial' : '900 155px Arial'
    c.fillText(value, x + 128, y + 137, 231)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

function crowdTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 256
  const c = canvas.getContext('2d')!
  c.fillStyle = '#464755'
  c.fillRect(0, 0, 1024, 256)
  let seed = 89031
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
  const shirts = ['#a34f48', '#445b7b', '#c8bdad', '#776a57', '#794d5c', '#ccc2ab', '#343a49', '#b26346']
  for (let row = 0; row < 5; row++) {
    const base = row * 51
    c.fillStyle = '#343741'
    c.fillRect(0, base + 46, 1024, 5)
    for (let i = 0; i < 64; i++) {
      if (random() < 0.1) continue
      const x = i * 16 + 3 + random() * 8, y = base + 12 + random() * 8
      c.fillStyle = shirts[Math.floor(random() * shirts.length)]!
      c.beginPath()
      c.ellipse(x, y + 17, 5 + random() * 2, 13, 0, 0, 2 * Math.PI)
      c.fill()
      c.fillStyle = random() < 0.5 ? '#af8369' : '#c5a690'
      c.beginPath()
      c.ellipse(x, y + 4, 3.2, 4.6, 0, 0, 2 * Math.PI)
      c.fill()
      c.fillStyle = random() < 0.4 ? '#d6cbc0' : '#443c3c'
      c.fillRect(x - 3, y, 6, 2.1)
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.anisotropy = 4
  return texture
}

function eventWallTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 512
  const c = canvas.getContext('2d')!
  const bands = [
    ['#653440', '#eee3d8', 'BRITISH GRAND PRIX'],
    ['#dfb94b', '#963b2a', 'SILVERSTONE'],
    ['#25323d', '#e4e1df', 'BITE POINT'],
    ['#28545b', '#e4e5da', 'SILVERSTONE'],
  ] as const
  for (const [i, [background, ink, label]] of bands.entries()) {
    const y = i * 128
    c.fillStyle = background
    c.fillRect(0, y, 1024, 128)
    c.fillStyle = ink
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.font = (i === 1 ? 'italic 900 ' : 'bold ') + '73px Arial'
    c.fillText(label, 512, y + 65, 935)
    c.fillStyle = 'rgba(15,13,14,.19)'
    c.fillRect(0, y + 122, 1024, 6)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.anisotropy = 8
  return texture
}

function assemble(
  root: THREE.Group, name: string, geometries: THREE.BufferGeometry[],
  material: THREE.Material, resources: Disposable[],
): void {
  const geometry = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries)
  if (geometries.length > 1) for (const part of geometries) part.dispose()
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
  const verge = new THREE.MeshLambertMaterial({ color: 0x467b6c, side: THREE.DoubleSide })
  const solid = new THREE.MeshLambertMaterial({ vertexColors: true })
  const signs = new THREE.MeshLambertMaterial({ map: atlas, side: THREE.DoubleSide })
  const meshMap = fenceTexture()
  const spectatorsMap = crowdTexture()
  const wallMap = eventWallTexture()
  const spectators = new THREE.MeshLambertMaterial({ map: spectatorsMap, side: THREE.DoubleSide })
  const standMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
  const eventWalls = new THREE.MeshLambertMaterial({ map: wallMap, side: THREE.DoubleSide })
  const fence = new THREE.MeshLambertMaterial({ map: meshMap, alphaTest: 0.23, side: THREE.DoubleSide })
  const resources: Disposable[] = [
    gravelMap, atlas, meshMap, spectatorsMap, wallMap, gravel, apron, paint, verge, solid, signs, fence, spectators, standMaterial, eventWalls,
  ]

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
  assemble(root, 'painted-runoff-verges', [
    ribbon(track, 1, [[5118, 0.95, 0.95], [5145, 0.95, 2.1], [5280, 0.9, 2.1], [5315, 0.9, 0.9]], 0.030),
    ribbon(track, 1, [[5590, 0.95, 0.95], [5638, 0.95, 2.25], [5800, 0.9, 2.1], [5860, 0.9, 0.9]], 0.032),
  ], verge, resources)
  assemble(root, 'pit-fast-lane-line', [
    ribbon(track, -1, [[5810, 7.5, 7.64], [5850, 9.5, 9.64],
      [track.length, 9.5, 9.64], [pitEnd, 9.5, 9.64]], 0.034),
  ], paint, resources)

  const boardBodies: THREE.BufferGeometry[] = [], boardFaces: THREE.BufferGeometry[] = []
  const wing: THREE.BufferGeometry[] = [], bridge: THREE.BufferGeometry[] = []
  const fencePosts: THREE.BufferGeometry[] = [], fencePanels: THREE.BufferGeometry[] = []
  const wallFaces: THREE.BufferGeometry[] = []
  const grandstandSolids: THREE.BufferGeometry[] = [], grandstandFaces: THREE.BufferGeometry[] = []
  const canopyTrees: THREE.BufferGeometry[] = []
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
    geometry.translate(-0.10, centre, 0)
    const uv = geometry.getAttribute('uv')
    for (let i = 0; i < uv.count; i++) {
      const u = (cell % SIGN_COLUMNS + 0.01 + uv.getX(i) * 0.98) / SIGN_COLUMNS
      const v = cell === 3 ? 0.33 + uv.getY(i) * 0.31 : 0.01 + uv.getY(i) * 0.98
      uv.setXY(i, u, 1 - (Math.floor(cell / SIGN_COLUMNS) + 1 - v) / SIGN_ROWS)
    }
    boardFaces.push(placement(station, lateral, geometry))
  }

  for (const board of BOARDS) for (const side of board.sides) {
    const offset = side * (track.halfAt(board.s) + 1.85)
    // Real braking boards sit low to the verge, with a substantial rectangular
    // face and two short supports. The colour changes between event zones.
    const casing = board.blue ? 0x244a74 : 0xd0cec1
    block(boardBodies, board.s, offset, 0.18, 0.19, 1.76, 0.99, casing)
    for (const leg of [-0.61, 0.61]) block(boardBodies, board.s, offset + leg, 0, 0.24, 0.12, 0.24, 0x626863)
    const cell = board.blue ? 3 + board.distance / 50 : board.distance / 50 - 1
    sign(board.s, offset, 0.675, 1.71, 0.95, cell)
  }

  const fascia = (start: number, end: number, side: Side, band: number): void => {
    const positions: number[] = [], uv: number[] = [], indices: number[] = []
    const gap = side < 0 ? track.barrierGapRight : track.barrierGapLeft
    const edge = (i: number) => {
      const offset = side * (track.halfRing[i]! + gap[i]! - 0.045)
      return [track.cx[i]! + track.edgeNormalX(i) * offset, track.cy[i]! + track.edgeNormalY(i) * offset] as const
    }
    let arc = 0
    for (let i = 0; arc < end; i++) {
      const segment = i % track.n
      const length = track.segLenAt(segment)
      const first = Math.max(arc, start), last = Math.min(arc + length, end)
      if (first < last) {
        const [ax, ay] = edge(segment), [bx, by] = edge((segment + 1) % track.n)
        const vertex = positions.length / 3
        for (const s of [first, last]) {
          const t = (s - arc) / length
          const x = THREE.MathUtils.lerp(ax, bx, t), y = THREE.MathUtils.lerp(ay, by, t)
          positions.push(x, 0.12, -y, x, 1.04, -y)
          const u = side * (s - start) / 8.5
          uv.push(u, 1 - (band + 0.98) / 4, u, 1 - (band + 0.02) / 4)
        }
        indices.push(vertex, vertex + 2, vertex + 1, vertex + 1, vertex + 2, vertex + 3)
      }
      arc += length
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    wallFaces.push(geometry)
  }
  for (const side of [-1, 1] as const) {
    fascia(4750, 4956, side, 1)
    fascia(4960, 5206, side, 2)
    fascia(5240, 5500, side, 3)
    fascia(5510, 5678, side, 2)
    fascia(5682, track.length + 324, side, 0)
  }

  const standQuad = (points: THREE.Vector3[], uv = [0, 0, 1, 0, 1, 1, 0, 1]): THREE.BufferGeometry => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap(p => p.toArray()), 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    geometry.computeVertexNormals()
    return geometry
  }
  const grandstand = (start: number, end: number, side: Side, tiers: number, covered: boolean): void => {
    const modules = Math.ceil((end - start) / 11)
    const length = (end - start) / modules
    const frontAt = (s: number) => track.halfAt(s) + track.barrierGapAt(s, side < 0) + 5.2
    const vertex = (s: number, depth: number, height: number): THREE.Vector3 => {
      const p = pointAt(track, s, side * (frontAt(s) + depth))
      return new THREE.Vector3(p.x, height, -p.y)
    }
    const plate = (
      s0: number, s1: number, d0: number, d1: number, y0: number, y1: number, color: number,
    ): void => {
      grandstandSolids.push(tint(standQuad([
        vertex(s0, d0, y0), vertex(s1, d0, y0), vertex(s1, d1, y1), vertex(s0, d1, y1),
      ]), color))
    }
    const rear = tiers * 1.45
    const eaves = 2.8 + tiers * 0.86
    for (let i = 0; i < modules; i++) {
      const s0 = start + i * length, s1 = s0 + length
      const station = (s0 + s1) / 2
      plate(s0, s1, 0, 0, 0, 1.25, 0x7e858a)
      plate(s0, s1, 0, rear, 1.1, 0.8 + tiers * 0.86, 0x5a6068)
      for (let tier = 0; tier < tiers; tier++) {
        const depth = tier * 1.45
        const base = 1.3 + tier * 0.86
        plate(s0, s1, depth, depth + 1.45, base, base, 0x656870)
        const row = (tier + i * 2) % 5
        const u0 = (i % 3) * 0.31, u1 = u0 + 0.32
        const v0 = (4 - row + 0.03) / 5, v1 = v0 + 0.94 / 5
        const aisle = i % 3 === 2 ? 0.42 : 0.025
        grandstandFaces.push(standQuad([
          vertex(s0 + aisle, depth, base), vertex(s1 - aisle, depth, base),
          vertex(s1 - aisle, depth, base + 0.88), vertex(s0 + aisle, depth, base + 0.88),
        ], [u0, v0, u1, v0, u1, v1, u0, v1]))
      }
      const back = side * (frontAt(station) + rear)
      block(grandstandSolids, station, back, 0, 0.28, 0.34, eaves, 0x899197)
      plate(s0, s1, rear - 0.1, rear - 0.1, eaves - 1.9, eaves - 0.55, 0x606973)
      if (covered) {
        plate(s0, s1, -2.0, rear + 1.8, eaves, eaves + 1.15, 0xbcc2c1)
        plate(s0, s1, -2.0, -2.0, eaves - 0.35, eaves, 0x8e9ba2)
      }
    }
    for (const cap of [start, end]) {
      grandstandSolids.push(tint(standQuad([
        vertex(cap, 0, 0.3), vertex(cap, rear, 0.3),
        vertex(cap, rear, 1.2 + tiers * 0.86), vertex(cap, 0, 1.25),
      ]), 0x68727a))
    }
  }

  // The long roof across Hamilton Straight, the uncovered Stowe stand visible
  // on approach, and the terraces above Vale have distinct silhouettes.
  grandstand(-53, 94, 1, 8, true)
  grandstand(125, 188, 1, 8, true)
  grandstand(193, 298, 1, 7, true)
  grandstand(348, 410, 1, 5, false)
  grandstand(4746, 4894, 1, 2, false)
  grandstand(4800, 4920, -1, 8, false)
  grandstand(5020, 5138, 1, 6, false)
  grandstand(5335, 5400, -1, 5, false)
  grandstand(5650, 5724, 1, 6, true)

  // A broken line of taller crowns beyond the Stowe bank, with lower trees
  // in front. This is a distant silhouette with no per-tree draw calls.
  for (let i = 0; i < 61; i++) {
    const station = 4938 + i * 4.4
    const side = i % 9 === 8 ? -1 : 1
    const distance = track.halfAt(station) + track.barrierGapAt(station, side < 0)
      + 29 + 4.2 * Math.sin(i * 0.43) + 2.5 * Math.cos(i * 1.21)
    const position = pointAt(track, station, side * distance)
    if (!clearOfCircuit(track, position.x, position.y, 8)) continue
    const height = 6.8 + 3.5 * Math.sin(i * 0.41) ** 2 + (i % 3) * 0.7
    // Overlapping understory joins the taller crowns to the bank and stops
    // individual trees reading as floating discs from the end of the straight.
    const crowns = [[4.9, 0.28, 0.29], [3.5, 0.65, 0.34], [2.85, 0.79, 0.28]] as const
    for (const [crown, [width, centre, radius]] of crowns.entries()) {
      const geometry = new THREE.IcosahedronGeometry(1, crown === 1 ? 1 : 0)
      geometry.scale(width, height * radius, width * (0.82 + 0.25 * Math.sin(i * 0.7) ** 2))
      geometry.rotateY(i * 2.39 + crown)
      geometry.translate(
        position.x + Math.sin(i + crown) * crown * 1.2, height * centre,
        -position.y + Math.cos(i + crown) * crown * 1.4,
      )
      const greens = [0x465139, 0x58644a, 0x657052, 0x4a5942]
      canopyTrees.push(tint(geometry, greens[(i + crown) % greens.length]!))
    }
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
  const roofProfile = [[-39, 13.8], [-18, 10.1], [15, 9.1], [65, 9.5], [114, 8.9],
    [165, 10.3], [215, 13.8], [261, 12.5], [292, 9.3]] as const
  const roofVertices: number[] = []
  const roofFace = (station: number, lateral: number, height: number): number[] => {
    const p = pointAt(track, station, lateral)
    return [p.x, height, -p.y]
  }
  for (let i = 1; i < roofProfile.length; i++) {
    const [s0, h0] = roofProfile[i - 1]!, [s1, h1] = roofProfile[i]!
    const a = roofFace(s0, -18.2, h0), b = roofFace(s1, -18.2, h1)
    const c = roofFace(s1, -40, h1 + 1.1), d = roofFace(s0, -40, h0 + 1.1)
    const e = roofFace(s0, -18.2, h0 - 0.63), f = roofFace(s1, -18.2, h1 - 0.63)
    roofVertices.push(...a, ...c, ...b, ...a, ...d, ...c, ...a, ...b, ...f, ...a, ...f, ...e)
  }
  const roofGeometry = new THREE.BufferGeometry()
  roofGeometry.setAttribute('position', new THREE.Float32BufferAttribute(roofVertices, 3))
  roofGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(roofVertices.length / 3 * 2), 2))
  roofGeometry.computeVertexNormals()
  wing.push(tint(roofGeometry, roof).setIndex(Array.from({ length: roofVertices.length / 3 }, (_, i) => i)))

  const bridgeS = 106
  const brace = (a: THREE.Vector3, b: THREE.Vector3, width: number, color: number): void => {
    const direction = b.clone().sub(a)
    const part = new THREE.BoxGeometry(width, direction.length(), width)
    part.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()))
    part.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
    bridge.push(tint(placement(bridgeS, 0, part), color))
  }
  block(bridge, bridgeS, -2, 6.13, 3.4, 38, 0.31, 0xaeb9bb)
  for (const x of [-1.62, 1.62]) {
    for (const y of [6.55, 8.42]) brace(new THREE.Vector3(x, y, -17), new THREE.Vector3(x, y, 21), 0.22, 0xc4c9c6)
    for (let z = -17, i = 0; z < 19; z += 4, i++) {
      const rise = i % 2 === 0
      brace(new THREE.Vector3(x, rise ? 6.56 : 8.41, z),
        new THREE.Vector3(x, rise ? 8.41 : 6.56, z + 4), 0.14, 0xc1c7c6)
    }
  }
  for (const z of [-15.8, 20.8]) {
    brace(new THREE.Vector3(-2.4, 0, z * 1.12), new THREE.Vector3(-1.45, 6.5, z), 0.46, 0xa9afac)
    brace(new THREE.Vector3(2.4, 0, z * 1.12), new THREE.Vector3(1.45, 6.5, z), 0.46, 0xa9afac)
  }
  sign(bridgeS - 1.64, 0, 7.42, 12, 1.45, 3)

  const fenceSpan = (start: number, end: number, side: Side): void => {
    for (let s = start; s < end; s += 6) {
      const offset = side * (track.halfAt(s) + track.barrierGapAt(s, side < 0) + 0.5)
      block(fencePosts, s, offset, 0.95, 0.075, 0.075, 2.2, 0x888f8d)
      const panel = new THREE.PlaneGeometry(6, 1.95)
      const uv = panel.getAttribute('uv')
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 10, uv.getY(i) * 3.25)
      panel.translate(3, 2.08, 0)
      fencePanels.push(placement(s, offset, panel))
    }
  }
  fenceSpan(-40, 296, -1)
  fenceSpan(-40, 296, 1)
  fenceSpan(4750, 4940, 1)
  fenceSpan(4958, 5150, 1)

  assemble(root, 'silverstone-grandstand-structure', grandstandSolids, standMaterial, resources)
  assemble(root, 'silverstone-occupied-terraces', grandstandFaces, spectators, resources)
  assemble(root, 'stowe-wooded-skyline', canopyTrees, solid, resources)
  assemble(root, 'silverstone-event-wall-fascias', wallFaces, eventWalls, resources)
  assemble(root, 'silverstone-catch-fence-posts', fencePosts, solid, resources)
  assemble(root, 'silverstone-catch-fence-mesh', fencePanels, fence, resources)
  assemble(root, 'distance-board-supports', boardBodies, solid, resources)
  assemble(root, 'numbered-distance-boards-and-bridge-sign', boardFaces, signs, resources)
  assemble(root, 'silverstone-wing', wing, solid, resources)
  assemble(root, 'hamilton-straight-footbridge', bridge, solid, resources)
  return { root, dispose() { for (const resource of resources) resource.dispose() } }
}
