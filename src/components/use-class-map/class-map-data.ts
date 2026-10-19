/**
 * 「类与方法调用图」的数据源。
 *
 * 成员数量与关键方法名全部取自构建产物 `drone-camera/lib/*.d.ts`,
 * 与对外公开 API 严格一致(不是从源码里手抄的近似值)。
 */

export type LayerId = 'panel' | 'contract' | 'backend' | 'core' | 'image'

export interface LayerMeta {
  id: LayerId
  label: string
  color: string
  desc: string
}

export const LAYERS: LayerMeta[] = [
  { id: 'panel', label: '交互层', color: '#8f7bff', desc: '原生 DOM / Canvas，框架无关' },
  { id: 'contract', label: '契约层', color: '#f0b429', desc: '面板只认能力，不认引擎' },
  { id: 'backend', label: '渲染后端', color: '#35c2d6', desc: 'three / Cesium 两套实现' },
  { id: 'core', label: '飞行内核', color: '#4ade80', desc: '零运行时依赖的确定性逻辑' },
  { id: 'image', label: '影像链路', color: '#f472b6', desc: '采集 / 拼接 / 浏览' },
]

export interface ClassDoc {
  id: string
  name: string
  file: string
  layer: LayerId
  kind?: 'factory'
  role: string
  /** 公开成员总数(含构造器与只读属性)，来自 .d.ts */
  total: number
  /** 图上展示的关键方法(不是全部) */
  keyMethods: string[]
  /** 这个类为什么存在 / 为什么这样分层 */
  detail: string
}

export interface ChainStep {
  doc: ClassDoc
  /** 这一步真正被调用的方法 */
  methods: string[]
  /** 分支提示：同为下一步的另一套实现 */
  alt?: string
}

export interface ChainDoc {
  id: string
  title: string
  subtitle: string
  steps: ChainStep[]
  note: string
}

