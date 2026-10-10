/**
 * 航线规划面板(原生 DOM 实现):航点任务的「规划 → 执行 → 场景内编辑」一条龙界面。
 *
 * 迁移自 firstapp 的 `views/dji/dji-viewer.vue`「航线」分页,去掉 Vue 依赖后重写为原生 DOM,
 * 与 `drone-panel.ts`(飞行控制面板)同一套范式:只读引擎、只调引擎,面板自身不持有状态。
 *
 * 四个区块(与 firstapp 一一对应):
 * 1. **航线任务** —— 执行 / 暂停 / 继续 / 停止 + 状态角标 + 进度 + 启动被拒的原因;
 * 2. **任务参数** —— 巡航速度 / 机头朝向 / 过点方式 / 完成后动作 / 循环执行;
 * 3. **航点列表** —— 每个航点的 X/Z/高度/速度/悬停/云台俯仰/动作,增删改 + 示例航线 + 清空 + 导出;
 * 4. **场景内编辑** —— 开关三维场景里的拖拽编辑,含手势说明、选中状态、框住航线与图层显隐。
 *
 * 设计边界:
 * - 只用原生 DOM / CSS,不引入任何 UI 框架(库整体与框架无关,Vue / React / 裸页面通用);
 * - 面板不持有状态:渲染时从 `DroneFly` 读快照,操作时调 `DroneFly` 方法,真值永远以引擎为准
 *   (见 sync)。宿主用别的方式改了航线,面板下一轮同步就会跟上;
 * - 样式默认注入一份(类名统一 `dmp-` 前缀、配色走 CSS 变量),可用 `injectStyles:false` 关闭。
 *
 * 非直觉约定:
 * - 以 100ms 轮询同步(可用 syncIntervalMs 调或传 0 关闭、完全由宿主调 sync());
 * - 航点数字输入框在**获得焦点期间不回写** —— 否则用户打到一半的 "-" / "1." 会被引擎值抹掉,
 *   与 firstapp 里"草稿行"要解决的是同一个问题,这里用"聚焦即不覆盖"更省一层状态;
 * - 航点列表只在**数量变化**时重建 DOM,其余情况原位更新,避免每轮同步都打断正在编辑的输入框;
 * - 航线执行中航点列表整体 disabled(与真机"航线上传后不可修改"一致);**导出是只读操作,执行中照常可用**;
 * - 导出走 `DroneFly.exportMission()`,面板只负责落盘(或交给宿主的 `onExport`),序列化逻辑留在引擎侧。
 * - 场景内编辑另有硬门槛:需处于观察者视角且航线未在执行,由 `DroneFly` 侧判定,面板只展示结果。
 */
import { MISSION_STATUS_LABELS, isMissionDepartStage } from './drone-sim'
import type {
  MissionFinishAction,
  MissionHeadingMode,
  MissionPathMode,
  MissionStage,
  MissionWaypoint,
} from './drone-sim'
import type { DroneFly, MissionExportFormat } from './drone-fly'
import type { MissionEditState } from './mission-editor'

/** 面板停靠位置(相对挂载容器) */
export type MissionPanelPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** 「导出航线」产出的载荷:宿主传了 `onExport` 就由宿主决定怎么保存(上传 / 入库 / 换文件名) */
export interface MissionExportPayload {
  format: MissionExportFormat
  /** 序列化好的完整文本(JSON 已带缩进,CSV 为中文表头 + CRLF) */
  text: string
  /** 建议文件名(含扩展名) */
  filename: string
  /** MIME 类型 */
  mime: string
}

/** MissionPanel 构造选项 */
export interface MissionPanelOptions {
  /** 挂载容器;缺省挂到 document.body(此时面板改用 fixed 定位) */
  container?: HTMLElement | null
  /** 面板停靠位置,默认 'top-left'(通常与右上角的飞行控制面板对开) */
  position?: MissionPanelPosition
  /** 面板标题,默认「航线规划」 */
  title?: string
  /** 是否注入自带样式,默认 true;关闭后仅保留 `dmp-*` 类名,由宿主自行配色 */
  injectStyles?: boolean
  /** 初始是否可见,默认 true */
  visible?: boolean
  /** 状态轮询间隔(毫秒),默认 100;传 0 关闭自动同步、完全由宿主调 sync() */
  syncIntervalMs?: number
  /** 是否渲染「场景内编辑」区块(需要画布与观察者视角),默认 true;传 false 退化成三块纯列表编辑 */
  sceneEdit?: boolean
  /** 是否启用移动端自适应(窄屏紧凑布局),默认 true */
  adaptive?: boolean
  /**
   * 「导出航线」的回调。**给了就由宿主接管保存**(上传服务器 / 写数据库 / 自定义文件名),
   * 面板不再触发浏览器下载;不给则默认下载到本地(JSON / CSV,文件名带时间戳)。
   */
  onExport?: (payload: MissionExportPayload) => void
}

const STYLE_ID = 'drone-mission-panel-styles'
const DEFAULT_SYNC_MS = 100
/** 巡航速度滑杆范围,与 DroneSim 的归一化保持一致 */
const SPEED_MIN = 1
const SPEED_MAX = 16
/** 航点数字字段的取值范围(与内核的归一化保持一致) */
const FIELD_RANGES = {
  x: { min: -2000, max: 2000 },
  z: { min: -2000, max: 2000 },
  altitude: { min: 1, max: 500 },
  speed: { min: 0, max: 16 },
  hoverSeconds: { min: 0, max: 60 },
  gimbalPitch: { min: -90, max: 60 },
} as const
type WaypointNumberField = keyof typeof FIELD_RANGES
/** 航点到点动作(与 firstapp 的 MISSION_ACTIONS 一致) */
const WAYPOINT_ACTIONS: Array<{ key: MissionWaypoint['action']; label: string }> = [
  { key: 'none', label: '无动作' },
  { key: 'photo', label: '拍照' },
]
/** 任务结束动作(与 firstapp 的 MISSION_FINISH_ACTIONS 一致) */
const FINISH_ACTIONS: Array<{ key: MissionFinishAction; label: string }> = [
  { key: 'hover', label: '原地悬停' },
  { key: 'rth', label: '自动返航' },
  { key: 'land', label: '自动降落' },
]
/** 哪些飞行阶段允许启动航线(与 firstapp 的 canStartMission 一致) */
const MISSION_STARTABLE_PHASES = ['standby', 'motorsOn', 'takingOff', 'flying', 'rth']

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }
  return text.replace(/[&<>"']/g, (ch) => map[ch] ?? ch)
}

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
}

