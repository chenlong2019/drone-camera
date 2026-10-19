import { describe, expect, it } from 'vitest'
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