export const CLASSES: ClassDoc[] = [
  // ── 交互层 ──────────────────────────────────────────────
  {
    id: 'control-panel',
    name: 'DroneControlPanel',
    file: 'drone-panel.ts',
    layer: 'panel',
    role: '飞控主面板：起飞 / 降落 / 返航、虚拟摇杆、云台俯仰、拍照录像、视角切换',
    total: 8,
    keyMethods: ['mount', 'sync', 'setVisible', 'setCollapsed'],
    detail:
      '构造时接收的是 DronePanelHost 而不是 DroneFly，所以 three 与 Cesium 两套后端共用同一个面板。面板用 200ms 轮询 sync() 读真值，不参与渲染循环，也不会被拍进成片。',
  },
  {
    id: 'mission-panel',
    name: 'MissionPanel',
    file: 'mission-panel.ts',
    layer: 'panel',
    role: '航线面板：航点表、任务参数、执行控制、场景编辑开关、经纬度 / XYZ 切换',
    total: 7,
    keyMethods: ['mount', 'sync', 'setVisible', 'destroy'],
    detail:
      '只依赖 MissionPanelHost。序列化(JSON / CSV)下沉在 drone-sim，两个后端共用一份导出格式，不必各写一遍。经纬度开关由 supportsGeoCoordinates() 决定是否出现，three 后端会自动隐藏。',
  },
  {
    id: 'capture-panel',
    name: 'DroneCapturePanel',
    file: 'drone-capture-panel.ts',
    layer: 'panel',
    role: '采集面板：会话、单拍 / 定时 / 定距、真实照片导入、会话导出',
    total: 11,
    keyMethods: ['mount', 'sync', 'openGallery', 'exportSession'],
    detail:
      '面板只留入口按钮，影像浏览与一键合成都在 DroneGallery 弹窗里。拍摄本身不直接碰相机，而是交给 CaptureService，保证虚拟采集与真实导入共用同一套数据结构。',
  },
  {
    id: 'minimap',
    name: 'DroneMiniMap',
    file: 'drone-minimap.ts',
    layer: 'panel',
    role: 'Canvas 2D 鹰眼图：俯视小地图、航点与航线、返回点',
    total: 11,
    keyMethods: ['render', 'setRange', 'getStats', 'destroy'],
    detail:
      '只读 sim 快照自行投影，不碰 renderer / 场景 / 相机，因此永远不会混进拍照与录像的成片。自带 requestAnimationFrame，与面板的 200ms 轮询是两套独立节奏。',
  },

  // ── 契约层 ──────────────────────────────────────────────
  {
    id: 'panel-host',
    name: 'DronePanelHost',
    file: 'drone-control.ts',
    layer: 'contract',
    role: '控制面板 / 鹰眼图所需的 26 项飞行能力契约',
    total: 26,
    keyMethods: ['setStick', 'takeOff', 'setGimbalPitch', 'requestPhoto', 'getCaptureCamera'],
    detail:
      'DroneFly 含 private 成员，按 TS 的类兼容规则，外部渲染器的控制器长得再像也赋不过去。于是把面板真正用到的那部分能力提成公开接口，DroneFly 与 CesiumDroneAdapter 各自实现，换后端时面板一行都不用改。',
  },
  {
    id: 'mission-host',
    name: 'MissionPanelHost',
    file: 'drone-control.ts',
    layer: 'contract',
    role: '航线面板所需的 28 项能力契约',
    total: 28,
    keyMethods: ['startMission', 'setMission', 'updateMissionWaypoint', 'exportMission', 'getWaypointGeo'],
    detail:
      '执行语义(起飞、过点、完成动作、循环)全部由 DroneSim 定义，两个后端只负责把真值变成画面。getWaypointGeo / setWaypointGeo 是可选的：Cesium 能切经纬度，three 返回 false，面板就不显示开关。',
  },

  // ── 渲染后端 ────────────────────────────────────────────
  {
    id: 'fly',
    name: 'DroneFly',
    file: 'drone-fly.ts',
    layer: 'backend',
    role: 'three.js + WebGPURenderer 飞行沙盒，同时实现两个面板契约',
    total: 88,
    keyMethods: ['initialize', 'animate', 'setStick', 'requestPhoto', 'getSnapshot'],
    detail:
      '装配总控：把 world / rig / lights / radar / mission-editor 装成一台可飞的无人机。每帧 animate() 推进 sim，再把真值写进场景。宿主渲染循环的顺序是 captureRecordingFrame → onBeforeRender → render → onAfterRender。',
  },
  {
    id: 'cesium',
    name: 'CesiumDroneAdapter',
    file: 'drone-cesium.ts',
    layer: 'backend',
    role: 'Cesium 地球坐标系适配器(ENU / ECEF)，同时实现两个面板契约',
    total: 75,
    keyMethods: ['start', 'getGeo', 'setStick', 'requestPhoto', 'setWaypointGeo'],
    detail:
      '飞行内核仍是同一个 DroneSim，区别只在「真值怎么变成画面」：坐标换轴、每帧写 modelMatrix、接管相机、拍照取景。Cesium 本体不随库打包，由使用方 loadCesiumScript() 注入。',
  },
  {
    id: 'mission-editor',
    name: 'MissionEditor',
    file: 'mission-editor.ts',
    layer: 'backend',
    role: 'three 场景内的航线拖拽编辑',
    total: 7,
    keyMethods: ['setEnabled', 'update', 'getState', 'deleteWaypoint'],
    detail:
      '交互约定与 Cesium 版 drone-cesium-mission 完全一致：拖拽移动、Shift 改高、Alt 细调、双击插入、Delete 删除、Esc 取消选中。面板只展示结果，「当前能否编辑」由实现方判定。',
  },
  {
    id: 'rig',
    name: 'DroneRig',
    file: 'drone-rig.ts',
    layer: 'backend',
    role: '机体装配：机臂折叠、起落架、桨叶、云台链',
    total: 17,
    keyMethods: ['setArmFold', 'setLegDeploy', 'updateProps', 'getGimbalCameraTransform'],
    detail:
      '按语义节点命名工作，换模型不换代码；云台相机的世界位姿从这里取，采集服务记录的正是这台取景相机而不是机身。',
  },
  {
    id: 'world',
    name: 'DroneWorld',
    file: 'drone-world.ts',
    layer: 'backend',
    role: '地面 / 障碍物 / 轨迹 / 航线拾取',
    total: 22,
    keyMethods: ['coneCast', 'pickMissionWaypoint', 'pushTrail', 'setObstaclesVisible'],
    detail:
      '避障判定所需的 AABB 与视线锥检测都在这里；航线编辑的点选与地面拾取也复用它，避免面板层直接接触 three 的 Raycaster。',
  },
  {
    id: 'lights',
    name: 'DroneLights',
    file: 'drone-lights.ts',
    layer: 'backend',
    role: '机体灯光：状态灯图案、电池指示灯、补光灯',
    total: 13,
    keyMethods: ['attach', 'update', 'setStatusPattern', 'setBatteryLevel'],
    detail:
      '只用模型自带的灯珠发光，不额外造光源；左红右绿 500ms 交替，边缘保留原色、中心过曝。Cesium 侧由 drone-cesium-rig 用 Billboard 光晕复刻同一套语义。',
  },
  {
    id: 'radar',
    name: 'DroneRadar',
    file: 'drone-radar.ts',
    layer: 'backend',
    role: '测距雷达：波束、目标距离、瞄准方向',
    total: 13,
    keyMethods: ['update', 'setAim', 'getSnapshot', 'bindSensors'],
    detail:
      '只负责算距离与方向并给出快照，HUD 由面板绘制；bindSensors 让雷达可以绑定到任意带世界坐标的传感器节点上。',
  },

  // ── 飞行内核 ────────────────────────────────────────────
  {
    id: 'sim',
    name: 'DroneSim',
    file: 'drone-sim.ts',
    layer: 'core',
    role: '飞控状态机、电池模型、定位、失效保护、航线执行',
    total: 66,
    keyMethods: ['step', 'setStick', 'takeOff', 'startMission', 'spinTo', 'snapshot'],
    detail:
      '全库唯一零运行时依赖的模块，Node / Worker 里可以直接跑。起飞、返航、航线过点、全景自转这些语义都在这里定义，渲染后端只是把它的真值画出来。',
  },

  // ── 影像链路 ────────────────────────────────────────────
  {
    id: 'capture',
    name: 'CaptureService',
    file: 'drone-capture.ts',
    layer: 'image',
    role: '采集会话 + 影像数据契约(CapturedImage / 位姿 / 内参)',
    total: 22,
    keyMethods: ['createSession', 'captureVirtualImage', 'startAutoCapture', 'exportSession'],
    detail:
      '虚拟采集与真实照片导入共用同一个 CapturedImage。位姿记录的是「取景相机」而非机身：先 await requestPhoto()，再读 getCaptureCamera()，顺序反了会拿到上一帧的位姿。',
  },
  {
    id: 'panorama',
    name: 'PanoramaCapture',
    file: 'drone-panorama.ts',
    layer: 'image',
    role: '全景分层拍摄编排：广角 9 张 / 180° 21 张 / 360° 36 张',
    total: 8,
    keyMethods: ['start', 'subscribe', 'cancel', 'buildGroup'],
    detail:
      'Mini 4 Pro 云台 Pan 只有 ±30°，水平覆盖靠机体原地自转(spinBodyTo)，云台只做俯仰分层。360° 预设是 12 方位 × 3 俯仰，每张都带全景元数据入库。',
  },
  {
    id: 'stitch',
    name: 'EquirectStitcher',
    file: 'drone-stitch.ts',
    layer: 'image',
    role: '等距柱状拼接：按已知位姿逐像素反投影',
    total: 2,
    keyMethods: ['stitch'],
    detail:
      '不需要特征匹配 / SfM / OpenCV —— 位姿是这条采集链路的免费红利。输出 3600×1800，之后两步补边：先横向(行内)，再纵向(天顶 / 天底与中间整行空隙)。',
  },
  {
    id: 'gallery',
    name: 'DroneGallery',
    file: 'drone-gallery.ts',
    layer: 'image',
    role: '影像集弹窗：按组合分组浏览、一键合成、开球面全景',
    total: 9,
    keyMethods: ['open', 'refresh', 'stitch', 'stitchAll'],
    detail:
      '弹窗挂 body，键盘走捕获阶段，弹窗开着时按 WASD 不会把无人机飞出去。合成调用注入的 PanoramaStitcher，默认实现就是 EquirectStitcher。',
  },
  {
    id: 'pano-viewer',
    name: 'DronePanoramaViewer',
    file: 'drone-panorama-viewer.ts',
    layer: 'image',
    role: '球面全景查看器：手写 WebGL 反投影，把等距柱状图贴回球面',
    total: 8,
    keyMethods: ['open', 'view', 'reset', 'download'],
    detail:
      '零依赖，不引 three：2:1 长条只是存储格式，拖动环视时每像素按经纬度反投影到球面，边缘 CLAMP_TO_EDGE 回绕，接缝与极点不露黑线。',
  },
  {
    id: 'image-viewer',
    name: 'DroneImageViewer',
    file: 'drone-image-viewer.ts',
    layer: 'image',
    role: '影像大图弹窗：翻页、下载、元数据',
    total: 9,
    keyMethods: ['open', 'step', 'jump', 'download'],
    detail: '被影像集弹窗复用；翻页只改索引，不重建 DOM，所以连按方向键也不会闪。',
  },

  // ── 装配入口 ────────────────────────────────────────────
  {
    id: 'factory',
    name: 'createDroneControl()',
    file: 'drone-engine.ts',
    layer: 'backend',
    kind: 'factory',
    role: '引擎装配工厂：一组参数选后端，返回 DroneEngineHost',
    total: 1,
    keyMethods: ['createDroneControl'],
    detail:
      '库里有两套完整控制器，选后端这件事只该发生一次，就在这里。engine 缺省为 three；返回类型是 DronePanelHost 加 engine 判别字段，需要引擎特有成员时再用判别字段收窄。',
  },
]

