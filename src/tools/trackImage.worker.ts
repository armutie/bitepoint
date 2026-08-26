import { extractTrack, type ExtractionOptions, type RasterImage } from './trackImage'

interface TraceRequest {
  id: number
  image: RasterImage
  options: ExtractionOptions
}

self.addEventListener('message', (event: MessageEvent<TraceRequest>) => {
  const { id, image, options } = event.data
  try {
    const result = extractTrack(image, options)
    self.postMessage({ id, result }, { transfer: [result.mask.buffer, result.skeleton.buffer] })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'The circuit could not be traced.'
    self.postMessage({ id, error: message })
  }
})

export {}
