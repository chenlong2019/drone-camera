/**
 * Photogrammetry helpers that do not depend on Cesium, Three, the DOM, or Node.
 *
 * The capture side stores Cesium positions in ECEF and local positions in ENU.
 * This module keeps that convention explicit so a reconstruction worker can use
 * the same values as the browser without importing a renderer.
 */

export type Vector3 = [number, number, number]
export type Quaternion = [number, number, number, number]

export interface CameraPoseLike {
  position: Vector3
  rotation: Quaternion
  coordinateFrame: 'ecef' | 'local-enu' | 'project-local' | string
}

export interface ColmapCameraPose {
  /** Camera centre in the reconstruction local frame, metres. */
  position: Vector3
  /** Camera-local-to-world quaternion in COLMAP/OpenCV axes, [x,y,z,w]. */
  rotation: Quaternion
  coordinateFrame: 'local-enu'
  rotationConvention: 'camera-local-to-world; COLMAP +X right, +Y down, +Z forward'
}

/** WGS84 geodetic coordinate. Angles are degrees and altitude is metres. */
export interface GeodeticCoordinate {
  longitude: number
  latitude: number
  altitude?: number
}

/** WGS84 ellipsoid constants used by all ECEF/ENU conversions. */
export const WGS84 = {
  semiMajorAxis: 6378137,
  inverseFlattening: 298.257223563,
  get flattening(): number {
    return 1 / this.inverseFlattening
  },
  get eccentricitySquared(): number {
    const f = this.flattening
    return f * (2 - f)
  },
} as const

export interface EcefEnuFrame {
  /** Origin expressed as the input geodetic coordinate. */
  readonly origin: GeodeticCoordinate
  /** Origin expressed in ECEF metres. */
  readonly ecefOrigin: Vector3
  /** Unit axes expressed in ECEF: east, north, up. */
  readonly east: Vector3
  readonly north: Vector3
  readonly up: Vector3
  /** Quaternion rotating ENU vectors into ECEF vectors, [x,y,z,w]. */
  readonly enuToEcefRotation: Quaternion
}

const DEG = Math.PI / 180
const RAD = 180 / Math.PI

function finite(value: number): boolean {
  return Number.isFinite(value)
}

function assertVector(value: Vector3, name: string): void {
  if (!value.every(finite)) throw new RangeError(`${name} must contain finite numbers`)
}

function normalizeVector(value: Vector3): Vector3 {
  const length = Math.hypot(value[0], value[1], value[2])
  if (!(length > 0) || !finite(length)) throw new RangeError('Cannot normalize a zero vector')
  return [value[0] / length, value[1] / length, value[2] / length]
}