/**
 * 航线规划面板:航点任务的规划 / 执行 / 场景内编辑。
 *
 * ```ts
 * const fly = new DroneFly(scene, camera, renderer, controls)
 * await fly.initialize({ modelUrl: '/models/dji_mini4_pro.glb' })
 * const mission = new MissionPanel(fly, { container: viewportEl, position: 'top-left' })
 * // 卸载:mission.destroy()
 * ```
 */
export class MissionPanel {
  /** 面板根元素(宿主可追加类名做二次定制) */
  readonly root: HTMLDivElement

  private readonly fly: DroneFly
  private readonly opts: MissionPanelOptions
  private readonly container: HTMLElement
  private readonly abort = new AbortController()
  private timer: number | null = null
  private destroyed = false
  private visible: boolean
  /** 上一次构建航点列表时的航点数:变了才重建 DOM,否则原位更新(不打断输入) */
  private lastWaypointCount = -1
  private speedDragging = false

  private readonly refs: {
    status: HTMLElement
    progress: HTMLElement
    block: HTMLElement
    start: HTMLButtonElement
    pause: HTMLButtonElement
    resume: HTMLButtonElement
    stop: HTMLButtonElement
    total: HTMLElement
    speed: HTMLInputElement
    speedValue: HTMLElement
    loop: HTMLInputElement
    count: HTMLElement
    fieldset: HTMLFieldSetElement
    list: HTMLUListElement
    add: HTMLButtonElement
    preset: HTMLButtonElement
    clear: HTMLButtonElement
    exportJson: HTMLButtonElement
    exportCsv: HTMLButtonElement
    lockHint: HTMLElement
  }

  /** 场景内编辑区块的元素(未渲染时为 null) */
  private readonly scene: {
    toggle: HTMLInputElement
    badge: HTMLElement
    status: HTMLElement
    deleteBtn: HTMLButtonElement
    addBtn: HTMLButtonElement
    selectFirst: HTMLButtonElement
    deselect: HTMLButtonElement
    showWaypoints: HTMLInputElement
    showPath: HTMLInputElement
  } | null

  constructor(fly: DroneFly, options: MissionPanelOptions = {}) {
    if (typeof document === 'undefined') {
      throw new Error('[drone-camera] MissionPanel 需要浏览器环境(document),Node 侧请勿实例化')
    }
    this.fly = fly
    this.opts = options
    this.container = options.container ?? document.body
    this.visible = options.visible ?? true

    if (options.injectStyles !== false) ensureStyles()

    // 面板用 absolute 定位到容器;容器若没有定位上下文则补一个 relative,否则会跑到页面左上角
    const host = options.container ?? null
    if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative'
    const layerPosition = host ? 'absolute' : 'fixed'

    this.root = document.createElement('div')
    this.root.className = 'dmp'
    this.root.dataset.position = options.position ?? 'top-left'
    this.root.dataset.adaptive = String(options.adaptive !== false)
    this.root.style.position = layerPosition
    this.root.innerHTML = this.template()
    if (!this.visible) this.root.style.display = 'none'

    this.refs = {
      status: this.query('[data-role="mission-status"]'),
      progress: this.query('[data-role="mission-progress"]'),
      block: this.query('[data-role="mission-block"]'),
      start: this.query<HTMLButtonElement>('[data-action="mission-start"]'),
      pause: this.query<HTMLButtonElement>('[data-action="mission-pause"]'),
      resume: this.query<HTMLButtonElement>('[data-action="mission-resume"]'),
      stop: this.query<HTMLButtonElement>('[data-action="mission-stop"]'),
      total: this.query('[data-role="mission-total"]'),
      speed: this.query<HTMLInputElement>('[data-role="mission-speed"]'),
      speedValue: this.query('[data-role="mission-speed-value"]'),
      loop: this.query<HTMLInputElement>('[data-role="mission-loop"]'),
      count: this.query('[data-role="waypoint-count"]'),
      fieldset: this.query<HTMLFieldSetElement>('[data-role="waypoint-fieldset"]'),
      list: this.query<HTMLUListElement>('[data-role="waypoint-list"]'),
      add: this.query<HTMLButtonElement>('[data-action="waypoint-add"]'),
      preset: this.query<HTMLButtonElement>('[data-action="waypoint-preset"]'),
      clear: this.query<HTMLButtonElement>('[data-action="waypoint-clear"]'),
      exportJson: this.query<HTMLButtonElement>('[data-action="waypoint-export"][data-format="json"]'),
      exportCsv: this.query<HTMLButtonElement>('[data-action="waypoint-export"][data-format="csv"]'),
      lockHint: this.query('[data-role="waypoint-lock"]'),
    }

    const sceneCard = this.root.querySelector<HTMLElement>('[data-blk="scene-edit"]')
    this.scene = sceneCard
      ? {
          toggle: sceneCard.querySelector<HTMLInputElement>('[data-role="scene-edit-toggle"]')!,
          badge: sceneCard.querySelector<HTMLElement>('[data-role="scene-edit-badge"]')!,
          status: sceneCard.querySelector<HTMLElement>('[data-role="scene-edit-status"]')!,
          deleteBtn: sceneCard.querySelector<HTMLButtonElement>('[data-action="scene-delete"]')!,
          addBtn: sceneCard.querySelector<HTMLButtonElement>('[data-action="scene-add"]')!,
          selectFirst: sceneCard.querySelector<HTMLButtonElement>(
            '[data-action="scene-select-first"]',
          )!,
          deselect: sceneCard.querySelector<HTMLButtonElement>('[data-action="scene-deselect"]')!,
          showWaypoints: sceneCard.querySelector<HTMLInputElement>('[data-role="toggle-waypoints"]')!,
          showPath: sceneCard.querySelector<HTMLInputElement>('[data-role="toggle-path"]')!,
        }
      : null

    this.bind()
    this.sync()
    this.mount()
  }

  // ───────────────────────────── 生命周期 ─────────────────────────────

  /** 插入容器(构造时已自动调用一次) */
  mount(): this {
    if (!this.destroyed && !this.root.isConnected) this.container.appendChild(this.root)
    return this
  }

  /** 从容器移除但保留实例,可再次 mount */
  unmount(): this {
    this.root.remove()
    return this
  }

  /** 显示 / 隐藏 */
  setVisible(visible: boolean): this {
    this.visible = visible
    this.root.style.display = visible ? '' : 'none'
    return this
  }

