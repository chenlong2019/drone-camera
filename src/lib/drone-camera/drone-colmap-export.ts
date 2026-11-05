/**
 * COLMAP 数据集写出:camera 三件套 cameras.txt / images.txt / points3D.txt。
 *
 * 这一层只做「把已经对齐好的位姿写成 COLMAP 能读的文本」,不碰文件系统 ——
 * 落盘、压缩、上传交给调用方,于是它能在浏览器、Node、Worker 里同样运行。
 *
 * 三个容易写错的地方(格式对不上时 COLMAP 不报错,只是读出来是空的):
 *   1. images.txt 每张图**占两行**,第二行是 2D 观测;没有观测也要留一个空行。
 *      COLMAP 按「头部 4 行 + 每图 2 行」定位,少一行后面全错位。
 *   2. qvec 是 world-to-camera,顺序 [QW, QX, QY, QZ];tvec 是 -R·C,
 *      不是相机中心本身(把中心直接当平移,相机就会绕原点乱转)。
 *   3. 相机系 +X 右 / +Y 下 / +Z 前,而渲染器的 +Y 上 / +Z 后 ——
 *      换算由 drone-photogrammetry 的 cameraPoseToColmap 负责,这里不重做。
 */

import type {
  CaptureManifest,
  CaptureManifestCamera,
  CaptureManifestImage,
} from './drone-capture-manifest'
import {
  cameraPoseToColmap,
  createEcefEnuFrame,
  type CameraAxisConvention,
  type EcefEnuFrame,
  type Quaternion,
} from './drone-photogrammetry'

/** COLMAP 支持的相机模型子集(只实现够用的三个,其余降级到 PINHOLE) */
export type ColmapCameraModel = 'SIMPLE_PINHOLE' | 'PINHOLE' | 'OPENCV'

export type ColmapWorldFrame = 'local-enu' | 'project-local'

/** 一条 3D 点记录;不传时 points3D.txt 只留注释,由 SfM 自己三角化 */
export interface ColmapPoint3D {
  position: [number, number, number]
  color?: [number, number, number]
  /** 重投影误差(像素),默认 0 */
  error?: number
  /** 轨迹 [(image_id, point2d_idx), ...] */
  track?: Array<[number, number]>
}

export interface ColmapExportOptions {
  /** 相机模型;auto 按畸变系数是否完整决定 OPENCV / PINHOLE */
  cameraModel?: 'auto' | ColmapCameraModel
  /** manifest 未声明图像坐标系时的兜底帧 */
  worldFrame?: ColmapWorldFrame
  /** manifest 里 rotation 的源约定;manifest 自己声明的是 forward=-Z,+Y=up(等价 three) */
  sourceCameraConvention?: CameraAxisConvention
  /** 位姿是 ECEF 时必须给,或由 manifest 的 transform.origin 自动构造 */
  enuFrame?: EcefEnuFrame
  /** 每张图的 2D 观测行,键为 image.id;不传则输出空行 */
  points2D?: Record<string, string>
  /** 3D 点云;不传则输出空表 */
  points?: ColmapPoint3D[]
  /** 小数位数,默认 6(COLMAP 自身导出用同一量级) */
  precision?: number
}

export interface ColmapExport {
  camerasTxt: string
  imagesTxt: string
  points3Dtxt: string
  cameraCount: number
  imageCount: number
  pointCount: number
  /** 被跳过的图像 id 及原因,配合 warnings 一起给用户看 */
  skipped: Array<{ imageId: string; reason: string }>
  warnings: string[]
}

const DEFAULT_PRECISION = 6

/** 定点格式化,顺手把 -0.000000 归一成 0.000000(不改变数值,只是别让文件里出现负零) */
function fixed(value: number, precision: number): string {
  const text = value.toFixed(precision)
  return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function finiteTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(finite)
}

interface ResolvedCamera {
  model: ColmapCameraModel
  width: number
  height: number
  params: number[]
  signature: string
}

/**
 * 把 manifest 的相机描述换算成 COLMAP 的 (MODEL, PARAMS[])。
 * 缺焦距时用水平 FOV 反算;缺主点时用画面中心;畸变不足四个系数就退回 PINHOLE。
 */