function dot(a: Vector3, b: Vector3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/** Convert WGS84 longitude/latitude/altitude to Earth-centred Earth-fixed metres. */
export function geodeticToEcef(coordinate: GeodeticCoordinate): Vector3 {
  const { longitude, latitude } = coordinate
  const altitude = coordinate.altitude ?? 0
  if (![longitude, latitude, altitude].every(finite)) {
    throw new RangeError('Geodetic coordinates must contain finite numbers')
  }
  if (latitude < -90 || latitude > 90) throw new RangeError('Latitude must be in [-90, 90]')

  const lon = longitude * DEG
  const lat = latitude * DEG
  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  const radius = WGS84.semiMajorAxis / Math.sqrt(1 - WGS84.eccentricitySquared * sinLat * sinLat)
  return [
    (radius + altitude) * cosLat * Math.cos(lon),
    (radius + altitude) * cosLat * Math.sin(lon),
    (radius * (1 - WGS84.eccentricitySquared) + altitude) * sinLat,
  ]
}

/** Convert ECEF metres to WGS84 longitude/latitude/altitude. */
export function ecefToGeodetic(position: Vector3): GeodeticCoordinate {
  assertVector(position, 'ECEF position')
  const [x, y, z] = position
  const longitude = Math.atan2(y, x) * RAD
  const horizontal = Math.hypot(x, y)
  const a = WGS84.semiMajorAxis
  const e2 = WGS84.eccentricitySquared

  // The polar case has no meaningful longitude, but zero is a stable and useful
  // value for manifests. Bowring's initial latitude followed by a few Newton
  // iterations is accurate to sub-millimetres for normal drone altitudes.
  if (horizontal < 1e-12) {
    const latitude = Math.sign(z || 1) * 90
    const altitude = Math.abs(z) - a * (1 - e2)
    return { longitude: 0, latitude, altitude }
  }

  const b = a * Math.sqrt(1 - e2)
  const theta = Math.atan2(z * a, horizontal * b)
  const sinTheta = Math.sin(theta)
  const cosTheta = Math.cos(theta)
  let latitude = Math.atan2(
    z + (e2 * b * sinTheta * sinTheta * sinTheta) / (1 - e2),
    horizontal - e2 * a * cosTheta * cosTheta * cosTheta,
  )
  for (let i = 0; i < 8; i += 1) {
    const sinLat = Math.sin(latitude)
    const radius = a / Math.sqrt(1 - e2 * sinLat * sinLat)
    const altitude = horizontal / Math.cos(latitude) - radius
    const next = Math.atan2(z, horizontal * (1 - (e2 * radius) / (radius + altitude)))
    if (Math.abs(next - latitude) < 1e-13) {
      latitude = next
      break
    }
    latitude = next
  }
  const sinLat = Math.sin(latitude)
  const radius = a / Math.sqrt(1 - e2 * sinLat * sinLat)
  const altitude = horizontal / Math.cos(latitude) - radius
  return { longitude, latitude: latitude * RAD, altitude }
}

/** Build an ENU frame at a WGS84 geodetic origin. ENU is [east, north, up]. */
export function createEcefEnuFrame(origin: GeodeticCoordinate): EcefEnuFrame {
  if (![origin.longitude, origin.latitude, origin.altitude ?? 0].every(finite)) {
    throw new RangeError('ENU origin must contain finite numbers')
  }
  const lon = origin.longitude * DEG
  const lat = origin.latitude * DEG
  const sinLon = Math.sin(lon)
  const cosLon = Math.cos(lon)
  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  const east: Vector3 = [-sinLon, cosLon, 0]
  const north: Vector3 = [-sinLat * cosLon, -sinLat * sinLon, cosLat]
  const up: Vector3 = [cosLat * cosLon, cosLat * sinLon, sinLat]
  return {
    origin: { longitude: origin.longitude, latitude: origin.latitude, altitude: origin.altitude ?? 0 },
    ecefOrigin: geodeticToEcef(origin),
    east,
    north,
    up,
    enuToEcefRotation: quaternionFromMatrix3([east, north, up]),
  }
}

/** Convert an ECEF point to ENU metres relative to a frame. */
export function ecefToEnu(position: Vector3, frame: EcefEnuFrame): Vector3 {
  assertVector(position, 'ECEF position')
  const delta: Vector3 = [
    position[0] - frame.ecefOrigin[0],
    position[1] - frame.ecefOrigin[1],
    position[2] - frame.ecefOrigin[2],
  ]
  return [dot(delta, frame.east), dot(delta, frame.north), dot(delta, frame.up)]
}

/** Convert ENU metres relative to a frame to an ECEF point. */
export function enuToEcef(position: Vector3, frame: EcefEnuFrame): Vector3 {
  assertVector(position, 'ENU position')
  return [
    frame.ecefOrigin[0] + frame.east[0] * position[0] + frame.north[0] * position[1] + frame.up[0] * position[2],
    frame.ecefOrigin[1] + frame.east[1] * position[0] + frame.north[1] * position[1] + frame.up[1] * position[2],
    frame.ecefOrigin[2] + frame.east[2] * position[0] + frame.north[2] * position[1] + frame.up[2] * position[2],
  ]
}

function normalizeQuaternion(q: Quaternion): Quaternion {
  const length = Math.hypot(q[0], q[1], q[2], q[3])
  if (!(length > 0) || !finite(length)) throw new RangeError('Quaternion must be finite and non-zero')
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length]
}