const BY_ID = new Map(CLASSES.map((cls) => [cls.id, cls]))

function step(classId: string, methods: string[], alt?: string): ChainStep {
  const doc = BY_ID.get(classId)
  if (!doc) throw new Error(`类图数据缺少 classId: ${classId}`)
  return alt ? { doc, methods, alt } : { doc, methods }
}

export const CHAINS: ChainDoc[] = [
  {
    id: 'flight',
    title: '飞行控制',
    subtitle: '摇杆 / 按钮 → 契约 → 后端 → 内核',
    steps: [
      step('control-panel', ['mount', 'sync']),
      step('panel-host', ['setStick', 'takeOff', 'setGimbalPitch']),
      step('fly', ['setStick', 'animate', 'getSnapshot']),
      step('sim', ['setStick', 'step', 'snapshot']),
    ],
    note: '摇杆是连续量：面板写入 → 后端 setStick → 每帧 sim.step() 积分 → 面板 200ms 轮询 snapshot() 回读。',
  },
  {
    id: 'mission',
    title: '航线任务',
    subtitle: '航点表 / 场景拖拽 → 契约 → 编辑器 → 内核',
    steps: [
      step('mission-panel', ['sync', 'startMission', 'updateMissionWaypoint']),
      step('mission-host', ['setMission', 'startMission', 'updateMissionWaypoint']),
      step('mission-editor', ['setEnabled', 'update', 'getState']),
      step('sim', ['startMission', 'step', 'missionProgress']),
    ],
    note: '场景拖拽每帧调用 updateMissionWaypoint；导出走 getMissionExport → exportMission，序列化实现在 drone-sim，两后端共用。',
  },
  {
    id: 'capture',
    title: '影像采集',
    subtitle: '拍摄 → 会话 → 全景编排 → 拼接 → 影像集',
    steps: [
      step('capture-panel', ['mount', 'sync']),
      step('capture', ['captureVirtualImage', 'startAutoCapture', 'exportSession']),
      step('panorama', ['start', 'subscribe', 'buildGroup']),
      step('stitch', ['stitch']),
      step('gallery', ['open', 'stitch', 'stitchAll']),
    ],
    note: '360° 全景 = 12 方位 × 3 俯仰 36 张；拼接按每张的 cameraPose 反投影，成片在影像集里点开球面查看器。',
  },
  {
    id: 'engine',
    title: '引擎装配',
    subtitle: '一处选后端，两套实现落到同一个内核',
    steps: [
      step('factory', ['createDroneControl']),
      step('fly', ['initialize'], 'CesiumDroneAdapter.start()'),
      step('sim', ['step', 'snapshot']),
    ],
    note: 'engine 缺省 three；Cesium 分支只是把 DroneFly 换成 CesiumDroneAdapter，飞行内核仍是同一个 DroneSim。',
  },
]

/** 全部类的公开成员总数，页头统计用 */
export const TOTAL_MEMBERS = CLASSES.reduce((sum, cls) => sum + cls.total, 0)

/* ── Vue Flow 画布节点数据 ───────────────────────────────── */

/** 类节点：doc + 本链路里被调到的方法 */
export interface ClassNodeData {
  kind: 'class'
  doc: ClassDoc
  methods: string[]
  alt?: string
}

/** 泳道标题节点：只做标注，不可拖、不可选 */
export interface LaneNodeData {
  kind: 'lane'
  title: string
  subtitle: string
  note: string
  color: string
}

export type CanvasNodeData = ClassNodeData | LaneNodeData

