import type { DroneFly } from './drone-fly'
import type { DroneSim, ObstacleBox } from './drone-sim'

/**
 * 鹰眼图(俯视小地图)—— 原生 DOM + Canvas 2D,与 drone-panel / mission-panel 同一套范式:
 * 框架无关、`dcm-*` 类名、配色走 CSS 变量、构造即可挂载、destroy 彻底回收。
 *
 * ## 为什么不是"开第二个 three.js 视口"
 * 它只是一张**态势示意图**,不是真实几何的第二次渲染 —— 只读 fly.sim 的真值
 * (位置 / 航向 / 障碍 AABB / 航线 / 返航点)与 world 的航迹,自己投影成 2D。于是:
 *
 * 1. **零渲染器耦合**:WebGPU / WebGL / 无头环境都能跑,不碰 renderer、不碰相机、不碰场景;
 * 2. **不会混进成片**:第二视口方案要把小地图渲进同一个 renderer,拍照与录像抓的就是那帧,
 *    小地图会糊在成片角落;本方案出的是叠加层,与 renderer 输出天然分离;
 * 3. **不占用三维资源**:没有额外的正交相机、视锥、scissor 状态要维护。
 *
 * ## 更新节奏与面板不同
 * 面板 200ms 轮询读数足够,但小地图 5Hz 会一帧一格地跳。所以这里**自驱 requestAnimationFrame**
 * 每帧重绘 —— 几百个图元的 canvas 重绘成本可忽略,且与宿主渲染循环互不干扰
 * (`render()` 也对外公开,宿主想自己控制节拍可以调它)。
 *
 * ## 坐标映射是直给
 * sim 的约定是 x 向东、z 向南(与模型一致),所以"北向上"就是屏幕右 = +x、屏幕上 = -z:
 * `u = cx + (x - ox) · k`、`v = cy + (z - oz) · k`。不需要矩阵,也不需要碰相机。
 * 顺带一个好处:机体箭头的 canvas 旋转角**恰好等于 heading 弧度**(0° = 北 = 屏幕上方)。
 *
 * ## 朝向固定北向
 * 地图不旋转、只有机体箭头转 —— 这是 DJI 的默认读图方式:障碍物与返航点的相对方位
 * 不随飞行姿态变化,"该往哪边飞"判断更稳(机头朝上模式下车头一偏,整张图都跟着晃)。
 */

/** 小地图吸附的容器角;bottom-center = 底边水平居中(两侧摇杆之间的空档) */
export type MiniMapPosition =
  'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'bottom-center'

export interface MiniMapOptions {
  /** 挂载容器;缺省挂到 document.body(贴视口),给了容器就贴容器(必要时自动补 relative) */
  container?: HTMLElement
  /** 吸附角,默认右下角(与控制面板右上、航线面板左上错开) */
  position?: MiniMapPosition
  /**
   * 角内偏移(像素):在默认 14px 边距之上再让出的距离。
   * 右下角常被 HUD 摇杆 + 技能钮占着,demo 里就是用它把小地图抬到轮盘上方。
   */
  offset?: { x?: number; y?: number }
  /** 画布边长(CSS 像素),默认 186 */
  size?: number
  /** 固定半量程(米);传了就关闭自动量程。缺省 null = 自动跟随 */
  range?: number | null
  /** 自动量程下限(米),默认 40 */
  minRange?: number
  /** 自动量程上限(米),默认 300 */
  maxRange?: number
  visible?: boolean
  /** 注入内置样式,默认 true;宿主自备样式可关掉 */
  injectStyles?: boolean
  /** 额外类名,追加在 `dcm` 之后 */
  className?: string
  showObstacles?: boolean
  showMission?: boolean
  showTrail?: boolean
  showFov?: boolean
  showGrid?: boolean
}

