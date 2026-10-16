/**
 * 飞行沙盒的"装配层 + 主循环":把仿真内核(drone-sim)、模型机械(drone-rig)、场景辅助(drone-world)、
 * 灯光(drone-lights)、雷达(drone-radar)接成一个可交互的三维飞行场景。
 *
 * 职责边界:本文件只做"推进仿真 + 把仿真状态映射到场景与相机";飞行物理在 drone-sim、
 * 模型骨骼动画在 drone-rig,各子系统实现各归其模块。
 *
 * 对外导出 DroneFly(宿主类)、DroneFlyInitializeOptions(初始化配置)、DRONE_MODEL_URL(真机机体模型路径)、
 * statusPatternFor(灯语映射)、DRONE_MAX_SPEED_METERS_PER_SECOND 及相机/拍照/录像类型,并转出 drone-sim / mission-editor 的公共类型。
 * 非直觉约定:仿真用固定步长 1/60 推进、每帧只调一次 syncPose 写入场景;非 orbit 视角不得调 controls.update();拍照/录像共用云台取景相机位姿;
 * initialize 不传 modelUrl 时用内置「机械哈士奇」机体(createHuskyDroneModel)而非去 /models 下找文件。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { DronePanelHost } from './drone-control'
import { createHuskyDroneModel } from './drone-husky-model'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { WebGPURenderer } from 'three/webgpu'
import { DroneLights, statusPatternFor } from './drone-lights'
import type { AuxLightMode, BatteryLightMode, StatusLightKey } from './drone-lights'
import { DroneRig, type RigPartReport } from './drone-rig'
import { DroneRadar, type RadarAim, type RadarSnapshot } from './drone-radar'
import { DEFAULT_OBSTACLES, DroneWorld, type ObstacleSpec } from './drone-world'
import { MissionEditor, type MissionEditState } from './mission-editor'
import {
  DroneSim,
  DRONE_SPEC,
  FLIGHT_MODES,
  NEUTRAL_STICK,
  buildMissionExport,
  exportMissionText,
  type DroneSnapshot,
  type ChecklistItem,
  type FaultFlags,
  type FlightMode,
  type FlightPhase,
  type MissionConfig,
  type MissionExport,
  type MissionExportFormat,
  type MissionSnapshot,
  type MissionWaypoint,
  type SimConfig,
  type StickState,
} from './drone-sim'
// 仅类型:采集契约定义在 drone-capture,用 import type 引 —— 采集服务不引任何渲染实现,
// 依赖方向始终是「后端 → 契约」单向,没有运行时循环。
import type { CaptureCameraState, CaptureViewOverride } from './drone-capture'

/**
 * 默认真机机体模型路径(DJI Mini 4 Pro 重命名版)。
 * 资产不随库打包,需使用方自行提供 —— 所以它**不再是 initialize() 的缺省值**:
 * 不传 modelUrl 时用的是零依赖的内置积木机体,想要真机模型就把这个常量传进去。
 */
export const DRONE_MODEL_URL = '/models/djiair_renamed.glb'
const DRONE_SIZE_METERS = 2.4
/** 机型最快档位速度,用于界面提示 */
export const DRONE_MAX_SPEED_METERS_PER_SECOND = FLIGHT_MODES.sport.horizontalSpeed

/** 旧版方向键 API(仅保留给外部复用) */
export type DroneDirection = 'up' | 'down' | 'left' | 'right'
/** 纯升降方向 */
export type DroneVerticalDirection = 'up' | 'down'
/** 纯偏航(左右转向)方向 */
export type DroneRotationDirection = 'left' | 'right'

export type {
  DroneSnapshot,
  FaultFlags,
  FlightMode,
  MissionConfig,
  MissionSnapshot,
  MissionWaypoint,
  SimConfig,
  StickState,
} from './drone-sim'
// 航线序列化(类型 + 实现)已下沉到 drone-sim(纯逻辑层):Cesium 后端复用同一份实现时,
// 不会把 three 拖进它的运行时依赖。这里原样再导出,公共 API(`from 'drone-camera'`)不变。
export type { MissionExport, MissionExportFormat } from './drone-sim'
export { buildMissionExport, exportMissionText, findMissionInsertIndex, missionToCsv } from './drone-sim'
export type { MissionDragMode, MissionEditState, MissionEditorHost } from './mission-editor'

/** 相机视角模式:orbit=观察者(轨道控制器),follow=跟随,fpv=机载(云台视角) */
export type CameraMode = 'orbit' | 'follow' | 'fpv'

/** 面板用的相机模式列表(含中文标签) */
export const CAMERA_MODE_LIST: Array<{ key: CameraMode; label: string }> = [
  { key: 'orbit', label: '观察者' },
  { key: 'follow', label: '跟随' },
  { key: 'fpv', label: '机载' },
]

/**
 * 云台增稳档位 —— **模型不参与稳像,全部在相机侧反向抵消**:
 * - `full`(默认):姿态 + 位置双解耦。取景相机的位置与朝向都由飞控真值直接解出
 *   (`机体平移 + R_y(航向)·挂点` / `R_y(航向+云台偏航)·R_x(云台俯仰)⊗安装偏置`),
 *   **完全不读骨骼链世界变换**。于是模型那边照旧物理真实(云台关节仍在做反向补偿、
 *   仍有一阶跟随与行程夹紧),但那些"拟真副作用"一个都传不到画面里 —— 机载视角即
 *   等效于真机的三轴机械云台:机身怎么倾斜,镜头都稳稳对着目标。
 * - `physical`:相机改为**采样骨骼链**(位置取云台真实世界位姿),于是镜头会跟着
 *   机体倾斜绕横滚轴画弧(镜头挂在重心下方约 0.14 m,侧倾 27° 即横移 ±6.7 cm),
 *   云台关节的滞后与行程夹紧也会原样入画。想要"裸机硬核真实感"时用。
 */
export type GimbalStabilization = 'full' | 'physical'

/** 云台增稳可调项(见 DroneFly.configureGimbal) */
export interface GimbalStabilizationOptions {
  /** 增稳档位,默认 'full' */
  stabilization?: GimbalStabilization
  /**
   * 云台关节一阶跟随时间常数(秒):0 = 立即到位,默认 0.02(20 ms)。
   * 只作用于**模型外观**(云台看起来像无刷电机一样有响应时间);
   * `full` 档下相机不采样关节,所以不会因为滞后而晃。
   */
  response?: number
  /** 电子增稳强度 0~1:0 = 关闭,默认 0(解耦后目标姿态已无噪声,低通只会加滞后) */
  smoothing?: number
}

const FIXED_STEP = 1 / 60
const MAX_STEPS_PER_FRAME = 240
const FOLLOW_DISTANCE = 7.5
const FOLLOW_HEIGHT = 2.8
/** 相机镜头位置:沿云台光轴从云台中心前移,避免把云台自身拍进画面 */
const GIMBAL_CAMERA_OFFSET = 0.12
/** 动态偏移余量(米):相机越过载荷前端后再往外挪这么多,贴着外壳边缘也不穿帮 */
const GIMBAL_CAMERA_CLEARANCE_MARGIN = 0.02
/**
 * 电子增稳(EIS)时间常数上限(秒):fpvSmoothing=1 时相机姿态低通的时间常数。
 * 真机是"云台没盖住的微米级偏移由电子防抖在裁切范围内修正",这里等价成对
 * 相机姿态做一阶低通,把残余高频微抖滤掉。
 */
const FPV_SMOOTH_TAU = 0.08
/** 云台关节一阶跟随时间常数默认值(秒):无刷电机实际响应量级 */
const DEFAULT_GIMBAL_RESPONSE = 0.02
/**
 * 电子增稳默认强度(0~1):默认关闭。`full` 档下相机姿态已由飞控真值直出(无噪声),
 * 再叠低通只会引入滞后 —— 那本身就是"晃"的来源之一。需要额外柔化时再调高。
 */
const DEFAULT_FPV_SMOOTHING = 0
/**
 * 机臂展开/收拢的一阶缓动速率(1/秒):9 ≈ 0.5 s 内完成,
 * 让"上电 → 展臂 → 桨叶张开 → 可起飞"整条流程控制在 1 秒内。
 */
const ARM_FOLD_RATE = 9
/**
 * 起落架腿收放的一阶缓动速率(1/秒):2.5 ≈ 0.6 s 走完,比机臂慢半拍 ——
 * 收腿发生在"已离地"之后,从容一点更像真机起落架。
 */
const LEG_DEPLOY_RATE = 2.5
/**
 * 起落架腿收放高度阈(米,AGL):高于收、低于放。
 * 起飞爬过该高度开始收;降落/手动下降到该高度以下就开始放,
 * 保证触地瞬间机足已经张开(地面静止永远是放下态,不影响触地配平)。
 */
const LEG_RETRACT_ALTITUDE = 0.6
/** 拍照等待渲染的兜底时限(毫秒),超时按失败处理 */
const PHOTO_TIMEOUT_MS = 2000
/** 录像参数:帧率 / 码率 / 分片间隔 */
const RECORD_FPS = 30
const RECORD_BITRATE = 8_000_000
const RECORD_TIMESLICE_MS = 500
/** 录制收尾兜底时限(毫秒):部分环境可能不派发 onstop */
const RECORD_STOP_TIMEOUT_MS = 1500

