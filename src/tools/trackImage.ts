import type { TrackData, TrackManifestEntry } from '../core/track'

export interface ImagePoint {
  x: number
  y: number
}

export type MaskMode = 'black-line' | 'coloured' | 'bright' | 'dark-road'

export interface RasterImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface ExtractionOptions {
  mode: MaskMode
  /** Close anti-aliased gaps after the large line components are selected. */
  closeRadius: number
  smoothing: number
}

export interface TrackExtraction {
  width: number
  height: number
  mask: Uint8Array
  skeleton: Uint8Array
  loop: ImagePoint[]
  diagnostics: {
    selectedPixels: number
    skeletonPixels: number
    loopPixels: number
  }
}

export interface TrackBakeOptions {
  id: string
  label: string
  blurb: string
  targetLength: number
  roadWidth: number
  corners: number
  start: ImagePoint
  clockwise: boolean
  sampleSpacing?: number
}

export interface TrackBake {
  track: TrackData
  manifest: TrackManifestEntry
}

const EIGHT_NEIGHBOURS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
] as const

/**
 * Pull the road guide out of a circuit diagram, not the surrounding labels.
 *
 * `coloured` is deliberately opinionated around modern circuit maps: sector
 * ribbons are usually red/yellow/blue or cyan, while marshal/DRS annotations
 * are green and speed-trap callouts magenta. The latter two hue ranges are
 * rejected before connected-component filtering gets involved.
 */
export function imageMask(image: RasterImage, mode: MaskMode): Uint8Array {
  const { width, height, data } = image
  if (data.length !== width * height * 4) throw new Error('Image pixel data is incomplete.')
  const mask = new Uint8Array(width * height)
  for (let i = 0, pixel = 0; i < data.length; i += 4, pixel++) {
    const r = data[i] ?? 0
    const g = data[i + 1] ?? 0
    const b = data[i + 2] ?? 0
    const a = data[i + 3] ?? 0
    if (a < 96) continue
    if (pixelMatches(r, g, b, mode)) mask[pixel] = 1
  }
  return mask
}

export function pixelMatches(r: number, g: number, b: number, mode: MaskMode): boolean {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const value = max / 255
  const saturation = max === 0 ? 0 : (max - min) / max
  if (mode === 'black-line') return value <= 0.22 && saturation <= 0.22
  if (mode === 'dark-road') return value >= 0.045 && value <= 0.28
  const coloured = value >= 0.55 && saturation >= 0.48 && acceptedTrackHue(hue(r, g, b))
  if (mode === 'coloured') return coloured
  return coloured || (value >= 0.72 && saturation <= 0.28)
}

/** Extract the single closed line that becomes Bite Point's centreline. */
export function extractTrack(image: RasterImage, options: ExtractionOptions): TrackExtraction {
  const initial = imageMask(image, options.mode)
  if (options.mode === 'coloured') {
    return extractSegmentedGuideFromMask(initial, image.width, image.height, options)
  }
  return extractLoopFromMask(initial, image.width, image.height, options)
}

/**
 * Trace disconnected coloured sector strokes and interpolate only their gaps.
 * This is the preferred path for labelled circuit maps: the thin coloured
 * guide remains the authority, never either edge of the broad road ribbon.
 */
