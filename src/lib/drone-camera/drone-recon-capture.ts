/**
 * 重建采集 —— 为 3DGS / SfM 拍数据集的轨迹规划与执行。
 *
 * ── 与全景采集的关系:同一套后端能力,相反的几何 ─────────────────────────
 *
 * `drone-panorama` 的全景扫描是**光心不动、只转朝向**(靠 `spinBodyTo` 原地自转),
 * 因为拼接要的是"视差≈0",接缝才拼得平。重建要的恰好相反:**光心必须移动**。
 * 两条来自同一点的光线如果都在同一个光心出发,三角化是退化的 —— 任何深度的假设
 * 都与像素完全自洽,于是 SfM 只能解出一个纯旋转,点云近似为零,3DGS 只能得到
 * 一层贴在球面上的纹理,绕着走两步就露馅。
 *
 * 所以本模块的拍点一律**带位移**,并按"相邻光心间距 / 拍摄距离"这个比值来定密度。
 *
 * ── 一个值得记住的等价关系:b/d 就是重叠率 ──────────────────────────────
 *
 * 相邻两个光心相距 `b`、到被摄面距离 `d`,它们之间的夹角是 `θ ≈ b/d`(小角);
 * 而"重叠率 o"要求角步进 `θ <= fov·(1-o)`。两式合起来:
 *
 *     b/d ≈ fov·(1-o)
 *
 * 也就是说**给重叠率就等于给 b/d**,它们是同一条约束的两种写法。60° 水平视场下:
 *
 * | 重叠率 | 角步进 | b/d | 判定 |
 * |---|---|---|---|
 * | 60% | 24° | 0.42 | 基线太长,跨视角匹配开始掉 |
 * | 70% | 18° | 0.31 | 边缘 |
 * | **75%** | **15°** | **0.26** | 最佳区 |
 * | 85% | 9° | 0.16 | 安全但张数翻倍 |
 * | 92% | 4.8° | 0.08 | 基线不足,深度病态(误差 ∝ d²/b) |
 *
 * 这就是为什么"多拍几张总没错"是错的:拍到 92% 重叠时,张数翻了一倍,
 * 深度精度反而掉了。本模块因此会在 b/d 越界时给出警告,而不是默默接受参数。
 *
 * ── 三种轨迹 ──────────────────────────────────────────────────────────
 *
 * - `orbit` 环绕:单体(楼 / 水塔 / 设备)。2~3 圈不同半径与高度,内圈补屋檐底面。
 * - `grid-tilt` 网格 + 五向倾斜:大面积地块。正射 + 四向 45° 倾斜,只拍正射立面会塌。
 * - `sphere` 球壳:小物体 / 室内。方位 × 俯仰双层,避开正上正下。
 *
 * ── 坐标约定 ─────────────────────────────────────────────────────────
 *
 * 全部在 **local-enu**(x 东 / y 北 / z 上,米)里算,与 `getCaptureCamera().pose.position`
 * 同一坐标系 —— 于是"设计位姿"与"采集回来的真值位姿"可以直接比较,不需要任何换算。
 *
 * ```ts
 * const plan = planReconCapture({ pattern: 'orbit', target: { center: [0, 0, 8], size: [24, 18, 16] } })
 * plan.baselineRatio          // 0.26 -> 可三角化
 * const recon = new ReconstructionCapture(captureService)
 * const result = await recon.start(session.id, plan)
 * result.coverage.usable      // 0.87 -> 87% 的表面点被 >=3 个视角看到
 * ```
 */
import type { CaptureService, CaptureSession, CapturedImage, ReconShotRef } from './drone-capture'
import type { Quaternion, Vector3 } from './drone-photogrammetry'
import { cameraQuaternionFromBasis, rotateVectorByQuaternion } from './drone-photogrammetry'
import type { ReconstructionPose } from './drone-reconstruction-source'
import { capturePoses } from './drone-reconstruction-source'
import type { MissionWaypoint } from './drone-sim'
import type { SplatCloud } from './drone-splat'
import { computeSplatBounds } from './drone-splat'

const DEG = Math.PI / 180

/** 相机水平视场缺省值(与项目其余部分一致:水平固定 60°,垂直随窗口宽高比) */
const DEFAULT_HORIZONTAL_FOV = 60
const DEFAULT_VERTICAL_FOV = 40
/** 取景余量:刚好装下主体后再放宽 15%,避免边缘切掉**/
const FRAMING_MARGIN = 1.15
/** 远景(航测 / 网格)的 b/d 建议区间 */
export const USABLE_BASELINE_RATIO: readonly [number, number] = [0.1, 0.3]
/**
 * 近景环绕的 b/d 建议区间。
 *
 * 不是"放宽标准",而是同一个比值在不同 d/R 下的必然结果:`b = 2R·sin(θ/2)` 里的 R 是
 * **光心半径**,而景深是 `R − h`。贴着一个 20 m 宽的楼绕飞时 `R/(R−h) ≈ 1.4`,
 * 于是 75% 重叠(θ=15°)天然给出 b/d ≈ 0.38 —— 这在几何上完全正常,若按远景标准
 * 去"修正",只会把张数堆到三倍而毫无收益。
 */
export const USABLE_BASELINE_RATIO_NEAR: readonly [number, number] = [0.15, 0.5]
/**
 * 硬上限:超过这个值跨视角特征匹配会真的开始掉点,规划器必须加密来压住它。
 * 它比两个"建议区间"都宽 —— 建议区间是提醒,这个是约束。
 */
export const MAX_BASELINE_RATIO = 0.6
/** 3DGS 认为"够用"的最少观测视角数 */
export const MIN_USABLE_VIEWS = 3
/** 视角数直方图的上限(超过的并入最后一格) */
const HISTOGRAM_CAP = 8
/** 内圈光心到主体角的最小景深(米):再近就没有拍摄价值了 */
const MIN_INNER_DEPTH_M = 3
/** 每张的估计耗时(秒):含定位、转向、曝光 —— 真机实测在 0.6~1.2 s */
const SECONDS_PER_SHOT = 0.8

export type ReconPattern = 'orbit' | 'grid-tilt' | 'sphere'

export type Vector3Tuple = [number, number, number]

/** 被摄主体:中心 + 尺寸,都在 local-enu 米制 */
export interface ReconTarget {
  center: Vector3Tuple
  /** 主体外接盒尺寸(x 东向宽 / y 北向深 / z 高) */
  size: Vector3Tuple
}

