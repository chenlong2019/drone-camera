import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import {
  CAPTURE_BUNDLE_MIME,
  CaptureService,
  DEFAULT_OBSTACLES,
  DroneCapturePanel,
  DroneControlPanel,
  DroneMiniMap,
  DronePanoramaViewer,
  DroneSplatViewer,
  FlightSourceManager,
  MissionPanel,
  ReconstructionCapture,
  VIDEO_LINK_DEFAULT_PORT,
  VideoDownlink,
  buildCaptureBundle,
  captureBundleFileName,
  capturePosesToCloud,
  createDroneControl,
  createReconstructionSample,
  planReconCapture,
} from '@/lib'
import type {
  CaptureBundleResult,
  DroneFly,
  FlightSourceKind,
  FlightSourceState,
  MavlinkLinkStatus,
  ReconCaptureResult,
  SplatCloud,
  VideoLinkState,
} from '@/lib'
import { PMREMGenerator as WGPUPMREMGenerator, PostProcessing, WebGPURenderer } from 'three/webgpu'
import { PMREMGenerator as WebGLPMREMGenerator } from 'three'
import { rendererKindOf, type DroneRendererKind, type DroneRendererLike } from '@/lib/drone-camera/drone-renderer'
import { pass } from 'three/tsl'
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js'
import { DemoScenery } from './demo-scenery'
import { BayScenery, type BayTimeOfDay } from './bay/bay-scenery'
import { sunDirectionFor } from './bay/bay-sky'
import { assetUrl } from '@/utils/asset-url'

/** 真机 GLB 路径(需自行放到 public/models 下);不给这个 URL 即用库内置哈士奇机体 */
const GLB_MODEL_URL = assetUrl('models/dji_mini4_pro.glb')

/**
 * 户外 HDRI 环境图(Poly Haven,CC0)。清晨低角度太阳,暖色直射 + 冷色天空漫射,
 * 一次性给出真实场景缺的三件事:天空背景、天空漫射光、地面反弹光。
 *
 * 为什么不用 RoomEnvironment:那是「白色影棚」,给金属机体做中性反射是对的,
 * 但户外场景的天空方向、色温、地平线全是假的,材质再对也像塑料。这里只在加载失败时兜底。
 * `?hdri=0` 可退回旧的中性环境,便于对比。
 */
const HDRI_URL = assetUrl('hdri/spruit_sunrise_2k.hdr')

/**
 * 太阳方位:由 HDRI 最亮区域实测反推(tmp-shots/find-sun-page.mjs)——
 * 方位角 36.6° / 仰角 8.4°,清晨低角度太阳。
 *
 * ⚠️ 方向光的方位必须与背景天空里的太阳严格一致:阴影方向和天空光是观众
 * 无意识校对的两件事,一旦矛盾就是最典型的「一眼假」。
 * 仰角只有 8.4°,阴影会拉到楼高的 6~7 倍 —— 这正是黄金时刻的视觉特征。
 */
const SUN_POSITION = { x: 80, y: 15, z: 59 }

/**
 * 泛光(bloom)参数 —— 「灯光透亮感」的来源:过曝亮核在屏幕上溢出柔和光晕。
 * threshold 是**线性空间亮度**,实测标定在 2.5:
 *   - 灯珠亮核:径向梯度中心增益后红核线性亮度 ≈3+ → 参与泛光(阈值扫描 1.0~2.5 光晕都在);
 *   - 阳光照亮的白色壳体/机臂高光:线性亮度 ~1.2~2 → 阈值 1.6 时机臂根部出现白斑,
 *     2.5 档完全干净。绿灯核亮度更高,不受影响。
 * ⚠️ 与 drone-lights 的梯度中心增益(5.0)耦合:灯核 HDR 必须高于 threshold 才会泛光,
 * 调整任一侧后需重新跑 tmp-shots/verify-bloom-thr.mjs 标定。
 */
const BLOOM_STRENGTH = 0.8
const BLOOM_RADIUS = 0.5
const BLOOM_THRESHOLD = 2.5

/** 机体来源:husky = 库内置「机械哈士奇」机体(零资产);glb = 真机模型 */
export type BodyKind = 'husky' | 'glb'

/**
 * 页面按钮需要的飞控源快照 —— 直接用库里的 `FlightSourceState`。
 * 切换本身由 `FlightSourceManager` 负责(内含失败回退),demo 只负责显示。
 */
export type FlightSourceInfo = FlightSourceState


export class UseThreeDemo {
  private container: HTMLElement
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private renderer: DroneRendererLike | null = null
  /** 实际渲染后端(由实例判别):'webgpu' | 'webgl' */
  private rendererKind: DroneRendererKind = 'webgpu'
  /** 后期管线:场景色 + 泛光。走它渲染才有效果,直接 renderer.render 会绕过 bloom */
  private postProcessing: PostProcessing | null = null
  /** bloom 节点(暴露给调试脚本运行时调 strength/threshold) */
  private bloomPass: ReturnType<typeof bloom> | null = null
  private controls: OrbitControls | null = null
  private animateId: number | null = null
  /** 太阳方向光(阴影来源)。方位需与 HDRI 里的太阳一致,见 applyHdriEnvironment */
  private dirLight: THREE.DirectionalLight | null = null
  /** 场景时段(白天/黄昏/夜晚);仅海湾布景响应,城市/无布景只吃到灯光变化 */
  private dayPhase: BayTimeOfDay = 'day'
  /** HDRI 贴图(同时用作背景与环境光),销毁时要显式释放 */
  private hdriTexture: THREE.Texture | null = null
  /**
   * demo 侧的布景层 —— 纯 three,不进库。两种实现同角色、可互换:
   *   - BayScenery(默认):firstapp「海湾竞速」的静态部分(天空 + 海面 + 跨海大桥);
   *   - DemoScenery(?scenery=city):程序化城市/树林/远山。
   * 两者都只往场景里加可看的东西,并把参与避障的 AABB 交给 demo 写进 sim.obstacles。
   */
  private scenery: DemoScenery | BayScenery | null = null
  /** 上一帧时间戳:布景动画(波浪/云)按真实 dt 推进 */
  private lastSceneryTime = 0
  droneFly?: DroneFly
  /**
   * 飞控源切换器:内置模型 ⇄ 外部 MAVLink(PX4 / SITL)。
   *
   * 它把「建/拆会话 + 切换失败回退 + 状态上报」收在一处,两个 demo(Cesium / three)
   * 与使用方项目共用同一套语义。接管点是 `sim`,所以面板与后端全程无感。
   */
  private sources: FlightSourceManager | null = null
  /** 飞控源变化回调(页面按钮刷新文案与灯色) */
  onFlightSourceChange: ((info: FlightSourceInfo) => void) | null = null

  /** 当前飞控源(只读;切换请用 setFlightSource) */
  get flightSource(): FlightSourceKind {
    return this.sources?.kind ?? 'internal'
  }

  /** 最近一次链路状态;验证脚本据此断言"连上了" */
  get mavlinkStatus(): MavlinkLinkStatus | null {
    return this.sources?.linkStatus ?? null
  }

  /** 上次使用的外部源地址(切回外部时复用) */
  get mavlinkUrl(): string | null {
    return this.sources?.mavlinkUrl ?? null
  }

  // ─────────────────────────────── 图传(视频同传) ───────────────────────────────

  /**
   * 图传发布端:云台取景 → JPEG → 局域网中转(`video-link/relay.mjs`),
   * 手机或另一台电脑打开 `http://<本机 IP>:8130/` 就能实时看。
   *
   * 与平台无关的推流逻辑在库里(`VideoDownlink`),demo 只负责"按 15 fps 向引擎要帧"
   * 和"把 OSD 拼出来"。
   */
  private videoLink: VideoDownlink | null = null
  /** 图传状态回调(页面 chip 与浮层据此刷新) */
  onVideoLinkChange: ((state: VideoLinkState) => void) | null = null
  /** 上一次向引擎要帧的时刻:引擎内部也限帧,这里再挡一层,免得每 rAF 造一个 Promise */
  private lastVideoFrameRequestAt = 0
  /** OSD 推送节流(2.5 Hz,与真机 OSD 刷新节奏同量级) */
  private lastVideoOsdAt = 0
  /**
   * 图传画面来源:
   * - `'view'` 取当前画面(默认,零额外渲染;切到机载视角时传的就是云台画面)
   * - `'gimbal'` 每帧多渲一次云台取景(语义最像真机图传,吃 GPU)
   */
  private videoFrameSource: 'view' | 'gimbal' = 'view'