export function extractSegmentedGuideFromMask(
  initial: Uint8Array,
  width: number,
  height: number,
  options: Pick<ExtractionOptions, 'closeRadius' | 'smoothing'>,
): TrackExtraction {
  if (initial.length !== width * height) throw new Error('Mask dimensions do not match.')
  const components = connectedComponents(initial, width, height).slice(0, 10)
  if (components.length === 0) throw new Error('No coloured track guide was found in this image.')

  const candidates = components.map((component) => {
    const componentMask = new Uint8Array(initial.length)
    for (const index of component) componentMask[index] = 1
    const radius = clampInt(options.closeRadius, 0, 3)
    const closed = radius > 0 ? morphClose(componentMask, width, height, radius) : componentMask
    const skeleton = thinZhangSuen(closed, width, height)
    return { component, path: longestSkeletonPath(skeleton, width, height) }
  })
  candidates.sort((a, b) => b.path.length - a.path.length)
  const longest = candidates[0]?.path.length ?? 0
  const segments = candidates
    .filter((candidate) => candidate.path.length >= Math.max(48, longest * 0.24))
    .slice(0, 6)
  if (segments.length < 2) {
    throw new Error('The coloured guide needs at least two substantial sections to reconstruct a lap.')
  }

  const ordered = orderGuideSegments(segments.map((candidate) => candidate.path))
  const smoothing = clampInt(options.smoothing, 0, 8)
  const loop = smoothClosed(joinGuideSegments(ordered), 3 + smoothing, smoothing === 0 ? 0 : 2)
  const selected = new Uint8Array(initial.length)
  for (const candidate of segments) for (const index of candidate.component) selected[index] = 1
  const skeleton = new Uint8Array(initial.length)
  rasterizeLoop(skeleton, width, height, loop)

  return {
    width,
    height,
    mask: selected,
    skeleton,
    loop,
    diagnostics: {
      selectedPixels: countMask(selected),
      skeletonPixels: countMask(skeleton),
      loopPixels: loop.length,
    },
  }
}

/** Exported separately so the topology can be tested without an image decoder. */
export function extractLoopFromMask(
  initial: Uint8Array,
  width: number,
  height: number,
  options: Pick<ExtractionOptions, 'closeRadius' | 'smoothing'>,
): TrackExtraction {
  if (initial.length !== width * height) throw new Error('Mask dimensions do not match.')
  const components = connectedComponents(initial, width, height)
  if (components.length === 0) throw new Error('No track-like line was found in this image.')

  // A sector is one of the largest marks in a circuit map. Keep components in
  // the same order of magnitude as the largest one, then close their tiny
  // colour-transition gaps. Individual letters and corner-number bubbles fall
  // out here without asking the user to erase the reference first.
  const largest = components[0]!.length
  const minimum = Math.max(20, Math.floor(largest * 0.075))
  const selected = new Uint8Array(initial.length)
  for (const component of components.slice(0, 8)) {
    if (component.length < minimum) break
    for (const index of component) selected[index] = 1
  }

  const radius = clampInt(options.closeRadius, 0, 12)
  const closed = radius > 0 ? morphClose(selected, width, height, radius) : selected
  const joined = largestComponentMask(closed, width, height)
  if (countMask(joined) < 80) {
    throw new Error('The selected line is too short to form a circuit.')
  }

  let skeleton = thinZhangSuen(joined, width, height)
  skeleton = largestComponentMask(skeleton, width, height)
  const openPath = longestSkeletonPath(skeleton, width, height)
  skeleton = bridgeNearbyEndpoints(skeleton, width, height)
  // Labels and corner bubbles can touch a dark road ribbon. Their skeletons
  // become dead-end twigs; peel those away until only closed topology remains.
  skeleton = pruneSkeletonBranches(skeleton, width, height)
  let rawLoop = longestSkeletonCycle(skeleton, width, height)
  if (rawLoop.length < 64 && openPath.length >= 64) {
    const first = openPath[0]!
    const last = openPath[openPath.length - 1]!
    const gap = Math.hypot(last.x - first.x, last.y - first.y)
    if (gap <= Math.max(width, height) * 0.12) {
      const seamReach = Math.min(48, Math.max(12, Math.round(openPath.length * 0.018)))
      rawLoop = straightenClosedSeam(openPath, seamReach)
    }
  }
  if (rawLoop.length < 64) {
    throw new Error('The extracted line is open or branched. Try another mask mode or gap setting.')
  }

  const smoothing = clampInt(options.smoothing, 0, 8)
  const loop = smoothClosed(rawLoop, 2 + smoothing, smoothing === 0 ? 0 : 2)
  return {
    width,
    height,
    mask: joined,
    skeleton,
    loop,
    diagnostics: {
      selectedPixels: countMask(joined),
      skeletonPixels: countMask(skeleton),
      loopPixels: loop.length,
    },
  }
}

