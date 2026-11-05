/**
 * 真采集数据 → 可查看的三维数据。
 *
 * `createReconstructionSample()` 给的是程序化示例(地形 + 楼 + 水塔),用来演示渲染管线;
 * 本模块把**真实采集的位姿**和**真实 COLMAP 输出**变成同一套 `SplatCloud`,于是查看器
 * 不必区分"示例"和"真数据"——它只认 splat。
 *
 * 三条输入路径:
 *
 * ```ts
 * // ① 采集会话 / manifest:把每张影像的视锥画出来(位姿自检,零重建)
 * const cloud = capturePosesToCloud(session)
 *
 * // ② COLMAP 跑完的 sparse 输出:位姿 + 三角化点一起看
 * const dataset = parseColmapDataset({ camerasTxt, imagesTxt, points3Dtxt })
 * const cloud = colmapDatasetToCloud(dataset)
 *
 * // ③ 只要位姿(比如从 images.txt 反解)
 * posesToCloud(colmapImagesToPoses(dataset))
 * ```
 *
 * ## 为什么先做"位姿骨架"而不是直接出重建结果
 *
 * 真实链路里,位姿错了后面全错,而位姿错在画面上是**看不出来的**:一个整体转 180° 的
 * 位姿集合,渲染出来依然"像那么回事"。把视锥画成实体之后,一眼能看出朝向对不对、
 * 覆盖率有没有洞、有没有哪张图的姿态突跳——这是花几小时训练之前唯一便宜的检查。
 *
 * ## 坐标约定(与 `drone-capture` 一致,别在别处再推一遍)
 *
 * - `position` / 四元数都在**同一个** `coordinateFrame` 里:`local-enu`(x 东 / y 北 / z 上)
 *   或 `project-local`(three 系,y 上);
 * - 四元数是 **camera-local → world**,`[x,y,z,w]`,相机朝 `-Z`、上方 `+Y`;
 * - COLMAP 的 `qvec` 是 **world → camera**(`+Z` 前向、`+Y` 向下),顺序 `[w,x,y,z]`。
 *   两者之间只有一个转换点:`colmapImagesToPoses()`;它用
 *   `convertCameraQuaternion(qvec,'colmap','three')` 换约定、用 `-Rᵀ·tvec` 换中心。
 */

import type { CaptureSession } from './drone-capture'
import type { CaptureManifest, CaptureManifestImage } from './drone-capture-manifest'
import type {
  CameraAxisConvention,
  EcefEnuFrame,
  Quaternion,
  Vector3,
} from './drone-photogrammetry'
import {
  convertCameraQuaternion,
  createEcefEnuFrame,
  ecefQuaternionToEnu,
  ecefToEnu,
  rotateVectorByQuaternion,
} from './drone-photogrammetry'
import { computeSplatBounds } from './drone-splat'
import type { SplatCloud } from './drone-splat'

const DEG = Math.PI / 180

/* ───────────────────────────── 通用:拼 splat ───────────────────────────── */

interface RawSplat {
  position: Vector3
  /** 椭球三轴 σ(米);各向同性小球就三个值相同 */
  scale: Vector3
  color: Vector3
  alpha: number
}

/**
 * 把一串原始 splat 摊成查看器要的扁平数组。
 *
 * 刻意不用 `drone-splat` 的内部 builder:那个是示例场景专用的(旋转恒等),这里需要
 * 按需给椭球朝向(画视锥棱时用拉长的椭球比一串小球省一半数量)。
 */
function cloudFrom(splats: RawSplat[], name: string): SplatCloud {
  const count = splats.length
  const center = new Float32Array(count * 3)
  const scale = new Float32Array(count * 3)
  const rotation = new Float32Array(count * 4)
  const rgba = new Float32Array(count * 4)
  for (let i = 0; i < count; i += 1) {
    const splat = splats[i]
    if (!splat) continue
    center[i * 3] = splat.position[0]
    center[i * 3 + 1] = splat.position[1]
    center[i * 3 + 2] = splat.position[2]
    scale[i * 3] = splat.scale[0]
    scale[i * 3 + 1] = splat.scale[1]
    scale[i * 3 + 2] = splat.scale[2]
    rotation[i * 4] = 1
    rgba[i * 4] = splat.color[0]
    rgba[i * 4 + 1] = splat.color[1]
    rgba[i * 4 + 2] = splat.color[2]
    rgba[i * 4 + 3] = splat.alpha
  }
  return {
    count,
    center,
    scale,
    rotation,
    rgba,
    shDegree: 0,
    droppedShCoefficients: 0,
    name,
    bounds: computeSplatBounds(center, count),
  }
}