  /** 当前是否可见 */
  isVisible(): boolean {
    return this.visible
  }

  /** 彻底销毁:解绑事件、停轮询、移除 DOM */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.abort.abort()
    this.stopTimer()
    this.root.remove()
  }

  /**
   * 移除已注入的共享样式。
   * 多个面板共存时请等最后一个销毁后再调用,否则其余面板会掉样式。
   */
  static removeInjectedStyles(): void {
    if (typeof document === 'undefined') return
    document.getElementById(STYLE_ID)?.remove()
  }

  // ───────────────────────────── 状态同步 ─────────────────────────────

  /** 把引擎当前状态刷到面板上(任务状态/按钮可用性/参数回显/航点列表/场景编辑) */
  sync(): void {
    if (this.destroyed) return
    const snap = this.fly.getSnapshot()
    const mission = snap.mission
    const editable = mission.status === 'idle'

    // ── 航线任务 ──
    this.refs.status.textContent = MISSION_STATUS_LABELS[mission.status] ?? mission.status
    this.refs.status.className = `dmp-badge${toneClass(mission.status)}`
    this.refs.progress.textContent = this.progressText(mission)
    this.refs.block.textContent = this.blockReason(snap, editable)

    const canStart =
      mission.status === 'idle' &&
      mission.total > 0 &&
      MISSION_STARTABLE_PHASES.includes(snap.phase)
    this.refs.start.disabled = !canStart
    this.refs.pause.disabled = mission.status !== 'running'
    this.refs.resume.disabled = mission.status !== 'paused'
    this.refs.stop.disabled = mission.status === 'idle' && snap.phase !== 'takingOff'

    // ── 任务参数 ──
    this.refs.total.textContent = `${mission.total} 个航点`
    if (!this.speedDragging) {
      this.refs.speed.value = String(mission.config.autoSpeed)
      this.renderSpeed(mission.config.autoSpeed)
    }
    this.writeChecked(this.refs.loop, mission.config.loop)
    this.markActive('[data-action="mission-heading"]', mission.config.headingMode)
    this.markActive('[data-action="mission-path"]', mission.config.pathMode)
    this.markActive('[data-action="mission-finish"]', mission.config.finishAction)

    // ── 航点列表 ──
    if (mission.waypoints.length !== this.lastWaypointCount) {
      this.buildRows(mission.waypoints)
      this.lastWaypointCount = mission.waypoints.length
    }
    this.refs.count.textContent = `${mission.waypoints.length} 个`
    this.refs.fieldset.disabled = !editable
    this.refs.add.disabled = !editable
    this.refs.preset.disabled = !editable
    this.refs.clear.disabled = !editable
    // 导出是只读操作:执行中也能导,只有"没有航点"才没得导
    const noWaypoints = mission.waypoints.length === 0
    this.refs.exportJson.disabled = noWaypoints
    this.refs.exportCsv.disabled = noWaypoints
    this.refs.lockHint.hidden = editable
    this.syncRows(mission)

    // ── 场景内编辑 ──
    if (this.scene) this.syncScene(this.fly.getMissionEditState(), editable)
  }

  // ───────────────────────────── 内部实现:模板 ─────────────────────────────

  private query<T extends HTMLElement = HTMLElement>(selector: string): T {
    const el = this.root.querySelector<T>(selector)
    if (!el) throw new Error(`[drone-camera] 航线面板结构缺失:${selector}`)
    return el
  }

  private template(): string {
    const heading = [
      { value: 'auto', label: '指向下一航点' },
      { value: 'fixed', label: '锁定起始航向' },
    ]
      .map(
        (item) =>
          `<button type="button" data-action="mission-heading" data-value="${item.value}">${item.label}</button>`,
      )
      .join('')
    const path = [
      { value: 'straight', label: '到点减速' },
      { value: 'curved', label: '曲线过点' },
    ]
      .map(
        (item) =>
          `<button type="button" data-action="mission-path" data-value="${item.value}">${item.label}</button>`,
      )
      .join('')
    const finish = FINISH_ACTIONS.map(
      (item) =>
        `<button type="button" data-action="mission-finish" data-value="${item.key}">${item.label}</button>`,
    ).join('')

    return `
      <div class="dmp-head">
        <span class="dmp-title">${escapeHtml(this.opts.title ?? '航线规划')}</span>
        <button type="button" class="dmp-icon" data-action="toggle-collapse" title="收起 / 展开" aria-label="收起或展开">–</button>
      </div>
      <div class="dmp-body">
        <section class="dmp-card">
          <div class="dmp-card-head"><span>航线任务</span><em class="dmp-badge" data-role="mission-status">--</em></div>
          <div class="dmp-btns">
            <button type="button" class="dmp-btn dmp-primary" data-action="mission-start">执行航线</button>
            <button type="button" class="dmp-btn" data-action="mission-pause">暂停</button>
            <button type="button" class="dmp-btn" data-action="mission-resume">继续</button>
            <button type="button" class="dmp-btn dmp-wide" data-action="mission-stop">停止任务(原地悬停)</button>
          </div>
          <p class="dmp-progress" data-role="mission-progress"></p>
          <p class="dmp-block" data-role="mission-block" hidden></p>
          <p class="dmp-fine">地面直接点「执行航线」会先自动起飞,到 1.2 米后自动接上航线;空中启动同样从首个航点走起。飞向首个航点与返航同款分段:先垂直调整到航点高度 → 水平飞过去 → 收到航点高度 → 机头对准航线方向,之后才开始执行航线。执行中拨动摇杆会暂停任务并交回手动控制。</p>
        </section>

        <section class="dmp-card">
          <div class="dmp-card-head"><span>任务参数</span><em data-role="mission-total">0 个航点</em></div>
          <label class="dmp-range-row">
            <span>巡航速度</span>
            <input type="range" data-role="mission-speed" min="${SPEED_MIN}" max="${SPEED_MAX}" step="0.5" value="6" />
            <strong data-role="mission-speed-value">6.0 m/s</strong>
          </label>
          <p class="dmp-row-label">机头朝向</p>
          <div class="dmp-seg dmp-seg-2">${heading}</div>
          <p class="dmp-row-label">过点方式</p>
          <div class="dmp-seg dmp-seg-2">${path}</div>
          <p class="dmp-row-label">全部完成后</p>
          <div class="dmp-seg dmp-seg-3">${finish}</div>
          <label class="dmp-switch"><input type="checkbox" data-role="mission-loop" /><span>循环执行(完成后回到第 1 个航点)</span></label>
          <p class="dmp-fine">曲线过点保持巡航速度、距航点 3 米就切向下一点,所以会忽略航点悬停;直线模式按刹车距离提前收油,过点更稳。</p>
        </section>

        <section class="dmp-card">
          <div class="dmp-card-head"><span>航点列表</span><em data-role="waypoint-count">0 个</em></div>
          <fieldset class="dmp-wp-fieldset" data-role="waypoint-fieldset">
            <ul class="dmp-wp-list" data-role="waypoint-list"></ul>
          </fieldset>
          <div class="dmp-seg dmp-seg-3">
            <button type="button" data-action="waypoint-add">添加航点</button>
            <button type="button" data-action="waypoint-preset">示例航线</button>
            <button type="button" data-action="waypoint-clear">清空</button>
          </div>
          <div class="dmp-seg dmp-seg-2">
            <button type="button" data-action="waypoint-export" data-format="json" title="完整存档:航点 + 任务参数 + 概览统计,可再次载入">导出 JSON</button>
            <button type="button" data-action="waypoint-export" data-format="csv" title="纯航点表,Excel / WPS 可直接打开">导出 CSV</button>
          </div>
          <p class="dmp-fine">导出内容为当前航点与任务参数,坐标与列表一致(相对返航点的东 / 南向偏移)。</p>
          <p class="dmp-fine" data-role="waypoint-lock" hidden>任务执行中:停止任务之后才能修改航点(与真机「航线上传后不可改」一致)。</p>
        </section>

        ${this.sceneEditTemplate()}
      </div>
    `
  }

  /** 「场景内编辑」区块;sceneEdit:false 时整块不渲染 */
  private sceneEditTemplate(): string {
    if (this.opts.sceneEdit === false) return ''
    return `
      <section class="dmp-card" data-blk="scene-edit">
        <div class="dmp-card-head"><span>场景内编辑</span><em class="dmp-badge" data-role="scene-edit-badge">已关闭</em></div>
        <label class="dmp-switch"><input type="checkbox" data-role="scene-edit-toggle" /><span>在三维场景里直接编辑航点</span></label>
        <ul class="dmp-gesture">
          <li><b>拖拽航点</b><span>在它当前高度的水平面内移动</span></li>
          <li><b>Shift + 拖拽</b><span>改高度(按住 Alt 可关掉 1 米吸附)</span></li>
          <li><b>双击地面</b><span>在该处插入一个航点</span></li>
          <li><b>Delete</b><span>删除当前选中的航点,Esc 取消选中</span></li>
        </ul>
        <div class="dmp-status" data-role="scene-edit-status"></div>
        <div class="dmp-seg dmp-seg-3">
          <button type="button" data-action="scene-delete">删除选中</button>
          <button type="button" data-action="scene-add">飞机位置新增</button>
          <button type="button" data-action="scene-frame">框住航线</button>
        </div>
        <div class="dmp-seg dmp-seg-2">
          <button type="button" data-action="scene-select-first">选中第 1 个航点</button>
          <button type="button" data-action="scene-deselect">取消选中</button>
        </div>
        <div class="dmp-switch-row">
          <label class="dmp-switch"><input type="checkbox" data-role="toggle-waypoints" /><span>显示航点</span></label>
          <label class="dmp-switch"><input type="checkbox" data-role="toggle-path" /><span>显示航线</span></label>
        </div>
        <p class="dmp-fine">隐藏只是不画,不影响任务执行;编辑航点则要求航线未在执行,且处于观察者视角(机载视角下屏幕里没有可点的目标)。</p>
      </section>
    `
  }

  /** 单个航点行的 DOM(结构固定,值由 syncRows 原位写入) */
  private rowTemplate(index: number): string {
    const actions = WAYPOINT_ACTIONS.map(
      (item) => `<option value="${item.key}">${item.label}</option>`,
    ).join('')
    return `
      <li class="dmp-wp" data-index="${index}" data-action="waypoint-select">
        <div class="dmp-wp-head">
          <span class="dmp-wp-index">${index + 1}</span>
          <span class="dmp-wp-coord" data-role="wp-coord"></span>
          <button type="button" class="dmp-mini" data-action="waypoint-remove">删除</button>
        </div>
        <div class="dmp-wp-row">
          <label class="dmp-wp-field"><span>X</span><input class="dmp-wp-input" type="number" step="2" data-field="x" /></label>
          <label class="dmp-wp-field"><span>Z</span><input class="dmp-wp-input" type="number" step="2" data-field="z" /></label>
          <label class="dmp-wp-field"><span>高度</span><input class="dmp-wp-input" type="number" step="1" min="1" data-field="altitude" /></label>
        </div>
        <div class="dmp-wp-row">
          <label class="dmp-wp-field"><span>速度</span><input class="dmp-wp-input" type="number" step="1" min="0" max="16" data-field="speed" /></label>
          <label class="dmp-wp-field"><span>悬停</span><input class="dmp-wp-input" type="number" step="1" min="0" max="60" data-field="hoverSeconds" /></label>
          <label class="dmp-wp-field dmp-wp-gimbal">
            <input type="checkbox" data-field="gimbalOn" />
            <span>云台</span>
            <input class="dmp-wp-input" type="number" step="5" min="-90" max="60" data-field="gimbalPitch" />
          </label>
          <label class="dmp-wp-field"><span>动作</span><select class="dmp-wp-select" data-field="action">${actions}</select></label>
        </div>
        <em class="dmp-wp-flag" data-role="wp-flag" hidden>当前目标</em>
      </li>
    `
  }

  /** 重建整张航点列表(仅在航点数量变化时调用) */
  private buildRows(waypoints: MissionWaypoint[]): void {
    this.refs.list.innerHTML = waypoints.length
      ? waypoints.map((_, index) => this.rowTemplate(index)).join('')
      : '<li class="dmp-wp-empty">暂无航点</li>'
  }

  /** 原位写入每个航点行的值:聚焦中的输入框跳过,避免抹掉用户打了一半的数 */
  private syncRows(mission: { waypoints: MissionWaypoint[]; index: number; status: string }): void {
    const rows = this.refs.list.querySelectorAll<HTMLLIElement>('li.dmp-wp')
    const selected = this.fly.getMissionSelected()
    rows.forEach((row, index) => {
      const waypoint = mission.waypoints[index]
      if (!waypoint) return
      row.classList.toggle('is-active', mission.status !== 'idle' && mission.index === index)
      row.classList.toggle('is-selected', selected === index)
      const coord = row.querySelector<HTMLElement>('[data-role="wp-coord"]')
      if (coord) coord.textContent = `E ${waypoint.x} / S ${waypoint.z}`

      const numberInput = (field: WaypointNumberField): void => {
        const input = row.querySelector<HTMLInputElement>(`[data-field="${field}"]`)
        if (input) this.writeValue(input, String(waypoint[field]))
      }
      numberInput('x')
      numberInput('z')
      numberInput('altitude')
      numberInput('speed')
      numberInput('hoverSeconds')

      const gimbalOn = row.querySelector<HTMLInputElement>('[data-field="gimbalOn"]')
      if (gimbalOn) this.writeChecked(gimbalOn, waypoint.gimbalPitch !== null)
      const gimbalPitch = row.querySelector<HTMLInputElement>('[data-field="gimbalPitch"]')
      if (gimbalPitch) {
        this.writeValue(gimbalPitch, String(waypoint.gimbalPitch ?? -45))
        gimbalPitch.disabled = waypoint.gimbalPitch === null
      }
      const action = row.querySelector<HTMLSelectElement>('[data-field="action"]')
      if (action) this.writeValue(action, waypoint.action)

      const flag = row.querySelector<HTMLElement>('[data-role="wp-flag"]')
      if (flag) flag.hidden = mission.status === 'idle' || mission.index !== index
    })
  }

  // ───────────────────────────── 内部实现:事件 ─────────────────────────────

  private bind(): void {
    const { signal } = this.abort

    // 事件委托:整块面板一个 click 句柄,内部按 [data-action] 分发
    this.root.addEventListener(
      'click',
      (event) => {
        const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]')
        if (target) this.handleAction(target.dataset.action ?? '', target)
      },
      { signal },
    )

    // 数字输入 / 下拉 / 勾选:统一在航点列表上委托
    this.refs.list.addEventListener('input', (event) => this.handleRowInput(event), { signal })
    this.refs.list.addEventListener('change', (event) => this.handleRowInput(event), { signal })

    // 巡航速度滑杆:拖动期间暂停回写,免得和用户的手打架
    this.refs.speed.addEventListener(
      'input',
      () => {
        const value = Number(this.refs.speed.value)
        if (!Number.isFinite(value)) return
        this.fly.setMissionConfig({ autoSpeed: value })
        this.renderSpeed(value)
      },
      { signal },
    )
    this.refs.speed.addEventListener('pointerdown', () => (this.speedDragging = true), { signal })
    window.addEventListener('pointerup', () => (this.speedDragging = false), { signal })

    // 循环执行
    this.refs.loop.addEventListener(
      'change',
      () => this.fly.setMissionConfig({ loop: this.refs.loop.checked }),
      { signal },
    )

    if (this.scene) {
      this.scene.toggle.addEventListener(
        'change',
        () => {
          this.fly.setMissionEditEnabled(this.scene?.toggle.checked ?? false)
          this.sync()
        },
        { signal },
      )
      this.scene.showWaypoints.addEventListener(
        'change',
        () => this.fly.setMissionWaypointsVisible(this.scene?.showWaypoints.checked ?? true),
        { signal },
      )
      this.scene.showPath.addEventListener(
        'change',
        () => this.fly.setMissionPathVisible(this.scene?.showPath.checked ?? true),
        { signal },
      )
    }

    if (this.opts.syncIntervalMs !== 0) {
      this.timer = window.setInterval(() => this.sync(), this.opts.syncIntervalMs ?? DEFAULT_SYNC_MS)
    }
  }

  private handleAction(action: string, target: HTMLElement): void {
    const fly = this.fly
    const rowIndex = (): number => Number(target.closest<HTMLElement>('.dmp-wp')?.dataset.index ?? -1)
    switch (action) {
      case 'toggle-collapse':
        this.root.dataset.collapsed = String(this.root.dataset.collapsed !== 'true')
        break
      case 'mission-start':
        fly.startMission()
        break
      case 'mission-pause':
        fly.pauseMission('用户暂停')
        break
      case 'mission-resume':
        fly.resumeMission()
        break
      case 'mission-stop':
        fly.stopMission('用户停止')
        break
      case 'mission-heading':
        fly.setMissionConfig({ headingMode: target.dataset.value as MissionHeadingMode })
        break
      case 'mission-path':
        fly.setMissionConfig({ pathMode: target.dataset.value as MissionPathMode })
        break
      case 'mission-finish':
        fly.setMissionConfig({ finishAction: target.dataset.value as MissionFinishAction })
        break
      case 'waypoint-add':
        this.addWaypoint()
        break
      case 'waypoint-preset':
        this.selectWaypoint(-1)
        fly.resetMissionToDefault()
        break
      case 'waypoint-clear':
        this.selectWaypoint(-1)
        fly.setMission([])
        break
      case 'waypoint-export':
        this.exportMission(target.dataset.format === 'csv' ? 'csv' : 'json', target)
        break
      case 'waypoint-select':
        this.selectWaypoint(rowIndex())
        break
      case 'waypoint-remove':
        this.removeWaypoint(rowIndex())
        break
      case 'scene-delete':
        this.deleteSelected()
        break
      case 'scene-add':
        this.addAtDrone()
        break
      case 'scene-frame':
        fly.frameMission()
        break
      case 'scene-select-first':
        this.selectWaypoint(0)
        break
      case 'scene-deselect':
        this.selectWaypoint(-1)
        break
      default:
        return
    }
    this.sync()
  }

  /** 航点行内的字段编辑(数字 / 勾选 / 下拉共用一条路径) */
  private handleRowInput(event: Event): void {
    const field = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-field]')
    const index = Number((field?.closest('.dmp-wp') as HTMLElement | null)?.dataset.index ?? -1)
    if (!field || index < 0) return
    const name = field.dataset.field ?? ''

    if (name === 'gimbalOn') {
      const enabled = (field as HTMLInputElement).checked
      this.patchWaypoint(index, { gimbalPitch: enabled ? -45 : null })
      return
    }
    if (name === 'action') {
      const value = (field as HTMLSelectElement).value === 'photo' ? 'photo' : 'none'
      this.patchWaypoint(index, { action: value })
      return
    }
    if (!(name in FIELD_RANGES)) return
    const key = name as WaypointNumberField
    const raw = (event.target as HTMLInputElement).value.trim()
    // 允许 "-" / "1." 这类输入中间态留在框里,不往下发
    if (raw === '') return
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    const range = FIELD_RANGES[key]
    this.patchWaypoint(index, { [key]: clamp(value, range.min, range.max) } as Partial<MissionWaypoint>)
  }

  // ───────────────────────────── 内部实现:动作 ─────────────────────────────

  /** 航点列表的权威来源是仿真内核,不是面板快照(快照 100ms 才刷一次,连续编辑会丢格) */
  private waypoints(): MissionWaypoint[] {
    return this.fly.sim.mission.map((waypoint) => ({ ...waypoint }))
  }

  private patchWaypoint(index: number, patch: Partial<MissionWaypoint>): void {
    const list = this.waypoints().map((waypoint, i) =>
      i === index ? { ...waypoint, ...patch } : waypoint,
    )
    this.fly.setMission(list)
  }

  private addWaypoint(): void {
    const list = this.waypoints()
    const last = list[list.length - 1]
    const next: Partial<MissionWaypoint> = last
      ? { x: last.x + 12, z: last.z, altitude: last.altitude, speed: last.speed }
      : { x: 0, z: -30, altitude: 30, speed: 0, hoverSeconds: 0, gimbalPitch: null, action: 'none' }
    this.fly.setMission([...list, next])
    this.revealRow(this.fly.sim.mission.length - 1)
  }

  private removeWaypoint(index: number): void {
    if (index < 0) return
    this.fly.setMission(this.waypoints().filter((_, i) => i !== index))
    // 删掉的可能正是场景里选中的那个,索引会整体前移,直接取消选中最不容易出错
    this.selectWaypoint(-1)
  }

  /**
   * 导出航线(只读操作,任务执行中也允许)。
   *
   * 默认把序列化结果落成本地文件:`json` 是完整存档(坐标约定 + 任务参数 + 概览统计),
   * `csv` 是纯航点表(带 UTF-8 BOM,Excel / WPS 双击不乱码)。
   * 宿主传了 `onExport` 时改由宿主接管保存,这里只把文本递出去。
   */
  private exportMission(format: MissionExportFormat, button: HTMLElement): void {
    const text = this.fly.exportMission(format)
    const filename = missionFilename(format)
    const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json'

    if (this.opts.onExport) {
      this.opts.onExport({ format, text, filename, mime })
      this.flashButton(button, '已交给宿主')
      return
    }

    const blob = new Blob([format === 'csv' ? `\ufeff${text}` : text], { type: mime })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.rel = 'noopener'
    // Firefox 要求链接在文档里才会响应 click
    document.body.appendChild(link)
    link.click()
    link.remove()
    // 立刻 revoke 有概率让浏览器来不及取数据,留一拍
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
    this.flashButton(button, '已导出')
  }

  /** 按钮上的短反馈(导出完成 / 已交给宿主),1.4s 后恢复原文案 */
  private flashButton(button: HTMLElement, text: string): void {
    if (!button.dataset.label) button.dataset.label = button.textContent ?? ''
    button.textContent = text
    window.setTimeout(() => {
      if (button.dataset.label) button.textContent = button.dataset.label
    }, 1400)
  }

  /** 选中航点(-1 = 取消):面板列表与三维场景共用同一份选中态 */
  private selectWaypoint(index: number): void {
    this.fly.setMissionSelected(index)
    if (index >= 0) this.revealRow(index)
  }

  private deleteSelected(): void {
    const index = this.fly.getMissionSelected()
    if (index < 0) return
    this.fly.deleteMissionWaypoint(index)
  }

  private addAtDrone(): void {
    const index = this.fly.addMissionWaypointAtDrone()
    if (index >= 0) this.revealRow(index)
  }

  /** 从场景里选中时,把列表里对应的那一行滚进视野(列表有最大高度) */
  private revealRow(index: number): void {
    const row = this.refs.list.querySelector<HTMLElement>(`[data-index="${index}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }

  // ───────────────────────────── 内部实现:渲染小件 ─────────────────────────────

  private renderSpeed(value: number): void {
    this.refs.speedValue.textContent = `${value.toFixed(1)} m/s`
  }

  /** 分段按钮的选中态:按 data-value 打标 */
  private markActive(selector: string, value: string): void {
    this.root.querySelectorAll<HTMLElement>(selector).forEach((button) => {
      button.classList.toggle('is-active', button.dataset.value === value)
    })
  }

  /** 写入输入框的值;聚焦中的框跳过(用户可能正在输入中间态) */
  private writeValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
    if (document.activeElement === input) return
    if (input.value !== value) input.value = value
  }

  /**
   * 写入勾选态;聚焦中的框跳过 —— 不只是为了不打架,还是正确性要求:
   * 航点行整行可点(选中航点),点击复选框会先冒泡到面板触发一次 sync;
   * 此刻浏览器把 checked 置为 true、但 input/change 事件尚未派发,若这里照写引擎值(false)
   * 就会把刚勾上的框拽回去,随后 change 又读到 false —— 勾选"点了没反应"。
   */
  private writeChecked(input: HTMLInputElement, checked: boolean): void {
    if (document.activeElement === input) return
    if (input.checked !== checked) input.checked = checked
  }

  private progressText(mission: {
    status: string
    stage: MissionStage
    index: number
    total: number
    progress: number
    etaSeconds: number
  }): string {
    if (mission.status === 'idle') {
      return mission.total ? `待执行 · 共 ${mission.total} 个航点` : '暂无航线'
    }
    const head = isMissionDepartStage(mission.stage)
      ? `启航(航点 1/${mission.total}) · ${this.stageLabel(mission.stage)}`
      : `第 ${mission.index + 1}/${mission.total} 个航点 · ${this.stageLabel(mission.stage)}`
    const percent = `${Math.round(mission.progress * 100)}%`
    const seconds = mission.etaSeconds
    const eta =
      seconds >= 60
        ? `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`
        : `${seconds.toFixed(0)} 秒`
    return `${head} · ${percent} · 剩余 ${eta}`
  }

  private stageLabel(stage: string): string {
    const labels: Record<string, string> = {
      idle: '待执行',
      'depart-climb': '垂直调整到首航点高度',
      'depart-cruise': '水平飞向首个航点',
      'depart-settle': '调整到航点高度',
      'depart-align': '对准航线方向',
      goto: '飞向航点',
      hover: '航点悬停',
    }
    return labels[stage] ?? stage
  }

  /** 启动不了时把原因摆出来,别让按钮灰着却没有解释 */
  private blockReason(
    snap: { phase: string; phaseLabel: string; positionSource: string; mission: { status: string; total: number } },
    editable: boolean,
  ): string {
    if (!editable) return ''
    const mission = snap.mission
    if (mission.total === 0) return '航线为空:先「添加航点」或「示例航线」'
    if (snap.positionSource === 'atti') return '当前无定位(姿态模式),航点任务需要 GNSS'
    if (!MISSION_STARTABLE_PHASES.includes(snap.phase)) {
      return `当前阶段(${snap.phaseLabel})无法启动航线`
    }
    return ''
  }

  private syncScene(state: MissionEditState, editable: boolean): void {
    const scene = this.scene
    if (!scene) return
    this.writeChecked(scene.toggle, state.enabled)

    const badge = !state.enabled
      ? { label: '已关闭', tone: '' }
      : state.dragging
        ? { label: '拖动中', tone: ' is-warn' }
        : state.active
          ? { label: '编辑中', tone: ' is-ok' }
          : { label: '待切换视角', tone: ' is-warn' }
    scene.badge.textContent = badge.label
    scene.badge.className = `dmp-badge${badge.tone}`

    // 状态行:优先报拖动动作,其次报选中/未选中,最后才提示"为什么不能编"
    const waypoint = state.selectedIndex >= 0 ? this.fly.sim.mission[state.selectedIndex] : null
    let text: string
    if (waypoint) {
      text = `已选中 航点 ${state.selectedIndex + 1} · E ${waypoint.x} / S ${waypoint.z} / ${waypoint.altitude.toFixed(0)} m`
    } else {
      text = '未选中航点(在场景里点一下航点光柱)'
    }
    if (state.dragging) {
      text += ` · ${state.mode === 'altitude' ? '调整高度中' : '移动中'}`
    } else if (state.enabled && !state.active) {
      text += ` · ${this.sceneBlockReason(editable)}`
    }
    scene.status.textContent = text

    scene.deleteBtn.disabled = state.selectedIndex < 0 || !editable
    scene.addBtn.disabled = !editable
    scene.selectFirst.disabled = this.fly.sim.mission.length === 0
    scene.deselect.disabled = state.selectedIndex < 0
    this.writeChecked(scene.showWaypoints, this.fly.isMissionWaypointsVisible())
    this.writeChecked(scene.showPath, this.fly.isMissionPathVisible())
  }

  private sceneBlockReason(editable: boolean): string {
    if (!editable) return '任务执行中不可编辑'
    if (!this.fly.isOrbitView) return '需切到观察者视角'
    return '当前不可编辑'
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }
}

/** 导出文件名:`mission-20261010-181530.json` —— 带本地时间戳,同一目录里多次导出不会互相覆盖 */
function missionFilename(format: MissionExportFormat): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `mission-${stamp}.${format}`
}

/** 任务状态 → 角标配色 */
function toneClass(status: string): string {
  if (status === 'running') return ' is-ok'
  if (status === 'paused') return ' is-warn'
  return ''
}

const PANEL_CSS = `
.dmp {
  --dmp-bg: rgba(15, 19, 27, 0.84);
  --dmp-card: rgba(255, 255, 255, 0.04);
  --dmp-border: rgba(255, 255, 255, 0.12);
  --dmp-text: #e9eff9;
  --dmp-muted: rgba(233, 239, 249, 0.58);
  --dmp-accent: #35a7ff;
  --dmp-on-accent: #04121f;
  --dmp-warn: #ffc53d;
  --dmp-danger: #ff5f5f;
  --dmp-ok: #3ddc97;
  --dmp-radius: 10px;
  /* 面板底部留出的避让高度:这套 HUD 布局里画面两下角是虚拟摇杆(底盘 92px + 上下留白),
     面板别压上去 —— 摇杆悬浮层 z-index 更高、仍可点,但叠着既难看又容易误触。
     宿主没有摇杆时可自行改小(例如 --dmp-clear-bottom: 24px) */
  --dmp-clear-bottom: 188px;
  font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  overscroll-behavior: contain;
  z-index: 20;
  width: 262px;
  box-sizing: border-box;
  padding: 10px 12px 12px;
  border: 1px solid var(--dmp-border);
  border-radius: var(--dmp-radius);
  background: var(--dmp-bg);
  color: var(--dmp-text);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  max-height: calc(100% - var(--dmp-clear-bottom));
  display: flex;
  flex-direction: column;
}
.dmp[data-position="top-left"] { top: 12px; left: 12px; }
.dmp[data-position="top-right"] { top: 12px; right: 12px; }
.dmp[data-position="bottom-left"] { bottom: 12px; left: 12px; }
.dmp[data-position="bottom-right"] { bottom: 12px; right: 12px; }
.dmp button, .dmp input, .dmp select { touch-action: manipulation; font: inherit; }
.dmp-hidden, .dmp [hidden] { display: none !important; }

.dmp-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.dmp-title { flex: 1; font-weight: 600; letter-spacing: 0.4px; }
.dmp-icon {
  width: 22px; height: 22px; flex: none; line-height: 1;
  border: 1px solid var(--dmp-border); border-radius: 6px;
  background: transparent; color: var(--dmp-text); cursor: pointer;
}
.dmp-icon:hover { background: rgba(255, 255, 255, 0.08); }
.dmp[data-collapsed="true"] .dmp-body { display: none; }

.dmp-body { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding-right: 2px; }
.dmp-body::-webkit-scrollbar { width: 6px; }
.dmp-body::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.16); border-radius: 3px; }

