/**
 * Cesium 版飞行适配器 —— 用 Cesium 自己的实体系统渲染机体,飞行逻辑仍走库里的 DroneSim。
 *
 * 与 three 版的 DroneFly 是同一组接口(DronePanelHost + MissionPanelHost)的两种实现:
 * 控制面板 / 航线面板 / 鹰眼图 / 键盘完全不区分后端,插到哪个适配器上就控制哪台飞机,
 * 面板代码一行都不用改。两端各带 `engine` 判别字段('three' / 'cesium'),
 * 由 `createDroneControl({ engine })` 统一装配(见 drone-engine.ts)。
 *
 * 模块划分(与 three 侧一一对应):
 * - 本文件              —— 适配器:坐标换轴、每帧写 modelMatrix、相机接管、拍照/录像、航线任务 API;
 * - drone-cesium-rig    —— 机体表现层:桨叶自转 + 钟罩反向补偿 + 机体灯光;
 * - drone-cesium-mission —— 航线表现层:航点标记 / 航线折线 / 场景内拖拽编辑。
 *
 * ─── 坐标系换算(全部风险都在这里,改之前先读完) ───────────────────────────
 *
 *   DroneSim 世界系        Cesium ENU 系          Cesium 世界系
 *     x  向东       ──▶      x  向东
 *     y  向上(AGL)  ──▶      z  向上        ──▶   enuToFixed(锚点) × ENU
 *     z  向南       ──▶      y  向北(= -z)
 *
 *   · 轴序不是简单搬运:x/z 要换轴,且南向取负 —— 漏掉这一步无人机会沿南北轴反向飞。
 *   · 航向:sim.heading 是罗盘角(正北 0°、顺时针增加),与 Cesium HeadingPitchRoll 同语义,直接换算;
 *   · 俯仰:Cesium 的 HeadingPitchRoll 是同一个旋转,但参照轴相反 —— **模型**前向是局部 -x、
 *     **相机**前向是局部 +x,所以模型 tiltPitch(正=抬头)要取负、相机 gimbalPitch(正=抬头)直传;
 *   · 横滚:两者都以"右压坡"为正,同号。
 *
 * ─── 高度基准 ──────────────────────────────────────────────────────────
 * sim.position.y 是相对起飞点的高度(AGL),所以锚点必须落在真实地形面上:
 * 构造时用 sampleTerrainMostDetailed 采样锚点地形高度,否则无人机会沉进地里或浮在半空。
 *
 * ─── 机体加载:GLB 净化(为什么需要) ───────────────────────────────────
 * 真机 GLB(DJI Mini 4 Pro 导出)把 `KHR_lights_punctual` 写进了 **extensionsRequired**,
 * 而 Cesium 不支持该扩展 → `Model.fromGltfAsync` 直接以
 * "Unsupported glTF Extension: KHR_lights_punctual" 拒载(整个机体不出来,且异常被吞)。
 * 处理方式**不修改磁盘上的资产**(shared asset 被改会让 three 侧的 GLTFLoader 拿到
 * 半剥离的扩展引用而崩),而是在加载期做内存净化:
 *   fetch → 复制 ArrayBuffer → 只在 JSON chunk 里摘掉 extensionsRequired 里的该扩展
 *        → Blob URL 交给 Cesium
 * 其余(extensionsUsed / lights 数组 / 节点引用)原样保留 —— 实测摘掉 required 一项
 * Cesium 即通过,three 侧读到的仍是完整文件。可用 `stripRequiredExtensions` 覆盖清单。
 */
import { DroneSim, NEUTRAL_STICK, buildMissionExport, exportMissionText } from './drone-sim'
import type {
  ChecklistItem,
  DroneSnapshot,
  FlightMode,
  MissionConfig,
  MissionExport,
  MissionExportFormat,
  MissionSnapshot,
  MissionWaypoint,
  StickState,
} from './drone-sim'
import type { DronePanelHost, MissionPanelHost } from './drone-control'
// 仅类型:`CameraMode` / `PhotoShot` 定义在 three 装配层里,用 `import type` 引,
// 编译期即被擦除,不会把 three 拖进 Cesium 路径的运行时依赖。
import type { CameraMode, PhotoShot } from './drone-fly'
// 同样是纯类型:采集模块只声明契约(不引实现),编译期即被擦除,
// 于是 drone-capture 与两套渲染后端之间不会形成运行时循环依赖。
import type { CaptureCameraState, CaptureViewOverride } from './drone-capture'
import { CesiumDroneRig } from './drone-cesium-rig'
import { CesiumMissionEditor } from './drone-cesium-mission'
import type { CesiumMissionHost } from './drone-cesium-mission'
import type { MissionEditLimits, MissionEditState } from './mission-editor'

/** Cesium 由 /Cesium/Cesium.js 以全局脚本注入,这里只做一层薄封装取引用 */
type CesiumNS = Record<string, any>

/** 可选机体规格。scale 把模型最大边归一到 2.4 m(与 three 版沙盒同尺寸),lift 让模型底面对齐放置点 */
export interface DroneModelSpec {
  key: string
  label: string
  url: string
  scale: number
  /** 模型自身前向与 ENU 北向的夹角修正(度),由实测定,见文件尾注释 */
  yawOffsetDeg: number
  /** 模型原点到底面的距离(米),用于让机腹贴地而不是原点贴地 */
  lift: number
  /**
   * 云台相机沿光轴前移的距离(米,自机体原点起算)。
   * 离线按 GLB 顶点实测「光轴走廊内壳体(含云台壳)最前点 + 2cm 余量」得出:
   * 相机必须探出壳体,否则 GLB 材质多为双面,在壳内会把机身内壁拍进画面。
   * 桨叶/机臂不算在内 —— FPV 边缘露出桨尖是真机也有的现象。
   */
  gimbalOffsetM: number
  /** 云台相机相对机体原点的高度(米):镜头玻璃的实测中线高度 */
  gimbalLiftM: number
}

/** 目标最大边尺寸(米)。与 three 版 normalizeModel 保持一致,换渲染器不换体量感 */
const TARGET_MAX_EDGE_M = 2.4

/**
 * 机体目录。scale / lift / gimbal* 由 GLB 包围盒与顶点实测得出(见下方注释里的原始数据):
 * - DJI Mini 4 Pro :31.758 × 9.959 × 25.236,min y = -5.034;云台镜头玻璃在机体系 z -0.590 m、y -0.03 m,壳体最前 -0.62 m
 * - CesiumDrone    : 3.964 × 1.120 ×  4.668,min y = -0.171;镜头在 z +1.127 m、y +0.19 m
 *   (两机型在 glTF 里的机头方向相反:DJI 朝 -z、CesiumDrone 朝 +z —— 运行时偏移
 *   一律沿「飞行方向」施加,与模型自身轴向无关,所以这里只存距离不存符号)
 */
export const DRONE_MODELS: DroneModelSpec[] = [
  {
    key: 'dji',
    label: 'DJI Mini 4 Pro',
    url: '/models/dji_mini4_pro.glb',
    scale: TARGET_MAX_EDGE_M / 31.758,
    // Blender 导出的 GLB 前向(+Z)与 Cesium HPR 的前向约定差 90°,实测 heading=0 时机头朝西,+90 拉回正北
    yawOffsetDeg: 90,
    lift: 5.034 * (TARGET_MAX_EDGE_M / 31.758),
    gimbalOffsetM: 0.64,
    gimbalLiftM: -0.03,
  },
  {
    key: 'cesium',
    label: 'Cesium 默认无人机',
    url: '/Cesium/SampleData/models/CesiumDrone/CesiumDrone.glb',
    scale: TARGET_MAX_EDGE_M / 4.668,
    yawOffsetDeg: 0,
    lift: 0.171 * (TARGET_MAX_EDGE_M / 4.668),
    gimbalOffsetM: 1.15,
    gimbalLiftM: 0.19,
  },
]

export interface CesiumDroneOptions {
  /** Cesium.Viewer 实例 */
  viewer: CesiumNS
  /**
   * Cesium 命名空间。缺省取 `window.Cesium`(配合 `loadCesiumScript()` 或页面里自引脚本);
   * 传进来可让同一页面挂多个互不干扰的 Cesium 版本 / 便于测试注入。
   */
  cesium?: CesiumNS
  /** 沙盒原点经纬度(度);高度缺省时自动采样地形 */
  lon?: number
  lat?: number
  /** 锚点海拔(米);不传则用 sampleTerrainMostDetailed 采样 */
  height?: number
  /** 初始机体下标(见 DRONE_MODELS),默认 0 */
  modelIndex?: number
  /** 起降点离地额外抬升(米),避免机腹与地形 z-fighting,默认 0.05 */
  groundClearance?: number
  /** 视角跟随距离(米),follow 模式用(相机在无人机正后方),默认 7.5(与 three 版一致) */
  followRange?: number
  /**
   * 加载期从 GLB 的 `extensionsRequired` 里摘掉的扩展清单
   * (见 DEFAULT_UNSUPPORTED_REQUIRED_EXTENSIONS,默认 ['KHR_lights_punctual']);
   * 传 `[]` 关闭净化,直接按原 URL 加载。
   */
  stripRequiredExtensions?: readonly string[]
}

