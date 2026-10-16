/**
 * 全景合成 —— 库内自带的默认 `PanoramaStitcher` 实现:**等距柱状(equirectangular)投影拼接**。
 *
 * ── 为什么库内做得了、而且不引任何依赖 ──────────────────────────────────
 *
 * 因为这条件是把「**这一张朝哪儿**」记全了:全景组每张影像都带
 * `metadata.panorama` —— 相对组起始航向的 `bodyYaw`(方位角)与绝对 `pitch`(仰角),
 * 再加上 `cameraIntrinsics` 的视场角,每一张的取景锥体就**完全确定**了。于是可以直接
 * 按已知位姿反投影逐像素采样,不需要特征匹配、不需要 SfM、不需要 OpenCV/WASM。
 * 真机全景拼接最难的一步(估位姿)在这条采集链路上是免费的 —— 这正是"位姿已知"的红利。
 *
 * ⚠️ **故意不读 `cameraPose.rotation`**。两个渲染后端的四元数各用各的局部轴约定
 * (three 的相机朝局部 -z,Cesium 的 HPR 帧朝局部 +x),拿它反投影等于把某个后端的
 * 内部约定搬进拼接器 —— 换个后端就错位。而 `bodyYaw` / `pitch` 是**语义化**的
 * (方位角 / 仰角,与后端无关),本模块按定义重建取景锥体,两端通吃。
 *
 * ⚠️ 只解算**旋转**、不解算平移:全景的前提是"相机绕光心转"。真机靠定点悬停做到,
 * 本库的扫描也是**机体原地自转**(见 drone-panorama 模块头),所以这一近似与采集方式自洽。
 * 机体重心与云台光心之间那点平移(厘米级)会带来轻微视差,拼接预览可接受;
 * 需要严格无差的重建输入,应该把原始 21/自适应球形全景照片交给宿主自己的光束法平差流程。
 *
 * ── 输出 ────────────────────────────────────────────────────────────
 *
 * `pano-360` 默认输出**整颗球的标准等距柱状图**:360°×180°(宽高比 2:1),
 * 没拍到的天顶 / 天底 / 方位缺口按 `fill` 补上。广角与 180° 默认只输出实际视场带,
 * 并把经纬范围写进结果供环视器正确反投影;180° 的方位范围裁在 [-90°, +90°]。
 * 若想保留"只输出实际覆盖带"的旧行为,传 `projection: 'band'`。
 *
 * 重叠区按"离画面中心越远权重越低"做羽化加权平均,避免接缝处的硬边;
 * 返回的 `coverage` 是**补边之前**的真实覆盖像素占比,便于宿主判断这组拍全了没有。
 *
 * ```ts
 * const stitcher = createEquirectStitcher({ pixelsPerDegree: 10 })
 * stitcher.onProgress = (done, total) => console.log(`${done}/${total}`)
 * const result = await stitcher.stitch(group)   // { url, width, height, coverage }
 * ```
 */
import type { CapturedImage } from './drone-capture'
import type { PanoramaGroup, PanoramaStitchResult, PanoramaStitcher } from './drone-panorama'

const DEG = Math.PI / 180
const RAD = 180 / Math.PI

/** 输出分辨率(每度多少像素)缺省值:整球 360°×180° → 3600×1800 */
const DEFAULT_PIXELS_PER_DEGREE = 10
const DEFAULT_MAX_WIDTH = 4096
const DEFAULT_MAX_HEIGHT = 2048
/** 羽化带宽(占半幅比例):0.22 = 从 78% 处开始向边缘衰减 */
const DEFAULT_FEATHER = 0.22
/**
 * 羽化到边缘时留一点权重下限,而不是衰减到 0。
 * 全景最外圈的像素只被一张影像覆盖,权重为 0 会让那一圈直接透明掉(看着像被啃了一口);
 * 加权平均里权重只用于**相对**比较,单张覆盖处颜色与权重无关,所以留个下限是无损的。
 */
const MIN_FEATHER_WEIGHT = 0.05
/** 内参缺失时的视场角兜底:水平 ±30° / 垂直 ±20° */
const FALLBACK_TAN_H = Math.tan(30 * DEG)
const FALLBACK_TAN_V = Math.tan(20 * DEG)

/**
 * 整颗球的标准等距柱状范围:方位 -180°~+180°(组起始航向 = 0° 落在画面正中)、
 * 仰角 +90°(天顶)~ -90°(天底)。宽高比恒为 2:1 —— DJI 全景的规格。
 */
const SPHERE_BAND: CoverageBand = { thetaStart: -180, spanTheta: 360, phiTop: 90, spanPhi: 180 }

/** 输出投影方式 */
export type EquirectProjection = 'sphere' | 'band'

/** 球面输出时未覆盖区域的填充方式 */
export type EquirectFill = 'edge' | 'none'

