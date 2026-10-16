/**
 * 影像采集与影像集管理 —— 框架无关的库内实现(方案 V1「阶段 1」)。
 *
 * 覆盖这条链路:**影像与相机参数可靠采集 → 影像集可检查可导出**。
 * 后台重建(COLMAP / 3D Tiles 发布)不在本模块内,它只负责把「输入」做得干净、
 * 完整、可复现 —— 这是整条摄影测量链路里唯一必须在前端做对的部分。
 *
 * 两类来源共用同一套数据模型(见 `CapturedImage`),但**不强行统一相机标定细节**:
 * - `virtual-camera`:场景渲染图。相机位姿与内参直接从渲染后端取(标定来源 `known`),
 *   坐标是场景局部坐标,若宿主给了地理原点则同时落到经纬度;
 * - `real-camera`:真实照片。位姿来自 EXIF/GPS(标定来源 `exif` / `unknown`),
 *   GPS 精度天然只够粗定位 —— 这一点由 `metadata.gps` 与 `validation` 明确标出。
 *
 * 设计边界:
 * - 不自己创建 Viewer / 相机:`虚拟采集`通过注入的 `VirtualCaptureProvider` 向**宿主后端**
 *   要取景帧与相机状态(见本文件对 provider 的说明),避免出现第二个场景实例;
 * - 不碰 DOM:`File` / `Blob` 只用于读取与预览,面板与下载由 drone-capture-panel 负责;
 * - 纯数据 + 纯逻辑,可在 Node / Worker 里跑(浏览器 API 全部按需探测)。
 *
 * 与方案文档的两处偏差(有意为之):
 * 1. `ImageSource` 用 `'virtual-camera'` 而不是文档里的 `'cesium-virtual'` —— 本库有 three
 *    与 Cesium 两套后端,用后端名当来源名会把 three 的采集结果错标成 Cesium;
 *    实际产出后端记在 `metadata.engine` 里。
 * 2. 模块落在 `src/lib/drone-camera/` 而不是文档草案的 `src/modules/**` —— 与本库既有
 *    组织约定(扁平、与框架无关、面板用原生 DOM)保持一致。
 */
import { readJpegExif } from './drone-exif'
import type { ExifData } from './drone-exif'

/** 影像来源:场景渲染图 / 真实相机照片 */
export type ImageSource = 'virtual-camera' | 'real-camera'

/** 相机位姿所在的坐标框架 */
export type CoordinateFrame = 'ecef' | 'local-enu' | 'project-local'

/**
 * 相机内参。
 *
 * `calibrationSource` 不是装饰字段:重建时「内参是已知的」和「内参是猜的」要用完全不同的
 * 策略(SfM 可以固定内参、也可以让内参参与优化),混在一起必然出精度问题,所以必须逐张带上。
 */
export interface CameraIntrinsics {
  width: number
  height: number
  fx?: number
  fy?: number
  cx?: number
  cy?: number
  horizontalFovDeg?: number
  verticalFovDeg?: number
  distortion?: number[]
  calibrationSource: 'known' | 'exif' | 'estimated' | 'unknown'
}

/**
 * 相机位姿。
 *
 * ⚠️ 两个隐性契约,换实现前必须一致:
 * - `rotation` 是四元数,**分量顺序固定 `[x, y, z, w]`**(与 three 一致);
 * - `coordinateFrame` 说明这套数字在哪个系里。库内约定:
 *   · `local-enu` = 以起飞点(返航点)为原点,**x 东 / y 北 / z 上**,单位米;
 *   · `ecef`      = 地心地固坐标,单位米(Cesium 后端)。
 *   四元数表示「相机自身的 x 轴(光轴)指向」在该系中的旋转。
 */
export interface CameraPose {
  position: [number, number, number]
  /** 四元数 [x, y, z, w] */
  rotation: [number, number, number, number]
  coordinateFrame: CoordinateFrame
}

/** 影像校验结论 */
export interface ImageValidation {
  status: 'pending' | 'valid' | 'warning' | 'invalid'
  messages: string[]
}

/**
 * 取景**俯仰**覆盖 —— 让取景相机临时偏离"云台当前俯仰"的常态。
 *
 * ⚠️ 这里**故意没有水平偏航**:水平视野覆盖不能靠云台转。DJI Mini 4 Pro 的云台 Pan
 * 机械行程只有 ±30°(本库 `DRONE_SPEC.gimbalYawRange` 按 ±5° 建模),
 * 靠云台转不出 180° 全景 —— 真机 180°/360° 是**机体原地自转**补水平、云台只做俯仰分层。
 * 水平网格因此走 `VirtualCaptureProvider.spinBodyTo`(转机身),而不是在这里塞一个偏航角。
 *
 * 与库内"稳像 = 模型不动、相机侧解耦"是同一套思路 —— 不动飞控、不动用户视角,
 * 只改这一张的取景俯仰,因此取景帧、拍照成片与记录的位姿天然同源。
 */