/** 飞行中每帧推进仿真用的最大步长(秒):切标签页回来时防止一次跳太远 */
const MAX_STEP_SECONDS = 0.1

// ── 跟随机位:与 three 版 updateCamera 的 FOLLOW_DISTANCE / FOLLOW_HEIGHT 同值 ──
/** 相机在无人机正后方的水平距离(米) */
const FOLLOW_DISTANCE = 7.5
/** 相机相对机体的高度(米) */
const FOLLOW_HEIGHT = 2.8
/** 瞄准点相对机体中心的抬升(米):机身整体进画面,而不是对着机腹 */
const FOLLOW_AIM_LIFT = 0.6

/** 等待 Cesium 取景瓦片稳定的最长时间;到时使用最近渲染帧而不是丢弃整张 */
const PHOTO_TIMEOUT_MS = 5000
/** track.requestFrame 不可用时的兜底采样帧率 */
const RECORD_FPS = 30
const RECORD_BITRATE = 8_000_000
const RECORD_TIMESLICE_MS = 500
const RECORD_STOP_TIMEOUT_MS = 1500

/** glTF 容器里的两个 chunk 类型 */
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

/**
 * Cesium 不支持、但在真机 GLB 里被声明为 **required** 的 glTF 扩展。
 * 出现在 extensionsRequired 里会被 `Model.fromGltfAsync` 直接拒载
 * ("Unsupported glTF Extension: ..."),需要加载期摘掉。
 */
export const DEFAULT_UNSUPPORTED_REQUIRED_EXTENSIONS = ['KHR_lights_punctual']

/**
 * 在内存里摘掉 JSON chunk 中 `extensionsRequired` 里的指定扩展,返回新的 GLB ArrayBuffer。
 *
 * 只动 JSON chunk 的这一个字段:MAGIC / version / BIN chunk 原样搬过去,
 * `extensionsUsed`、扩展本体(如 KHR_lights_punctual.lights)与节点上的扩展引用全部保留 ——
 * 于是 three 侧读同一份文件时行为完全不变(实测:摘 required 一项 Cesium 即通过,
 * 而连同 lights 数组一起删会让 three 的 GLTFLightsExtension 读到悬空引用而抛错)。
 *
 * @returns 新的 ArrayBuffer;若该文件本来就没有需要摘的扩展,返回 null(调用方继续用原 URL)
 */
export function stripRequiredExtensions(
  buffer: ArrayBuffer,
  strip: readonly string[] = DEFAULT_UNSUPPORTED_REQUIRED_EXTENSIONS,
): ArrayBuffer | null {
  if (strip.length === 0 || buffer.byteLength < 20) return null
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== 0x46546c67) return null // 'glTF'
  if (view.getUint32(4, true) !== 2) return null

  // 走一遍 chunk 头,找出 JSON / BIN chunk 的位置与长度
  const total = view.getUint32(8, true)
  let jsonStart = -1
  let jsonLength = 0
  let binStart = -1
  let binLength = 0
  let cursor = 12
  const limit = Math.min(total, buffer.byteLength)
  while (cursor + 8 <= limit) {
    const length = view.getUint32(cursor, true)
    const type = view.getUint32(cursor + 4, true)
    const body = cursor + 8
    if (body + length > limit) break
    if (type === CHUNK_JSON && jsonStart < 0) {
      jsonStart = body
      jsonLength = length
    } else if (type === CHUNK_BIN && binStart < 0) {
      binStart = body
      binLength = length
    }
    cursor = body + length
  }
  if (jsonStart < 0) return null

  const jsonText = new TextDecoder('utf-8').decode(new Uint8Array(buffer, jsonStart, jsonLength))
  let json: { extensionsRequired?: string[]; [key: string]: unknown }
  try {
    json = JSON.parse(jsonText)
  } catch {
    return null
  }
  const required = json.extensionsRequired
  if (!Array.isArray(required)) return null
  const kept = required.filter((name) => !strip.includes(name))
  if (kept.length === required.length) return null // 无需改动 → 走原 URL,不复制

  if (kept.length > 0) json.extensionsRequired = kept
  else delete json.extensionsRequired

  // 重打包:JSON chunk 按 glTF 规范用空格(0x20)补齐到 4 字节对齐
  const encoded = new TextEncoder().encode(JSON.stringify(json))
  const paddedLength = (encoded.byteLength + 3) & ~3
  const binTail = binStart >= 0 ? binLength : 0
  const byteLength = 12 + 8 + paddedLength + (binTail ? 8 + binTail : 0)
  const out = new Uint8Array(byteLength)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, 0x46546c67, true)
  outView.setUint32(4, 2, true)
  outView.setUint32(8, byteLength, true)
  outView.setUint32(12, paddedLength, true)
  outView.setUint32(16, CHUNK_JSON, true)
  out.fill(0x20, 20, 20 + paddedLength)
  out.set(encoded, 20)
  if (binTail) {
    const binChunk = 20 + paddedLength
    outView.setUint32(binChunk, binTail, true)
    outView.setUint32(binChunk + 4, CHUNK_BIN, true)
    out.set(new Uint8Array(buffer, binStart!, binTail), binChunk + 8)
  }
  return out.buffer
}

let cesiumScriptPromise: Promise<void> | null = null

/**
 * 按需注入 Cesium 全局脚本(默认 `/Cesium/Cesium.js`),幂等且并发安全。
 *
 * 库不打包 Cesium(它自带 WebGL 内核与 Workers,体量与构建方式都不适合打进库),
 * 由使用方把 Cesium 静态资源放到自有目录,再调本函数或在页面里自己引 script。
 * 脚本就绪后 `window.Cesium` 可用,直接传给 `createDroneControl({ engine: 'cesium', ... })`。
 */
export function loadCesiumScript(src = '/Cesium/Cesium.js'): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('[drone-camera] loadCesiumScript 只能在浏览器里调用'))
  }
  const existing = (window as unknown as { Cesium?: CesiumNS }).Cesium
  if (existing) return Promise.resolve()
  if (cesiumScriptPromise) return cesiumScriptPromise
  cesiumScriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => {
      cesiumScriptPromise = null
      reject(new Error(`[drone-camera] Cesium 静态资源加载失败:${src}`))
    }
    document.head.appendChild(script)
  })
  return cesiumScriptPromise
}

export class CesiumDroneAdapter implements DronePanelHost, MissionPanelHost, CesiumMissionHost {
  readonly sim = new DroneSim()
  /** 引擎判别字段:与 DroneFly 的 `engine = 'three'` 成对(见 drone-engine.ts) */
  readonly engine = 'cesium' as const
  /** 当前视角模式;orbit = 交给 Cesium 自由漫游,follow / fpv 由本适配器每帧驱动相机 */
  cameraMode: CameraMode = 'orbit'

  private readonly C: CesiumNS
  private readonly viewer: CesiumNS
  private readonly enuToFixed: CesiumNS
  private readonly origin: { lon: number; lat: number; height: number }
  private readonly groundClearance: number
  private readonly followRange: number
  /** 加载期净化时的扩展剥离清单(见 stripRequiredExtensions) */
  private readonly stripExtensions: readonly string[]
  /** 当前机体若走了净化路径,记下 Blob URL 以便销毁时回收 */
  private sanitizedBlobUrl: string | null = null

  /** 场景里当前挂载的机体 —— 直接是 Cesium 的 Model primitive(不走 Entity,见 loadModel 注释) */
  private model: CesiumNS | null = null
  /** 机体表现层:桨叶自转 + 灯光(见 drone-cesium-rig 文件头) */
  private readonly rig: CesiumDroneRig
  /** 航线表现层 + 场景内编辑:航点标记 / 航线折线 / 拖拽(见 drone-cesium-mission 文件头) */
  private missionEditor: CesiumMissionEditor | null = null
  /** 模型加载序号:切换机体时作废仍在途的旧请求,避免晚到的结果盖掉新机体 */
  private loadToken = 0
  /** 复用的 4×4 世界矩阵(每帧重填,避免逐帧分配) */
  private readonly worldMatrix: CesiumNS
  private modelIndex: number
  private armFoldTarget = 0
  // ── 航线任务状态(与 three 版 DroneFly 同字段同语义:面板只读这些) ──
  /** 场景内编辑开关(面板勾选;"当前确实可编辑"另看 isOrbitView + 任务状态,见 canMissionSceneEdit) */
  private missionEditEnabled = false
  /** 场景/列表双向联动的选中航点索引 */
  private missionEditSelected = -1
  /** 航线总显隐 / 航点标记 / 航线折线(互不影响,与 three 版三个开关一致) */
  private missionVisible = true
  private missionMarkersVisible = true
  private missionPathVisible = true
  private recorder: MediaRecorder | null = null
  private recordChunks: Blob[] = []
  /** 录制专用离屏画布的上下文:每帧只往里搬一帧云台取景,主画布上的用户视角永远不会混进录像 */
  private recordContext: CanvasRenderingContext2D | null = null
  /** 手动抓帧轨道(captureStream(0)):录到什么由取景帧决定 */
  private captureTrack: CanvasCaptureMediaStreamTrack | null = null
  private recordStream: MediaStream | null = null
  /** 待取景的拍照请求:取景帧渲染完同任务内拷屏(见 captureGimbalFrame) */
  private photoPending: {
    resolve: (shot: PhotoShot | null) => void
    timer: number
    settledFrames: number
    forceCapture: boolean
  } | null = null
  /** 拍照稳定帧期间暂存的用户相机,完成或超时后还原 */
  private photoCameraRestore: {
    camera: ReturnType<CesiumDroneAdapter['snapshotCamera']> | null
  } | null = null
  /** 录像收尾回调:UI 用它落盘(引擎不直接触发下载);与 three 版同名同参 */
  onRecordingReady: ((blob: Blob, seconds: number) => void) | null = null
  private rafId: number | null = null
  private lastTime = 0
  private disposed = false
  /** 相机是否被本适配器锁在无人机上(退出 follow/fpv 时要把 transform 还回去) */
  private cameraLocked = false
  /**
   * 取景**俯仰**覆盖(全景分层用,见 `setCaptureView`):非 null 时取景相机临时偏离
   * "云台当前俯仰"。只影响取景(拍照 / 录像 / 采集快照),不动飞控与机体姿态。
   *
   * 这里没有水平偏航是有意的 —— 水平覆盖靠**机体原地自转**(见 `spinBodyTo`),
   * 云台 Pan 机械行程转不出 180°(理由见 `drone-panorama` 的文件头)。
   */
  private captureView: CaptureViewOverride | null = null