  /** 上电待机后已补过一轮预热(展开态渲染变体);关机会复位,下次上电再补 */
  private prewarmedStandby = false

  /** 桥面装饰(GLB 异步)就绪后已补过一轮预热 */
  private decorPrewarmDone = false
  /**
   * 图传传输方式。两条通道是并行的,`'webrtc'` 时 M-JPEG 降为 3 fps 保底:
   * 观看端先看到 JPEG 兜底画面,WebRTC 连通后自动切换 —— 任何一环失败都不黑屏。
   */
  private videoTransportMode: 'mjpeg' | 'webrtc' = 'mjpeg'
  /** WebRTC 活跃时 M-JPEG 的保底帧率(双流并存的带宽折中) */
  private videoMjpegFps = 15

  /** 当前图传画面来源 */
  get videoSource(): 'view' | 'gimbal' {
    return this.videoFrameSource
  }

  /** 切换画面来源:下一帧生效(不需要重连) */
  setVideoSource(source: 'view' | 'gimbal'): void {
    this.videoFrameSource = source
    this.onVideoLinkChange?.(this.videoLinkState)
  }

  /** 图传状态快照(未开启时给一份 idle) */
  get videoLinkState(): VideoLinkState {
    return (
      this.videoLink?.snapshot ?? {
        status: 'idle',
        url: null,
        viewers: 0,
        fps: 0,
        kbps: 0,
        sentFrames: 0,
        droppedFrames: 0,
        watchUrls: [],
        error: null,
        webrtcEnabled: false,
        webrtcViewers: 0,
        webrtcStats: [],
      }
    )
  }

  /** 当前传输方式(M-JPEG 永远在跑;webrtc 表示额外开了 P2P 通道) */
  get videoTransport(): 'mjpeg' | 'webrtc' {
    return this.videoTransportMode
  }

  /**
   * 切换传输方式。`'webrtc'` 需要浏览器支持 `captureStream`(探针:Chromium 全支持);
   * 不支持时保持 M-JPEG 并原样返回状态,面板上不会出现"开了但没效果"的假象。
   */
  setVideoTransport(mode: 'mjpeg' | 'webrtc'): VideoLinkState {
    const link = this.videoLink
    const fly = this.droneFly
    this.videoTransportMode = mode
    if (mode === 'webrtc') {
      const stream = fly?.createVideoStream({ width: 960, maxFps: 15 }) ?? null
      if (!stream) {
        this.videoTransportMode = 'mjpeg'
        this.videoMjpegFps = 15
        this.onVideoLinkChange?.(this.videoLinkState)
        return this.videoLinkState
      }
      // M-JPEG 降到 3 fps 保底(观看端切页/回退时至少有画面),省下的带宽让给 H.264/VP8
      this.videoMjpegFps = 3
      link?.enableWebRtc(stream)
    } else {
      this.videoMjpegFps = 15
      link?.disableWebRtc()
      fly?.destroyVideoStream()
    }
    this.onVideoLinkChange?.(this.videoLinkState)
    return this.videoLinkState
  }

  /** 图传是否正在推流(链路已连上) */
  get videoLinkActive(): boolean {
    return this.videoLink?.connected ?? false
  }

  /** 库提供的原生 DOM 控制面板(右上:飞行控制 + 双摇杆 + 云台/拍照/录像) */
  private controlPanel: DroneControlPanel | null = null
  /** 库提供的原生 DOM 航线规划面板(左上:任务/参数/航点列表/场景内编辑) */
  private missionPanel: MissionPanel | null = null
  /** 库提供的鹰眼图(右下:俯视小地图;只读真值 + Canvas 2D,与三维渲染完全解耦) */
  private miniMap: DroneMiniMap | null = null
  /**
   * 独立的 360° 全景弹窗(页顶按钮入口):可导入本地等距柱状全景图拖动环视,
   * 与影像集弹窗里那张互不相干(各自懒创建、各自销毁)。
   */
  private panoramaViewer: DronePanoramaViewer | null = null
  /**
   * 3D Gaussian Splatting 查看器(页顶「Splat 重建」入口)。
   * 与全景查看器各自懒创建:一个看球面照片,一个看椭球点集,数据源与渲染路径完全不同。
   * 公开字段:验证脚本经它读 stats(数量 / fps / 排序耗时)。
   */
  splatViewer: DroneSplatViewer | null = null
  /**
   * 采集服务:控制面板(全景拍摄)与采集面板共用同一份。
   * 公开字段:验证脚本经它断言全景拍摄的入库结果。
   */
  captureService: CaptureService | null = null
  /**
   * 库提供的影像采集面板(左下:采集会话 / 虚拟采集 / 真实照片导入 / 影像集 / 导出)。
   * 公开字段:验证脚本要经它拿到 CaptureService 做编程式采集与导出断言。
   */
  capturePanel: DroneCapturePanel | null = null
  /** 重建采集进行中(挡住重复点击;UI 也拿它换文案) */
  reconBusy = false
  /** 重建采集进度文案(空 = 未开始) */
  reconLabel = ''
  /** 最近一次重建采集的结果(验证脚本经它断言张数 / 覆盖) */
  reconResult: ReconCaptureResult | null = null
  /** COLMAP 包打包中(挡住重复点击) */
  colmapBusy = false
  /** COLMAP 包导出文案(空 = 还没导出过) */
  colmapLabel = ''
  /** 最近一次导出的包(验证脚本经它断言文件清单 / 字节数,不必等下载) */
  colmapResult: CaptureBundleResult | null = null
  /** 当前机体来源(undefined 传给 initialize = 哈士奇机体) */
  private bodyKind: BodyKind = 'glb'
  /** 切换中标志:整机销毁+重建是异步的,期间挡住重复点击 */
  private switching = false
  /** 机体切换完成回调(宿主用来刷新按钮文案) */
  onBodyChange: ((kind: BodyKind) => void) | null = null

  constructor(container: HTMLElement) {
    this.container = container
  }

  /** 当前机体来源:husky = 库内置哈士奇机体,glb = 真机模型 */
  get currentBody(): BodyKind {
    return this.bodyKind
  }

  /** 打开 360° 全景弹窗(不带图 = 显示「导入图片」入口;影像集里的合成图走它自己的「360° 环视」) */
  openPanorama(): void {
    if (!this.panoramaViewer) {
      this.panoramaViewer = new DronePanoramaViewer({ importable: true })
    }
    this.panoramaViewer.open()
  }