/** 探针/调试读数 */
export interface MiniMapStats {
  /** 当前实际半量程(米) */
  range: number
  /** 当前比例尺(像素 / 米) */
  scale: number
  obstacleCount: number
  waypointCount: number
  trailPoints: number
  /** 机载水平视场角(度);非机载视角返回 null */
  fovDeg: number | null
  /** 地图中心的世界坐标(= 机体位置) */
  centerX: number
  centerZ: number
}

/** 解析后的配色(从 CSS 变量读,宿主可整体换肤) */
interface MiniMapColors {
  grid: string
  ring: string
  obstacle: string
  obstacleEdge: string
  mission: string
  missionDone: string
  missionActive: string
  trail: string
  home: string
  drone: string
  fov: string
  text: string
}

const STYLE_ID = 'drone-minimap-styles'
const DEG = Math.PI / 180
/** 画布内边距(像素):给刻度环与角标留白 */
const MAP_PADDING = 10
/** 自动量程档位(米):取不小于需求的最近一档,避免地图随飞行持续缩放抖动 */
const RANGE_STEPS = [40, 60, 80, 100, 150, 200, 300]
/** 量程缓动速率(1/秒):换档时平滑过渡而不是硬切 */
const RANGE_EASE_RATE = 3.4
/** 视场扇形半径占量程的比例(纯示意,不代表真实测距) */
const FOV_FAN_RATIO = 0.55
/** 网格候选步距(米):挑第一个屏上间距 ≥ 16px 的 */
const GRID_STEPS = [2, 5, 10, 25, 50, 100, 200]
const GRID_MIN_PX = 16
const FONT = '"Inter", "HarmonyOS Sans SC", system-ui, -apple-system, "Segoe UI", sans-serif'

const CSS = `
.dcm {
  --dcm-size: 186px;
  --dcm-offset-x: 0px;
  --dcm-offset-y: 0px;
  --dcm-bg: rgba(9, 17, 22, 0.62);
  --dcm-border: rgba(255, 255, 255, 0.16);
  --dcm-grid: rgba(255, 255, 255, 0.06);
  --dcm-ring: rgba(255, 255, 255, 0.17);
  --dcm-obstacle: rgba(186, 188, 183, 0.32);
  --dcm-obstacle-edge: rgba(214, 216, 210, 0.6);
  --dcm-mission: #39d0b0;
  --dcm-mission-done: rgba(57, 208, 176, 0.3);
  --dcm-mission-active: #ffc53d;
  --dcm-trail: rgba(93, 202, 165, 0.5);
  --dcm-home: #35e08a;
  --dcm-drone: #7fe3ff;
  --dcm-fov: rgba(127, 227, 255, 0.13);
  --dcm-text: rgba(226, 240, 246, 0.82);
  position: absolute;
  z-index: 5;
  width: var(--dcm-size);
  height: var(--dcm-size);
  border-radius: 12px;
  border: 0.5px solid var(--dcm-border);
  background: var(--dcm-bg);
  overflow: hidden;
  pointer-events: none;
  user-select: none;
}
.dcm[data-position="top-left"] { left: calc(14px + var(--dcm-offset-x)); top: calc(14px + var(--dcm-offset-y)); }
.dcm[data-position="top-right"] { right: calc(14px + var(--dcm-offset-x)); top: calc(14px + var(--dcm-offset-y)); }
.dcm[data-position="bottom-left"] { left: calc(14px + var(--dcm-offset-x)); bottom: calc(14px + var(--dcm-offset-y)); }
.dcm[data-position="bottom-right"] { right: calc(14px + var(--dcm-offset-x)); bottom: calc(14px + var(--dcm-offset-y)); }
.dcm[data-position="bottom-center"] { left: 50%; transform: translateX(-50%); bottom: calc(14px + var(--dcm-offset-y)); }
.dcm-canvas { display: block; width: 100%; height: 100%; }
`

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/** 圆角矩形路径(不依赖 ctx.roundRect,老 WebView 也能用) */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

function readVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