/** 一个拍点(规划结果,不含"实际拍到没有") */
export interface ReconShot {
  /** 组内序号(1 起,按拍摄顺序) */
  index: number
  /** 环绕:第几圈;网格 / 球壳:0 */
  ring: number
  /** 网格行(0 起) */
  row: number
  /** 网格列(0 起) */
  col: number
  /** 光心位置(local-enu,米) */
  position: Vector3Tuple
  /** 机身航向(度,罗盘角 0=北 90=东);相机与机身同向 */
  heading: number
  /** 取景俯仰(度,负 = 下视) */
  pitch: number
  /** 相机朝向(three 相机约定,ENU 世界)—— 视锥绘制与覆盖统计用 */
  rotation: Quaternion
  /** 到主体中心的距离(米) */
  distance: number
}

export interface ReconPlanOptions {
  pattern: ReconPattern
  target: ReconTarget
  horizontalFovDeg?: number
  verticalFovDeg?: number
  /** 沿轨迹方向的重叠率(0~1),缺省 0.75 */
  alongTrackOverlap?: number
  /** 旁向(垂直轨迹方向)的重叠率,缺省 0.65 */
  sideOverlap?: number
  /** 环绕圈数,缺省 3 */
  rings?: number
  /** 网格:相对**主体顶面**的飞行高度(米),缺省 40 */
  altitude?: number
  /** 网格:倾斜角(度),缺省 45;传 0 只拍正射 */
  tiltDeg?: number
  /** 球壳:俯仰范围(度),缺省 [-60, 60] */
  elevationRangeDeg?: [number, number]
}

export interface ReconPlan {
  pattern: ReconPattern
  label: string
  target: ReconTarget
  shots: ReconShot[]
  total: number
  horizontalFovDeg: number
  verticalFovDeg: number
  /** 相邻光心间距 / 拍摄距离的中位数;落在 USABLE_BASELINE_RATIO 内才可三角化 */
  baselineRatio: number
  /** 拍摄距离中位数(米) */
  medianDistance: number
  /**
   * 实际达到的沿轨重叠率(0~1)。
   *
   * 它可能**高于**传入值:b/d 上限是硬约束,重叠率只是下限密度。近距离环绕时
   * b/d 常常先撞线,于是调重叠率看不到张数变化 —— 这个字段就是那种情况的反馈,
   * 免得以为参数没生效。
   */
  effectiveOverlap: number
  /** 网格模式的单张地面足迹(米) */
  footprint?: { along: number; across: number }
  /** 按每张 0.8 s 估的采集耗时(秒) */
  estimatedSeconds: number
  warnings: string[]
}

// ─────────────────────────────── 向量小工具 ───────────────────────────────

function sub(a: Vector3Tuple, b: Vector3Tuple): Vector3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ]
}

function normalize(v: Vector3): Vector3 {
  const length = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0)
  if (length < 1e-9) return [0, 1, 0]
  return [(v[0] ?? 0) / length, (v[1] ?? 0) / length, (v[2] ?? 0) / length]
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** 罗盘角收敛到 [0, 360) */
function normalizeHeading(deg: number): number {
  return ((deg % 360) + 360) % 360
}

// ─────────────────────────────── 位姿构造 ───────────────────────────────

/**
 * 由「站哪、朝哪个方位、抬头多少」直接构造相机四元数。
 *
 * 不用 lookAt 到目标点:环绕的相机指向中心、网格的倾斜相机指向航线外侧,
 * 两者用同一个 `(heading, pitch)` 参数化更一致 —— 而且这正是机载云台的实际自由度
 * (航向由机身给,俯仰由云台给)。
 */
function poseFromHeadingPitch(heading: number, pitch: number): Quaternion {
  const h = heading * DEG
  const p = pitch * DEG
  const forward: Vector3 = [
    Math.sin(h) * Math.cos(p),
    Math.cos(h) * Math.cos(p),
    Math.sin(p),
  ]
  // 正下视 / 正上视时 forward 与世界上方平行,基向量退化 —— 换一个参考轴
  const worldUp: Vector3 = Math.abs(forward[2] ?? 0) > 0.999 ? [0, 1, 0] : [0, 0, 1]
  const right = normalize(cross(forward, worldUp))
  const up = cross(right, forward)
  return cameraQuaternionFromBasis({ right, up, forward }, 'three')
}

/**
 * 光心到**主体表面**的最近距离 —— 三角化公式里的景深 z 就是这个量。
 *
 * 用"到中心"会低估 b/d:环绕一个半径 5 m 的楼、光心在 15.8 m 处时,
 * 到中心 15.8 而到表面只有 10.8,同样的角步进对应的 b/d 差 46%。
 * 近距环绕必须比航测更大的重叠率,原因就在这里。
 */
function surfaceDistance(position: Vector3Tuple, target: ReconTarget): number {
  const gaps: number[] = []
  for (let axis = 0; axis < 3; axis += 1) {
    const outside = Math.abs((position[axis] ?? 0) - (target.center[axis] ?? 0)) - (target.size[axis] ?? 0) / 2
    gaps.push(Math.max(0, outside))
  }
  return Math.max(0.5, Math.hypot(gaps[0] ?? 0, gaps[1] ?? 0, gaps[2] ?? 0))
}

function makeShot(
  input: {
    index: number
    ring: number
    row: number
    col: number
    position: Vector3Tuple
    heading: number
    pitch: number
  },
  target: ReconTarget,
): ReconShot {
  const heading = normalizeHeading(input.heading)
  return {
    index: input.index,
    ring: input.ring,
    row: input.row,
    col: input.col,
    position: [input.position[0], input.position[1], input.position[2]],
    heading,
    pitch: input.pitch,
    rotation: poseFromHeadingPitch(heading, input.pitch),
    distance: surfaceDistance(input.position, target),
  }
}

/** 把整个主体刚好装进画面所需的距离 */
function framingDistance(target: ReconTarget, hfovDeg: number, vfovDeg: number): number {
  const halfW = Math.max(target.size[0], target.size[1]) / 2
  const halfH = target.size[2] / 2
  const byWidth = halfW / Math.max(1e-3, Math.tan((hfovDeg * DEG) / 2))
  const byHeight = halfH / Math.max(1e-3, Math.tan((vfovDeg * DEG) / 2))
  return Math.max(byWidth, byHeight, 2) * FRAMING_MARGIN
}