export interface CaptureViewOverride {
  /**
   * 俯仰(度):**替代**云台俯仰 —— 即该张照片相对水平面的绝对俯仰角。
   * 不给则沿用云台当前俯仰。全景网格给的是绝对值,否则用户把云台压到 -90° 后全景会全朝地面。
   */
  pitch?: number
}

/** 影像在一次全景扫描里的定位(写进 `metadata.panorama`) */
export interface PanoramaShotRef {
  /** 全景组 id:同一次扫描共用一个,拼接时按它聚合 */
  group: string
  /** 全景模式标识(`pano-wide` / `pano-180` / `pano-360`);这里用 string 以免形成循环依赖 */
  mode: string
  /** 组内序号(1 起) */
  index: number
  /** 组内总张数 */
  total: number
  /** 网格行列(0 起):row = 俯仰层, col = 机身水平方位 */
  row: number
  col: number
  /** 该张的**机身航向偏移**(度,相对本组起始航向;正值 = 向右/顺时针) */
  bodyYaw: number
  /** 该张的取景俯仰(度,绝对) */
  pitch: number
}

/** 虚拟采集的附加参数 */
export interface VirtualCaptureOptions {
  /** 本次取景的俯仰覆盖(用完自动复位;见 CaptureViewOverride) */
  view?: CaptureViewOverride | null
  /** 本次取景属于哪个全景组 */
  panorama?: PanoramaShotRef
}

/** 统一影像条目(虚拟采集与真实导入共用) */
export interface CapturedImage {
  id: string
  source: ImageSource
  fileName: string
  mimeType: string
  sizeBytes: number
  /** ISO 8601;虚拟采集是快门时刻,真实照片优先取 EXIF 拍摄时间 */
  capturedAt: string
  /** 预览地址:虚拟 = PNG data URL,真实 = Blob URL(仅浏览器内有效) */
  imageUrl?: string
  /** 只用于浏览器内短期数据流,**不得写入服务端数据库**(见模块头) */
  localBlob?: Blob
  cameraIntrinsics?: CameraIntrinsics
  cameraPose?: CameraPose
  metadata: {
    latitude?: number
    longitude?: number
    altitude?: number
    cameraModel?: string
    sceneId?: string
    sceneVersion?: string
    dronePoseId?: string
    gimbalRotation?: [number, number, number, number]
    gpsAccuracyMeters?: number
    rtkFixed?: boolean
    /** 虚拟影像的产出后端(three / cesium),便于区分同页两套后端的采集结果 */
    engine?: string
    /** 全景扫描定位(属于某次 180°/360° 拍摄时才有) */
    panorama?: PanoramaShotRef
    /** 真实照片的原始 EXIF(保留原始字段,避免二次解析丢信息) */
    exif?: ExifData
  }
  validation: ImageValidation
}

/** 采集会话参数 */
export interface CaptureSessionOptions {
  source: ImageSource
  name: string
  /** 自动采集的时间间隔(毫秒);0 / 缺省 = 不按时间触发 */
  captureIntervalMs?: number
  /** 自动采集的距离间隔(米);0 / 缺省 = 不按距离触发 */
  distanceIntervalMeters?: number
  includeCameraMetadata?: boolean
  /** 虚拟场景标识(便于回溯「这批影像出自哪个版本的场景」) */
  sceneId?: string
  sceneVersion?: string
  /** 地理参考原点:给了它,局部 ENU 坐标同时能换算成经纬度 */
  georeference?: GeoreferenceOrigin
}

/** 局部坐标 → 经纬高的原点(局部 ENU 的 (0,0,0) 落在这里) */
export interface GeoreferenceOrigin {
  longitude: number
  latitude: number
  altitude?: number
}

/** 采集会话状态 */
export type CaptureSessionStatus = 'created' | 'capturing' | 'paused' | 'finished' | 'failed'

/** 采集会话 */
export interface CaptureSession {
  id: string
  options: CaptureSessionOptions
  status: CaptureSessionStatus
  images: CapturedImage[]
  createdAt: string
  updatedAt: string
  /** 产出后端(虚拟采集时由 provider 提供) */
  engine?: string
  /** 自动采集是否进行中 */
  autoCapturing: boolean
}

/**
 * 取景成片的结构契约。
 *
 * 故意只声明结构、不从 drone-fly 引类型:这样 `drone-capture` 不依赖任何渲染模块
 * (drone-fly / drone-cesium 反过来 `import type` 本模块,依赖方向单向,无循环)。
 */
export interface VirtualShot {
  dataUrl: string
  width: number
  height: number
}

/**
 * 虚拟取景相机状态 —— 由渲染后端提供(见 `VirtualCaptureProvider`)。
 * 注意这必须是**取景相机**(云台镜头)而不是机身:两者朝向可能完全不同。
 */