  /**
   * 规划并执行一次**重建采集**—— 与全景拍摄相反的那一半。
   *
   * 全景是"光心不动、只转朝向"(拼接要视差≈0),重建必须让光心移动,否则三角化退化。
   * 这里以机体当前正下方的场景块为主体,规划 2 圈环绕(每圈半径与高度不同),
   * 采完直接用**真值位姿**算视角覆盖,把热力图丢进 Splat 查看器:
   * 红 = 没拍到、黄 = 只有 1 个视角、绿以上 = 可用。
   *
   * 之所以值得在仿真里做:真值位姿是白送的,而真机采集最痛的就是位姿。
   */
  async startReconCapture(
    options: { pattern?: 'orbit' | 'sphere'; size?: [number, number, number]; rings?: number } = {},
  ): Promise<ReconCaptureResult | null> {
    const fly = this.droneFly
    const capture = this.captureService
    if (!fly || !capture || this.reconBusy) return null

    const sim = fly.sim
    // 采集会把机体"放置"到一串拍点上(胶片式,不真飞);采完放回原位,别打断用户的飞行状态
    const homeEnu: [number, number, number] = [sim.position.x, -sim.position.z, sim.position.y]
    // 采集要"在某个位置拍",所以必须先离地 —— 否则 placeBodyAt 只是把地面上的机体挪过去
    if (!sim.airborne) {
      // 开机自检(0.3s)会自动过渡到 standby,但模型加载慢时可能还没走完 —— 先等它,
      // 再 autoTakeOff(它会先起电机;takeOff 要求已处于 motorsOn,地面待机时会直接返回 false)
      const deadline = Date.now() + 12000
      while (!sim.airborne && Date.now() < deadline) {
        if (sim.phase === 'standby' || sim.phase === 'motorsOn') sim.autoTakeOff()
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
      if (!sim.airborne) {
        this.reconLabel = `起飞失败(当前 ${sim.phase})`
        this.onReconProgress?.(this.reconLabel)
        return null
      }
    }

    const session =
      capture.activeSession ??
      capture.createSession({
        source: 'virtual-camera',
        name: '重建采集',
        sceneId: 'three-demo',
        georeference: { longitude: 116.391, latitude: 39.906, altitude: 42 },
      })

    // 主体 = 机体当前正下方、地面上的一个方块(local-enu:z 上,中心在半高处)
    const size = options.size ?? ([20, 20, 10] as [number, number, number])
    const target = {
      center: [sim.position.x, -sim.position.z, size[2] / 2] as [number, number, number],
      size,
    }
    const intrinsics = capture.getCaptureIntrinsics()
    const plan = planReconCapture({
      pattern: options.pattern ?? 'orbit',
      target,
      rings: options.rings ?? 2,
      // 用实际取景相机的视场,而不是写死的 60° —— 垂直视场随窗口宽高比变化
      horizontalFovDeg: intrinsics?.horizontalFovDeg ?? 60,
      verticalFovDeg: intrinsics?.verticalFovDeg ?? 40,
    })

    const recon = new ReconstructionCapture(capture)
    recon.subscribe((progress) => {
      this.reconLabel =
        progress.state === 'running'
          ? `采集中 ${progress.index}/${progress.total}`
          : progress.message ?? progress.state
      this.onReconProgress?.(this.reconLabel)
    })

    this.reconBusy = true
    this.reconLabel = `采集中 0/${plan.total}`
    this.onReconProgress?.(this.reconLabel)
    try {
      const result = await recon.start(session.id, plan)
      // 机体放回采集开始时的位置(高度也还原);自转目标已由执行器清掉
      capture.placeBodyAt(homeEnu)
      this.reconResult = result
      if (result?.coverageCloud) {
        this.showSplatCloud(result.coverageCloud, result.coverageCloud.name)
      }
      const summary = result?.coverage
      this.reconLabel = summary
        ? `完成 ${result?.captured}/${result?.total} · 可用 ${(summary.usable * 100).toFixed(0)}%`
        : result?.error ?? '完成'
      this.onReconProgress?.(this.reconLabel)
      return result
    } finally {
      this.reconBusy = false
    }
  }

  /** 进度回调(宿主用来刷新按钮文案) */
  onReconProgress: ((label: string) => void) | null = null

  /** 直接把一份点云送进 Splat 查看器(local-enu,z 向上) */
  showSplatCloud(cloud: SplatCloud, title: string): void {
    this.ensureSplatViewer()
    const viewer = this.splatViewer
    if (!viewer) return
    viewer.setUpAxis('z', false)
    viewer.open(cloud, title)
  }

  /** 懒创建查看器:数据源由宿主管,查看器只负责画 */
  private ensureSplatViewer(): void {
    if (this.splatViewer) return
    this.splatViewer = new DroneSplatViewer({
      importable: true,
      extraActions: [
        { label: '示例场景', className: 'dsv-sample', onClick: () => this.openSplat('sample') },
        {
          // 3DGS 训练产物(INRIA train.py 的 point_cloud.ply)。文件放在 public/ 下,
          // 没训练时点了会看到「载入失败」而不是崩 —— fetch 404 走 fail 分支。
          label: '训练成果 recon74',
          className: 'dsv-trained',
          onClick: () => this.splatViewer?.open('/recon74.ply', 'recon74 · 3DGS 30000 iter'),
        },
      ],
    })
  }

  /**
   * 打开 Splat 查看器。
   *
   * 数据源优先级(**这就是"真采集数据"的入口**):
   * 1. 当前采集会话里有位姿的影像 → 画成视锥骨架(z 向上,`local-enu`);
   * 2. 没有采集 → 内置示例场景(零资产,打开即见)。
   *
   * 为什么先给"位姿骨架"而不是等重建结果:位姿错在画面上看不出来 —— 一个整体转错的
   * 位姿集合渲染出来照样像那么回事。把视锥画成实体之后,朝向、覆盖率、姿态突跳一眼可见,
   * 这是花几小时跑训练之前唯一便宜的检查。
   *
   * 弹窗里还可以「导入」.ply / .splat,或直接拖文件进去。
   */
  openSplat(mode: 'auto' | 'capture' | 'sample' = 'auto'): void {
    this.ensureSplatViewer()
    const viewer = this.splatViewer
    if (!viewer) return
    const session = this.captureService?.activeSession ?? null
    if (mode !== 'sample' && session) {
      const cloud = capturePosesToCloud(session)
      if (cloud.count > 0) {
        // 采集位姿在 local-enu(x 东 / y 北 / z 上),不是 three 的 y 向上
        viewer.setUpAxis('z', false)
        viewer.open(cloud, cloud.name)
        return
      }
    }
    viewer.setUpAxis('y', false)
    viewer.open(createReconstructionSample(), '示例重建数据')
  }

  /**
   * 导出 COLMAP 采集包:**影像 + manifest + 三件套**打成一个 zip 直接下载。
   *
   * 这是"浏览器采集"与"磁盘上跑 COLMAP"之间唯一缺的一步:采集结果全在内存里,
   * 而 `colmap feature_extractor` 只认目录。解压这个包 → `--image_path <解压目录>`,
   * 三件套已经就位(相机内参、位姿、空点表)。
   *
   * 真实导入的照片走 Blob URL(只在当前页面有效),所以这里先把字节读出来 ——
   * 否则包里会塞进去一串打不开的 `blob:` 地址。
   */
  async exportColmap(): Promise<CaptureBundleResult | null> {
    const capture = this.captureService
    const session = capture?.activeSession
    if (!capture || !session) {
      this.colmapLabel = '还没有采集会话'
      return null
    }
    if (this.colmapBusy) return null
    this.colmapBusy = true
    this.colmapLabel = '打包中…'
    try {
      const manifest = capture.buildManifest(session.id)
      if (!manifest) {
        this.colmapLabel = '清单为空'
        return null
      }
      const images = await Promise.all(
        session.images.map(async (image) => {
          if (typeof image.imageUrl === 'string' && image.imageUrl.startsWith('data:')) {
            return { id: image.id, dataUrl: image.imageUrl }
          }
          if (image.localBlob) {
            const buffer = await image.localBlob.arrayBuffer()
            return {
              id: image.id,
              bytes: new Uint8Array(buffer),
              mimeType: image.localBlob.type || image.mimeType,
            }
          }
          return { id: image.id }
        }),
      )
      const bundle = buildCaptureBundle({ manifest, images })
      this.colmapResult = bundle
      this.downloadBytes(bundle.bytes, captureBundleFileName(bundle.manifest))
      const megabytes = bundle.totalBytes / (1024 * 1024)
      this.colmapLabel = `已导出 ${bundle.manifest.images.length} 张 · ${megabytes.toFixed(1)} MB`
      return bundle
    } finally {
      this.colmapBusy = false
    }
  }

  /** 触发浏览器下载(anchor + object URL;revoke 放到下一拍,免得 Safari 还没开始读就失效) */
  private downloadBytes(bytes: Uint8Array, fileName: string): void {
    // BlobPart 只接受 ArrayBuffer 支撑的视图,而 Uint8Array 默认是 ArrayBufferLike(理论含 SharedArrayBuffer);
    // writeZipStore 里都是普通 ArrayBuffer,这里收窄一次
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: CAPTURE_BUNDLE_MIME }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  async init(): Promise<void> {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x87ceeb)

    const width = this.container.clientWidth
    const height = this.container.clientHeight

    this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000)
    this.camera.position.set(4, 4, 5)