/** Scale an extracted image-space loop into the exact JSON the game loads. */
export function bakeTrack(extraction: TrackExtraction, options: TrackBakeOptions): TrackBake {
  const id = options.id.trim().toLowerCase()
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(id)) {
    throw new Error('Track id must use lowercase letters, numbers, and underscores.')
  }
  const label = options.label.trim()
  if (!label) throw new Error('Track name is required.')
  if (!(options.targetLength >= 300 && options.targetLength <= 20_000)) {
    throw new Error('Lap length must be between 300 m and 20 km.')
  }
  if (!(options.roadWidth >= 5 && options.roadWidth <= 30)) {
    throw new Error('Road width must be between 5 m and 30 m.')
  }
  if (!Number.isInteger(options.corners) || options.corners < 1 || options.corners > 60) {
    throw new Error('Corner count must be between 1 and 60.')
  }

  let oriented = extraction.loop.slice()
  if (isClockwise(oriented) !== options.clockwise) oriented.reverse()
  oriented = rotateToNearest(oriented, options.start)

  const spacing = Math.min(Math.max(options.sampleSpacing ?? 4.5, 1.5), 12)
  const samples = Math.min(Math.max(Math.round(options.targetLength / spacing), 96), 5000)
  const resampled = resampleClosed(oriented, samples)
  const pixelLength = perimeter(resampled)
  if (pixelLength < 1) throw new Error('The extracted circuit has no measurable length.')

  const bounds = pointBounds(resampled)
  const centre = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
  const firstScale = options.targetLength / pixelLength
  let centreline: [number, number][] = resampled.map((point) => [
    (point.x - centre.x) * firstScale,
    -(point.y - centre.y) * firstScale,
  ])
  // Resampling rounds the vertex count, so apply one final uniform correction
  // to make the baked perimeter—not merely the source trace—hit the requested
  // lap length exactly.
  const correction = options.targetLength / tuplePerimeter(centreline)
  centreline = centreline.map(([x, y]) => [round6(x * correction), round6(y * correction)])
  const length = tuplePerimeter(centreline)
  const halfRing = new Array<number>(centreline.length).fill(options.roadWidth / 2)
  const blurb = options.blurb.trim() || 'Traced from a circuit reference.'

  const track: TrackData = {
    id,
    label,
    blurb,
    profile: 'image',
    seed: 0,
    width: options.roadWidth,
    length,
    centerline: centreline,
    halfRing,
    brakeMarkers: [],
  }
  const outline = manifestOutline(centreline)
  const manifest: TrackManifestEntry = {
    id,
    label,
    blurb,
    profile: 'image',
    seed: 0,
    length: Math.round(length * 10) / 10,
    corners: options.corners,
    file: `tracks/${id}.json`,
    outline: outline.points,
    outlineAspect: outline.aspect,
  }
  return { track, manifest }
}

export function isClockwise(points: readonly ImagePoint[]): boolean {
  let twiceArea = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    twiceArea += a.x * b.y - b.x * a.y
  }
  // Image y increases downward, so the usual signed-area result is reversed.
  return twiceArea > 0
}

export function perimeter(points: readonly ImagePoint[]): number {
  let length = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    length += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return length
}

function acceptedTrackHue(h: number): boolean {
  return h <= 78 || (h >= 168 && h <= 262) || h >= 338
}

function hue(r: number, g: number, b: number): number {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const delta = max - min
  if (delta === 0) return 0
  let h: number
  if (max === rn) h = 60 * (((gn - bn) / delta) % 6)
  else if (max === gn) h = 60 * ((bn - rn) / delta + 2)
  else h = 60 * ((rn - gn) / delta + 4)
  return h < 0 ? h + 360 : h
}

