import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import {
  CaptureService,
  DEFAULT_OBSTACLES,
  DroneCapturePanel,
  DroneControlPanel,
  DroneMiniMap,
  DronePanoramaViewer,
  MissionPanel,
  createDroneControl,
} from '@/lib'
import type { DroneFly } from '@/lib'
import { PMREMGenerator, PostProcessing, WebGPURenderer } from 'three/webgpu'
import { pass } from 'three/tsl'
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js'
import { DemoScenery } from './demo-scenery'
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

export class UseThreeDemo {
  private container: HTMLElement
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private renderer: WebGPURenderer | null = null
  /** 后期管线:场景色 + 泛光。走它渲染才有效果,直接 renderer.render 会绕过 bloom */
  private postProcessing: PostProcessing | null = null
  /** bloom 节点(暴露给调试脚本运行时调 strength/threshold) */
  private bloomPass: ReturnType<typeof bloom> | null = null
  private controls: OrbitControls | null = null
  private animateId: number | null = null
  /** 太阳方向光(阴影来源)。方位需与 HDRI 里的太阳一致,见 applyHdriEnvironment */
  private dirLight: THREE.DirectionalLight | null = null
  /** HDRI 贴图(同时用作背景与环境光),销毁时要显式释放 */
  private hdriTexture: THREE.Texture | null = null
  /**
   * demo 侧的布景层(城市 / 自然 / 标线 / 地标)—— 纯 three,不进库。
   * 见 demo-scenery.ts:它只往场景里加可看的东西,并把建筑/地标的 AABB 交给 demo 写进 sim.obstacles。
   */
  private scenery: DemoScenery | null = null
  droneFly?: DroneFly
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
   * 采集服务:控制面板(全景拍摄)与采集面板共用同一份。
   * 公开字段:验证脚本经它断言全景拍摄的入库结果。
   */
  captureService: CaptureService | null = null
  /**
   * 库提供的影像采集面板(左下:采集会话 / 虚拟采集 / 真实照片导入 / 影像集 / 导出)。
   * 公开字段:验证脚本要经它拿到 CaptureService 做编程式采集与导出断言。
   */
  capturePanel: DroneCapturePanel | null = null
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

  async init(): Promise<void> {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x87ceeb)

    // 场景内容层:demo 自己用 three 搭的布景(城市建筑群 / 树林 / 远山 / 起飞坪+跑道+道路 / 铁塔拱门雕塑)。
    // 与库的沙盒骨架(底板 + 网格 + 返航点 + 参考障碍物)完全解耦:这里删掉,沙盒功能一切照旧。
    // 只建一次,不随机体切换重建(切换的是飞机,不是世界);带 ?scenery=0 可关掉。
    const withScenery = new URLSearchParams(window.location.search).get('scenery') !== '0'
    if (withScenery) {
      this.scenery = new DemoScenery(this.scene)
    }

    const width = this.container.clientWidth
    const height = this.container.clientHeight

    this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000)
    this.camera.position.set(4, 4, 5)

    this.renderer = new WebGPURenderer({ antialias: true })
    await this.renderer.init()
    this.renderer.setSize(width, height)
    this.renderer.shadowMap.enabled = true
    this.container.appendChild(this.renderer.domElement)

    // 轨道控制器
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
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
    dirLight.shadow.bias = -0.0005
    this.scene.add(dirLight)
    this.dirLight = dirLight

    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0

    // 先给中性影棚底光,保证首帧金属机体就有正确反射;
    // 再异步升级到真实户外 HDRI(2k 8MB,不阻塞首帧,加载完自动替换)。
    this.applyFallbackEnvironment()
    void this.applyHdriEnvironment()

    // 后期管线:场景色 + 泛光。pass 渲到 HDR 线性缓冲(材质级 toneMapped 标志在 RT 路径下不生效,
    // ACES 改由输出级统一做)—— LED 亮核(core 增益后线性 >1)溢出光晕,白色壳体(<threshold)不受影响。
    // 相机/场景实例在机体切换(switchBody 整套销毁重建)时保持不变,管线只需建一次。
    const scenePass = pass(this.scene, this.camera)
    const sceneColor = scenePass.getTextureNode()
    this.bloomPass = bloom(sceneColor, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD)
    this.postProcessing = new PostProcessing(this.renderer)
    this.postProcessing.outputNode = sceneColor.add(this.bloomPass)

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

    window.addEventListener('resize', this.onResize.bind(this))
    this.animate()
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
    const pmrem = new PMREMGenerator(renderer)
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
      // 压一点环境:0.85 留出阴影对比度;给满 1.0 时天空漫射会把长影洗灰
      scene.environmentIntensity = 0.85
      scene.background = tex
      scene.backgroundIntensity = 1
      // 雾色取 HDRI 地平线的暖灰:远景没入大气而不是被生硬切断。
      // 只在 HDRI 生效时加 —— 影棚兜底场景加雾反而怪。
      scene.fog = new THREE.FogExp2(0xc9b8a3, 0.0009)
      this.hdriTexture = tex
    } catch {
      // 保持 RoomEnvironment 兜底,静默失败:天空贴图不该阻断整个 demo
    }
  }

  /** 机型来源:不传 url = 用库内置的哈士奇机体(见 DroneFly.initialize) */
  public async InitdRroneFly(url?: string, kind: BodyKind = url ? 'glb' : 'husky'): Promise<void> {
    this.bodyKind = kind
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

    // 上电:走完自检 → 预热 → 待机,面板上「起飞」随即可用(真机也是先开机再用遥控器)
    fly.powerOn()
    // 展开机臂:「机臂已展开」是起飞前检查的阻塞项,真机也得先展臂(面板上也有对应按钮)
    fly.setArmsFolded(false)

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

      if (keepMode === 'orbit' && camPos && camTarget && this.camera && this.controls) {
        this.camera.position.copy(camPos)
        this.controls.target.copy(camTarget)
        this.controls.update()
      } else {
        this.droneFly?.setCameraMode(keepMode)
      }

      this.onBodyChange?.(next)
      return next
    } finally {
      this.switching = false
    }
  }

  /** 拆掉飞行相关的一切(面板 + 鹰眼图 + 引擎);模型/灯光/雷达/世界的释放都在 DroneFly.destroy 里 */
  private teardownFlight(): void {
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

  private onResize(): void {
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
    window.removeEventListener('resize', this.onResize.bind(this))

    this.controls?.dispose()

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