/**
 * 解算某个半径上的角度步进(度)。
 *
 * 取**两个约束中更严格**的那个:
 * - 重叠率给的是"下限密度" `fov·(1-o)`;
 * - 三角化的硬约束是 `b/d <= 0.3`,而 `b/d ≈ θ·R/d`,于是 `θ <= 0.3·d/R`。
 *
 * 近距离环绕时后者更紧(内圈半径小、景深也小,但比值更不利),这正是"拍近处要比
 * 拍地面更密"的量化来源 —— 不是凭经验,是同一个不等式在不同 d/R 下的结果。
 */
function ringStep(hfovDeg: number, overlap: number, radius: number, depth: number): number {
  const byOverlap = angularStep(hfovDeg, overlap)
  if (radius <= 0 || depth <= 0) return byOverlap
  const byBaseline = ((MAX_BASELINE_RATIO * depth) / radius) / DEG
  return Math.max(1.5, Math.min(byOverlap, byBaseline))
}

/**
 * 绕一整圈时**最不利方位**的景深。
 *
 * 正对主体那一面时景深最大,斜对着盒角时最小(方盒约 0.81 倍)。规划必须按最不利值算:
 * 否则绕到对角时 b/d 就悄悄越界,而规划报告上仍显示"合格" —— 这正是那种
 * "指标好看、结果难看"的经典错法。
 */
function ringMinDepth(
  center: Vector3Tuple,
  radius: number,
  z: number,
  target: ReconTarget,
): number {
  let min = Infinity
  for (let i = 0; i < 8; i += 1) {
    const rad = i * 45 * DEG
    const position: Vector3Tuple = [
      center[0] + Math.sin(rad) * radius,
      center[1] + Math.cos(rad) * radius,
      z,
    ]
    min = Math.min(min, surfaceDistance(position, target))
  }
  return Number.isFinite(min) ? min : radius
}

/** 由重叠率得到的角度步进(度) —— 它同时就是 b/d(见文件头) */
function angularStep(fovDeg: number, overlap: number): number {
  return Math.max(2, fovDeg * (1 - clamp01(overlap)))
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(0.95, Math.max(0, value)) : 0
}

// ─────────────────────────────── 轨迹规划 ───────────────────────────────

/**
 * 规划一次重建采集。
 *
 * 纯函数:不碰渲染后端、不碰采集服务,只做几何。因此可以拿去给 UI 预览、
 * 给真机导出航线、或者在一次采集开始前先做"这样拍够不够"的判定。
 */
export function planReconCapture(options: ReconPlanOptions): ReconPlan {
  const hfov = options.horizontalFovDeg ?? DEFAULT_HORIZONTAL_FOV
  const vfov = options.verticalFovDeg ?? DEFAULT_VERTICAL_FOV
  // 缺省重叠率按模式给:景深越近,同样的角步进对应越大的 b/d(见 surfaceDistance)
  const defaultAlong = options.pattern === 'orbit' ? 0.82 : options.pattern === 'sphere' ? 0.8 : 0.75
  const along = clamp01(options.alongTrackOverlap ?? defaultAlong)
  const side = clamp01(options.sideOverlap ?? 0.65)
  const target = options.target

  let shots: ReconShot[] = []
  let footprint: { along: number; across: number } | undefined
  let label = ''
  let effectiveOverlap = along

  if (options.pattern === 'orbit') {
    label = `${options.rings ?? 3} 圈环绕`
    const orbit = planOrbit(target, options.rings ?? 3, hfov, vfov, along)
    shots = orbit.shots
    // 张数由最密的那圈决定,报告也按它算才算诚实
    effectiveOverlap = 1 - orbit.stepDeg / Math.max(1, hfov)
  } else if (options.pattern === 'grid-tilt') {
    const tilt = options.tiltDeg ?? 45
    label = tilt > 0 ? `网格 + ${tilt}° 五向倾斜` : '网格正射'
    const grid = planGrid(target, options.altitude ?? 40, hfov, vfov, along, side, tilt)
    shots = grid.shots
    footprint = grid.footprint
    effectiveOverlap = 1 - grid.colGap / Math.max(1e-3, grid.footprint.along)
  } else {
    label = '球壳环绕'
    const sphere = planSphere(target, hfov, vfov, along, options.elevationRangeDeg ?? [-60, 60])
    shots = sphere.shots
    effectiveOverlap = 1 - sphere.stepDeg / Math.max(1, hfov)
  }

  const { ratio, distance } = baselineStats(shots)
  const warnings = reviewPlan(shots, target, ratio, options)

  return {
    pattern: options.pattern,
    label,
    target,
    shots,
    total: shots.length,
    horizontalFovDeg: hfov,
    verticalFovDeg: vfov,
    baselineRatio: ratio,
    medianDistance: distance,
    effectiveOverlap: Math.max(0, Math.min(1, effectiveOverlap)),
    footprint,
    estimatedSeconds: Math.round(shots.length * SECONDS_PER_SHOT),
    warnings,
  }
}

function planOrbit(
  target: ReconTarget,
  rings: number,
  hfov: number,
  vfov: number,
  overlap: number,
): { shots: ReconShot[]; stepDeg: number } {
  const ringCount = Math.max(1, Math.min(6, Math.round(rings)))
  const outer = framingDistance(target, hfov, vfov)
  // 半对角线:内圈半径必须让相机离盒角仍有可用的景深
  const halfDiagonal = Math.hypot(target.size[0], target.size[1]) / 2
  const minRadius = halfDiagonal + MIN_INNER_DEPTH_M

  const shots: ReconShot[] = []
  let minStep = angularStep(hfov, overlap)
  for (let ring = 0; ring < ringCount; ring += 1) {
    // 半径逐圈内收 30%:再多的话内圈就贴到主体角上了 —— 景深塌到 2 m 以内时,
    // b/d 约束会把角步进压到 3°(单圈上百张),而拍到的东西并没有多
    const radiusScale = ringCount === 1 ? 1 : 1 - (ring * 0.3) / (ringCount - 1)
    const radius = Math.max(outer * radiusScale, minRadius)
    // 高度:外圈必须**高于主体顶部**,否则顶面永远进不了视锥(法向 +z 的点会被背面剔除
    // 整片判掉,覆盖报告里顶面 0% 而看不出原因);内圈压到腰部以下仰拍屋檐底面。
    const heightScale = ringCount === 1 ? 0 : [0.8, 0, -0.35][ring % 3] ?? 0
    const z = target.center[2] + target.size[2] * heightScale
    // 该圈最不利方位上的景深决定它要多密
    const depth = ringMinDepth(target.center, radius, z, target)
    const stepDeg = ringStep(hfov, overlap, radius, depth)
    minStep = Math.min(minStep, stepDeg)
    const count = Math.max(6, Math.round(360 / stepDeg))
    const actualStep = 360 / count

    for (let col = 0; col < count; col += 1) {
      const azimuth = col * actualStep
      const rad = azimuth * DEG
      const position: Vector3Tuple = [
        target.center[0] + Math.sin(rad) * radius,
        target.center[1] + Math.cos(rad) * radius,
        z,
      ]
      // 朝向中心:方位角 + 180°(`sin/cos` 的定义决定 +180 才是"回看")
      const pitch = Math.atan2(target.center[2] - z, radius) / DEG
      shots.push(
        makeShot(
          { index: shots.length + 1, ring, row: 0, col, position, heading: azimuth + 180, pitch },
          target,
        ),
      )
    }
  }
  // 内圈最密,它的步进就是整组的代表值
  return { shots, stepDeg: minStep }
}