  /** 宿主回调:模型切换完成后通知 UI 刷新按钮文案 */
  onModelChange: ((spec: DroneModelSpec) => void) | null = null

  /** Cesium 后端适配器:实现 DronePanelHost,面板/航线/鹰眼/键盘可直接用 */
  constructor(options: CesiumDroneOptions) {
    if (typeof window === 'undefined') {
      throw new Error('[drone-camera] CesiumDroneAdapter 需要浏览器环境')
    }
    const C = options.cesium ?? (window as unknown as { Cesium?: CesiumNS }).Cesium
    if (!C) {
      throw new Error(
        '[drone-camera] 未找到 Cesium:请先 await loadCesiumScript("/Cesium/Cesium.js"),' +
          '或在 options 里显式传入 cesium 命名空间',
      )
    }
    this.C = C
    this.viewer = options.viewer
    this.groundClearance = options.groundClearance ?? 0.05
    this.followRange = options.followRange ?? FOLLOW_DISTANCE
    this.modelIndex = options.modelIndex ?? 0
    this.stripExtensions =
      options.stripRequiredExtensions ?? DEFAULT_UNSUPPORTED_REQUIRED_EXTENSIONS
    this.origin = {
      lon: options.lon ?? 116.391,
      lat: options.lat ?? 39.906,
      height: options.height ?? 0,
    }
    // 锚点 ENU 框架:本地米坐标 → ECEF 世界坐标的唯一入口
    this.enuToFixed = C.Transforms.eastNorthUpToFixedFrame(
      C.Cartesian3.fromDegrees(this.origin.lon, this.origin.lat, this.origin.height),
    )
    this.worldMatrix = new C.Matrix4()
    this.rig = new CesiumDroneRig(this.sim, C)
    this.installArmCheck()
  }

  // ───────────────────────────── 生命周期 ─────────────────────────────

  /**
   * 启动:采样锚点地形高度、加载机体、起循环。
   * 地形采样失败不阻断(退回给定的 height);不挂地形(椭球)时采样高度恒为 0,同样无碍。
   */
  async start(): Promise<void> {
    const C = this.C
    try {
      const carto = C.Cartographic.fromDegrees(this.origin.lon, this.origin.lat)
      const [sampled] = await C.sampleTerrainMostDetailed(this.viewer.terrainProvider, [carto])
      if (sampled && Number.isFinite(sampled.height)) {
        this.origin.height = sampled.height
      }
    } catch {
      // 离线 / ion 不可用:沿用传入的高度,不阻断飞行
    }
    this.rebuildEnuFrame()
    void this.loadModel()
    // 航线表现层:航点标记 / 航线折线 / 场景内拖拽编辑(与机体加载异步并行,互不依赖)
    this.missionEditor = new CesiumMissionEditor(this, this.C, this.viewer)
    this.missionEditor.setEnabled(this.missionEditEnabled)
    this.applyMissionVisibility()
    this.loop(performance.now())
  }

  /** 销毁 viewer 与适配器,停止每帧同步 */
  destroy(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.rafId = null
    if (this.recorder) {
      try {
        this.recorder.stop()
      } catch {
        /* 已停止 */
      }
      this.recorder = null
    }
    if (this.photoPending) {
      window.clearTimeout(this.photoPending.timer)
      const pending = this.photoPending
      this.photoPending = null
      pending.resolve(null)
    }
    if (this.photoCameraRestore?.camera) {
      this.restoreCamera(this.photoCameraRestore.camera)
    }
    this.photoCameraRestore = null
    this.recordStream?.getTracks().forEach((track) => track.stop())
    this.recordStream = null
    this.captureTrack = null
    this.recordContext = null
    this.releaseCamera()
    this.rig.dispose()
    // 航线实体(航点/折线/返航点)与指针/键盘监听一并收掉
    this.missionEditor?.destroy()
    this.missionEditor = null
    if (this.model) {
      // primitives.remove 会连带 destroy primitive,几何与纹理一起释放
      this.viewer.scene.primitives.remove(this.model)
      this.model = null
    }
    this.releaseSanitizedUrl()
    this.recordChunks = []
  }

  /** 回收加载期净化产生的 Blob URL(否则整份 GLB 会一直被浏览器缓存持有) */
  private releaseSanitizedUrl(): void {
    if (this.sanitizedBlobUrl && typeof URL !== 'undefined') {
      URL.revokeObjectURL(this.sanitizedBlobUrl)
    }
    this.sanitizedBlobUrl = null
  }

  /**
   * 解析交给 Cesium 的模型地址:先按原 URL 取 ArrayBuffer,若 `extensionsRequired`
   * 里有 Cesium 不支持的扩展,就在内存里摘掉并用 Blob URL 代替(见文件头"GLB 净化")。
   *
   * 无扩展可摘(或净化关闭)时返回原 URL —— 零额外开销、零对象 URL 泄漏;
   * 取文件失败时也回退原 URL,让 Cesium 自己报出真正的网络/解析错误。
   */
  private async resolveModelUrl(url: string): Promise<string> {
    this.releaseSanitizedUrl()
    if (this.stripExtensions.length === 0 || typeof fetch !== 'function') return url
    try {
      const response = await fetch(url)
      if (!response.ok) return url
      const patched = stripRequiredExtensions(await response.arrayBuffer(), this.stripExtensions)
      if (!patched) return url
      this.sanitizedBlobUrl = URL.createObjectURL(
        new Blob([patched], { type: 'model/gltf-binary' }),
      )
      return this.sanitizedBlobUrl
    } catch {
      return url
    }
  }

  // ───────────────────────────── 机体 ─────────────────────────────

  /** 当前机体模型规格(名称/缩放/机头偏移等) */
  get modelSpec(): DroneModelSpec {
    return DRONE_MODELS[this.modelIndex] ?? DRONE_MODELS[0]!
  }

  /** 机体模型是否已挂载完成(加载是异步的,期间无人机不可见) */
  get modelLoaded(): boolean {
    return this.model !== null
  }

  /** 切换机体(按下标轮换或直接指定 key);返回切换后的规格 */
  setModel(keyOrIndex: string | number): DroneModelSpec {
    const idx =
      typeof keyOrIndex === 'number'
        ? keyOrIndex
        : DRONE_MODELS.findIndex((m) => m.key === keyOrIndex)
    if (idx < 0 || idx >= DRONE_MODELS.length) return this.modelSpec
    this.modelIndex = idx
    void this.loadModel()
    this.onModelChange?.(this.modelSpec)
    return this.modelSpec
  }

  /** 在目录里轮换到下一个机体 */
  cycleModel(): DroneModelSpec {
    return this.setModel((this.modelIndex + 1) % DRONE_MODELS.length)
  }

  /**
   * 加载机体并挂到 scene.primitives 上。
   *
   * 为什么不用 Entity + model:实测(Cesium 1.144)Entity.model 的 ModelVisualizer
   * 迟迟不产出可渲染/可拾取的 Model primitive(位置是 CallbackProperty 时尤甚),
   * 而手动 Model.fromGltfAsync + 每帧写 modelMatrix 立刻可见 —— 动态模型本就是
   * primitive 路线的推荐用法,还省掉了 Entity 的 Property 求值开销。
   */
  private async loadModel(): Promise<void> {
    const C = this.C
    const spec = this.modelSpec
    const token = ++this.loadToken
    // 净化后的 Blob URL(或原 URL)—— 摘掉 Cesium 不支持的 required 扩展,见文件头
    const url = await this.resolveModelUrl(spec.url)
    if (this.disposed || token !== this.loadToken) return
    let model: CesiumNS
    try {
      model = await C.Model.fromGltfAsync({
        url,
        scale: spec.scale,
        // 关掉像素下限,否则拉远看时模型会保持屏幕尺寸、比例失真
        minimumPixelSize: 0,
      })
    } catch {
      // 加载失败(404 / 解析错):保留旧机体,不打断飞行
      return
    }
    // 等待期间页面已销毁或又切了机体 → 丢弃这次的结果
    if (this.disposed || token !== this.loadToken) return
    if (this.model) this.viewer.scene.primitives.remove(this.model)
    this.model = model
    this.viewer.scene.primitives.add(model)
    this.syncModelMatrix()
    // 重绑桨叶关节与灯组(非语义机体自动 no-op)。
    // ⚠️ 必须等 model.ready:fromGltfAsync 返回时 glTF 场景图还没建好,
    // 此时 getNode 一律返回 undefined,提前 attach 会把整层表现永久禁用。
    const bindRig = (): void => {
      if (!this.disposed && this.model === model) this.rig.attach(model)
    }
    if (model.ready) bindRig()
    else model.readyEvent.addEventListener(() => bindRig())
  }

