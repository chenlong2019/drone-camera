import { describe, expect, it } from 'vitest'
import type { CapturedImage } from '../lib/drone-camera/drone-capture'
import { createOriginalImagesZip } from '../lib/drone-camera/drone-image-utils'

function image(fileName: string, bytes: string): CapturedImage {
  return {
    id: fileName,
    source: 'real-camera',
    fileName,
    mimeType: 'image/jpeg',
    sizeBytes: bytes.length,
    capturedAt: new Date(0).toISOString(),
    localBlob: new Blob([bytes], { type: 'image/jpeg' }),
    metadata: {},
    validation: { status: 'valid', messages: [] },
  }
}

describe('original image ZIP export', () => {
  it('includes original bytes, sanitizes paths, and preserves unique file names', async () => {
    const archive = await createOriginalImagesZip([
      image('../same.jpg', 'first-image'),
      image('same.jpg', 'second-image'),
    ])
    const bytes = new Uint8Array(await archive.arrayBuffer())
    const view = new DataView(bytes.buffer)

    expect(archive.type).toBe('application/zip')
    expect(view.getUint32(0, true)).toBe(0x04034b50)

    const firstNameLength = view.getUint16(26, true)
    const firstSize = view.getUint32(22, true)
    const firstName = new TextDecoder().decode(bytes.slice(30, 30 + firstNameLength))
    const firstDataStart = 30 + firstNameLength
    const firstData = new TextDecoder().decode(bytes.slice(firstDataStart, firstDataStart + firstSize))

    const secondHeader = firstDataStart + firstSize
    expect(view.getUint32(secondHeader, true)).toBe(0x04034b50)
    const secondNameLength = view.getUint16(secondHeader + 26, true)
    const secondSize = view.getUint32(secondHeader + 22, true)
    const secondName = new TextDecoder().decode(
      bytes.slice(secondHeader + 30, secondHeader + 30 + secondNameLength),
    )
    const secondDataStart = secondHeader + 30 + secondNameLength
    const secondData = new TextDecoder().decode(bytes.slice(secondDataStart, secondDataStart + secondSize))

    expect(firstName).toBe('_same.jpg')
    expect(firstData).toBe('first-image')
    expect(secondName).toBe('same.jpg')
    expect(secondData).toBe('second-image')
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50)
  })

  it('rejects a session image with no original data', async () => {
    const missing = image('missing.jpg', '')
    missing.localBlob = undefined

    await expect(createOriginalImagesZip([missing])).rejects.toThrow('图片缺少原始数据')
  })
})