function planSphere(
  target: ReconTarget,
  hfov: number,
  vfov: number,
  overlap: number,
  elevationRange: [number, number],
): { shots: ReconShot[]; stepDeg: number } {
  const radius = framingDistance(target, hfov, vfov)
  const depth = ringMinDepth(target.center, radius, target.center[2], target)
  const azimuthStep = ringStep(hfov, overlap, radius, depth)
  const count = Math.max(6, Math.round(360 / azimuthStep))
  const actualStep = 360 / count
  const low = Math.max(-85, Math.min(elevationRange[0], elevationRange[1]))
  const high = Math.min(85, Math.max(elevationRange[0], elevationRange[1]))
  const elevationStep = angularStep(vfov, overlap)
  const rows = Math.max(1, Math.floor((high - low) / elevationStep) + 1)

  const shots: ReconShot[] = []
  for (let row = 0; row < rows; row += 1) {
    // 从高到低扫(先俯后仰),真机也这么飞,免得贴着地面开始
    const elevation = rows === 1 ? (low + high) / 2 : high - (row * (high - low)) / (rows - 1)
    const e = elevation * DEG
    const horizontal = radius * Math.cos(e)
    const z = target.center[2] + radius * Math.sin(e)
    for (let col = 0; col < count; col += 1) {
      const azimuth = col * actualStep
      const rad = azimuth * DEG
      const position: Vector3Tuple = [
        target.center[0] + Math.sin(rad) * horizontal,
        target.center[1] + Math.cos(rad) * horizontal,
        z,
      ]
      shots.push(
        makeShot(
          {
            index: shots.length + 1,
            ring: 0,
            row,
            col,
            position,
            heading: azimuth + 180,
            // ⚠️ elevation 是"相机在球心之上的仰角",而 pitch 是"相机看的方向"。
            // 相机在 +60° 时是**向下**看球心,所以必须是 -elevation —— 写成 +elevation
            // 会让整个球壳的光轴朝外翻,画面上是"对着天空拍",而位置全对。
            pitch: -elevation,
          },
          target,
        ),
      )
    }
  }
  return { shots, stepDeg: azimuthStep }
}

function planGrid(
  target: ReconTarget,
  altitude: number,
  hfov: number,
  vfov: number,
  alongOverlap: number,
  sideOverlap: number,
  tiltDeg: number,
): {
  shots: ReconShot[]
  footprint: { along: number; across: number }
  colGap: number
} {
  const groundZ = target.center[2] + target.size[2] / 2
  const height = Math.max(2, altitude)
  const along = 2 * height * Math.tan((vfov * DEG) / 2)
  const across = 2 * height * Math.tan((hfov * DEG) / 2)
  // 列间距同时受重叠率与 b/d 上限约束(景深就是飞行高度,所以这个比值是纯几何的)
  const colGap = Math.max(0.5, Math.min(along * (1 - alongOverlap), MAX_BASELINE_RATIO * height))
  const rowGap = Math.max(0.5, across * (1 - sideOverlap))

  // 外扩半幅:边缘那一圈倾斜张若从测区边界起飞,拍到的全是外面 —— 航测的老规矩
  const padAlong = Math.min(along / 2, target.size[1] / 2)
  const padAcross = Math.min(across / 2, target.size[0] / 2)
  const e0 = target.center[0] - target.size[0] / 2 - padAcross
  const e1 = target.center[0] + target.size[0] / 2 + padAcross
  const n0 = target.center[1] - target.size[1] / 2 - padAlong
  const n1 = target.center[1] + target.size[1] / 2 + padAlong

  const cols = Math.max(1, Math.ceil((e1 - e0) / colGap) + 1)
  const rows = Math.max(1, Math.ceil((n1 - n0) / rowGap) + 1)
  const spanE = e1 - e0
  const spanN = n1 - n0

  const shots: ReconShot[] = []
  for (let row = 0; row < rows; row += 1) {
    const n = rows === 1 ? (n0 + n1) / 2 : n0 + (row * spanN) / (rows - 1)
    const forward = row % 2 === 0
    for (let step = 0; step < cols; step += 1) {
      // 弓字形:偶数行自西向东、奇数行自东向西,免去每行空飞回起点
      const e = forward ? e0 + (step * spanE) / Math.max(1, cols - 1) : e1 - (step * spanE) / Math.max(1, cols - 1)
      const position: Vector3Tuple = [e, n, groundZ + height]
      const travel = forward ? 90 : 270
      // 五向:正射 + 前后左右四个倾斜(靠机身转向实现 —— 云台只有俯仰通道)
      const directions = tiltDeg > 0 ? [travel, travel + 90, travel + 180, travel + 270] : []
      if (tiltDeg <= 0) {
        shots.push(
          makeShot(
            { index: shots.length + 1, ring: 0, row, col: step, position, heading: travel, pitch: -90 },
            target,
          ),
        )
        continue
      }
      shots.push(
        makeShot(
          { index: shots.length + 1, ring: 0, row, col: step, position, heading: travel, pitch: -90 },
          target,
        ),
      )
      for (const heading of directions) {
        shots.push(
          makeShot(
            {
              index: shots.length + 1,
              ring: 0,
              row,
              col: step,
              position: [position[0], position[1], position[2]],
              heading,
              pitch: -Math.abs(tiltDeg),
            },
            target,
          ),
        )
      }
    }
  }
  return { shots, footprint: { along, across }, colGap }
}