    // 双渲染器:默认 WebGPU(主路径,支持 TSL 后期);?renderer=webgl 用传统 WebGLRenderer。
    // 库对两者都只依赖 render/domElement(见 drone-renderer.ts 契约),差异只在 demo 侧的
    // 后期管线与海湾材质(NodeMaterial 是 WebGPURenderer 专属)。
    this.rendererKind =
      (new URLSearchParams(window.location.search).get('renderer') as DroneRendererKind) ?? 'webgpu'
    const postPipeline = this.rendererKind !== 'webgl'
    let renderer: DroneRendererLike
    if (postPipeline) {
      const gpu = new WebGPURenderer({ antialias: true })
      await gpu.init()
      // 卡顿排查第一现场:真在硬件上跑还是掉进了软件渲染(SwiftShader),一眼可见
      try {
        const info = (gpu as unknown as { backend?: { device?: { adapterInfo?: GPUAdapterInfo | null } } })
          .backend?.device?.adapterInfo
        if (info) {
          console.info(
            `[three-demo] WebGPU adapter: vendor=${info.vendor || '?'} architecture=${info.architecture || '?'} device=${info.device || '?'}`,
          )
        }
      } catch {
        // adapterInfo 拿不到就算了,不影响渲染
      }
      renderer = gpu
    } else {
      const gl = new THREE.WebGLRenderer({ antialias: true })
      gl.toneMapping = THREE.ACESFilmicToneMapping
      renderer = gl
    }
    this.renderer = renderer
    this.rendererKind = rendererKindOf(renderer)
    renderer.setSize(width, height)
    renderer.shadowMap.enabled = true
    this.container.appendChild(renderer.domElement)

    // 场景内容层:demo 自己用 three 搭的布景,与库的沙盒骨架(底板 + 网格 + 返航点)完全解耦。
    // 默认是 firstapp「海湾竞速」的静态部分(天空 + 海面 + 跨海大桥);
    //   ?scenery=city 回到程序化城市,?scenery=0 全关。
    // 只建一次,不随机体切换重建(切换的是飞机,不是世界)。
    // ⚠️ 必须在 rendererKind 判别之后:海湾材质按后端二选一(TSL 只有 WebGPURenderer 能渲),
    // 放在前面会让 WebGL 路径拿到 NodeMaterial,WebGLProgram 直接抛 "reading 'replace'"。
    const sceneryMode = new URLSearchParams(window.location.search).get('scenery') ?? 'bay'
    if (sceneryMode !== '0') {
      this.scenery =
        sceneryMode === 'city'
          ? new DemoScenery(this.scene)
          : new BayScenery(this.scene, this.rendererKind)
    }

    // 轨道控制器
    this.controls = new OrbitControls(this.camera, renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.05

    // —— 灯光:方向光负责「太阳锐影」,天空漫射全部交给 HDRI ——
    // 不再用 AmbientLight:它与 HDRI 的天空漫射重复,会把阴影洗灰、对比度塌陷。
    // 色温取清晨暖阳;强度给足,因为 PMREM 里的太阳只是模糊亮斑,锐影全靠这盏灯。
    const dirLight = new THREE.DirectionalLight(0xffd2a0, 3.0)
    dirLight.position.set(SUN_POSITION.x, SUN_POSITION.y, SUN_POSITION.z)
    dirLight.castShadow = true
    dirLight.shadow.mapSize.set(2048, 2048)
    dirLight.shadow.camera.near = 10
    dirLight.shadow.camera.far = 500
    dirLight.shadow.camera.left = -220
    dirLight.shadow.camera.right = 220
    dirLight.shadow.camera.top = 220
    dirLight.shadow.camera.bottom = -220
    // 改过正交范围必须重算投影矩阵,否则仍按默认 ±5m 裁剪 —— 表现为「只有原点附近有影子」
    dirLight.shadow.camera.updateProjectionMatrix()
    // 装饰剔除层(bay 的树/路灯/中国结)也要进阴影贴图:反射相机不看它,阴影相机得看
    dirLight.shadow.camera.layers.enable(1)
    dirLight.shadow.bias = -0.0005
    this.scene.add(dirLight)
    this.dirLight = dirLight

    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0

    // 先给中性影棚底光,保证首帧金属机体就有正确反射;
    // 再异步升级到真实户外 HDRI(2k 8MB,不阻塞首帧,加载完自动替换)。
    this.applyFallbackEnvironment()
    void this.applyHdriEnvironment()

    // 后期管线:场景色 + 泛光。pass 渲到 HDR 线性缓冲(材质级 toneMapped 标志在 RT 路径下不生效,
    // ACES 改由输出级统一做)—— LED 亮核(core 增益后线性 >1)溢出光晕,白色壳体(<threshold)不受影响。
    // 相机/场景实例在机体切换(switchBody 整套销毁重建)时保持不变,管线只需建一次。
    // 后期(TSL pass/bloom)只在 WebGPURenderer 下可用;WebGL 直渲 —— 色调映射已开 ACES 兜底
    if (this.rendererKind === 'webgpu') {
      const scenePass = pass(this.scene, this.camera)
      const sceneColor = scenePass.getTextureNode()
      this.bloomPass = bloom(sceneColor, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD)
      this.postProcessing = new PostProcessing(this.renderer as unknown as WebGPURenderer)
      this.postProcessing.outputNode = sceneColor.add(this.bloomPass)
    }

    // 地面 / 网格 / 坐标参照全部交给库的沙盒世界(DroneWorld):它自带 4000m 底板 + 米级细网格 + 百米粗网格。
    // demo 这里原本还叠了一层 20x20 灰地板、20x20 蓝网格和一根 AxesHelper(正正压在同一个 y=0 上,
    // 与库的底板同面闪烁),以及一个自转的红色方块 —— 都是 firstapp 模板的演示残留,与无人机沙盒无关,已清掉。
    // 机体来源:默认加载真机 GLB;带 ?model=husky 时改用库内置的机械哈士奇机体(零资产依赖)。
    // 演示用 —— 哈士奇机体不传 modelUrl 即可,不需要 /models 下放任何文件。
    // 页面上还有按钮可以随时在两者之间切换(见 switchBody)。
    const useHuskyBody = new URLSearchParams(window.location.search).get('model') === 'husky'
    await this.InitdRroneFly(
      useHuskyBody ? undefined : GLB_MODEL_URL,
      useHuskyBody ? 'husky' : 'glb',
    )

    // 预热渲染上下文:此时 loading 遮罩还挡着,编译爆发藏在这里,不留给用户第一次点「跟随」
    this.prewarmRenderContexts()

    window.addEventListener('resize', this.onResize)
    this.animate()
  }

