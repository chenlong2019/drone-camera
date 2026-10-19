/**
 * 影像采集面板(原生 DOM):采集会话 / 虚拟采集 / 真实照片导入 / 导出 —— 只放**动作**。
 *
 * 与 drone-panel / mission-panel / drone-minimap 是同一套范式:只用 DOM + CSS,
 * 不引任何 UI 框架,库整体保持与框架无关(Vue / React / 裸页面通用)。
 *
 * 面板自身不持有采集状态 —— 状态全在 `CaptureService` 里(影像集、会话、自动采集句柄),
 * 面板只是它的一个视图:订阅 `service.subscribe()` 后在**局部**刷新计数,
 * 不整体重绘骨架(否则会打断正在输入的间隔 / 距离框)。
 *
 * 三处刻意的设计:
 * - 面板按会话的 `source` 分别展示「虚拟采集」与「真实导入」两套入口 —— 两类影像的采集动作
 *   本来就不是一回事(一个是快门,一个是文件),混在一起只会让人误操作;
 * - 「自动采集」走的是服务里 200ms 心跳上的时间 / 距离双触发,面板只负责把开关与参数递进去;
 * - **影像的浏览与合成不在这里**。面板只有 300 多像素宽,缩略图 + 统计 + 详情 + 导出全塞进来
 *   既看不清全局又要滚半天。所以「影像集」整体交给 `DroneGallery` 弹窗(按组合分组、
 *   每组一键合成、点缩略图看大图),面板只留一个入口按钮。弹窗住在 `document.body` 上、
 *   不在面板里 —— 面板带 `backdrop-filter`,会改 `fixed` 后代的定位基准。
 */
import { CaptureService } from './drone-capture'
import type {
  CaptureExportFormat,
  CaptureSession,
  CaptureSessionOptions,
  ImageSource,
  VirtualCaptureProvider,
} from './drone-capture'
// 影像文案与无害 DOM 工具在面板 / 弹窗查看器 / 影像集弹窗之间共用(见 drone-image-utils 模块头)
import { escapeHtml, groupSessionImages, triggerDownload } from './drone-image-utils'
import { DroneImageViewer } from './drone-image-viewer'
import type { DroneImageViewerOptions } from './drone-image-viewer'
import { DroneGallery } from './drone-gallery'
import type { DroneGalleryOptions } from './drone-gallery'

/** 面板停靠位置(与 DroneControlPanel 同一组取值) */
export type DroneCapturePanelPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** DroneCapturePanel 构造选项 */
export interface DroneCapturePanelOptions {
  /** 挂载容器;缺省挂到 document.body(此时用 fixed 定位) */
  container?: HTMLElement | null
  /** 停靠位置,默认 'bottom-left'(three 页左上/右上/底部中央已被别的面板占用) */
  position?: DroneCapturePanelPosition
  /**
   * 停靠微调(像素)。用 margin 实现,不覆盖 position 的定位规则 ——
   * 演示页里底部左右角已经被 HUD 摇杆占住,面板整体上抬一段就能错开。
   */
  offset?: { x?: number; y?: number }
  /** 面板标题,默认「影像采集」 */
  title?: string
  /** 是否注入自带样式,默认 true */
  injectStyles?: boolean
  /** 初始是否可见,默认 true */
  visible?: boolean
  /** 已有采集服务(多面板共享一个会话列表时传入);缺省按 host 新建一个 */
  service?: CaptureService
  /** 挂载时若一个会话都没有,是否自动建一个虚拟采集会话,默认 true */
  autoCreateSession?: boolean
  /**
   * 新建会话时套用的默认参数(场景标识 / 地理参考原点 / 自动采集间隔)。
   * 宿主知道自己跑在哪个场景里,把这些填上,采到的影像才带得上场景版本与经纬度。
   */
  sessionDefaults?: Partial<CaptureSessionOptions>
  /** 导出时是否顺手触发浏览器下载,默认 true */
  downloadOnExport?: boolean
  /**
   * 是否启用大图查看器(影像集弹窗点缩略图时打开),默认 true。
   * 弹窗挂在 `document.body` 上(不是面板内部,原因见 drone-image-viewer 模块头),
   * 层级 / 下载按钮 / 翻页回调等细项走 `viewerOptions`。
   */
  viewer?: boolean
  /** 弹窗查看器的细项(层级 / 是否提供下载 / 关闭与翻页回调) */
  viewerOptions?: DroneImageViewerOptions
  /**
   * 是否启用影像集弹窗(面板上的「打开影像集」按钮),默认 true。
   * 影像的浏览 / 分组 / 一键合成都在它里面(见 drone-gallery);`false` 则面板不提供该入口。
   */
  gallery?: boolean
  /** 影像集弹窗的细项(层级 / 合成器 / 关闭与合成回调) */
  galleryOptions?: DroneGalleryOptions
}