/** 相邻光心的间距 / 拍摄距离 —— 判定这组数据能不能三角化 */
function baselineStats(shots: ReconShot[]): { ratio: number; distance: number } {
  const ratios: number[] = []
  const distances: number[] = []
  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i]
    if (!shot) continue
    distances.push(shot.distance)
    const next = shots[i + 1]
    if (!next) continue
    // 只比同一圈 / 同一行的相邻点:跨圈、跨行的间距不代表覆盖密度
    if (next.ring !== shot.ring || next.row !== shot.row) continue
    const gap = Math.hypot(
      next.position[0] - shot.position[0],
      next.position[1] - shot.position[1],
      next.position[2] - shot.position[2],
    )
    // ⚠️ 网格模式同一个网格点会拍 5 张(正射 + 四向倾斜),相邻两张光心重合,
    // 间距为 0。把它们计入中位数会把 b/d 拉到 0 并误报"基线不足"。
    if (gap < 1e-3) continue
    const depth = (shot.distance + next.distance) / 2
    if (depth > 0.5) ratios.push(gap / depth)
  }
  return { ratio: median(ratios), distance: median(distances) }
}

function reviewPlan(
  shots: ReconShot[],
  target: ReconTarget,
  baselineRatio: number,
  options: ReconPlanOptions,
): string[] {
  const warnings: string[] = []
  // 远景与近景用不同的建议区间(见 USABLE_BASELINE_RATIO_NEAR 的说明)
  const range = options.pattern === 'grid-tilt' ? USABLE_BASELINE_RATIO : USABLE_BASELINE_RATIO_NEAR
  if (shots.length === 0) warnings.push('没有生成任何拍点:检查主体尺寸与视场角')
  if (baselineRatio > 0 && baselineRatio < range[0]) {
    warnings.push(
      `基线/景深比 ${baselineRatio.toFixed(3)} 低于 ${range[0]}:重叠率过高,` +
        `深度误差随距离平方放大,减重叠率比加张数更有效`,
    )
  }
  if (baselineRatio > range[1]) {
    warnings.push(
      `基线/景深比 ${baselineRatio.toFixed(3)} 高于 ${range[1]}:` +
        `跨视角特征匹配会开始掉点,考虑提高重叠率或降低飞行高度`,
    )
  }
  const flatness = target.size[2] / Math.max(1e-3, Math.max(target.size[0], target.size[1]))
  if (flatness < 0.05 && options.pattern !== 'grid-tilt') {
    warnings.push('主体接近平面(高/宽 < 5%):环绕只能拍到侧面,建议用 grid-tilt 网格模式')
  }
  if (options.pattern === 'orbit' && (options.rings ?? 3) < 2) {
    warnings.push('单圈只能拍到腰部高度的一圈视角,顶面与底面会缺观测')
  }
  if (options.pattern === 'grid-tilt' && target.size[2] > (options.altitude ?? 40) * 0.5) {
    warnings.push('主体高度超过飞行高度的一半:倾斜张的立面覆盖率不足,建议提高高度或增加仰角')
  }
  return warnings
}

// ─────────────────────────────── 覆盖统计 ───────────────────────────────

export interface ReconCoverageOptions {
  /** 采样间距(米);缺省按主体尺度自动(约最长边的 1/24,夹在 0.2~3) */
  sampleStep?: number
  /** 只采表面(默认)还是填满整个包围盒 */
  volume?: boolean
  /**
   * 是否把**朝下的面**也计入覆盖(默认否)。
   * 航拍永远拍不到物体底面,把它算进去只会让报告里常驻一块补不上的缺口。
   */
  includeDownFace?: boolean
}

export interface ReconSample {
  position: Vector3Tuple
  /** 有多少个拍点能看到这一点 */
  views: number
}

export interface ReconCoverageSummary {
  samples: number
  /** 视角数直方图:下标 = 视角数(超过 HISTOGRAM_CAP 的并入最后一格) */
  histogram: number[]
  /** 0 视角占比:完全没拍到 */
  uncovered: number
  /** 1 视角占比:无法三角化,只能靠单目先验猜 */
  single: number
  /** >= MIN_USABLE_VIEWS 视角占比 —— 3DGS 真正可用的部分 */
  usable: number
  medianViews: number
  /** 被忽略的朝下面采样点数(见 options.includeDownFace) */
  skippedDownFace: number
  warnings: string[]
}

/**
 * 一个表面采样点:位置 + **该处的外法向**(可能有多个,棱上的点同时属于两个面)。
 *
 * 法向是做背面剔除的唯一依据 —— 没有它,凸体的背面会被算成"每台相机都看得到",
 * 覆盖统计于是永远接近 100%,等于没有统计。
 */
interface SamplePoint {
  position: Vector3Tuple
  normals: Vector3Tuple[]
}

/**
 * 采样点的包围盒表面(或体积)。
 *
 * 表面模式按 6 个面分别采样并记录法向;尺寸为 0 的轴(平面主体)两个面会重合,
 * 用法向集合 `any` 判定即可,不需要特判。
 */
function sampleTarget(
  target: ReconTarget,
  step: number,
  volume: boolean,
  includeDownFace: boolean,
): { points: SamplePoint[]; skippedDownFace: number } {
  const half = [target.size[0] / 2, target.size[1] / 2, target.size[2] / 2]
  const axisCount = half.map((value) => Math.max(1, Math.round((value * 2) / step) + 1))
  const axisCoords = (axis: number): number[] => {
    const count = axisCount[axis] ?? 2
    const span = half[axis] ?? 0
    return Array.from({ length: count }, (_, i) =>
      count === 1 ? (target.center[axis] ?? 0) : (target.center[axis] ?? 0) - span + (i * span * 2) / (count - 1),
    )
  }
  const coords = [axisCoords(0), axisCoords(1), axisCoords(2)]

  if (volume) {
    const points: SamplePoint[] = []
    for (const x of coords[0] ?? []) {
      for (const y of coords[1] ?? []) {
        for (const z of coords[2] ?? []) points.push({ position: [x, y, z], normals: [] })
      }
    }
    return { points, skippedDownFace: 0 }
  }

  // 按位置聚合,棱上的点因此自然带上两个法向
  const byKey = new Map<string, SamplePoint>()
  const add = (position: Vector3Tuple, normal: Vector3Tuple): void => {
    const key = `${position[0].toFixed(4)}|${position[1].toFixed(4)}|${position[2].toFixed(4)}`
    const existing = byKey.get(key)
    if (existing) existing.normals.push(normal)
    else byKey.set(key, { position, normals: [normal] })
  }
  let skippedDownFace = 0

  for (let axis = 0; axis < 3; axis += 1) {
    const values = coords[axis] ?? []
    if (values.length === 0) continue
    const last = values.length - 1
    // 尺寸为 0 的轴(平面主体)两个面重合,正反法向都要留 —— 否则平面就一个采样点都没有
    const sides = last === 0 ? ([1, -1] as const) : ([-1, 1] as const)
    for (const side of sides) {
      // 朝下的面(-z):航拍永远拍不到物体底面,默认不计入(否则报告里永远有 15% 缺口)
      if (axis === 2 && side === -1 && !includeDownFace) continue
      const value = side < 0 && last > 0 ? values[0] : values[last]
      const normal: Vector3Tuple = [0, 0, 0]
      normal[axis] = side
      const others = [0, 1, 2].filter((index) => index !== axis)
      for (const a of coords[others[0] ?? 0] ?? []) {
        for (const b of coords[others[1] ?? 1] ?? []) {
          const position: Vector3Tuple = [0, 0, 0]
          position[axis] = value ?? 0
          position[others[0] ?? 0] = a
          position[others[1] ?? 1] = b
          if (axis === 2 && side === -1) skippedDownFace += 1
          add(position, normal)
        }
      }
    }
  }
  return { points: [...byKey.values()], skippedDownFace: Math.max(0, skippedDownFace) }
}

