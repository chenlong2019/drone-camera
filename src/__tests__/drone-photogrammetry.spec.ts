import { describe, expect, it } from 'vitest'
import {
  createEcefEnuFrame,
  ecefQuaternionToEnu,
  ecefToGeodetic,
  ecefToEnu,
  enuQuaternionToEcef,
  enuToEcef,
  geodeticToEcef,
  validateTileset,
  createReconstructionTask,
  cameraPoseToColmap,
} from '../lib/drone-camera/drone-photogrammetry'

describe('photogrammetry coordinate helpers', () => {
  it('round-trips WGS84 geodetic coordinates through ECEF', () => {
    const input = { longitude: 116.391, latitude: 39.906, altitude: 42.5 }
    const output = ecefToGeodetic(geodeticToEcef(input))
    expect(output.longitude).toBeCloseTo(input.longitude, 9)
    expect(output.latitude).toBeCloseTo(input.latitude, 9)
    expect(output.altitude).toBeCloseTo(input.altitude, 5)
  })

  it('round-trips local ENU offsets around an origin', () => {
    const frame = createEcefEnuFrame({ longitude: 116.391, latitude: 39.906, altitude: 10 })
    const local: [number, number, number] = [12.5, -4.25, 8]
    const result = ecefToEnu(enuToEcef(local, frame), frame)
    expect(result[0]).toBeCloseTo(local[0], 8)
    expect(result[1]).toBeCloseTo(local[1], 8)
    expect(result[2]).toBeCloseTo(local[2], 8)
  })

  it('round-trips ENU and ECEF orientation quaternions', () => {
    const frame = createEcefEnuFrame({ longitude: 10, latitude: 50 })
    const rotation: [number, number, number, number] = [0.1, -0.2, 0.3, 0.9]
    const ecef = enuQuaternionToEcef(rotation, frame)
    const output = ecefQuaternionToEnu(ecef, frame)
    const normalized = Math.hypot(...rotation)
    expect(output[0]).toBeCloseTo(rotation[0] / normalized, 8)
    expect(output[1]).toBeCloseTo(rotation[1] / normalized, 8)
    expect(output[2]).toBeCloseTo(rotation[2] / normalized, 8)
    expect(output[3]).toBeCloseTo(rotation[3] / normalized, 8)
  })

  it('converts an ECEF capture pose to an explicit local COLMAP pose', () => {
    const frame = createEcefEnuFrame({ longitude: 116.391, latitude: 39.906, altitude: 42 })
    const origin = frame.ecefOrigin
    const result = cameraPoseToColmap(
      { position: origin, rotation: [0, 0, 0, 1], coordinateFrame: 'ecef' },
      { enuFrame: frame },
    )
    expect(result.position).toEqual([0, 0, 0])
    expect(result.coordinateFrame).toBe('local-enu')
    expect(result.rotationConvention).toContain('COLMAP')
  })
})

describe('3D Tiles and reconstruction helpers', () => {
  it('validates a minimal 3D Tiles 1.1 tree', () => {
    const result = validateTileset({
      asset: { version: '1.1' },
      geometricError: 10,
      root: {
        geometricError: 0,
        boundingVolume: { sphere: [0, 0, 0, 1] },
        content: { uri: 'content/root.glb' },
      },
    })
    expect(result.valid).toBe(true)
    expect(result.stats.nodes).toBe(1)
    expect(result.stats.contentUris).toBe(1)
  })

  it('reports malformed tilesets and creates deterministic task paths', () => {
    const result = validateTileset({ asset: { version: '2.0' }, root: {} })
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)

    const task = createReconstructionTask('/data', 'building-001', { createdAt: '2026-01-01T00:00:00.000Z' })
    expect(task.paths.imagesDir).toBe('/data/captures/building-001/images')
    expect(task.paths.tilesetPath).toBe('/data/outputs/building-001/tileset.json')
  })
})