  // ──────────────────────────── 坐标换算 ────────────────────────────

  private rebuildEnuFrame(): void {
    const C = this.C
    const next = C.Transforms.eastNorthUpToFixedFrame(
      C.Cartesian3.fromDegrees(this.origin.lon, this.origin.lat, this.origin.height),
    )
    // Matrix4 是数组型对象,逐元素拷贝保持引用稳定(enuToFixed 被多处闭包捕获)
    C.Matrix4.clone(next, this.enuToFixed)
  }

  /** sim 本地米坐标(y 为 AGL) → ECEF 世界坐标 */
  private computeWorldPosition(): CesiumNS {
    const C = this.C
    const sim = this.sim
    // ENU 三轴:东 = x,北 = -z(南向取负),上 = y
    const local = C.Cartesian3.fromElements(
      sim.position.x,
      -sim.position.z,
      sim.position.y + this.groundClearance + this.modelSpec.lift,
    )
    return C.Matrix4.multiplyByPoint(this.enuToFixed, local, new C.Cartesian3())
  }

  /**
   * 每帧把 sim 真值写进模型的世界矩阵。
   * headingPitchRollToFixedFrame(origin, hpr) 一步给出「ENU 平移 + 航向/俯仰/横滚旋转」,
   * 与 Entity 管线里 headingPitchRollQuaternion 的语义完全一致。
   */
  private syncModelMatrix(): void {
    if (!this.model) return
    const C = this.C
    const sim = this.sim
    const hpr = new C.HeadingPitchRoll(
      C.Math.toRadians(sim.heading + this.modelSpec.yawOffsetDeg),
      // HeadingPitchRoll 是同一个旋转,但模型前向(局部 -x)与相机前向(局部 +x)相反:
      // sim.tiltPitch 正 = 抬头,对模型要取负(相机侧则直传,见 applyGimbalCameraPose)
      C.Math.toRadians(-sim.tiltPitch),
      C.Math.toRadians(sim.tiltRoll),
    )
    this.model.modelMatrix = C.Transforms.headingPitchRollToFixedFrame(
      this.computeWorldPosition(),
      hpr,
      undefined,
      undefined,
      this.worldMatrix,
    )
  }

  /** 当前经纬高(渲染坐标系下的真实地理位置),供 HUD / 验证脚本读取 */
  getGeo(): { lon: number; lat: number; height: number } {
    const C = this.C
    const carto = C.Cartographic.fromCartesian(this.computeWorldPosition())
    return {
      lon: C.Math.toDegrees(carto.longitude),
      lat: C.Math.toDegrees(carto.latitude),
      height: carto.height,
    }
  }

  // ───────────────────────────── 主循环 ─────────────────────────────

  private loop = (now: number): void => {
    if (this.disposed) return
    const dt = this.lastTime === 0 ? 0 : Math.min(MAX_STEP_SECONDS, (now - this.lastTime) / 1000)
    this.lastTime = now
    // 固定调用顺序:先推进飞控状态机,再把真值写进场景(模型矩阵 → 桨叶/灯光 → 航线实体),
    // 然后按视角模式摆相机,最后抓拍照/录像的云台取景帧(见 captureGimbalFrame)
    this.sim.step(dt)
    this.syncModelMatrix()
    this.rig.update(dt)
    this.missionEditor?.update()
    this.applyCamera()
    this.captureGimbalFrame()
    this.rafId = requestAnimationFrame(this.loop)
  }

  // ───────────────────────────── 相机 ─────────────────────────────

  /** 切相机模式:orbit 环绕 / follow 跟随 / fpv 机载 */
  setCameraMode(mode: CameraMode): void {
    if (mode === this.cameraMode) return
    this.cameraMode = mode
    // 退出跟随时把相机交还给 Cesium 的漫游控制器;进入跟随/机载由 applyCamera 每帧接管
    if (mode === 'orbit') this.releaseCamera()
  }

  /** 退出跟随:把相机 transform 归位,交还给 Cesium 的漫游控制器 */
  private releaseCamera(): void {
    if (!this.cameraLocked) return
    this.viewer.camera.lookAtTransform(this.C.Matrix4.IDENTITY)
    this.cameraLocked = false
  }

  private applyCamera(): void {
    if (this.cameraMode === 'orbit') {
      this.releaseCamera()
      return
    }
    const C = this.C
    const cam = this.viewer.camera
    const pos = this.computeWorldPosition()
    const sim = this.sim
    if (this.cameraMode === 'follow') {
      // 与 three 版 updateCamera 同框位:相机在无人机**正后方** followRange、
      // 上方 FOLLOW_HEIGHT,瞄准点抬 FOLLOW_AIM_LIFT(机身整体进画面)。
      // ⚠️ HeadingPitchRange 的 heading 实测是「机位相对目标的方位角」:
      // 传 sim.heading + 180 会把相机摆到机头**前方**(画面正中是云台镜头),
      // 直接传 sim.heading 才落在机尾后方 —— 探针实测见 tmp-shots/probe-follow.mjs。
      const lift = FOLLOW_HEIGHT - FOLLOW_AIM_LIFT
      const aim = C.Cartesian3.add(
        pos,
        C.Matrix4.multiplyByPointAsVector(
          this.enuToFixed,
          new C.Cartesian3(0, 0, FOLLOW_AIM_LIFT),
          new C.Cartesian3(),
        ),
        new C.Cartesian3(),
      )
      cam.lookAt(
        aim,
        new C.HeadingPitchRange(
          C.Math.toRadians(sim.heading),
          -Math.atan2(lift, this.followRange),
          Math.hypot(this.followRange, lift),
        ),
      )
      this.cameraLocked = true
      return
    }
    // fpv:相机就架在云台载荷上,与拍照/录像共用同一条取景路径
    this.releaseCamera()
    this.applyGimbalCameraPose()
  }

  /**
   * 把相机摆到云台取景位姿 —— 机载视角、拍照、录像三者的唯一取景来源,
   * 与 three 版 applyGimbalCameraPose 同一语义:
   *   位置 = 机体原点沿**云台光轴**前移(水平分量按 cos(俯仰) 收缩、同时抬起 offset·sin(俯仰));
   *   姿态 = 航向(含云台偏航)与云台俯仰,横滚锁水平(three 版三轴增稳的 rollDeg 恒 0)。
   *
   * ⚠️ 符号约定(两端不同,别想当然):
   *    · Cesium **相机**的 pitch 正 = 抬头(Quaternion.fromHeadingPitchRoll 里相机前向取局部 +x,
   *      pitch 分量 Ry(-pitch) 作用后前向上扬),而 sim.gimbalPitch 正 = 抬头 → 同号直传;
   *    · Cesium **模型**的 pitch 正 = 低头(机体前向是局部 -x,同一个旋转对它反号),
   *      而 sim.tiltPitch 正 = 抬头 → 要取负(见 syncModelMatrix)。
   *    实测铁证:云台 -30°(下视)时 pitch 直传画面朝地、取负则朝天(见 verify-gimbal-cam.mjs)。
   */
  private applyGimbalCameraPose(): void {
    const { destination, heading, pitch, roll } = this.gimbalCameraView()
    this.viewer.camera.setView({
      destination,
      orientation: { heading, pitch, roll },
    })
  }