/** 色相 → RGB(HSL,S/L 固定,只跑色相环,省得为一条曲线引依赖) */
function hueToRgb(hue: number): Vector3 {
  const h = ((hue % 1) + 1) % 1
  const sector = h * 6
  const f = sector - Math.floor(sector)
  const q = 1 - f
  const table: Record<number, Vector3> = {
    0: [1, f, 0],
    1: [q, 1, 0],
    2: [0, 1, f],
    3: [0, q, 1],
    4: [f, 0, 1],
    5: [1, 0, q],
  }
  return table[Math.floor(sector) % 6] ?? [1, 1, 1]
}

/* ───────────────────────────── 位姿 → 视锥 ───────────────────────────── */

/** 一个待绘制的相机位姿(已归一到 three 约定,单位米) */
export interface ReconstructionPose {
  id: string
  /** 相机中心(光心),不是机身位置 */
  position: Vector3
  /** camera-local → world,`[x,y,z,w]`,相机朝 -Z / 上方 +Y */
  rotation: Quaternion
  horizontalFovDeg: number
  verticalFovDeg: number
}

export interface PoseCloudOptions {
  /** 视锥长度(米);缺省 = 轨迹包围盒对角线的 12%(下限 0.4m) */
  frustumDepth?: number
  /** 相机中心小球半径(米);缺省 = 视锥长度的 10% */
  markerRadius?: number
  /** 是否画相邻相机之间的轨迹,默认 true */
  trail?: boolean
  /** 每条视锥棱上的采样点数,默认 6(含远端角点) */
  ribSamples?: number
  /** 视锥末端方框是否连起来,默认 true */
  frustumRod?: boolean
  /** 数据源名,显示在查看器标题/HUD */
  name?: string
}

/** 从内参推视场角(fx/fy 优先,其次显式给的 fov,最后退到 60°) */
export function fovFromIntrinsics(intrinsics?: {
  width?: number
  height?: number
  fx?: number
  fy?: number
  horizontalFovDeg?: number
  verticalFovDeg?: number
}): { horizontalFovDeg: number; verticalFovDeg: number } {
  const width = intrinsics?.width ?? 0
  const height = intrinsics?.height ?? 0
  const fx = intrinsics?.fx ?? 0
  const fy = intrinsics?.fy ?? 0
  let horizontal = 60
  if (fx > 0 && width > 0) horizontal = (2 * Math.atan(width / (2 * fx))) / DEG
  else if (intrinsics?.horizontalFovDeg && intrinsics.horizontalFovDeg > 1) {
    horizontal = intrinsics.horizontalFovDeg
  }
  let vertical = 0
  if (fy > 0 && height > 0) vertical = (2 * Math.atan(height / (2 * fy))) / DEG
  else if (intrinsics?.verticalFovDeg && intrinsics.verticalFovDeg > 1) {
    vertical = intrinsics.verticalFovDeg
  }
  // 真实照片只有焦距没有画幅时,按 3:2 的经验比例给一个;总比 0 好
  if (!(vertical > 0)) {
    vertical = height > 0 && width > 0 ? (2 * Math.atan((Math.tan((horizontal * DEG) / 2) * height) / width)) / DEG : horizontal * 0.66
  }
  return { horizontalFovDeg: horizontal, verticalFovDeg: vertical }
}

/** 相机局部(camera-local)的四个画幅角点方向,深度为 depth */
function frustumCorners(pose: ReconstructionPose, depth: number): Vector3[] {
  const tx = Math.tan((pose.horizontalFovDeg * DEG) / 2) * depth
  const ty = Math.tan((pose.verticalFovDeg * DEG) / 2) * depth
  const local: Vector3[] = [
    [tx, ty, -depth],
    [-tx, ty, -depth],
    [-tx, -ty, -depth],
    [tx, -ty, -depth],
  ]
  return local.map((corner) => {
    const rotated = rotateVectorByQuaternion(corner, pose.rotation)
    return [
      pose.position[0] + rotated[0],
      pose.position[1] + rotated[1],
      pose.position[2] + rotated[2],
    ] as Vector3
  })
}