/**
 * 统计每个采样点被多少个拍点看到。
 *
 * 判据是纯针孔投影:把世界点转到相机系(three 约定,相机看 -Z),
 * 要求 `z < 0` 且归一化后的 `|x/-z| <= tan(hfov/2)`、`|y/-z| <= tan(vfov/2)`。
 * 不做遮挡判定 —— 遮挡需要场景几何,而这里的输入只有拍点。
 * 也就是说这是**覆盖上界**:真实可见数只会更少,不会更多。
 */
export function reconCoverage(
  shots: ReconShot[],
  target: ReconTarget,
  options: ReconCoverageOptions & { fov?: { horizontalFovDeg: number; verticalFovDeg: number } } = {},
): { summary: ReconCoverageSummary; samples: ReconSample[]; sampleStep: number } {
  const longest = Math.max(target.size[0], target.size[1], target.size[2])
  const step = options.sampleStep ?? Math.min(3, Math.max(0.2, longest / 24))
  const sampled = sampleTarget(target, step, options.volume ?? false, options.includeDownFace ?? false)
  const histogram = Array.from({ length: HISTOGRAM_CAP + 1 }, () => 0)
  const samples: ReconSample[] = []

  for (const point of sampled.points) {
    const { position } = point
    let views = 0
    for (const shot of shots) {
      // 背面剔除:凸体的表面点只有法向朝向相机时才可能被看到。
      // 少了这一步,绕一圈拍摄会让每个点的视角数都等于总张数 —— 统计彻底失真。
      if (point.normals.length > 0) {
        const toCamera = sub(shot.position, position)
        const facing = point.normals.some(
          (normal) =>
            normal[0] * (toCamera[0] ?? 0) + normal[1] * (toCamera[1] ?? 0) + normal[2] * (toCamera[2] ?? 0) > 0,
        )
        if (!facing) continue
      }
      const local = rotateVectorByQuaternion(sub(position, shot.position), conjugate(shot.rotation))
      const depth = -(local[2] ?? 0)
      if (depth <= 1e-6) continue
      const tanH = Math.tan(((options.fov?.horizontalFovDeg ?? DEFAULT_HORIZONTAL_FOV) * DEG) / 2)
      const tanV = Math.tan(((options.fov?.verticalFovDeg ?? DEFAULT_VERTICAL_FOV) * DEG) / 2)
      if (Math.abs((local[0] ?? 0) / depth) > tanH) continue
      if (Math.abs((local[1] ?? 0) / depth) > tanV) continue
      views += 1
    }
    samples.push({ position, views })
    histogram[Math.min(views, HISTOGRAM_CAP)] = (histogram[Math.min(views, HISTOGRAM_CAP)] ?? 0) + 1
  }

  const total = samples.length || 1
  const viewCounts = samples.map((sample) => sample.views)
  const summary: ReconCoverageSummary = {
    samples: samples.length,
    histogram,
    uncovered: (histogram[0] ?? 0) / total,
    single: (histogram[1] ?? 0) / total,
    usable: samples.filter((sample) => sample.views >= MIN_USABLE_VIEWS).length / total,
    medianViews: median(viewCounts),
    skippedDownFace: 0,
    warnings: [],
  }
  if (summary.uncovered > 0.02) {
    summary.warnings.push(
      `${(summary.uncovered * 100).toFixed(1)}% 的表面点没有任何视角拍到 —— 那里必然糊成一片`,
    )
  }
  if (summary.single > 0.05) {
    summary.warnings.push(
      `${(summary.single * 100).toFixed(1)}% 的表面点只有 1 个视角 —— 无法三角化,` +
        `3DGS 只能靠单目先验猜深度`,
    )
  }
  if (summary.usable < 0.8) {
    summary.warnings.push(
      `只有 ${(summary.usable * 100).toFixed(1)}% 的表面点达到 ${MIN_USABLE_VIEWS} 视角,` +
        `低于 80% 时重建会出现大片 floater`,
    )
  }
  summary.skippedDownFace = sampled.skippedDownFace
  return { summary, samples, sampleStep: step }
}

function conjugate(quaternion: Quaternion): Quaternion {
  return [-quaternion[0], -quaternion[1], -quaternion[2], quaternion[3]]
}

/**
 * 把覆盖统计画成点云 —— 直接丢给 `DroneSplatViewer` 看。
 *
 * 颜色:**红 = 0 视角、橙 = 1、黄 = 2、绿 = 3~4、青 = 5~7、蓝 = ≥8**。
 * 这是"热力图"的语义(红=坏),不是涨跌色,所以不遵循项目的红涨绿跌约定。
 */
export function reconCoverageToCloud(
  samples: ReconSample[],
  options: { sampleStep?: number; name?: string } = {},
): SplatCloud {
  const count = samples.length
  const center = new Float32Array(count * 3)
  const scale = new Float32Array(count * 3)
  const rotation = new Float32Array(count * 4)
  const rgba = new Float32Array(count * 4)
  const sigma = Math.max(0.05, (options.sampleStep ?? 0.35) * 0.4)
  for (let i = 0; i < count; i += 1) {
    const sample = samples[i]
    if (!sample) continue
    center[i * 3] = sample.position[0]
    center[i * 3 + 1] = sample.position[1]
    center[i * 3 + 2] = sample.position[2]
    scale[i * 3] = sigma
    scale[i * 3 + 1] = sigma
    scale[i * 3 + 2] = sigma
    rotation[i * 4 + 3] = 1
    const [r, g, b] = viewsColor(sample.views)
    rgba[i * 4] = r
    rgba[i * 4 + 1] = g
    rgba[i * 4 + 2] = b
    rgba[i * 4 + 3] = 0.92
  }
  return {
    count,
    center,
    scale,
    rotation,
    rgba,
    shDegree: 0,
    droppedShCoefficients: 0,
    name: options.name ?? `视角覆盖 · ${count} 点`,
    bounds: computeSplatBounds(center, count),
  }
}