export interface CaptureCameraState {
  pose: CameraPose
  intrinsics: CameraIntrinsics
  /** 成片画幅(像素) */
  frame: { width: number; height: number }
  /** 场景标识 */
  scene?: { id?: string; version?: string }
  /** 机体真值(诊断 / 复现用) */
  drone?: {
    position: [number, number, number]
    heading: number
    tiltPitch: number
    tiltRoll: number
    gimbalPitch: number
    gimbalYaw: number
  }
  /** 相机的地理位置(地理坐标系后端提供;纯局部场景没有这个值) */
  geo?: { longitude: number; latitude: number; altitude: number }
}

/**
 * 宿主渲染后端向采集服务暴露的能力。
 *
 * `DroneFly`(three)与 `CesiumDroneAdapter` 都天然满足:`requestPhoto()` 是既有的拍照入口,
 * `getCaptureCamera()` 是为采集新增的只读快照。**采集服务不创建第二个 Viewer** ——
 * 无论虚拟影像来自哪套后端,取景帧与相机状态都只有这一个来源。
 */
export interface VirtualCaptureProvider {
  /** 后端标识,写进影像元数据 */
  readonly engine?: string
  /** 取当前云台取景的一帧(与拍照完全同一条路径) */
  requestPhoto(): Promise<VirtualShot | null>
  /** 取景相机的位姿与内参快照;模型 / 云台未就绪时返回 null */
  getCaptureCamera(): CaptureCameraState | null
  /**
   * 设置取景**俯仰**覆盖(全景分层用);传 `null` 复位。
   *
   * 可选方法:只做单张采集的后端可以不实现 —— 此时全景扫描仍会按预设逐张请求,
   * 只是每张都沿用云台当前俯仰(采不到俯仰网格)。
   */
  setCaptureView?(override: CaptureViewOverride | null): void
  /**
   * 让**机体原地自转**到绝对方位角 `headingDeg`(度,罗盘角);`null` 停止自转。
   *
   * 全景扫描的**水平**覆盖只有这条路可走:云台 Pan 机械行程只有 ±30°,
   * 转不出 180°(见 `CaptureViewOverride` 的说明)。后端只负责下达目标,
   * "转到位了没"由调用方用 `getBodyHeading()` 比对 —— 这样各后端不必各自实现等待逻辑。
   */
  spinBodyTo?(headingDeg: number | null): void
  /** 机体当前方位角(度,罗盘角);没实现的后端返回 undefined */
  getBodyHeading?(): number
}

/** 会话汇总(面板与导出共用) */
export interface CaptureSessionSummary {
  total: number
  valid: number
  warning: number
  invalid: number
  pending: number
  /** 真实照片里带 GPS 的张数 */
  withGps: number
  /** 虚拟影像里带完整相机位姿的张数 */
  withPose: number
}

/** 导出格式 */
export type CaptureExportFormat = 'json' | 'csv'

/** 会话导出文件标识 */
export const CAPTURE_EXPORT_FORMAT = 'drone-camera/capture-session'
/** 导出结构版本 */
export const CAPTURE_EXPORT_VERSION = 1

/** 自动采集的判定间隔(毫秒):定时与定距两个触发条件都在这条心跳上评估 */
const AUTO_CAPTURE_TICK_MS = 200

/** 逐张影像的校验规则 */
export function validateCapturedImage(image: CapturedImage): ImageValidation {
  const messages: string[] = []
  let status: ImageValidation['status'] = 'valid'

  const warn = (message: string): void => {
    messages.push(message)
    if (status === 'valid') status = 'warning'
  }
  const note = (message: string): void => {
    messages.push(message)
  }
  const fail = (message: string): void => {
    messages.push(message)
    status = 'invalid'
  }

  if (!image.mimeType.startsWith('image/')) fail(`不是图像类型(${image.mimeType || '未知'})`)
  if (image.sizeBytes <= 0) fail('文件为空')
  // 虚拟影像没有位姿 = 相机参数链断了,只能当普通截图看,必须警告;
  // 真实照片没有位姿是常态(相机外参要靠 SfM 解算),不算退化
  if (!image.cameraPose && image.source === 'virtual-camera') {
    warn('缺少相机位姿(无法参与 SfM 相机解算)')
  }
  if (!image.cameraIntrinsics || image.cameraIntrinsics.calibrationSource === 'unknown') {
    warn('相机内参未知(SfM 需自行估计,精度受限)')
  }
  if (image.source === 'real-camera') {
    if (image.metadata.latitude === undefined || image.metadata.longitude === undefined) {
      warn('缺少 GPS 经纬度(无法地理配准)')
    }
    if (!image.metadata.cameraModel) warn('缺少相机型号信息')
    if (!image.metadata.exif) warn('未读到 EXIF 元数据')
  } else if (!image.metadata.sceneId) {
    // 只影响成果与场景版本的可回溯性,不影响重建质量 —— 记为提示而不是警告
    note('未记录场景标识(成果无法与特定场景版本对应)')
  }
  const { width, height } = image.cameraIntrinsics ?? { width: 0, height: 0 }
  if (width <= 0 || height <= 0) fail('图像尺寸无效')
  if (width > 0 && height > 0 && Math.min(width, height) < 200) {
    warn(`图像过小(${width}×${height}),对重建几乎没有贡献`)
  }

  return { status, messages }
}