function quaternionMultiply(a: Quaternion, b: Quaternion): Quaternion {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

function quaternionConjugate(q: Quaternion): Quaternion {
  return [-q[0], -q[1], -q[2], q[3]]
}

/** Convert a column-basis 3×3 rotation matrix to an [x,y,z,w] quaternion. */
function quaternionFromMatrix3(columns: [Vector3, Vector3, Vector3]): Quaternion {
  const [x, y, z] = columns
  const m00 = x[0], m01 = y[0], m02 = z[0]
  const m10 = x[1], m11 = y[1], m12 = z[1]
  const m20 = x[2], m21 = y[2], m22 = z[2]
  const trace = m00 + m11 + m22
  let q: Quaternion
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]
  }
  return normalizeQuaternion(q)
}

/** Convert an ENU orientation quaternion to the same orientation in ECEF. */
export function enuQuaternionToEcef(rotation: Quaternion, frame: EcefEnuFrame): Quaternion {
  return normalizeQuaternion(quaternionMultiply(frame.enuToEcefRotation, normalizeQuaternion(rotation)))
}

/** Convert an ECEF orientation quaternion to the same orientation in ENU. */
export function ecefQuaternionToEnu(rotation: Quaternion, frame: EcefEnuFrame): Quaternion {
  return normalizeQuaternion(
    quaternionMultiply(quaternionConjugate(frame.enuToEcefRotation), normalizeQuaternion(rotation)),
  )
}

/**
 * Camera-local axis conventions used by common reconstruction/rendering tools.
 * `colmap` and `opencv` use +X right, +Y down, +Z forward. Three's camera uses
 * +X right, +Y up, -Z forward. Cesium's camera uses +X right, +Y up, -Z forward
 * for its view direction; Cesium HPR values still need their own heading/pitch
 * semantics and should not be written directly as a COLMAP quaternion.
 */
export type CameraAxisConvention = 'colmap' | 'opencv' | 'three' | 'cesium'

export interface CameraWorldBasis {
  /** Camera +X axis in the world (usually the view's right vector). */
  right: Vector3
  /** Camera visual up axis in the world. */
  up: Vector3
  /** Camera optical forward direction in the world. */
  forward: Vector3
}

type Matrix3 = [Vector3, Vector3, Vector3]

const CAMERA_AXES: Record<CameraAxisConvention, Matrix3> = {
  colmap: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  opencv: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  three: [[1, 0, 0], [0, -1, 0], [0, 0, -1]],
  cesium: [[1, 0, 0], [0, -1, 0], [0, 0, -1]],
}

/**
 * Build a camera-local-to-world quaternion from rendered camera basis vectors.
 * This is useful for Cesium, where `directionWC`/`upWC` are available at the
 * exact frame that is copied to a PNG. The returned quaternion uses the chosen
 * camera convention and is safe to write to a manifest.
 */
export function cameraQuaternionFromBasis(
  basis: CameraWorldBasis,
  convention: CameraAxisConvention = 'three',
): Quaternion {
  assertVector(basis.right, 'camera right')
  assertVector(basis.up, 'camera up')
  assertVector(basis.forward, 'camera forward')
  const right = normalizeVector(basis.right)
  const up = normalizeVector(basis.up)
  const forward = normalizeVector(basis.forward)
  const columns: Matrix3 =
    convention === 'colmap' || convention === 'opencv'
      ? [right, [-up[0], -up[1], -up[2]], forward]
      : [right, up, [-forward[0], -forward[1], -forward[2]]]
  return quaternionFromMatrix3(columns)
}

function transposeMultiply(a: Matrix3, b: Matrix3): Matrix3 {
  const result: Matrix3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let c = 0; c < 3; c += 1) {
    const column = b[c]
    if (!column) continue
    result[c] = [dot(a[0] ?? [0, 0, 0], column), dot(a[1] ?? [0, 0, 0], column), dot(a[2] ?? [0, 0, 0], column)]
  }
  return result
}

