/**
 * CaptureManifest and quality checks for the virtual photogrammetry PoC.
 *
 * The capture service deliberately keeps its browser facing session model
 * (`CaptureSession`) small.  This module is the boundary to an offline
 * reconstruction tool: it turns a session into a stable, JSON serialisable
 * manifest and validates the fields that COLMAP (or another tool) needs.
 */

import type {
  CameraIntrinsics,
  CaptureSession,
  CapturedImage,
  CoordinateFrame,
} from './drone-capture'
import { createEcefEnuFrame, ecefToEnu } from './drone-photogrammetry'

export const CAPTURE_MANIFEST_SCHEMA_VERSION = 1 as const

export type CaptureStatus = 'success' | 'failed' | 'pending'

export interface CaptureManifestTransform {
  /** Source coordinate frame used by the image poses. */
  source: string
  /** Target frame expected by the reconstruction/export pipeline. */
  target: string
  /** Optional translation in target units: target = rotation * (scale * source) + translation. */
  translation?: [number, number, number]
  /** Optional active rotation, in quaternion [x, y, z, w] order. */
  rotation?: [number, number, number, number]
  /** Optional uniform scale from source units to target units. */
  scale?: number
  /** Origin used when deriving a local ENU frame. */
  origin?: { longitude: number; latitude: number; altitude: number }
  /** Extra transform parameters supplied by an integration. */
  [key: string]: unknown
}

export interface CaptureManifestCoordinateFrame {
  world: string
  local: string
  units: 'meters' | string
  transform: CaptureManifestTransform
}

export interface CaptureManifestCamera {
  /** COLMAP style camera model, for example PINHOLE or OPENCV. */
  model: string
  width: number
  height: number
  fx?: number
  fy?: number
  cx?: number
  cy?: number
  horizontalFovDeg?: number
  verticalFovDeg?: number
  distortion?: number[]
  /** Projection model as used by the rendering backend. */
  projection?: string
  /** Zoom value if the backend exposes one. */
  zoom?: number
}

export interface CaptureManifestImage {
  id: string
  /** Path relative to the capture directory. */
  file: string
  timestamp: string
  position?: [number, number, number]
  rotation?: [number, number, number, number]
  /** Explicitly states quaternion order and camera axis convention. */
  rotationConvention: string
  captureStatus: CaptureStatus
  source?: string
  mimeType?: string
  sizeBytes?: number
  width?: number
  height?: number
  coordinateFrame?: CoordinateFrame | string
  intrinsics?: CaptureManifestCamera
  cameraModel?: string
  engine?: string
  sceneId?: string
  sceneVersion?: string
  /** Optional content hashes or quality probes supplied by a storage layer. */
  contentHash?: string
  quality?: CaptureImageQuality
  validation?: { status: string; messages: string[] }
}

export interface CaptureImageQuality {
  /** Set by a decoder when the image was successfully opened. */
  decodable?: boolean
  /** True when all sampled pixels have the same (or almost the same) value. */
  uniform?: boolean
  /** True when the decoded image is effectively black or white. */
  blank?: boolean
  /** Optional luma statistics from an image decoder. */
  meanLuma?: number
  variance?: number
}

export interface CaptureManifest {
  schemaVersion: typeof CAPTURE_MANIFEST_SCHEMA_VERSION
  captureId: string
  createdAt: string
  coordinateFrame: CaptureManifestCoordinateFrame
  camera: CaptureManifestCamera
  images: CaptureManifestImage[]
}

export interface CaptureManifestOptions {
  captureId?: string
  createdAt?: string
  coordinateFrame?: Partial<CaptureManifestCoordinateFrame> & {
    transform?: Partial<CaptureManifestTransform>
  }
  /** Override the default image path prefix (`images/`). */
  imageDirectory?: string
  /** Explicit camera model when the source does not expose one. */
  cameraModel?: string
  /** Explicit projection model, for example perspective. */
  projection?: string
}

export type CaptureValidationSeverity = 'error' | 'warning'

export interface CaptureValidationIssue {
  code: string
  message: string
  severity: CaptureValidationSeverity
  imageId?: string
}