export class DroneMiniMap {
  private readonly fly: DroneFly
  private readonly container: HTMLElement
  private readonly root: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly size: number
  private readonly minRange: number
  private readonly maxRange: number
  private readonly showObstacles: boolean
  private readonly showMission: boolean
  private readonly showTrail: boolean
  private readonly showFov: boolean
  private readonly showGrid: boolean

  private colors: MiniMapColors
  private visible: boolean
  private destroyed = false

  /** 手动量程(米);null = 自动跟随 */
  private manualRange: number | null = null
  private rangeCurrent = 120
  private rangeTarget = 120
  private rangeReady = false

  /** 本帧的投影参数:比例尺(像素/米)、地图中心的世界坐标 */
  private scale = 1
  private originX = 0
  private originZ = 0

  private raf: number | null = null
  private lastTime = 0
  private frameDrawn = false

  /** 构造鹰眼图:Canvas 2D 俯视 HUD,只读 sim 真值,不碰三维渲染 */
  constructor(fly: DroneFly, options: MiniMapOptions = {}) {
    if (typeof document === 'undefined') {
      throw new Error('[drone-camera] DroneMiniMap 需要浏览器环境(document),Node 侧请勿实例化')
    }
    this.fly = fly
    this.size = Math.max(96, options.size ?? 186)
    this.manualRange = options.range === undefined ? null : options.range
    this.minRange = Math.max(10, options.minRange ?? 40)
    this.maxRange = Math.max(this.minRange, options.maxRange ?? 300)
    this.showObstacles = options.showObstacles !== false
    this.showMission = options.showMission !== false
    this.showTrail = options.showTrail !== false
    this.showFov = options.showFov !== false
    this.showGrid = options.showGrid !== false
    this.visible = options.visible ?? true

    if (options.injectStyles !== false) ensureStyles()

    this.container = options.container ?? document.body
    const host = options.container ?? null
    // 与 panel 同一套挂载纪律:容器没有定位上下文就补一个,否则绝对定位会飞到页面左上角
    if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative'

    this.root = document.createElement('div')
    this.root.className = options.className ? `dcm ${options.className}` : 'dcm'
    this.root.dataset.position = options.position ?? 'bottom-right'
    this.root.style.position = host ? 'absolute' : 'fixed'
    this.root.style.setProperty('--dcm-size', `${this.size}px`)
    if (options.offset?.x)
      this.root.style.setProperty('--dcm-offset-x', `${Math.max(0, options.offset.x)}px`)
    if (options.offset?.y)
      this.root.style.setProperty('--dcm-offset-y', `${Math.max(0, options.offset.y)}px`)
    if (!this.visible) this.root.style.display = 'none'

    this.canvas = document.createElement('canvas')
    this.canvas.className = 'dcm-canvas'
    this.root.appendChild(this.canvas)
    this.container.appendChild(this.root)

    const context = this.canvas.getContext('2d')
    if (!context) throw new Error('[drone-camera] DroneMiniMap 无法获取 2D 绘图上下文')
    this.ctx = context
    // 高 DPI:逻辑坐标始终按 CSS 像素算,靠 canvas 的 backing store 倍数保证线条清晰
    const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
    this.canvas.width = Math.round(this.size * dpr)
    this.canvas.height = Math.round(this.size * dpr)
    this.ctx.scale(dpr, dpr)

    this.colors = this.resolveColors()

    this.lastTime = typeof performance === 'undefined' ? 0 : performance.now()
    this.render()
    this.start()
  }

  // ────────────────────────────────────────────────────────────────────────
  // 公开接口
  // ────────────────────────────────────────────────────────────────────────

  /** 立即重绘一帧(宿主想自控节拍时可关掉内置 rAF —— 见 stop()) */
  render(): void {
    if (this.destroyed) return
    this.frameDrawn = true
    this.drawFrame()
  }