function lerp(a: Vector3, b: Vector3, t: number): Vector3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/**
 * 把位姿画成"相机视锥骨架":光心小球 + 四条棱 + 末端方框 + 相邻光心的轨迹。
 *
 * 每个位姿约 `2 + 4·samples + 4·(samples-1)` 个 splat(默认 6 samples ≈ 42 个),
 * 30 张图的采集只有一千出头——比示例场景小两个数量级,任何设备都无压力。
 */
export function posesToCloud(poses: ReconstructionPose[], options: PoseCloudOptions = {}): SplatCloud {
  const usable = poses.filter(
    (pose) =>
      Number.isFinite(pose.position[0]) &&
      Number.isFinite(pose.position[1]) &&
      Number.isFinite(pose.position[2]) &&
      pose.horizontalFovDeg > 0 &&
      pose.verticalFovDeg > 0,
  )
  const name = options.name ?? '采集位姿'
  if (usable.length === 0) return cloudFrom([], name)

  // 尺度按轨迹自身范围推:悬停采集(所有点几乎重合)与 2km 测区都不会画成一样大
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (const pose of usable) {
    minX = Math.min(minX, pose.position[0])
    minY = Math.min(minY, pose.position[1])
    minZ = Math.min(minZ, pose.position[2])
    maxX = Math.max(maxX, pose.position[0])
    maxY = Math.max(maxY, pose.position[1])
    maxZ = Math.max(maxZ, pose.position[2])
  }
  const extent = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ)
  const depth = options.frustumDepth ?? Math.max(extent * 0.12, 0.4)
  const marker = options.markerRadius ?? depth * 0.1
  const samples = Math.max(2, options.ribSamples ?? 6)
  const ribRadius = marker * 0.42
  const trailRadius = marker * 0.3
  const drawRod = options.frustumRod ?? true

  const splats: RawSplat[] = []
  const total = usable.length

  for (let index = 0; index < total; index += 1) {
    const pose = usable[index]
    if (!pose) continue
    // 色相沿航线从青蓝到洋红:同一张图在查看器和影像集里能靠颜色对上序号
    const color = hueToRgb(0.52 - (0.42 * index) / Math.max(1, total - 1))
    splats.push({ position: pose.position, scale: [marker, marker, marker], color, alpha: 1 })

    const corners = frustumCorners(pose, depth)
    for (const corner of corners) {
      for (let step = 1; step <= samples; step += 1) {
        const t = step / samples
        const point = lerp(pose.position, corner, t)
        // 沿棱渐细:近端粗、远端细,视觉上就有透视感
        const radius = ribRadius * (1 - t * 0.55)
        splats.push({ position: point, scale: [radius, radius, radius], color, alpha: 0.72 })
      }
    }
    if (drawRod) {
      const steps = Math.max(3, Math.round(samples * 0.8))
      for (let edge = 0; edge < 4; edge += 1) {
        const from = corners[edge]
        const to = corners[(edge + 1) % 4]
        if (!from || !to) continue
        for (let step = 0; step < steps; step += 1) {
          const t = step / (steps - 1)
          const point = lerp(from, to, t)
          splats.push({
            position: point,
            scale: [ribRadius * 0.5, ribRadius * 0.5, ribRadius * 0.5],
            color,
            alpha: 0.6,
          })
        }
      }
    }
  }

  // 轨迹:相邻光心之间按 8cm 或 1/24 段插值,长航线也不会变成虚线
  if (options.trail ?? true) {
    for (let index = 1; index < total; index += 1) {
      const previous = usable[index - 1]
      const current = usable[index]
      if (!previous || !current) continue
      const span = Math.hypot(
        current.position[0] - previous.position[0],
        current.position[1] - previous.position[1],
        current.position[2] - previous.position[2],
      )
      const steps = Math.max(2, Math.min(64, Math.ceil(span / Math.max(0.08, depth * 0.05))))
      for (let step = 0; step < steps; step += 1) {
        const t = step / steps
        splats.push({
          position: lerp(previous.position, current.position, t),
          scale: [trailRadius, trailRadius, trailRadius],
          color: [0.35, 0.95, 0.85],
          alpha: 0.9,
        })
      }
    }
  }

  return cloudFrom(splats, name)
}