  /**
   * 预热渲染上下文 —— 消掉「点击跟随卡死几秒」的根。
   *
   * WebGPU 渲染器的 RenderObject 按 (object, material, renderContext, lightsNode) 缓存,
   * 而水面反射(ReflectorNode)有**独立的 renderContext**:某个物体**首次进入反射视锥**
   * 才会建节点图、编译 WGSL;软光栅下每次编译几百 ms。跟随是低机位,反射相机的视锥
   * 第一次罩住天空穹顶/桥底/机体大片内容,几十个新渲染对象一口气编译,
   * 实测第一帧 p95 2.5s、3 秒只渲出 4 帧 —— 这就是用户看到的"点跟随卡死,fps 掉到 7"。
   *
   * 对策:用三个代表性机位(贴水低机位/机头/中距斜视)各渲两帧,把反射上下文的
   * 渲染对象提前建齐。代价是加载期多花 1~3s(在遮罩后面),换来之后任意视角切换零编译。
   * 机体切换会换一套材质,InitdRroneFly 之后也要再跑一遍(见 switchBody)。
   */
  private prewarmRenderContexts(): void {
    const renderer = this.renderer
    const scene = this.scene
    const camera = this.camera
    const sim = this.droneFly?.sim
    if (!renderer || !scene || !camera || !sim) return
    // 诊断标记:验证脚本用 performance.now 圈出预热窗口,量化它实际建了多少管线
    const w = window as unknown as { __prewarm?: { start: number; end: number } }
    w.__prewarm = { start: performance.now(), end: 0 }
    const px = sim.position.x
    const pz = sim.position.z
    // [相机位置, 注视点]:低机位贴水面(对齐 follow 的 7.5m 后 2.8m 高)/ 机头云台位(≈fpv)/ 中距离斜视
    const poses: Array<[readonly [number, number, number], readonly [number, number, number]]> = [
      [[px, 2.8, pz + 7.5], [px, 0.7, pz]],
      [[px, 0.35, pz - 0.2], [px + 2, 0.4, pz - 6]],
      [[px + 14, 6, pz + 14], [px, 0.5, pz]],
    ]
    // 远景装饰(中线灯/行道树/中国结/桥面文字)有各自独立的材质与几何变体,管线没法共享:
    // 它们大多在出生点近旁的路面上,初始俯视机位与 follow 机位都未必扫进视锥,
    // 首次入锥才逐件编译。因此在这里做 4 方向水平扫视,把近旁装饰一次收进视锥;
    // 再朝桥中心补一眼,覆盖远端的桥面装饰。
    const bridge = scene.getObjectByName('cable-stayed-highway-bridge')
    if (bridge) {
      const box = new THREE.Box3().setFromObject(bridge)
      const center = box.getCenter(new THREE.Vector3())
      const eye = new THREE.Vector3(px, 3, pz)
      const dir = center.clone().sub(eye).normalize()
      poses.push([
        [eye.x - dir.x * 5, 3.5, eye.z - dir.z * 5],
        [center.x, Math.max(center.y, 8), center.z],
      ])
    }
    const headingPoses: Array<readonly [number, number, number]> = [
      [px, 2.8, pz + 7.5],
      [px, 2.8, pz - 7.5],
      [px + 7.5, 2.8, pz],
      [px - 7.5, 2.8, pz],
    ]
    for (const pos of headingPoses) {
      poses.push([pos, [px, 2.2, pz]])
    }
    const savedPos = camera.position.clone()
    const savedQuat = camera.quaternion.clone()
    const savedTarget = this.controls?.target.clone() ?? null
    // 与真实循环完全同路径:天空/海面先钉到当前机位(它们每帧跟着相机走),
    // 渲染必须走 postProcessing —— 它的 renderContext 独立于裸 renderer.render,
    // 预热建错上下文等于白建(第一版就栽在这里:裸 render 预热完,首点跟随照样爆发)。
    const renderOnce = (): void => {
      if (this.postProcessing) this.postProcessing.render()
      else renderer.render(scene, camera)
    }
    for (const [pos, look] of poses) {
      camera.position.set(pos[0], pos[1], pos[2])
      camera.lookAt(look[0], look[1], look[2])
      camera.updateMatrixWorld(true)
      // 天空/海面钉到当前机位(它们每帧跟着相机走);只有 BayScenery 吃 camera 参数
      if (this.scenery instanceof BayScenery) this.scenery.update(0, camera)
      // 第一帧触发节点图构建与 WGSL 编译,第二帧确认走的是缓存路径
      renderOnce()
      renderOnce()
    }
    if (this.scenery instanceof BayScenery) this.scenery.update(0, camera)
    camera.position.copy(savedPos)
    camera.quaternion.copy(savedQuat)
    if (this.controls && savedTarget) {
      this.controls.target.copy(savedTarget)
      this.controls.update()
    }
    w.__prewarm.end = performance.now()
  }

  /**
   * 中性影棚环境 —— 兜底。
   * 哈士奇机体有大量 metalness 0.7~0.9 的金属件,没有环境反射会发黑,
   * 所以 HDRI 未就绪(或失败)时先用 RoomEnvironment 顶住,保证首帧不是黑飞机。
   */
  private applyFallbackEnvironment(): void {
    const scene = this.scene
    const renderer = this.renderer
    if (!scene || !renderer) return
    // three/webgpu 的 PMREM 只认 WebGPURenderer;传统 WebGLRenderer 用 three 的同名类
    const pmrem =
      this.rendererKind === 'webgpu'
        ? new WGPUPMREMGenerator(renderer as unknown as WebGPURenderer)
        : new WebGLPMREMGenerator(renderer as unknown as THREE.WebGLRenderer)
    const room = new RoomEnvironment()
    scene.environment = pmrem.fromScene(room, 0.04).texture
    // 没有替代 AmbientLight,由环境图独立承担漫射,故比原先的 0.55 提高
    scene.environmentIntensity = 0.9
    room.dispose()
    pmrem.dispose()
  }

  /**
   * 载入真实户外 HDRI(Poly Haven, CC0)。
   *
   * 一张图同时解决三件事,这也是它比调参数更有效的原因:
   *   1) 背景 —— 天空有渐变、有云、有地平线,不再是纯色色块;
   *   2) 环境漫射 —— 天空光从上方来、地面反弹从下方来,方向性正确;
   *   3) 材质反射 —— 玻璃/金属反射的是真实天空而不是白墙。
   *
   * 加载期间场景可能被销毁(切路由/destroy),此时丢弃贴图,避免泄漏。
   * `?hdri=0` 保留旧的影棚环境,便于 A/B 对比。
   */
  private async applyHdriEnvironment(): Promise<void> {
    const scene = this.scene
    if (!scene) return
    if (new URLSearchParams(window.location.search).get('hdri') === '0') return
    try {
      const tex = await new RGBELoader().loadAsync(HDRI_URL)
      if (this.scene !== scene) {
        tex.dispose()
        return
      }
      tex.mapping = THREE.EquirectangularReflectionMapping
      scene.environment = tex
      // 压一点环境:0.85 留出阴影对比度;给满 1.0 时天空漫射会把长影洗灰。
      // ⚠️ 按**当前时段**取值:HDRI 是异步加载的,若用户已切到黄昏/夜晚,
      // 这里不能把夜晚压暗的环境强度又覆盖回白天值(白天 0.85 / 黄昏 0.5 / 夜晚 0.12)。
      scene.environmentIntensity = { day: 0.85, dusk: 0.5, night: 0.12 }[this.dayPhase]
      scene.background = tex
      scene.backgroundIntensity = 1
      // 雾色取 HDRI 地平线的暖灰:远景没入大气而不是被生硬切断。
      // 只在 HDRI 生效时加 —— 影棚兜底场景加雾反而怪。
      // 海湾布景除外:TSL 天空球/海面材质自带地平线融合,暖灰雾会把整座桥染黄。
      if (!(this.scenery instanceof BayScenery)) {
        scene.fog = new THREE.FogExp2(0xc9b8a3, 0.0009)
      }
      this.hdriTexture = tex
    } catch {
      // 保持 RoomEnvironment 兜底,静默失败:天空贴图不该阻断整个 demo
    }
  }

  /** 当前时段(顶栏 chip 显示用) */
  public get currentDayPhase(): BayTimeOfDay {
    return this.dayPhase
  }