  /** 显示/隐藏鹰眼图 */
  setVisible(visible: boolean): void {
    this.visible = visible
    this.root.style.display = visible ? '' : 'none'
  }

  /** 鹰眼图当前是否可见 */
  isVisible(): boolean {
    return this.visible
  }

  /** 量程:传数字 = 固定该半量程(米);传 null = 回到自动跟随 */
  setRange(range: number | null): void {
    this.manualRange = range === null ? null : Math.max(5, range)
    this.rangeReady = false
  }

  /** 当前实际半量程(米) */
  getRange(): number {
    return this.rangeCurrent
  }

  /** 切主题(读一遍 CSS 变量)后调用;平时不必每帧读 */
  refreshTheme(): void {
    this.colors = this.resolveColors()
    this.drawFrame()
  }

  /** 探针读数 */
  getStats(): MiniMapStats {
    const sim = this.fly.sim
    return {
      range: this.rangeCurrent,
      scale: this.scale,
      obstacleCount: this.showObstacles ? sim.obstacles.length : 0,
      waypointCount: this.showMission ? sim.mission.length : 0,
      trailPoints: this.fly.world?.getTrail().count ?? 0,
      fovDeg: this.horizontalFov(),
      centerX: this.originX,
      centerZ: this.originZ,
    }
  }

  /** 本帧是否已绘制过(探针用:确认 rAF 真的在跑) */
  hasDrawn(): boolean {
    return this.frameDrawn
  }