function viewsColor(views: number): [number, number, number] {
  if (views <= 0) return [0.886, 0.294, 0.29]
  if (views === 1) return [0.937, 0.624, 0.153]
  if (views === 2) return [0.98, 0.78, 0.459]
  if (views <= 4) return [0.592, 0.769, 0.349]
  if (views <= 7) return [0.365, 0.792, 0.647]
  return [0.216, 0.541, 0.867]
}

// ─────────────────────────────── 航线导出 ───────────────────────────────

/**
 * 把规划好的拍点翻译成航点 —— 给**真机**用。
 *
 * 仿真里 `placeBodyAt` 是瞬移,真机必须真飞。每个航点带云台俯仰与拍照动作,
 * 于是"飞一条航线就把数据采了"这件事在真机上也成立。
 *
 * ⚠️ 航向只能用 `headingMode: 'auto'`(机头指向下一航点)近似 —— 而拍点要求
 * "机头正对主体/正对航线外侧",两者在转弯处会差几十度。真机的正解是让飞控
 * 支持逐航点航向(MAV_CMD_DO_SET_YAW),或在到点悬停时补一次自转。
 */
export function reconPlanToWaypoints(plan: ReconPlan): MissionWaypoint[] {
  return plan.shots.map((shot) => ({
    x: shot.position[0],
    z: -shot.position[1],
    altitude: Math.max(0, shot.position[2]),
    speed: 0,
    hoverSeconds: 1.5,
    gimbalPitch: shot.pitch,
    action: 'photo' as const,
  }))
}

// ─────────────────────────────── 执行器 ───────────────────────────────

export type ReconCaptureState = 'idle' | 'running' | 'done' | 'cancelled' | 'failed'

export interface ReconProgress {
  state: ReconCaptureState
  pattern: string
  index: number
  total: number
  ring: number
  row: number
  col: number
  group: string | null
  message?: string
}

export interface ReconCaptureResult {
  group: string
  pattern: string
  total: number
  /** 实际入库张数(成片失败会少于 total) */
  captured: number
  cancelled: boolean
  error?: string
  /** 用**采集回来的真值位姿**算的覆盖(不是规划位姿) */
  coverage?: ReconCoverageSummary
  /** 覆盖热力图点云:直接丢给 `DroneSplatViewer` 就能看到哪块没拍够 */
  coverageCloud?: SplatCloud
  /** 真值位姿,便于外部复核或直接喂给 COLMAP 导出 */
  poses?: ReconstructionPose[]
  /** 规划位姿与真值位姿的最大偏差(米);大于 0.5 说明定点保持没跟上 */
  maxDrift?: number
}

export interface ReconstructionCaptureOptions {
  /** 每张之间的间隔(毫秒),给渲染后端留稳定时间;缺省 0 */
  shotIntervalMs?: number
  /** 等待机身转到方位的最长时间(毫秒),缺省 8000 */
  spinTimeoutMs?: number
  /** 等待机体到位的轮询上限(毫秒),缺省 5000 —— 只对"真的飞过去"的后端有意义 */
  moveTimeoutMs?: number
  onFinished?: (result: ReconCaptureResult) => void
}