function connectedComponents(mask: Uint8Array, width: number, height: number): number[][] {
  const seen = new Uint8Array(mask.length)
  const components: number[][] = []
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || seen[seed]) continue
    const component: number[] = []
    const queue = [seed]
    seen[seed] = 1
    for (let q = 0; q < queue.length; q++) {
      const index = queue[q]!
      component.push(index)
      const x = index % width
      const y = Math.floor(index / width)
      for (const [dx, dy] of EIGHT_NEIGHBOURS) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const neighbour = ny * width + nx
        if (!mask[neighbour] || seen[neighbour]) continue
        seen[neighbour] = 1
        queue.push(neighbour)
      }
    }
    components.push(component)
  }
  components.sort((a, b) => b.length - a.length)
  return components
}

function largestComponentMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  const component = connectedComponents(mask, width, height)[0]
  const result = new Uint8Array(mask.length)
  for (const index of component ?? []) result[index] = 1
  return result
}

function morphClose(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  let value: Uint8Array<ArrayBufferLike> = mask.slice()
  for (let i = 0; i < radius; i++) value = dilate(value, width, height)
  for (let i = 0; i < radius; i++) value = erode(value, width, height)
  return value
}

function dilate(mask: Uint8Array, width: number, height: number): Uint8Array {
  const result = mask.slice()
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x
      if (!mask[index]) continue
      for (const [dx, dy] of EIGHT_NEIGHBOURS) result[(y + dy) * width + x + dx] = 1
    }
  }
  return result
}

function erode(mask: Uint8Array, width: number, height: number): Uint8Array {
  const result = new Uint8Array(mask.length)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x
      if (!mask[index]) continue
      let solid = true
      for (const [dx, dy] of EIGHT_NEIGHBOURS) {
        if (!mask[(y + dy) * width + x + dx]) {
          solid = false
          break
        }
      }
      if (solid) result[index] = 1
    }
  }
  return result
}

function thinZhangSuen(mask: Uint8Array, width: number, height: number): Uint8Array {
  const value = mask.slice()
  const remove: number[] = []
  for (let iteration = 0; iteration < 120; iteration++) {
    let changed = false
    for (let phase = 0; phase < 2; phase++) {
      remove.length = 0
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const index = y * width + x
          if (!value[index]) continue
          const p2 = value[index - width]!
          const p3 = value[index - width + 1]!
          const p4 = value[index + 1]!
          const p5 = value[index + width + 1]!
          const p6 = value[index + width]!
          const p7 = value[index + width - 1]!
          const p8 = value[index - 1]!
          const p9 = value[index - width - 1]!
          const neighbours = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
          if (neighbours < 2 || neighbours > 6) continue
          const ring = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
          let transitions = 0
          for (let k = 0; k < 8; k++) if (ring[k] === 0 && ring[k + 1] === 1) transitions++
          if (transitions !== 1) continue
          const first = phase === 0 ? p2 * p4 * p6 : p2 * p4 * p8
          const second = phase === 0 ? p4 * p6 * p8 : p2 * p6 * p8
          if (first === 0 && second === 0) remove.push(index)
        }
      }
      if (remove.length > 0) changed = true
      for (const index of remove) value[index] = 0
    }
    if (!changed) break
  }
  return value
}

function bridgeNearbyEndpoints(mask: Uint8Array, width: number, height: number): Uint8Array {
  const endpoints: number[] = []
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] && skeletonNeighbours(mask, width, height, index).length === 1) endpoints.push(index)
  }
  if (endpoints.length !== 2) return mask
  const [a, b] = endpoints as [number, number]
  const ax = a % width
  const ay = Math.floor(a / width)
  const bx = b % width
  const by = Math.floor(b / width)
  if (Math.hypot(bx - ax, by - ay) > Math.max(width, height) * 0.035) return mask
  const result = mask.slice()
  drawLine(result, width, height, ax, ay, bx, by)
  return result
}

function pruneSkeletonBranches(mask: Uint8Array, width: number, height: number): Uint8Array {
  const value = mask.slice()
  const remove: number[] = []
  for (let iteration = 0; iteration < Math.max(width, height); iteration++) {
    remove.length = 0
    for (let index = 0; index < value.length; index++) {
      if (value[index] && skeletonNeighbours(value, width, height, index).length <= 1) remove.push(index)
    }
    if (remove.length === 0) break
    for (const index of remove) value[index] = 0
  }
  return value
}