/** `EquirectStitcher` 构造选项 */
export interface EquirectStitcherOptions {
  /**
   * 输出分辨率(每度像素数),默认 10。整球输出即 3600×1800。
   * 越大越清晰、越慢(耗时与输出像素数 × 影像数成正比)。
   */
  pixelsPerDegree?: number
  /** 输出宽度上限(像素),默认 4096;超出按比例整体缩小 */
  maxWidth?: number
  /** 输出高度上限(像素),默认 2048 */
  maxHeight?: number
  /**
   * 输出投影,默认按全景模式自动选择(`pano-360` 用 sphere,广角/180° 用 band):
   * - `'sphere'`:整颗球的标准等距柱状图(360°×180°、2:1 长条,与 DJI 全景同规格),
   *   没拍到的天顶 / 天底 / 方位缺口按 `fill` 补上,输出是规整矩形;
   * - `'band'`:只输出局部覆盖带(未覆盖像素按 `fill` 策略处理),并将其范围写入结果。
   */
  projection?: EquirectProjection
  /**
   * 球面输出时未覆盖区域的填充方式,默认 `'edge'`:
   * - `'edge'`:**先横向后纵向**补 —— 每行先横向接续(两侧月牙被同行最近的天空/地面
   *   内容接上),再向天顶 / 天底铺该列的边缘颜色,与真机球面全景的观感一致;
   *   填完输出完全不透明。细节见 `fillEdges` 注释;
   * - `'none'`:保持透明(需 PNG)。
   */
  fill?: EquirectFill
  /** 羽化带宽(占半幅比例,0~0.9),默认 0.22 */
  feather?: number
  /** 未覆盖区域的底色;不给 = 保持透明(需要 PNG) */
  background?: string | null
  /** 输出 MIME,默认 `image/png`(透明角落需要 PNG);用 `image/jpeg` 时请同时给 `background` */
  mimeType?: string
  /** JPEG 质量(0~1),默认 0.9 */
  quality?: number
}

/** 一张影像在"全景参考系"里的取景几何 */
interface ShotGeometry {
  image: CapturedImage
  /** 取景中心方位角(度,相对本组起始航向;正值 = 向右) */
  theta: number
  /** 取景中心仰角(度,绝对) */
  phi: number
  /** 半视场角的正切(水平 / 垂直) */
  tanH: number
  tanV: number
  /**
   * 相机在全景参考系里的三个基向量:**右 / 上 / 前**。
   * 前 = 该张的取景方向,右 = 前 × 上(右手系,与"方位角增大向右"一致)。
   */
  right: [number, number, number]
  up: [number, number, number]
  forward: [number, number, number]
  /** 该张在方位 / 仰角上的覆盖半宽(度,由四角实测,不是 tan 近似) */
  halfTheta: number
  halfPhi: number
}

/** 输出图对应的方位/仰角范围 */
interface CoverageBand {
  /** 最左列的方位角(度,可越出 ±180:组内某张可能在 -131°) */
  thetaStart: number
  /** 方位跨度(度,≤ 360) */
  spanTheta: number
  /** 最上一行的仰角(度) */
  phiTop: number
  /** 仰角跨度(度) */
  spanPhi: number
}

/** 一次拼接的运行期状态(逐张累加时复用) */
interface StitchTarget {
  width: number
  height: number
  thetaStart: number
  spanTheta: number
  /** 带是否首尾相接(整圈):只有整圈才允许输出列 mod 回绕 */
  wrapsTheta: boolean
  phiTop: number
  spanPhi: number
  /** 每列 / 每行的方向分量表(避免逐像素调三角函数) */
  sinTheta: Float32Array
  cosTheta: Float32Array
  sinPhi: Float32Array
  cosPhi: Float32Array
  /** 颜色累加(RGB)与权重累加 */
  acc: Float32Array
  wsum: Float32Array
  /** 每个输出像素被多少张源照片直接覆盖 */
  coverageCount: Uint8Array
  feather: number
  colsPerDeg: number
  rowsPerDeg: number
}

/**
 * 库内默认的全景拼接器:按已知取景位姿把一组照片反投影成**一张等距柱状全景图**。
 *
 * 与库的其它模块一样是纯浏览器的原生实现(只用 `document.createElement('canvas')`),
 * 不引任何依赖;`stitch()` 里逐张 `await` 让出事件循环,所以能边拼边播进度。
 */
export class EquirectStitcher implements PanoramaStitcher {
  /** 逐张回调(已完成张数 / 总张数),供 UI 播进度;不设则不回调 */
  onProgress: ((done: number, total: number) => void) | null = null

  private readonly pixelsPerDegree: number
  private readonly maxWidth: number
  private readonly maxHeight: number
  private readonly projection: EquirectProjection | undefined
  private readonly fill: EquirectFill
  private readonly feather: number
  private readonly background: string | null
  private readonly mimeType: string
  private readonly quality: number

  /** 构造拼接器:定输出尺寸/投影(fill/band)/补边策略,可复用 */
  constructor(options: EquirectStitcherOptions = {}) {
    this.pixelsPerDegree = clampNumber(options.pixelsPerDegree, 1, 40, DEFAULT_PIXELS_PER_DEGREE)
    this.maxWidth = clampNumber(options.maxWidth, 64, 16384, DEFAULT_MAX_WIDTH)
    this.maxHeight = clampNumber(options.maxHeight, 64, 16384, DEFAULT_MAX_HEIGHT)
    this.projection = options.projection
    this.fill = options.fill === 'none' ? 'none' : 'edge'
    this.feather = clampNumber(options.feather, 0, 0.9, DEFAULT_FEATHER)
    this.background = options.background ?? null
    this.mimeType = options.mimeType ?? 'image/png'
    this.quality = clampNumber(options.quality, 0, 1, 0.9)
  }