/** Convert a camera pose quaternion while preserving its optical axis meaning. */
export function convertCameraQuaternion(
  rotation: Quaternion,
  from: CameraAxisConvention,
  to: CameraAxisConvention,
): Quaternion {
  const source = CAMERA_AXES[from]
  const target = CAMERA_AXES[to]
  if (!source || !target) throw new RangeError(`Unknown camera axis convention: ${String(from)} → ${String(to)}`)
  if (from === to) return normalizeQuaternion(rotation)
  const targetToSource = transposeMultiply(source, target)
  return normalizeQuaternion(quaternionMultiply(normalizeQuaternion(rotation), quaternionFromMatrix3(targetToSource)))
}

/**
 * Convert a captured pose into the local camera convention expected by a
 * COLMAP/OpenCV reconstruction worker. This is the explicit ECEF→ENU and
 * camera-axis boundary; callers must not write Cesium HPR values directly to
 * a COLMAP pose file.
 */
export function cameraPoseToColmap(
  pose: CameraPoseLike,
  options: {
    enuFrame?: EcefEnuFrame
    sourceCameraConvention?: CameraAxisConvention
  } = {},
): ColmapCameraPose {
  assertVector(pose.position, 'camera position')
  const sourceConvention = options.sourceCameraConvention ?? 'cesium'
  let position: Vector3
  let rotation = normalizeQuaternion(pose.rotation)
  if (pose.coordinateFrame === 'ecef') {
    if (!options.enuFrame) throw new RangeError('enuFrame is required to convert an ECEF camera pose')
    position = ecefToEnu(pose.position, options.enuFrame)
    rotation = ecefQuaternionToEnu(rotation, options.enuFrame)
  } else {
    position = [...pose.position]
  }
  return {
    position,
    rotation: convertCameraQuaternion(rotation, sourceConvention, 'colmap'),
    coordinateFrame: 'local-enu',
    rotationConvention: 'camera-local-to-world; COLMAP +X right, +Y down, +Z forward',
  }
}

/** Minimal 3D Tiles JSON shape used by validation and loading helpers. */
export interface TilesetNode {
  boundingVolume?: { box?: unknown; region?: unknown; sphere?: unknown }
  geometricError?: number
  refine?: 'ADD' | 'REPLACE' | string
  transform?: number[]
  content?: { uri?: string; url?: string; [key: string]: unknown }
  /** 3D Tiles 1.1 may attach more than one content payload to a node. */
  contents?: Array<{ uri?: string; url?: string; [key: string]: unknown }>
  children?: TilesetNode[]
  [key: string]: unknown
}

export interface TilesetJson {
  asset?: { version?: string; [key: string]: unknown }
  geometricError?: number
  root?: TilesetNode
  properties?: Record<string, unknown>
  [key: string]: unknown
}

export interface TilesetValidationStats {
  nodes: number
  contentUris: number
  boundingVolumes: number
  maxDepth: number
}

export interface TilesetValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  stats: TilesetValidationStats
}

function finiteArray(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every((entry) => typeof entry === 'number' && finite(entry))
}

function validateBoundingVolume(volume: TilesetNode['boundingVolume'], path: string, result: TilesetValidationResult): void {
  if (!volume || typeof volume !== 'object') {
    result.errors.push(`${path}.boundingVolume is required`)
    return
  }
  const keys = ['box', 'region', 'sphere'].filter((key) => Object.prototype.hasOwnProperty.call(volume, key))
  if (keys.length !== 1) {
    result.errors.push(`${path}.boundingVolume must contain exactly one of box, region, sphere`)
    return
  }
  const key = keys[0]
  const lengths = { box: 12, region: 6, sphere: 4 }
  if (!finiteArray(volume[key as keyof typeof volume], lengths[key as keyof typeof lengths])) {
    result.errors.push(`${path}.boundingVolume.${key} must contain ${lengths[key as keyof typeof lengths]} finite numbers`)
  } else {
    result.stats.boundingVolumes += 1
  }
}

