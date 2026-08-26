import './trackImporter.css'
import {
  bakeTrack,
  type ImagePoint,
  type MaskMode,
  type RasterImage,
  type TrackBake,
  type TrackExtraction,
} from './trackImage'

const MAX_IMAGE_EDGE = 1100

const canvas = required<HTMLCanvasElement>('preview')
const context = canvasContext(canvas)

const fileInput = required<HTMLInputElement>('image-file')
const dropZone = required<HTMLElement>('drop-zone')
const emptyState = required<HTMLElement>('empty-state')
const busy = required<HTMLElement>('busy')
const replaceButton = required<HTMLButtonElement>('replace-image')
const traceButton = required<HTMLButtonElement>('trace-button')
const downloadButton = required<HTMLButtonElement>('download')
const manifestButton = required<HTMLButtonElement>('copy-manifest')
const readout = required<HTMLElement>('readout')
const errorBox = required<HTMLElement>('error')
const stageHelp = required<HTMLElement>('stage-help')
const modeInput = required<HTMLSelectElement>('mask-mode')
const gapInput = required<HTMLInputElement>('gap-radius')
const smoothingInput = required<HTMLInputElement>('smoothing')
const lengthInput = required<HTMLInputElement>('track-length')
const widthInput = required<HTMLInputElement>('road-width')
const cornersInput = required<HTMLInputElement>('corner-count')
const nameInput = required<HTMLInputElement>('track-name')
const idInput = required<HTMLInputElement>('track-id')
const blurbInput = required<HTMLTextAreaElement>('track-blurb')
const gapOutput = required<HTMLOutputElement>('gap-output')
const smoothOutput = required<HTMLOutputElement>('smooth-output')

let sourceCanvas: HTMLCanvasElement | null = null
let raster: RasterImage | null = null
let extraction: TrackExtraction | null = null
let start: ImagePoint | null = null
let clockwise = true
let baked: TrackBake | null = null
let requestId = 0

const worker = new Worker(new URL('./trackImage.worker.ts', import.meta.url), { type: 'module' })
worker.addEventListener('message', (event: MessageEvent<{
  id: number
  result?: TrackExtraction
  error?: string
}>) => {
  if (event.data.id !== requestId) return
  setBusy(false)
  if (event.data.error || !event.data.result) {
    extraction = null
    showError(event.data.error ?? 'The circuit could not be traced.')
    render()
    updateBake()
    return
  }
  extraction = event.data.result
  start = topmost(extraction.loop)
  hideError()
  readout.hidden = false
  stageHelp.textContent = 'Trace found. Click the circuit to place start / finish; check the route before exporting.'
  render()
  updateBake()
})

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file) void loadImage(file)
})
replaceButton.addEventListener('click', () => fileInput.click())
traceButton.addEventListener('click', trace)
downloadButton.addEventListener('click', downloadTrack)
manifestButton.addEventListener('click', () => void copyManifest())

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault()
    dropZone.classList.add('dragging')
  })
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault()
    dropZone.classList.remove('dragging')
  })
}
dropZone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files[0]
  if (file?.type.startsWith('image/')) void loadImage(file)
})

gapInput.addEventListener('input', () => { gapOutput.value = `${gapInput.value} px` })
smoothingInput.addEventListener('input', () => { smoothOutput.value = smoothingInput.value })
for (const input of [lengthInput, widthInput, cornersInput, nameInput, idInput, blurbInput]) {
  input.addEventListener('input', updateBake)
}
nameInput.addEventListener('input', () => {
  if (!idInput.dataset.edited) idInput.value = slugify(nameInput.value)
})
idInput.addEventListener('input', () => { idInput.dataset.edited = 'true' })

for (const button of document.querySelectorAll<HTMLButtonElement>('.direction')) {
  button.addEventListener('click', () => {
    clockwise = button.dataset.direction === 'clockwise'
    for (const sibling of document.querySelectorAll('.direction')) sibling.classList.toggle('active', sibling === button)
    render()
    updateBake()
  })
}

canvas.addEventListener('click', (event) => {
  if (!extraction) return
  const rect = canvas.getBoundingClientRect()
  const click = {
    x: (event.clientX - rect.left) * canvas.width / rect.width,
    y: (event.clientY - rect.top) * canvas.height / rect.height,
  }
  start = nearest(extraction.loop, click)
  render()
  updateBake()
})

async function loadImage(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) {
    showError('Choose a PNG, JPG, or WebP circuit map.')
    return
  }
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const working = document.createElement('canvas')
    working.width = width
    working.height = height
    const workingContext = working.getContext('2d', { willReadFrequently: true })
    if (!workingContext) throw new Error('Image canvas is unavailable.')
    workingContext.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const pixels = workingContext.getImageData(0, 0, width, height)
    sourceCanvas = working
    raster = { width, height, data: pixels.data }
    canvas.width = width
    canvas.height = height
    extraction = null
    start = null
    baked = null
    emptyState.hidden = true
    replaceButton.disabled = false
    traceButton.disabled = false
    readout.hidden = true
    hideError()
    render()
    trace()
  } catch (cause) {
    showError(cause instanceof Error ? cause.message : 'This image could not be opened.')
  }
}