/* ─────────────────────── 采集会话 / manifest → 位姿 ─────────────────────── */

export type CaptureLike = CaptureSession | CaptureManifest

export interface CapturePoseOptions extends PoseCloudOptions {
  /**
   * 采集位姿的四元数约定。虚拟采集写的是 `'three'`(与 three 相机一致,默认);
   * 从 COLMAP / OpenCV 导入的真照片位姿要传 `'colmap'`。
   */
  sourceCameraConvention?: CameraAxisConvention
  /**
   * ECEF → ENU 的帧(Cesium 后端的采集位姿是 ECEF)。
   * 不传则从 manifest 的 `coordinateFrame.transform.origin` 或 session 的 `georeference` 推;
   * 两者都没有时,ECEF 位姿会被跳过 —— 直接把 6.3e6 米量级的坐标画出来,
   * 视锥和取景都会失效,而那看起来只是"场景有点大"。
   */
  enuFrame?: EcefEnuFrame
  /** 收集被跳过的图与原因(诊断用) */
  onSkip?: (id: string, reason: string) => void
}

interface PoseCandidate {
  id: string
  position?: number[]
  rotation?: number[]
  coordinateFrame?: string
  horizontalFovDeg?: number
  verticalFovDeg?: number
  status?: string
}

function isManifest(input: CaptureLike): input is CaptureManifest {
  // manifest 有 schemaVersion,session 有 options;用前者判定(后者在 manifest 里不存在)
  return typeof (input as CaptureManifest).schemaVersion === 'number'
}

function poseCandidates(input: CaptureLike): PoseCandidate[] {
  if (isManifest(input)) {
    const libraryCamera = input.camera
    return (input.images ?? []).map((image: CaptureManifestImage) => ({
      id: image.id,
      position: image.position,
      rotation: image.rotation,
      coordinateFrame: typeof image.coordinateFrame === 'string' ? image.coordinateFrame : undefined,
      ...pickFov(image.intrinsics ?? libraryCamera),
      status: image.captureStatus,
    }))
  }
  return (input.images ?? []).map((image) => ({
    id: image.id,
    position: image.cameraPose?.position,
    rotation: image.cameraPose?.rotation,
    coordinateFrame: image.cameraPose?.coordinateFrame,
    ...pickFov(image.cameraIntrinsics),
    status: image.validation?.status,
  }))
}

function pickFov(intrinsics?: {
  width?: number
  height?: number
  fx?: number
  fy?: number
  horizontalFovDeg?: number
  verticalFovDeg?: number
}): { horizontalFovDeg?: number; verticalFovDeg?: number } {
  if (!intrinsics) return {}
  const fov = fovFromIntrinsics(intrinsics)
  return { horizontalFovDeg: fov.horizontalFovDeg, verticalFovDeg: fov.verticalFovDeg }
}

/** 从 manifest 的 transform.origin 或 session 的 georeference 推出 ENU 帧 */
export function enuFrameFromCapture(input: CaptureLike): EcefEnuFrame | null {
  if (isManifest(input)) {
    const origin = input.coordinateFrame?.transform?.origin
    if (!origin || !Number.isFinite(origin.longitude) || !Number.isFinite(origin.latitude)) return null
    return createEcefEnuFrame({
      longitude: origin.longitude,
      latitude: origin.latitude,
      altitude: Number.isFinite(origin.altitude) ? origin.altitude : 0,
    })
  }
  const origin = input.options?.georeference
  if (!origin || !Number.isFinite(origin.longitude) || !Number.isFinite(origin.latitude)) return null
  return createEcefEnuFrame({
    longitude: origin.longitude,
    latitude: origin.latitude,
    altitude: Number.isFinite(origin.altitude) ? origin.altitude : 0,
  })
}

/**
 * 会话 / manifest → 位姿列表(丢掉没有位姿、以及采集失败的图)。
 *
 * 输出一律在 **local-enu** 或 **project-local** 里,四元数一律是 three 相机约定。
 * Cesium 后端的位姿是 ECEF,这里顺手换到 ENU —— 否则点云落在 6.3e6 米外,
 * float32 的精度(约 0.5 米)连"场景在哪"都保不住。
 */