/** Validate the structural parts Cesium needs before attempting a tileset load. */
export function validateTileset(tileset: unknown): TilesetValidationResult {
  const result: TilesetValidationResult = {
    valid: false,
    errors: [],
    warnings: [],
    stats: { nodes: 0, contentUris: 0, boundingVolumes: 0, maxDepth: 0 },
  }
  if (!tileset || typeof tileset !== 'object') {
    result.errors.push('tileset must be an object')
    return result
  }
  const value = tileset as TilesetJson
  const version = value.asset?.version
  if (typeof version !== 'string' || !/^1(?:\.0|\.1)$/.test(version)) {
    result.errors.push('asset.version must be "1.0" or "1.1"')
  }
  if (typeof value.geometricError !== 'number' || !finite(value.geometricError) || value.geometricError < 0) {
    result.errors.push('geometricError must be a finite non-negative number')
  }
  if (!value.root || typeof value.root !== 'object' || Array.isArray(value.root)) {
    result.errors.push('root is required')
  } else {
    const walk = (node: TilesetNode, path: string, depth: number): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        result.errors.push(`${path} must be an object`)
        return
      }
      result.stats.nodes += 1
      result.stats.maxDepth = Math.max(result.stats.maxDepth, depth)
      if (typeof node.geometricError !== 'number' || !finite(node.geometricError) || node.geometricError < 0) {
        result.errors.push(`${path}.geometricError must be a finite non-negative number`)
      }
      validateBoundingVolume(node.boundingVolume, path, result)
      if (node.transform !== undefined && !finiteArray(node.transform, 16)) {
        result.errors.push(`${path}.transform must contain 16 finite numbers`)
      }
      const uri = node.content?.uri ?? node.content?.url
      if (uri !== undefined) {
        if (typeof uri !== 'string' || !uri.trim()) result.errors.push(`${path}.content.uri must be a non-empty string`)
        else result.stats.contentUris += 1
      }
      if (node.contents !== undefined) {
        if (!Array.isArray(node.contents)) {
          result.errors.push(`${path}.contents must be an array`)
        } else {
          node.contents.forEach((content, index) => {
            const contentUri = content?.uri ?? content?.url
            if (typeof contentUri !== 'string' || !contentUri.trim()) {
              result.errors.push(`${path}.contents[${index}].uri must be a non-empty string`)
            } else {
              result.stats.contentUris += 1
            }
          })
        }
      }
      if (node.children !== undefined) {
        if (!Array.isArray(node.children)) result.errors.push(`${path}.children must be an array`)
        else node.children.forEach((child, index) => walk(child, `${path}.children[${index}]`, depth + 1))
      }
    }
    walk(value.root, 'root', 0)
    if (result.stats.contentUris === 0) result.warnings.push('tileset has no content URI; it may contain only external children')
  }
  result.valid = result.errors.length === 0
  return result
}

export interface CesiumTilesetLoader<T> {
  /** Adapter supplied by the host, typically Cesium3DTileset.fromUrl. */
  load(url: string): Promise<T> | T
}

export interface CesiumTilesetLoadResult<T> {
  url: string
  tileset: T
  validation?: TilesetValidationResult
}

/**
 * Load a tileset through an injected Cesium adapter. No Cesium symbol is
 * imported or referenced, so this helper also works in workers and tests.
 */
export async function loadCesiumTileset<T>(
  url: string,
  loader: CesiumTilesetLoader<T> | ((url: string) => Promise<T> | T),
  options: { validate?: (url: string) => Promise<TilesetValidationResult> | TilesetValidationResult } = {},
): Promise<CesiumTilesetLoadResult<T>> {
  if (typeof url !== 'string' || !url.trim()) throw new TypeError('A non-empty tileset URL is required')
  const validation = options.validate ? await options.validate(url) : undefined
  if (validation && !validation.valid) {
    throw new Error(`Invalid 3D Tiles tileset: ${validation.errors.join('; ')}`)
  }
  const load = typeof loader === 'function' ? loader : loader.load.bind(loader)
  return { url, tileset: await load(url), validation }
}

/** Verbose alias for applications that prefer the generic name. */
export const loadTilesetForCesium = loadCesiumTileset

