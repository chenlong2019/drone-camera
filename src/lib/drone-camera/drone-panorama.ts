/**
 * 全景拍摄(180° / 360°)—— 大疆式网格扫描。
 *
 * 真机全景不是一个快门拍下来的:机体与云台按**预设网格**转到一串方位,逐张曝光,
 * 相机内部把这一组照片拼成一张全景图。本模块复刻前半段(网格扫描 + 逐张落库),
 * 拼接交给外部(见文件末尾的 `PanoramaStitcher`)—— 库内不做图像配准与融合。
 *
 * ── 网格怎么施加:水平靠**机体原地自转**,垂直靠云台俯仰 ──────────────────
 *
 * ⚠️ 这是本模块唯一容易做错的地方。Mini 4 Pro 的云台 Pan(水平转)机械行程只有
 * **±30°**(本库 `DRONE_SPEC.gimbalYawRange` 按 ±5° 建模),而 180° 全景需要 ±90° 水平
 * 视野 —— 云台根本转不出来。所以真机的做法是:
 *
 * - **水平**:飞行器定点悬停、**空间坐标不动、原地自转机身**(Yaw),每转到一个方位停下来;
 * - **垂直**:云台只做俯仰分层(上 / 中 / 下),每层一张;
 * - 180°:7 个方位 × 3 个俯仰 = 21 张;
 * - 球形 360°:8 个方位;垂直层数按相机实际垂直视场自动计算,另拍天顶与天底。
 *
 * 一句话:**水平广角靠机身原地自转,垂直分层靠云台俯仰**。因此本模块的扫描循环
 * 是「先转机身到这一列 → 再按行拍俯仰」,而不是"只转取景相机"。老款 Mavic 2 有大角度
 * 云台 Pan,可以云台自己转着拍;Mini 系列不行。
 *
 * ── 三条设计约束 ──────────────────────────────────────────────────────
 *
 * - **只依赖 `CaptureService`**:转机身走 `spinBodyTo`(后端把目标航向交给飞控内核)、
 *   俯仰覆盖走 `setCaptureView`(见 `captureVirtualImage` 的 `options.view`)。
 *   模块本身既拿不到也不该拿渲染后端,换渲染器时一行都不用改。
 * - **每张都带全景定位**:写进 `CapturedImage.metadata.panorama`(组 id / 模式 / 序号 /
 *   总数 / 行列 / 该张的机身航向偏移与俯仰)。组内照片因此可被后端按 `group` 聚合、
 *   按 `index` 排序,单独一张也仍是完整的影像条目(有位姿、有内参、可单独校验)。
 * - **串行**:渲染后端的拍照是"一帧一张"的(上一张未取回时 `requestPhoto()` 会拒),
 *   所以扫描必须等一张落地再动下一个方位,否则会丢帧。
 *
 * ```ts
 * const pano = new PanoramaCapture(captureService)
 * pano.subscribe((p) => console.log(`${p.index}/${p.total}`))
 * const result = await pano.start(session.id, 'pano-360')   // 垂直层数按实际视场自适应
 * pano.cancel()                                             // 中途可停
 * ```
 */
import type { CaptureService, CapturedImage, PanoramaShotRef } from './drone-capture'

/** 全景模式 */
export type PanoramaMode = 'pano-wide' | 'pano-180' | 'pano-360'

/** 网格里的一个拍摄点 */
export interface PanoramaShotSpec {
  /** 组内序号(1 起,按扫描顺序:先扫完一个机身方位,再转下一个) */
  index: number
  /** 网格行列(0 起;row = 俯仰层, col = 机身水平方位) */
  row: number
  col: number
  /** 该张的**机身航向偏移**(度,相对本组起始航向;正值 = 向右/顺时针) */
  bodyYaw: number
  /** 该张的取景俯仰(度,相对水平面的绝对值) */
  pitch: number
}