export function capturePoses(input: CaptureLike, options: CapturePoseOptions = {}): ReconstructionPose[] {
  const convention = options.sourceCameraConvention ?? 'three'
  const enuFrame = options.enuFrame ?? enuFrameFromCapture(input)
  const poses: ReconstructionPose[] = []
  for (const candidate of poseCandidates(input)) {
    if (candidate.status === 'failed' || candidate.status === 'invalid') {
      options.onSkip?.(candidate.id, `状态=${candidate.status}`)
      continue
    }
    const position = candidate.position
    const rotation = candidate.rotation
    if (!position || position.length < 3 || !rotation || rotation.length < 4) {
      options.onSkip?.(candidate.id, '缺少位姿')
      continue
    }
    const [px, py, pz] = position as [number, number, number]
    const quaternion: Quaternion = [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1]
    if (![px, py, pz, ...quaternion].every((value) => Number.isFinite(value))) {
      options.onSkip?.(candidate.id, '位姿含非有限值')
      continue
    }
    if (Math.hypot(quaternion[0], quaternion[1], quaternion[2], quaternion[3]) < 1e-9) {
      options.onSkip?.(candidate.id, '四元数为零长度')
      continue
    }
    let worldPosition: Vector3 = [px, py, pz]
    let worldRotation = quaternion
    if (candidate.coordinateFrame === 'ecef') {
      if (!enuFrame) {
        options.onSkip?.(candidate.id, 'ECEF 位姿缺少 ENU 原点')
        continue
      }
      worldPosition = ecefToEnu(worldPosition, enuFrame)
      // 先换世界系(ECEF→ENU),再换相机局部约定;两步互相独立
      worldRotation = ecefQuaternionToEnu(worldRotation, enuFrame)
    }
    poses.push({
      id: candidate.id,
      position: worldPosition,
      rotation:
        convention === 'three'
          ? worldRotation
          : convertCameraQuaternion(worldRotation, convention, 'three'),
      horizontalFovDeg: candidate.horizontalFovDeg ?? 60,
      verticalFovDeg: candidate.verticalFovDeg ?? 40,
    })
  }
  return poses
}

/**
 * 采集会话 / manifest → 视锥骨架点云。
 *
 * 这是"零重建"的位姿自检:真数据进去,真位姿出来,不经过任何示例几何。
 */
export function capturePosesToCloud(input: CaptureLike, options: CapturePoseOptions = {}): SplatCloud {
  let skipped = 0
  const poses = capturePoses(input, {
    ...options,
    onSkip: (id, reason) => {
      skipped += 1
      options.onSkip?.(id, reason)
    },
  })
  const suffix = skipped > 0 ? ` · 跳过 ${skipped}` : ''
  return posesToCloud(poses, { ...options, name: options.name ?? `采集位姿 · ${poses.length} 张${suffix}` })
}

/* ────────────────────────────── COLMAP 输出 ────────────────────────────── */

export interface ColmapCameraRecord {
  id: number
  model: string
  width: number
  height: number
  params: number[]
}

export interface ColmapObservation {
  x: number
  y: number
  /** 观测到的 3D 点 id;0 / -1 = 该观测未三角化 */
  point3DId: number
}

export interface ColmapImageRecord {
  id: number
  /** world → camera,colmap 约定([w,x,y,z]) */
  qvec: [number, number, number, number]
  tvec: [number, number, number]
  cameraId: number
  name: string
  points2D: ColmapObservation[]
}

export interface ColmapPointRecord {
  id: number
  position: Vector3
  color: [number, number, number]
  /** 重投影误差(像素) */
  error: number
  /** [image_id, point2D_idx] 列表 */
  track: Array<[number, number]>
}

export interface ColmapDataset {
  cameras: ColmapCameraRecord[]
  images: ColmapImageRecord[]
  points: ColmapPointRecord[]
  /** 解析期的非致命问题(坏行、缺文件、字段不足) */
  warnings: string[]
  /** 平均 track 长度:小于 2 说明点几乎没被多视图确认 */
  meanTrackLength: number
  /** 平均重投影误差(像素) */
  meanError: number
}

export interface ColmapDatasetText {
  camerasTxt?: string
  imagesTxt?: string
  points3Dtxt?: string
}

function stripComments(text: string): string[] {
  // ⚠️ 只去注释行,保留空行:images.txt 里每张图的第二行(2D 观测)可以**就是空行**,
  // 按空行过滤会让后续所有图像错位一行,而且读出来"看起来还挺正常"。
  return text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line))
}