export interface ReconstructionTaskPaths {
  captureDir: string
  imagesDir: string
  manifestPath: string
  validationPath: string
  reconstructionDir: string
  colmapDir: string
  sparseDir: string
  denseDir: string
  meshDir: string
  outputDir: string
  tilesetPath: string
  reportPath: string
}

export interface ReconstructionTask {
  captureId: string
  createdAt: string
  paths: ReconstructionTaskPaths
  coordinateFrame: 'ecef' | 'local-enu' | 'project-local'
  status: 'created' | 'running' | 'succeeded' | 'failed'
}

export interface ReconstructionReport {
  captureId: string
  status: 'succeeded' | 'failed' | 'partial'
  stage: 'validate-images' | 'feature-extraction' | 'matching' | 'sfm' | 'dense' | 'mesh' | 'tiles' | 'load'
  startedAt: string
  finishedAt?: string
  registeredImages?: number
  totalImages?: number
  tilesetUrl?: string
  errors: string[]
  warnings: string[]
}

function joinPath(...parts: string[]): string {
  const first = parts[0] ?? ''
  const absolute = /^[\\/]/.test(first)
  const joined = parts
    .filter((part) => part.length > 0)
    .join('/')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
  const windowsDrive = /^[A-Za-z]:\//.test(joined)
  if (absolute && !windowsDrive && !joined.startsWith('/')) return `/${joined}`
  return joined.replace(/\/$/, '')
}

/** Create deterministic task directories without touching the filesystem. */
export function createReconstructionTask(
  dataRoot: string,
  captureId: string,
  options: { coordinateFrame?: ReconstructionTask['coordinateFrame']; createdAt?: string } = {},
): ReconstructionTask {
  if (!captureId || /[\\/]/.test(captureId)) throw new TypeError('captureId must be a non-empty path segment')
  const captureDir = joinPath(dataRoot, 'captures', captureId)
  const reconstructionDir = joinPath(dataRoot, 'reconstruction', captureId)
  const outputDir = joinPath(dataRoot, 'outputs', captureId)
  return {
    captureId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    coordinateFrame: options.coordinateFrame ?? 'local-enu',
    status: 'created',
    paths: {
      captureDir,
      imagesDir: joinPath(captureDir, 'images'),
      manifestPath: joinPath(captureDir, 'manifest.json'),
      validationPath: joinPath(captureDir, 'image-validation.json'),
      reconstructionDir,
      colmapDir: joinPath(reconstructionDir, 'colmap'),
      sparseDir: joinPath(reconstructionDir, 'sparse'),
      denseDir: joinPath(reconstructionDir, 'dense'),
      meshDir: joinPath(reconstructionDir, 'mesh'),
      outputDir,
      tilesetPath: joinPath(outputDir, 'tileset.json'),
      reportPath: joinPath(reconstructionDir, 'reconstruction-report.json'),
    },
  }
}

/** Basic consistency checks for a reconstruction report loaded from disk. */
export function validateReconstructionReport(report: unknown): string[] {
  const errors: string[] = []
  if (!report || typeof report !== 'object') return ['report must be an object']
  const value = report as Partial<ReconstructionReport>
  if (!value.captureId || typeof value.captureId !== 'string') errors.push('captureId is required')
  if (!['succeeded', 'failed', 'partial'].includes(value.status ?? '')) errors.push('status is invalid')
  if (!value.startedAt || typeof value.startedAt !== 'string') errors.push('startedAt is required')
  if (!Array.isArray(value.errors)) errors.push('errors must be an array')
  if (!Array.isArray(value.warnings)) errors.push('warnings must be an array')
  if (value.registeredImages !== undefined && (!Number.isInteger(value.registeredImages) || value.registeredImages < 0)) {
    errors.push('registeredImages must be a non-negative integer')
  }
  if (value.totalImages !== undefined && (!Number.isInteger(value.totalImages) || value.totalImages < 0)) {
    errors.push('totalImages must be a non-negative integer')
  }
  if (
    value.registeredImages !== undefined &&
    value.totalImages !== undefined &&
    value.registeredImages > value.totalImages
  ) {
    errors.push('registeredImages cannot exceed totalImages')
  }
  return errors
}