/** 会话汇总 */
export function summarizeSession(session: CaptureSession): CaptureSessionSummary {
  const summary: CaptureSessionSummary = {
    total: session.images.length,
    valid: 0,
    warning: 0,
    invalid: 0,
    pending: 0,
    withGps: 0,
    withPose: 0,
  }
  for (const image of session.images) {
    summary[image.validation.status] += 1
    if (image.metadata.latitude !== undefined && image.metadata.longitude !== undefined) {
      summary.withGps += 1
    }
    if (image.cameraPose) summary.withPose += 1
  }
  return summary
}

/**
 * 由 EXIF 推相机内参。
 *
 * 换算依据是 **35mm 等效焦距**:全画幅成像面宽 36mm,故水平视场角
 * `fovX = 2·atan(36 / (2·f35))`,再按像素宽度反推 `fx = width / (2·tan(fovX/2))`。
 * 像素为正方形,所以 `fx = fy`;主点按像面中心。
 *
 * 只有实际焦距而没有 35mm 等效值时无法反推传感器尺寸,此时返回 `unknown`
 * —— 宁可让用户看到「内参未知」,也不要编一个假内参把误差带进重建。
 */
export function intrinsicsFromExif(
  exif: ExifData | null | undefined,
  width: number,
  height: number,
): CameraIntrinsics {
  const base: CameraIntrinsics = { width, height, calibrationSource: 'unknown' }
  const focal35 = exif?.focalLength35mm
  if (!focal35 || focal35 <= 0 || width <= 0 || height <= 0) return base
  const fovX = 2 * Math.atan(36 / (2 * focal35))
  const fx = width / (2 * Math.tan(fovX / 2))
  const fy = fx
  const fovY = 2 * Math.atan(height / (2 * fy))
  return {
    width,
    height,
    fx,
    fy,
    cx: width / 2,
    cy: height / 2,
    horizontalFovDeg: (fovX * 180) / Math.PI,
    verticalFovDeg: (fovY * 180) / Math.PI,
    calibrationSource: 'exif',
  }
}

/** `CaptureService` 构造选项 */
export interface CaptureServiceOptions {
  /** 虚拟取景帧来源(渲染后端) */
  provider?: VirtualCaptureProvider | null
  /** 时间源,便于测试注入 */
  now?: () => Date
  /** id 生成器,便于测试注入 */
  createId?: () => string
}

function defaultId(): string {
  return `img-${Math.random().toString(36).slice(2, 10)}`
}

function sessionId(): string {
  return `cap-${Math.random().toString(36).slice(2, 10)}`
}