  /**
   * 云台取景视点 —— 机载视角、拍照、录像、采集快照**共用同一个来源**。
   *
   * 把它单独抽出来是为了让「画面里看到的」与「采集记录下来的」不可能不一致:
   * 相机摆位与写入影像元数据的位姿读的是同一个函数。
   */
  private gimbalCameraView(): {
    destination: CesiumNS
    heading: number
    pitch: number
    roll: number
  } {
    const C = this.C
    const sim = this.sim
    const spec = this.modelSpec
    // 取景俯仰:全景分层给了覆盖时用覆盖值(绝对值),否则沿用云台俯仰。
    // 水平方向不在这里做手脚 —— 全景的水平覆盖靠 spinBodyTo 转机体(云台 Pan 行程不够),
    // 所以取景偏航恒等于"机体航向 + 云台偏航真值"。
    const viewPitch = this.captureView?.pitch ?? sim.gimbalPitch
    const viewYaw = sim.gimbalYaw
    const pitchRad = C.Math.toRadians(viewPitch)
    const headingRad = C.Math.toRadians(sim.heading)

    let offsetENU: CesiumNS
    if (this.captureView) {
      // 全景扫描:光心钉在机体自转轴上(与 three 版 fixedCenter 同义)。
      // 取景相机平时沿光轴前移,机体原地自转一周光心会扫出大圆,对近景产生显著视差,
      // 拼接器"绕光心纯旋转"的前提被破坏;全景分层俯仰时只转朝向、光心不动,才能保证
      // 相邻张重叠区可羽化融合,也避免下视时机身进画面。
      offsetENU = new C.Cartesian3(0, 0, spec.gimbalLiftM)
    } else {
      // 普通拍照/录像:光心随云台俯仰做弧线摆动,贴合真实镜头位置。
      offsetENU = new C.Cartesian3(
        Math.sin(headingRad) * spec.gimbalOffsetM * Math.cos(pitchRad),
        Math.cos(headingRad) * spec.gimbalOffsetM * Math.cos(pitchRad),
        spec.gimbalOffsetM * Math.sin(pitchRad) + spec.gimbalLiftM,
      )
    }
    const destination = C.Cartesian3.add(
      this.computeWorldPosition(),
      C.Matrix4.multiplyByPointAsVector(this.enuToFixed, offsetENU, new C.Cartesian3()),
      new C.Cartesian3(),
    )
    return {
      destination,
      // ⚠️ 见 applyGimbalCameraPose 的符号约定说明
      heading: C.Math.toRadians(sim.heading - viewYaw),
      pitch: pitchRad,
      // 三轴增稳:横滚锁水平(three 版 getGimbalCameraOrientation 的 rollDeg 恒 0)
      roll: 0,
    }
  }

  /**
   * 取景相机位姿与内参快照 —— 虚拟影像采集用(见 drone-capture 的 `VirtualCaptureProvider`)。
   *
   * 与 three 版同义:**记录的是取景相机(云台镜头),不是机身**;位姿与内参都从
   * `gimbalCameraView()` + 渲染相机的投影参数里读,不触发渲染、不改动任何相机状态。
   *
   * 坐标系用 `ecef`(Cesium 原生地固系),同时给出一份经纬高 —— 与真实照片的 GPS 字段同形。
   */
  getCaptureCamera(): CaptureCameraState | null {
    if (this.disposed || !this.modelLoaded) return null
    const C = this.C
    const canvas = this.viewer.canvas as HTMLCanvasElement | undefined
    const width = canvas?.width ?? 0
    const height = canvas?.height ?? 0
    if (!width || !height) return null

    const { destination, heading, pitch, roll } = this.gimbalCameraView()
    // 与 camera.setView({orientation:{heading,pitch,roll}}) 内部用的是同一个换算,
    // 所以这个四元数就是相机此刻的真实姿态(而不是另算一套近似)。
    const rotation = C.Transforms.headingPitchRollQuaternion(
      destination,
      new C.HeadingPitchRoll(heading, pitch, roll),
    )
    const carto = C.Cartographic.fromCartesian(destination)
    // PerspectiveFrustum.fovy 是**垂直**视场角(弧度)
    const fovY: number =
      typeof this.viewer.camera.frustum?.fovy === 'number'
        ? this.viewer.camera.frustum.fovy
        : (60 * Math.PI) / 180
    const fy = height / 2 / Math.tan(fovY / 2)
    const fx = fy
    const fovX = 2 * Math.atan(width / (2 * fx))
    const sim = this.sim
    const degrees = (radians: number): number => (radians * 180) / Math.PI

    return {
      pose: {
        position: [destination.x, destination.y, destination.z],
        rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
        coordinateFrame: 'ecef',
      },
      intrinsics: {
        width,
        height,
        fx,
        fy,
        cx: width / 2,
        cy: height / 2,
        horizontalFovDeg: degrees(fovX),
        verticalFovDeg: degrees(fovY),
        calibrationSource: 'known',
      },
      frame: { width, height },
      drone: {
        // 与 three 版统一成 x 东 / y 北 / z 上(sim 内部是 x 东 / y 上 / z 南)
        position: [sim.position.x, -sim.position.z, sim.position.y],
        heading: sim.heading,
        tiltPitch: sim.tiltPitch,
        tiltRoll: sim.tiltRoll,
        gimbalPitch: sim.gimbalPitch,
        gimbalYaw: sim.gimbalYaw,
      },
      geo: {
        longitude: degrees(carto.longitude),
        latitude: degrees(carto.latitude),
        altitude: carto.height,
      },
    }
  }

  // ──────────────────── 取景帧(拍照 / 录像共用) ────────────────────

  /**
   * 记下相机当前位姿(取景帧渲染完原样还回):
   * 用 WC(World Coordinate)三元组存,不依赖相机此刻锁在哪个参考系里。
   */
  private snapshotCamera(): {
    position: CesiumNS
    direction: CesiumNS
    up: CesiumNS
    transform: CesiumNS
  } {
    const C = this.C
    const cam = this.viewer.camera
    return {
      position: C.Cartesian3.clone(cam.positionWC),
      direction: C.Cartesian3.clone(cam.directionWC),
      up: C.Cartesian3.clone(cam.upWC),
      transform: C.Matrix4.clone(cam.transform),
    }
  }

  /** 把相机位姿原样还回去 —— 取景帧渲染完必须调用(与 three 版 restoreCamera 同义) */
  private restoreCamera(snapshot: ReturnType<CesiumDroneAdapter['snapshotCamera']>): void {
    const C = this.C
    const cam = this.viewer.camera
    // 先回到世界系再写位姿:position/direction 的 setter 是按当前参考系解释的
    cam.lookAtTransform(C.Matrix4.IDENTITY)
    cam.setView({
      destination: snapshot.position,
      orientation: { direction: snapshot.direction, up: snapshot.up },
    })
    // 还回原来的锁定参考系(follow 模式下非单位阵);世界位姿在 _setTransform 里保持不变
    cam.lookAtTransform(snapshot.transform)
  }

  /**
   * 取景帧场景可见性:拍照/录像时机体自身与航线辅助物退场。
   *
   * 全景固定光心后,相机就在机体怀里,机壳/机臂/桨叶会进画面并被拼进全景;
   * 航线点/线也不该出现在照片里。与 three 版 `setCaptureFrameVisible` 同义,
   * 拍完按 `applyMissionVisibility()` 还原用户开关状态。
   */
  private setCaptureFrameVisible(visible: boolean): void {
    if (this.model) this.model.show = visible
    if (visible) {
      this.applyMissionVisibility()
    } else {
      this.missionEditor?.setVisible(false)
    }
  }

  /**
   * 取景帧 —— 拍照与录像共用同一条「云台取景」路径:录制/成片内容恒为云台相机拍的,
   * 与用户此刻在哪个视角无关(与 three 版 captureRecordingFrame 完全同义)。
   *
   * 做法:把 Cesium 相机临时搬到云台位姿并保持到地球瓦片就绪、连续渲染稳定帧,
   * 再拷进录制画布(或 toDataURL 成照片)→ 还原相机 → 再渲一帧把用户视角画回去。
   *
   * 两个必须:
   *  - 渲染与拷屏必须同任务完成,否则 WebGL 合成后清空后台缓冲,拿到的是黑帧;
   *  - 拷完必须补渲用户视角:取景帧留在主画布上,不补的话合成器会把云台画面
   *    呈现给用户(录制期间整屏闪帧)。
   * fpv 模式下相机本来就在云台上:用户视角与云台取景是同一个画面,
   * 省去搬移/还原/补渲,渲一帧直接用。
   */
  private captureGimbalFrame(): void {
    const photo = this.photoPending
    const recording = this.recorder !== null
    // 拍照超时可能在两次渲染帧之间触发;下一帧先还原临时相机与场景显隐。
    let restoredAfterTimeout = false
    if (!photo && this.photoCameraRestore) {
      if (this.photoCameraRestore.camera) this.restoreCamera(this.photoCameraRestore.camera)
      this.photoCameraRestore = null
      this.setCaptureFrameVisible(true)
      restoredAfterTimeout = true
    }
    if (!photo && !recording) {
      if (restoredAfterTimeout) this.viewer.render()
      return
    }
    const fpv = this.cameraMode === 'fpv'
    const restore = fpv
      ? null
      : photo
        ? (this.photoCameraRestore?.camera ?? null)
        : this.snapshotCamera()
    if (photo && !this.photoCameraRestore) this.photoCameraRestore = { camera: restore }
    if (!fpv) this.applyGimbalCameraPose()
    this.setCaptureFrameVisible(false)
    this.viewer.render()
    if (recording) this.pushRecordFrame()
    // 首帧 setView 后 Cesium 可能仍显示上一视角的地形/影像瓦片;保持取景位姿,
    // 直到地球瓦片就绪并连续渲染两帧,再拷贝画面。
    if (photo && !photo.forceCapture && this.viewer.scene.globe?.tilesLoaded === false) {
      photo.settledFrames = 0
      return
    }
    if (photo && photo.settledFrames < 2) {
      photo.settledFrames += 1
      return
    }
    if (photo) {
      this.photoPending = null
      window.clearTimeout(photo.timer)
      const shot = this.grabCanvas()
      // 成片才计数(与 three 版 onAfterRender 一致)
      if (shot) this.sim.takePhoto()
      photo.resolve(shot)
    }
    this.setCaptureFrameVisible(true)
    if (photo) this.photoCameraRestore = null
    if (restore) {
      this.restoreCamera(restore)
      this.viewer.render()
    } else {
      // fpv 模式下取景帧就是用户视角:必须再渲一帧把机体显示回来,否则用户会看到一闪
      this.viewer.render()
    }
  }