  /**
   * 把一组全景照片拼成一张等距柱状全景图。
   *
   * 默认按模式输出:球形 360° 为整颗球(360°×180°、2:1),广角/180° 为局部全景带。
   * 可通过 `projection` 显式覆盖,见 `EquirectStitcherOptions`。
   * 返回 `null` 的情况:非浏览器环境、组内可用影像少于 2 张、没有 DOM canvas、
   * 或者一张都没加载成功 —— 这些都是"没得拼",而不是"拼坏了"。
   */
  async stitch(group: PanoramaGroup): Promise<PanoramaStitchResult | null> {
    if (typeof document === 'undefined') return null
    const shots = buildGeometries(group)
    this.onProgress?.(0, shots.length)
    if (shots.length < 2) return null

    // 球面全景输出整球;宽角/180°输出局部带,避免把没拍的背面伪装成球面。
    const projection = this.projection ?? (group.mode === 'pano-360' ? 'sphere' : 'band')
    const coverageBand = computeBand(shots)
    const band =
      projection === 'sphere'
        ? SPHERE_BAND
        : group.mode === 'pano-180' && coverageBand
          ? { ...coverageBand, thetaStart: -90, spanTheta: 180 }
          : coverageBand
    if (!band) return null

    // ── 输出画布尺寸:按覆盖范围 × 分辨率,再按上限整体缩放(2:1 等比不变) ──
    let width = Math.max(2, Math.round(band.spanTheta * this.pixelsPerDegree))
    let height = Math.max(2, Math.round(band.spanPhi * this.pixelsPerDegree))
    const shrink = Math.min(1, this.maxWidth / width, this.maxHeight / height)
    if (shrink < 1) {
      width = Math.max(2, Math.round(width * shrink))
      height = Math.max(2, Math.round(height * shrink))
    }

    const target = createTarget(band, width, height, this.feather)
    const source = document.createElement('canvas')
    const sourceCtx = source.getContext('2d', { willReadFrequently: true })
    if (!sourceCtx) return null

    let loaded = 0
    for (let i = 0; i < shots.length; i += 1) {
      const shot = shots[i]
      if (!shot) continue
      const image = await loadImage(shot.image.imageUrl)
      if (image) {
        const pixels = readPixels(source, sourceCtx, image)
        if (pixels) {
          accumulateShot(target, shot, pixels.data, pixels.width, pixels.height)
          loaded += 1
        }
      }
      this.onProgress?.(i + 1, shots.length)
      // 让出事件循环:进度条要能画出来,长任务别把主线程焊死
      await yieldToEventLoop()
    }
    if (!loaded) return null

    const composed = compose(target, this.fill)
    const output = document.createElement('canvas')
    output.width = width
    output.height = height
    const outputCtx = output.getContext('2d')
    if (!outputCtx) return null
    if (this.background) {
      // 先铺底再叠图:ImageData 里未覆盖处 alpha = 0,合成后露出底色(JPEG 需要不透明底)
      outputCtx.fillStyle = this.background
      outputCtx.fillRect(0, 0, width, height)
      const layer = document.createElement('canvas')
      layer.width = width
      layer.height = height
      layer.getContext('2d')?.putImageData(composed.image, 0, 0)
      outputCtx.drawImage(layer, 0, 0)
    } else {
      outputCtx.putImageData(composed.image, 0, 0)
    }

    const diagnostic = createCoverageMap(target)
    return {
      url: output.toDataURL(this.mimeType, this.quality),
      diagnosticUrl: diagnostic.url,
      diagnosticCoverage: diagnostic.coverage,
      width,
      height,
      name: `${group.id}.png`,
      coverage: composed.covered / (width * height),
      equirectangular: {
        ...band,
        wrapsTheta: target.wrapsTheta,
      },
    }
  }
}

