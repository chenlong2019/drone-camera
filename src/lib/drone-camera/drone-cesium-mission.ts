/**
 * Cesium 航线表现层 + 场景内航点编辑器 —— 与 three 版 `mission-editor.ts`(拖动求解)
 * 和 `drone-world.ts`(航点标记/航线折线)合起来对应的那一层。
 *
 * ─── 为什么不直接复用 three 的 MissionEditor ────────────────────────────
 * three 的编辑器整层建立在 THREE.Raycaster × 场景图拾取之上(射线打光柱/地面环),
 * 而 Cesium 侧没有场景图可打:拾取走 `scene.pick`(实体)、求交走相机射线。
 * 交互约定则**逐条对齐**(拖拽=水平面内移动、Shift=改高、Alt=细调、双击地面插入、
 * Delete=删除、Esc=取消选中、3px 阈值区分点击与拖动、插入位用最小绕路法)——
 * 两个后端的"航线编辑手感"因此一致,用户换渲染器不需要重新学。
 *
 * ─── 拖拽数学:屏幕空间增量,而不是射线求交 ─────────────────────────────
 * Cesium 的 `pickEllipsoid` 只打椭球(有地形时会和可视地面不一致)、`pickPosition`
 * 依赖深度缓冲(无地形时不可用),所以这里不跟"指针命中的世界点"较劲,改用
 * **屏幕像素增量 → ENU 米增量**的换算:
 *
 *   1. 取拖拽起点处"每像素多少米":mpp = 2·dist·tan(fovy/2) / 画布高,
 *      dist = 相机到该航点的距离(fovy 取 `camera.frustum.fovy`);
 *   2. 相机的右向(`rightWC`)与前向(`directionWC`)投影到 ENU 水平面(东/北),
 *      得到屏幕 x/y 轴在水平面上的单位方向;
 *   3. 屏幕增量 (dx, dy) 按 mpp 放大、沿这两个方向分解,得到 ENU 位移;
 *      ENU 东 = sim +x,北 = sim −z(sim 的 z 向南为正)。
 *
 * 这样拖拽全程只依赖相机与画布,不依赖地形/拾取,任何视角下都不会跳点。
 * 改高度(Shift)更简单:dy·mpp 直接当米数(上拖加高)。
 *
 * ─── 事件拦截:容器捕获段 + stopPropagation ────────────────────────────
 * Cesium 的相机漫游监听挂在 canvas 上,且**注册得比本编辑器早**(viewer 先建)。
 * 若只在 canvas 上挂自己的 pointerdown,同目标监听器按注册序执行,Cesium 的
 * 先跑、相机已经开始转。所以本编辑器把指针事件挂在 `viewer.container` 的
 * **捕获段**:事件自窗口下行时先经过容器,命中航点要拖走时 `stopPropagation()`,
 * Cesium 的 canvas 监听器根本收不到这个事件,相机纹丝不动;点空白处则放行,
 * 观察者视角的平移/缩放完全不受影响。
 *
 * ─── 拾取:屏幕投影就近判定,而不是 scene.pick ────────────────────────────
 * 实测(Cesium 1.144)entity point 被 `scene.pick` 命中时返回的是批量图元包装对象
 * `{ primitive, collection, id }`(collection 里混着全部点图元、id 也不是实体 id),
 * 拿不到"哪个航点"。所以拾取改为几何法:把每个航点投到屏幕
 * (`cartesianToCanvasCoordinates`),指针落在标记 PICK_RADIUS_PX 内取最近的那个。
 * 好处:不依赖 Cesium 的拾取语义与深度剔除,合成事件与真实点击走同一条路,
 * 行为完全确定;代价是点被建筑挡住时也点得到(航点标记本就常显,可接受)。
 *
 * ─── 实体约定 ──────────────────────────────────────────────────────────
 * - 航点:`dc-mission-wp-<i>`(point + label,序号从 1 开始);
 * - 航线:`dc-mission-path`(polyline,PolylineGlow 材质);
 * - 返航点:`dc-mission-home`(point + label,常驻);
 * - 状态配色:默认青、选中琥珀、执行目标红、悬停放大一圈。
 * 位置只在"航点签名变化"时重写(拖动单点走 moveWaypoint 后签名也变),不逐帧刷。
 */