/** 简易距离(米) */
function distance3(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/**
 * 影像采集服务:管理采集会话、把两类影像归一成 `CapturedImage`、并支持导出。
 *
 * ```ts
 * const capture = new CaptureService({ provider: fly })
 * const session = capture.createSession({ source: 'virtual-camera', name: '厂区绕飞' })
 * await capture.captureVirtualImage(session.id)                 // 手动拍一张
 * capture.startAutoCapture(session.id, { intervalMs: 2000 })    // 或按时间自动连拍
 * capture.importRealImages(session.id, files)                   // 真实照片导入
 * const csv = capture.exportSession(session.id, 'csv')
 * ```
 */
export class CaptureService {
  private readonly sessions = new Map<string, CaptureSession>()
  private readonly listeners = new Set<(session: CaptureSession) => void>()
  private readonly now: () => Date
  private readonly createId: () => string
  private provider: VirtualCaptureProvider | null
  /** 自动采集句柄:按会话各存一份 */
  private readonly auto = new Map<
    string,
    {
      timer: ReturnType<typeof setInterval>
      intervalMs: number
      distanceMeters: number
      lastShotAt: number
      lastPosition: [number, number, number] | null
      busy: boolean
    }
  >()

  /** 构造采集服务:管理拍摄会话与自动采集(每会话独立相册) */
  constructor(options: CaptureServiceOptions = {}) {
    this.provider = options.provider ?? null
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? defaultId
  }

  /** 换绑定后端(机体切换 / 引擎重建后重新挂) */
  setProvider(provider: VirtualCaptureProvider | null): void {
    this.provider = provider
  }

  /** 读取当前取景相机内参(未就绪或后端未提供时返回 null)。 */
  getCaptureIntrinsics(): CameraIntrinsics | null {
    const intrinsics = this.provider?.getCaptureCamera()?.intrinsics
    return intrinsics ? { ...intrinsics } : null
  }

  // ───────────────────────────── 会话 ─────────────────────────────

  /** 新建拍摄会话(指定覆盖俯仰/张数等,返回会话) */
  createSession(options: CaptureSessionOptions): CaptureSession {
    const timestamp = this.now().toISOString()
    const session: CaptureSession = {
      id: sessionId(),
      options: { includeCameraMetadata: true, ...options },
      status: 'created',
      images: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      engine: this.provider?.engine,
      autoCapturing: false,
    }
    this.sessions.set(session.id, session)
    this.emit(session)
    return session
  }

  /** 按 id 取会话(不存在返回 null) */
  getSession(id: string): CaptureSession | null {
    return this.sessions.get(id) ?? null
  }

  /** 列全部会话(按创建时间) */
  listSessions(): CaptureSession[] {
    return [...this.sessions.values()]
  }

  /** 当前会话(最近创建 / 最近操作的那个);面板默认展示它 */
  get activeSession(): CaptureSession | null {
    let latest: CaptureSession | null = null
    for (const session of this.sessions.values()) {
      if (!latest || session.updatedAt >= latest.updatedAt) latest = session
    }
    return latest
  }

  /** 暂停会话的自动采集 */
  pauseSession(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.stopAutoCapture(id)
    session.status = 'paused'
    this.touch(session)
  }

  /** 续跑被暂停的会话 */
  resumeSession(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.status = 'capturing'
    this.touch(session)
  }

  /** 结束会话(停止采集,照片保留;返回被结束的会话) */
  finishSession(id: string): CaptureSession | null {
    const session = this.sessions.get(id)
    if (!session) return null
    this.stopAutoCapture(id)
    session.status = 'finished'
    this.touch(session)
    return session
  }

  /** 删除会话及其全部照片 */
  removeSession(id: string): void {
    this.stopAutoCapture(id)
    this.sessions.delete(id)
  }

  /** 移除单张影像(无效照片的常规处置) */
  removeImage(sessionId: string, imageId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const index = session.images.findIndex((image) => image.id === imageId)
    if (index < 0) return false
    const [removed] = session.images.splice(index, 1)
    if (removed?.localBlob && removed.imageUrl?.startsWith('blob:')) {
      // 回收 Blob URL,否则整张图会被浏览器缓存一直持有
      try {
        URL.revokeObjectURL(removed.imageUrl)
      } catch {
        /* 非浏览器环境忽略 */
      }
    }
    this.touch(session)
    return true
  }

  /** 清空会话内全部照片(会话保留) */
  clearImages(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    for (const image of session.images) {
      if (image.imageUrl?.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(image.imageUrl)
        } catch {
          /* ignore */
        }
      }
    }
    session.images = []
    this.touch(session)
  }

  /** 订阅会话变更(面板用);返回退订函数 */
  subscribe(listener: (session: CaptureSession) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ─────────────────────── 虚拟影像采集 ───────────────────────

  /**
   * 采集一张虚拟影像。
   *
   * 顺序有讲究:先 `requestPhoto()` 拿到成片,再读相机状态 —— 因为渲染后端是**按帧**推进的,
   * 成片用的是「取景那一帧」的机体真值;等 promise 落地时仿真还没走到下一帧,此刻读到的
   * 位姿正好就是那张照片的位姿(反过来先读就会差一帧)。
   *
   * `options.view` 给的是**本次取景**的俯仰覆盖(全景分层用):设置 → 拍照 → 读位姿 →
   * 无条件复位,全程在同一个 try/finally 里,调用方不可能忘记还原。
   */
  async captureVirtualImage(
    sessionId: string,
    options: VirtualCaptureOptions = {},
  ): Promise<CapturedImage | null> {
    const session = this.sessions.get(sessionId)
    if (!session || session.status === 'finished' || session.status === 'failed') return null
    const provider = this.provider
    if (!provider) return null

    const view = options.view ?? null
    const setView = provider.setCaptureView?.bind(provider)
    if (view && setView) setView(view)
    try {
      const shot = await provider.requestPhoto()
      if (!shot) return null
      // 成片到手后再读相机状态(那一刻仍是取景帧的仿真状态,含本次的俯仰覆盖)
      const camera = provider.getCaptureCamera()
      const image = this.buildVirtualImage(session, shot, camera, options.panorama)
      session.images.push(image)
      if (session.status === 'created') session.status = 'capturing'
      this.touch(session)
      return image
    } finally {
      if (view && setView) setView(null)
    }
  }

  // ─────────────────────── 机体自转(全景水平网格) ───────────────────────

  /** 后端是否支持"机体原地自转" —— 全景的水平覆盖只有它做得出来 */
  get canSpinBody(): boolean {
    return typeof this.provider?.spinBodyTo === 'function'
  }

  /** 机体当前方位角(度,罗盘角);后端不支持时返回 null */
  getBodyHeading(): number | null {
    const heading = this.provider?.getBodyHeading?.()
    return typeof heading === 'number' && Number.isFinite(heading) ? heading : null
  }

  /** 让机体原地自转到绝对方位角 `headingDeg`;`null` 停止自转(后端不支持则什么都不做) */
  spinBodyTo(headingDeg: number | null): void {
    this.provider?.spinBodyTo?.(headingDeg)
  }

  private buildVirtualImage(
    session: CaptureSession,
    shot: VirtualShot,
    camera: CaptureCameraState | null,
    panorama?: PanoramaShotRef,
  ): CapturedImage {
    const timestamp = this.now().toISOString()
    const { width, height } = { width: shot.width, height: shot.height }
    const intrinsics: CameraIntrinsics | undefined = camera
      ? { ...camera.intrinsics, width, height }
      : { width, height, calibrationSource: 'unknown' }
    // 局部 ENU + 地理原点 → 顺带落一份经纬度,与真实照片的 GPS 字段同形,便于统一查看
    const geo =
      camera?.geo ??
      (camera && camera.pose.coordinateFrame === 'local-enu' && session.options.georeference
        ? enuToGeodetic(camera.pose.position, session.options.georeference)
        : undefined)

    const image: CapturedImage = {
      id: this.createId(),
      source: 'virtual-camera',
      fileName: `virtual-${timestamp.replace(/[:.]/g, '-')}.png`,
      mimeType: 'image/png',
      sizeBytes: dataUrlBytes(shot.dataUrl),
      capturedAt: timestamp,
      imageUrl: shot.dataUrl,
      cameraIntrinsics: intrinsics,
      cameraPose: camera?.pose,
      metadata: {
        latitude: geo?.latitude,
        longitude: geo?.longitude,
        altitude: geo?.altitude,
        cameraModel: '虚拟相机(场景渲染)',
        sceneId: camera?.scene?.id ?? session.options.sceneId,
        sceneVersion: camera?.scene?.version ?? session.options.sceneVersion,
        engine: camera ? this.provider?.engine : undefined,
        panorama,
      },
      validation: { status: 'pending', messages: [] },
    }
    image.validation = validateCapturedImage(image)
    return image
  }

  /**
   * 开始自动采集:在一条 200ms 的心跳上同时评估**时间**与**距离**两个触发条件,
   * 谁先满足就先拍一张,并同时刷新两个基准 —— 避免时间与距离各自计时导致的重复连拍。
   */
  startAutoCapture(
    sessionId: string,
    options: { intervalMs?: number; distanceMeters?: number } = {},
  ): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const intervalMs = Math.max(0, options.intervalMs ?? session.options.captureIntervalMs ?? 0)
    const distanceMeters = Math.max(
      0,
      options.distanceMeters ?? session.options.distanceIntervalMeters ?? 0,
    )
    if (intervalMs <= 0 && distanceMeters <= 0) return false
    this.stopAutoCapture(sessionId)
    session.options.captureIntervalMs = intervalMs
    session.options.distanceIntervalMeters = distanceMeters

    const state = {
      timer: setInterval(() => void this.tickAuto(sessionId), AUTO_CAPTURE_TICK_MS),
      intervalMs,
      distanceMeters,
      lastShotAt: 0,
      lastPosition: null as [number, number, number] | null,
      busy: false,
    }
    this.auto.set(sessionId, state)
    session.autoCapturing = true
    if (session.status === 'created' || session.status === 'paused') session.status = 'capturing'
    this.touch(session)
    // 立刻拍第一张:否则「开始」到第一张之间会空等一个间隔
    void this.tickAuto(sessionId, true)
    return true
  }

  private async tickAuto(sessionId: string, force = false): Promise<void> {
    const session = this.sessions.get(sessionId)
    const state = this.auto.get(sessionId)
    if (!session || !state || state.busy) return
    const position = this.provider?.getCaptureCamera()?.pose.position ?? null
    const elapsed = this.now().getTime() - state.lastShotAt
    const moved =
      position && state.lastPosition ? distance3(position, state.lastPosition) : Infinity
    const dueByTime = state.intervalMs > 0 && elapsed >= state.intervalMs
    const dueByDistance = state.distanceMeters > 0 && moved >= state.distanceMeters
    if (!force && !dueByTime && !dueByDistance) return

    state.busy = true
    try {
      const image = await this.captureVirtualImage(sessionId)
      if (!image) return
      state.lastShotAt = this.now().getTime()
      const after = this.provider?.getCaptureCamera()?.pose.position ?? position
      state.lastPosition = after ? [...after] : null
    } finally {
      state.busy = false
    }
  }

  /** 停止会话的自动采集(会话与照片都保留) */
  stopAutoCapture(sessionId: string): void {
    const state = this.auto.get(sessionId)
    if (!state) return
    clearInterval(state.timer)
    this.auto.delete(sessionId)
    const session = this.sessions.get(sessionId)
    if (session) {
      session.autoCapturing = false
      this.touch(session)
    }
  }

  /** 会话是否正在自动采集(定时按间隔拍照) */
  isAutoCapturing(sessionId: string): boolean {
    return this.auto.has(sessionId)
  }

  // ─────────────────────── 真实照片导入 ───────────────────────

  /**
   * 导入真实照片。**尽力保留原始信息**:EXIF 全读,读不到就明确标记缺失,
   * 但绝不因此拒绝文件 —— 「有没有元数据」本身是需要展示的信息(见 validateCapturedImage)。
   */
  async importRealImages(sessionId: string, files: File[] | FileList): Promise<CapturedImage[]> {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    const list = Array.from(files)
    const imported: CapturedImage[] = []
    for (const file of list) {
      const image = await this.buildRealImage(file)
      session.images.push(image)
      imported.push(image)
    }
    if (session.status === 'created') session.status = 'capturing'
    this.touch(session)
    return imported
  }

  private async buildRealImage(file: File): Promise<CapturedImage> {
    const exif = await readJpegExif(file)
    const isJpeg = /jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name)
    const dimensions = await decodeDimensions(file, exif)
    const intrinsics = intrinsicsFromExif(exif, dimensions.width, dimensions.height)
    const capturedAt = exifTimeToIso(exif?.dateTimeOriginal) ?? this.now().toISOString()
    const gps = exif?.gps
    const hasGps = gps?.latitude !== undefined && gps?.longitude !== undefined

    const image: CapturedImage = {
      id: this.createId(),
      source: 'real-camera',
      fileName: file.name,
      mimeType: file.type || (isJpeg ? 'image/jpeg' : ''),
      sizeBytes: file.size,
      capturedAt,
      localBlob: file,
      cameraIntrinsics: intrinsics,
      // 位姿只有「位置」有来源(GPS),**没有朝向** —— 真实无人机照片的相机姿态要靠 SfM 解算,
      // 所以这里只填位置,rotation 留空由后续流程补。用 local-enu? 不:GPS 是地理坐标,
      // 直接记在 metadata 里,pose 留空以免给出一个含义不明的坐标系。
      metadata: {
        latitude: hasGps ? gps?.latitude : undefined,
        longitude: hasGps ? gps?.longitude : undefined,
        altitude: gps?.altitude,
        cameraModel: [exif?.make, exif?.model].filter(Boolean).join(' ') || undefined,
        exif: exif ?? undefined,
        rtkFixed: undefined,
      },
      validation: { status: 'pending', messages: [] },
    }
    // Blob URL 只在浏览器里有意义(预览用)
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      image.imageUrl = URL.createObjectURL(file)
    }
    image.validation = validateCapturedImage(image)
    return image
  }

  // ───────────────────────── 导出 ─────────────────────────

  /** 导出会话清单为 JSON(完整存档)或 CSV(表格式,可直接进 Excel) */
  exportSession(sessionId: string, format: CaptureExportFormat = 'json'): string {
    const session = this.sessions.get(sessionId)
    if (!session) return format === 'csv' ? '' : '{}'
    return format === 'csv' ? this.toCsv(session) : this.toJson(session)
  }

  private toJson(session: CaptureSession): string {
    return JSON.stringify(
      {
        format: CAPTURE_EXPORT_FORMAT,
        version: CAPTURE_EXPORT_VERSION,
        exportedAt: this.now().toISOString(),
        // 坐标系说明写进文件:换个工具打开也不至于误读那三个数(与航线导出的做法一致)
        frame: {
          virtual: 'local-enu: 原点 = 起飞点(返航点),x 东 / y 北 / z 上,单位米',
          real: 'metadata.longitude / latitude 为 WGS84 十进制度,altitude 为 GPS 海拔(米)',
          quaternion: '[x, y, z, w]',
        },
        session: {
          ...session,
          // 二进制 / 会话内对象不进导出
          images: undefined,
        },
        summary: summarizeSession(session),
        images: session.images.map((image) => this.toExportImage(image)),
      },
      null,
      2,
    )
  }

  /** 导出用的影像视图:剥掉 Blob / data URL(它们只对当前浏览器会话有意义) */
  private toExportImage(image: CapturedImage): Omit<CapturedImage, 'localBlob' | 'imageUrl'> {
    const { localBlob: _blob, imageUrl: _url, ...rest } = image
    return rest
  }

  private toCsv(session: CaptureSession): string {
    const escape = (value: string | number | undefined): string => {
      if (value === undefined || value === null) return ''
      const text = String(value)
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }
    const header = [
      '序号',
      '来源',
      '引擎',
      '文件名',
      '采集时间',
      '图像宽',
      '图像高',
      'fx',
      'fy',
      '水平视场角(度)',
      '内参来源',
      '坐标系',
      '相机X',
      '相机Y',
      '相机Z',
      '四元数x',
      '四元数y',
      '四元数z',
      '四元数w',
      '经度',
      '纬度',
      '高度(m)',
      '相机型号',
      '场景',
      '全景组',
      '全景模式',
      '全景序号',
      '机身偏航(度)',
      '取景俯仰(度)',
      '校验',
      '备注',
    ]
    const rows = session.images.map((image, index) => {
      const pose = image.cameraPose
      const intrinsics = image.cameraIntrinsics
      return [
        index + 1,
        image.source,
        image.metadata.engine,
        image.fileName,
        image.capturedAt,
        intrinsics?.width,
        intrinsics?.height,
        intrinsics?.fx === undefined ? undefined : Number(intrinsics.fx.toFixed(3)),
        intrinsics?.fy === undefined ? undefined : Number(intrinsics.fy.toFixed(3)),
        intrinsics?.horizontalFovDeg === undefined
          ? undefined
          : Number(intrinsics.horizontalFovDeg.toFixed(3)),
        intrinsics?.calibrationSource,
        pose?.coordinateFrame,
        pose?.position[0],
        pose?.position[1],
        pose?.position[2],
        pose?.rotation[0],
        pose?.rotation[1],
        pose?.rotation[2],
        pose?.rotation[3],
        image.metadata.longitude,
        image.metadata.latitude,
        image.metadata.altitude,
        image.metadata.cameraModel,
        image.metadata.sceneId,
        image.metadata.panorama?.group,
        image.metadata.panorama?.mode,
        image.metadata.panorama
          ? `${image.metadata.panorama.index}/${image.metadata.panorama.total}`
          : undefined,
        image.metadata.panorama?.bodyYaw,
        image.metadata.panorama?.pitch,
        image.validation.status,
        image.validation.messages.join(' / '),
      ].map(escape)
    })
    return [header.join(','), ...rows.map((row) => row.join(','))].join('\r\n')
  }

  // ───────────────────────── 内部 ─────────────────────────

  private touch(session: CaptureSession): void {
    session.updatedAt = this.now().toISOString()
    this.emit(session)
  }

  private emit(session: CaptureSession): void {
    for (const listener of this.listeners) listener(session)
  }
}