const STYLE_ID = 'drone-capture-panel-styles'
/** 自动采集默认间隔(秒) */
const DEFAULT_INTERVAL_SECONDS = 1

const PANEL_CSS = `
.dcap {
  --dcap-bg: rgba(15, 19, 27, 0.86);
  --dcap-border: rgba(255, 255, 255, 0.12);
  --dcap-text: #e9eff9;
  --dcap-muted: rgba(233, 239, 249, 0.58);
  --dcap-accent: #35a7ff;
  --dcap-on-accent: #04121f;
  --dcap-ok: #37d67a;
  --dcap-warn: #f5a623;
  --dcap-danger: #ff5f5f;
  --dcap-radius: 10px;
  font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.dcap {
  z-index: 20;
  width: 316px;
  max-height: min(62vh, 580px);
  box-sizing: border-box;
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dcap-border);
  border-radius: var(--dcap-radius);
  background: var(--dcap-bg);
  color: var(--dcap-text);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}
.dcap[data-position="top-left"] { top: 12px; left: 12px; }
.dcap[data-position="top-right"] { top: 12px; right: 12px; }
.dcap[data-position="bottom-left"] { bottom: 12px; left: 12px; }
.dcap[data-position="bottom-right"] { bottom: 12px; right: 12px; }
.dcap-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.dcap-title { font-size: 12px; font-weight: 600; }
.dcap-count { margin-left: auto; color: var(--dcap-muted); font-variant-numeric: tabular-nums; }
.dcap-icon {
  width: 20px; height: 20px; padding: 0; line-height: 1; cursor: pointer;
  border: 1px solid var(--dcap-border); border-radius: 6px;
  background: rgba(255, 255, 255, 0.06); color: var(--dcap-text);
}
.dcap-body { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.dcap[data-collapsed="true"] .dcap-body { display: none; }
.dcap-blk { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--dcap-border); }
.dcap-blk:first-child { margin-top: 0; padding-top: 0; border-top: none; }
.dcap-label {
  display: flex; justify-content: space-between; align-items: baseline;
  color: var(--dcap-muted); margin-bottom: 6px;
}
.dcap-label em { font-style: normal; color: var(--dcap-text); font-variant-numeric: tabular-nums; }
.dcap-row { display: flex; gap: 6px; align-items: center; margin-bottom: 7px; }
.dcap-row > .dcap-field { flex: 1; min-width: 0; }
.dcap-btn {
  flex: 1; min-height: 28px; padding: 4px 8px; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--dcap-border); border-radius: 8px;
  background: rgba(255, 255, 255, 0.06); color: var(--dcap-text); font: inherit;
}
.dcap-btn:hover { background: rgba(255, 255, 255, 0.12); }
.dcap-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
.dcap-btn.dcap-primary { background: var(--dcap-accent); border-color: transparent; color: var(--dcap-on-accent); font-weight: 600; }
.dcap-btn.dcap-on { background: var(--dcap-danger); border-color: transparent; color: #fff; font-weight: 600; }
.dcap-select, .dcap-num, .dcap-text {
  box-sizing: border-box; width: 100%; min-height: 26px; padding: 2px 6px;
  border: 1px solid var(--dcap-border); border-radius: 7px;
  background: rgba(255, 255, 255, 0.06); color: var(--dcap-text); font: inherit;
}
.dcap-num { width: 62px; text-align: right; font-variant-numeric: tabular-nums; }
.dcap-select:focus, .dcap-num:focus, .dcap-text:focus { outline: none; border-color: var(--dcap-accent); }
.dcap-field { display: flex; align-items: center; gap: 5px; color: var(--dcap-muted); white-space: nowrap; }
.dcap-hint { margin: 2px 0 0; color: var(--dcap-muted); font-size: 11px; }
.dcap-note {
  margin: 6px 0 0; padding: 5px 7px; border-radius: 7px; font-size: 11px; line-height: 1.5;
  background: rgba(255, 255, 255, 0.05); color: var(--dcap-muted);
}
.dcap-note[hidden] { display: none; }
.dcap-note.is-warn { color: var(--dcap-warn); }
@media (pointer: coarse) { .dcap-btn { min-height: 34px; } }
`

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
}