import { findMissionInsertIndex } from './drone-sim'
import type { DroneSim, MissionWaypoint } from './drone-sim'
import type { MissionDragMode, MissionEditLimits, MissionEditState } from './mission-editor'

/** Cesium 由 /Cesium/Cesium.js 以全局脚本注入,这里只做一层薄封装取引用 */
type CesiumNS = Record<string, any>

/** 航点实体 id 前缀(完整 id = 前缀 + 序号) */
const ENTITY_WAYPOINT_PREFIX = 'dc-mission-wp-'
/** 航线折线实体 id */
const ENTITY_PATH_ID = 'dc-mission-path'
/** 返航点实体 id */
const ENTITY_HOME_ID = 'dc-mission-home'

/** 拖动判定阈值(像素):小于它算"点击选中"而不是拖动(与 three 版一致) */
const DRAG_THRESHOLD_PX = 3
/** 航点拾取半径(像素):指针落在标记这么大的范围内算命中(就近取最近) */
const PICK_RADIUS_PX = 14
/** 默认吸附步长(米);按住 Alt 时用微调步长(与 three 版一致) */
const SNAP_STEP = 1
const SNAP_STEP_FINE = 0.2

/** 状态配色(与 dmp 面板的 CSS 变量同语言:accent 青 / warn 琥珀 / danger 红) */
const COLOR_WAYPOINT = '#38bdf8'
const COLOR_WAYPOINT_OUTLINE = '#04121f'
const COLOR_WAYPOINT_SELECTED = '#ffc53d'
const COLOR_WAYPOINT_ACTIVE = '#ff5f5f'
const COLOR_PATH = '#38bdf8'
const COLOR_HOME = '#3ddc97'
/** 序号标签配色 */
const COLOR_LABEL = '#e9eff9'
const COLOR_LABEL_BG = 'rgba(4, 18, 31, 0.62)'
const COLOR_HOME_LABEL = '#bfe9d6'

/**
 * 指针捕获的安全封装(与 mission-editor.ts 同名辅助函数同一形态,本地复制:
 * 本文件不能值导入 three 侧模块,否则把 three 拖进 Cesium 运行时依赖)。
 *
 * ⚠️ Chromium 起 setPointerCapture / releasePointerCapture 返回 **Promise**:
 * 指针已失效时是异步 reject —— 调用处的 try/catch 捕不到,会冒成未处理 rejection。
 */
function capturePointer(canvas: HTMLCanvasElement, pointerId: number): void {
  try {
    const result: unknown = canvas.setPointerCapture(pointerId)
    if (result && typeof (result as Promise<void>).catch === 'function') {
      ;(result as Promise<void>).catch(() => {})
    }
  } catch {
    /* 指针已释放,同步抛错 */
  }
}

function releasePointer(canvas: HTMLCanvasElement, pointerId: number): void {
  try {
    const result: unknown = canvas.releasePointerCapture(pointerId)
    if (result && typeof (result as Promise<void>).catch === 'function') {
      ;(result as Promise<void>).catch(() => {})
    }
  } catch {
    /* 没捕获过,同步抛错 */
  }
}

/**
 * 编辑器依赖的宿主接口(由 CesiumDroneAdapter 实现):
 * 航点数据以仿真内核为权威源,编辑器只通过它读写,不含任何渲染细节。
 */
