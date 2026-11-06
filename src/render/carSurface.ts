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

/** Small, mipmapped surface maps: the weave is structure, paint only has a fine finish. */
export function surfaceTexture(kind: 'carbon' | 'rubber' | 'paint' | 'fabric'): THREE.DataTexture {
  const n = 128, data = new Uint8Array(n * n * 4)
  let seed = 6173
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const random = seed / 4294967295
    // Two-over / two-under twill with rounded fibre bundles, not a checkerboard.
    const warp = ((Math.floor(x / 8) - Math.floor(y / 8) + 16) % 4) < 2
    const cross = (warp ? x : y) % 8
    const bundle = Math.sin((cross + 0.5) / 8 * Math.PI)
    const fibre = Math.cos((warp ? y : x) * Math.PI) * 2
    const v = kind === 'carbon' ? 113 + bundle * 48 + (warp ? 9 : -9) + fibre
      : kind === 'rubber' ? 190 + random * 18 + Math.sin(x * 0.6) * 5
      : kind === 'fabric' ? 155 + bundle * 23 + fibre * 3
      : 205 + random * 12 + Math.sin(x * 0.22) * Math.cos(y * 0.17) * 3
    const i = (y * n + x) * 4
    data[i] = data[i + 1] = data[i + 2] = Math.round(v); data[i + 3] = 255
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(kind === 'carbon' ? 18 : kind === 'paint' ? 12 : 3, kind === 'carbon' ? 3 : kind === 'paint' ? 6 : 1)
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true
  return t
}

export type PaintPanel = 'nose' | 'shoulder' | 'sidepod' | 'engine'

/** Reference livery: white upper panels with double red borders, red flanks,
 * dark lower returns. Decals and assembly detail are baked, with no overlay meshes.
 */
export function cockpitLivery(kind: PaintPanel, body: number, accent: number): THREE.DataTexture {
  const w = 512, h = 512, data = new Uint8Array(w * h * 4)
  const red = new THREE.Color(body).convertLinearToSRGB()
  const white = new THREE.Color(accent).convertLinearToSRGB()
  const redRGB = [red.r, red.g, red.b], whiteRGB = [white.r, white.g, white.b]
  const black = [0.065, 0.073, 0.083]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / (w - 1), v = y / (h - 1)
    const top = v < 0.5 ? v : 1 - v
    const border = kind === 'nose' ? 0.113 + 0.012 * Math.sin(u * Math.PI)
      : 0.12 + 0.022 * Math.sin(u * Math.PI)
    let c = redRGB
    let pin = 0
    if (kind === 'nose') {
      c = u < 0.16 ? whiteRGB : redRGB
    } else if (kind === 'shoulder') {
      if (top > border && top < 0.45) c = whiteRGB
      // The narrow red double line sits just inside the white panel.
      pin = Math.max(0, 1 - Math.abs(top - border - 0.012) * h)
      if (kind === 'shoulder' && v > 0.46 && v < 0.54) c = black
    } else if (kind === 'engine') {
      if (v < 0.52 && u > 0.25 + 0.075 * Math.sin(top * Math.PI * 2)) c = whiteRGB
      if (v > 0.62) c = black
      pin = u > 0.32 && u < 0.33 && v < 0.52 ? 1 : 0
    } else if (v > 0.51 && v < 0.995) c = black
    const seam = Math.exp(-(((u - 0.24) / 0.0018) ** 2)) * 0.13
    const finish = 1 - seam - 0.04 * Math.exp(-(((top - 0.49) / 0.035) ** 2))
      + Math.sin(u * 25 + v * 13) * 0.005
    const i = (y * w + x) * 4
    for (let k = 0; k < 3; k++) data[i + k] = Math.round((c[k]! + (redRGB[k]! - c[k]!) * pin) * finish * 255)
    data[i + 3] = 255
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h
    const c = canvas.getContext('2d')
    if (c) {
      c.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0)
      const text = (word: string, x: number, y: number, size: number, colour: string, italic = false) => {
        c.fillStyle = colour; c.font = `${italic ? 'italic ' : ''}700 ${size}px Arial, sans-serif`
        c.textAlign = 'center'; c.textBaseline = 'middle'
        c.save(); c.translate(x * w, y * h)
        if (kind === 'sidepod') c.scale(-1, -1)
        if (kind === 'engine') c.scale(-1, y < 0.25 ? -1 : 1)
        c.fillText(word, 0, 0); c.restore()
      }
      const hp = (x: number, y: number, radius: number) => {
        c.save(); c.translate(x * w, y * h); c.scale(radius * (kind === 'engine' ? -1 : 1), radius * (kind === 'engine' && y < 0.25 ? -1.3 : 1.3))
        c.fillStyle = '#0870bf'; c.beginPath(); c.arc(0, 0, 1, 0, Math.PI * 2); c.fill()
        c.fillStyle = '#f0f0eb'; c.font = 'italic 700 1.7px Arial, sans-serif'
        c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('hp', -0.06, 0.02)
        c.restore()
      }
      const shell = (x: number, y: number, size: number) => {
        c.save(); c.translate(x * w, y * h); c.scale(-size, -size * 1.7)
        c.fillStyle = '#f2ca30'; c.strokeStyle = '#b82027'; c.lineWidth = 0.09
        c.beginPath(); c.moveTo(-0.45, 0.42); c.lineTo(-0.88, -0.02)
        c.bezierCurveTo(-1.02, -1.13, 1.02, -1.13, 0.88, -0.02)
        c.lineTo(0.45, 0.42); c.closePath(); c.fill(); c.stroke()
        for (const x of [-0.62, -0.32, 0, 0.32, 0.62]) {
          c.beginPath(); c.moveTo(0, 0.29); c.lineTo(x, -0.57 + Math.abs(x) * 0.28); c.stroke()
        }
        c.restore()
      }
      if (kind === 'nose') {
        hp(0.53, 0.25, 24)
        text('44', 0.79, 0.25, 33, '#efefea', true)
      } else if (kind === 'shoulder') {
        text('CEVA', 0.53, 0.25, 20, '#25292c')
        text('LOGISTICS', 0.53, 0.277, 6, '#535558')
        text('UniCredit', 0.12, 0.25, 15, '#25292c')
        for (const u of [0.26, 0.91]) for (const v of [0.32, 0.415]) {
          const x = u * w, y = v * h
          c.fillStyle = '#626669'; c.beginPath(); c.arc(x, y, 2.2, 0, Math.PI * 2); c.fill()
          c.strokeStyle = '#b5b8b6'; c.lineWidth = 0.8
          c.beginPath(); c.moveTo(x - 1.1, y + 0.6); c.lineTo(x + 1.1, y - 0.6); c.stroke()
        }
      } else if (kind === 'sidepod') {
        shell(0.54, 0.07, 27)
        text('CEVA', 0.31, 0.07, 22, '#efeeea')
        text('LOGISTICS', 0.31, 0.10, 6, '#efeeea')
      } else {
        for (const v of [0.075, 0.425]) {
          hp(0.62, v, 29)
          text('44', 0.14, v, 39, '#e6e5df', true)
          text('IBM', 0.85, v + 0.03, 18, '#303338')
        }
      }
      data.set(c.getImageData(0, 0, w, h).data)
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat)
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true
  return t
}