export interface CaptureValidationReport {
  valid: boolean
  status: 'valid' | 'warning' | 'invalid'
  imageCount: number
  checkedImages: number
  errors: CaptureValidationIssue[]
  warnings: CaptureValidationIssue[]
  issues: CaptureValidationIssue[]
  duplicateImageIds: string[][]
  /** Aliases useful to callers that treat the report as a quality gate. */
  passed: boolean
}

export interface CaptureValidatorOptions {
  /** Require every image to contain a finite camera pose (default true). */
  requirePose?: boolean
  /** Require a usable global camera model (default true). */
  requireIntrinsics?: boolean
  /** Check optional blank/uniform probes (default true when present). */
  checkBlankImages?: boolean
  /** Treat duplicate content hashes/poses as errors (default true). */
  rejectDuplicates?: boolean
  /** Maximum relative difference allowed for numeric camera parameters. */
  intrinsicsTolerance?: number
  /** Optional additional image quality probes, keyed by id or file. */
  imageQuality?: Record<string, CaptureImageQuality | undefined>
}

const ROTATION_CONVENTION =
  'quaternion [x,y,z,w]; active camera-local-to-world rotation; camera forward=-Z, right=+X, up=+Y'

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function finiteTuple<T extends number[]>(value: unknown, length: number): value is T {
  return Array.isArray(value) && value.length === length && value.every(finite)
}

function cloneTuple<T extends number[]>(value: T): T {
  return value.slice() as T
}

function cameraFromIntrinsics(
  intrinsics: CameraIntrinsics | undefined,
  options: CaptureManifestOptions,
): CaptureManifestCamera {
  const source = intrinsics
  const model = options.cameraModel ?? (source?.fx !== undefined || source?.fy !== undefined ? 'PINHOLE' : 'UNKNOWN')
  return {
    model,
    width: source?.width ?? 0,
    height: source?.height ?? 0,
    ...(source?.fx === undefined ? {} : { fx: source.fx }),
    ...(source?.fy === undefined ? {} : { fy: source.fy }),
    ...(source?.cx === undefined ? {} : { cx: source.cx }),
    ...(source?.cy === undefined ? {} : { cy: source.cy }),
    ...(source?.horizontalFovDeg === undefined ? {} : { horizontalFovDeg: source.horizontalFovDeg }),
    ...(source?.verticalFovDeg === undefined ? {} : { verticalFovDeg: source.verticalFovDeg }),
    ...(source?.distortion === undefined ? {} : { distortion: [...source.distortion] }),
    projection: options.projection ?? 'perspective',
  }
}

function cameraEqual(a: CaptureManifestCamera, b: CaptureManifestCamera, tolerance: number): boolean {
  const fields: Array<keyof CaptureManifestCamera> = [
    'width',
    'height',
    'fx',
    'fy',
    'cx',
    'cy',
    'horizontalFovDeg',
    'verticalFovDeg',
    'zoom',
  ]
  if (a.model !== b.model || a.projection !== b.projection) return false
  if (!fields.every((field) => {
    const av = a[field]
    const bv = b[field]
    if (typeof av !== 'number' || typeof bv !== 'number') return av === bv
    const scale = Math.max(1, Math.abs(av), Math.abs(bv))
    return Math.abs(av - bv) <= tolerance * scale
  })) return false
  const ad = a.distortion ?? []
  const bd = b.distortion ?? []
  return ad.length === bd.length && ad.every((value, index) => {
    const other = bd[index]
    return finite(other) && Math.abs(value - other) <= tolerance * Math.max(1, Math.abs(value), Math.abs(other))
  })
}

function pathForImage(fileName: string, directory: string): string {
  const normalized = fileName.replace(/\\/g, '/')
  const prefix = directory.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!prefix || normalized.startsWith(`${prefix}/`)) return normalized
  return `${prefix}/${normalized.replace(/^\/+/, '')}`
}

function frameName(frame: CoordinateFrame | undefined): string {
  switch (frame) {
    case 'ecef':
      return 'Cesium ECEF'
    case 'local-enu':
      return 'ENU'
    case 'project-local':
      return 'project-local'
    default:
      return 'unknown'
  }
}