function numbers(fields: string[], count: number): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i += 1) {
    const value = Number(fields[i])
    if (!Number.isFinite(value)) return []
    out.push(value)
  }
  return out
}

/** 解析 COLMAP 的 `cameras.txt` / `images.txt` / `points3D.txt`(任意子集都可) */
export function parseColmapDataset(input: ColmapDatasetText): ColmapDataset {
  const warnings: string[] = []
  const cameras: ColmapCameraRecord[] = []
  const images: ColmapImageRecord[] = []
  const points: ColmapPointRecord[] = []

  if (input.camerasTxt) {
    for (const raw of stripComments(input.camerasTxt)) {
      const line = raw.trim()
      if (!line) continue
      const fields = line.split(/\s+/)
      if (fields.length < 5) {
        warnings.push(`cameras.txt 跳过字段不足的行:${line.slice(0, 60)}`)
        continue
      }
      const id = Number(fields[0])
      const width = Number(fields[2])
      const height = Number(fields[3])
      const params = fields.slice(4).map(Number).filter((value) => Number.isFinite(value))
      if (!Number.isFinite(id) || !Number.isFinite(width) || !Number.isFinite(height)) {
        warnings.push(`cameras.txt 跳过非数字行:${line.slice(0, 60)}`)
        continue
      }
      cameras.push({ id, model: fields[1] ?? 'PINHOLE', width, height, params })
    }
  }

  if (input.imagesTxt) {
    const lines = stripComments(input.imagesTxt)
    let index = 0
    while (index < lines.length) {
      const line = (lines[index] ?? '').trim()
      if (!line) {
        index += 1
        continue
      }
      const fields = line.split(/\s+/)
      const head = numbers(fields, 9)
      if (fields.length < 10 || head.length < 9) {
        warnings.push(`images.txt 跳过无法识别的行:${line.slice(0, 60)}`)
        index += 1
        continue
      }
      const id = head[0] ?? 0
      const qw = head[1] ?? 1
      const qx = head[2] ?? 0
      const qy = head[3] ?? 0
      const qz = head[4] ?? 0
      const tx = head[5] ?? 0
      const ty = head[6] ?? 0
      const tz = head[7] ?? 0
      const cameraId = head[8] ?? 0
      const name = fields.slice(9).join(' ')
      const observationLine = (lines[index + 1] ?? '').trim()
      const points2D: ColmapObservation[] = []
      if (observationLine) {
        const values = observationLine.split(/\s+/).map(Number)
        for (let i = 0; i + 2 < values.length; i += 3) {
          const x = values[i]
          const y = values[i + 1]
          const point3DId = values[i + 2]
          if (x === undefined || y === undefined || point3DId === undefined) break
          if (![x, y, point3DId].every((value) => Number.isFinite(value))) {
            warnings.push(`images.txt 第 ${id} 张的 2D 观测含非数字,已截断`)
            break
          }
          points2D.push({ x, y, point3DId })
        }
      }
      images.push({
        id,
        qvec: [qw, qx, qy, qz],
        tvec: [tx, ty, tz],
        cameraId,
        name,
        points2D,
      })
      // 每张图固定占两行(第二行可以是空行)——这是 COLMAP 的定位方式
      index += 2
    }
  }

  if (input.points3Dtxt) {
    for (const raw of stripComments(input.points3Dtxt)) {
      const line = raw.trim()
      if (!line) continue
      const fields = line.split(/\s+/)
      if (fields.length < 8) {
        warnings.push(`points3D.txt 跳过字段不足的行:${line.slice(0, 60)}`)
        continue
      }
      const head = numbers(fields, 8)
      if (head.length < 8) {
        warnings.push(`points3D.txt 跳过非数字行:${line.slice(0, 60)}`)
        continue
      }
      const id = head[0] ?? 0
      const x = head[1] ?? 0
      const y = head[2] ?? 0
      const z = head[3] ?? 0
      const r = head[4] ?? 255
      const g = head[5] ?? 255
      const b = head[6] ?? 255
      const error = head[7] ?? 0
      const track: Array<[number, number]> = []
      for (let i = 8; i + 1 < fields.length; i += 2) {
        const imageId = Number(fields[i])
        const pointIndex = Number(fields[i + 1])
        if (Number.isFinite(imageId) && Number.isFinite(pointIndex)) track.push([imageId, pointIndex])
      }
      points.push({ id, position: [x, y, z], color: [r, g, b], error, track })
    }
  }

  if (!input.imagesTxt) warnings.push('没有 images.txt:位姿为空')
  if (!input.points3Dtxt) warnings.push('没有 points3D.txt:只有位姿,没有 sparse 点')

  const trackTotal = points.reduce((sum, point) => sum + point.track.length, 0)
  const errorTotal = points.reduce((sum, point) => sum + point.error, 0)
  return {
    cameras,
    images,
    points,
    warnings,
    meanTrackLength: points.length > 0 ? trackTotal / points.length : 0,
    meanError: points.length > 0 ? errorTotal / points.length : 0,
  }
}