function longestSkeletonPath(mask: Uint8Array, width: number, height: number): ImagePoint[] {
  let seed = -1
  for (let index = 0; index < mask.length; index++) {
    if (mask[index]) { seed = index; break }
  }
  if (seed < 0) return []
  const first = farthestSkeletonNode(mask, width, height, seed, false)
  const second = farthestSkeletonNode(mask, width, height, first.node, true)
  const indices: number[] = []
  let current = second.node
  while (current >= 0) {
    indices.push(current)
    if (current === first.node) break
    current = second.parent?.[current] ?? -1
  }
  return indices.map((index) => ({ x: index % width, y: Math.floor(index / width) }))
}

function straightenClosedSeam(points: readonly ImagePoint[], reach: number): ImagePoint[] {
  const value = points.map((point) => ({ ...point }))
  const safeReach = Math.min(Math.max(1, reach), Math.floor((value.length - 2) / 3))
  const firstIndex = value.length - 1 - safeReach
  const a = value[firstIndex]!
  const b = value[safeReach]!
  const count = safeReach * 2 + 2
  for (let offset = 0; offset < count; offset++) {
    const index = (firstIndex + offset) % value.length
    const t = offset / (count - 1)
    value[index] = {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    }
  }
  return value
}

function farthestSkeletonNode(
  mask: Uint8Array,
  width: number,
  height: number,
  start: number,
  keepParent: boolean,
): { node: number; parent?: Int32Array } {
  const distance = new Int32Array(mask.length).fill(-1)
  const parent = keepParent ? new Int32Array(mask.length).fill(-1) : undefined
  const queue = [start]
  distance[start] = 0
  let farthest = start
  for (let q = 0; q < queue.length; q++) {
    const current = queue[q]!
    if (distance[current]! > distance[farthest]!) farthest = current
    for (const neighbour of skeletonNeighbours(mask, width, height, current)) {
      if (distance[neighbour] !== -1) continue
      distance[neighbour] = distance[current]! + 1
      if (parent) parent[neighbour] = current
      queue.push(neighbour)
    }
  }
  return parent ? { node: farthest, parent } : { node: farthest }
}

function orderGuideSegments(segments: readonly ImagePoint[][]): ImagePoint[][] {
  const first = segments[0]!
  const remaining = segments.slice(1)
  let best: ImagePoint[][] = []
  let bestCost = Infinity

  const visit = (ordered: ImagePoint[][], unused: ImagePoint[][], cost: number): void => {
    if (unused.length === 0) {
      const total = cost + guideConnectionCost(ordered[ordered.length - 1]!, ordered[0]!)
      if (total < bestCost) {
        bestCost = total
        best = ordered.map((segment) => segment.slice())
      }
      return
    }
    const previous = ordered[ordered.length - 1]!
    for (let i = 0; i < unused.length; i++) {
      const source = unused[i]!
      const rest = [...unused.slice(0, i), ...unused.slice(i + 1)]
      for (const candidate of [source, source.slice().reverse()]) {
        const nextCost = cost + guideConnectionCost(previous, candidate)
        if (nextCost < bestCost) visit([...ordered, candidate], rest, nextCost)
      }
    }
  }

  visit([first], remaining, 0)
  return best.length > 0 ? best : segments.map((segment) => segment.slice())
}

function guideConnectionCost(a: readonly ImagePoint[], b: readonly ImagePoint[]): number {
  const end = a[a.length - 1]!
  const start = b[0]!
  const gap = unitVector(start.x - end.x, start.y - end.y)
  const out = pathTangent(a, false)
  const into = pathTangent(b, true)
  const distance = Math.hypot(start.x - end.x, start.y - end.y)
  const alignment = dot(out, gap) + dot(gap, into)
  return distance * (2.1 - 0.55 * alignment)
}

function joinGuideSegments(segments: readonly ImagePoint[][]): ImagePoint[] {
  const joined: ImagePoint[] = []
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!
    const next = segments[(i + 1) % segments.length]!
    joined.push(...segment)
    joined.push(...cubicGuideBridge(segment, next))
  }
  return joined
}