/** 生成文件名用的时间戳(本地时间,精确到秒) */
function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/**
 * 影像采集面板。
 *
 * ```ts
 * const panel = new DroneCapturePanel(fly, { container: viewportEl, position: 'bottom-left' })
 * // 卸载:panel.destroy()
 * ```
 */
export class DroneCapturePanel {
  /** 采集服务(面板的视图数据源;宿主可直接用它编程式采集 / 导出) */
  readonly service: CaptureService
  private readonly host: HTMLElement
  private readonly root: HTMLDivElement
  private readonly refs: {
    body: HTMLElement
    count: HTMLElement
    sessionSelect: HTMLSelectElement
    sessionName: HTMLElement
    sourceSelect: HTMLSelectElement
    nameInput: HTMLInputElement
    virtualBlock: HTMLElement
    realBlock: HTMLElement
    intervalInput: HTMLInputElement
    distanceInput: HTMLInputElement
    autoBtn: HTMLButtonElement
    autoState: HTMLElement
    galleryCount: HTMLElement
    galleryBtn: HTMLButtonElement
    note: HTMLElement
    fileInput: HTMLInputElement
    dirInput: HTMLInputElement
  }
  private readonly options: DroneCapturePanelOptions
  /** 大图查看器(影像集弹窗点缩略图时打开);`viewer` / `gallery` 关掉时为 null */
  private viewer: DroneImageViewer | null = null
  /** 影像集弹窗(浏览 / 分组 / 一键合成);`options.gallery === false` 时为 null */
  private gallery: DroneGallery | null = null
  private unsubscribe: (() => void) | null = null
  private sessionSignature = ''
  private noteTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  /** 构造采集面板:模式/张数/开始按钮 + 会话相册入口 */
  constructor(host: VirtualCaptureProvider, options: DroneCapturePanelOptions = {}) {
    if (typeof document === 'undefined') throw new Error('[DroneCapturePanel] 需要 DOM 环境')
    this.options = options
    if (options.injectStyles !== false) ensureStyles()

    this.service = options.service ?? new CaptureService({ provider: host })
    // 换后端(机体切换)后重新绑定取景帧来源
    if (!options.service) this.service.setProvider(host)

    const container = options.container ?? null
    this.host = container ?? document.body
    // 面板用 absolute 定位到容器;容器没有定位上下文时补一个 relative,否则会跑到页面左上角
    if (container && getComputedStyle(container).position === 'static') {
      container.style.position = 'relative'
    }

    this.root = document.createElement('div')
    this.root.className = 'dcap'
    this.root.dataset.position = options.position ?? 'bottom-left'
    this.root.dataset.collapsed = 'false'
    this.root.style.position = container ? 'absolute' : 'fixed'
    // 停靠微调用 margin:与 position 类里的 top/left/bottom/right 是两套独立机制,互不覆盖
    const position = options.position ?? 'bottom-left'
    const offset = options.offset ?? {}
    if (offset.y) {
      const key = position.startsWith('bottom') ? 'marginBottom' : 'marginTop'
      this.root.style[key] = `${offset.y}px`
    }
    if (offset.x) {
      const key = position.endsWith('right') ? 'marginRight' : 'marginLeft'
      this.root.style[key] = `${offset.x}px`
    }
    if (options.visible === false) this.root.style.display = 'none'
    this.root.innerHTML = this.template()
    this.host.appendChild(this.root)
    this.refs = {
      body: this.query('[data-role="body"]'),
      count: this.query('[data-role="count"]'),
      sessionSelect: this.query<HTMLSelectElement>('[data-role="session-select"]'),
      sessionName: this.query('[data-role="session-name"]'),
      sourceSelect: this.query<HTMLSelectElement>('[data-role="source-select"]'),
      nameInput: this.query<HTMLInputElement>('[data-role="name-input"]'),
      virtualBlock: this.query('[data-blk="virtual"]'),
      realBlock: this.query('[data-blk="real"]'),
      intervalInput: this.query<HTMLInputElement>('[data-role="interval"]'),
      distanceInput: this.query<HTMLInputElement>('[data-role="distance"]'),
      autoBtn: this.query<HTMLButtonElement>('[data-action="auto-toggle"]'),
      autoState: this.query('[data-role="auto-state"]'),
      galleryCount: this.query('[data-role="gallery-count"]'),
      galleryBtn: this.query<HTMLButtonElement>('[data-action="open-gallery"]'),
      note: this.query('[data-role="note"]'),
      fileInput: this.query<HTMLInputElement>('[data-role="file-input"]'),
      dirInput: this.query<HTMLInputElement>('[data-role="dir-input"]'),
    }

    this.refs.nameInput.value = `虚拟采集-${stamp()}`
    this.refs.intervalInput.value = String(DEFAULT_INTERVAL_SECONDS)
    this.refs.distanceInput.value = '0'

    if (options.autoCreateSession !== false && this.service.listSessions().length === 0) {
      this.service.createSession(
        this.newSessionOptions('virtual-camera', this.refs.nameInput.value),
      )
    }

    this.root.addEventListener('click', this.onClick)
    this.root.addEventListener('change', this.onChange)
    this.refs.fileInput.addEventListener('change', () => void this.onFiles(this.refs.fileInput))
    this.refs.dirInput.addEventListener('change', () => void this.onFiles(this.refs.dirInput))
    this.unsubscribe = this.service.subscribe(() => this.sync())

    // 大图查看器与影像集弹窗都住 document.body,与面板共用同一份 service ——
    // 于是虚拟采集 / 真实导入 / 全景照片在影像集里都能看、全景组还能一键合成。
    // 查看器实例直接交给影像集弹窗复用(同一个实例,不会出现两套翻页状态)。
    if (options.viewer !== false) {
      this.viewer = new DroneImageViewer(this.service, { ...options.viewerOptions })
    }
    if (options.gallery !== false) {
      this.gallery = new DroneGallery(this.service, {
        ...options.galleryOptions,
        ...(this.viewer ? { viewer: this.viewer } : {}),
        // 面板关掉了大图查看器时,影像集里也不该冒出一个(两个开关要一致)
        viewerEnabled: options.viewer !== false && (options.galleryOptions?.viewerEnabled ?? true),
      })
    }

    this.sync()
  }