.dmp-card {
  padding: 8px 9px 9px;
  border: 1px solid var(--dmp-border);
  border-radius: 8px;
  background: var(--dmp-card);
}
.dmp-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
.dmp-card-head > span { flex: 1; font-weight: 600; }
.dmp-card-head em { font-style: normal; font-size: 11px; color: var(--dmp-muted); }

.dmp-badge {
  flex: none; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--dmp-border);
  background: rgba(255, 255, 255, 0.06);
  color: var(--dmp-muted); font-size: 11px;
}
.dmp-badge.is-ok { color: var(--dmp-ok); border-color: rgba(61, 220, 151, 0.4); }
.dmp-badge.is-warn { color: var(--dmp-warn); border-color: rgba(255, 197, 61, 0.4); }

.dmp-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.dmp-btn {
  padding: 6px 8px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--dmp-border);
  background: rgba(255, 255, 255, 0.06);
  color: var(--dmp-text);
}
.dmp-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); }
.dmp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.dmp-btn.dmp-primary { background: var(--dmp-accent); border-color: var(--dmp-accent); color: var(--dmp-on-accent); font-weight: 600; }
.dmp-btn.dmp-primary:hover:not(:disabled) { filter: brightness(1.08); }
.dmp-btn.dmp-wide { grid-column: 1 / -1; }