/** 录像容器候选:优先 VP9,退回 VP8/webm,再交给浏览器默认 */
const RECORD_MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

/** 单张照片(云台相机取景) */
export interface PhotoShot {
  /** PNG data URL,可直接用于 <img> 或下载 */
  dataUrl: string
  width: number
  height: number
}

/** 相机位姿快照:取景帧(拍照 / 录像)渲染完必须还回去 */
interface CameraRestore {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  zoom: number
}

function pickRecordMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function')
    return undefined
  return RECORD_MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** DroneFly.initialize() 的可选配置 */
export interface DroneFlyInitializeOptions {
  /**
   * 机体模型 GLB 地址(URL 或相对路径)。
   * **不传 = 用内置的「积木无人机」**(程序化几何体拼出来的四轴,零资产依赖,
   * 见 `createHuskyDroneModel`);需要真机模型时再传,例如 `DRONE_MODEL_URL`。
   * 自定义模型不必与默认模型尺寸/原点一致 —— 载入后会自动缩放到 2.4m 级、
   * 水平居中并底面对齐地面(见 normalizeModel),因此可直接传任意 glb。
   */
  modelUrl?: string
  /**
   * 场景里的障碍物(建筑 / 灯杆 / 天桥 / 树…… 都是 AABB 盒),同一份数据既生成可视网格,
   * 又喂给飞控做避障判定 —— 换了坐标,画面和碰撞会一起变。
   * 缺省用内置的 `DEFAULT_OBSTACLES`(起飞点 30 米内的 7 个参考物);
   * 传 `[]` 得到一块纯空地(只剩地面网格与返航点标记);也可传自己的 `ObstacleSpec[]` 整体替换。
   * 只想临时藏起来(保留碰撞)用 `fly.world?.setObstaclesVisible(false)`。
   */
  obstacles?: ObstacleSpec[]
}

/**
 * 飞行沙盒的装配层:把飞行仿真内核、模型机械、场景辅助与灯光接到一起。
 *
 * 每帧固定步长推进仿真(与渲染帧率解耦,时间倍速下也能保持稳定),
 * 然后只做"把仿真状态映射到三维场景"这一件事,保证画面与遥测显示的永远是同一份状态。
 */
export class DroneFly implements DronePanelHost {
  camera: THREE.PerspectiveCamera | null
  scene: THREE.Scene<THREE.Object3DEventMap> | null
  renderer: WebGPURenderer | null
  controls: OrbitControls<THREE.Camera> | null
  model: THREE.Group | null = null
  lights: DroneLights | null = null
  rig: DroneRig | null = null
  world: DroneWorld | null = null
  radar: DroneRadar | null = null
  /** 雷达射线可视化开关(雷达实例可能晚于页面初始化创建,先缓存再补上);默认不显示 */
  private radarBeamsVisible = false
  /** 辅助灯锥形光束开关;默认不显示 */
  private auxBeamVisible = false
  readonly sim = new DroneSim()
  /**
   * 引擎标识。DroneFly 是 three.js 实现,与 CesiumDroneAdapter 的 `engine = 'cesium'`
   * 构成判别字段 —— 宿主用同一份 `createDroneControl({ engine })` 装配,拿到实例后
   * 还能靠它 `if (drone.engine === 'three')` 访问引擎特有成员。
   */
  readonly engine = 'three' as const
  cameraMode: CameraMode = 'orbit'
  /** 云台增稳档位(见 GimbalStabilization);默认位置 + 姿态双解耦 */
  gimbalStabilization: GimbalStabilization = 'full'
  /** 云台关节一阶跟随时间常数(秒),0 = 立即到位;仅影响模型外观,初值同步给 rig */
  gimbalResponse = DEFAULT_GIMBAL_RESPONSE
  /** 电子增稳强度 0~1,0 = 关闭(默认) */
  fpvSmoothing = DEFAULT_FPV_SMOOTHING
  /**
   * 取景**俯仰**覆盖(全景分层用,见 `setCaptureView`):非 null 时取景相机临时偏离
   * "云台当前俯仰"。只影响取景(拍照 / 录像 / 采集快照),不动飞控与机体姿态。
   *
   * 这里没有水平偏航是有意的 —— 水平覆盖靠**机体原地自转**(见 `spinBodyTo`),
   * 云台 Pan 机械行程转不出 180°(理由见 `drone-panorama` 的文件头)。
   */
  private captureView: CaptureViewOverride | null = null

  private readonly loader = new GLTFLoader()
  private groundOffsetY = 0
  private accumulator = 0
  private destroyed = false
  private cameraTarget = new THREE.Vector3(0, 0, 0)
  /** 观察者视角是否把控制点自动跟到飞机上(框航线 / 场景编辑时关掉,见 frameMission) */
  private cameraAutoFollow = true
  private readonly cameraScratch = new THREE.Object3D()
  private readonly dronePosition = new THREE.Vector3()
  private readonly cameraShift = new THREE.Vector3()
  private readonly followPosition = new THREE.Vector3()
  private readonly followLookAt = new THREE.Vector3()
  private readonly forwardVector = new THREE.Vector3()
  /** 电子增稳:相机姿态的低通状态(避免切视角时从旧位姿慢慢滑过来) */
  private readonly fpvQuat = new THREE.Quaternion()
  /** 姿态解耦档下,由飞控真值解出的期望相机世界朝向(不读骨骼链) */
  private readonly fpvTargetQuat = new THREE.Quaternion()
  /** 全景成片的**固定光心**:挂点世界高度暂存(见 applyGimbalCameraPose 的 fixedCenter) */
  private readonly captureCenter = new THREE.Vector3()
  private fpvQuatReady = false
  /** 上一帧的帧间隔(秒):拍照/录像取景帧复用,保证平滑状态连续 */
  private lastFrameDelta = 1 / 60
  private lightOverride: StatusLightKey | null = null
  /** 机臂目标折叠度:1 = 收纳(出厂收纳状态,起飞前必须先展开) */
  private armFoldTarget = 1
  /** 航线可视化签名:只有航线内容变化时才重建三维标记(每帧重建代价太大) */
  private missionSignature = ''
  /** 航点/航线图层显隐(面板开关,重建标记后要重新贴回) */
  private missionVisible = true
  /** 航点标记 / 航线折线各自的开关(拆开控制,重建标记后要重新贴回) */
  private missionMarkersVisible = true
  private missionPathVisible = true
  /** 场景内航点编辑器(需要画布,headless / 无渲染器时为 null) */
  missionEditor: MissionEditor | null = null
  /** 场景编辑开关(界面意图;编辑器实例可能晚于页面初始化创建,先缓存再补上) */
  private missionEditEnabled = false
  /** 场景编辑选中的航点索引(-1 = 未选中) */
  private missionEditSelected = -1
  /** 待取景的拍照请求:渲染前摆相机、渲染后拷屏并还原(见 onBeforeRender / onAfterRender) */
  private photoRequest: {
    resolve: (shot: PhotoShot | null) => void
    timer: number
    /** 取景前的相机位姿(onBeforeRender 填,onAfterRender 还原) */
    restore: CameraRestore | null
  } | null = null
  /** 云台相机取景用的独立相机(拍照不影响主相机对象本身) */
  private readonly captureCamera = new THREE.PerspectiveCamera()
  /** 屏录:sim.recording 是状态来源,这里负责真正的 MediaRecorder */
  private recorder: MediaRecorder | null = null
  private recordChunks: Blob[] = []
  private recordStream: MediaStream | null = null
  /** 手动抓帧轨道(captureStream(0)):录到什么由 captureRecordingFrame 那一帧云台取景决定 */
  private captureTrack: CanvasCaptureMediaStreamTrack | null = null
  /** 录制专用离屏画布的上下文:每帧只往里搬一帧云台取景,主画布上的用户视角永远不会混进录像 */
  private recordContext: CanvasRenderingContext2D | null = null
  /** 进入机载视角前的观察者缩放,退出时归还(变焦只在机载取景下生效) */
  private savedZoom: number | null = null
  /** 录像收尾回调:UI 用它落盘(引擎不直接触发下载) */
  onRecordingReady: ((blob: Blob, seconds: number) => void) | null = null

  /** 飞行总控:接管场景/相机/渲染器/控制器,装配仿真内核与机体机械 */
  constructor(
    scene: THREE.Scene<THREE.Object3DEventMap> | null,
    camera: THREE.PerspectiveCamera | null,
    renderer: WebGPURenderer | null,
    controls: OrbitControls<THREE.Camera> | null,
  ) {
    this.scene = scene
    this.camera = camera
    this.renderer = renderer
    this.controls = controls
  }