function coordinateFrameFromSession(
  session: CaptureSession,
  images: CapturedImage[],
  override?: CaptureManifestOptions['coordinateFrame'],
): CaptureManifestCoordinateFrame {
  const frames = [...new Set(images.map((image) => image.cameraPose?.coordinateFrame).filter(Boolean))]
  const source = frames.length === 1 ? frameName(frames[0]) : frames.length > 1 ? 'mixed' : 'unknown'
  const origin = session.options.georeference
  const enuFrame = source === 'Cesium ECEF' && origin ? createEcefEnuFrame(origin) : null
  const enuTranslation = enuFrame ? ecefToEnu([0, 0, 0], enuFrame) : null
  const transformParametersAvailable = source !== 'unknown' && source !== 'mixed' && (source !== 'Cesium ECEF' || enuFrame !== null)
  const defaultTransform: CaptureManifestTransform = {
    source,
    target: source === 'Cesium ECEF' ? 'ENU' : source,
    ...(transformParametersAvailable
      ? {
          translation: [0, 0, 0] as [number, number, number],
          rotation: [0, 0, 0, 1] as [number, number, number, number],
          scale: 1,
        }
      : { parametersAvailable: false }),
    ...(origin
      ? {
          origin: {
            longitude: origin.longitude,
            latitude: origin.latitude,
            altitude: origin.altitude ?? 0,
          },
        }
      : {}),
    ...(enuFrame && enuTranslation
      ? {
          parametersAvailable: true,
          translation: enuTranslation,
          rotation: [
            -enuFrame.enuToEcefRotation[0],
            -enuFrame.enuToEcefRotation[1],
            -enuFrame.enuToEcefRotation[2],
            enuFrame.enuToEcefRotation[3],
          ] as [number, number, number, number],
          ecefOrigin: [...enuFrame.ecefOrigin],
          basis: {
            east: [...enuFrame.east],
            north: [...enuFrame.north],
            up: [...enuFrame.up],
          },
          enuToEcefRotation: [...enuFrame.enuToEcefRotation],
          // Row-major affine matrix that maps ECEF metres to local ENU metres.
          matrix: [
            enuFrame.east[0],
            enuFrame.east[1],
            enuFrame.east[2],
            enuTranslation[0],
            enuFrame.north[0],
            enuFrame.north[1],
            enuFrame.north[2],
            enuTranslation[1],
            enuFrame.up[0],
            enuFrame.up[1],
            enuFrame.up[2],
            enuTranslation[2],
            0,
            0,
            0,
            1,
          ],
          matrixOrder: 'row-major',
        }
      : {}),
  }
  const transform = { ...defaultTransform, ...(override?.transform ?? {}) }
  return {
    world: override?.world ?? (source === 'Cesium ECEF' ? 'Cesium ECEF' : source),
    local: override?.local ?? (source === 'Cesium ECEF' ? 'ENU' : source),
    units: override?.units ?? 'meters',
    transform,
  }
}

function imageStatus(image: CapturedImage): CaptureStatus {
  if (image.validation.status === 'invalid') return 'failed'
  if (image.validation.status === 'pending') return 'pending'
  return 'success'
}

function imageEntry(
  image: CapturedImage,
  camera: CaptureManifestCamera,
  imageDirectory: string,
): CaptureManifestImage {
  const pose = image.cameraPose
  const intrinsics = image.cameraIntrinsics ? cameraFromIntrinsics(image.cameraIntrinsics, {}) : undefined
  return {
    id: image.id,
    file: pathForImage(image.fileName, imageDirectory),
    timestamp: image.capturedAt,
    ...(pose
      ? {
          position: cloneTuple(pose.position),
          rotation: cloneTuple(pose.rotation),
          coordinateFrame: pose.coordinateFrame,
        }
      : {}),
    rotationConvention: ROTATION_CONVENTION,
    captureStatus: imageStatus(image),
    source: image.source,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    width: image.cameraIntrinsics?.width ?? camera.width,
    height: image.cameraIntrinsics?.height ?? camera.height,
    ...(intrinsics ? { intrinsics } : {}),
    ...(image.metadata.cameraModel ? { cameraModel: image.metadata.cameraModel } : {}),
    ...(image.metadata.engine ? { engine: image.metadata.engine } : {}),
    ...(image.metadata.sceneId ? { sceneId: image.metadata.sceneId } : {}),
    ...(image.metadata.sceneVersion ? { sceneVersion: image.metadata.sceneVersion } : {}),
    ...(image.imageUrl ? { contentHash: hashText(image.imageUrl) } : {}),
    validation: { status: image.validation.status, messages: [...image.validation.messages] },
  }
}