.dmp-progress { margin: 7px 0 0; color: var(--dmp-accent); font-size: 11px; }
.dmp-block { margin: 5px 0 0; padding: 5px 7px; border-radius: 6px; background: rgba(255, 95, 95, 0.12); color: #ffb3b3; font-size: 11px; }
.dmp-fine { margin: 6px 0 0; color: var(--dmp-muted); font-size: 11px; line-height: 1.45; }
.dmp-row-label { margin: 7px 0 4px; color: var(--dmp-muted); font-size: 11px; }

.dmp-range-row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; }
.dmp-range-row > span { color: var(--dmp-muted); font-size: 11px; }
.dmp-range-row strong { font-variant-numeric: tabular-nums; font-size: 11px; }
.dmp-range-row input[type="range"] { width: 100%; accent-color: var(--dmp-accent); }

.dmp-seg { display: grid; gap: 4px; }
.dmp-seg-2 { grid-template-columns: 1fr 1fr; }
.dmp-seg-3 { grid-template-columns: repeat(3, 1fr); }
.dmp-seg button {
  padding: 5px 4px; border-radius: 6px; cursor: pointer; font-size: 11px;
  border: 1px solid var(--dmp-border);
  background: rgba(255, 255, 255, 0.05);
  color: var(--dmp-text);
}
.dmp-seg button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.11); }
.dmp-seg button:disabled { opacity: 0.4; cursor: not-allowed; }
.dmp-seg button.is-active { background: var(--dmp-accent); border-color: var(--dmp-accent); color: var(--dmp-on-accent); font-weight: 600; }