  /**
   * 初始化无人机:装配机体模型,并挂入机械 / 灯光 / 场景 / 雷达 / 编辑器各子系统,
   * 最后做一次初始同步。可重复调用前需先 dispose(本方法不自动清理旧模型)。
   *
   * 机体来源二选一:
   * - `options.modelUrl` 给了 → 加载该 GLB;
   * - 没给 → 用内置「积木无人机」(程序化几何体,零资产依赖)。
   *
   * @param options.modelUrl 机体 GLB 路径;缺省用内置积木机体。
   * @param options.obstacles 场景障碍物规格(缺省用内置 7 个参考物)。
   */
  async initialize(options: DroneFlyInitializeOptions = {}): Promise<void> {
    if (!this.scene || this.destroyed) return

    // 没传模型路径就不再默认去 /models 下找一个未必存在的文件:直接用内置积木机体,
    // 保证"零资产"环境下也能完整跑通(归一化 / 机械 / 灯光 / 雷达走的都是同一条装配路径)。
    let model: THREE.Group
    if (options.modelUrl) {
      const gltf = await this.loader.loadAsync(options.modelUrl)
      if (this.destroyed) {
        this.disposeModel(gltf.scene)
        return
      }
      model = gltf.scene
      model.name = 'DJI Mini 4 Pro'
    } else {
      model = createHuskyDroneModel()
    }
    this.normalizeModel(model)
    // 模型已归一到"底面对齐 y=0",记录其基准高度作为地面偏移;机体高度一律加这个偏移(见 syncPose / updateCamera)
    this.groundOffsetY = model.position.y
    model.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
    })
    this.scene.add(model)
    this.model = model

    // 机械件与灯光
    this.rig = new DroneRig(model)
    this.rig.gimbalResponse = this.gimbalResponse
    this.lights = new DroneLights()
    this.lights.attach(model, this.scene)
    this.lights.setBeamVisible(this.auxBeamVisible)

    // 场景辅助(地面网格 / 返航点 / 障碍物 / 航迹):障碍物规格由调用方决定,缺省才是内置那 7 个
    this.world = new DroneWorld(this.scene, options.obstacles ?? DEFAULT_OBSTACLES)
    this.sim.obstacles = this.world.collisionBoxes

    // 场景内航点编辑:直接抓三维场景里的航点拖动(需要画布与相机,headless 环境下自动跳过)
    const canvas = this.renderer?.domElement
    if (canvas && this.camera) {
      this.missionEditor = new MissionEditor({
        canvas,
        camera: this.camera,
        world: this.world,
        canEdit: () => this.canMissionSceneEdit(),
        getWaypoints: () => this.sim.mission.map((waypoint) => ({ ...waypoint })),
        getSelected: () => this.missionEditSelected,
        setSelected: (index) => this.setMissionSelected(index),
        commitWaypoints: (waypoints, selected) => {
          // ⚠️ 这里故意不刷新 missionSignature:航点数变了必须让 syncPose 整层重建
          // (拖动那种"只改一个航点"的路径走 updateMissionWaypoint,才刷新签名)
          if (!this.sim.setMission(waypoints)) return
          this.setMissionSelected(selected)
        },
        moveWaypoint: (index, patch) => this.updateMissionWaypoint(index, patch),
        setOrbitEnabled: (enabled) => {
          if (this.controls) this.controls.enabled = enabled && this.isOrbitView
        },
        getLimits: () => ({
          maxAltitude: this.sim.config.maxAltitude,
          maxDistance: this.sim.config.maxDistance,
          homeX: this.sim.homePosition.x,
          homeZ: this.sim.homePosition.z,
        }),
        newWaypointTemplate: (index) => this.newWaypointTemplate(index),
        log: (level, text) => this.sim.pushEvent(level, text),
      })
      this.missionEditor.setEnabled(this.missionEditEnabled)
    }

    // 前视测距雷达(起点/方向取自模型的前向视觉玻璃节点,上电后工作)
    if (this.scene) {
      this.radar = new DroneRadar(this.scene)
      this.radar.bindSensors(model)
      this.radar.setVisible(this.radarBeamsVisible)
    }

    // 起飞前检查里的"模型侧"项目:模型自检只做提示,不拦起飞(缺几个装饰件不影响飞控)
    const allPartsFound = this.rig.parts.every((part) => part.found)
    this.sim.externalChecks = [
      {
        id: 'model',
        label: '模型部件自检',
        ok: allPartsFound,
        detail: this.modelHealthText(),
        blocking: false,
      },
      {
        id: 'arms',
        label: '机臂已展开',
        ok: this.rig.armFold < 0.02,
        detail: this.rig.armFold < 0.02 ? '已展开' : '机臂处于收纳状态',
        blocking: true,
      },
    ]
    this.syncPose(0)
  }

  private modelHealthText(): string {
    const missing = this.rig?.parts.filter((part) => !part.found) ?? []
    if (missing.length === 0) return `ID 表部件全部就位(${this.rig?.parts.length ?? 0} 项)`
    return `缺失 ${missing.length} 项:${missing.map((item) => item.id).join('、')}`
  }

  /** 每帧推进:渲染帧率下用固定步长跑仿真,再用同一份状态驱动画面 */
  /**
   * 每帧推进:固定步长跑仿真,与渲染帧率解耦。
   * 低帧率机器(或无头环境)不会让仿真变慢 —— 用累加器补帧;挂起后的超长帧直接丢弃积压。
   */
  animate(deltaSeconds?: number): void {
    const delta = Math.max(0, Math.min(deltaSeconds ?? 1 / 60, 2))
    this.lastFrameDelta = delta
    const timeScale = clamp(this.sim.config.timeScale, 1, 20)
    const scaled = delta * timeScale
    this.accumulator = Math.min(this.accumulator + scaled, MAX_STEPS_PER_FRAME * FIXED_STEP)
    let steps = 0
    while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      this.sim.step(FIXED_STEP)
      this.accumulator -= FIXED_STEP
      steps += 1
    }

    this.syncPose(delta)
    this.updateCamera(delta)
    this.pushTrail()
    // 仿真侧关掉了录像(重置/降落等):收尾并交出成片
    if (this.recorder && !this.sim.recording) void this.stopRecording()
  }

  /** 把仿真状态写进三维场景 */
  private syncPose(delta: number): void {
    const sim = this.sim
    const x = sim.position.x
    const y = this.groundOffsetY + sim.position.y
    const z = sim.position.z
    this.rig?.applyBodyPose({
      x,
      y,
      z,
      headingDeg: sim.heading,
      pitchDeg: sim.tiltPitch,
      rollDeg: sim.tiltRoll,
    })
    this.rig?.setGimbalAttitude(
      sim.gimbalPitch,
      sim.gimbalRoll,
      sim.gimbalYaw,
      sim.tiltPitch,
      sim.tiltRoll,
      // 关节按一阶惯性跟随(模拟无刷电机响应);delta=0(初始化同步)时立即到位
      delta,
    )
    // 目视转速用真实帧时间,不跟时间倍速走,否则高倍速下桨叶会糊成一片;
    // 传入混控后的四电机转速表,每个桨按自己的负荷转(差动可见)
    this.rig?.updateProps(sim.motorSpeeds ?? sim.motorLoad, delta)
    if (this.rig) {
      const fold = this.rig.armFold
      this.rig.setArmFold(fold + (this.armFoldTarget - fold) * Math.min(1, delta * ARM_FOLD_RATE))
      // 桨叶叠拢/张开:机臂完全展开后才缓缓张开(真机节奏)
      this.rig.updateBlades(delta)
      sim.armFold = this.rig.armFold
      const armCheck = sim.externalChecks.find((item) => item.id === 'arms')
      if (armCheck) {
        const unfolded = this.rig.armFold < 0.02
        if (!unfolded) {
          armCheck.ok = false
          armCheck.detail = '机臂处于收纳状态'
        } else if (this.rig.bladeOpen < 0.98) {
          armCheck.ok = false
          armCheck.detail = '螺旋桨展开中'
        } else {
          armCheck.ok = true
          armCheck.detail = '已展开'
        }
      }
      // 起落架腿:高于阈值(且已离地)收起,低空/地面放下 —— 只有带 LEG_* 节点的
      // 机体(哈士奇)有腿,真机 GLB 自动 no-op。迟滞靠单阈值 + 缓动天然形成。
      const legTarget = sim.airborne && sim.position.y > LEG_RETRACT_ALTITUDE ? 0 : 1
      const legDeploy = this.rig.legDeploy
      this.rig.setLegDeploy(
        legDeploy + (legTarget - legDeploy) * Math.min(1, delta * LEG_DEPLOY_RATE),
      )
    }

    // 灯光:状态灯语跟随飞行状态,除非面板手动指定
    const lights = this.lights
    if (lights) {
      lights.setFlying(sim.airborne)
      lights.setBatteryLevel(sim.batteryPercent)
      lights.setStatusPattern(this.lightOverride ?? statusPatternFor(sim))
      lights.update(delta)
      // 状态灯骨骼绑定:首次在展开态把灯珠挂进机臂折叠节点(记录绑定位姿),
      // 之后每帧按绑定位姿刚体同步 —— 灯珠像焊在机臂末端一样随折叠/展开运动,
      // 即使被热更新重建等外力挪动过也会自动归位
      if (this.rig && this.rig.armFold < 0.005) {
        lights.attachStatusToArms(
          this.rig.getArmFoldNode('RearLeft'),
          this.rig.getArmFoldNode('RearRight'),
        )
      }
      lights.syncStatusToArms()
    }

    const home = sim.homePosition
    this.world?.setHome(home.x, home.z)

    // 航线任务可视化:航点标记 / 航线折线只在航线内容变化时重建,当前目标每帧贴高亮
    const world = this.world
    if (world) {
      const signature = this.buildMissionSignature()
      if (signature !== this.missionSignature) {
        this.missionSignature = signature
        world.setMissionWaypoints(
          sim.mission.map((waypoint) => ({
            x: waypoint.x,
            z: waypoint.z,
            altitude: waypoint.altitude,
          })),
          home,
        )
        // 重建出来的是一整套新对象,显隐与高亮状态得重新贴回去
        world.setMissionVisible(this.missionVisible)
        world.setMissionWaypointsVisible(this.missionMarkersVisible)
        world.setMissionPathVisible(this.missionPathVisible)
        world.setMissionSelection(this.missionEditSelected)
      }
      const active = sim.missionIndex >= 0 ? (sim.mission[sim.missionIndex] ?? null) : null
      world.setMissionActive(
        active ? sim.missionIndex : -1,
        active ? { x: active.x, z: active.z, altitude: active.altitude } : null,
      )
    }

    // 场景编辑:不可编辑(切到机载视角 / 任务开始执行)时自动收摊
    this.missionEditor?.update()

    // 测距雷达:上电即工作,镜头可转向(默认看正前方/正上方),视场随机体姿态转动
    if (this.radar && this.world && this.model) {
      this.radar.update(this.model, this.world, delta, sim.phase !== 'powerOff')
    }
  }

  /** 测距雷达最新读数:前视双镜头 + 上视双孔(Vue 面板 100ms 轮询) */
  getRadarSnapshot(): RadarSnapshot {
    return (
      this.radar?.getSnapshot() ?? {
        detecting: false,
        left: null,
        right: null,
        range: 18,
        upLeft: null,
        upRight: null,
        upRange: 15,
        aim: 'forward',
      }
    )
  }

  /** 切换镜头瞄准:forward = 转向正前方/正上方;sensor = 沿镜头(玻璃面)朝向 */
  setRadarAim(aim: RadarAim): void {
    this.radar?.setAim(aim)
  }

  /** 切换雷达射线可视化(前视 + 上视,读数不受影响) */
  setRadarBeamsVisible(visible: boolean): void {
    this.radarBeamsVisible = visible
    this.radar?.setVisible(visible)
  }

  /** 当前雷达射线可视化是否显示(探针用) */
  isRadarBeamsVisible(): boolean {
    return this.radar?.isBeamsVisible() ?? this.radarBeamsVisible
  }

  /** 切换底部辅助灯的锥形光束显隐(不影响辅助灯照明) */
  setAuxBeamVisible(visible: boolean): void {
    this.auxBeamVisible = visible
    this.lights?.setBeamVisible(visible)
  }

  /** 当前辅助灯锥形光束是否绘制(探针用) */
  isAuxBeamVisible(): boolean {
    return this.lights?.isBeamVisible() ?? this.auxBeamVisible
  }

  private pushTrail(): void {
    const sim = this.sim
    if (!this.world) return
    if (sim.airborne) {
      this.world.pushTrail(sim.position.x, this.groundOffsetY + sim.position.y, sim.position.z)
    }
  }

  // ————————————————————————————— 相机 —————————————————————————————

  /** 切换相机视角;进出机载视角时保存/归还轨道视角的缩放(变焦只在机载下生效) */
  setCameraMode(mode: CameraMode): void {
    const previous = this.cameraMode
    this.cameraMode = mode
    if (this.controls) this.controls.enabled = mode === 'orbit'
    // 变焦只在机载取景下生效:进入时记下观察者视角的缩放,离开时归还,
    // 这样轨道视角的滚轮缩放不会被相机变焦覆盖
    if (this.camera && mode === 'fpv' && previous !== 'fpv') this.savedZoom = this.camera.zoom
    // 进机载视角时重置电子增稳状态,否则会从上一段视角的位姿慢慢滑过来
    if (mode === 'fpv') this.fpvQuatReady = false
    if (this.camera && mode !== 'fpv' && previous === 'fpv') {
      this.camera.zoom = this.savedZoom ?? 1
      this.camera.updateProjectionMatrix()
      this.savedZoom = null
    }
    if (mode === 'orbit') {
      // 回到观察者视角时保留当前朝向,只把控制点交还给轨道控制器
      this.cameraTarget.set(
        this.sim.position.x,
        this.groundOffsetY + this.sim.position.y,
        this.sim.position.z,
      )
      this.controls?.target.copy(this.cameraTarget)
    }
  }

  /** 当前是否为观察者(轨道控制)视角;非轨道模式下渲染循环不得调用 controls.update(),否则其每帧 lookAt(target) 会覆盖机载/跟随朝向 */
  get isOrbitView(): boolean {
    return this.cameraMode === 'orbit'
  }

  /** 直接把无人机移动到目标位置并同步观察点/朝向 */
  flyTo(target: { x?: number; y?: number; z?: number; heading?: number; pitch?: number; roll?: number }): void {
    const next = { ...this.sim.position }
    if (target.x !== undefined) next.x = target.x
    if (target.y !== undefined) next.y = Math.max(0, target.y)
    if (target.z !== undefined) next.z = target.z
    this.sim.position.x = next.x
    this.sim.position.y = next.y
    this.sim.position.z = next.z
    if (target.heading !== undefined) this.sim.heading = target.heading
    if (target.pitch !== undefined) this.sim.tiltPitch = clamp(target.pitch, -45, 45)
    if (target.roll !== undefined) this.sim.tiltRoll = clamp(target.roll, -45, 45)
    this.cameraTarget.set(this.sim.position.x, this.groundOffsetY + this.sim.position.y, this.sim.position.z)
    if (this.controls) {
      this.controls.target.copy(this.cameraTarget)
      this.controls.update()
    }
    this.syncPose(0)
  }

  /** 直接调整镜头/云台变焦倍数(1~4x),并同步当前机载视角 */
  zoomTo(zoom: number): void {
    this.sim.setZoom(zoom)
    if (this.camera && this.cameraMode !== 'orbit') {
      if (this.camera.zoom !== this.sim.cameraZoom) {
        this.camera.zoom = this.sim.cameraZoom
        this.camera.updateProjectionMatrix()
      }
    }
  }

  /**
   * 把相机摆到云台镜片位置并取云台朝向(机载视角与拍照共用):
   * 位置 = 云台挂点沿航向前移 offset,朝向 = 云台光轴(已被三轴解算锁水平)。
   *
   * offset 默认按模型实测:云台载荷(相机外壳)沿光轴的前端距离 + 余量。
   * 写死的小偏移只适配"外壳刚好在枢轴前一点点"的模型;换一个载荷更长的
   * 模型(如 dji_mini4_pro.glb,壳体前端在枢轴前 0.25m),相机会泡进外壳,
   * 画面正中变成一颗对着的镜头(看着相机而不是从相机往外看)。
   *
   * 位姿来源按 gimbalStabilization 分档:'full' 时位置与朝向都由飞控真值解算(不读骨骼链,
   * 与模型姿态完全解耦);'physical' 时采样骨骼链世界变换(镜头随机体侧倾横移,保留裸机真实感)。
   */
  private applyGimbalCameraPose(
    camera: THREE.PerspectiveCamera,
    options: {
      offset?: number
      zoom?: number
      delta?: number
      live?: boolean
      fixedCenter?: boolean
      instant?: boolean
    } = {},
  ): boolean {
    const rig = this.rig
    const ok = rig?.getGimbalCameraTransform(this.cameraScratch) ?? false
    if (!ok || !rig) return false
    this.cameraScratch.updateMatrixWorld(true)
    const clearance = rig.getGimbalCameraClearance()
    const offset =
      options.offset ??
      (clearance != null ? clearance + GIMBAL_CAMERA_CLEARANCE_MARGIN : GIMBAL_CAMERA_OFFSET)
    const stabilized = this.gimbalStabilization === 'full'
    // 取景俯仰:全景分层给了覆盖时用覆盖值(绝对值),否则沿用云台俯仰。
    // ⚠️ `live`(实时机载画面)**不吃覆盖**:覆盖只属于成片。否则全景扫描每拍一张,
    // 实时画面就被拽到那一层的俯仰再弹回来 —— 用户看到的就是"一闪一闪"(扫描时
    // 每张取景都会暂时改角度)。水平方向本来就不在这里做手脚(靠机体自转),俯仰同样只给成片。
    const overridePitch = options.live === true ? undefined : this.captureView?.pitch
    const viewPitch = overridePitch ?? this.sim.gimbalPitch
    const viewYaw = this.sim.gimbalYaw
    // 成片光心**固定在空间中一点**(机体自转轴正上方、云台挂点高度):
    // 拼接器的成立前提是"相机绕光心纯旋转"(见 drone-stitch 文件头)。而取景相机
    // 平时挂在机头、还沿光轴前移一米级 —— 机体原地自转一周,光心扫出一个大圆,
    // 对 1m 高的近地场景视差以"度"计,羽化平均直接把重叠区抹成糊(实测清晰度只剩 8.6%)。
    // 全景扫描(captureView 非 null)时把光心钉死,这一条假设就严格成立,拼出来才是锐的。
    const fixedCenter =
      options.fixedCenter === true &&
      stabilized &&
      this.captureView !== null &&
      rig.getGimbalCameraMount(this.captureCenter, 0, 0)
    const decoupled =
      !fixedCenter && stabilized && rig.getGimbalCameraMount(camera.position, offset, viewPitch)
    if (fixedCenter) {
      camera.position.set(this.sim.position.x, this.captureCenter.y, this.sim.position.z)
    } else if (!decoupled) {
      this.forwardVector.set(0, 0, -1).applyQuaternion(this.cameraScratch.quaternion).normalize()
      camera.position.copy(this.cameraScratch.position).addScaledVector(this.forwardVector, offset)
    }
    // 朝向:解耦档直接取"引擎解出的期望姿态"(不经骨骼链),否则沿用云台节点世界朝向
    const oriented =
      stabilized && rig.getGimbalCameraOrientation(this.fpvTargetQuat, viewPitch, 0, viewYaw)
    const source = oriented ? this.fpvTargetQuat : this.cameraScratch.quaternion
    // 可选电子增稳(对相机姿态做一阶低通,滤掉残余高频微抖)
    const delta = options.delta ?? 0
    const tau = this.fpvSmoothing * FPV_SMOOTH_TAU
    if (!options.instant && tau > 0 && delta > 0) {
      if (!this.fpvQuatReady) {
        this.fpvQuat.copy(source)
        this.fpvQuatReady = true
      } else {
        this.fpvQuat.slerp(source, 1 - Math.exp(-delta / tau))
      }
      camera.quaternion.copy(this.fpvQuat)
    } else {
      this.fpvQuat.copy(source)
      this.fpvQuatReady = true
      camera.quaternion.copy(source)
    }
    if (options.zoom !== undefined && Math.abs(camera.zoom - options.zoom) > 1e-3) {
      camera.zoom = options.zoom
      camera.updateProjectionMatrix()
    }
    return true
  }

  /**
   * 调云台增稳参数(机载视角稳定性调优入口)。
   *
   * ```ts
   * fly.configureGimbal({ stabilization: 'physical', response: 0.05, smoothing: 0 })
   * ```
   */
  configureGimbal(options: GimbalStabilizationOptions = {}): void {
    if (options.stabilization) this.gimbalStabilization = options.stabilization
    if (options.response !== undefined) {
      this.gimbalResponse = Math.max(0, options.response)
      if (this.rig) this.rig.gimbalResponse = this.gimbalResponse
    }
    if (options.smoothing !== undefined) this.fpvSmoothing = clamp(options.smoothing, 0, 1)
  }

  /**
   * 设置取景**俯仰**覆盖 —— 全景扫描(180° / 360°)按俯仰层逐张取景的入口;传 `null` 复位。
   *
   * ```ts
   * fly.setCaptureView({ pitch: -15 })   // 这一张按俯视 15° 取景(替代云台俯仰)
   * const shot = await fly.requestPhoto()
   * fly.setCaptureView(null)             // 复位
   * ```
   *
   * 语义:俯仰**替代**云台俯仰(绝对值)。只影响取景相机,机体、飞控与用户视角都不动 ——
   * 与"稳像 = 模型不动、相机侧解耦"同一套思路。
   *
   * ⚠️ **没有水平偏航**是有意的:水平方向靠 `spinBodyTo` 转机体,云台 Pan 机械行程
   * 转不出 180°(理由见 `drone-panorama` 文件头)。
   *
   * ⚠️ 俯仰覆盖依赖姿态解耦档(`gimbalStabilization === 'full'`,默认)。
   * `physical` 档的相机姿态采自骨骼链(保留裸机画弧),叠加不了绝对俯仰,此时覆盖不生效。
   * 采集侧(`drone-capture`)在每次取景后会自动复位,单独调用时记得自己收尾。
   */
  setCaptureView(override: CaptureViewOverride | null): void {
    this.captureView = override ?? null
  }

  /**
   * 让**机体原地自转**到绝对方位角 `headingDeg`(度,罗盘角);`null` 停止自转。
   *
   * 全景的水平网格走这条通道(见 `drone-panorama`):Mini 4 Pro 云台 Pan 只有 ±30°,
   * 180° 视野必须靠机体自己转。转的是机身、不是相机 —— 所以 FPV 画面里的世界会跟着转,
   * 而机体的 x/z 位置由定点保持锁住("原地"的含义)。
   */
  spinBodyTo(headingDeg: number | null): void {
    this.sim.spinTo(headingDeg)
  }

  /** 机体当前方位角(度,罗盘角)—— 全景扫描用它判断"转到位了没" */
  getBodyHeading(): number {
    return this.sim.heading
  }

  /** 记下当前相机位姿,供取景帧渲染完还原 */
  private snapshotCamera(): CameraRestore | null {
    const camera = this.camera
    if (!camera) return null
    return {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      zoom: camera.zoom,
    }
  }

  /** 把相机位姿还回去 —— 取景帧渲染完必须调用 */
  private restoreCamera(restore: CameraRestore): void {
    const camera = this.camera
    if (!camera) return
    camera.position.copy(restore.position)
    camera.quaternion.copy(restore.quaternion)
    if (Math.abs(camera.zoom - restore.zoom) > 1e-3) {
      camera.zoom = restore.zoom
      camera.updateProjectionMatrix()
    }
    camera.updateMatrixWorld(true)
  }

  /**
   * 取景帧渲染时的场景可见性:位置标记类辅助物 + **机体自身**都退场。
   *
   * 辅助物(返航点光柱 / 航点光柱 / 航迹 / 地面网格)不该出现在照片里,这批早就有;
   * 机体自身是全景**固定光心**带来的新问题 —— 光心钉在自转轴上以后,相机就在机体怀里,
   * 机壳 / 机臂 / 桨叶会进画面,再被多张重复拼进天底。真机全景同样拍不到自己,
   * 成片退场是干净的做法(实时画面不受影响:还原后那一帧渲的还是完整机体)。
   */
  private setCaptureFrameVisible(visible: boolean): void {
    this.world?.setCaptureHelpersVisible(visible)
    if (this.model) this.model.visible = visible
    // 雷达波束挂在场景上(不随 model 隐藏),单独摘;恢复时按用户开关的语义还原
    if (this.radar) this.radar.setVisible(visible ? this.radarBeamsVisible : false)
  }

  // ————————————————————————————— 录制帧 —————————————————————————————

  /**
   * 录制帧 —— 交给录制器的画面恒为云台取景,与用户此刻在哪个视角无关。
   *
   * 真机只有一个云台相机,录制内容就该是它拍的;而用户盯着的画面可能是观察者
   * 视角,两者不是一回事。做法是每帧走一遍**和拍照完全相同**的取景路径
   * (摆相机 → 渲染 → 同一任务内把这一帧搬进录制画布),再还原相机位姿。
   *
   * 录制流挂在独立的离屏画布上而不是主画布:主画布随后还要渲染用户视角,而画布
   * 捕获是按"绘制之后"抓帧的,直接抓主画布会把用户视角录进去。离屏画布的内容
   * 只有云台取景,污染不了。
   *
   * 由渲染循环调用(在 controls.update 之后、onBeforeRender 之前)。未录制时零开销。
   */
  captureRecordingFrame(): void {
    const track = this.captureTrack
    const context = this.recordContext
    const camera = this.camera
    const source = this.renderer?.domElement as HTMLCanvasElement | undefined
    if (!track || !context || !camera || !source || !this.renderer || !this.scene) return
    // 尺寸跟住主画布,窗口变化时录像不留黑边
    if (context.canvas.width !== source.width || context.canvas.height !== source.height) {
      context.canvas.width = source.width
      context.canvas.height = source.height
    }
    if (this.cameraMode === 'fpv') {
      // 相机此刻就在云台上(updateCamera 刚摆好):这一帧渲出来直接搬走
      this.setCaptureFrameVisible(false)
      this.renderer.render(this.scene, camera)
      this.setCaptureFrameVisible(true)
      context.drawImage(source, 0, 0)
      track.requestFrame()
      return
    }
    const restore = this.snapshotCamera()
    if (
      !this.applyGimbalCameraPose(camera, {
        zoom: this.sim.cameraZoom,
        delta: this.lastFrameDelta,
        live: true,
      })
    ) {
      // 云台还不可用(模型没载完):这一帧没有可录内容,下一帧再说
      return
    }
    camera.updateMatrixWorld(true)
    this.setCaptureFrameVisible(false)
    this.renderer.render(this.scene, camera)
    this.setCaptureFrameVisible(true)
    context.drawImage(source, 0, 0)
    track.requestFrame()
    if (restore) this.restoreCamera(restore)
  }

  // ————————————————————————————— 拍照 —————————————————————————————

  /**
   * 拍照:用云台相机取景拍一张 PNG。
   *
   * 实现是"渲染前换相机位姿 → 渲染后同一任务内拷屏":不依赖离屏渲染目标
   * (WebGPU/WebGL 后端行为一致),拷屏与渲染在同一个任务里完成,画面不会闪帧。
   * 上一张尚未取回时返回 null,避免连拍踩踏。
   */
  requestPhoto(): Promise<PhotoShot | null> {
    if (!this.renderer || !this.camera || !this.rig) return Promise.resolve(null)
    if (this.photoRequest) return Promise.resolve(null)
    return new Promise<PhotoShot | null>((resolve) => {
      const timer = window.setTimeout(() => {
        if (this.photoRequest) {
          this.photoRequest = null
          resolve(null)
        }
      }, PHOTO_TIMEOUT_MS)
      this.photoRequest = { resolve, timer, restore: null }
    })
  }

  /**
   * 取景相机(云台镜头)的位姿与内参快照 —— 虚拟影像采集用(见 drone-capture 的
   * `VirtualCaptureProvider`)。与 CesiumDroneAdapter.getCaptureCamera 同义。
   *
   * 三个要点:
   * - 记录的是**取景相机**,不是机身 —— 云台朝向可能与机体朝向差几十度;
   * - 位姿与拍照走**同一条取景路径**(`applyGimbalCameraPose`),只是渲到一台临时相机上,
   *   因此不触发渲染、不动主相机、也不影响用户当前视角;
   * - 坐标系换成库内约定的 `local-enu`(x 东 / y 北 / z 上):three 沙盒内部是
   *   x 东 / y 上 / z 南,由 ENU 基向量在 three 世界系里的朝向构成旋转再左乘即可。
   *
   * 模型 / 云台未就绪时返回 null(调用方据此跳过本次采集)。
   */
  getCaptureCamera(): CaptureCameraState | null {
    const rig = this.rig
    const camera = this.camera
    const renderer = this.renderer
    if (!rig || !camera || !renderer) return null
    const scratch = this.captureCamera
    // delta 传 0:取当前真值对应的期望位姿,不参与电子增稳的低通(那会引入一帧滞后)。
    // fixedCenter 与拍照帧同一开关:录进影像条目的光心 = 成片真正的光心(全景扫描时是固定点)
    if (
      !this.applyGimbalCameraPose(scratch, {
        zoom: this.sim.cameraZoom,
        delta: 0,
        fixedCenter: true,
      })
    )
      return null

    const canvas = renderer.domElement as HTMLCanvasElement
    const width = canvas.width
    const height = canvas.height
    if (!width || !height) return null

    // 内参:成片用的是渲染相机的投影参数 + 取景时套上的数字变焦
    const zoom = this.sim.cameraZoom > 0 ? this.sim.cameraZoom : 1
    const fovY = 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) / zoom)
    const fy = height / 2 / Math.tan(fovY / 2)
    const fx = fy // 像素正方
    const fovX = 2 * Math.atan(width / (2 * fx))

    // 位姿:three 世界系 → local-enu。ENU 基向量在世界系里是
    // 东 (1,0,0) / 北 (0,0,-1) / 上 (0,1,0),三者的旋转矩阵的逆把世界向量换进 ENU。
    const enuFromWorld = new THREE.Quaternion()
      .setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(0, 0, -1),
          new THREE.Vector3(0, 1, 0),
        ),
      )
      .invert()
    const rotation = scratch.quaternion.clone().premultiply(enuFromWorld)

    const sim = this.sim
    const toEnu = (x: number, y: number, z: number): [number, number, number] => [x, -z, y]
    const degrees = (radians: number): number => (radians * 180) / Math.PI

    return {
      pose: {
        position: toEnu(scratch.position.x, scratch.position.y, scratch.position.z),
        rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
        coordinateFrame: 'local-enu',
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
        position: toEnu(sim.position.x, sim.position.y, sim.position.z),
        heading: sim.heading,
        tiltPitch: sim.tiltPitch,
        tiltRoll: sim.tiltRoll,
        gimbalPitch: sim.gimbalPitch,
        gimbalYaw: sim.gimbalYaw,
      },
    }
  }

  /** 渲染前钩子(渲染循环在 controls.update 之后、render 之前调用):本帧按云台相机取景 */
  onBeforeRender(): void {
    const request = this.photoRequest
    const camera = this.camera
    if (!request || !camera) return
    // 先记下当前位姿:取景帧渲染完立刻还原,轨道视角不会被拽到云台位置
    request.restore = this.snapshotCamera()
    // 返航点光柱 / 航迹是给用户看的位置标记,不该出现在照片里(机腹正下方的
    // 3m 光柱离镜头只有几厘米,每一张都会带一根竖线,全景拼接后逐列复制)
    this.setCaptureFrameVisible(false)
    this.applyGimbalCameraPose(camera, {
      zoom: this.sim.cameraZoom,
      delta: this.lastFrameDelta,
      fixedCenter: true,
      // 静态照片必须使用元数据记录的精确姿态,不能沿用实时画面 / 录像的平滑过渡。
      instant: true,
    })
    camera.updateMatrixWorld(true)
  }

  /** 渲染后钩子:与渲染同一任务内拷屏,然后把相机位姿还原 */
  onAfterRender(): void {
    const request = this.photoRequest
    if (!request) return
    this.photoRequest = null
    window.clearTimeout(request.timer)
    const shot = this.grabCanvas()
    // 成片才计数:sim.takePhoto 负责 photoCount +1 与事件日志(实际成像由引擎层负责,见其注释)
    if (shot) this.sim.takePhoto()
    if (request.restore) this.restoreCamera(request.restore)
    this.setCaptureFrameVisible(true)
    // 补渲一帧用户视角:刚才那一帧画布上留的是云台取景,直接把还原后的位姿渲回去,
    // 观察者 / 跟随视角就不会"闪"一帧云台画面(Cesium 侧同款修法)。
    // 走裸 render 不经宿主后期管线 —— 与录像路径同一已知差异,仅此一帧。
    if (this.scene && this.renderer && this.camera) {
      this.renderer.render(this.scene, this.camera)
    }
    request.resolve(shot)
  }

  /** 把当前画布内容拷进离屏 canvas(同一任务内执行,拿到的是刚渲染的那一帧) */
  private grabCanvas(): PhotoShot | null {
    const source = this.renderer?.domElement as HTMLCanvasElement | undefined
    if (!source || !source.width || !source.height) return null
    const target = document.createElement('canvas')
    target.width = source.width
    target.height = source.height
    const context = target.getContext('2d')
    if (!context) return null
    context.drawImage(source, 0, 0)
    return { dataUrl: target.toDataURL('image/png'), width: target.width, height: target.height }
  }

  // ————————————————————————————— 录像 —————————————————————————————

  /** 当前是否正在屏录(以 MediaRecorder 实例是否存在为准) */
  get isRecording(): boolean {
    return this.recorder !== null
  }

  /** 开始屏录(录云台取景,与用户当前视角无关)。返回 false = 当前环境不支持 */
  startRecording(): boolean {
    if (this.recorder) return true
    const canvas = this.renderer?.domElement as HTMLCanvasElement | undefined
    if (
      !canvas ||
      typeof MediaRecorder === 'undefined' ||
      typeof canvas.captureStream !== 'function'
    )
      return false
    // 录制源用独立离屏画布:每帧只往里搬一帧云台取景,主画布上用户视角的渲染
    // 永远不会污染录制流(画布捕获按"绘制之后"抓帧,直接抓主画布会录到用户视角)。
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
      const mime = pickRecordMime()
      recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: RECORD_BITRATE })
        : new MediaRecorder(stream)
    } catch {
      this.captureTrack = null
      return false
    }
    this.recordContext = recordContext
    this.recordChunks = []
    this.recordStream = stream
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
    if (!recorder) {
      this.sim.setRecordingState(false)
      return Promise.resolve(null)
    }
    this.recorder = null
    const seconds = this.sim.recordSeconds
    this.sim.setRecordingState(false)
    return new Promise<Blob | null>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        const chunks = this.recordChunks
        this.recordChunks = []
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

  /** 按当前相机模式摆放相机:机载=云台位姿,跟随=平滑尾随,观察者=交给轨道控制器 */
  private updateCamera(delta: number): void {
    const camera = this.camera
    if (!camera) return
    const sim = this.sim
    const dronePosition = this.dronePosition.set(
      sim.position.x,
      this.groundOffsetY + sim.position.y,
      sim.position.z,
    )

    if (this.cameraMode === 'fpv') {
      // 相机位姿 = 云台光轴(含变焦);取景逻辑与拍照共用同一套。
      // live: 实时画面不吃"取景俯仰覆盖"(那属于成片),否则全景扫描时机载视角每拍一帧闪一下
      this.applyGimbalCameraPose(camera, { zoom: this.sim.cameraZoom, delta, live: true })
      return
    }

    if (this.cameraMode === 'follow') {
      const rad = (sim.heading * Math.PI) / 180
      this.forwardVector.set(Math.sin(rad), 0, -Math.cos(rad))
      this.followPosition.copy(dronePosition).addScaledVector(this.forwardVector, -FOLLOW_DISTANCE)
      this.followPosition.y += FOLLOW_HEIGHT
      camera.position.lerp(this.followPosition, Math.min(1, delta * 4))
      this.followLookAt.copy(dronePosition)
      this.followLookAt.y += 0.6
      camera.lookAt(this.followLookAt)
      return
    }

    // 观察者:轨道控制器接管,但控制点平滑跟住飞机,避免飞出视野后找不回来
    if (this.cameraAutoFollow) {
      this.cameraTarget.lerp(dronePosition, Math.min(1, delta * 2.2))
      if (this.controls) {
        this.cameraShift.subVectors(this.cameraTarget, this.controls.target)
        this.controls.target.add(this.cameraShift)
        camera.position.add(this.cameraShift)
      }
    } else if (this.controls) {
      // 框住航线 / 场景编辑期间不跟飞机:否则刚摆好的画面会被"跟到飞机"慢慢拖走
      this.cameraTarget.copy(this.controls.target)
    }
  }

  /** 复位相机:回到观察者视角、还原缩放,并把机位重置到飞机斜后上方 */
  resetCamera(): void {
    if (!this.camera || !this.controls) return
    this.setCameraMode('orbit')
    this.cameraAutoFollow = true
    if (this.camera.zoom !== 1) {
      this.camera.zoom = 1
      this.camera.updateProjectionMatrix()
    }
    const dronePosition = new THREE.Vector3(
      this.sim.position.x,
      this.groundOffsetY + this.sim.position.y,
      this.sim.position.z,
    )
    this.camera.position.set(dronePosition.x + 6, dronePosition.y + 3.5, dronePosition.z + 7)
    this.controls.target.copy(dronePosition)
    this.cameraTarget.copy(dronePosition)
  }

  /**
   * 把观察者相机拉到"一眼看全整条航线"的位置(编辑航线前先框住航线)。
   *
   * 航点动辄 30~40 米高、水平铺开几十米,默认机位贴着飞机,根本看不到航线 ——
   * 所以框住一次比让用户自己滚轮找半天更实际。按包围球的垂直/水平视场双向取距离,
   * 保证竖着铺开的航线也不会被裁掉。
   */
  frameMission(): boolean {
    const camera = this.camera
    const controls = this.controls
    if (!camera || !controls) return false
    const home = this.sim.homePosition
    const first = this.sim.mission[0]
    let minX = home.x
    let maxX = home.x
    let minY = first ? Math.max(1, first.altitude) : DRONE_SPEC.takeoffAltitude
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

    const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)
    center.y += this.groundOffsetY
    const radius = Math.max(12, 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ))
    const halfVertical = THREE.MathUtils.degToRad(camera.fov / 2)
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * Math.max(0.2, camera.aspect))
    const distance =
      Math.max(radius / Math.tan(halfVertical), radius / Math.tan(halfHorizontal)) * 1.35

    this.setCameraMode('orbit')
    // 关掉"控制点跟飞机":否则摆好的画面会在几秒内被拖回飞机身上
    this.cameraAutoFollow = false
    if (camera.zoom !== 1) {
      camera.zoom = 1
      camera.updateProjectionMatrix()
    }
    const direction = new THREE.Vector3(-0.42, 0.55, 0.72).normalize()
    camera.position.copy(center).addScaledVector(direction, distance)
    controls.target.copy(center)
    this.cameraTarget.copy(center)
    camera.lookAt(center)
    camera.updateMatrixWorld(true)
    controls.update()
    return true
  }

  // ————————————————————————————— 飞行控制 —————————————————————————————

  /** 当前飞行阶段(真值取 sim.phase):未上电 / 自检 / 待机 / 电机已启动 / 飞行中 / 返航 / 降落… */
  get phase(): FlightPhase {
    return this.sim.phase
  }

  /** 是否已离地(离地 5cm 以上且已上电) */
  get airborne(): boolean {
    return this.sim.airborne
  }

  /** 当前飞行模式:Cine / Normal / Sport */
  get flightMode(): FlightMode {
    return this.sim.mode
  }

  /** 当前高度(米,相对起飞点) */
  get altitude(): number {
    return this.sim.position.y
  }

  /** 起飞前检查清单(含宿主注入的外部项);面板据此提示"还差什么才能起飞" */
  get preflightChecks(): ChecklistItem[] {
    return this.sim.checklist
  }

  /** 上电:自检 → 预热 → 待机(仅未上电 / 已停桨时受理) */
  powerOn(): void {
    this.sim.powerOn()
  }

  /** 一键起飞:地面待机时自动启动电机,再爬升到 1.2 米;返回是否受理 */
  takeOff(): boolean {
    return this.sim.autoTakeOff()
  }

  /** 自动降落(会先中止正在执行的航线);返回是否受理 */
  land(): boolean {
    return this.sim.startLanding()
  }

  /** 智能返航(需在空中,会先中止航线);返回是否受理 */
  returnHome(reason = '用户触发返航'): boolean {
    return this.sim.startRth(reason)
  }

  // ————————————————————————————— 操作透传 —————————————————————————————

  /** 写摇杆连续量(摇杆优先于键盘;松杆由飞控刹停悬停) */
  setStick(stick: Partial<StickState>): void {
    this.sim.setStick(stick)
  }

  /** 摇杆立刻回中(等同松开遥控器杆) */
  resetStick(): void {
    this.sim.setStick({ ...NEUTRAL_STICK })
  }

  /** 键盘 / 方向键输入直接映射成摇杆行程(美国手 Mode 2) */
  setMoveDirection(direction: DroneDirection | null): void {
    this.sim.setStick({
      pitch: direction === 'up' ? 1 : direction === 'down' ? -1 : 0,
      roll: direction === 'right' ? 1 : direction === 'left' ? -1 : 0,
    })
  }

  /** 设垂直方向指令 -1(降)~0(保持)~1(升),面板/键盘写入 */
  setVerticalDirection(direction: DroneVerticalDirection | null): void {
    this.sim.setStick({ throttle: direction === 'up' ? 1 : direction === 'down' ? -1 : 0 })
  }

  /** 设偏航指令 -1(左转)~0~1(右转) */
  setRotationDirection(direction: DroneRotationDirection | null): void {
    this.sim.setStick({ yaw: direction === 'right' ? 1 : direction === 'left' ? -1 : 0 })
  }

  /** 切飞行挡位:平稳 C / 普通 N / 运动 S */
  setMode(mode: FlightMode): void {
    this.sim.setMode(mode)
  }

  /** 改仿真配置(限速/风/电量阈值等,立即生效) */
  setConfig(patch: Partial<SimConfig>): void {
    this.sim.config = { ...this.sim.config, ...patch }
  }

  /** 注入/清除故障标志(测失效保护用) */
  setFaults(patch: Partial<FaultFlags>): void {
    this.sim.faults = { ...this.sim.faults, ...patch }
  }

  /** 设机臂折叠目标 0(展开)~1(收纳),桨叶同步收拢 */
  setArmFoldTarget(fold: number): void {
    this.armFoldTarget = fold > 0.5 ? 1 : 0
  }

  /** 当前机臂折叠量 0~1(插值中的实时值) */
  get armFoldTargetValue(): number {
    return this.armFoldTarget
  }

  /**
   * 展开 / 收拢机臂。
   *
   * 折叠量的取值是**反的**(0 = 完全展开,1 = 完全收纳,见 DroneRig),这里包一层语义化接口,
   * 免得调用方每次都要在脑子里翻转一次。飞行中收拢会被机臂检查项拦下(与真机一致)。
   */
  setArmsFolded(folded: boolean): void {
    this.setArmFoldTarget(folded ? 1 : 0)
  }

  /** 机臂当前是否处于"已收拢"的目标状态(展开 = false) */
  get armsFolded(): boolean {
    return this.armFoldTargetValue > 0.5
  }

  /**
   * 起落架腿当前是否放下(收起 = false)。
   * 收放由飞行高度自动驱动(高于 LEG_RETRACT_ALTITUDE 收、低于放),
   * 只有带 LEG_* 节点的机体(哈士奇)有腿,真机 GLB 恒为 true。
   */
  get legsDeployed(): boolean {
    return (this.rig?.legDeploy ?? 1) > 0.5
  }

  /** 设云台俯仰角(度,范围见 DRONE_SPEC) */
  setGimbalPitch(pitch: number): void {
    this.sim.setGimbalPitch(pitch)
  }

  /** 云台增量微调(度;俯仰/偏航分别给) */
  nudgeGimbal(deltaPitch: number, deltaYaw = 0): void {
    this.sim.nudgeGimbal(deltaPitch, deltaYaw)
  }

  /** 清空飞行航迹 */
  clearTrail(): void {
    this.world?.clearTrail()
  }

  // ————————————————————————————— 航线任务 —————————————————————————————

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

  /** 下发航点列表(执行中会被拒绝,与真机"上传后不可改"一致) */
  setMission(waypoints: Array<Partial<MissionWaypoint>>): boolean {
    return this.sim.setMission(waypoints)
  }

  /** 改航线参数(高度/速度/航向模式等,下一次起飞生效) */
  setMissionConfig(patch: Partial<MissionConfig>): void {
    this.sim.setMissionConfig(patch)
  }

  /** 航线参数恢复默认 */
  resetMissionToDefault(): void {
    this.sim.resetMissionToDefault()
  }

  /** 取航线只读快照(航点/Home/进度) */
  getMissionSnapshot(): MissionSnapshot {
    return this.sim.snapshot().mission
  }

  /**
   * 把当前航线整理成可序列化的导出数据(只读,随时可调,执行中也行)。
   *
   * 序列化实现已下沉到 drone-sim(纯逻辑层),Cesium 后端复用同一函数;
   * 航程按"返航点起飞 → 依次过点"的三维折线累计,耗时按每点自己的速度(0 = 巡航速度)
   * 加上到点悬停折算,和引擎执行时的口径一致。
   */
  getMissionExport(): MissionExport {
    return buildMissionExport(
      this.sim.mission.map((waypoint) => ({ ...waypoint })),
      { ...this.sim.missionConfig },
      this.sim.homePosition,
    )
  }

  /**
   * 导出航线文本。`json` 是完整存档(含坐标约定、任务参数、概览统计,可再喂回 `setMission`),
   * `csv` 只出航点表 —— 表头中文、CRLF 换行,Excel / WPS 双击即可打开。
   */
  exportMission(format: MissionExportFormat = 'json'): string {
    return exportMissionText(this.getMissionExport(), format)
  }

  /** 航点标记 / 航线折线的总显隐(不影响任务执行) */
  setMissionVisible(visible: boolean): void {
    this.missionVisible = visible
    this.world?.setMissionVisible(visible)
  }

  /** 航线是否可见 */
  isMissionVisible(): boolean {
    return this.world?.isMissionVisible() ?? this.missionVisible
  }

  /** 只开关航点标记 */
  setMissionWaypointsVisible(visible: boolean): void {
    this.missionMarkersVisible = visible
    this.world?.setMissionWaypointsVisible(visible)
  }

  /** 航线航点标记是否可见 */
  isMissionWaypointsVisible(): boolean {
    return this.world?.isMissionWaypointsVisible() ?? this.missionMarkersVisible
  }

  /** 只开关航线折线 */
  setMissionPathVisible(visible: boolean): void {
    this.missionPathVisible = visible
    this.world?.setMissionPathVisible(visible)
  }

  /** 航线路径线是否可见 */
  isMissionPathVisible(): boolean {
    return this.world?.isMissionPathVisible() ?? this.missionPathVisible
  }

  /** three 后端是本地米坐标系,没有地理坐标;经纬度切换开关因此不显示 */
  supportsGeoCoordinates(): boolean {
    return false
  }

  /** three 后端无经纬高:返回 null(面板始终走 XYZ 显示) */
  getWaypointGeo(_index: number): { lon: number; lat: number; height: number } | null {
    return null
  }

  /** three 后端是本地米坐标系,无地理锚点,经纬度编辑不可用;接口占位返回 false */
  setWaypointGeo(_index: number, _geo: { lon: number; lat: number; height: number }): boolean {
    return false
  }

  // ————————————————————————————— 场景内航点编辑 —————————————————————————————

  /** 航点标记 / 航线折线的重建签名(只跟返航点与航点位置有关) */
  private buildMissionSignature(): string {
    const home = this.sim.homePosition
    return `${home.x}|${home.z}#${this.sim.mission
      .map((waypoint) => `${waypoint.x}|${waypoint.z}|${waypoint.altitude}`)
      .join(';')}`
  }

  /** 场景编辑的硬门槛:观察者视角 + 航线未在执行(含"已下发等待起飞到位") */
  private canMissionSceneEdit(): boolean {
    return this.isOrbitView && this.sim.missionStatus === 'idle' && !this.sim.missionPendingStart
  }

  /** 开关「场景内编辑航点」 */
  setMissionEditEnabled(enabled: boolean): void {
    this.missionEditEnabled = enabled
    this.missionEditor?.setEnabled(enabled)
    if (!enabled) {
      this.setMissionSelected(-1)
    } else if (!this.canMissionSceneEdit()) {
      this.sim.pushEvent('warn', '场景编辑需要先切到观察者视角,且航线未在执行')
    } else if (this.sim.mission.length > 0) {
      // 默认机位贴着飞机,航点全在画面外 —— 开编辑时先把整条航线框进画面
      this.frameMission()
    }
  }

  /** 航线编辑模式是否开启 */
  isMissionEditEnabled(): boolean {
    return this.missionEditEnabled
  }

  /** 场景编辑:选中某个航点(-1 取消选中) */
  setMissionSelected(index: number): void {
    this.missionEditSelected = index
    this.world?.setMissionSelection(index)
  }

  /** 当前选中的航点索引(无选中返回 null) */
  getMissionSelected(): number {
    return this.missionEditSelected
  }

  /** 场景编辑的实时状态(界面 100ms 轮询) */
  getMissionEditState(): MissionEditState {
    const editor = this.missionEditor
    if (!editor) {
      return {
        enabled: this.missionEditEnabled,
        active: false,
        selectedIndex: this.missionEditSelected,
        hoverIndex: -1,
        dragging: false,
        mode: null,
      }
    }
    const state = editor.getState()
    // 选中态以装配层为准(编辑器只是读)
    return { ...state, selectedIndex: this.missionEditSelected }
  }

  /**
   * 原位更新一个航点(场景拖拽每帧调用):改内核 + 只挪这一根三维标记。
   *
   * 关键在于同步刷新签名 —— 否则下一帧 syncPose 发现"签名变了"会把整层标记重建一遍,
   * 拖动时就会一顿一顿地闪。
   */
  updateMissionWaypoint(index: number, patch: Partial<MissionWaypoint>): MissionWaypoint | null {
    const applied = this.sim.updateMissionWaypoint(index, patch)
    if (!applied) return null
    this.world?.updateMissionWaypoint(index, {
      x: applied.x,
      z: applied.z,
      altitude: applied.altitude,
    })
    this.missionSignature = this.buildMissionSignature()
    return applied
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
  private newWaypointTemplate(index: number): Partial<MissionWaypoint> {
    const list = this.sim.mission
    const neighbour = list[Math.min(index, list.length - 1)] ?? list[list.length - 1]
    return {
      altitude: neighbour?.altitude ?? 30,
      speed: neighbour?.speed ?? this.sim.missionConfig.autoSpeed,
      hoverSeconds: neighbour?.hoverSeconds ?? 0,
    }
  }

  /** 取机体机械位姿报告(机臂折叠/桨叶角/云台角/起落架,调试用) */
  getRigReport(): RigPartReport[] {
    return this.rig?.parts ?? []
  }

  /** 取全量真值快照(位置/姿态/电池/云台/任务…,面板与 MCP 都用它) */
  getSnapshot(): DroneSnapshot {
    return this.sim.snapshot()
  }

  /** 取灯光真值快照(各灯模式/亮度/当前色) */
  getLightsSnapshot() {
    return this.lights?.getSnapshot() ?? null
  }

  /** 兼容旧接口:直接返回仿真遥测 */
  getTelemetry() {
    return {
      speedMetersPerSecond: Math.hypot(this.sim.velocity.x, this.sim.velocity.z),
      altitudeMeters: this.sim.position.y,
      isFlying: this.sim.airborne,
    }
  }

  // —— 灯光手动覆盖(面板调试用) ——

  /** 设状态灯灯语(覆盖默认模式,如 breathing / blink) */
  setStatusLightPattern(key: StatusLightKey): void {
    this.lightOverride = key
    this.lights?.setStatusPattern(key)
  }

  /** 清除状态灯覆盖,回到按状态自动的灯语 */
  clearStatusLightOverride(): void {
    this.lightOverride = null
    this.lights?.setStatusPattern(statusPatternFor(this.sim))
  }

  /** 当前状态灯覆盖(无覆盖返回 null) */
  get statusLightOverride(): StatusLightKey | null {
    return this.lightOverride
  }

  /** 设电池灯模式(off / level / blink) */
  setBatteryLightMode(mode: BatteryLightMode): void {
    this.lights?.setBatteryMode(mode)
  }

  /** 设电池灯亮度 0~1 */
  setBatteryLightLevel(levelPercent: number): void {
    this.sim.forceBatteryLevel(levelPercent)
    this.lights?.setBatteryLevel(levelPercent)
  }

  /** 设补光灯模式(off / on / auto) */
  setAuxLightMode(mode: AuxLightMode): void {
    this.lights?.setAuxLightMode(mode)
  }

  /** 销毁飞行沙盒:停渲染循环、拆面板、释放场景与渲染器 */
  destroy(): void {
    this.destroyed = true
    // 录制中直接收摊(页面卸载不触发下载)
    if (this.recorder) {
      try {
        this.recorder.stop()
      } catch {
        /* 已停止 */
      }
      this.recorder = null
    }
    this.recordStream?.getTracks().forEach((track) => track.stop())
    this.recordStream = null
    this.captureTrack = null
    this.recordContext = null
    this.recordChunks = []
    this.onRecordingReady = null
    this.missionEditor?.destroy()
    this.missionEditor = null
    this.rig?.destroy()
    this.rig = null
    this.lights?.destroy()
    this.lights = null
    this.world?.destroy()
    this.world = null
    this.radar?.destroy()
    this.radar = null
    if (this.model) {
      this.disposeModel(this.model)
      this.scene?.remove(this.model)
    }
    this.model = null
  }

  private normalizeModel(model: THREE.Group): void {
    const initialBounds = new THREE.Box3().setFromObject(model)
    const size = initialBounds.getSize(new THREE.Vector3())
    const largestDimension = Math.max(size.x, size.y, size.z)
    if (largestDimension > 0) model.scale.setScalar(DRONE_SIZE_METERS / largestDimension)

    const bounds = new THREE.Box3().setFromObject(model)
    const center = bounds.getCenter(new THREE.Vector3())
    model.position.x -= center.x
    model.position.z -= center.z
    model.position.y -= bounds.min.y
  }

  private disposeModel(model: THREE.Group): void {
    model.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry.dispose()
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      materials.forEach((material) => material.dispose())
    })
  }
}

// statusPatternFor(灯语与飞行状态的映射)已搬到 drone-lights.ts:它是纯逻辑(只读 DroneSim),
// 不依赖 three,搬过去之后 Cesium 侧机体表现层就能直接复用,不必 import 整个 three 装配层。
// 这里原样再导出,`@/lib` 的既有 API 与导入路径完全不变。
export { statusPatternFor }