function resolveCamera(
  camera: CaptureManifestCamera | undefined,
  requested: ColmapExportOptions['cameraModel'],
  warnings: string[],
): ResolvedCamera | null {
  if (!camera) return null
  const width = camera.width
  const height = camera.height
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0) return null

  let fx = camera.fx
  if (!finite(fx) || fx <= 0) {
    if (finite(camera.horizontalFovDeg) && camera.horizontalFovDeg > 0 && camera.horizontalFovDeg < 180) {
      fx = width / 2 / Math.tan((camera.horizontalFovDeg * Math.PI) / 360)
    }
  }
  if (!finite(fx) || fx <= 0) {
    warnings.push('相机缺少焦距且无法由水平 FOV 反算,无法写出 cameras.txt')
    return null
  }
  let fy = camera.fy
  if (!finite(fy) || fy <= 0) fy = fx
  const cx = finite(camera.cx) ? camera.cx : width / 2
  const cy = finite(camera.cy) ? camera.cy : height / 2

  const distortion = (camera.distortion ?? []).filter(finite)
  const wanted = requested ?? 'auto'
  let model: ColmapCameraModel
  if (wanted === 'auto') {
    model = distortion.length >= 4 ? 'OPENCV' : 'PINHOLE'
  } else {
    model = wanted
  }
  if (model === 'OPENCV' && distortion.length < 4) {
    warnings.push('要求 OPENCV 模型但畸变系数不足 4 个,已退回 PINHOLE(畸变被丢弃)')
    model = 'PINHOLE'
  }
  if (model === 'PINHOLE' && distortion.length > 0 && distortion.length < 4) {
    warnings.push(`相机有 ${distortion.length} 个畸变系数但不足 4 个,PINHOLE 模型会忽略它们`)
  }

  const params =
    model === 'OPENCV'
      ? [fx, fy, cx, cy, distortion[0]!, distortion[1]!, distortion[2]!, distortion[3]!]
      : model === 'SIMPLE_PINHOLE'
        ? [fx, cx, cy]
        : [fx, fy, cx, cy]

  return {
    model,
    width,
    height,
    params,
    signature: [
      model,
      `${width}x${height}`,
      ...params.map((value) => value.toFixed(4)),
    ].join('|'),
  }
}

function resolveFrame(image: CaptureManifestImage, fallback: ColmapWorldFrame): 'ecef' | ColmapWorldFrame {
  const frame = image.coordinateFrame
  if (frame === 'ecef' || frame === 'local-enu' || frame === 'project-local') return frame
  return fallback
}

function enuFrameFromManifest(manifest: CaptureManifest): EcefEnuFrame | null {
  const origin = manifest.coordinateFrame?.transform?.origin
  if (!origin || !finite(origin.longitude) || !finite(origin.latitude)) return null
  return createEcefEnuFrame({
    longitude: origin.longitude,
    latitude: origin.latitude,
    altitude: finite(origin.altitude) ? origin.altitude : 0,
  })
}

const CAMERAS_HEADER = [
  '# Camera list with one line of data per camera:',
  '#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]',
]

const IMAGES_HEADER = [
  '# Image list with two lines of data per image:',
  '#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME',
  '#   POINTS2D[] as (X, Y, POINT3D_ID)',
]

const POINTS_HEADER = [
  '# 3D point list with one line of data per point:',
  '#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)',
]

interface PreparedImage {
  id: number
  qvec: [number, number, number, number]
  tvec: [number, number, number]
  cameraId: number
  name: string
  points2D: string
}

/**
 * 把 manifest 写成 COLMAP 数据集。
 *
 * 多相机自动处理:内参不同的图像各占一个 camera_id(变焦、多机都走这条路径);
 * 内参相同则共用一个,和 COLMAP 自己的单相机数据集完全一致。
 */