/** 全景预设 */
export interface PanoramaPreset {
  mode: PanoramaMode
  label: string
  /** 纵向拍摄层数(含球形模式单独补拍的天顶/天底) */
  rows: number
  /** 机身水平方位数(每一列要原地自转一次) */
  cols: number
  /** 环拍网格每层的取景俯仰(度);按从上到下排列 */
  rowPitches: number[]
  /** 第一列的机身偏航(度,相对起始航向) */
  bodyYawStart: number
  /** 每列之间的机身偏航步进(度) */
  bodyYawStep: number
  /**
   * 扫描结束时机身应停在的偏航(度,相对起始航向)。
   * 180° 网格停在 +90°(就是最后一列);球形 360° 补完天底后回到起始航向。
   */
  finalBodyYaw: number
  /** 全部拍摄点(按扫描顺序:列优先) */
  shots: PanoramaShotSpec[]
  total: number
}

/** 无法读取相机内参时采用的保守垂直视场角 */
const FALLBACK_VERTICAL_FOV_DEG = 24
/** 相邻垂直视场的最大中心间距比例;step <= FOV×0.6 即至少 40% 角度重叠 */
const MAX_VERTICAL_STEP_FOV_RATIO = 0.6

/**
 * 广角采用 3×3 网格(9 张);180° 采用 7×3 网格(21 张);
 * 球形 360° 采用 8 个方位;俯仰层数按相机实际垂直视场自动计算,并补天顶/天底。
 *
 * - 广角:机身方位 -30°/0°/+30°,每个方位拍 +20°/0°/-20°,共 9 张;
 * - 180°:机身从 -90° 转到 +90°(共 180°),7 个方位 × 3 层 = 21 张,拍完就停在 +90°;
 * - 360° 球形:8 个方位(0°~315°,步进 45°);俯仰层根据实际垂直视场布满 -90°~+90°,
 *   相邻层中心距不超过垂直 FOV 的 60%,再补天顶/天底;拍完机身回到起始航向。
 *
 * 垂直环拍步长按实际垂直 FOV 计算:中心间距最大为 FOV×0.6,保留至少 40% 理论重叠,
 * 避免宽屏窄垂直视场下固定步长留下整圈未覆盖纬度带。
 * 额外的天顶与天底照片覆盖球面两极,而不是依赖合成器把最近边缘像素拉伸过去。
 * 360° 用 45° 方位步进;默认 Cesium 水平视场约 60°,仍有约 15° 水平重叠。
 */
export const PANORAMA_PRESETS: Record<PanoramaMode, PanoramaPreset> = {
  'pano-wide': buildPreset('pano-wide', '广角', {
    bodyYawStart: -30,
    cols: 3,
    bodyYawStep: 30,
    rowPitches: [20, 0, -20],
    finalBodyYaw: 30,
  }),
  'pano-180': buildPreset('pano-180', '180° 全景', {
    bodyYawStart: -90,
    cols: 7,
    bodyYawStep: 30,
    rowPitches: [20, -15, -50],
    // 收尾姿态 = 最后一列(+90°),不再多转
    finalBodyYaw: 90,
  }),
  'pano-360': buildPreset('pano-360', '360° 全景', {
    bodyYawStart: 0,
    cols: 8,
    bodyYawStep: 45,
    rowPitches: sphericalPitchGrid(FALLBACK_VERTICAL_FOV_DEG),
    // 天顶/天底与首列同方位;拍完整球后机身回到起始航向
    finalBodyYaw: 0,
    poles: true,
  }),
}

/** 供 UI 渲染的稳定顺序 */
export const PANORAMA_MODE_LIST: PanoramaMode[] = ['pano-wide', 'pano-180', 'pano-360']

function buildPreset(
  mode: PanoramaMode,
  label: string,
  spec: {
    bodyYawStart: number
    cols: number
    bodyYawStep: number
    rowPitches: number[]
    finalBodyYaw: number
    poles?: boolean
  },
): PanoramaPreset {
  const shots: PanoramaShotSpec[] = []
  if (spec.poles) {
    shots.push({ index: shots.length + 1, row: 0, col: 0, bodyYaw: 0, pitch: 90 })
  }
  // 列优先:真机是"转一个方位 → 上中下三张",不是"每个俯仰层转一圈"
  for (let col = 0; col < spec.cols; col += 1) {
    const bodyYaw = normalizeYaw(spec.bodyYawStart + col * spec.bodyYawStep)
    spec.rowPitches.forEach((pitch, row) => {
      shots.push({ index: shots.length + 1, row: row + (spec.poles ? 1 : 0), col, bodyYaw, pitch })
    })
  }
  if (spec.poles) {
    shots.push({
      index: shots.length + 1,
      row: spec.rowPitches.length + 1,
      col: 0,
      bodyYaw: 0,
      pitch: -90,
    })
  }
  return {
    mode,
    label,
    rows: spec.rowPitches.length + (spec.poles ? 2 : 0),
    cols: spec.cols,
    rowPitches: [...spec.rowPitches],
    bodyYawStart: spec.bodyYawStart,
    bodyYawStep: spec.bodyYawStep,
    finalBodyYaw: spec.finalBodyYaw,
    shots,
    total: shots.length,
  }
}