function trace(): void {
  if (!raster) return
  setBusy(true)
  hideError()
  extraction = null
  baked = null
  render()
  updateButtons()
  const id = ++requestId
  // Give the worker its own pixel buffer so re-tracing remains possible.
  const image: RasterImage = {
    width: raster.width,
    height: raster.height,
    data: raster.data.slice(),
  }
  worker.postMessage({
    id,
    image,
    options: {
      mode: modeInput.value as MaskMode,
      closeRadius: Number(gapInput.value),
      smoothing: Number(smoothingInput.value),
    },
  }, [image.data.buffer])
}

function updateBake(): void {
  baked = null
  if (!extraction || !start) {
    updateButtons()
    return
  }
  try {
    baked = bakeTrack(extraction, {
      id: idInput.value,
      label: nameInput.value,
      blurb: blurbInput.value,
      targetLength: Number(lengthInput.value),
      roadWidth: Number(widthInput.value),
      corners: Number(cornersInput.value),
      start,
      clockwise,
    })
    hideError()
    required<HTMLElement>('trace-points').textContent = extraction.loop.length.toLocaleString()
    required<HTMLElement>('output-points').textContent = baked.track.centerline.length.toLocaleString()
    required<HTMLElement>('scale-readout').textContent = `${Math.round(baked.track.length).toLocaleString()} m`
    required<HTMLElement>('direction-readout').textContent = clockwise ? 'CW' : 'CCW'
  } catch (cause) {
    showError(cause instanceof Error ? cause.message : 'Track settings are incomplete.')
  }
  updateButtons()
}

function render(): void {
  context.clearRect(0, 0, canvas.width, canvas.height)
  if (!sourceCanvas) return
  context.globalAlpha = extraction ? 0.48 : 0.82
  context.drawImage(sourceCanvas, 0, 0)
  context.globalAlpha = 1
  if (!extraction) return

  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.shadowColor = 'rgba(0, 0, 0, 0.8)'
  context.shadowBlur = 9
  context.strokeStyle = '#f4f7f8'
  context.lineWidth = Math.max(2.2, canvas.width / 460)
  drawLoop(extraction.loop)
  context.shadowBlur = 0
  context.strokeStyle = '#f5a623'
  context.lineWidth = Math.max(1.1, canvas.width / 950)
  drawLoop(extraction.loop)
  context.restore()
  if (start) drawStart(start)
}

function drawLoop(points: readonly ImagePoint[]): void {
  if (points.length === 0) return
  context.beginPath()
  context.moveTo(points[0]!.x, points[0]!.y)
  for (let i = 1; i < points.length; i++) context.lineTo(points[i]!.x, points[i]!.y)
  context.closePath()
  context.stroke()
}

function drawStart(point: ImagePoint): void {
  if (!extraction) return
  const index = extraction.loop.indexOf(point)
  const step = clockwise ? 12 : -12
  const ahead = extraction.loop[(index + step + extraction.loop.length) % extraction.loop.length]!
  const angle = Math.atan2(ahead.y - point.y, ahead.x - point.x)
  const size = Math.max(8, canvas.width / 95)
  context.save()
  context.translate(point.x, point.y)
  context.rotate(angle)
  context.fillStyle = '#f5a623'
  context.strokeStyle = '#0b0d0f'
  context.lineWidth = Math.max(2, canvas.width / 700)
  context.beginPath()
  context.moveTo(size, 0)
  context.lineTo(-size * 0.65, size * 0.62)
  context.lineTo(-size * 0.3, 0)
  context.lineTo(-size * 0.65, -size * 0.62)
  context.closePath()
  context.fill()
  context.stroke()
  context.restore()
}

function setBusy(value: boolean): void {
  busy.hidden = !value
  dropZone.classList.toggle('is-busy', value)
  traceButton.disabled = value || !raster
}

function updateButtons(): void {
  downloadButton.disabled = !baked
  manifestButton.disabled = !baked
}

function downloadTrack(): void {
  if (!baked) return
  const blob = new Blob([`${JSON.stringify(baked.track, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${baked.track.id}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

async function copyManifest(): Promise<void> {
  if (!baked) return
  try {
    await navigator.clipboard.writeText(JSON.stringify(baked.manifest, null, 2))
    manifestButton.textContent = 'Manifest copied'
    window.setTimeout(() => { manifestButton.textContent = 'Copy manifest entry' }, 1600)
  } catch {
    showError('Clipboard access was blocked. Download the track JSON and try again.')
  }
}

function showError(message: string): void {
  errorBox.textContent = message
  errorBox.hidden = false
}

function hideError(): void {
  errorBox.hidden = true
  errorBox.textContent = ''
}

function topmost(points: readonly ImagePoint[]): ImagePoint {
  return points.reduce((best, point) => point.y < best.y ? point : best, points[0]!)
}

function nearest(points: readonly ImagePoint[], target: ImagePoint): ImagePoint {
  return points.reduce((best, point) => {
    const bestDistance = (best.x - target.x) ** 2 + (best.y - target.y) ** 2
    const distance = (point.x - target.x) ** 2 + (point.y - target.y) ** 2
    return distance < bestDistance ? point : best
  }, points[0]!)
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}`)
  return element as T
}

function canvasContext(element: HTMLCanvasElement): CanvasRenderingContext2D {
  const value = element.getContext('2d')
  if (!value) throw new Error('Canvas is unavailable.')
  return value
}
