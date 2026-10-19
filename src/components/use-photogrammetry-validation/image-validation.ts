import type { CapturedImage } from '../../lib/drone-camera/drone-capture'
import type { CaptureImageQuality } from '../../lib/drone-camera/drone-capture-manifest'

export interface PixelQualityStatistics extends CaptureImageQuality {
  sampleCount: number
  /** Fraction of sampled pixels with alpha >= 250 (0..1). */
  validPixelRatio: number
  /** Fraction with alpha < 250, including partially transparent pixels. */
  transparentPixelRatio: number
}

export interface InspectedImageQuality extends CaptureImageQuality {
  width?: number
  height?: number
  sampleWidth?: number
  sampleHeight?: number
  sampleCount?: number
  validPixelRatio?: number
  transparentPixelRatio?: number
  error?: string
}

/** Luma is measured in 0..255; transparent pixels do not contribute to it. */
export function analyzeImagePixels(rgba: Uint8ClampedArray): PixelQualityStatistics {
  if (rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new RangeError('Expected a non-empty RGBA pixel buffer')
  }
  const sampleCount = rgba.length / 4
  let validCount = 0
  let mean = 0
  let squaredDifference = 0
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (rgba[offset + 3]! < 250) continue
    const luma = 0.2126 * rgba[offset]! + 0.7152 * rgba[offset + 1]! + 0.0722 * rgba[offset + 2]!
    validCount += 1
    const delta = luma - mean
    mean += delta / validCount
    squaredDifference += delta * (luma - mean)
  }
  const validPixelRatio = validCount / sampleCount
  const ratios = { sampleCount, validPixelRatio, transparentPixelRatio: 1 - validPixelRatio }
  if (validCount === 0) return { ...ratios, blank: true, uniform: true }
  const variance = Math.max(0, squaredDifference / validCount)
  const uniform = variance <= 1
  return {
    ...ratios,
    meanLuma: mean,
    variance,
    uniform,
    blank: uniform && (mean <= 1 || mean >= 254),
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Image inspection was cancelled', 'AbortError')
}

async function loadImageElement(blob: Blob, signal?: AbortSignal): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(blob)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      const cleanup = () => {
        image.onload = null
        image.onerror = null
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        cleanup()
        image.src = ''
        reject(new DOMException('Image inspection was cancelled', 'AbortError'))
      }
      image.onload = () => {
        cleanup()
        resolve(image)
      }
      image.onerror = () => {
        cleanup()
        reject(new Error('Image could not be decoded'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      else image.src = objectUrl
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function inspectImage(
  image: CapturedImage,
  signal?: AbortSignal,
): Promise<InspectedImageQuality> {
  let bitmap: ImageBitmap | undefined
  try {
    throwIfAborted(signal)
    let blob = image.localBlob
    if (!blob) {
      if (!image.imageUrl) throw new Error('Image has no local file or URL')
      const response = await fetch(image.imageUrl, { signal })
      if (!response.ok) throw new Error(`Image request failed: HTTP ${response.status}`)
      blob = await response.blob()
    }
    throwIfAborted(signal)
    if (blob.size === 0) throw new Error('Image file is empty')
    let source: ImageBitmap | HTMLImageElement
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(blob)
      source = bitmap
    } else {
      source = await loadImageElement(blob, signal)
    }
    throwIfAborted(signal)
    const width = source instanceof HTMLImageElement ? source.naturalWidth : source.width
    const height = source instanceof HTMLImageElement ? source.naturalHeight : source.height
    if (width <= 0 || height <= 0) throw new Error('Decoded image has no pixels')
    const scale = Math.min(1, 256 / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas pixel inspection is unavailable')
    // Nearest-neighbour samples preserve alpha and texture variance in the source.
    context.imageSmoothingEnabled = false
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    return {
      ...analyzeImagePixels(pixels.data),
      decodable: true,
      width,
      height,
      sampleWidth: canvas.width,
      sampleHeight: canvas.height,
    }
  } catch (error) {
    throwIfAborted(signal)
    return { decodable: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    bitmap?.close()
  }
}

/** Decode real capture files and sample their pixels, keyed by capture image id. */
export async function inspectCaptureImages(
  images: CapturedImage[],
  signal?: AbortSignal,
): Promise<Record<string, InspectedImageQuality>> {
  throwIfAborted(signal)
  const quality: Record<string, InspectedImageQuality> = Object.create(null)
  // Process sequentially to avoid retaining a decoded full-resolution batch in memory.
  for (const image of images) {
    quality[image.id] = await inspectImage(image, signal)
  }
  return quality
}