  /** 把刚渲出来的主画布拷进录制画布,并通知抓帧轨道 */
  private pushRecordFrame(): void {
    const context = this.recordContext
    const source = this.viewer.canvas as HTMLCanvasElement | undefined
    if (!context || !source) return
    // 尺寸跟住主画布,窗口变化时录像不留黑边
    if (context.canvas.width !== source.width || context.canvas.height !== source.height) {
      context.canvas.width = source.width
      context.canvas.height = source.height
    }
    context.drawImage(source, 0, 0)
    this.captureTrack?.requestFrame()
  }

  /** 把当前画布内容拷进离屏 canvas 并转成 PNG(同一任务内执行,拿到的是刚渲染的那一帧) */
  private grabCanvas(): PhotoShot | null {
    const source = this.viewer.canvas as HTMLCanvasElement | undefined
    if (!source || !source.width || !source.height) return null
    const target = document.createElement('canvas')
    target.width = source.width
    target.height = source.height
    const context = target.getContext('2d')
    if (!context) return null
    context.drawImage(source, 0, 0)
    return { dataUrl: target.toDataURL('image/png'), width: target.width, height: target.height }
  }

  /** 视角复位:回到自由漫游,并把机位拉到无人机斜后上方 */
  resetCamera(): void {
    const C = this.C
    this.releaseCamera()
    this.cameraMode = 'orbit'
    const pos = this.computeWorldPosition()
    this.viewer.camera.flyToBoundingSphere(new C.BoundingSphere(pos, 6), {
      duration: 0.8,
      offset: new C.HeadingPitchRange(0, C.Math.toRadians(-28), 16),
    })
  }

  // ──────────────────────── 上位机指令透传 ────────────────────────

  /** 当前飞行相位(与 three 后端同一枚举) */
  get phase() {
    return this.sim.phase
  }
  /** 是否已离地 */
  get airborne(): boolean {
    return this.sim.airborne
  }
  /** 当前飞行挡位 */
  get flightMode(): FlightMode {
    return this.sim.mode
  }
  /** 相对起飞点高度(米) */
  get altitude(): number {
    return this.sim.position.y
  }
  /** 起飞前检查项列表(供面板展示) */
  get preflightChecks(): ChecklistItem[] {
    return this.sim.checklist
  }
  /** 机臂是否处于收纳态 */
  get armsFolded(): boolean {
    return this.armFoldTarget > 0.5
  }
  /** 是否正在录像 */
  get isRecording(): boolean {
    return this.recorder !== null
  }

  /** 上电自检(通过后才能起飞) */
  powerOn(): void {
    this.sim.powerOn()
  }
  /** 自动起飞到默认高度(地面待机相位才受理) */
  takeOff(): boolean {
    return this.sim.autoTakeOff()
  }
  /** 自动降落(中止进行中的航线) */
  land(): boolean {
    return this.sim.startLanding()
  }
  /** 智能返航(需在空中;先中止航线) */
  returnHome(reason = '用户触发返航'): boolean {
    return this.sim.startRth(reason)
  }
  /** 写摇杆连续量(与 three 后端同语义) */
  setStick(stick: Partial<StickState>): void {
    this.sim.setStick(stick)
  }
  /** 切飞行挡位 */
  setMode(mode: FlightMode): void {
    this.sim.setMode(mode)
  }
  /** 设云台俯仰角(度) */
  setGimbalPitch(pitch: number): void {
    this.sim.setGimbalPitch(pitch)
  }

  /** 直接把无人机移动到目标本地坐标位置,并保持离地高度不低于地形 */
  flyTo(target: { x?: number; y?: number; z?: number; heading?: number; pitch?: number; roll?: number }): void {
    const nextX = target.x ?? this.sim.position.x
    const nextY = target.y ?? this.sim.position.y
    const nextZ = target.z ?? this.sim.position.z
    this.sim.position.x = nextX
    this.sim.position.y = Math.max(0, nextY)
    this.sim.position.z = nextZ
    if (target.heading !== undefined) this.sim.heading = target.heading
    if (target.pitch !== undefined) {
      this.sim.tiltPitch = Math.max(-45, Math.min(45, target.pitch))
    }
    if (target.roll !== undefined) {
      this.sim.tiltRoll = Math.max(-45, Math.min(45, target.roll))
    }
    void this.ensureAltitudeAboveTerrain()
  }

  /** 设定相机变焦倍数(1~4x),保持和 three 后端一致 */
  zoomTo(zoom: number): void {
    this.sim.setZoom(zoom)
    if (this.cameraMode === 'follow') {
      const distance = Math.max(1.5, this.followRange / this.sim.cameraZoom)
      this.viewer.camera.lookAt(
        this.computeWorldPosition(),
        new this.C.HeadingPitchRange(
          this.C.Math.toRadians(this.sim.heading),
          -Math.atan2(FOLLOW_HEIGHT - FOLLOW_AIM_LIFT, distance),
          distance,
        ),
      )
    }
  }

  /** 在当前相对坐标处采样地形并确保无人机不钻进地形里 */
  private async ensureAltitudeAboveTerrain(): Promise<void> {
    if (this.disposed || !this.viewer.terrainProvider) return
    const C = this.C
    const local = C.Cartesian3.fromElements(this.sim.position.x, -this.sim.position.z, 0)
    const world = C.Matrix4.multiplyByPoint(this.enuToFixed, local, new C.Cartesian3())
    const carto = C.Cartographic.fromCartesian(world)
    try {
      const [sampled] = await C.sampleTerrainMostDetailed(this.viewer.terrainProvider, [carto])
      if (!sampled || !Number.isFinite(sampled.height)) return
      const minAltitude =
        sampled.height - this.origin.height - this.groundClearance - this.modelSpec.lift + 0.25
      if (this.sim.position.y < minAltitude) {
        this.sim.position.y = minAltitude
      }
    } catch {
      // 地形不可用时忽略,保留当前高度不阻断飞行
    }
  }

  /**
   * 设置取景**俯仰**覆盖 —— 全景扫描(180° / 360°)按俯仰层逐张取景的入口;传 `null` 复位。
   * 与 three 版 `DroneFly.setCaptureView` 同语义:俯仰替代云台俯仰;只影响取景相机
   * (`gimbalCameraView` 一处生效),拍照 / 录像 / 采集快照三条路径自动同源。
   *
   * 没有水平偏航是有意的:水平覆盖靠 `spinBodyTo` 转机体(云台 Pan 行程不够)。
   */
  setCaptureView(override: CaptureViewOverride | null): void {
    this.captureView = override ?? null
  }

  /**
   * 让**机体原地自转**到绝对方位角 `headingDeg`(度,罗盘角);`null` 停止自转。
   * 与 three 版同语义,同样交给飞控内核(`sim.spinTo`)—— 两个后端的自转行为因此完全一致。
   */
  spinBodyTo(headingDeg: number | null): void {
    this.sim.spinTo(headingDeg)
  }

  /** 机体当前方位角(度,罗盘角)—— 全景扫描用它判断"转到位了没" */
  getBodyHeading(): number {
    return this.sim.heading
  }

  /**
   * 展开 / 收拢机臂。
   * Cesium 的 Model 没有 three 版的机械骨骼,这里只维护"目标状态"——
   * 它的唯一作用是驱动起飞前检查项,与真机"不展臂不许起飞"一致。
   */
  setArmsFolded(folded: boolean): void {
    this.armFoldTarget = folded ? 1 : 0
    this.refreshArmCheck()
  }

  /** 注入机臂检查项:三方渲染器下没有骨骼可查,直接用目标状态代替 */
  private installArmCheck(): void {
    if (this.sim.externalChecks.some((item) => item.id === 'arms')) return
    this.sim.externalChecks.push({
      id: 'arms',
      label: '机臂',
      ok: false,
      detail: '机臂处于收纳状态',
      blocking: true,
    })
  }

  private refreshArmCheck(): void {
    const item = this.sim.externalChecks.find((entry) => entry.id === 'arms')
    if (!item) return
    item.ok = this.armFoldTarget <= 0.5
    item.detail = item.ok ? '已展开' : '机臂处于收纳状态'
  }

  // ──────────────────────── 航线任务(MissionPanelHost) ────────────────────────
  //
  // 飞行内核(DroneSim)本来就带全套航线逻辑(启航四步 / goto / hover / 限高限距),
  // Cesium 侧要补的只是"把面板需要的方法接上"加"航点怎么变成地球上的画面"。
  // 方法与 three 版 DroneFly 同名同语义, MissionPanel 因此零改动换后端。

