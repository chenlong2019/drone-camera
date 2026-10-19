import { describe, expect, it } from 'vitest'
import { Quaternion, Vector3 } from 'three'
import {
  buildCaptureManifest,
  validateCaptureManifest,
} from '../lib/drone-camera/drone-capture-manifest'
import type { CaptureSession } from '../lib/drone-camera/drone-capture'

function session(): CaptureSession {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    id: 'building-poc-001',
    options: {
      source: 'virtual-camera',
      name: 'building',
      georeference: { longitude: 116.391, latitude: 39.906, altitude: 42 },
      sceneId: 'scene-1',
    },
    status: 'finished',
    createdAt: now,
    updatedAt: now,
    autoCapturing: false,
    images: [
      {
        id: 'img-0001',
        source: 'virtual-camera',
        fileName: 'img-0001.png',
        mimeType: 'image/png',
        sizeBytes: 128,
        capturedAt: now,
        imageUrl: 'data:image/png;base64,AAAA',
        cameraIntrinsics: {
          width: 1920,
          height: 1080,
          fx: 1200,
          fy: 1200,
          cx: 960,
          cy: 540,
          calibrationSource: 'known',
        },
        cameraPose: {
          position: [1, 2, 3],
          rotation: [0, 0, 0, 1],
          coordinateFrame: 'ecef',
        },
        metadata: { engine: 'cesium', sceneId: 'scene-1' },
        validation: { status: 'valid', messages: [] },
      },
    ],
  }
}

describe('capture manifest', () => {
  it('writes the documented schema and an actual ECEF to ENU transform', () => {
    const manifest = buildCaptureManifest(session())

    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.captureId).toBe('building-poc-001')
    expect(manifest.coordinateFrame.world).toBe('Cesium ECEF')
    expect(manifest.coordinateFrame.transform.parametersAvailable).toBe(true)
    expect(manifest.coordinateFrame.transform.matrix).toHaveLength(16)
    expect(manifest.images[0]?.rotationConvention).toContain('[x,y,z,w]')
    expect(manifest.images[0]?.file).toBe('images/img-0001.png')
  })

  it('exports equivalent matrix and TRS transforms with a known ENU basis', () => {
    const input = session()
    input.options.georeference = { longitude: 0, latitude: 0, altitude: 100 }
    const transform = buildCaptureManifest(input).coordinateFrame.transform
    const matrix = transform.matrix as number[]
    const rotation = new Quaternion(...transform.rotation!)
    const translation = new Vector3(...transform.translation!)
    // At lon=0, lat=0, ECEF +Y is east, +Z is north, and +X is up.
    const originX = 6378137 + 100
    for (const [point, expected] of [
      [[originX, 0, 0], [0, 0, 0]],
      [[originX + 3, 1, 2], [1, 2, 3]],
    ] as const) {
      const throughTrs = new Vector3(...point)
        .multiplyScalar(transform.scale!)
        .applyQuaternion(rotation)
        .add(translation)
        .toArray()
      const throughMatrix = [0, 4, 8].map((row) =>
        matrix[row]! * point[0] + matrix[row + 1]! * point[1] + matrix[row + 2]! * point[2] + matrix[row + 3]!,
      )
      expected.forEach((value, axis) => {
        expect(throughTrs[axis]).toBeCloseTo(value, 7)
        expect(throughMatrix[axis]).toBeCloseTo(value, 7)
      })
    }
  })

  it('rejects missing pose and duplicate image content', () => {
    const manifest = buildCaptureManifest(session())
    const duplicate = { ...manifest.images[0]!, id: 'img-0002' }
    manifest.images.push(duplicate)
    manifest.images[1]!.position = undefined
    const report = validateCaptureManifest(manifest)

    expect(report.valid).toBe(false)
    expect(report.errors.some((issue) => issue.code === 'pose')).toBe(true)
    expect(report.errors.some((issue) => issue.code === 'duplicate-content')).toBe(true)
  })
})