/** 从 `+Z` 前向的 colmap 相机模型推视场角 */
function colmapCameraFov(camera: ColmapCameraRecord | undefined): { horizontalFovDeg: number; verticalFovDeg: number } {
  if (!camera) return { horizontalFovDeg: 60, verticalFovDeg: 40 }
  // SIMPLE_PINHOLE: f, cx, cy;PINHOLE: fx, fy, cx, cy;OPENCV 等前两个也是 fx, fy
  const isSimple = camera.model === 'SIMPLE_PINHOLE' || camera.model === 'SIMPLE_RADIAL'
  const fx = camera.params[0] ?? 0
  const fy = isSimple ? fx : (camera.params[1] ?? fx)
  return fovFromIntrinsics({
    width: camera.width,
    height: camera.height,
    fx,
    fy,
  })
}

/**
 * `images.txt` 的 `qvec/tvec` → 相机中心 + three 约定的朝向。
 *
 * 两个必须算对的地方:
 * - **中心是 `-Rᵀ·tvec` 而不是 `tvec`**。`tvec` 是"世界原点在相机系里的位置",
 *   直接当平移用,所有相机会绕着原点转。
 * - **qvec 是 world→camera,还要换相机局部系**。`convertCameraQuaternion` 负责
 *   colmap(+Z 前向 / +Y 向下)→ three(-Z 前向 / +Y 向上),它只改局部系,不动世界。
 */
export function colmapImagesToPoses(dataset: ColmapDataset): ReconstructionPose[] {
  const byId = new Map(dataset.cameras.map((camera) => [camera.id, camera]))
  const poses: ReconstructionPose[] = []
  for (const image of dataset.images) {
    const [qw, qx, qy, qz] = image.qvec
    const length = Math.hypot(qw, qx, qy, qz)
    if (!(length > 1e-9)) continue
    const normalized: Quaternion = [qx / length, qy / length, qz / length, qw / length]
    // ⚠️ qvec 是 **world→camera**;`convertCameraQuaternion` 要的是 camera→world,
    // 所以必须先取共轭。少了这一步,中心还是对的(tvec 的换算也用同一个共轭),
    // 但朝向会整体歪掉 —— 表现为视锥全都朝偏一个角度,而位置完全正确,极难察觉。
    const inverse: Quaternion = [-normalized[0], -normalized[1], -normalized[2], normalized[3]]
    // Rᵀ·tvec = q⁻¹ 作用到 tvec
    const rotated = rotateVectorByQuaternion(image.tvec, inverse)
    const fov = colmapCameraFov(byId.get(image.cameraId))
    poses.push({
      id: String(image.id),
      position: [-rotated[0], -rotated[1], -rotated[2]],
      rotation: convertCameraQuaternion(inverse, 'colmap', 'three'),
      horizontalFovDeg: fov.horizontalFovDeg,
      verticalFovDeg: fov.verticalFovDeg,
    })
  }
  return poses
}

export interface ColmapCloudOptions extends PoseCloudOptions {
  /** 是否把相机视锥也画出来,默认 true */
  showCameras?: boolean
  /** 点的统一半径(米);缺省按包围盒对角线 / 500 */
  pointRadius?: number
  /** 点的着色方式:原始 RGB(默认)或按重投影误差(误差越大越红) */
  colorBy?: 'rgb' | 'error'
  /** 重投影误差超过该值算"红点",默认 1.0 像素 */
  errorScale?: number
}

