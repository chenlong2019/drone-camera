import { describe, expect, it } from 'vitest'
import { Quaternion as ThreeQuaternion, Vector3 as ThreeVector3 } from 'three'
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

  it.each([1, -1])('uses the WGS84 polar radius at pole %s', (hemisphere) => {
    const result = ecefToGeodetic([0, 0, hemisphere * (6356752.314245179 + 87)])
    expect(result.longitude).toBe(0)
    expect(result.latitude).toBe(hemisphere * 90)
    expect(result.altitude).toBeCloseTo(87, 6)
  })

  it('rejects the geocentre because geodetic latitude and height are undefined', () => {
    expect(() => ecefToGeodetic([0, 0, 0])).toThrow(/no defined geodetic coordinate/)
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

  it('exports COLMAP world-to-camera translation and a forward-facing projection', () => {
    const result = cameraPoseToColmap({
      position: [4, -2, 10],
      rotation: [0, 0, 0, 1],
      coordinateFrame: 'project-local',
    }, { sourceCameraConvention: 'three' })
    const [w, x, y, z] = result.qvec
    const worldToCamera = new ThreeQuaternion(x, y, z, w)
    const project = (point: [number, number, number]) =>
      new ThreeVector3(...point).applyQuaternion(worldToCamera).add(new ThreeVector3(...result.tvec))

    expect(result.coordinateFrame).toBe('project-local')
    expect(result.tvec).toEqual([-4, -2, 10])
    expect(project([4, -2, 10]).length()).toBeCloseTo(0, 10)
    expect(project([4, -2, 0]).toArray()).toEqual([0, 0, 10])
    const point = project([5, -3, 0])
    expect(point.toArray()).toEqual([1, 1, 10])
    expect(100 * point.x / point.z + 50).toBeCloseTo(60)
    expect(100 * point.y / point.z + 40).toBeCloseTo(50)
  })

  it('inverts a rotated camera pose instead of writing its centre as translation', () => {
    const result = cameraPoseToColmap({
      position: [4, -2, 10],
      rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      coordinateFrame: 'local-enu',
    }, { sourceCameraConvention: 'three' })
    const [w, x, y, z] = result.qvec
    const cameraPoint = new ThreeVector3(-6, -3, 9)
      .applyQuaternion(new ThreeQuaternion(x, y, z, w))
      .add(new ThreeVector3(...result.tvec))
    expect(cameraPoint.x).toBeCloseTo(1, 10)
    expect(cameraPoint.y).toBeCloseTo(1, 10)
    expect(cameraPoint.z).toBeCloseTo(10, 10)
    expect(result.tvec[0]).toBeCloseTo(10, 10)
    expect(result.tvec[1]).toBeCloseTo(-2, 10)
    expect(result.tvec[2]).toBeCloseTo(4, 10)
  })

  it('rejects unknown world frames instead of labelling them ENU', () => {
    expect(() => cameraPoseToColmap({
      position: [1, 2, 3], rotation: [0, 0, 0, 1], coordinateFrame: 'unknown',
    })).toThrow(/Unsupported camera coordinate frame/)
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