export function exportColmapDataset(
  manifest: CaptureManifest,
  options: ColmapExportOptions = {},
): ColmapExport {
  const precision = options.precision ?? DEFAULT_PRECISION
  const warnings: string[] = []
  const skipped: Array<{ imageId: string; reason: string }> = []
  const sourceConvention: CameraAxisConvention = options.sourceCameraConvention ?? 'three'
  const fallbackFrame: ColmapWorldFrame = options.worldFrame ?? 'project-local'

  const images = Array.isArray(manifest?.images) ? manifest.images : []
  if (images.length === 0) warnings.push('manifest 不含任何图像')

  const libraryCamera = resolveCamera(manifest.camera, options.cameraModel, warnings)
  if (!libraryCamera) warnings.push('manifest 的相机缺少可用内参,全部图像将无法写出')

  const enuFrame = options.enuFrame ?? enuFrameFromManifest(manifest)
  const cameraIds = new Map<string, number>()
  const cameras: ResolvedCamera[] = []
  const prepared: PreparedImage[] = []

  const cameraIdFor = (camera: ResolvedCamera): number => {
    const existing = cameraIds.get(camera.signature)
    if (existing !== undefined) return existing
    const id = cameras.length + 1
    cameraIds.set(camera.signature, id)
    cameras.push(camera)
    return id
  }

  for (const image of images) {
    if (image.captureStatus !== 'success') {
      skipped.push({ imageId: image.id, reason: `captureStatus=${image.captureStatus}` })
      continue
    }
    if (!finiteTuple(image.position, 3) || !finiteTuple(image.rotation, 4)) {
      skipped.push({ imageId: image.id, reason: '缺少有限的位置或四元数' })
      continue
    }
    const quaternion = image.rotation as Quaternion
    if (Math.hypot(...quaternion) < 1e-9) {
      skipped.push({ imageId: image.id, reason: '四元数为零长度' })
      continue
    }

    // 每张图可能自带内参(多相机/变焦);没有就沿用 manifest 的全局相机
    const perImage = image.intrinsics
      ? resolveCamera(
          { ...image.intrinsics, width: image.intrinsics.width || image.width || 0, height: image.intrinsics.height || image.height || 0 },
          options.cameraModel,
          warnings,
        )
      : null
    const camera = perImage ?? libraryCamera
    if (!camera) {
      skipped.push({ imageId: image.id, reason: '没有可用内参' })
      continue
    }

    const frame = resolveFrame(image, fallbackFrame)
    if (!image.file) {
      skipped.push({ imageId: image.id, reason: '缺少文件名' })
      continue
    }
    if (/\s/.test(image.file)) {
      warnings.push(`文件名含空白字符,COLMAP 会把它截断:${image.file}`)
    }

    let pose
    try {
      pose = cameraPoseToColmap(
        { position: image.position as [number, number, number], rotation: quaternion, coordinateFrame: frame },
        {
          sourceCameraConvention: sourceConvention,
          ...(frame === 'ecef' ? { enuFrame: enuFrame ?? undefined } : {}),
        },
      )
    } catch (error) {
      skipped.push({
        imageId: image.id,
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    prepared.push({
      id: prepared.length + 1,
      qvec: pose.qvec,
      tvec: pose.tvec,
      cameraId: cameraIdFor(camera),
      name: image.file,
      points2D: options.points2D?.[image.id] ?? '',
    })
  }

  const camerasTxt = [
    ...CAMERAS_HEADER,
    `# Number of cameras: ${cameras.length}`,
    ...cameras.map(
      (camera, index) =>
        `${index + 1} ${camera.model} ${camera.width} ${camera.height} ${camera.params
          .map((value) => fixed(value, precision))
          .join(' ')}`,
    ),
    '',
  ].join('\n')

  const imagesTxt = [
    ...IMAGES_HEADER,
    `# Number of images: ${prepared.length}, mean observations per image: 0`,
    ...prepared.flatMap((image) => [
      `${image.id} ${image.qvec.map((value) => fixed(value, precision)).join(' ')} ${image.tvec
        .map((value) => fixed(value, precision))
        .join(' ')} ${image.cameraId} ${image.name}`,
      image.points2D,
    ]),
    '',
  ].join('\n')

  const points = options.points ?? []
  const points3Dtxt = [
    ...POINTS_HEADER,
    `# Number of points: ${points.length}, mean track length: ${
      points.length === 0
        ? 0
        : (
            points.reduce((sum, point) => sum + (point.track?.length ?? 0), 0) / points.length
          ).toFixed(2)
    }`,
    ...points.map((point, index) => {
      const color = point.color ?? [255, 255, 255]
      const track = (point.track ?? []).map(([imageId, index2D]) => `${imageId} ${index2D}`).join(' ')
      return [
        index + 1,
        ...point.position.map((value) => fixed(value, precision)),
        ...color.map((value) => Math.max(0, Math.min(255, Math.round(value)))),
        fixed(point.error ?? 0, precision),
        track,
      ]
        .filter((part) => part !== '')
        .join(' ')
    }),
    '',
  ].join('\n')

  return {
    camerasTxt,
    imagesTxt,
    points3Dtxt,
    cameraCount: cameras.length,
    imageCount: prepared.length,
    pointCount: points.length,
    skipped,
    warnings,
  }
}