/**
 * COLMAP 的 sparse 点云(+ 可选视锥)→ `SplatCloud`。
 *
 * 点是各向同性小球:**不要**给它们编造尺度。真实 3DGS 训练会从这些点出发,各自学出
 * 各向异性的椭球;在查看器里假装已知形状只会掩盖误差。
 */
export function colmapDatasetToCloud(
  dataset: ColmapDataset,
  options: ColmapCloudOptions = {},
): SplatCloud {
  const splats: RawSplat[] = []
  const positions: Vector3[] = dataset.points.map((point) => point.position)
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (const [x, y, z] of positions) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    maxZ = Math.max(maxZ, z)
  }
  const diagonal = positions.length > 0 ? Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) : 0
  const radius = options.pointRadius ?? (diagonal > 0 ? Math.max(diagonal / 500, 1e-4) : 0.02)
  const errorScale = Math.max(0.05, options.errorScale ?? 1)
  const colorBy = options.colorBy ?? 'rgb'

  for (const point of dataset.points) {
    let color: Vector3
    if (colorBy === 'error') {
      // 0 → 青绿,≥errorScale → 品红;夹在中段是为了让"正常点"不抢视觉
      const t = Math.min(1, Math.max(0, point.error / errorScale))
      color = [0.2 + t * 0.8, 0.85 - t * 0.7, 0.45 - t * 0.35]
    } else {
      color = [point.color[0] / 255, point.color[1] / 255, point.color[2] / 255]
    }
    splats.push({ position: point.position, scale: [radius, radius, radius], color, alpha: 0.95 })
  }

  if (options.showCameras ?? true) {
    // 视锥的尺度必须跟着点云走:posesToCloud 默认按"位姿范围"推尺寸,但点云范围
    // 通常远大于轨迹范围(相机站得远、拍得近),不覆盖就会出现 3km 点云配 30cm 视锥
    const frustumCloud = posesToCloud(colmapImagesToPoses(dataset), {
      ...options,
      frustumDepth: options.frustumDepth ?? Math.max(diagonal * 0.08, 0.05),
      trail: options.trail ?? true,
      name: options.name ?? 'COLMAP sparse',
    })
    for (let i = 0; i < frustumCloud.count; i += 1) {
      splats.push({
        position: [
          frustumCloud.center[i * 3] ?? 0,
          frustumCloud.center[i * 3 + 1] ?? 0,
          frustumCloud.center[i * 3 + 2] ?? 0,
        ],
        scale: [
          frustumCloud.scale[i * 3] ?? radius,
          frustumCloud.scale[i * 3 + 1] ?? radius,
          frustumCloud.scale[i * 3 + 2] ?? radius,
        ],
        color: [
          frustumCloud.rgba[i * 4] ?? 1,
          frustumCloud.rgba[i * 4 + 1] ?? 1,
          frustumCloud.rgba[i * 4 + 2] ?? 1,
        ],
        alpha: frustumCloud.rgba[i * 4 + 3] ?? 1,
      })
    }
  }

  const name =
    options.name ??
    `COLMAP · ${dataset.images.length} 位姿 / ${dataset.points.length} 点${
      dataset.points.length > 0 ? ` · 重投影 ${dataset.meanError.toFixed(2)}px` : ''
    }`
  return cloudFrom(splats, name)
}

/**
 * 从文件列表里认出 COLMAP 三件套。
 *
 * 用户通常会把 `sparse/0/` 整个目录拖进来,里面还有 `project.ini`、`frames.txt` 之类的
 * 杂项;按文件名匹配比按内容猜稳得多(`cameras.txt` 的内容太容易和别的东西撞)。
 */
export function colmapTextFromFiles(
  files: Array<{ name: string; text: string }>,
): { input: ColmapDatasetText; matched: string[]; ignored: string[] } {
  const input: ColmapDatasetText = {}
  const matched: string[] = []
  const ignored: string[] = []
  for (const file of files) {
    const base = file.name.split(/[\\/]/).pop() ?? file.name
    if (/^cameras.*\.txt$/i.test(base)) {
      input.camerasTxt = file.text
      matched.push(base)
    } else if (/^images.*\.txt$/i.test(base)) {
      input.imagesTxt = file.text
      matched.push(base)
    } else if (/^points3d.*\.txt$/i.test(base)) {
      input.points3Dtxt = file.text
      matched.push(base)
    } else {
      ignored.push(base)
    }
  }
  return { input, matched, ignored }
}