  /**
   * 昼夜切换:白天 / 黄昏 / 夜晚。
   *
   * 分两半:
   *  - 海湾布景(天空 uniform / 海面 / 路灯自发光与光池)走 BayScenery.setTimeOfDay,
   *    全是 uniform 改值,不触发 WebGPU 管线重编译;
   *  - 全场景的直射光(太阳⇄低角度橙阳⇄月光)与环境漫射强度(HDRI 是白天图,
   *    夜里必须压到接近熄灭,否则桥面被"白天"照亮)在这里改。
   * 改灯的强度/颜色/位置不换 lightsNode 结构,同样走缓存路径。
   */
  public setDayPhase(phase: BayTimeOfDay): BayTimeOfDay {
    this.dayPhase = phase
    if (this.dirLight) {
      switch (phase) {
        case 'day':
          // 基线:清晨暖阳(与 init 建灯时的参数一致)
          this.dirLight.color.set(0xffd2a0)
          this.dirLight.intensity = 3.0
          this.dirLight.position.set(SUN_POSITION.x, SUN_POSITION.y, SUN_POSITION.z)
          break
        case 'dusk':
          // 低角度橙阳:影子拉长,与天空的日落混合项同方向
          this.dirLight.color.set(0xff8c4a)
          this.dirLight.intensity = 1.7
          this.dirLight.position.copy(sunDirectionFor(0.12)).multiplyScalar(220)
          break
        case 'night':
          // 月光:冷蓝弱直射,方向 = 天空里月亮的方向
          this.dirLight.color.set(0x93a7d8)
          this.dirLight.intensity = 0.5
          this.dirLight.position.copy(sunDirectionFor(0.45)).multiplyScalar(220)
          break
      }
    }
    if (this.scene) {
      this.scene.environmentIntensity = { day: 0.85, dusk: 0.5, night: 0.12 }[phase]
    }
    if (this.scenery instanceof BayScenery) this.scenery.setTimeOfDay(phase)
    return phase
  }