/** Four panels share one material and one 1024px atlas. */
export function cockpitPaintAtlas(body: number, accent: number): THREE.DataTexture {
  const n = 512, data = new Uint8Array(n * n * 16)
  const panels: PaintPanel[] = ['nose', 'shoulder', 'sidepod', 'engine']
  panels.forEach((kind, slot) => {
    const panel = cockpitLivery(kind, body, accent), pixels = panel.image.data as Uint8Array
    const ox = slot % 2 * n, oy = Math.floor(slot / 2) * n
    for (let y = 0; y < n; y++) data.set(pixels.subarray(y * n * 4, (y + 1) * n * 4), ((oy + y) * n * 2 + ox) * 4)
    panel.dispose()
  })
  const t = new THREE.DataTexture(data, n * 2, n * 2, THREE.RGBAFormat)
  t.colorSpace = THREE.SRGBColorSpace
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true
  return t
}

/** Pack a shell into its atlas tile; mirror the opposite flank without mirroring text.
 * The half-turn is periodic, so wrap before packing to avoid sampling another tile.
 */
export function paintPanelUV(g: THREE.BufferGeometry, panel: PaintPanel, mirrored = false): THREE.BufferGeometry {
  const slot = { nose: 0, shoulder: 1, sidepod: 2, engine: 3 }[panel]
  const uv = g.getAttribute('uv')
  for (let i = 0; i < uv.count; i++) {
    const v = mirrored ? ((0.5 - uv.getY(i)) % 1 + 1) % 1 : uv.getY(i)
    // Half-texel inset keeps mip/linear filtering from bleeding across panels.
    uv.setXY(i, (slot % 2 + 0.001 + uv.getX(i) / 3 * 0.998) / 2,
      (Math.floor(slot / 2) + 0.001 + v * 0.998) / 2)
  }
  return g
}

/** Local team graphics; no external fonts, textures or network requests. */
export function teamDecal(text: string, second?: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = second ? 256 : 128
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#dedfdb'; ctx.font = '600 49px Arial, sans-serif'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 256, 68, 470)
  if(second) ctx.fillText(second, 256, 196, 470)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4
  return texture
}