export interface CesiumMissionHost {
  /** 飞行内核:读 missionIndex(执行目标)等真值 */
  readonly sim: DroneSim
  /** 当前是否可编辑:观察者视角 + 航线未在执行 */
  canEdit(): boolean
  /** 航点列表(权威源 = 仿真内核) */
  getWaypoints(): MissionWaypoint[]
  /** 宿主查询当前选中航点索引(无选中返回 -1) */
  getSelected(): number
  /** 宿主同步选中航点(编辑器点击/面板列表双向联动) */
  setSelected(index: number): void
  /** 整表提交(新增 / 删除) */
  commitWaypoints(waypoints: Array<Partial<MissionWaypoint>>, selected: number): void
  /** 拖动中的单点实时更新,返回夹紧后的航点(限高限距由宿主/内核生效) */
  moveWaypoint(index: number, patch: Partial<MissionWaypoint>): MissionWaypoint | null
  /** 新航点的默认参数(高度与速度继承相邻航点) */
  newWaypointTemplate(index: number): Partial<MissionWaypoint>
  /** 取编辑限制(限高/限距/返航点,供夹紧与插入位计算) */
  getLimits(): MissionEditLimits
  /** sim 本地米坐标(x 东 / z 南 / y 为 AGL)→ ECEF 世界坐标 */
  localToWorld(x: number, y: number, z: number): CesiumNS
  /** ECEF 世界坐标 → sim 本地水平坐标(双击拾取用);打不中返回 null */
  worldToLocalXZ(world: CesiumNS): { x: number; z: number } | null
  /** 拖拽期间收起 / 恢复 Cesium 相机漫游输入 */
  setCameraInputEnabled(enabled: boolean): void
  /** 编辑日志出口(宿主接到 sim.pushEvent) */
  log(level: 'info' | 'warn', text: string): void
}

/** 拖动状态:屏幕空间增量法只需要起点坐标与起点时的航点值 */
interface DragState {
  index: number
  mode: MissionDragMode
  pointerId: number
  startClientX: number
  startClientY: number
  startX: number
  startZ: number
  startAltitude: number
  moved: boolean
  /** 起点处的东 / 北单位向量(世界坐标,拖动全程不变) */
  east: CesiumNS
  north: CesiumNS
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function snap(value: number, step: number): number {
  return Math.round(value / step) * step
}

/**
 * CSS 颜色串 → Cesium.Color。
 *
 * ⚠️ 必须转:实测 entity 图形属性(point.color / label.fillColor / outlineColor 等)
 * **不吃 CSS 字符串** —— 赋值后 Property 里存的是原样字符串,可视化器按 Color 取用时
 * 得到垃圾值,点会渲染成纯黑、标签直接不显示(红色对照点用 Color.RED 则完全正常)。
 * 所以所有颜色在进实体前统一过一遍本函数。
 */
function cssColor(C: CesiumNS, css: string): CesiumNS {
  return C.Color.fromCssColorString(css)
}

/**
 * Cesium 航线编辑器:航点/航线实体渲染 + 场景内拖拽编辑。
 *
 * 用法:构造传入宿主 → 每帧 `update()` → 面板开关 `setEnabled()` → 卸载 `destroy()`。
 * 交互约定与 three 版 MissionEditor 一致,见文件头。
 */
export class CesiumMissionEditor {
  private readonly host: CesiumMissionHost
  private readonly C: CesiumNS
  private readonly viewer: CesiumNS
  /** 事件挂在 viewer.container 的捕获段(见文件头"事件拦截") */
  private readonly container: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private enabled = false
  private hoverIndex = -1
  private drag: DragState | null = null
  /** 在空白处按下:抬手时若没拖动过就取消选中 */
  private emptyClick: { x: number; y: number } | null = null
  /** 上次同步过的航点签名:没变就不碰实体 */
  private waypointSignature = ''
  /** 上次同步过的返航点(起飞后才固定,之前可能还是 0,0) */
  private homeKey = ''
  /** 状态视觉(选中/执行目标)上次的值,变了才改实体 */
  private lastSelected = -2
  private lastActive = -2
  private lastHover = -2
  private disposed = false

  constructor(host: CesiumMissionHost, C: CesiumNS, viewer: CesiumNS) {
    this.host = host
    this.C = C
    this.viewer = viewer
    this.container = viewer.container as HTMLElement
    this.canvas = viewer.canvas as HTMLCanvasElement
    // 捕获段挂容器:先于 canvas 上的 Cesium 漫游监听器拿到事件,才能拦掉拖拽时的相机转动
    this.container.addEventListener('pointerdown', this.onPointerDown, { capture: true })
    this.container.addEventListener('pointermove', this.onPointerMove, { capture: true })
    this.container.addEventListener('pointerup', this.onPointerUp, { capture: true })
    this.container.addEventListener('pointercancel', this.onPointerUp, { capture: true })
    this.container.addEventListener('pointerleave', this.onPointerLeave, { capture: true })
    this.container.addEventListener('dblclick', this.onDoubleClick, { capture: true })
    window.addEventListener('keydown', this.onKeyDown)
  }