/** Small deterministic fallback hash for browser sessions without Web Crypto. */
function hashText(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** Build a JSON serialisable manifest from an existing capture session. */
export function buildCaptureManifest(
  session: CaptureSession,
  options: CaptureManifestOptions = {},
): CaptureManifest {
  const first = session.images.find((image) => image.cameraIntrinsics)?.cameraIntrinsics
  const camera = cameraFromIntrinsics(first, options)
  return {
    schemaVersion: CAPTURE_MANIFEST_SCHEMA_VERSION,
    captureId: options.captureId ?? session.id,
    createdAt: options.createdAt ?? session.createdAt,
    coordinateFrame: coordinateFrameFromSession(session, session.images, options.coordinateFrame),
    camera,
    images: session.images.map((image) => imageEntry(image, camera, options.imageDirectory ?? 'images')),
  }
}

/** Compatibility aliases for callers that prefer a verb based name. */
export const captureSessionToManifest = buildCaptureManifest
export const createCaptureManifest = buildCaptureManifest

export function serializeCaptureManifest(manifest: CaptureManifest, space = 2): string {
  return JSON.stringify(manifest, null, space)
}

export function parseCaptureManifest(value: string | CaptureManifest): CaptureManifest {
  const manifest = typeof value === 'string' ? (JSON.parse(value) as CaptureManifest) : value
  if (!manifest || manifest.schemaVersion !== CAPTURE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported capture manifest schema version: ${String(manifest?.schemaVersion)}`)
  }
  if (!Array.isArray(manifest.images)) throw new Error('Capture manifest images must be an array')
  return manifest
}

function makeIssue(
  severity: CaptureValidationSeverity,
  code: string,
  message: string,
  imageId?: string,
): CaptureValidationIssue {
  return { severity, code, message, ...(imageId ? { imageId } : {}) }
}

/** Validate the manifest before handing it to an offline reconstruction task. */
export function validateCaptureManifest(
  manifest: CaptureManifest,
  options: CaptureValidatorOptions = {},
): CaptureValidationReport {
  const errors: CaptureValidationIssue[] = []
  const warnings: CaptureValidationIssue[] = []
  const add = (issue: CaptureValidationIssue): void => {
    if (issue.severity === 'error') errors.push(issue)
    else warnings.push(issue)
  }
  const requirePose = options.requirePose ?? true
  const requireIntrinsics = options.requireIntrinsics ?? true
  const checkBlank = options.checkBlankImages ?? true
  const rejectDuplicates = options.rejectDuplicates ?? true
  const tolerance = options.intrinsicsTolerance ?? 1e-3
  const images = Array.isArray(manifest?.images) ? manifest.images : []
  const duplicateImageIds: string[][] = []

  if (!manifest || manifest.schemaVersion !== CAPTURE_MANIFEST_SCHEMA_VERSION) {
    add(makeIssue('error', 'schema-version', 'Unsupported or missing manifest schemaVersion'))
  }
  if (!manifest?.captureId) add(makeIssue('error', 'capture-id', 'captureId is required'))
  if (!manifest?.createdAt || Number.isNaN(Date.parse(manifest.createdAt))) {
    add(makeIssue('error', 'created-at', 'createdAt must be a valid ISO timestamp'))
  }
  if (!manifest?.coordinateFrame?.world || !manifest.coordinateFrame.local) {
    add(makeIssue('error', 'coordinate-frame', 'coordinateFrame.world and local are required'))
  }
  if (!manifest?.coordinateFrame?.transform?.source || !manifest.coordinateFrame.transform.target) {
    add(makeIssue('error', 'coordinate-transform', 'coordinateFrame.transform must declare source and target'))
  }
  if (manifest?.coordinateFrame?.transform?.parametersAvailable === false) {
    add(makeIssue('error', 'coordinate-transform', 'Coordinate transform parameters are unavailable'))
  }

  const camera = manifest?.camera
  if (!camera || !camera.model || !finite(camera.width) || !finite(camera.height) || camera.width <= 0 || camera.height <= 0) {
    add(makeIssue('error', 'camera-intrinsics', 'camera model and positive image dimensions are required'))
  }
  if (requireIntrinsics && (!camera || !finite(camera.fx) || !finite(camera.fy) || !finite(camera.cx) || !finite(camera.cy))) {
    add(makeIssue('error', 'camera-intrinsics', 'camera fx/fy/cx/cy must be finite'))
  }

  const seenIds = new Set<string>()
  const seenFiles = new Map<string, string>()
  const seenHashes = new Map<string, string>()
  const seenPoses = new Map<string, string>()
  let checkedImages = 0
  for (const image of images) {
    checkedImages += 1
    if (!image?.id) add(makeIssue('error', 'image-id', 'Image id is required'))
    if (image?.id && seenIds.has(image.id)) add(makeIssue('error', 'duplicate-id', `Duplicate image id: ${image.id}`, image.id))
    if (image?.id) seenIds.add(image.id)
    if (image?.captureStatus !== 'success') {
      add(makeIssue('error', 'capture-status', 'Image captureStatus must be success', image?.id))
    }
    if (!image?.file) add(makeIssue('error', 'image-file', 'Image file path is required', image?.id))
    if (!image?.timestamp || Number.isNaN(Date.parse(image.timestamp))) {
      add(makeIssue('error', 'timestamp', 'Image timestamp must be valid', image?.id))
    }
    if (!image?.mimeType?.startsWith('image/')) {
      add(makeIssue('error', 'mime-type', 'Image MIME type must start with image/', image?.id))
    }
    if (!finite(image?.sizeBytes) || (image?.sizeBytes ?? 0) <= 0) {
      add(makeIssue('error', 'empty-file', 'Image file is empty or size is unknown', image?.id))
    }
    const width = image?.width ?? camera?.width
    const height = image?.height ?? camera?.height
    if (!finite(width) || !finite(height) || width <= 0 || height <= 0) {
      add(makeIssue('error', 'image-dimensions', 'Image dimensions must be positive', image?.id))
    } else if (camera && (width !== camera.width || height !== camera.height)) {
      add(makeIssue('error', 'image-dimensions-mismatch', 'Image dimensions do not match the manifest camera', image?.id))
    }
    const quality = options.imageQuality?.[image?.id] ?? options.imageQuality?.[image?.file] ?? image?.quality
    if (quality?.decodable === false) add(makeIssue('error', 'decode', 'Image cannot be decoded', image?.id))
    if (checkBlank && (quality?.blank === true || quality?.uniform === true)) {
      add(makeIssue('error', 'blank-image', 'Image is uniformly black/white or otherwise blank', image?.id))
    }
    if (checkBlank && finite(quality?.variance) && quality.variance <= 1e-6) {
      add(makeIssue('error', 'blank-image', 'Image has no measurable pixel variation', image?.id))
    }
    if (
      checkBlank &&
      finite(quality?.meanLuma) &&
      (quality.meanLuma <= 1 || quality.meanLuma >= 254) &&
      (!finite(quality.variance) || quality.variance <= 1)
    ) {
      add(makeIssue('error', 'blank-image', 'Image is effectively pure black or white', image?.id))
    }
    if (!image?.rotationConvention) add(makeIssue('error', 'rotation-convention', 'rotationConvention is required', image?.id))
    if (requirePose && (!finiteTuple(image?.position, 3) || !finiteTuple(image?.rotation, 4))) {
      add(makeIssue('error', 'pose', 'Image position and quaternion must contain finite values', image?.id))
    }
    if (finiteTuple(image?.rotation, 4)) {
      const norm = Math.hypot(...image.rotation)
      if (norm < 1e-9) add(makeIssue('error', 'pose-quaternion', 'Image rotation quaternion has zero length', image.id))
    }

    const file = image?.file
    if (file && seenFiles.has(file)) {
      const firstId = seenFiles.get(file)!
      duplicateImageIds.push([firstId, image.id])
      if (rejectDuplicates) add(makeIssue('error', 'duplicate-file', `Duplicate image file: ${file}`, image.id))
      if (rejectDuplicates) add(makeIssue('error', 'duplicate-content', 'Duplicate image content (same file path)', image.id))
    } else if (file) seenFiles.set(file, image.id)
    const hash = image?.contentHash
    if (hash && seenHashes.has(hash)) {
      const firstId = seenHashes.get(hash)!
      duplicateImageIds.push([firstId, image.id])
      if (rejectDuplicates) add(makeIssue('error', 'duplicate-content', 'Duplicate image content hash', image.id))
    } else if (hash) seenHashes.set(hash, image.id)
    if (finiteTuple(image?.position, 3) && finiteTuple(image?.rotation, 4)) {
      const poseKey = `${image.position.join(',')}|${image.rotation.join(',')}`
      if (seenPoses.has(poseKey)) {
        const firstId = seenPoses.get(poseKey)!
        duplicateImageIds.push([firstId, image.id])
        if (rejectDuplicates) add(makeIssue('error', 'duplicate-pose', 'Duplicate camera pose', image.id))
      } else seenPoses.set(poseKey, image.id)
    }

    if (image?.intrinsics && camera && !cameraEqual(camera, image.intrinsics, tolerance)) {
      add(makeIssue('error', 'intrinsics-mismatch', 'Image camera intrinsics do not match the manifest camera', image.id))
    }
  }
  if (images.length === 0) add(makeIssue('error', 'no-images', 'Manifest contains no images'))
  if (images.length === 1) warnings.push(makeIssue('warning', 'single-image', 'A single image cannot provide photogrammetric coverage'))

  const issues = [...errors, ...warnings]
  const status = errors.length ? 'invalid' : warnings.length ? 'warning' : 'valid'
  return {
    valid: errors.length === 0,
    passed: errors.length === 0,
    status,
    imageCount: images.length,
    checkedImages,
    errors,
    warnings,
    issues,
    duplicateImageIds,
  }
}

/** Validate a browser capture session without requiring the caller to build a manifest first. */
export function validateCaptureSession(
  session: CaptureSession,
  options: CaptureValidatorOptions = {},
  manifestOptions: CaptureManifestOptions = {},
): CaptureValidationReport {
  return validateCaptureManifest(buildCaptureManifest(session, manifestOptions), options)
}

/** Object oriented facade for applications that keep validators as services. */
export class CaptureValidator {
  readonly options: CaptureValidatorOptions

  constructor(options: CaptureValidatorOptions = {}) {
    this.options = { ...options }
  }

  validate(manifest: CaptureManifest): CaptureValidationReport
  validate(session: CaptureSession, manifestOptions?: CaptureManifestOptions): CaptureValidationReport
  validate(input: CaptureManifest | CaptureSession, manifestOptions: CaptureManifestOptions = {}): CaptureValidationReport {
    if ((input as CaptureManifest).schemaVersion === CAPTURE_MANIFEST_SCHEMA_VERSION) {
      return validateCaptureManifest(input as CaptureManifest, this.options)
    }
    return validateCaptureSession(input as CaptureSession, this.options, manifestOptions)
  }

  static validate(manifest: CaptureManifest, options?: CaptureValidatorOptions): CaptureValidationReport
  static validate(
    session: CaptureSession,
    options?: CaptureValidatorOptions,
    manifestOptions?: CaptureManifestOptions,
  ): CaptureValidationReport
  static validate(
    input: CaptureManifest | CaptureSession,
    options: CaptureValidatorOptions = {},
    manifestOptions: CaptureManifestOptions = {},
  ): CaptureValidationReport {
    if ((input as CaptureManifest).schemaVersion === CAPTURE_MANIFEST_SCHEMA_VERSION) {
      return validateCaptureManifest(input as CaptureManifest, options)
    }
    return validateCaptureSession(input as CaptureSession, options, manifestOptions)
  }
}