  /** 停止内置刷新(之后需自行调用 render()) */
  stop(): void {
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf)
      this.raf = null
    }
  }

  /** 停止重绘循环并移除画布 */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stop()
    this.root.parentNode?.removeChild(this.root)
    if (this.container.childElementCount === 0) {
      // 容器是构造函数补的 relative,不还原也无害;这里只清掉可能残留的样式
      this.container.style.removeProperty('position')
    }
    if (typeof document !== 'undefined') {
      document.getElementById(STYLE_ID)?.remove()
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 内部
  // ────────────────────────────────────────────────────────────────────────

  private start(): void {
    if (typeof requestAnimationFrame !== 'function') return
    const tick = (time: number): void => {
      if (this.destroyed) return
      this.raf = requestAnimationFrame(tick)
      const delta = Math.min(0.25, Math.max(0, (time - this.lastTime) / 1000))
      this.lastTime = time
      if (this.visible) this.drawFrame(delta)
    }
    this.raf = requestAnimationFrame(tick)
  }

  private resolveColors(): MiniMapColors {
    const style = getComputedStyle(this.root)
    return {
      grid: readVar(style, '--dcm-grid', 'rgba(255,255,255,0.06)'),
      ring: readVar(style, '--dcm-ring', 'rgba(255,255,255,0.17)'),
      obstacle: readVar(style, '--dcm-obstacle', 'rgba(186,188,183,0.32)'),
      obstacleEdge: readVar(style, '--dcm-obstacle-edge', 'rgba(214,216,210,0.6)'),
      mission: readVar(style, '--dcm-mission', '#39d0b0'),
      missionDone: readVar(style, '--dcm-mission-done', 'rgba(57,208,176,0.3)'),
      missionActive: readVar(style, '--dcm-mission-active', '#ffc53d'),
      trail: readVar(style, '--dcm-trail', 'rgba(93,202,165,0.5)'),
      home: readVar(style, '--dcm-home', '#35e08a'),
      drone: readVar(style, '--dcm-drone', '#7fe3ff'),
      fov: readVar(style, '--dcm-fov', 'rgba(127,227,255,0.13)'),
      text: readVar(style, '--dcm-text', 'rgba(226,240,246,0.82)'),
    }
  }

  /** 机载取景相机的当前水平视场角(度,已折算 zoom);非机载视角返回 null */
  private horizontalFov(): number | null {
    const camera = this.fly.camera
    if (!camera || this.fly.cameraMode !== 'fpv') return null
    const zoom = Math.max(1e-3, camera.zoom || 1)
    const vertical = camera.fov * DEG
    const effective = 2 * Math.atan(Math.tan(vertical / 2) / zoom)
    const aspect = camera.aspect || 1
    return (2 * Math.atan(Math.tan(effective / 2) * aspect)) / DEG
  }

  /**
   * 量程:自动模式下取「机体到返航点 / 到各航点的最远距离 + 余量」,
   * 再向上取整到 RANGE_STEPS 的档位,最后缓动过去(换档不硬切)。
   */
  private updateRange(sim: DroneSim, delta: number): void {
    if (this.manualRange !== null) {
      this.rangeCurrent = this.manualRange
      this.rangeTarget = this.manualRange
      this.rangeReady = true
      return
    }
    const px = sim.position.x
    const pz = sim.position.z
    let need = this.minRange * 0.7
    if (sim.homeReady) {
      const home = sim.homePosition
      need = Math.max(need, Math.hypot(px - home.x, pz - home.z) + 12)
    }
    for (const waypoint of sim.mission) {
      need = Math.max(need, Math.hypot(px - waypoint.x, pz - waypoint.z) + 12)
    }
    this.rangeTarget = Math.min(
      this.maxRange,
      Math.max(this.minRange, RANGE_STEPS.find((step) => step >= need) ?? this.maxRange),
    )
    if (!this.rangeReady) {
      this.rangeCurrent = this.rangeTarget
      this.rangeReady = true
      return
    }
    const ease = Math.min(1, Math.max(0, delta) * RANGE_EASE_RATE)
    if (Math.abs(this.rangeCurrent - this.rangeTarget) < 1e-3) {
      this.rangeCurrent = this.rangeTarget
      return
    }
    this.rangeCurrent += (this.rangeTarget - this.rangeCurrent) * ease
  }

  private drawFrame(delta = 1 / 60): void {
    const ctx = this.ctx
    const size = this.size
    const sim = this.fly.sim

    ctx.clearRect(0, 0, size, size)
    ctx.save()
    roundRectPath(ctx, 0, 0, size, size, 12)
    ctx.clip()

    this.updateRange(sim, delta)

    const half = size / 2
    // 投影:机体居中(ox/oz = 机体位置),比例尺按量程折算
    this.scale = (half - MAP_PADDING) / this.rangeCurrent
    this.originX = sim.position.x
    this.originZ = sim.position.z

    if (this.showGrid) this.drawGrid()
    this.drawRings()
    if (this.showObstacles) this.drawObstacles(sim.obstacles)
    if (this.showMission) this.drawMission(sim)
    if (this.showTrail) this.drawTrail()
    this.drawHome(sim)
    if (this.showFov) this.drawFov(sim.heading)
    this.drawDrone(sim.heading)
    this.drawCompass()
    this.drawScaleLabel()

    ctx.restore()
  }

  private toX(worldX: number): number {
    return this.size / 2 + (worldX - this.originX) * this.scale
  }

  private toY(worldZ: number): number {
    return this.size / 2 + (worldZ - this.originZ) * this.scale
  }

  private gridStep(): number {
    for (const step of GRID_STEPS) {
      if (step * this.scale >= GRID_MIN_PX) return step
    }
    return GRID_STEPS[GRID_STEPS.length - 1] ?? 200
  }

  private drawGrid(): void {
    const ctx = this.ctx
    const step = this.gridStep()
    const half = this.rangeCurrent
    const firstX = Math.ceil((this.originX - half) / step)
    const lastX = Math.floor((this.originX + half) / step)
    const firstZ = Math.ceil((this.originZ - half) / step)
    const lastZ = Math.floor((this.originZ + half) / step)

    ctx.strokeStyle = this.colors.grid
    ctx.lineWidth = 0.5
    ctx.beginPath()
    for (let i = firstX; i <= lastX; i += 1) {
      const px = this.toX(i * step)
      ctx.moveTo(px, 0)
      ctx.lineTo(px, this.size)
    }
    for (let i = firstZ; i <= lastZ; i += 1) {
      const py = this.toY(i * step)
      ctx.moveTo(0, py)
      ctx.lineTo(this.size, py)
    }
    ctx.stroke()
  }

  /** 刻度环:满量程 + 半量程两道虚线同心圆(圆心即机体,因为机体恒居中) */
  private drawRings(): void {
    const ctx = this.ctx
    const center = this.size / 2
    const outer = center - MAP_PADDING
    ctx.strokeStyle = this.colors.ring
    ctx.lineWidth = 0.5
    ctx.setLineDash([3, 4])
    for (const radius of [outer, outer * 0.5]) {
      ctx.beginPath()
      ctx.arc(center, center, radius, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  private drawObstacles(boxes: readonly ObstacleBox[]): void {
    if (boxes.length === 0) return
    const ctx = this.ctx
    ctx.fillStyle = this.colors.obstacle
    ctx.strokeStyle = this.colors.obstacleEdge
    ctx.lineWidth = 0.5
    for (const box of boxes) {
      const x0 = this.toX(box.minX)
      const y0 = this.toY(box.minZ)
      const width = (box.maxX - box.minX) * this.scale
      const height = (box.maxZ - box.minZ) * this.scale
      // 屏外的整块跳过(大场景里省掉无谓的路径)
      if (x0 + width < -MAP_PADDING || x0 > this.size + MAP_PADDING) continue
      if (y0 + height < -MAP_PADDING || y0 > this.size + MAP_PADDING) continue
      // 极窄的杆件(灯杆)至少画成 2px,否则小地图上直接消失
      ctx.beginPath()
      ctx.rect(x0, y0, Math.max(2, width), Math.max(2, height))
      ctx.fill()
      ctx.stroke()
    }
  }

  private drawMission(sim: DroneSim): void {
    const waypoints = sim.mission
    if (waypoints.length === 0) return
    const ctx = this.ctx
    const running = sim.missionStatus !== 'idle'
    const active = running ? sim.missionIndex : -1

    // 折线顶点 = [返航点(有则加)] + 各航点;offset 记录航点与顶点的错位
    const nodes: Array<{ x: number; y: number }> = []
    const hasHome = sim.homeReady
    if (hasHome) {
      const home = sim.homePosition
      nodes.push({ x: this.toX(home.x), y: this.toY(home.z) })
    }
    for (const waypoint of waypoints) {
      nodes.push({ x: this.toX(waypoint.x), y: this.toY(waypoint.z) })
    }
    const offset = hasHome ? 1 : 0

    ctx.save()
    ctx.globalAlpha = running ? 1 : 0.72
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    for (let i = 0; i < nodes.length - 1; i += 1) {
      const a = nodes[i]
      const b = nodes[i + 1]
      if (!a || !b) continue
      const target = i + 1 - offset
      const done = active >= 0 && target <= active
      ctx.strokeStyle = done ? this.colors.missionDone : this.colors.mission
      if (done) ctx.setLineDash([3, 3])
      else ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
    ctx.setLineDash([])

    // 航点圆点:未到 = 主色,当前目标 = 琥珀 + 外圈,已过 = 淡色
    const showIndex = this.rangeCurrent <= 150
    ctx.font = `600 9px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < waypoints.length; i += 1) {
      const waypoint = waypoints[i]
      if (!waypoint) continue
      const px = this.toX(waypoint.x)
      const py = this.toY(waypoint.z)
      const isActive = i === active
      const isDone = active >= 0 && i < active
      ctx.beginPath()
      ctx.arc(px, py, isActive ? 5.5 : 3.6, 0, Math.PI * 2)
      ctx.fillStyle = isActive
        ? this.colors.missionActive
        : isDone
          ? this.colors.missionDone
          : this.colors.mission
      ctx.fill()
      if (isActive) {
        ctx.strokeStyle = this.colors.missionActive
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(px, py, 8.5, 0, Math.PI * 2)
        ctx.stroke()
      }
      if (showIndex) {
        ctx.fillStyle = this.colors.text
        ctx.fillText(String(i + 1), px, py - 9)
      }
    }
    ctx.restore()
  }

  private drawTrail(): void {
    const trail = this.fly.world?.getTrail()
    if (!trail || trail.count < 2) return
    const ctx = this.ctx
    const positions = trail.positions
    // 每 0.25m 一个点,量程稍大时屏上远小于 1px —— 抽稀到约 600 段即可
    const stride = Math.max(1, Math.floor(trail.count / 600))
    ctx.strokeStyle = this.colors.trail
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.beginPath()
    let started = false
    for (let i = 0; i < trail.count; i += stride) {
      const x = positions[i * 3]
      const z = positions[i * 3 + 2]
      if (x === undefined || z === undefined) continue
      const px = this.toX(x)
      const py = this.toY(z)
      if (started) ctx.lineTo(px, py)
      else {
        ctx.moveTo(px, py)
        started = true
      }
    }
    const lastX = positions[(trail.count - 1) * 3]
    const lastZ = positions[(trail.count - 1) * 3 + 2]
    if (started && lastX !== undefined && lastZ !== undefined) {
      ctx.lineTo(this.toX(lastX), this.toY(lastZ))
    }
    ctx.stroke()
  }

  private drawHome(sim: DroneSim): void {
    if (!sim.homeReady) return
    const ctx = this.ctx
    const home = sim.homePosition
    const px = this.toX(home.x)
    const py = this.toY(home.z)
    ctx.strokeStyle = this.colors.home
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(px, py, 8, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = this.colors.home
    ctx.font = `600 10px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('H', px, py + 0.5)
  }

  /** FPV 水平视场扇形:从机体出发、机头方向张开,看一眼就知道"现在镜头能拍到哪一片" */
  private drawFov(heading: number): void {
    const fov = this.horizontalFov()
    if (fov === null) return
    const ctx = this.ctx
    const radius = this.rangeCurrent * FOV_FAN_RATIO * this.scale
    const half = (fov / 2) * DEG
    ctx.save()
    // canvas 旋转角恰好等于 heading 弧度:俯视图北向上时,机体箭头指向 = 航向角本身
    ctx.translate(this.size / 2, this.size / 2)
    ctx.rotate(heading * DEG)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.arc(0, 0, radius, -Math.PI / 2 - half, -Math.PI / 2 + half)
    ctx.closePath()
    ctx.fillStyle = this.colors.fov
    ctx.fill()
    ctx.restore()
  }

  private drawDrone(heading: number): void {
    const ctx = this.ctx
    ctx.save()
    ctx.translate(this.size / 2, this.size / 2)
    ctx.rotate(heading * DEG)
    ctx.beginPath()
    ctx.moveTo(0, -9)
    ctx.lineTo(6.2, 7)
    ctx.lineTo(0, 3.8)
    ctx.lineTo(-6.2, 7)
    ctx.closePath()
    ctx.fillStyle = this.colors.drone
    ctx.fill()
    ctx.restore()
  }

  private drawCompass(): void {
    const ctx = this.ctx
    const x = this.size - 17
    const y = 20
    ctx.fillStyle = this.colors.drone
    ctx.beginPath()
    ctx.moveTo(x, y - 14)
    ctx.lineTo(x - 3.5, y - 7)
    ctx.lineTo(x + 3.5, y - 7)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = this.colors.text
    ctx.font = `600 10px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('N', x, y)
  }

  private drawScaleLabel(): void {
    const ctx = this.ctx
    ctx.fillStyle = this.colors.text
    ctx.font = `500 10px ${FONT}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(`${Math.round(this.rangeCurrent)} m`, 10, this.size - 9)
  }
}