  /** 新建会话参数 = 宿主给的默认值(场景标识 / 地理原点)+ 界面上的来源与名称 */
  private newSessionOptions(source: ImageSource, name: string): CaptureSessionOptions {
    return { ...this.options.sessionDefaults, source, name }
  }

  /** 当前展示的会话 */
  get session(): CaptureSession | null {
    return this.service.activeSession
  }

  /** 显示 / 隐藏 */
  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none'
  }

  /**
   * 打开大图查看器。`imageId` 缺省用当前选中的那张(再缺省 = 最后一张)。
   * 宿主若想在自己的界面上挂个「查看」按钮,调这里即可 —— 与点缩略图是同一条路径。
   */
  openViewer(imageId?: string): void {
    const session = this.session
    if (!session || !this.viewer) return
    const id = imageId ?? session.images[session.images.length - 1]?.id
    if (!id) return
    this.viewer.open(id, session.id)
  }

  /** 关闭大图查看器(没打开时是空操作) */
  closeViewer(): void {
    this.viewer?.close()
  }

  /** 打开影像集弹窗(浏览 / 分组 / 一键合成);`gallery: false` 时是空操作 */
  openGallery(sessionId?: string): void {
    this.gallery?.open(sessionId ?? this.session?.id)
  }

  /** 关闭影像集弹窗(连同它里面的大图查看器) */
  closeGallery(): void {
    this.gallery?.close()
  }

  /** 手动同步一次(宿主改了服务状态后可主动调用) */
  sync(): void {
    if (this.destroyed) return
    const session = this.session
    this.refs.count.textContent = session ? `${session.images.length} 张` : '–'
    this.refs.sessionName.textContent = session ? `${session.options.name}` : '未创建'

    this.syncSessionOptions()
    // 按来源切换入口:虚拟采集与真实导入不该同时暴露
    const isVirtual = !session || session.options.source === 'virtual-camera'
    this.refs.virtualBlock.style.display = isVirtual ? '' : 'none'
    this.refs.realBlock.style.display = isVirtual ? 'none' : ''

    const auto = session ? this.service.isAutoCapturing(session.id) : false
    this.refs.autoBtn.textContent = auto ? '停止自动' : '自动采集'
    this.refs.autoBtn.classList.toggle('dcap-on', auto)
    this.refs.autoState.textContent = auto
      ? `自动中 · 每 ${this.refs.intervalInput.value}s / ${this.refs.distanceInput.value}m`
      : '空闲'

    // 影像集入口:报"几组 / 多少张",比单纯一个总数更能说明这堆影像的构成
    if (session) {
      const groups = groupSessionImages(session.images)
      const panoGroups = groups.filter((group) => group.kind === 'panorama').length
      this.refs.galleryCount.textContent = panoGroups
        ? `${panoGroups} 组全景 · 共 ${session.images.length} 张`
        : `共 ${session.images.length} 张`
    } else {
      this.refs.galleryCount.textContent = '未创建会话'
    }
    this.refs.galleryBtn.disabled = !session || session.images.length === 0
    this.refs.galleryBtn.title = session?.images.length
      ? '按组合浏览影像集,全景组可一键合成'
      : '还没有影像'
    // 弹窗开着时同步刷新(它自己也订阅了服务,这里只是保证"刚打开时就是最新的")
    this.gallery?.refresh()
  }

  /**
   * 面板底部的一行提示(参数不合法、导入进行中……)。
   * 影像集搬进弹窗后,面板没有详情区了,这些"一次性反馈"需要个落脚处;
   * 给个几秒后自动消失,免得过时的话一直挂在那儿。
   */
  setNote(text: string, warn = false): void {
    if (this.destroyed) return
    this.refs.note.textContent = text
    this.refs.note.classList.toggle('is-warn', warn)
    this.refs.note.hidden = !text
    if (this.noteTimer !== null) clearTimeout(this.noteTimer)
    this.noteTimer = text
      ? setTimeout(() => {
          if (!this.destroyed) this.refs.note.hidden = true
          this.noteTimer = null
        }, 5000)
      : null
  }

  private syncSessionOptions(): void {
    const sessions = this.service.listSessions()
    const signature = sessions.map((s) => `${s.id}:${s.options.name}:${s.options.source}`).join('|')
    if (signature !== this.sessionSignature) {
      this.sessionSignature = signature
      const active = this.session
      this.refs.sessionSelect.innerHTML = sessions
        .map(
          (session) =>
            `<option value="${session.id}">${escapeHtml(session.options.name)} · ${session.images.length}</option>`,
        )
        .join('')
      if (active) this.refs.sessionSelect.value = active.id
    } else {
      // 张数会变,只刷新选项文案即可(整体重绘会打断正在输入的名称框)
      const active = this.session
      if (active) this.refs.sessionSelect.value = active.id
      const options = this.refs.sessionSelect.options
      for (let i = 0; i < options.length; i += 1) {
        const session = sessions[i]
        const option = options[i]
        if (!session || !option) continue
        const text = `${session.options.name} · ${session.images.length}`
        if (option.textContent !== text) option.textContent = text
      }
    }
  }

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null
    // 取「最近的带 data-action 的祖先(含自身)」:按钮里嵌图标时图标会先命中自己
    const actionEl = target?.closest<HTMLElement>('[data-action]')
    if (!actionEl) return
    void this.handleAction(actionEl.dataset.action ?? '', actionEl)
  }

  private async handleAction(action: string, element: HTMLElement): Promise<void> {
    const session = this.session
    switch (action) {
      case 'toggle-collapse': {
        const collapsed = this.root.dataset.collapsed === 'true'
        this.root.dataset.collapsed = collapsed ? 'false' : 'true'
        this.query<HTMLButtonElement>('[data-action="toggle-collapse"]').textContent = collapsed
          ? '–'
          : '+'
        break
      }
      case 'session-new': {
        const source = this.refs.sourceSelect.value as ImageSource
        const name = this.refs.nameInput.value.trim() || `采集-${stamp()}`
        this.service.createSession(this.newSessionOptions(source, name))
        this.sync()
        break
      }
      case 'capture-one': {
        if (!session) break
        element.setAttribute('disabled', 'disabled')
        // 手动拍一张:纯粹走服务,与自动采集同一条路径 ⇒ 元数据完全一致
        await this.service.captureVirtualImage(session.id)
        element.removeAttribute('disabled')
        break
      }
      case 'auto-toggle': {
        if (!session) break
        if (this.service.isAutoCapturing(session.id)) {
          this.service.stopAutoCapture(session.id)
        } else {
          const seconds = Number(this.refs.intervalInput.value)
          const meters = Number(this.refs.distanceInput.value)
          const started = this.service.startAutoCapture(session.id, {
            intervalMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
            distanceMeters: Number.isFinite(meters) && meters > 0 ? meters : 0,
          })
          if (!started) this.setNote('自动采集需要时间间隔或距离间隔至少填一个 > 0 的值。')
        }
        this.sync()
        break
      }
      case 'pick-files':
        this.refs.fileInput.click()
        break
      case 'pick-dir':
        this.refs.dirInput.click()
        break
      case 'open-gallery':
        this.openGallery()
        break
      case 'clear-images': {
        if (!session) break
        this.service.clearImages(session.id)
        this.sync()
        break
      }
      case 'export':
        if (session)
          this.exportSession(session, (element.dataset.format as CaptureExportFormat) ?? 'json')
        break
      case 'finish':
        if (session) this.service.finishSession(session.id)
        break
      default:
        break
    }
  }

  private readonly onChange = (event: Event): void => {
    const target = event.target as HTMLElement | null
    if (!target) return
    if (target === this.refs.sessionSelect) {
      // 「当前会话」= 服务里 updatedAt 最新的那个;切会话时把它的参数带回输入框
      const session = this.service.getSession(this.refs.sessionSelect.value)
      if (session) {
        session.updatedAt = new Date().toISOString()
        // 弹窗锁在旧会话的那张图上,切会话就收起来(否则会出现"面板已换会话、弹窗还在放旧的")
        this.viewer?.close()
        if (session.options.captureIntervalMs) {
          this.refs.intervalInput.value = String(session.options.captureIntervalMs / 1000)
        }
        if (session.options.distanceIntervalMeters) {
          this.refs.distanceInput.value = String(session.options.distanceIntervalMeters)
        }
        this.sync()
      }
    }
  }

  private async onFiles(input: HTMLInputElement): Promise<void> {
    const session = this.session
    if (!session || !input.files?.length) return
    const files = Array.from(input.files)
    input.value = ''
    this.setNote(`正在导入 ${files.length} 个文件…`)
    await this.service.importRealImages(session.id, files)
    this.sync()
    this.setNote(`已导入 ${files.length} 个文件。`)
  }

  /** 导出当前会话清单(JSON 完整存档 / CSV 表格) */
  exportSession(session: CaptureSession, format: CaptureExportFormat): string {
    const text = this.service.exportSession(session.id, format)
    if (this.options.downloadOnExport !== false && typeof document !== 'undefined') {
      const mime = format === 'csv' ? 'text/csv' : 'application/json'
      const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
      const extension = format === 'manifest' ? 'json' : format
      triggerDownload(
        url,
        `capture-${session.options.name}-${stamp()}${format === 'manifest' ? '-manifest' : ''}.${extension}`,
      )
      // 下载已经开始,URL 可以立刻回收
      URL.revokeObjectURL(url)
    }
    return text
  }

  /** 拆除面板 DOM 与轮询 */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.noteTimer !== null) clearTimeout(this.noteTimer)
    this.noteTimer = null
    // 先拆大图查看器、再拆影像集弹窗:两者的 body 滚动锁是**嵌套**的
    // (查看器开在影像集之上),必须按"后锁的先解"的顺序恢复 ——
    // 反过来的话,外层会把它进场前保存的值写回去,overflow 就残留成 'hidden'。
    this.viewer?.destroy()
    this.viewer = null
    // 弹窗挂 body,不拆会留在页面上(连同它的键盘监听)
    this.gallery?.destroy()
    this.gallery = null
    for (const session of this.service.listSessions()) this.service.stopAutoCapture(session.id)
    this.root.remove()
    if (this.options.injectStyles !== false) document.getElementById(STYLE_ID)?.remove()
  }

  private query<T extends HTMLElement = HTMLElement>(selector: string): T {
    const el = this.root.querySelector<T>(selector)
    if (!el) throw new Error(`[DroneCapturePanel] 缺少节点:${selector}`)
    return el
  }

  private template(): string {
    return `
      <div class="dcap-head">
        <span class="dcap-title">${escapeHtml(this.options.title ?? '影像采集')}</span>
        <span class="dcap-count" data-role="count">–</span>
        <button type="button" class="dcap-icon" data-action="toggle-collapse" title="收起 / 展开" aria-label="收起或展开">–</button>
      </div>
      <div class="dcap-body" data-role="body">
        <section class="dcap-blk">
          <div class="dcap-label">采集会话<em data-role="session-name">–</em></div>
          <div class="dcap-row">
            <select class="dcap-select dcap-field" data-role="session-select" title="切换当前会话"></select>
            <button type="button" class="dcap-btn" style="flex:0 0 auto" data-action="finish" title="结束当前会话(保留影像集)">结束</button>
          </div>
          <div class="dcap-row">
            <input class="dcap-text dcap-field" data-role="name-input" type="text" placeholder="会话名称" title="新会话名称">
            <select class="dcap-select" data-role="source-select" style="flex:0 0 86px" title="影像来源">
              <option value="virtual-camera">场景虚拟</option>
              <option value="real-camera">真实照片</option>
            </select>
            <button type="button" class="dcap-btn dcap-primary" style="flex:0 0 auto" data-action="session-new">新建</button>
          </div>
        </section>

        <section class="dcap-blk" data-blk="virtual">
          <div class="dcap-label">虚拟采集<em data-role="auto-state">空闲</em></div>
          <div class="dcap-row">
            <button type="button" class="dcap-btn dcap-primary" data-action="capture-one">拍一张</button>
            <button type="button" class="dcap-btn" data-action="auto-toggle">自动采集</button>
          </div>
          <div class="dcap-row">
            <label class="dcap-field">间隔(s)
              <input class="dcap-num" data-role="interval" type="number" min="0" step="0.5" value="1">
            </label>
            <label class="dcap-field">距离(m)
              <input class="dcap-num" data-role="distance" type="number" min="0" step="1" value="0">
            </label>
          </div>
          <p class="dcap-hint">与「拍照」同源,每张带取景相机位姿 / 内参 / 坐标系。</p>
        </section>

        <section class="dcap-blk" data-blk="real">
          <div class="dcap-label">真实照片导入</div>
          <div class="dcap-row">
            <button type="button" class="dcap-btn" data-action="pick-files">选择照片</button>
            <button type="button" class="dcap-btn" data-action="pick-dir">选择文件夹</button>
          </div>
          <p class="dcap-hint">原图不压缩保存;缺 EXIF / GPS 标记为「警告」。</p>
        </section>

        <section class="dcap-blk">
          <div class="dcap-label">影像集<em data-role="gallery-count">未创建会话</em></div>
          <div class="dcap-row">
            <button type="button" class="dcap-btn dcap-primary" data-action="open-gallery" disabled>打开影像集</button>
          </div>
          <p class="dcap-hint">按组合分组浏览;全景组可「一键合成」成一张等距柱状全景图。</p>
          <div class="dcap-row" style="margin-top:6px">
            <button type="button" class="dcap-btn" data-action="export" data-format="json">导出 JSON</button>
            <button type="button" class="dcap-btn" data-action="export" data-format="manifest">导出 Manifest</button>
            <button type="button" class="dcap-btn" data-action="export" data-format="csv">导出 CSV</button>
            <button type="button" class="dcap-btn" data-action="clear-images">清空</button>
          </div>
        </section>
      </div>
      <p class="dcap-note" data-role="note" hidden></p>
      <input type="file" data-role="file-input" accept="image/*" multiple style="display:none">
      <input type="file" data-role="dir-input" webkitdirectory directory multiple style="display:none">
    `
  }
}
