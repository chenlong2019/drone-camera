import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  analyzeImagePixels,
  inspectCaptureImages,
} from '../components/use-photogrammetry-validation/image-validation'
import type { CapturedImage } from '../lib/drone-camera/drone-capture'

function capture(overrides: Partial<CapturedImage> = {}): CapturedImage {
  return {
    id: 'image-1',
    source: 'virtual-camera',
    fileName: 'image-1.png',
    mimeType: 'image/png',
    sizeBytes: 1,
    capturedAt: '2026-10-19T00:00:00Z',
    metadata: {},
    validation: { status: 'valid', messages: [] },
    ...overrides,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('decoded image pixel quality', () => {
  it.each([0, 255])('identifies a blank image with luma %s', (value) => {
    const result = analyzeImagePixels(new Uint8ClampedArray([
      value, value, value, 255, value, value, value, 255,
    ]))
    expect(result.blank).toBe(true)
    expect(result.uniform).toBe(true)
    expect(result.meanLuma).toBeCloseTo(value)
    expect(result.variance).toBe(0)
    expect(result.validPixelRatio).toBe(1)
  })

  it('identifies uniform gray without labelling it black or white', () => {
    const result = analyzeImagePixels(new Uint8ClampedArray([128, 128, 128, 255]))
    expect(result.uniform).toBe(true)
    expect(result.blank).toBe(false)
  })

  it('flags fully transparent content even when hidden RGB pixels vary', () => {
    const result = analyzeImagePixels(new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 0]))
    expect(result.blank).toBe(true)
    expect(result.transparentPixelRatio).toBe(1)
    expect(result.validPixelRatio).toBe(0)
    expect(result.meanLuma).toBeUndefined()
  })

  it('reports transparent regions and excludes them from luma statistics', () => {
    const result = analyzeImagePixels(new Uint8ClampedArray([
      0, 0, 0, 0, 0, 0, 0, 120, 64, 64, 64, 255, 192, 192, 192, 255,
    ]))
    expect(result.validPixelRatio).toBe(0.5)
    expect(result.transparentPixelRatio).toBe(0.5)
    expect(result.meanLuma).toBeCloseTo(128)
    expect(result.variance).toBeCloseTo(4096)
    expect(result.uniform).toBe(false)
    expect(result.blank).toBe(false)
  })

  it('rejects incomplete or empty RGBA samples', () => {
    expect(() => analyzeImagePixels(new Uint8ClampedArray())).toThrow(RangeError)
    expect(() => analyzeImagePixels(new Uint8ClampedArray([1, 2, 3]))).toThrow(RangeError)
  })
})

describe('capture image decoding', () => {
  it('reports absent and invalid files as decode failures', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('Invalid PNG')))
    const results = await inspectCaptureImages([
      capture(),
      capture({ id: 'broken', localBlob: new Blob(['invalid image']) }),
    ])
    expect(results['image-1']?.decodable).toBe(false)
    expect(results.broken).toEqual({ decodable: false, error: 'Invalid PNG' })
  })

  it('rejects a cancelled inspection instead of reporting a decode failure', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(inspectCaptureImages([capture()], controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('releases a bitmap if cancellation arrives during decoding', async () => {
    const controller = new AbortController()
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn().mockImplementation(async () => {
      controller.abort()
      return { width: 10, height: 10, close }
    }))
    await expect(inspectCaptureImages([
      capture({ localBlob: new Blob(['pixels']) }),
    ], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(close).toHaveBeenCalledOnce()
  })
})
