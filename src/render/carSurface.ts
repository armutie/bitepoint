import * as THREE from 'three'

/** Halo fairing: a wide carbon upper surface, not a circular pipe. */
export function haloSurface(points: number[][], from = 0, to = 1, decal = false): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map(v => new THREE.Vector3(v[0]!, v[1]!, v[2]!)))
  const positions: number[] = [], uvs: number[] = [], indices: number[] = []
  const steps = 96, sides = decal ? 1 : 16
  for (let i = 0; i <= steps; i++) {
    const t = from + (to - from) * i / steps, c = curve.getPoint(t), tangent = curve.getTangent(t)
    const across = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize()
    for (let j = 0; j <= sides; j++) {
      const angle = j / sides * Math.PI * 2
      const lateral = decal ? (j - 0.5) * 0.085 : Math.cos(angle) * 0.056
      const vertical = decal ? 0.026 : Math.sin(angle) * 0.025
      positions.push(c.x + across.x * lateral, c.y + vertical, c.z + across.z * lateral)
      uvs.push(i / steps, j / sides)
      if (i < steps && j < sides) {
        const k = i * (sides + 1) + j
        if (decal) indices.push(k, k + sides + 1, k + 1, k + 1, k + sides + 1, k + sides + 2)
        else indices.push(k, k + 1, k + sides + 1, k + 1, k + sides + 2, k + sides + 1)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(indices); g.computeVertexNormals()
  return g
}

/** A smooth, closed body shell. Sections are x, centre-height, half-height, half-width. */
export function shell(sections: readonly (readonly [number, number, number, number])[], rings = 40): THREE.BufferGeometry {
  const shape = new THREE.CatmullRomCurve3(sections.map(s => new THREE.Vector3(s[0], s[1], s[2])))
  const widths = new THREE.CatmullRomCurve3(sections.map(s => new THREE.Vector3(s[0], s[3], 0)))
  const sides = 24, pos: number[] = [], uv: number[] = [], indices: number[] = []
  for (let i = 0; i <= rings; i++) {
    const t = i / rings, s = shape.getPoint(t), w = widths.getPoint(t).y
    for (let j = 0; j <= sides; j++) {
      const a = j / sides * Math.PI * 2
      const sn = Math.sin(a), cs = Math.cos(a)
      pos.push(s.x, s.y + s.z * Math.sign(sn) * Math.abs(sn) ** 0.38, w * Math.sign(cs) * Math.abs(cs) ** 0.38)
      uv.push(t * 3, j / sides)
      if (i < rings && j < sides) {
        const k = i * (sides + 1) + j
        indices.push(k, k + sides + 1, k + 1, k + 1, k + sides + 1, k + sides + 2)
      }
    }
  }
  for (const end of [0, rings]) {
    const s = shape.getPoint(end / rings), centre = pos.length / 3
    pos.push(s.x, s.y, 0); uv.push(end / rings, 0.5)
    for (let j = 0; j < sides; j++) {
      const k = end * (sides + 1) + j
      if (end === 0) indices.push(centre, k, k + 1)
      else indices.push(centre, k + 1, k)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(indices); g.computeVertexNormals()
  return g
}

/** Fine material detail, generated once per car and mipmapped to avoid distant shimmer. */
export function surfaceTexture(kind: 'carbon' | 'rubber'): THREE.DataTexture {
  const n = 128, data = new Uint8Array(n * n * 4)
  let seed = 6173
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const random = seed / 4294967295
    const weave = (Math.floor(x / 8) + Math.floor(y / 8)) % 2
    const strand = Math.sin((weave ? x : y) * Math.PI / 2)
    const v = kind === 'carbon' ? 140 + strand * 18 + weave * 22 : 190 + random * 18 + Math.sin(x * 0.6) * 5
    const i = (y * n + x) * 4
    data[i] = data[i + 1] = data[i + 2] = Math.round(v); data[i + 3] = 255
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(kind === 'carbon' ? 12 : 3, kind === 'carbon' ? 3 : 1)
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true
  return t
}

/** Local team graphics; no external fonts, textures or network requests. */
export function teamDecal(text: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#edf3f4'; ctx.font = 'italic 800 62px sans-serif'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 256, 68, 490)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4
  return texture
}