const SPIN_TOLERANCE_DEG = 0.5
const POSITION_TOLERANCE_M = 0.5
const POLL_MS = 16

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function headingGap(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

/** 组 id:`recon-<模式>-<时间戳>`,与全景的命名风格一致 */
function reconGroupId(pattern: string): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `recon-${pattern}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/**
 * 重建采集执行器:逐个拍点"放置机体 → 转向 → 按俯仰取景 → 落库"。
 *
 * 与 `PanoramaCapture` 共用同一套后端能力(自转 + 俯仰覆盖),只多用了
 * `placeBodyAt`(位移)。因此**没有位移能力的后端会被直接拒绝**,而不是
 * 悄悄退化成"光心不动"——那正好就是全景,而文件看起来完全正常。
 *
 * ```ts
 * const recon = new ReconstructionCapture(captureService)
 * recon.subscribe((p) => console.log(`${p.index}/${p.total}`))
 * const result = await recon.start(session.id, plan)
 * result.coverage.usable   // 0.87
 * ```
 */
export class ReconstructionCapture {
  private readonly capture: CaptureService
  private readonly listeners = new Set<(progress: ReconProgress) => void>()
  private options: ReconstructionCaptureOptions
  private token = 0
  private current: ReconProgress | null = null

  constructor(capture: CaptureService, options: ReconstructionCaptureOptions = {}) {
    this.capture = capture
    this.options = { ...options }
  }

  get running(): boolean {
    return this.current?.state === 'running'
  }

  get progress(): ReconProgress | null {
    return this.current ? { ...this.current } : null
  }

  subscribe(listener: (progress: ReconProgress) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 请求停止(当前那张会拍完再退出) */
  cancel(): void {
    if (!this.running) return
    this.token += 1
    this.setProgress({ ...(this.current as ReconProgress), state: 'cancelled' })
  }

  /**
   * 按规划拍一整组。已在采集、会话不存在、或后端缺能力时返回 null / 失败结果。
   *
   * 失败与"少拍几张"分得很清:单张成片失败只计入缺口(重拍一整组代价太大),
   * 而**机体到不了位 / 转不到位**说明几何根本没施加成功,继续拍只会得到一堆
   * 重影般的废片,于是立即以失败收尾。
   */
  async start(sessionId: string, plan: ReconPlan): Promise<ReconCaptureResult | null> {
    if (this.running) return null
    const session = this.capture.getSession(sessionId)
    if (!session) return null
    const group = reconGroupId(plan.pattern)
    const token = (this.token += 1)
    const total = plan.total
    let captured = 0
    let last: ReconShot | undefined = plan.shots[0]

    this.setProgress({
      state: 'running',
      pattern: plan.pattern,
      index: 0,
      total,
      ring: last?.ring ?? 0,
      row: last?.row ?? 0,
      col: last?.col ?? 0,
      group,
    })

    const fail = (message: string): ReconCaptureResult => {
      this.capture.spinBodyTo(null)
      this.setProgress({
        state: 'failed',
        pattern: plan.pattern,
        index: captured,
        total,
        ring: last?.ring ?? 0,
        row: last?.row ?? 0,
        col: last?.col ?? 0,
        group,
        message,
      })
      const result: ReconCaptureResult = {
        group,
        pattern: plan.pattern,
        total,
        captured,
        cancelled: false,
        error: message,
      }
      this.options.onFinished?.(result)
      return result
    }

    if (!this.capture.canPlaceBody) {
      return fail('当前渲染后端不支持移动机体,无法产生基线 —— 采集会退化成纯旋转')
    }
    if (!this.capture.canSpinBody) {
      return fail('当前渲染后端不支持机体自转,无法调整水平朝向')
    }
    if (plan.shots.length === 0) return fail('规划里没有拍点')

    const drift: number[] = []
    for (const shot of plan.shots) {
      if (this.token !== token) break
      last = shot
      this.setProgress({
        state: 'running',
        pattern: plan.pattern,
        index: captured,
        total,
        ring: shot.ring,
        row: shot.row,
        col: shot.col,
        group,
      })

      this.capture.placeBodyAt(shot.position)
      const arrived = await this.awaitPosition(shot.position, token)
      if (this.token !== token) break
      if (!arrived) return fail(`机体未能到达 ${formatPosition(shot.position)}`)

      const before = this.capture.getBodyPosition()
      if (before) {
        drift.push(
          Math.hypot(
            before[0] - shot.position[0],
            before[1] - shot.position[1],
            before[2] - shot.position[2],
          ),
        )
      }

      this.capture.spinBodyTo(shot.heading)
      const aligned = await this.awaitHeading(shot.heading, token)
      if (this.token !== token) break
      if (!aligned) return fail(`机身未能转到 ${shot.heading.toFixed(0)}°(需定点悬停中再拍)`)

      const image = await this.capture.captureVirtualImage(sessionId, {
        view: { pitch: shot.pitch },
        recon: reconRef(group, plan.pattern, shot, total),
      })
      if (image) captured += 1
      if (this.token !== token) break
      if (this.options.shotIntervalMs && this.options.shotIntervalMs > 0) {
        await delay(this.options.shotIntervalMs)
      }
    }

    // 停自转:目标留着的话,后面任何一次回到悬停都会被它继续拽着转
    this.capture.spinBodyTo(null)
    const cancelled = this.token !== token
    const result: ReconCaptureResult = {
      group,
      pattern: plan.pattern,
      total,
      captured,
      cancelled,
    }

    // 覆盖统计用**真值位姿**:模拟器有定点保持误差、云台有惯性,规划位姿只是设计值。
    // 两者混用会让报告好看得不像真的。
    if (captured > 0) {
      const images = groupImages(session, group)
      if (images.length > 0) {
        const poses = capturePoses({ ...session, images })
        result.poses = poses
        const covered = reconCoverage(posesAsShots(poses), plan.target, {
          fov: { horizontalFovDeg: plan.horizontalFovDeg, verticalFovDeg: plan.verticalFovDeg },
        })
        result.coverage = covered.summary
        result.coverageCloud = reconCoverageToCloud(covered.samples, {
          sampleStep: covered.sampleStep,
          name: `视角覆盖 · ${plan.label} · ${captured} 张`,
        })
      }
      if (drift.length > 0) result.maxDrift = Math.max(...drift)
    }

    this.setProgress({
      state: cancelled ? 'cancelled' : 'done',
      pattern: plan.pattern,
      index: captured,
      total,
      ring: last?.ring ?? 0,
      row: last?.row ?? 0,
      col: last?.col ?? 0,
      group,
      message: cancelled ? `已取消(完成 ${captured}/${total})` : `完成 ${captured}/${total}`,
    })
    this.options.onFinished?.(result)
    return result
  }

  /** 按组 id 取回本次采集的影像(按序号排序) */
  buildImages(sessionId: string, group: string): CapturedImage[] {
    const session = this.capture.getSession(sessionId)
    if (!session) return []
    return groupImages(session, group)
  }

  private async awaitPosition(target: Vector3Tuple, token: number): Promise<boolean> {
    // 没有位置读取能力的后端当作"瞬时到位":它能放下机体,但报不出坐标
    if (!this.capture.getBodyPosition) return true
    const deadline = Date.now() + (this.options.moveTimeoutMs ?? 5000)
    for (;;) {
      const current = this.capture.getBodyPosition()
      if (
        current &&
        Math.hypot(current[0] - target[0], current[1] - target[1], current[2] - target[2]) <=
          POSITION_TOLERANCE_M
      ) {
        return true
      }
      if (this.token !== token) return false
      if (Date.now() >= deadline) return false
      await delay(POLL_MS)
    }
  }

  private async awaitHeading(target: number, token: number): Promise<boolean> {
    const deadline = Date.now() + (this.options.spinTimeoutMs ?? 8000)
    for (;;) {
      const heading = this.capture.getBodyHeading()
      if (heading !== null && headingGap(heading, target) <= SPIN_TOLERANCE_DEG) return true
      if (this.token !== token) return false
      if (Date.now() >= deadline) return false
      await delay(POLL_MS)
    }
  }

  private setProgress(progress: ReconProgress): void {
    this.current = progress
    for (const listener of this.listeners) listener({ ...progress })
  }
}

function formatPosition(position: Vector3Tuple): string {
  return `(${position[0].toFixed(1)}, ${position[1].toFixed(1)}, ${position[2].toFixed(1)})`
}

function reconRef(
  group: string,
  pattern: string,
  shot: ReconShot,
  total: number,
): ReconShotRef {
  return {
    group,
    pattern,
    index: shot.index,
    total,
    ring: shot.ring,
    row: shot.row,
    col: shot.col,
  }
}

function groupImages(session: CaptureSession, group: string): CapturedImage[] {
  return session.images
    .filter((image) => image.metadata.recon?.group === group)
    .sort((a, b) => (a.metadata.recon?.index ?? 0) - (b.metadata.recon?.index ?? 0))
}

/** 真值位姿 → 覆盖统计用的拍点(不带规划信息,只保留"从哪看、朝哪看、多大视场") */
function posesAsShots(poses: ReconstructionPose[]): ReconShot[] {
  return poses.map((pose, index) => ({
    index: index + 1,
    ring: 0,
    row: 0,
    col: index,
    position: [pose.position[0], pose.position[1], pose.position[2]],
    heading: 0,
    pitch: 0,
    rotation: pose.rotation,
    distance: 0,
  }))
}