  /** 当前是否处于观察者(自由漫游)视角 —— 场景内编辑的前置条件 */
  get isOrbitView(): boolean {
    return this.cameraMode === 'orbit'
  }

  /** 启动航线任务(地面时先自动起飞,到 1.2 米后自动接上航线) */
  startMission(): boolean {
    return this.sim.startMission()
  }

  /** 暂停执行中的航线(原地悬停,可再续飞) */
  pauseMission(reason?: string): boolean {
    return this.sim.pauseMission(reason)
  }

  /** 续飞被暂停的航线 */
  resumeMission(): boolean {
    return this.sim.resumeMission()
  }

  /** 中止航线并留在原地悬停 */
  stopMission(reason?: string): boolean {
    return this.sim.stopMission(reason)
  }

  /** 下发航点列表(执行中会被内核拒绝,与真机"上传后不可改"一致) */
  setMission(waypoints: Array<Partial<MissionWaypoint>>): boolean {
    return this.sim.setMission(waypoints)
  }

  /** 改航线参数(巡航速度/机头朝向/过点方式/完成后动作/循环) */
  setMissionConfig(patch: Partial<MissionConfig>): void {
    this.sim.setMissionConfig(patch)
  }

  /** 航线参数与航点恢复出厂默认 */
  resetMissionToDefault(): void {
    this.sim.resetMissionToDefault()
  }

  /** 航线只读快照(航点/Home/进度) */
  getMissionSnapshot(): MissionSnapshot {
    return this.sim.snapshot().mission
  }

  /** 全量真值快照(面板据此渲染任务状态与阻塞原因) */
  getSnapshot(): DroneSnapshot {
    return this.sim.snapshot()
  }

  /** 把当前航线整理成可序列化的导出数据(实现下沉在 drone-sim,与 three 后端共用) */
  getMissionExport(): MissionExport {
    return buildMissionExport(
      this.sim.mission.map((waypoint) => ({ ...waypoint })),
      { ...this.sim.missionConfig },
      this.sim.homePosition,
    )
  }

  /** 导出航线文本(`json` 完整存档 / `csv` 纯航点表) */
  exportMission(format: MissionExportFormat = 'json'): string {
    return exportMissionText(this.getMissionExport(), format)
  }

  /** 场景内编辑状态(开关/是否激活/选中/悬停/拖拽中) */
  getMissionEditState(): MissionEditState {
    return (
      this.missionEditor?.getEditState() ?? {
        enabled: this.missionEditEnabled,
        active: false,
        selectedIndex: this.missionEditSelected,
        hoverIndex: -1,
        dragging: false,
        mode: null,
      }
    )
  }

  /** 场景内编辑开关(开启仍需"当前确实可编辑"才生效) */
  setMissionEditEnabled(enabled: boolean): void {
    this.missionEditEnabled = enabled
    this.missionEditor?.setEnabled(enabled)
    if (!enabled) this.setMissionSelected(-1)
    else if (this.sim.mission.length > 0 && this.canMissionSceneEdit()) {
      this.frameMission()
    }
  }

  /** 场景内编辑开关当前是否开着 */
  isMissionEditEnabled(): boolean {
    return this.missionEditEnabled
  }

  /** 当前选中的航点索引(无选中 -1) */
  getMissionSelected(): number {
    return this.missionEditSelected
  }

  /** 同步选中航点(列表点击与场景拾取双向联动) */
  setMissionSelected(index: number): void {
    this.missionEditSelected = index
  }

  /** 原位更新一个航点(场景拖拽每帧调用);内核会做限高 / 限距夹紧 */
  updateMissionWaypoint(index: number, patch: Partial<MissionWaypoint>): MissionWaypoint | null {
    return this.sim.updateMissionWaypoint(index, patch)
  }

  /** 场景编辑:按索引删除一个航点 */
  deleteMissionWaypoint(index: number): boolean {
    if (!this.canMissionSceneEdit()) return false
    if (!this.sim.removeMissionWaypoint(index)) return false
    this.setMissionSelected(Math.min(index, this.sim.mission.length - 1))
    this.sim.pushEvent('info', `场景编辑:已删除航点 ${index + 1}`)
    return true
  }

  /** 场景编辑:以飞机当前位置新增一个航点(高度取飞机当前高度) */
  addMissionWaypointAtDrone(): number {
    if (!this.canMissionSceneEdit()) return -1
    const position = this.sim.position
    const index = this.sim.addMissionWaypoint({
      x: Math.round(position.x),
      z: Math.round(position.z),
      altitude: Math.max(1, Math.round(position.y)),
      speed: this.sim.missionConfig.autoSpeed,
    })
    if (index < 0) return -1
    this.setMissionSelected(index)
    this.sim.pushEvent('info', `场景编辑:已在飞机当前位置新增航点 ${index + 1}`)
    return index
  }

  /** 新航点的默认参数:高度与速度继承相邻航点,避免插出一个贴地点 */
  newWaypointTemplate(index: number): Partial<MissionWaypoint> {
    const list = this.sim.mission
    const neighbour = list[Math.min(index, list.length - 1)] ?? list[list.length - 1]
    return {
      altitude: neighbour?.altitude ?? 30,
      speed: neighbour?.speed ?? this.sim.missionConfig.autoSpeed,
      hoverSeconds: neighbour?.hoverSeconds ?? 0,
    }
  }

  /** 航点标记 / 航线折线 / 返航点的总显隐(不影响任务执行) */
  setMissionVisible(visible: boolean): void {
    this.missionVisible = visible
    this.missionEditor?.setVisible(visible)
  }

  isMissionVisible(): boolean {
    return this.missionVisible
  }

  /** 航点标记显隐 */
  setMissionWaypointsVisible(visible: boolean): void {
    this.missionMarkersVisible = visible
    this.missionEditor?.setWaypointsVisible(visible)
  }

  isMissionWaypointsVisible(): boolean {
    return this.missionMarkersVisible
  }

  /** 航线折线显隐 */
  setMissionPathVisible(visible: boolean): void {
    this.missionPathVisible = visible
    this.missionEditor?.setPathVisible(visible)
  }

  isMissionPathVisible(): boolean {
    return this.missionPathVisible
  }

  /** 地理坐标(经纬高)在 Cesium 后端始终可用 */
  supportsGeoCoordinates(): boolean {
    return true
  }

  /**
   * 取某航点的地理坐标(经纬高,WGS84)。
   *
   * 航点在 sim 里是本地米坐标(x 东 / z 南 / altitude AGL),经 `localToWorld` 投到 ECEF 后
   * 再反算 Cartographic;海拔取椭球绝对高程(= 地形 + AGL),与真实照片的 GPS 字段同形。
   * 越界或点位退化(如地心)返回 null。
   */
  getWaypointGeo(index: number): { lon: number; lat: number; height: number } | null {
    const waypoint = this.sim.mission[index]
    if (!waypoint) return null
    const world = this.localToWorld(waypoint.x, waypoint.altitude, waypoint.z)
    const carto = this.C.Cartographic.fromCartesian(world)
    if (!carto || !Number.isFinite(carto.longitude) || !Number.isFinite(carto.latitude)) return null
    return {
      lon: this.C.Math.toDegrees(carto.longitude),
      lat: this.C.Math.toDegrees(carto.latitude),
      height: carto.height,
    }
  }

  /**
   * 用地理坐标原地改写一个航点:经纬高 → 本地米坐标的逆向换算。
   * `Cartesian3.fromDegrees` 投到 ECEF,再用 `worldToLocalXZ` 取回本地水平坐标(x 东 / z 南);
   * 海拔绝对高程减去锚点海拔即 AGL,交给 `updateMissionWaypoint` 夹紧到合法范围。
   * 越界 / 点位退化(地心)返回 false。
   */
  setWaypointGeo(index: number, geo: { lon: number; lat: number; height: number }): boolean {
    const waypoint = this.sim.mission[index]
    if (!waypoint) return false
    if (![geo.lon, geo.lat, geo.height].every((n) => Number.isFinite(n))) return false
    const C = this.C
    const world = C.Cartesian3.fromDegrees(geo.lon, geo.lat, geo.height)
    const local = this.worldToLocalXZ(world)
    if (!local) return false
    const altitude = Math.min(500, Math.max(1, geo.height - this.origin.height))
    return this.updateMissionWaypoint(index, { x: local.x, z: local.z, altitude }) !== null
  }

  /** 三个显隐开关的初值在编辑器创建后补一遍(构造早于 start) */
  private applyMissionVisibility(): void {
    this.missionEditor?.setVisible(this.missionVisible)
    this.missionEditor?.setWaypointsVisible(this.missionMarkersVisible)
    this.missionEditor?.setPathVisible(this.missionPathVisible)
  }