.dmp-switch { display: flex; align-items: center; gap: 6px; margin-top: 7px; cursor: pointer; }
.dmp-switch input { flex: none; accent-color: var(--dmp-accent); }
.dmp-switch > span { font-size: 11px; }
.dmp-switch-row { display: flex; gap: 14px; }

.dmp-wp-fieldset { margin: 0; padding: 0; border: 0; min-width: 0; }
.dmp-wp-fieldset:disabled { opacity: 0.55; }
.dmp-wp-list { list-style: none; margin: 0; padding: 0; max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.dmp-wp-list::-webkit-scrollbar { width: 6px; }
.dmp-wp-list::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.16); border-radius: 3px; }
.dmp-wp-empty { color: var(--dmp-muted); font-size: 11px; padding: 6px 2px; }
.dmp-wp {
  position: relative; padding: 6px 6px 7px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--dmp-border);
  background: rgba(255, 255, 255, 0.03);
}
.dmp-wp.is-selected, .dmp-wp:hover { border-color: rgba(53, 167, 255, 0.5); }
.dmp-wp.is-active { border-color: var(--dmp-ok); box-shadow: 0 0 0 1px rgba(61, 220, 151, 0.35) inset; }
.dmp-wp-head { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
.dmp-wp-index {
  flex: none; width: 18px; height: 18px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: rgba(53, 167, 255, 0.2); color: var(--dmp-accent); font-size: 11px; font-weight: 600;
}
.dmp-wp-coord { flex: 1; color: var(--dmp-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.dmp-mini {
  flex: none; padding: 2px 7px; border-radius: 5px; cursor: pointer; font-size: 11px;
  border: 1px solid var(--dmp-border);
  background: transparent; color: var(--dmp-danger);
}
.dmp-mini:hover { background: rgba(255, 95, 95, 0.14); }
.dmp-wp-row { display: grid; grid-template-columns: 1fr 1fr 1.25fr; gap: 5px; margin-bottom: 5px; }
.dmp-wp-row:last-of-type { margin-bottom: 0; grid-template-columns: repeat(2, 1fr); }
.dmp-wp-field { display: flex; align-items: center; gap: 4px; min-width: 0; }
.dmp-wp-field > span { flex: none; color: var(--dmp-muted); font-size: 11px; }
.dmp-wp-gimbal { grid-column: span 2; }
.dmp-wp-input {
  width: 100%; min-width: 0; box-sizing: border-box;
  padding: 3px 4px; border-radius: 5px;
  border: 1px solid var(--dmp-border);
  background: rgba(0, 0, 0, 0.28); color: var(--dmp-text); font-size: 11px;
  font-variant-numeric: tabular-nums;
}
/* Chrome/Edge 的数字框默认带上下调节箭头,窄格里能吃掉十几像素 —— 藏掉它,
   否则"500"这种三位数会裁得只剩"5",看起来就像列表高度和场景对不上 */
.dmp-wp-input::-webkit-outer-spin-button,
.dmp-wp-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.dmp-wp-input[type='number'] { -moz-appearance: textfield; appearance: textfield; }
.dmp-wp-input:focus { outline: none; border-color: var(--dmp-accent); }
.dmp-wp-input:disabled { opacity: 0.45; }
.dmp-wp-select {
  width: 100%; min-width: 0; box-sizing: border-box;
  padding: 3px 4px; border-radius: 5px;
  border: 1px solid var(--dmp-border);
  background: rgba(0, 0, 0, 0.28); color: var(--dmp-text); font-size: 11px;
}
.dmp-wp-flag {
  position: absolute; top: -6px; right: 8px;
  padding: 0 6px; border-radius: 999px; font-style: normal; font-size: 10px;
  background: var(--dmp-ok); color: #03231a; font-weight: 600;
}
.dmp-gesture { list-style: none; margin: 7px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.dmp-gesture li { display: flex; gap: 8px; font-size: 11px; }
.dmp-gesture b { flex: none; width: 74px; color: var(--dmp-text); font-weight: 600; }
.dmp-gesture span { color: var(--dmp-muted); }
.dmp-status { margin: 7px 0; padding: 5px 7px; border-radius: 6px; background: rgba(255, 255, 255, 0.05); font-size: 11px; color: var(--dmp-muted); }

@media (max-height: 620px) {
  .dmp[data-adaptive="true"] { width: 232px; padding: 8px 9px 9px; }
  .dmp[data-adaptive="true"] .dmp-wp-list { max-height: 168px; }
  .dmp[data-adaptive="true"] .dmp-fine { display: none; }
  .dmp[data-adaptive="true"] .dmp-gesture { display: none; }
}
`