/** 把角度收敛到 (-180, 180],读起来更直观(-90 而不是 270) */
function normalizeYaw(deg: number): number {
  const wrapped = ((deg + 180) % 360) - 180
  return wrapped === -180 ? 180 : wrapped
}

/** 方位角归一到 [0, 360):罗盘角没有负数 */
function normalizeHeading(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/** 两个方位角之间的最小夹角(度,恒为非负) */
function headingGap(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

/** 全景扫描状态 */
export type PanoramaState = 'idle' | 'running' | 'done' | 'cancelled' | 'failed'

/** 扫描进度(面板订阅它做展示) */
export interface PanoramaProgress {
  state: PanoramaState
  mode: PanoramaMode
  /** 已完成张数 */
  index: number
  total: number
  /** 当前(或刚完成)的网格位置 */
  row: number
  col: number
  /** 当前列的机身航向偏移(度,相对起始航向) */
  bodyYaw: number
  pitch: number
  /** 组 id(开始拍摄后才有) */
  group: string | null
  message?: string
}

/** 一组全景照片(交给拼接器) */
export interface PanoramaGroup {
  id: string
  mode: PanoramaMode
  sessionId: string
  /** 按组内序号排序 */
  images: CapturedImage[]
}

/** 拼接产物(库里只搬运,不解释) */
export interface PanoramaStitchResult {
  /** 可直接显示的地址(blob: / http: / data:);以字符串打开时按标准整球解释 */
  url?: string
  /** 可选的覆盖热力图:红=无照片覆盖,黄=单张覆盖,绿=多张重叠 */
  diagnosticUrl?: string
  /** 覆盖热力图像素占比;未覆盖区域必须由拼接器补边,存在视差风险区域通常只被一张照片覆盖 */
  diagnosticCoverage?: { uncovered: number; single: number; overlap: number }
  /** 也可以直接给二进制,由宿主决定怎么用 */
  blob?: Blob
  width?: number
  height?: number
  name?: string
  /**
   * 有效覆盖比例(0~1) —— 拼接后画面里"真的有像素"的部分占比。
   * 库内自带拼接器(见 drone-stitch)会填;宿主自己的拼接器可以不填。
   * 拿它判断"这组是不是拍漏了"(比如中途没转到位,角落空一块)。
   */
  coverage?: number
  /** 局部全景带的球面范围;缺省表示标准 360°×180° 整球。 */
  equirectangular?: {
    thetaStart: number
    spanTheta: number
    phiTop: number
    spanPhi: number
    wrapsTheta: boolean
  }
}

/**
 * 拼接器接口 —— **库内不提供实现**,由宿主注入(后端服务、WASM 拼接库、离线工具都行)。
 * 整组拍完(未取消)后自动调用一次;返回 null 表示"这次不拼"。
 */
export interface PanoramaStitcher {
  /** 把一组已拍照片拼成等距柱状全景(按位姿反投影;覆盖不足返回 null) */
  stitch(group: PanoramaGroup): Promise<PanoramaStitchResult | null>
}

/** 一次扫描的最终结果 */
export interface PanoramaResult {
  group: string
  mode: PanoramaMode
  total: number
  /** 实际入库张数(成片失败会少于 total) */
  captured: number
  cancelled: boolean
  /** 没能完成的原因(机体没起飞 / 后端不支持自转 / 机身转不到位),成功时为 undefined */
  error?: string
  /** 拼接产物(注入过拼接器且未取消时才有) */
  stitched?: PanoramaStitchResult | null
}

/** `PanoramaCapture` 构造选项 */
export interface PanoramaCaptureOptions {
  /**
   * 每张之间的间隔(毫秒),默认 0(拍完立即转下一个方位)。
   * 想更贴近真机节奏、或给渲染后端留稳定时间时调大(真机每张约 0.5~1s)。
   */
  shotIntervalMs?: number
  /**
   * 等待机身转到位的最长时间(毫秒),默认 8000。
   * 超时即判定"转不过去"(没起飞、正在返航、速度倍率为 0),以失败收尾而不是硬拍。
   */
  spinTimeoutMs?: number
  /** 拼接器(可选) */
  stitcher?: PanoramaStitcher | null
  /** 整组拍完并完成拼接后的回调(宿主落盘 / 提示用) */
  onStitched?: (result: PanoramaStitchResult | null, group: PanoramaGroup) => void
}

/**
 * 判定"机身已转到目标方位"的容差(度)。
 * 取 0.5° 与飞控内核同值:航向是连续量,`turnToward` 的末段步长会缩到恰好落在目标上
 * (不会过冲),所以收得紧一点也能收敛,换来的是"方位角与预设逐格一致"这种干净结论。
 */
const SPIN_TOLERANCE_DEG = 0.5
/** 等待机身自转时的轮询间隔(毫秒) */
const SPIN_POLL_MS = 16
/** 默认的自转等待上限(毫秒):360° 一圈按 90°/s 约 4 s */
const DEFAULT_SPIN_TIMEOUT_MS = 8000
/** 生成组 id 用的时间戳(本地时间,精确到秒) */
function groupStamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 根据相机垂直 FOV 生成覆盖两极的俯仰层,相邻层中心距不超过 FOV 的 60%。 */
export function sphericalPitchGrid(verticalFovDeg: number): number[] {
  const fov = Number.isFinite(verticalFovDeg)
    ? Math.max(1, Math.min(179, verticalFovDeg))
    : FALLBACK_VERTICAL_FOV_DEG
  const intervals = Math.max(2, Math.ceil(180 / (fov * MAX_VERTICAL_STEP_FOV_RATIO)))
  const step = 180 / intervals
  return Array.from({ length: intervals - 1 }, (_, index) => 90 - step * (index + 1))
}

function sphericalPreset(verticalFovDeg: number): PanoramaPreset {
  return buildPreset('pano-360', '360° 全景', {
    bodyYawStart: 0,
    cols: 8,
    bodyYawStep: 45,
    rowPitches: sphericalPitchGrid(verticalFovDeg),
    finalBodyYaw: 0,
    poles: true,
  })
}

/**
 * 全景扫描器:先转机身到方位、再按俯仰层逐张取景拍摄,把每张登记进 `CaptureService` 的会话。
 *
 * 只依赖 `CaptureService` —— 转机身走 `spinBodyTo` / `getBodyHeading`,俯仰覆盖由服务在每张
 * 内部设置并复位(见 `CaptureService.captureVirtualImage` 的 `options.view`),
 * 这里既拿不到也不该拿渲染后端,于是换渲染器时本模块一行都不用改。
 */
export class PanoramaCapture {
  private readonly capture: CaptureService
  private readonly listeners = new Set<(progress: PanoramaProgress) => void>()
  private options: PanoramaCaptureOptions
  /** 取消令牌:自增即让正在跑的扫描退出 */
  private token = 0
  private current: PanoramaProgress | null = null

  /** 构造全景扫描器:按俯仰分层 × 机体自转覆盖 360° */
  constructor(capture: CaptureService, options: PanoramaCaptureOptions = {}) {
    this.capture = capture
    this.options = { ...options }
  }

  /** 是否正在扫描 */
  get running(): boolean {
    return this.current?.state === 'running'
  }

  /** 当前进度快照(未拍摄过返回 null) */
  get progress(): PanoramaProgress | null {
    return this.current ? { ...this.current } : null
  }

  /** 订阅进度变化;返回退订函数 */
  subscribe(listener: (progress: PanoramaProgress) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 设置 / 替换拼接器(传 null 关闭) */
  setStitcher(stitcher: PanoramaStitcher | null): void {
    this.options = { ...this.options, stitcher }
  }

  /** 取预设(UI 展示行列数 / 张数用) */
  static preset(mode: PanoramaMode, verticalFovDeg?: number): PanoramaPreset {
    return mode === 'pano-360' && verticalFovDeg !== undefined
      ? sphericalPreset(verticalFovDeg)
      : PANORAMA_PRESETS[mode]
  }

  /**
   * 开始一次扫描。已在扫描中、或会话不存在时返回 null(不排队,避免误触连发)。
   *
   * 成片失败(如后端某一帧相机未就绪)只计入 `captured` 的缺口,不中断整组 ——
   * 少一张的代价远小于让用户重拍一整组;但**机身转不到位**是另一回事:那说明网格根本没
   * 施加成功(没起飞 / 正在返航 / 速度倍率为 0),继续拍只会得到一堆同一方位的废片,
   * 所以立即以失败收尾。
   */
  async start(sessionId: string, mode: PanoramaMode): Promise<PanoramaResult | null> {
    if (this.running) return null
    const session = this.capture.getSession(sessionId)
    if (!session) return null
    const verticalFovDeg = this.capture.getCaptureIntrinsics()?.verticalFovDeg
    const preset =
      mode === 'pano-360'
        ? sphericalPreset(verticalFovDeg ?? FALLBACK_VERTICAL_FOV_DEG)
        : PANORAMA_PRESETS[mode]
    const group = `${mode}-${groupStamp()}`
    const token = (this.token += 1)

    let captured = 0
    // 进度里要播"当前在哪一格";shots 恒非空(预设至少一行一列),这里给个零值兜底
    let last: PanoramaShotSpec = preset.shots[0] ?? {
      index: 0,
      row: 0,
      col: 0,
      bodyYaw: 0,
      pitch: 0,
    }
    this.setProgress({
      state: 'running',
      mode,
      index: 0,
      total: preset.total,
      row: last.row,
      col: last.col,
      bodyYaw: last.bodyYaw,
      pitch: last.pitch,
      group,
    })

    const fail = (message: string): PanoramaResult => {
      this.capture.spinBodyTo(null)
      this.setProgress({
        state: 'failed',
        mode,
        index: captured,
        total: preset.total,
        row: last.row,
        col: last.col,
        bodyYaw: last.bodyYaw,
        pitch: last.pitch,
        group,
        message,
      })
      return { group, mode, total: preset.total, captured, cancelled: false, error: message }
    }

    // 水平网格只能靠机体自转:后端没有这个能力就没法拍,提前收场而不是拍一堆废片
    const startHeading = this.capture.getBodyHeading()
    if (!this.capture.canSpinBody || startHeading === null) {
      return fail('当前渲染后端不支持机体原地自转,无法完成全景水平网格')
    }

    let column = -1
    for (const shot of preset.shots) {
      if (this.token !== token) break

      // 换列了 —— 先让机身原地自转到这一列的方位,等它真的对准再拍
      if (shot.col !== column) {
        column = shot.col
        const target = normalizeHeading(startHeading + shot.bodyYaw)
        this.capture.spinBodyTo(target)
        const aligned = await this.awaitHeading(target, token)
        if (this.token !== token) break
        if (!aligned) return fail(`机身未能转到 ${target.toFixed(0)}°(需定点悬停中再拍)`)
      }

      last = shot
      // 先把"正在拍哪一格"播出去:进度条与取景角同步,而不是等成片回来才跳
      this.setProgress({
        state: 'running',
        mode,
        index: captured,
        total: preset.total,
        row: shot.row,
        col: shot.col,
        bodyYaw: shot.bodyYaw,
        pitch: shot.pitch,
        group,
      })
      const image = await this.capture.captureVirtualImage(sessionId, {
        view: { pitch: shot.pitch },
        panorama: panoramaRef(group, mode, shot, preset.total),
      })
      // 先计数再判取消:取消请求可能在等待成片时到达,而这张**已经入库**了,
      // 漏算会让"入库张数"与 result.captured 对不上(导出/日志都会少一张)
      if (image) captured += 1
      if (this.token !== token) break
      if (this.options.shotIntervalMs && this.options.shotIntervalMs > 0) {
        await delay(this.options.shotIntervalMs)
      }
    }

    const cancelled = this.token !== token
    const result: PanoramaResult = { group, mode, total: preset.total, captured, cancelled }

    // 收尾姿态:180° 网格停在 +90°(已到位,不再转);360° 网格把最后 30° 转满、回到起始航向。
    // 照片已经拍完了,所以这里转不到位不算失败(比如用户刚好触发返航),只是姿态没回正。
    if (!cancelled) {
      const finalHeading = normalizeHeading(startHeading + preset.finalBodyYaw)
      const current = this.capture.getBodyHeading()
      if (current === null || headingGap(current, finalHeading) > SPIN_TOLERANCE_DEG) {
        this.capture.spinBodyTo(finalHeading)
        await this.awaitHeading(finalHeading, token)
      }
    }
    // 停自转:目标留在那里的话,后面任何一次进入飞行态都会被它继续拽着转
    this.capture.spinBodyTo(null)

    // 整组拍完才谈拼接:取消的组是半成品,拼了也没意义
    if (!cancelled) {
      const stitcher = this.options.stitcher
      if (stitcher) {
        const built = this.buildGroup(sessionId, group, mode)
        if (built && built.images.length) {
          try {
            result.stitched = await stitcher.stitch(built)
          } catch (error) {
            this.setProgress({
              state: 'done',
              mode,
              index: captured,
              total: preset.total,
              row: last.row,
              col: last.col,
              bodyYaw: last.bodyYaw,
              pitch: last.pitch,
              group,
              message: `拼接失败:${(error as Error).message}`,
            })
            return result
          }
          this.options.onStitched?.(result.stitched ?? null, built)
        }
      }
    }

    this.setProgress({
      state: cancelled ? 'cancelled' : 'done',
      mode,
      index: captured,
      total: preset.total,
      row: last.row,
      col: last.col,
      bodyYaw: last.bodyYaw,
      pitch: last.pitch,
      group,
      message: cancelled
        ? `已取消(完成 ${captured}/${preset.total})`
        : `完成 ${captured}/${preset.total}`,
    })
    return result
  }

  /** 请求停止当前扫描(当前那一张会拍完再退出) */
  cancel(): void {
    if (!this.running) return
    this.token += 1
    this.setProgress({ ...(this.current as PanoramaProgress), state: 'cancelled' })
  }

  /** 按组 id 从会话里聚合已拍的照片(按序号排序)—— 拼接器与导出都用它 */
  buildGroup(sessionId: string, group: string, mode: PanoramaMode): PanoramaGroup | null {
    const session = this.capture.getSession(sessionId)
    if (!session) return null
    const images = session.images
      .filter((image) => image.metadata.panorama?.group === group)
      .sort((a, b) => (a.metadata.panorama?.index ?? 0) - (b.metadata.panorama?.index ?? 0))
    return { id: group, mode, sessionId, images }
  }

  /**
   * 等机身转到目标方位(轮询真值,而不是假设"下一条命令必然到位")。
   * 轮询间隔 16 ms、每个方位最多等 `spinTimeoutMs` —— 一帧的转角只有 1~2°,
   * 所以这里的等待粒度对结果没有影响,只影响进度播报的平滑度。
   */
  private async awaitHeading(target: number, token: number): Promise<boolean> {
    const timeout = this.options.spinTimeoutMs ?? DEFAULT_SPIN_TIMEOUT_MS
    const deadline = Date.now() + timeout
    for (;;) {
      const heading = this.capture.getBodyHeading()
      if (heading !== null && headingGap(heading, target) <= SPIN_TOLERANCE_DEG) return true
      if (this.token !== token) return false
      if (Date.now() >= deadline) return false
      await delay(SPIN_POLL_MS)
    }
  }

  private setProgress(progress: PanoramaProgress): void {
    this.current = progress
    for (const listener of this.listeners) listener({ ...progress })
  }
}

/** 组装写进影像元数据的全景定位 */
function panoramaRef(
  group: string,
  mode: PanoramaMode,
  shot: PanoramaShotSpec,
  total: number,
): PanoramaShotRef {
  return {
    group,
    mode,
    index: shot.index,
    total,
    row: shot.row,
    col: shot.col,
    bodyYaw: shot.bodyYaw,
    pitch: shot.pitch,
  }
}