  /** 机型来源:不传 url = 用库内置的哈士奇机体(见 DroneFly.initialize) */
  public async InitdRroneFly(url?: string, kind: BodyKind = url ? 'glb' : 'husky'): Promise<void> {    this.bodyKind = kind
    // 新引擎 = 新材质集,上电补预热要重新走一遍
    this.prewarmedStandby = false
    if (!this.scene || !this.camera || !this.renderer) {
      throw new Error('[three-demo] 场景尚未就绪,请先 await init()')
    }
    // 障碍物(建筑 / 灯杆 / 天桥 / 树)不在 modelUrl 里,而是由库的世界层按规格程序化生成。
    // 默认传空数组 = 清空它们,沙盒只剩地面网格 + 返航点 + 无人机;
    // 带 ?obstacles=1 时恢复内置那 7 个参考物 —— 鹰眼图上就能直接看到建筑/天桥的矩形轮廓。
    const withObstacles = new URLSearchParams(window.location.search).get('obstacles') === '1'
    // 引擎装配入口:engine 决定用 three 还是 Cesium 那套实现。这里显式写 'three'
    // (也是缺省值),与 Cesium 页共用同一份装配 API,换后端时调用点形状不变。
    const fly = await createDroneControl({
      engine: 'three',
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      controls: this.controls,
      modelUrl: url,
      obstacles: withObstacles ? DEFAULT_OBSTACLES : [],
    })
    this.droneFly = fly

    // 演示开关:`?unlimited=1` 取消限高 / 限距(内核 SimConfig.unlimitedFlight)。
    // 拍高空机位、飞长航线时用;不带参数则仍是真机口径的 120 m / 500 m。
    if (new URLSearchParams(window.location.search).get('unlimited') === '1') {
      fly.sim.setConfig({ unlimitedFlight: true })
    }

    // 把 demo 布景的碰撞盒并进仿真障碍物:库内 `sim.obstacles` 就是 world 那份 collisionBoxes 的引用,
    // 这里 push 进去 = **避障刹停 / 鹰眼图轮廓**都能看见 demo 自己搭的楼与地标,库侧一行都不用改。
    // (每次重建都是一个新 sim,所以在这里 push 不会累积重复。)
    for (const box of this.scenery?.footprints ?? []) {
      fly.sim.obstacles.push(box)
    }

    // 海湾布景自带整片海面:库的 4000m 底板 + 网格会和它叠在同一高度互相穿插,
    // 这里把地面参照整层关掉(海面就是地面);城市/无布景模式保持原样。
    // 注意在 InitdRroneFly 里 world 刚建好,且每次切机型重建 world 都要重新执行,
    // 所以放在装配路径上而不是 init()。
    if (this.scenery instanceof BayScenery) {
      fly.world?.setGroundVisible(false)
    }

    // 上电:走完自检 → 预热 → 待机,面板上「起飞」随即可用(真机也是先开机再用遥控器)
    fly.powerOn()
    // 展开机臂:「机臂已展开」是起飞前检查的阻塞项,真机也得先展臂(面板上也有对应按钮)
    fly.setArmsFolded(false)

    // ⚠️ 落位必须在上电之后:powerOn() 会把 position / heading 归零,写在它前面等于没写。
    if (this.scenery instanceof BayScenery) {
      // 机体放到桥面同向第一条车道的中心:桥面顶被对齐到 y=0(见 bay-scenery 的 ROAD_TOP),
      // 所以 y=0 就是"站在桥上",起飞/降落/返航点全都在这块桥面上。
      // (中心线正中是绿化隔离带,不能落在那儿,见 BayScenery.resolveSpawn。)
      const spawn = this.scenery.spawn
      fly.placeBodyAt([spawn.x, -spawn.z, 0])
      fly.sim.heading = spawn.heading
      fly.world?.setHome(spawn.x, spawn.z)
      // 观察相机挪到机体后上方(沿桥面走向后退 + 抬高),否则首帧还在原点看海。
      // ⚠️ 必须走 setOrbitCamera 同步库内部的跟随状态:只改 controls.target 的话,
      // autoFollow 第一帧会把控制点从内部初值(原点)朝飞机 lerp 一步再冻结,
      // 实测页面停在 (0,0,-7.5) 附近看海,摆好的机位整个被拽走。
      const rad = (spawn.heading * Math.PI) / 180
      fly.setOrbitCamera(
        new THREE.Vector3(spawn.x - Math.sin(rad) * 14, 7, spawn.z + Math.cos(rad) * 14),
        new THREE.Vector3(spawn.x, 1.5, spawn.z),
      )
    }

    // 飞控源切换器:默认内置模型;带 `?mavlink=ws://…` 时启动即接外部飞控。
    // 接管点是 sim,所以下面要建的面板与采集服务读到的永远是"当前在飞的那一个"。
    this.sources = new FlightSourceManager({
      sim: fly.sim,
      mavlinkUrl: new URLSearchParams(window.location.search).get('mavlink') ?? undefined,
      onChange: (state) => this.onFlightSourceChange?.(state),
    })
    const mavlinkUrl = new URLSearchParams(window.location.search).get('mavlink')
    if (mavlinkUrl) {
      // 不 await —— 网桥没起时连接要等 5 s 超时,不该把首屏卡住;失败会自动回退内置模型
      void this.setFlightSource('mavlink', mavlinkUrl).catch((error: unknown) => {
        console.warn('[three-demo] MAVLink 接入失败,继续使用内置飞控:', error)
      })
    } else {
      this.onFlightSourceChange?.(this.sources.state)
    }

    // 采集服务:**控制面板(全景拍摄)与影像采集面板共用同一份** ——
    // 于是全景扫描拍下的几十张会直接出现在采集面板的影像集里,计数与导出都在一处。
    // 服务持有指向前端的 provider,所以它跟 fly 同生命周期(换机体时整个重建)。
    const captureService = new CaptureService({ provider: fly })
    this.captureService = captureService

    // 控制面板由库直接生成(原生 DOM,不依赖 Vue):视角切换 + 双虚拟摇杆 + 云台 / 拍摄模式 / 拍照 / 录像
    this.controlPanel = new DroneControlPanel(fly, {
      container: this.container,
      position: 'top-right',
      captureService,
    })

    // 航线规划面板(同样原生 DOM):执行/暂停/停止任务、任务参数、航点列表、三维场景内编辑。
    // 摆在左上角与右上角的控制面板对开;场景内编辑默认可用(初始就是观察者视角)
    this.missionPanel = new MissionPanel(fly, {
      container: this.container,
      position: 'top-left',
    })

    // 鹰眼图:俯视小地图。与两个面板同一套「原生 DOM + 只读真值」范式,
    // 但它内部是 Canvas 2D 且**自驱 rAF** 每帧重绘 —— 因为 200ms 轮询在二维图上会一格一格跳。
    // 不碰 renderer / 场景 / 相机,所以拍照与录像的成片里不会混进小地图。
    // 位置选底部中央:右下角被 HUD 摇杆 + 技能钮占满、往上又撞控制面板,两侧摇杆之间是唯一空档;
    // offset.y 抬过底部的键盘提示图标。
    this.miniMap = new DroneMiniMap(fly, {
      container: this.container,
      position: 'bottom-center',
      offset: { y: 30 },
    })

    // 影像采集面板(左下角):虚拟采集复用「拍照」那条取景路径,每张顺带记下取景相机
    // 位姿 / 内参 / 坐标系;也可以导入真实照片读 EXIF/GPS。offset.y 把面板抬到左摇杆上方。
    // sessionDefaults 把「这是哪个场景」交代清楚,并给局部 ENU 一个地理原点 ——
    // 于是虚拟影像除了局部坐标以外,还会带一份可读的经纬高(与真实照片的字段同形)。
    this.capturePanel = new DroneCapturePanel(fly, {
      container: this.container,
      position: 'bottom-left',
      // 与控制面板共用同一个采集服务:全景拍的那一组照片直接落进这里的影像集
      service: captureService,
      // 左侧整列被航线面板占着(y 12~724,按钮到 579),贴角放必然压它;
      // 横向让开 300px 落到航线面板右侧空档:x 312~628 与航线面板(≤274)、
      // 左摇杆(30~124/顶边距底 169)都不相交;y 240 让面板底边越过底部中央
      // 鹰眼图顶部(1366×768 下鹰眼图顶边距底 232),两种视口都不压它。
      offset: { x: 300, y: 240 },
      sessionDefaults: {
        sceneId: 'three-demo',
        sceneVersion: kind,
        georeference: { longitude: 116.391, latitude: 39.906, altitude: 0 },
      },
    })

    // 开发期调试句柄:方便在浏览器控制台 / 自动化脚本里读飞控真值(生产构建会被剔除)
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__droneDemo = this
    }
  }

  /**
   * 切换飞控源(运行时可切,不重建机体、不刷新页面)。
   *
   * 两种源共用同一份界面 —— 面板、鹰眼图、采集服务读的都是 `sim`:
   *   - `'internal'` 内置 DroneSim 自己积分
   *   - `'mavlink'`  PX4 / ArduPilot 的遥测写进 `sim`,面板指令翻译成 MAVLink
   *
   * 外部源若把飞机带到了几十米高,交还内置模型后会保持悬停
   * (见 `DroneSim.detachExternalSource`),不会出现空中停桨。
   */
  public async setFlightSource(kind: FlightSourceKind, url?: string): Promise<FlightSourceInfo> {
    const sources = this.sources
    if (!sources) {
      // 机体还没装好(初始化中):返回当前快照,不制造一个假的成功
      return { kind: 'internal', url: null, status: null, error: null }
    }
    if (kind === 'internal') await sources.useInternal()
    else await sources.useMavlink(url)
    return sources.state
  }

  /**
   * 开启图传:连中转 → 挂在渲染循环上按 15 fps 推帧。
   *
   * 默认地址按**当前页面 hostname** 推:用手机访问 `192.168.0.5:56789` 打开页面时,
   * 图传自然指向 `192.168.0.5:8130`,不需要用户改配置(中转与页面不必同源)。
   */
  public async startVideoLink(url?: string, transport?: 'mjpeg' | 'webrtc'): Promise<VideoLinkState> {
    if (this.videoLink?.connected) return this.videoLinkState
    const link = new VideoDownlink({
      url: url ?? `ws://${window.location.hostname}:${VIDEO_LINK_DEFAULT_PORT}/ws`,
      onState: (state) => this.onVideoLinkChange?.(state),
    })
    this.videoLink = link
    try {
      await link.connect()
    } catch (error: unknown) {
      // 失败也留着实例:它自己会按 2 s 间隔重连(中转后启动也能自愈)
      this.onVideoLinkChange?.(link.snapshot)
      throw error
    }
    // `?rtc=1` 一进来就走 WebRTC;默认仍是 M-JPEG(兼容一切浏览器)
    const wantRtc =
      transport ?? (new URLSearchParams(window.location.search).get('rtc') === '1' ? 'webrtc' : 'mjpeg')
    if (wantRtc === 'webrtc') this.setVideoTransport('webrtc')
    return link.snapshot
  }

  /** 关闭图传(顺带断开中转,观看端会显示"等待图传信号") */
  public stopVideoLink(): void {
    this.videoLink?.close()
    this.videoLink = null
    // 视频轨道一起收:链路都没了,继续喂轨道只是白编码
    this.droneFly?.destroyVideoStream()
    this.videoMjpegFps = 15
    this.onVideoLinkChange?.(this.videoLinkState)
  }

  /** 一键开关,返回操作后的状态 */
  public async toggleVideoLink(url?: string): Promise<VideoLinkState> {
    if (this.videoLink) {
      this.stopVideoLink()
      return this.videoLinkState
    }
    return this.startVideoLink(url)
  }

  /**
   * 图传取帧 + OSD —— 由渲染循环每帧调用(自身的限帧与背压丢弃在库内)。
   *
   * 帧必须来自 `requestVideoFrame()` 而不是直接截屏:图传要给的是**云台看到的画面**,
   * 用户在观察者视角下截屏传出去的会是第三人称航拍,不是机载视角。
   */
  private pumpVideoLink(): void {
    const link = this.videoLink
    const fly = this.droneFly
    if (!link || !fly || !link.connected) return
    const now = performance.now()
    // 自愈:机体切换会销毁重建 DroneFly,视频轨道跟着没了 —— 在这里静默重开并热替换
    if (this.videoTransportMode === 'webrtc' && !fly.hasVideoStream) {
      const stream = fly.createVideoStream({ width: 960, maxFps: 15 })
      if (stream) link.setVideoStream(stream)
      else this.setVideoTransport('mjpeg')
    }
    // M-JPEG 推帧:WebRTC 活跃时降到 3 fps 保底(见 setVideoTransport 的带宽说明)
    if (now - this.lastVideoFrameRequestAt >= 1000 / this.videoMjpegFps) {
      this.lastVideoFrameRequestAt = now
      void fly
        .requestVideoFrame({ source: this.videoFrameSource, width: 640, quality: 0.6 })
        .then((shot) => {
          if (!shot) return
          link.pushFrame(shot.data)
        })
        .catch(() => {
          /* 单帧失败不影响推流,下一拍继续 */
        })
    }
    if (now - this.lastVideoOsdAt >= 400) {
      this.lastVideoOsdAt = now
      const sim = fly.sim
      link.sendOsd({
        alt: sim.position.y,
        speed: Math.hypot(sim.velocity.x, sim.velocity.z),
        heading: sim.heading,
        battery: sim.batteryPercent,
        mode: sim.modeLabelText,
        satellites: sim.satelliteCount,
        gimbalPitch: sim.gimbalPitch,
        recording: sim.recording,
      })
    }
  }

  /**
   * 切换机体来源:积木机体 ⇄ 真机 GLB。
   *
   * 机体不是「换个 mesh」那么简单——机械件(DroneRig)、灯光(DroneLights)、雷达(DroneRadar)
   * 都按模型节点命名在 initialize 里一次性装配,两个面板也各自持有 DroneFly 引用。
   * 所以切换 = 整套销毁 + 重新 initialize:先拆面板(否则它们还轮询着旧飞控),再 destroy 引擎
   * (内部会收掉 rig/lights/world/radar/missionEditor 并释放模型几何与材质),然后按新来源重建。
   */
  public async switchBody(): Promise<BodyKind> {
    if (this.switching) return this.bodyKind
    this.switching = true
    try {
      const prev = this.bodyKind
      const next: BodyKind = prev === 'husky' ? 'glb' : 'husky'
      // 视角快照:重建后相机归位,这里把用户当前视角还回去(orbit 才有意义;
      // follow/fpv 下相机由引擎每帧驱动,只需把模式还原即可)
      const keepMode = this.droneFly ? this.droneFly.cameraMode : 'orbit'
      const camPos = this.camera?.position.clone()
      const camTarget = this.controls?.target.clone()
      // 飞控源跨机体切换保留:换了 mesh 不代表要断开用户连着的 PX4
      const keepSource = this.flightSource
      const keepSourceUrl = this.mavlinkUrl

      this.teardownFlight()
      try {
        await this.InitdRroneFly(next === 'husky' ? undefined : GLB_MODEL_URL, next)
      } catch (err) {
        // 典型失败:public/models 下没有真机 glb → initialize 内部 loadAsync reject。
        // 此时引擎已销毁,必须回滚到上一个来源,否则页面停在空白场景
        await this.InitdRroneFly(prev === 'husky' ? undefined : GLB_MODEL_URL, prev)
        this.onBodyChange?.(prev)
        throw err
      }

      if (keepSource === 'mavlink' && keepSourceUrl) {
        void this.setFlightSource('mavlink', keepSourceUrl).catch((error: unknown) => {
          console.warn('[three-demo] 机体切换后重新接入 MAVLink 失败:', error)
        })
      }

      if (keepMode === 'orbit' && camPos && camTarget && this.camera && this.controls) {
        this.camera.position.copy(camPos)
        this.controls.target.copy(camTarget)
        this.controls.update()
      } else {
        this.droneFly?.setCameraMode(keepMode)
      }

      // 新机体 = 新材质:反射上下文里的渲染对象也要重 建,趁「切换中」遮罩还在时预热
      this.prewarmRenderContexts()

      this.onBodyChange?.(next)
      return next
    } finally {
      this.switching = false
    }
  }

  /** 拆掉飞行相关的一切(面板 + 鹰眼图 + 引擎);模型/灯光/雷达/世界的释放都在 DroneFly.destroy 里 */
  private teardownFlight(): void {
    // 外部会话必须先于内核销毁:它每帧往 sim 里写状态,并且持有 WebSocket。
    // 地址记在 manager 里,但 manager 本身跟着 sim 一起作废,重建后会重新创建。
    this.sources?.destroy()
    this.sources = null

    this.controlPanel?.destroy()
    this.controlPanel = null

    this.missionPanel?.destroy()
    this.missionPanel = null

    // 鹰眼图也要先拆:它还握着一份 fly 引用,并且在自驱 rAF 里读 sim 真值
    this.miniMap?.destroy()
    this.miniMap = null

    // 采集面板同理:它持有 CaptureService(内含指向旧后端的 provider 与自动采集定时器),
    // 不拆掉的话自动采集会继续向已销毁的后端要帧
    this.capturePanel?.destroy()
    this.capturePanel = null
    // 服务本身没有资源要放,但 provider 指向的 fly 马上要被销毁,置空避免被误用
    this.captureService = null

    // 360° 全景弹窗与飞控无关,但归 demo 管:整机关页释放 GL
    this.panoramaViewer?.destroy()
    this.panoramaViewer = null

    this.droneFly?.destroy()
    this.droneFly = undefined
  }

  private animate(): void {
    this.animateId = requestAnimationFrame(this.animate.bind(this))

    // 每帧推进无人机仿真与相机 —— 视角切换/云台转动都是在这里生效的,漏调则画面永远不变
    this.droneFly?.animate()

    // 图传推帧:15 fps 取云台画面 + 2.5 Hz OSD(未开启时为空判,零开销)
    this.pumpVideoLink()

    // 布景动画:海湾场景的波浪与云层按真实 dt 推进,并把天空/海面钉到相机脚下
    // (相机 far 只有 1000m,不跟随的话飞远了会撞出穹顶、海面边缘露底)
    const now = performance.now()
    const delta = this.lastSceneryTime ? Math.min((now - this.lastSceneryTime) / 1000, 0.1) : 0
    this.lastSceneryTime = now
    if (this.scenery instanceof BayScenery && this.camera) {
      this.scenery.update(delta, this.camera)
    }

    // 上电自检完成(机臂展开/桨叶张开/灯语点亮)后再预热一轮:加载期预热时飞机还是
    // 折叠熄灭态,这批「展开态」的渲染变体(桨叶/传感器/LED/深度材质)要等这一刻才建得齐。
    // 相位变化只发生一次,之后每帧只是布尔比较,零开销。
    const phase = this.droneFly?.sim.phase
    if (phase === 'standby' && !this.prewarmedStandby && this.droneFly) {
      this.prewarmedStandby = true
      this.prewarmRenderContexts()
    } else if (phase !== 'standby') {
      this.prewarmedStandby = false
    }

    // 桥/灯/结/树是 GLB 异步装配:加载末尾那轮预热时多半还没建出来,预热等于白跑
    // (这也是"点跟随卡死"的主因 —— 装饰就绪后的第一次入锥全部现编译)。
    // 装饰组就绪后补一轮;watch 的三个名字与 BayScenery.applyDecorLayers 一致。
    if (
      !this.decorPrewarmDone &&
      this.scene?.getObjectByName('median-street-lamps') &&
      this.scene.getObjectByName('median-trees') &&
      this.scene.getObjectByName('street-lamp-chinese-knots')
    ) {
      this.decorPrewarmDone = true
      this.prewarmRenderContexts()
    }

    // 只有观察者(轨道)视角才交给 OrbitControls;机载/跟随视角下它的
    // 每帧 lookAt(target) 会把相机拽回"看着飞机",覆盖云台取景
    if (!this.droneFly || this.droneFly.isOrbitView) {
      this.controls?.update()
    }

    // 拍照 / 录像钩子:摆云台取景 → 渲染 → 同一任务内拷屏并还原相机。
    // 不调这三个钩子,拍照会一直"相机未就绪"超时,录像录到的是用户视角而非云台画面;
    // 未拍照且未录制时三者全部零开销,每帧调用没有代价
    this.droneFly?.captureRecordingFrame()
    this.droneFly?.onBeforeRender()

    if (this.postProcessing) {
      // 必须经后期管线渲染:直接 renderer.render 会绕过 bloom(拍照路径同样走这里,成片带泛光;
      // 云台录像在库内走独立 renderer.render,暂不带泛光 —— 属已知差异)
      this.postProcessing.render()
    } else if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera)
    }

    this.droneFly?.onAfterRender()
  }

  private readonly onResize = (): void => {
    if (!this.camera || !this.renderer) return
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }

  async destroy(): Promise<void> {
    if (this.animateId !== null) {
      cancelAnimationFrame(this.animateId)
    }
    window.removeEventListener('resize', this.onResize)

    this.controls?.dispose()

    // 图传会话先关:它每帧向引擎要帧,留着会一直往已销毁的后端发请求
    this.videoLink?.close()
    this.videoLink = null

    this.teardownFlight()

    // 布景层:整层摘掉并释放几何/材质/贴图(它在场景里独立于飞控,不随 teardownFlight 收)
    this.scenery?.dispose()
    this.scenery = null

    this.postProcessing = null
    this.bloomPass = null

    this.hdriTexture?.dispose()
    this.hdriTexture = null
    this.dirLight = null

    if (this.renderer) {
      this.renderer.dispose()
      this.container.removeChild(this.renderer.domElement)
    }

    this.scene = null
    this.camera = null
    this.renderer = null
    this.controls = null
  }
}