  /**
   * 把相机拉到"一眼看全整条航线"的位置(编辑航线前先框住航线)。
   *
   * 与 three 版 frameMission 同目的:航点动辄 30~40 米高、水平铺开几十米,
   * 默认机位贴着飞机,根本看不到航线。这里按航点 + 返航点的包围球算距离,
   * 保证竖着铺开的航线也不会被裁掉;只有观察者视角受理(机载/跟随下相机
   * 每帧被适配器接管,飞过去会被立刻拽回)。
   */
  frameMission(): boolean {
    if (!this.isOrbitView) return false
    const C = this.C
    const home = this.sim.homePosition
    const first = this.sim.mission[0]
    let minX = home.x
    let maxX = home.x
    let minY = first ? Math.max(1, first.altitude) : 1
    let maxY = minY
    let minZ = home.z
    let maxZ = home.z
    const include = (x: number, y: number, z: number): void => {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
    }
    for (const waypoint of this.sim.mission) {
      include(waypoint.x, waypoint.altitude, waypoint.z)
    }
    // 地面也要进画面:航点的水平位置在地面上是有意义的参照
    include(minX, 0, minZ)
    include(maxX, 0, maxZ)

    const centerLocal = {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      z: (minZ + maxZ) / 2,
    }
    const radius = Math.max(12, 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ))
    const center = this.localToWorld(centerLocal.x, centerLocal.y, centerLocal.z)
    // 距离同时满足垂直/水平视场:按相机的 fovy 与画布宽高比取大者,再留 35% 余量
    const cam = this.viewer.camera
    const canvas = this.viewer.canvas as HTMLCanvasElement
    const halfVertical = cam.frustum.fovy / 2
    const aspect = canvas.clientWidth > 0 ? canvas.clientWidth / canvas.clientHeight : 1.6
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * Math.max(0.2, aspect))
    const distance =
      Math.max(radius / Math.tan(halfVertical), radius / Math.tan(halfHorizontal)) * 1.35
    this.releaseCamera()
    this.viewer.camera.flyToBoundingSphere(new C.BoundingSphere(center, radius), {
      duration: 0.6,
      offset: new C.HeadingPitchRange(0, C.Math.toRadians(-32), distance),
    })
    return true
  }

  /** 场景内编辑的硬门槛:观察者视角 + 任务未在执行(与 three 版 canMissionSceneEdit 一致) */
  private canMissionSceneEdit(): boolean {
    return this.isOrbitView && this.sim.missionStatus === 'idle' && !this.sim.missionPendingStart
  }

  // ─────────────── 场景内编辑器宿主(CesiumMissionHost 实现) ───────────────

  canEdit(): boolean {
    return this.canMissionSceneEdit()
  }

  getWaypoints(): MissionWaypoint[] {
    return this.sim.mission.map((waypoint) => ({ ...waypoint }))
  }

  getSelected(): number {
    return this.missionEditSelected
  }

  setSelected(index: number): void {
    this.setMissionSelected(index)
  }

  /** 整表提交(双击插入 / 删除):内核会逐点归一化并重建实体 */
  commitWaypoints(waypoints: Array<Partial<MissionWaypoint>>, selected: number): void {
    if (!this.sim.setMission(waypoints)) return
    this.setMissionSelected(selected)
  }

  moveWaypoint(index: number, patch: Partial<MissionWaypoint>): MissionWaypoint | null {
    return this.updateMissionWaypoint(index, patch)
  }

  getLimits(): MissionEditLimits {
    return {
      maxAltitude: this.sim.config.maxAltitude,
      maxDistance: this.sim.config.maxDistance,
      homeX: this.sim.homePosition.x,
      homeZ: this.sim.homePosition.z,
    }
  }

  /**
   * sim 本地米坐标 → ECEF 世界坐标(航点实体定位用)。
   *
   * 与 computeWorldPosition(机体)的差别只在高程基准:机体要再抬
   * groundClearance + modelSpec.lift(让机腹贴地),而航点的 altitude 本身就是
   * **相对起飞点的 AGL**,直接加锚点海拔即是世界高。
   */
  localToWorld(x: number, y: number, z: number): CesiumNS {
    const C = this.C
    const local = C.Cartesian3.fromElements(x, -z, y + this.origin.height)
    return C.Matrix4.multiplyByPoint(this.enuToFixed, local, new C.Cartesian3())
  }

  /** ECEF 世界坐标 → sim 本地水平坐标(双击插入航点用) */
  worldToLocalXZ(world: CesiumNS): { x: number; z: number } | null {
    const C = this.C
    const inverse = C.Matrix4.inverse(this.enuToFixed, new C.Matrix4())
    if (!inverse) return null
    const local = C.Matrix4.multiplyByPoint(inverse, world, new C.Cartesian3())
    if (!local || !Number.isFinite(local.x) || !Number.isFinite(local.y)) return null
    // ENU 东 = sim +x;北 = sim −z(sim 的 z 向南为正)
    return { x: local.x, z: -local.y }
  }

  /** 拖拽期间收起 Cesium 的相机漫游输入,否则相机会跟着指针一起动 */
  setCameraInputEnabled(enabled: boolean): void {
    const controller = this.viewer.scene?.screenSpaceCameraController
    if (controller && 'enableInputs' in controller) controller.enableInputs = enabled
  }

  /** 编辑日志出口:接仿真内核的事件流(面板/控制台都看得到) */
  log(level: 'info' | 'warn', text: string): void {
    this.sim.pushEvent(level, text)
  }

  // ──────────────────────── 拍照 / 录像 ────────────────────────

  /**
   * 拍照:用云台相机取景拍一张 PNG(与用户当前视角无关,与 three 版同义)。
   *
   * 实现是登记一个待取景请求,渲染循环当帧把相机搬到云台位姿 → 渲染 → 同一任务内
   * 拷屏 → 还原(见 captureGimbalFrame)。上一张尚未取回时返回 null,避免连拍踩踏;
   * 地球瓦片未及时稳定时,最多等待 PHOTO_TIMEOUT_MS,之后使用最近渲染的取景帧,
   * 避免因流式地形持续加载而把整张照片丢弃。
   */
  async requestPhoto(): Promise<PhotoShot | null> {
    if (this.disposed || this.photoPending) return null
    return new Promise<PhotoShot | null>((resolve) => {
      const pending = { resolve, timer: 0, settledFrames: 0, forceCapture: false }
      pending.timer = window.setTimeout(() => {
        if (this.photoPending === pending) pending.forceCapture = true
      }, PHOTO_TIMEOUT_MS)
      this.photoPending = pending
    })
  }

  /** 开始屏录(录云台取景,与用户当前视角无关)。返回 false = 当前环境不支持 */
  startRecording(): boolean {
    if (this.recorder) return true
    const canvas = this.viewer.canvas as HTMLCanvasElement | undefined
    if (
      !canvas ||
      typeof MediaRecorder === 'undefined' ||
      typeof canvas.captureStream !== 'function'
    ) {
      return false
    }
    // 录制源用独立离屏画布:每帧只往里搬一帧云台取景,主画布上用户视角的渲染
    // 永远不会污染录制流。直接抓主画布(canvas.captureStream)录到的就是用户视角
    // —— 那正是"录像没用云台拍"的原因。
    const recordCanvas = document.createElement('canvas')
    recordCanvas.width = canvas.width || 1
    recordCanvas.height = canvas.height || 1
    const recordContext = recordCanvas.getContext('2d')
    if (!recordContext) return false
    let recorder: MediaRecorder
    let stream: MediaStream
    try {
      // captureStream(0) = 手动抓帧:录到什么由渲染循环里搬进这张画布的云台帧决定。
      stream = recordCanvas.captureStream(0)
      const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined
      if (track && typeof track.requestFrame === 'function') {
        this.captureTrack = track
      } else {
        // 少数环境不支持手动抓帧:退回按帧率自动采样这张画布(内容仍是云台取景)
        stream.getTracks().forEach((item) => item.stop())
        stream = recordCanvas.captureStream(RECORD_FPS)
        this.captureTrack = null
      }
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm'
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: RECORD_BITRATE })
    } catch {
      this.captureTrack = null
      return false
    }
    this.recordContext = recordContext
    this.recordStream = stream
    this.recordChunks = []
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.recordChunks.push(event.data)
    }
    recorder.start(RECORD_TIMESLICE_MS)
    this.recorder = recorder
    this.sim.setRecordingState(true)
    return true
  }

  /** 结束屏录:收尾成 Blob 并交给 onRecordingReady(未录制时直接返回 null) */
  stopRecording(): Promise<Blob | null> {
    const recorder = this.recorder
    this.recorder = null
    const seconds = this.sim.recordSeconds
    this.sim.setRecordingState(false)
    if (!recorder) return Promise.resolve(null)
    const chunks = this.recordChunks
    this.recordChunks = []
    return new Promise<Blob | null>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        this.recordStream?.getTracks().forEach((track) => track.stop())
        this.recordStream = null
        this.captureTrack = null
        this.recordContext = null
        const blob = chunks.length
          ? new Blob(chunks, { type: recorder.mimeType || 'video/webm' })
          : null
        if (blob) this.onRecordingReady?.(blob, seconds)
        resolve(blob)
      }
      // 部分环境可能不派发 onstop,兜底收尾
      const timer = window.setTimeout(finish, RECORD_STOP_TIMEOUT_MS)
      recorder.onstop = finish
      try {
        recorder.stop()
      } catch {
        finish()
      }
    })
  }

  /** 回到"上电前的干净状态":停桨、归零位姿、复位飞控 */
  resetAll(): void {
    this.setStick({ ...NEUTRAL_STICK })
    this.sim.reset()
  }
}