/** data URL 的近似字节数(导出 / 统计用,不做 base64 严格换算) */
function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const payload = dataUrl.length - comma - 1
  return Math.round((payload * 3) / 4)
}

/** EXIF 本地时间(无时区)按原样当作本地时间转 ISO,避免凭空造出一个 UTC 偏移 */
function exifTimeToIso(value: string | undefined): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** 取图像真实像素尺寸:优先浏览器解码(覆盖 PNG / HEIC 等无 EXIF 的格式),退化到 EXIF 记录值 */
async function decodeDimensions(
  file: Blob,
  exif: ExifData | null,
): Promise<{ width: number; height: number }> {
  const fallback = { width: exif?.pixelXDimension ?? 0, height: exif?.pixelYDimension ?? 0 }
  const createBitmap = (
    globalThis as unknown as { createImageBitmap?: (blob: Blob) => Promise<ImageBitmap> }
  ).createImageBitmap
  if (typeof createBitmap !== 'function') return fallback
  try {
    const bitmap = await createBitmap(file)
    const size = { width: bitmap.width, height: bitmap.height }
    if (typeof (bitmap as unknown as { close?: () => void }).close === 'function') {
      ;(bitmap as unknown as { close: () => void }).close()
    }
    return size.width && size.height ? size : fallback
  } catch {
    return fallback
  }
}

/**
 * 局部 ENU → 经纬高(小范围近似)。
 *
 * 用等距圆柱近似:1° 纬度 ≈ 111320m,1° 经度 ≈ 111320·cos(lat)。在无人机作业的
 * 几百米~几公里尺度上误差可忽略;真要测绘级精度必须走 ECEF 严格换算 + 椭球参数,
 * 那是后台配准环节的事,不在前端做。
 */
function enuToGeodetic(
  position: [number, number, number],
  origin: GeoreferenceOrigin,
): { longitude: number; latitude: number; altitude: number } {
  const metersPerDegLat = 111320
  const metersPerDegLon = metersPerDegLat * Math.cos((origin.latitude * Math.PI) / 180)
  return {
    longitude: origin.longitude + (metersPerDegLon > 0 ? position[0] / metersPerDegLon : 0),
    latitude: origin.latitude + position[1] / metersPerDegLat,
    altitude: (origin.altitude ?? 0) + position[2],
  }
}