function cubicGuideBridge(a: readonly ImagePoint[], b: readonly ImagePoint[]): ImagePoint[] {
  const p0 = a[a.length - 1]!
  const p3 = b[0]!
  const distance = Math.hypot(p3.x - p0.x, p3.y - p0.y)
  const samples = Math.max(2, Math.round(distance))
  const control = Math.min(distance * 0.38, 52)
  const out = pathTangent(a, false)
  const into = pathTangent(b, true)
  const p1 = { x: p0.x + out.x * control, y: p0.y + out.y * control }
  const p2 = { x: p3.x - into.x * control, y: p3.y - into.y * control }
  const bridge: ImagePoint[] = []
  for (let i = 1; i < samples; i++) {
    const t = i / samples
    const u = 1 - t
    bridge.push({
      x: u ** 3 * p0.x + 3 * u ** 2 * t * p1.x + 3 * u * t ** 2 * p2.x + t ** 3 * p3.x,
      y: u ** 3 * p0.y + 3 * u ** 2 * t * p1.y + 3 * u * t ** 2 * p2.y + t ** 3 * p3.y,
    })
  }
  return bridge
}

function pathTangent(points: readonly ImagePoint[], atStart: boolean): ImagePoint {
  const reach = Math.min(14, points.length - 1)
  const a = atStart ? points[0]! : points[points.length - 1 - reach]!
  const b = atStart ? points[reach]! : points[points.length - 1]!
  return unitVector(b.x - a.x, b.y - a.y)
}

function unitVector(x: number, y: number): ImagePoint {
  const length = Math.hypot(x, y) || 1
  return { x: x / length, y: y / length }
}

function dot(a: ImagePoint, b: ImagePoint): number {
  return a.x * b.x + a.y * b.y
}

function rasterizeLoop(mask: Uint8Array, width: number, height: number, points: readonly ImagePoint[]): void {
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    drawLine(mask, width, height, Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y))
  }
}

function longestSkeletonCycle(mask: Uint8Array, width: number, height: number): ImagePoint[] {
  const nodes: number[] = []
  for (let index = 0; index < mask.length; index++) {
    if (mask[index]) nodes.push(index)
  }
  if (nodes.length === 0) return []

  // A circuit with labels attached is not a tidy degree-two ring. Build a
  // breadth-first spanning tree, then inspect every non-tree edge: each closes
  // one fundamental cycle. The longest of those is the main lap; tiny loops in
  // number bubbles and anti-aliased corners lose naturally.
  const parent = new Int32Array(mask.length).fill(-2)
  const queue = [nodes[0]!]
  parent[nodes[0]!] = -1
  for (let q = 0; q < queue.length; q++) {
    const current = queue[q]!
    for (const neighbour of skeletonNeighbours(mask, width, height, current)) {
      if (parent[neighbour] !== -2) continue
      parent[neighbour] = current
      queue.push(neighbour)
    }
  }
  let best: number[] = []
  for (const node of nodes) {
    for (const neighbour of skeletonNeighbours(mask, width, height, node)) {
      if (neighbour <= node) continue
      if (parent[node] === neighbour || parent[neighbour] === node) continue
      const cycle = fundamentalCycle(node, neighbour, parent)
      if (cycle.length > best.length) best = cycle
    }
  }
  return best.map((index) => ({ x: index % width, y: Math.floor(index / width) }))
}

function fundamentalCycle(a: number, b: number, parent: Int32Array): number[] {
  const aPath: number[] = []
  const aPosition = new Map<number, number>()
  let current = a
  while (current >= 0) {
    aPosition.set(current, aPath.length)
    aPath.push(current)
    current = parent[current] ?? -1
  }
  const bPath: number[] = []
  current = b
  while (current >= 0 && !aPosition.has(current)) {
    bPath.push(current)
    current = parent[current] ?? -1
  }
  if (current < 0) return []
  const commonAt = aPosition.get(current)!
  return [...aPath.slice(0, commonAt + 1), ...bPath.reverse()]
}