/** 输出纯色覆盖热力图,不叠加全景照片,便于直接识别视角空洞与低重叠区。 */
function createCoverageMap(target: StitchTarget): {
  url: string
  coverage: { uncovered: number; single: number; overlap: number }
} {
  const canvas = document.createElement('canvas')
  canvas.width = target.width
  canvas.height = target.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('[EquirectStitcher] 无法创建覆盖诊断画布')
  const image = ctx.createImageData(target.width, target.height)
  let uncovered = 0
  let single = 0
  let overlap = 0
  for (let i = 0; i < target.coverageCount.length; i += 1) {
    const count = target.coverageCount[i] ?? 0
    const offset = i * 4
    if (count === 0) {
      image.data[offset] = 239
      image.data[offset + 1] = 68
      image.data[offset + 2] = 68
      uncovered += 1
    } else if (count === 1) {
      image.data[offset] = 250
      image.data[offset + 1] = 204
      image.data[offset + 2] = 21
      single += 1
    } else {
      image.data[offset] = 34
      image.data[offset + 1] = 197
      image.data[offset + 2] = 94
      overlap += 1
    }
    image.data[offset + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  const total = target.width * target.height
  return {
    url: canvas.toDataURL('image/png'),
    coverage: {
      uncovered: uncovered / total,
      single: single / total,
      overlap: overlap / total,
    },
  }
}

/** 建一个默认参数的等距柱状拼接器(库内默认注入给影像集弹窗的"一键合成") */
export function createEquirectStitcher(options: EquirectStitcherOptions = {}): EquirectStitcher {
  return new EquirectStitcher(options)
}

// ───────────────────────────── 取景几何 ─────────────────────────────

/** 由全景组的影像元数据重建每张的取景锥体 */
function buildGeometries(group: PanoramaGroup): ShotGeometry[] {
  const geometries: ShotGeometry[] = []
  for (const image of group.images) {
    const pano = image.metadata.panorama
    if (!pano || !image.imageUrl) continue
    const theta = pano.bodyYaw
    const phi = pano.pitch
    const { tanH, tanV } = fieldsOfView(image)
    const forward = direction(theta, phi)
    const up = upVector(theta, phi)
    const right = cross(forward, up)
    const half = angularExtent(theta, phi, right, up, forward, tanH, tanV)
    geometries.push({ image, theta, phi, tanH, tanV, right, up, forward, ...half })
  }
  // 按组内序号排:累加顺序影响不了加权平均,但这让"覆盖带"的推演可复现
  geometries.sort(
    (a, b) => (a.image.metadata.panorama?.index ?? 0) - (b.image.metadata.panorama?.index ?? 0),
  )
  return geometries
}

/** 取景方向单位向量:方位角 θ(0 = 组起始航向,增大向右)、仰角 φ(0 = 水平) */
function direction(theta: number, phi: number): [number, number, number] {
  const t = theta * DEG
  const p = phi * DEG
  const cosP = Math.cos(p)
  return [Math.sin(t) * cosP, Math.sin(p), -Math.cos(t) * cosP]
}

/** 取景相机的"上"方向(∂方向/∂φ,已归一) */
function upVector(theta: number, phi: number): [number, number, number] {
  const t = theta * DEG
  const p = phi * DEG
  const sinP = Math.sin(p)
  return [-Math.sin(t) * sinP, Math.cos(p), Math.cos(t) * sinP]
}

function cross(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/** 单张影像的视场角正切(优先用记录的水平/垂直 FOV,退化到焦距,再退化到兜底值) */
function fieldsOfView(image: CapturedImage): { tanH: number; tanV: number } {
  const intrinsics = image.cameraIntrinsics
  let tanH = FALLBACK_TAN_H
  let tanV = FALLBACK_TAN_V
  if (intrinsics) {
    if (typeof intrinsics.horizontalFovDeg === 'number' && intrinsics.horizontalFovDeg > 0) {
      tanH = Math.tan((intrinsics.horizontalFovDeg / 2) * DEG)
    } else if (typeof intrinsics.fx === 'number' && intrinsics.fx > 0 && intrinsics.width > 0) {
      tanH = intrinsics.width / 2 / intrinsics.fx
    }
    if (typeof intrinsics.verticalFovDeg === 'number' && intrinsics.verticalFovDeg > 0) {
      tanV = Math.tan((intrinsics.verticalFovDeg / 2) * DEG)
    } else if (typeof intrinsics.fy === 'number' && intrinsics.fy > 0 && intrinsics.height > 0) {
      tanV = intrinsics.height / 2 / intrinsics.fy
    }
  }
  return { tanH: Math.max(1e-4, tanH), tanV: Math.max(1e-4, tanV) }
}

/**
 * 实测该张在方位 / 仰角上的覆盖半宽。
 *
 * 不拿 `atan(tanH)` 近似:那个只在仰角为 0 时成立 —— 仰角一大,同样的水平半视场
 * 对应的方位跨度会明显变宽(相机斜着看,画面边缘离中心方位更远)。
 * 逐角点实测才能保证"覆盖矩形"真的包住这张影像。
 */
export function angularExtent(
  centerTheta: number,
  centerPhi: number,
  right: [number, number, number],
  up: [number, number, number],
  forward: [number, number, number],
  tanH: number,
  tanV: number,
): { halfTheta: number; halfPhi: number } {
  const samples: Array<[number, number]> = [
    [0, 0],
    [-tanH, -tanV],
    [tanH, -tanV],
    [-tanH, tanV],
    [tanH, tanV],
    [0, -tanV],
    [0, tanV],
    [-tanH, 0],
    [tanH, 0],
  ]
  let maxT = 0
  let halfP = 0
  for (const sample of samples) {
    const a = sample[0]
    const b = sample[1]
    const dx = a * right[0] + b * up[0] + forward[0]
    const dy = a * right[1] + b * up[1] + forward[1]
    const dz = a * right[2] + b * up[2] + forward[2]
    const len = Math.hypot(dx, dy, dz) || 1
    // 方位角相对本张中心**解回绕**再取绝对值:组内某张中心在 ±180 附近时,
    // 直接比 atan2 的原始值会得到 ~360° 的假跨度
    const theta = wrap180(Math.atan2(dx / len, -dz / len) * RAD - centerTheta)
    const phi = Math.asin(Math.max(-1, Math.min(1, dy / len))) * RAD
    if (Math.abs(theta) > maxT) maxT = Math.abs(theta)
    halfP = Math.max(halfP, Math.abs(phi - centerPhi))
  }
  return { halfTheta: Math.max(maxT, 0.5), halfPhi: Math.max(halfP, 0.5) }
}

/**
 * 求输出图要覆盖的方位 / 仰角范围。
 *
 * 方位是**环上的区间**:把每张的覆盖区间 [θ-半宽, θ+半宽] 归到圈上合并,
 * 最大的那段空隙就是"没拍到的那一段",覆盖带 = 空隙之外的那一整段。
 * 于是 180° 组(窄视场)自然得到"约 240° 的一条带"(不是整圈),360° 组得到整圈 —— 同一套算法。
 *
 * ⚠️ 端点必须取**区间并集**的边缘,不能拿"中心相距最远的那两张"各加半宽凑数:
 * 同一列的三张俯仰不同,角点的方位半宽差得很多(俯仰越大角点甩得越远),
 * 拿哪一张代表这一列是任意的 —— 拿窄的那张,带端点就切掉同列宽张的真实内容;
 * 拿宽的那张,另一端又多出一段谁也没拍到的空带。
 */
function computeBand(shots: ShotGeometry[]): CoverageBand | null {
  if (!shots.length) return null
  let phiTop = -Infinity
  let phiBottom = Infinity
  for (const shot of shots) {
    phiTop = Math.max(phiTop, shot.phi + shot.halfPhi)
    phiBottom = Math.min(phiBottom, shot.phi - shot.halfPhi)
  }
  const spanPhi = Math.max(1, phiTop - phiBottom)

  // 每张的覆盖区间归到 [0,360),跨圈的拆成两段;单张就盖满整圈的直接返回整圈
  const intervals: Array<{ lo: number; hi: number }> = []
  for (const shot of shots) {
    if (shot.halfTheta * 2 >= 360) {
      return { thetaStart: 0, spanTheta: 360, phiTop, spanPhi }
    }
    const lo = mod(shot.theta - shot.halfTheta, 360)
    const hi = lo + shot.halfTheta * 2
    if (hi > 360) {
      intervals.push({ lo, hi: 360 })
      intervals.push({ lo: 0, hi: hi - 360 })
    } else {
      intervals.push({ lo, hi })
    }
  }
  intervals.sort((a, b) => a.lo - b.lo)

  const merged: Array<{ lo: number; hi: number }> = []
  for (const interval of intervals) {
    const last = merged[merged.length - 1]
    if (last && interval.lo <= last.hi) {
      last.hi = Math.max(last.hi, interval.hi)
    } else {
      merged.push({ lo: interval.lo, hi: interval.hi })
    }
  }
  if (!merged.length) return null
  // 合并后只剩一段且几乎盖满整圈:按整圈处理( accumulateShot 里允许列回绕)
  const only = merged[0]
  if (merged.length === 1 && only && only.hi - only.lo >= 360 - 1e-6) {
    return { thetaStart: only.lo, spanTheta: 360, phiTop, spanPhi }
  }

  // 找最大的空隙:空隙之后的合并段是带的首段,空隙之前的是末段
  let gap = -Infinity
  let startIndex = 0
  let endIndex = 0
  for (let i = 0; i < merged.length; i += 1) {
    const current = merged[i]
    const next = merged[(i + 1) % merged.length]
    if (!current || !next) continue
    const delta = i === merged.length - 1 ? next.lo + 360 - current.hi : next.lo - current.hi
    if (delta > gap) {
      gap = delta
      startIndex = (i + 1) % merged.length
      endIndex = i
    }
  }
  const first = merged[startIndex]
  const lastArc = merged[endIndex]
  if (!first || !lastArc) return null
  const thetaStart = first.lo
  const spanTheta = Math.min(
    360,
    Math.max(1, lastArc.hi + (endIndex < startIndex ? 360 : 0) - thetaStart),
  )
  return { thetaStart, spanTheta, phiTop, spanPhi }
}

// ───────────────────────────── 逐张累加 ─────────────────────────────

function createTarget(
  band: CoverageBand,
  width: number,
  height: number,
  feather: number,
): StitchTarget {
  const sinTheta = new Float32Array(width)
  const cosTheta = new Float32Array(width)
  const thetaStep = band.spanTheta / width
  for (let c = 0; c < width; c += 1) {
    const t = (band.thetaStart + (c + 0.5) * thetaStep) * DEG
    sinTheta[c] = Math.sin(t)
    cosTheta[c] = Math.cos(t)
  }
  const sinPhi = new Float32Array(height)
  const cosPhi = new Float32Array(height)
  const phiStep = band.spanPhi / height
  for (let r = 0; r < height; r += 1) {
    const p = (band.phiTop - (r + 0.5) * phiStep) * DEG
    sinPhi[r] = Math.sin(p)
    cosPhi[r] = Math.cos(p)
  }
  return {
    width,
    height,
    thetaStart: band.thetaStart,
    spanTheta: band.spanTheta,
    wrapsTheta: band.spanTheta >= 360 - 1e-6,
    phiTop: band.phiTop,
    spanPhi: band.spanPhi,
    sinTheta,
    cosTheta,
    sinPhi,
    cosPhi,
    acc: new Float32Array(width * height * 3),
    wsum: new Float32Array(width * height),
    coverageCount: new Uint8Array(width * height),
    feather,
    colsPerDeg: width / band.spanTheta,
    rowsPerDeg: height / band.spanPhi,
  }
}

/**
 * 把一张影像按反投影累加进输出缓冲。
 *
 * 循环是"以这张影像的输出矩形为界"的 —— 全景各张在输出图上只占一小块,
 * 逐张只扫自己那块,总工作量 ≈ 各张覆盖面积之和,而不是"输出像素 × 张数"。
 */
function accumulateShot(
  target: StitchTarget,
  shot: ShotGeometry,
  pixels: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
): void {
  const base = mod(shot.theta - target.thetaStart, 360)
  if (base >= target.spanTheta) return // 落在未覆盖的空隙里(理论上只在极端不完整的组上出现)

  const colFrom = Math.floor((base - shot.halfTheta) * target.colsPerDeg) - 1
  const colTo = Math.ceil((base + shot.halfTheta) * target.colsPerDeg) + 1
  // 非整圈带不允许列回绕:越出带的列是"带外"(没人拍到),不是"带的另一端"。
  // 整圈带首尾真的相接,mod 回绕才是正确语义 —— 180° 组若也回绕,
  // 最左列那张的左半边会被复制到最右列,两端各叠出一块鬼影。
  const colLo = target.wrapsTheta ? colFrom : Math.max(0, colFrom)
  const colHi = target.wrapsTheta ? colTo : Math.min(target.width - 1, colTo)
  const rowFrom = Math.max(
    0,
    Math.floor((target.phiTop - (shot.phi + shot.halfPhi)) * target.rowsPerDeg) - 1,
  )
  const rowTo = Math.min(
    target.height - 1,
    Math.ceil((target.phiTop - (shot.phi - shot.halfPhi)) * target.rowsPerDeg) + 1,
  )
  if (rowFrom > rowTo) return

  const [rx, ry, rz] = shot.right
  const [ux, uy, uz] = shot.up
  const [fx, fy, fz] = shot.forward
  const tanH = shot.tanH
  const tanV = shot.tanV
  const featherStart = 1 - target.feather
  const maxX = imageWidth - 1
  const maxY = imageHeight - 1

  for (let r = rowFrom; r <= rowTo; r += 1) {
    const sinP = target.sinPhi[r] ?? 0
    const cosP = target.cosPhi[r] ?? 1
    const rowBase = r * target.width
    for (let c = colLo; c <= colHi; c += 1) {
      const col = mod(c, target.width)
      const sinT = target.sinTheta[col] ?? 0
      const cosT = target.cosTheta[col] ?? 1
      // 该输出像素在全景参考系里的方向
      const dx = sinT * cosP
      const dy = sinP
      const dz = -cosT * cosP
      // 转到这张的相机系:相机 x = 右、y = 上、深度 = 前
      const a = dx * rx + dy * ry + dz * rz
      const b = dx * ux + dy * uy + dz * uz
      const depth = dx * fx + dy * fy + dz * fz
      if (depth <= 1e-6) continue
      const xn = a / depth
      const yn = b / depth
      if (xn < -tanH || xn > tanH || yn < -tanV || yn > tanV) continue

      const nx = xn / tanH // -1 ~ 1
      const ny = yn / tanV
      const weight = taper(Math.abs(nx), featherStart) * taper(Math.abs(ny), featherStart)
      if (weight <= 0) continue

      const px = (nx * 0.5 + 0.5) * maxX
      const py = (0.5 - ny * 0.5) * maxY
      const x0 = px | 0
      const y0 = py | 0
      const x1 = x0 < maxX ? x0 + 1 : maxX
      const y1 = y0 < maxY ? y0 + 1 : maxY
      const tx = px - x0
      const ty = py - y0
      const w00 = (1 - tx) * (1 - ty)
      const w10 = tx * (1 - ty)
      const w01 = (1 - tx) * ty
      const w11 = tx * ty

      const i00 = (y0 * imageWidth + x0) * 4
      const i10 = (y0 * imageWidth + x1) * 4
      const i01 = (y1 * imageWidth + x0) * 4
      const i11 = (y1 * imageWidth + x1) * 4
      const cell = (rowBase + col) * 3
      for (let ch = 0; ch < 3; ch += 1) {
        const value =
          (pixels[i00 + ch] ?? 0) * w00 +
          (pixels[i10 + ch] ?? 0) * w10 +
          (pixels[i01 + ch] ?? 0) * w01 +
          (pixels[i11 + ch] ?? 0) * w11
        target.acc[cell + ch] = (target.acc[cell + ch] ?? 0) + value * weight
      }
      target.wsum[rowBase + col] = (target.wsum[rowBase + col] ?? 0) + weight
      if ((target.coverageCount[rowBase + col] ?? 0) < 255) {
        target.coverageCount[rowBase + col] = (target.coverageCount[rowBase + col] ?? 0) + 1
      }
    }
  }
}

/** 羽化衰减:带宽内保持 1,进入边缘带后二次衰减到下限(下限不为 0,见常量说明) */
function taper(normalized: number, featherStart: number): number {
  if (normalized <= featherStart) return 1
  const band = 1 - featherStart
  if (band <= 1e-6) return MIN_FEATHER_WEIGHT
  const k = (normalized - featherStart) / band
  const decay = 1 - k * k
  return decay < MIN_FEATHER_WEIGHT ? MIN_FEATHER_WEIGHT : decay
}

/**
 * 把累加缓冲归一成像素,并按 `fill` 补上未覆盖区域。
 *
 * `covered` 是**补边之前**真实被影像覆盖的像素数 —— 宿主用 `coverage` 判断这组拍全了没有,
 * 所以不能被填充像素污染。
 */
function compose(target: StitchTarget, fill: EquirectFill): { image: ImageData; covered: number } {
  const width = target.width
  const height = target.height
  const image = new ImageData(width, height)
  const data = image.data
  let covered = 0
  for (let r = 0; r < height; r += 1) {
    const rowBase = r * width
    for (let c = 0; c < width; c += 1) {
      const i = rowBase + c
      const weight = target.wsum[i] ?? 0
      const out = i * 4
      if (weight > 1e-6) {
        const inv = 1 / weight
        data[out] = clampByte((target.acc[i * 3] ?? 0) * inv)
        data[out + 1] = clampByte((target.acc[i * 3 + 1] ?? 0) * inv)
        data[out + 2] = clampByte((target.acc[i * 3 + 2] ?? 0) * inv)
        data[out + 3] = 255
        covered += 1
      } else {
        data[out + 3] = 0
      }
    }
  }
  if (fill === 'edge') fillEdges(width, height, data, target.wrapsTheta)
  if (target.wrapsTheta) closeLongitudeSeam(target, data)
  return { image, covered }
}

/**
 * 让整球输出的左右边界在环绕时连续。两侧各取约 1° 做渐变修正，
 * 避免只改最外一列后在修正区边缘产生新的细线。
 */
function closeLongitudeSeam(target: StitchTarget, data: Uint8ClampedArray): void {
  const { width, height, colsPerDeg } = target
  const blendColumns = Math.min(Math.floor(width / 2), Math.max(1, Math.round(colsPerDeg)))
  for (let r = 0; r < height; r += 1) {
    const row = r * width * 4
    const leftEdge = row
    const rightEdge = row + (width - 1) * 4
    if ((data[leftEdge + 3] ?? 0) === 0 || (data[rightEdge + 3] ?? 0) === 0) continue

    for (let offset = 0; offset < blendColumns; offset += 1) {
      const left = row + offset * 4
      const right = row + (width - 1 - offset) * 4
      const t = offset / blendColumns
      const strength = 1 - t * t * (3 - 2 * t)
      for (let channel = 0; channel < 3; channel += 1) {
        const leftValue = data[left + channel] ?? 0
        const rightValue = data[right + channel] ?? 0
        const midpoint = (leftValue + rightValue) / 2
        data[left + channel] = clampByte(leftValue + (midpoint - leftValue) * strength)
        data[right + channel] = clampByte(rightValue + (midpoint - rightValue) * strength)
      }
    }
  }
}

/**
 * 把未覆盖像素补上,得到一张不透明的整幅球面图(真机全景的观感)。两步,**先横向后纵向**:
 *
 * ① **行内延展** —— 每一行里没覆盖到的段,用同行最近的已覆盖像素横向接上(整圈才允许绕回)。
 *    这一步专治"两侧月牙":顶层照片够不到的高仰角 + 大方位偏移区,和它在**同一行**的
 *    最近覆盖像素是顶层画面的边缘(天空),横向接上就是自然的延续。若先做纵向,
 *    这些列的最高覆盖行在地平线附近(暗),会把地面色一路拖到天顶,拉出一根根暗柱。
 * ② **列向延展** —— 天顶 / 天底方向(整行都没人拍的行)用该列最高 / 最低覆盖行铺:
 *    天空蓝一路铺到天顶、地面黑一路铺到天底,正是球面全景两端的观感。
 *
 * ⚠️ ② 还必须补 colTop~colBot 之间的"中间整行空隙":俯仰层间没有重叠时,会出现整圈
 * 空纬度带。用最近一侧整行硬复制会形成明显环状色阶(看起来像一圈墙),所以对空洞按
 * 纬度在上下有效行之间做渐变;这只是减轻未覆盖处的硬边,不能代替拍摄时的真实重叠。
 */
function fillEdges(width: number, height: number, data: Uint8ClampedArray, wraps: boolean): void {
  horizontalFill(width, height, data, wraps)
  verticalFill(width, height, data)
}

/** 行内延展:每行未覆盖段用同行最近的已覆盖像素补(环形与否按整圈/带状定) */
function horizontalFill(
  width: number,
  height: number,
  data: Uint8ClampedArray,
  wraps: boolean,
): void {
  const rowBytes = width * 4
  const covered = new Uint8Array(width)
  const nearL = new Int32Array(width)
  const nearR = new Int32Array(width)
  for (let r = 0; r < height; r += 1) {
    const base = r * rowBytes
    let first = -1
    let last = -1
    for (let c = 0; c < width; c += 1) {
      covered[c] = (data[base + c * 4 + 3] ?? 0) > 0 ? 1 : 0
      if ((covered[c] ?? 0) !== 0) {
        if (first < 0) first = c
        last = c
      }
    }
    if (first < 0) continue // 整行都没拍到:交给列向延展
    let p = -1
    for (let c = 0; c < width; c += 1) {
      nearL[c] = covered[c] ? c : p
      if (covered[c]) p = c
    }
    p = -1
    for (let c = width - 1; c >= 0; c -= 1) {
      nearR[c] = covered[c] ? c : p
      if (covered[c]) p = c
    }
    for (let c = 0; c < width; c += 1) {
      if ((covered[c] ?? 0) !== 0) continue
      const fromL = nearL[c] ?? -1
      const fromR = nearR[c] ?? -1
      let pick = -1
      let best = Infinity
      if (fromL >= 0) {
        pick = fromL
        best = c - fromL
      }
      if (fromR >= 0 && fromR - c < best) {
        pick = fromR
        best = fromR - c
      }
      if (wraps) {
        if (last >= 0) {
          const d = c + width - last
          if (d < best) {
            pick = last
            best = d
          }
        }
        if (first >= 0) {
          const d = width - c + first
          if (d < best) {
            pick = first
            best = d
          }
        }
      }
      if (pick >= 0) copyPixel(data, base + pick * 4, base + c * 4)
    }
  }
}

/** 列向延展:天顶 / 天底方向用该列最高 / 最低覆盖行铺;并补中间整行空隙(见 fillEdges 注释) */
function verticalFill(width: number, height: number, data: Uint8ClampedArray): void {
  const rowBytes = width * 4
  const colTop = new Int32Array(width).fill(-1)
  const colBot = new Int32Array(width).fill(-1)
  for (let r = 0; r < height; r += 1) {
    const base = r * rowBytes
    for (let c = 0; c < width; c += 1) {
      if ((data[base + c * 4 + 3] ?? 0) > 0) {
        if ((colTop[c] ?? -1) < 0) colTop[c] = r
        colBot[c] = r
      }
    }
  }
  // 复用的"更近一侧覆盖行"scratch:每列各扫一遍,避免逐列新建数组
  const nearAbove = new Int32Array(height).fill(-1)
  const nearBelow = new Int32Array(height).fill(-1)
  for (let c = 0; c < width; c += 1) {
    const top = colTop[c] ?? -1
    const bot = colBot[c] ?? -1
    if (top < 0 || bot < 0) continue
    const colOff = c * 4
    // 天顶方向:top 以上用 top 行铺
    const srcTop = top * rowBytes + colOff
    for (let r = 0; r < top; r += 1) copyPixel(data, srcTop, r * rowBytes + colOff)
    // 天底方向:bot 以下用 bot 行铺
    const srcBot = bot * rowBytes + colOff
    for (let r = bot + 1; r < height; r += 1) copyPixel(data, srcBot, r * rowBytes + colOff)
    // 中间整行空隙:top..bot 之间没人拍到的行,取更近一侧(上 / 下)的已覆盖行铺
    let last = -1
    for (let r = top; r <= bot; r += 1) {
      if ((data[r * rowBytes + colOff + 3] ?? 0) > 0) last = r
      nearAbove[r] = last
    }
    last = -1
    for (let r = bot; r >= top; r -= 1) {
      if ((data[r * rowBytes + colOff + 3] ?? 0) > 0) last = r
      nearBelow[r] = last
    }
    for (let r = top; r <= bot; r += 1) {
      if ((data[r * rowBytes + colOff + 3] ?? 0) > 0) continue
      const above = nearAbove[r] ?? -1
      const below = nearBelow[r] ?? -1
      const dst = r * rowBytes + colOff
      if (above >= 0 && below >= 0) {
        const upper = above * rowBytes + colOff
        const lower = below * rowBytes + colOff
        const blend = (r - above) / (below - above)
        for (let channel = 0; channel < 3; channel += 1) {
          const upperValue = data[upper + channel] ?? 0
          const lowerValue = data[lower + channel] ?? 0
          data[dst + channel] = clampByte(upperValue + (lowerValue - upperValue) * blend)
        }
        data[dst + 3] = 255
      } else {
        const src = above >= 0 ? above : below
        if (src >= 0) copyPixel(data, src * rowBytes + colOff, dst)
      }
    }
  }
}

function copyPixel(data: Uint8ClampedArray, from: number, to: number): void {
  data[to] = data[from] ?? 0
  data[to + 1] = data[from + 1] ?? 0
  data[to + 2] = data[from + 2] ?? 0
  data[to + 3] = 255
}

// ───────────────────────────── 小工具 ─────────────────────────────

/** 从图片元素里读出像素(用一块复用的 canvas 当解码中转) */
function readPixels(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
): { data: Uint8ClampedArray; width: number; height: number } | null {
  const width = image.naturalWidth || image.width
  const height = image.naturalHeight || image.height
  if (!width || !height) return null
  canvas.width = width
  canvas.height = height
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)
  try {
    const data = ctx.getImageData(0, 0, width, height)
    return { data: data.data, width: data.width, height: data.height }
  } catch {
    // 跨域画布会抛安全错误:数据 URL / Blob URL 不会走到这里,真遇到就当这张读不出来
    return null
  }
}

function loadImage(url: string | undefined): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!url) {
      resolve(null)
      return
    }
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = url
  })
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 取模到 [0, span) */
function mod(value: number, span: number): number {
  if (!(span > 0)) return 0
  const result = value % span
  return result < 0 ? result + span : result
}

/** 方位角收敛到 (-180, 180] */
function wrap180(deg: number): number {
  const wrapped = ((deg + 180) % 360) - 180
  return wrapped === -180 ? 180 : wrapped
}

function clampByte(value: number): number {
  if (!(value > 0)) return 0
  return value > 255 ? 255 : value
}

function clampNumber(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}