  // ───────────────────────────── 开关与状态 ─────────────────────────────

  /** 编辑模式是否开启(开启时点场景可加/拖航点) */
  get isEnabled(): boolean {
    return this.enabled
  }

  /** 开关编辑模式;关闭时取消拖动、归还相机输入、清悬停 */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) {
      this.cancelDrag()
      this.hoverIndex = -1
      this.canvas.style.cursor = ''
    }
  }

  /** 编辑器对外状态快照(面板"场景内编辑"区块据此渲染) */
  getEditState(): MissionEditState {
    return {
      enabled: this.enabled,
      active: this.editable(),
      selectedIndex: this.host.getSelected(),
      hoverIndex: this.hoverIndex,
      dragging: this.drag !== null,
      mode: this.drag?.mode ?? null,
    }
  }

  private editable(): boolean {
    return this.enabled && this.host.canEdit()
  }

  // ───────────────────────────── 每帧同步 ─────────────────────────────

  /** 每帧调用:签名变了才重建实体位置,选中/执行目标变化才改配色 */
  update(): void {
    if (this.disposed) return
    this.syncEntities()
    this.syncStateVisuals()
  }

  /** 航点签名(坐标串)或返航点变了才动实体,避免逐帧重写 */
  private syncEntities(): void {
    const waypoints = this.host.getWaypoints()
    const signature = waypoints
      .map((wp) => `${wp.x.toFixed(2)},${wp.z.toFixed(2)},${wp.altitude.toFixed(2)}`)
      .join(';')
    const home = this.host.sim.homePosition
    const homeKey = `${home.x.toFixed(2)},${home.z.toFixed(2)}`
    if (signature === this.waypointSignature && homeKey === this.homeKey) return
    this.waypointSignature = signature
    this.homeKey = homeKey
    this.rebuildWaypointEntities(waypoints)
    this.rebuildPathEntity(waypoints)
    this.rebuildHomeEntity(home)
    // 实体换了,状态视觉的"上次值"作废,强制重刷一次
    this.lastSelected = -2
    this.lastActive = -2
    this.lastHover = -2
  }

  private rebuildWaypointEntities(waypoints: MissionWaypoint[]): void {
    // 先摘掉多出来的实体(航点被删)
    for (let index = waypoints.length; ; index += 1) {
      const stale = this.viewer.entities.getById(ENTITY_WAYPOINT_PREFIX + index)
      if (!stale) break
      this.viewer.entities.remove(stale)
    }
    waypoints.forEach((waypoint, index) => {
      const id = ENTITY_WAYPOINT_PREFIX + index
      const position = this.host.localToWorld(waypoint.x, waypoint.altitude, waypoint.z)
      const existing = this.viewer.entities.getById(id)
      if (existing) {
        existing.position = position
        return
      }
      this.viewer.entities.add({
        id,
        position,
        // point 而不是 billboard:零贴图依赖,且天然参与 scene.pick(点击选中靠它)
        point: {
          pixelSize: 9,
          color: cssColor(this.C, COLOR_WAYPOINT),
          outlineColor: cssColor(this.C, COLOR_WAYPOINT_OUTLINE),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: String(index + 1),
          font: '12px sans-serif',
          pixelOffset: { x: 12, y: -12 },
          fillColor: cssColor(this.C, COLOR_LABEL),
          showBackground: true,
          backgroundColor: cssColor(this.C, COLOR_LABEL_BG),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    })
  }

  private rebuildPathEntity(waypoints: MissionWaypoint[]): void {
    const existing = this.viewer.entities.getById(ENTITY_PATH_ID)
    if (waypoints.length < 2) {
      if (existing) this.viewer.entities.remove(existing)
      return
    }
    const positions = waypoints.map((wp) => this.host.localToWorld(wp.x, wp.altitude, wp.z))
    if (existing) {
      // 直接赋值数组即可:Cesium 的属性描述符会把它包成 ConstantProperty
      existing.polyline.positions = positions
      return
    }
    this.viewer.entities.add({
      id: ENTITY_PATH_ID,
      polyline: {
        positions,
        width: 2,
        // 发光材质:地球上一条淡青色的航线,和 dmp 面板 accent 色同语言
        material: new this.C.PolylineGlowMaterialProperty({
          glowPower: 0.25,
          color: cssColor(this.C, COLOR_PATH),
        }),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }

  private rebuildHomeEntity(home: { x: number; z: number }): void {
    const existing = this.viewer.entities.getById(ENTITY_HOME_ID)
    const position = this.host.localToWorld(home.x, 0, home.z)
    if (existing) {
      existing.position = position
      return
    }
    this.viewer.entities.add({
      id: ENTITY_HOME_ID,
      position,
      point: {
        pixelSize: 7,
        color: cssColor(this.C, COLOR_HOME),
        outlineColor: cssColor(this.C, COLOR_WAYPOINT_OUTLINE),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: '返航点',
        font: '11px sans-serif',
        pixelOffset: { x: 10, y: -10 },
        fillColor: cssColor(this.C, COLOR_HOME_LABEL),
        showBackground: true,
        backgroundColor: cssColor(this.C, COLOR_LABEL_BG),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }

  /** 选中 / 执行目标 / 悬停 → 颜色与大小(只在变化时写实体) */
  private syncStateVisuals(): void {
    const selected = this.host.getSelected()
    // missionIndex = 当前目标航点;-1 = 无(未执行 / 已停止)
    const active = this.host.sim.missionStatus === 'idle' ? -1 : this.host.sim.missionIndex
    if (selected === this.lastSelected && active === this.lastActive && this.hoverIndex === this.lastHover) {
      return
    }
    this.lastSelected = selected
    this.lastActive = active
    this.lastHover = this.hoverIndex
    const count = this.host.getWaypoints().length
    for (let index = 0; index < count; index += 1) {
      const entity = this.viewer.entities.getById(ENTITY_WAYPOINT_PREFIX + index)
      if (!entity?.point) continue
      if (index === active) {
        entity.point.color = cssColor(this.C, COLOR_WAYPOINT_ACTIVE)
        entity.point.pixelSize = 12
      } else if (index === selected) {
        entity.point.color = cssColor(this.C, COLOR_WAYPOINT_SELECTED)
        entity.point.pixelSize = 12
      } else if (index === this.hoverIndex) {
        entity.point.color = cssColor(this.C, COLOR_WAYPOINT)
        entity.point.pixelSize = 11
      } else {
        entity.point.color = cssColor(this.C, COLOR_WAYPOINT)
        entity.point.pixelSize = 9
      }
    }
  }

  // ───────────────────────────── 显隐控制 ─────────────────────────────

  /** 航点标记 + 航线折线总显隐(由宿主的 setMissionVisible 转发) */
  setVisible(visible: boolean): void {
    const count = this.host.getWaypoints().length
    for (let index = 0; index < count; index += 1) {
      const entity = this.viewer.entities.getById(ENTITY_WAYPOINT_PREFIX + index)
      if (entity) entity.show = visible
    }
    const path = this.viewer.entities.getById(ENTITY_PATH_ID)
    if (path) path.show = visible
    const home = this.viewer.entities.getById(ENTITY_HOME_ID)
    if (home) home.show = visible
  }

  /** 航点标记显隐(不影响任务执行) */
  setWaypointsVisible(visible: boolean): void {
    const count = this.host.getWaypoints().length
    for (let index = 0; index < count; index += 1) {
      const entity = this.viewer.entities.getById(ENTITY_WAYPOINT_PREFIX + index)
      if (entity) entity.show = visible
    }
  }

  /** 航线折线显隐 */
  setPathVisible(visible: boolean): void {
    const path = this.viewer.entities.getById(ENTITY_PATH_ID)
    if (path) path.show = visible
  }

  // ───────────────────────────── 指针交互 ─────────────────────────────

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.editable() || event.button !== 0) return
    const index = this.pickWaypoint(event)
    if (index < 0) {
      // 空白处:交给 Cesium 漫游(不拦截),抬手没拖动就当取消选中
      this.emptyClick = { x: event.clientX, y: event.clientY }
      return
    }
    const waypoint = this.host.getWaypoints()[index]
    if (!waypoint) return
    this.emptyClick = null
    this.host.setSelected(index)
    this.drag = this.createDrag(event, index, waypoint)
    this.host.setCameraInputEnabled(false)
    this.canvas.style.cursor = event.shiftKey ? 'ns-resize' : 'grabbing'
    capturePointer(this.canvas, event.pointerId)
    // 命中航点要拖走:拦住事件,Canvas 上的 Cesium 漫游监听器收不到,相机不转
    event.stopPropagation()
    event.preventDefault()
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.enabled) return
    const drag = this.drag
    if (!drag) {
      const hover = this.editable() ? this.pickWaypoint(event) : -1
      if (hover !== this.hoverIndex) {
        this.hoverIndex = hover
        this.canvas.style.cursor = hover >= 0 ? 'grab' : ''
      }
      return
    }
    if (!drag.moved) {
      const moved = Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY)
      if (moved < DRAG_THRESHOLD_PX) return
      drag.moved = true
    }
    this.applyDrag(event, drag)
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    releasePointer(this.canvas, event.pointerId)
    const emptyClick = this.emptyClick
    this.emptyClick = null
    const drag = this.drag
    if (!drag) {
      if (
        emptyClick &&
        Math.hypot(event.clientX - emptyClick.x, event.clientY - emptyClick.y) < DRAG_THRESHOLD_PX
      ) {
        this.host.setSelected(-1)
      }
      return
    }
    this.drag = null
    this.host.setCameraInputEnabled(true)
    this.canvas.style.cursor = this.hoverIndex >= 0 ? 'grab' : ''
    if (!drag.moved) return
    const waypoint = this.host.getWaypoints()[drag.index]
    if (!waypoint) return
    this.host.log(
      'info',
      `场景编辑:航点 ${drag.index + 1} 已更新为 E ${waypoint.x.toFixed(0)} / S ${waypoint.z.toFixed(0)} / 高度 ${waypoint.altitude.toFixed(1)} m`,
    )
  }

  private readonly onPointerLeave = (): void => {
    if (!this.drag && this.hoverIndex !== -1) {
      this.hoverIndex = -1
      this.canvas.style.cursor = ''
    }
  }

  /** 双击地面新增航点(双击已有航点不处理,避免误插一个重合点) */
  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (!this.editable() || event.button !== 0) return
    if (this.pickWaypoint(event) >= 0) return
    const world = this.pickEllipsoid(event)
    const local = world ? this.host.worldToLocalXZ(world) : null
    if (!local) return
    const limits = this.host.getLimits()
    // 瞄到地平线附近时拾取点会跑到几公里外,先按限距拉回来(与 three 版同款夹紧)
    const offsetX = local.x - limits.homeX
    const offsetZ = local.z - limits.homeZ
    const distance = Math.hypot(offsetX, offsetZ)
    let x = local.x
    let z = local.z
    if (distance > limits.maxDistance) {
      const scale = limits.maxDistance / distance
      x = limits.homeX + offsetX * scale
      z = limits.homeZ + offsetZ * scale
    }
    x = snap(x, SNAP_STEP)
    z = snap(z, SNAP_STEP)

    const list = this.host.getWaypoints()
    const at = findMissionInsertIndex(list, x, z, limits.homeX, limits.homeZ)
    const template = this.host.newWaypointTemplate(at)
    const next: Array<Partial<MissionWaypoint>> = list.map((waypoint) => ({ ...waypoint }))
    next.splice(at, 0, { ...template, x, z })
    this.host.commitWaypoints(next, at)
    this.host.log('info', `场景编辑:在 E ${x.toFixed(0)} / S ${z.toFixed(0)} 新增航点 ${at + 1}(双击地面新增)`)
    // 拦住 Cesium 的双击默认行为(会把相机怼到拾取目标上)
    event.stopPropagation()
    event.preventDefault()
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled) return
    const target = event.target as HTMLElement | null
    if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
    if (event.key === 'Escape') {
      this.host.setSelected(-1)
      return
    }
    if (event.key !== 'Delete' && event.key !== 'Backspace') return
    const index = this.host.getSelected()
    if (index < 0) return
    // 浏览器默认会拿 Backspace 当"后退",先拦掉
    event.preventDefault()
    this.deleteWaypoint(index)
  }

  /** 删除一个航点(面板按钮与 Delete 键共用) */
  deleteWaypoint(index: number): boolean {
    if (!this.host.canEdit()) return false
    const list = this.host.getWaypoints()
    if (index < 0 || index >= list.length) return false
    const next = list.filter((_, i) => i !== index).map((waypoint) => ({ ...waypoint }))
    this.host.commitWaypoints(next, Math.min(index, next.length - 1))
    this.host.log('info', `场景编辑:已删除航点 ${index + 1}`)
    return true
  }

  // ───────────────────────────── 拖拽求解 ─────────────────────────────

  private createDrag(
    event: { clientX: number; clientY: number; shiftKey: boolean; pointerId: number },
    index: number,
    waypoint: MissionWaypoint,
  ): DragState {
    const C = this.C
    // 东 / 北单位向量:由 localToWorld 的两个微差推出(ENU 框架与高程基准都藏在宿主体内)
    const east = C.Cartesian3.subtract(
      this.host.localToWorld(1, 0, 0),
      this.host.localToWorld(0, 0, 0),
      new C.Cartesian3(),
    )
    const north = C.Cartesian3.subtract(
      this.host.localToWorld(0, 0, -1),
      this.host.localToWorld(0, 0, 0),
      new C.Cartesian3(),
    )
    return {
      index,
      mode: event.shiftKey ? 'altitude' : 'move',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: waypoint.x,
      startZ: waypoint.z,
      startAltitude: waypoint.altitude,
      moved: false,
      east,
      north,
    }
  }

  private applyDrag(event: PointerEvent, drag: DragState): void {
    const step = event.altKey ? SNAP_STEP_FINE : SNAP_STEP
    const limits = this.host.getLimits()
    if (drag.mode === 'altitude') {
      // 改高度:屏幕纵向增量直接当米(上拖加高),不依赖任何求交
      const altitude = drag.startAltitude - (event.clientY - drag.startClientY) * this.metersPerPixel(drag)
      this.host.moveWaypoint(drag.index, {
        altitude: clamp(snap(altitude, step), 1, limits.maxAltitude),
      })
      return
    }
    const delta = this.screenDeltaToLocal(
      event.clientX - drag.startClientX,
      event.clientY - drag.startClientY,
      drag,
    )
    if (!delta) return
    this.host.moveWaypoint(drag.index, { x: snap(delta.x, step), z: snap(delta.z, step) })
  }

  /** 屏幕像素增量 → ENU 米增量(再换算成 sim 的 x 东 / z 南) */
  private screenDeltaToLocal(
    dx: number,
    dy: number,
    drag: DragState,
  ): { x: number; z: number } | null {
    const C = this.C
    const cam = this.viewer.camera
    const mpp = this.metersPerPixel(drag)
    // 相机右向 / 前向投影到 ENU 水平面:垂直俯视时水平分量退化,直接放弃本次更新
    const project = (vector: CesiumNS): { e: number; n: number } | null => {
      const e = C.Cartesian3.dot(vector, drag.east)
      const n = C.Cartesian3.dot(vector, drag.north)
      const length = Math.hypot(e, n)
      return length < 1e-6 ? null : { e: e / length, n: n / length }
    }
    const right = project(cam.rightWC)
    const forward = project(cam.directionWC)
    if (!right || !forward) return null
    // 屏幕右移 = 相机右向;屏幕上移(dy<0)= 相机前向
    const east = (right.e * dx - forward.e * dy) * mpp
    const northMeters = (right.n * dx - forward.n * dy) * mpp
    // ENU 东 = sim +x;北 = sim −z(sim 的 z 向南为正)
    return { x: drag.startX + east, z: drag.startZ - northMeters }
  }

  /** 拖拽起点处"一个屏幕像素"对应多少米 */
  private metersPerPixel(drag: DragState): number {
    const C = this.C
    const cam = this.viewer.camera
    const target = this.host.localToWorld(drag.startX, drag.startAltitude, drag.startZ)
    const distance = C.Cartesian3.distance(cam.positionWC, target)
    // 视锥在 distance 处的可见高度 = 2·tan(fovy/2)·distance;再按画布像素高度折算
    const height = 2 * Math.tan(cam.frustum.fovy / 2) * distance
    const rect = this.canvas.getBoundingClientRect()
    return rect.height > 0 ? height / rect.height : 0.2
  }

  // ───────────────────────────── 拾取 ─────────────────────────────

  /**
   * 屏幕坐标 → 命中的航点序号;没命中返回 -1。
   *
   * 几何法:每个航点投到屏幕,取指针 PICK_RADIUS_PX 内最近的那个(见文件头"拾取")。
   * 相机背后的航点投影会 undefined / 跑飞,一律跳过。
   */
  private pickWaypoint(event: { clientX: number; clientY: number }): number {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return -1
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top
    const waypoints = this.host.getWaypoints()
    let best = -1
    let bestDistance = PICK_RADIUS_PX
    for (let index = 0; index < waypoints.length; index += 1) {
      const waypoint = waypoints[index]!
      const screen = this.viewer.scene.cartesianToCanvasCoordinates(
        this.host.localToWorld(waypoint.x, waypoint.altitude, waypoint.z),
      )
      if (!screen) continue
      const distance = Math.hypot(screen.x - px, screen.y - py)
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    }
    return best
  }

  /** 屏幕坐标 → 椭球上的世界点(双击插入用;瞄到天空返回 undefined) */
  private pickEllipsoid(event: { clientX: number; clientY: number }): CesiumNS | undefined {
    return this.viewer.camera.pickEllipsoid(this.toWindowPosition(event))
  }

  /** client 坐标 → Cesium 的窗口坐标(相对画布左上角) */
  private toWindowPosition(event: { clientX: number; clientY: number }): CesiumNS {
    const rect = this.canvas.getBoundingClientRect()
    return new this.C.Cartesian2(event.clientX - rect.left, event.clientY - rect.top)
  }

  private cancelDrag(): void {
    if (!this.drag) return
    this.drag = null
    this.host.setCameraInputEnabled(true)
  }

  // ───────────────────────────── 销毁 ─────────────────────────────

  destroy(): void {
    if (this.disposed) return
    this.disposed = true
    this.container.removeEventListener('pointerdown', this.onPointerDown, { capture: true })
    this.container.removeEventListener('pointermove', this.onPointerMove, { capture: true })
    this.container.removeEventListener('pointerup', this.onPointerUp, { capture: true })
    this.container.removeEventListener('pointercancel', this.onPointerUp, { capture: true })
    this.container.removeEventListener('pointerleave', this.onPointerLeave, { capture: true })
    this.container.removeEventListener('dblclick', this.onDoubleClick, { capture: true })
    window.removeEventListener('keydown', this.onKeyDown)
    this.cancelDrag()
    // 实体逐个摘掉(entities.remove 会释放对应的 primitive)
    const waypointCount = this.host.getWaypoints().length
    for (let index = 0; index < waypointCount; index += 1) {
      const entity = this.viewer.entities.getById(ENTITY_WAYPOINT_PREFIX + index)
      if (entity) this.viewer.entities.remove(entity)
    }
    for (const id of [ENTITY_PATH_ID, ENTITY_HOME_ID]) {
      const entity = this.viewer.entities.getById(id)
      if (entity) this.viewer.entities.remove(entity)
    }
    this.waypointSignature = ''
    this.homeKey = ''
  }
}