function skeletonNeighbours(mask: Uint8Array, width: number, height: number, index: number): number[] {
  const x = index % width
  const y = Math.floor(index / width)
  const neighbours: number[] = []
  for (const [dx, dy] of EIGHT_NEIGHBOURS) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
    const candidate = ny * width + nx
    if (mask[candidate]) neighbours.push(candidate)
  }
  return neighbours
}

function drawLine(
  mask: Uint8Array, width: number, height: number,
  x0: number, y0: number, x1: number, y1: number,
): void {
  let dx = Math.abs(x1 - x0)
  let sx = x0 < x1 ? 1 : -1
  let dy = -Math.abs(y1 - y0)
  let sy = y0 < y1 ? 1 : -1
  let error = dx + dy
  while (true) {
    if (x0 >= 0 && y0 >= 0 && x0 < width && y0 < height) mask[y0 * width + x0] = 1
    if (x0 === x1 && y0 === y1) break
    const twice = 2 * error
    if (twice >= dy) { error += dy; x0 += sx }
    if (twice <= dx) { error += dx; y0 += sy }
  }
}

function smoothClosed(points: readonly ImagePoint[], radius: number, passes: number): ImagePoint[] {
  let value = points.map((point) => ({ ...point }))
  if (radius <= 0 || passes <= 0) return value
  for (let pass = 0; pass < passes; pass++) {
    value = value.map((_point, index) => {
      let x = 0
      let y = 0
      let weight = 0
      for (let offset = -radius; offset <= radius; offset++) {
        const sample = value[(index + offset + value.length) % value.length]!
        const w = radius + 1 - Math.abs(offset)
        x += sample.x * w
        y += sample.y * w
        weight += w
      }
      return { x: x / weight, y: y / weight }
    })
  }
  return value
}

function resampleClosed(points: readonly ImagePoint[], count: number): ImagePoint[] {
  const cumulative = [0]
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    cumulative.push(cumulative[cumulative.length - 1]! + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const total = cumulative[cumulative.length - 1]!
  const result: ImagePoint[] = []
  let segment = 0
  for (let i = 0; i < count; i++) {
    const target = total * i / count
    while (segment + 1 < cumulative.length && cumulative[segment + 1]! < target) segment++
    const a = points[segment % points.length]!
    const b = points[(segment + 1) % points.length]!
    const span = cumulative[segment + 1]! - cumulative[segment]!
    const t = span <= 1e-9 ? 0 : (target - cumulative[segment]!) / span
    result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  }
  return result
}

function rotateToNearest(points: readonly ImagePoint[], target: ImagePoint): ImagePoint[] {
  let closest = 0
  let best = Infinity
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!
    const distance = (point.x - target.x) ** 2 + (point.y - target.y) ** 2
    if (distance < best) {
      best = distance
      closest = i
    }
  }
  return [...points.slice(closest), ...points.slice(0, closest)]
}

function pointBounds(points: readonly ImagePoint[]): {
  minX: number; minY: number; maxX: number; maxY: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return { minX, minY, maxX, maxY }
}

function tuplePerimeter(points: readonly [number, number][]): number {
  let length = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    length += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return length
}

function manifestOutline(centerline: readonly [number, number][]): {
  points: [number, number][]
  aspect: [number, number]
} {
  const sampled = resampleClosed(centerline.map(([x, y]) => ({ x, y: -y })), 150)
  const bounds = pointBounds(sampled)
  const width = Math.max(bounds.maxX - bounds.minX, 1e-9)
  const height = Math.max(bounds.maxY - bounds.minY, 1e-9)
  const scale = Math.max(width, height)
  return {
    points: sampled.map((point) => [
      round6((point.x - bounds.minX) / scale),
      round6((point.y - bounds.minY) / scale),
    ]),
    aspect: [round6(width / scale), round6(height / scale)],
  }
}

function countMask(mask: Uint8Array): number {
  let count = 0
  for (const value of mask) count += value
  return count
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max)
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
