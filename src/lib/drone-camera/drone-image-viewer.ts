/**
 * 影像弹窗查看器(原生 DOM):点缩略图后铺开看大图 —— 大图 / 元数据 / 上一张下一张 / 下载。
 *
 * 与 drone-panel / mission-panel / drone-capture-panel 同一套范式:只用 DOM + CSS,
 * 不引任何 UI 框架,库整体保持与框架无关。
 *
 * 两处刻意的设计:
 *
 * 1. **挂 `document.body`,绝不做面板的后代**。面板带 `backdrop-filter`,`filter` 一类的属性
 *    会为 `position: fixed` 的后代创建新的包含块 —— 弹窗会被裁在面板里、跑不动。
 *    (同一坑在面板的悬浮摇杆层上踩过一次:`inset:0` 的悬浮层必须是面板的**兄弟节点**。)
 *    另外挂 body 还有个附带好处:面板为了不打断输入框,采集入库时会重绘缩略图 DOM,
 *    弹窗不在那棵子树里,重绘碰不到它。
 *
 * 2. **键盘在 window 的捕获阶段接管**。控制面板的键盘飞行监听挂在 window 的**冒泡阶段**,
 *    两边真同时监听的话,弹窗里按 ←/→ 翻页会顺带让无人机偏航、Esc 也拦不住任何东西。
 *    所以在捕获阶段就把事件截住(`stopPropagation`),并且**只在弹窗打开时**挂着监听 ——
 *    关闭即摘除,不影响页面其它键盘交互。Ctrl / Cmd / Alt 组合键一律放行,
 *    宿主快捷键与面板的 Ctrl+K 拍照照常工作。
 */
import type { CaptureService, CapturedImage, CaptureSession } from './drone-capture'
import { describeImage, triggerDownload } from './drone-image-utils'

/** 弹窗查看器构造选项 */
export interface DroneImageViewerOptions {
  /** 是否注入自带样式,默认 true */
  injectStyles?: boolean
  /** 弹窗层级,默认 1000(库内面板最高 21,留足余量) */
  zIndex?: number
  /** 是否提供「下载原图」按钮,默认 true */
  downloadable?: boolean
  /** 关闭回调(点 × / 点空白 / Esc 都会触发) */
  onClose?: () => void
  /** 翻页回调 —— 便于宿主把外部状态(如面板选中态)跟着同步 */
  onNavigate?: (image: CapturedImage, index: number) => void
}

const STYLE_ID = 'drone-image-viewer-styles'
const DEFAULT_Z_INDEX = 1000
/** 触屏滑动翻页的最小水平位移(px) */
const SWIPE_MIN_PX = 48

const VIEWER_CSS = `
.dview {
  --dview-text: #e9eff9;
  --dview-muted: rgba(233, 239, 249, 0.58);
  --dview-border: rgba(255, 255, 255, 0.12);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.dview {
  position: fixed; inset: 0; z-index: ${DEFAULT_Z_INDEX};
  display: flex; align-items: center; justify-content: center;
  padding: max(10px, env(safe-area-inset-top)) 10px max(10px, env(safe-area-inset-bottom));
  color: var(--dview-text);
  outline: none;
}
.dview[hidden] { display: none; }
.dview-mask {
  position: absolute; inset: 0; background: rgba(6, 9, 14, 0.86);
  -webkit-backdrop-filter: blur(7px); backdrop-filter: blur(7px);
}
.dview-frame {
  position: relative; z-index: 1;
  display: flex; flex-direction: column;
  width: min(100%, 1280px); height: 100%; overflow: hidden;
  /* height 必须给定:大图是 absolute(不占流内高度),若 frame 高度由内容撑起,
     stage 的 flex:1 会分到 0 高,整块取景区塌掉 */
  border: 1px solid var(--dview-border); border-radius: 12px;
  background: rgba(15, 19, 27, 0.94);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
}
.dview-bar {
  display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
  padding: 8px 10px; border-bottom: 1px solid var(--dview-border);
}
.dview-idx { font-weight: 600; font-variant-numeric: tabular-nums; }
.dview[data-status="warning"] .dview-idx { color: #f5a623; }
.dview[data-status="invalid"] .dview-idx { color: #ff5f5f; }
.dview-name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dview-muted);
}
.dview-icon {
  flex: 0 0 auto; width: 26px; height: 26px; padding: 0; cursor: pointer;
  border: 1px solid var(--dview-border); border-radius: 7px;
  background: rgba(255, 255, 255, 0.06); color: var(--dview-text);
  font: inherit; line-height: 1;
}
.dview-icon:hover { background: rgba(255, 255, 255, 0.14); }
.dview-icon[hidden] { display: none; }
.dview-stage {
  position: relative; flex: 1; min-height: 0;
  display: flex; align-items: center; justify-content: center;
  /* 不裁剪的话,大图会按固有比例溢出 stage、顶栏直接被图盖住 */
  overflow: hidden; background: #05070b; touch-action: pan-y;
}
.dview-img {
  /* 绝对定位 + margin auto:最可靠的"适应窗口"写法,不依赖 flex 高度的百分比解析 */
  position: absolute; inset: 0; margin: auto;
  max-width: 100%; max-height: 100%; display: block; object-fit: contain;
}
.dview-img[hidden] { display: none; }
.dview-empty { margin: 0; padding: 20px; color: var(--dview-muted); text-align: center; }
.dview-empty[hidden] { display: none; }
.dview-nav {
  position: absolute; top: 50%; transform: translateY(-50%);
  width: 38px; height: 58px; padding: 0; cursor: pointer;
  border: 1px solid var(--dview-border); border-radius: 10px;
  background: rgba(10, 14, 20, 0.6); color: var(--dview-text);
  font: 22px/1 inherit;
}
.dview-nav:hover { background: rgba(53, 167, 255, 0.28); }
.dview-nav[hidden] { display: none; }
.dview-prev { left: 8px; }
.dview-next { right: 8px; }
.dview-meta {
  flex: 0 0 auto; max-height: 26vh; overflow-y: auto; overscroll-behavior: contain;
  padding: 8px 10px; border-top: 1px solid var(--dview-border);
  font-size: 11px; line-height: 1.6; color: var(--dview-muted);
  white-space: pre-wrap; word-break: break-all;
}
.dview-meta b { color: var(--dview-text); font-weight: 600; }
.dview-meta .is-warn { color: #f5a623; }
.dview-hint {
  flex: 0 0 auto; padding: 5px 10px; border-top: 1px solid var(--dview-border);
  color: var(--dview-muted); font-size: 10px;
}
@media (max-height: 520px) {
  .dview-meta { max-height: 38vh; font-size: 10px; }
  .dview-nav { height: 44px; }
}
@media (pointer: coarse) {
  .dview-icon { width: 32px; height: 32px; }
  .dview-nav { width: 44px; }
}
`

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = VIEWER_CSS
  document.head.appendChild(style)
}

interface ViewerRefs {
  mask: HTMLElement
  stage: HTMLElement
  img: HTMLImageElement
  empty: HTMLElement
  idx: HTMLElement
  name: HTMLElement
  meta: HTMLElement
  prev: HTMLButtonElement
  next: HTMLButtonElement
  download: HTMLButtonElement
}

/**
 * 影像弹窗查看器。
 *
 * ```ts
 * const viewer = new DroneImageViewer(service)
 * viewer.open(image.id)           // 打开(第二参不给则用当前会话)
 * viewer.step(1)                  // 下一张(循环)
 * viewer.close()                  // 关闭;destroy() 彻底卸载
 * ```
 *
 * DOM 是**懒挂载**的:构造只记住 service 与选项,第一次 `open()` 才建节点、注入样式、
 * 订阅服务与键盘;`close()` 则整个拆掉(而不是藏起来)—— 于是"弹窗关着"时
 * 它对页面零影响,键盘监听也不在。
 */
export class DroneImageViewer {
  private readonly service: CaptureService
  private readonly options: DroneImageViewerOptions
  private root: HTMLDivElement | null = null
  private refs: ViewerRefs | null = null
  private unsubscribe: (() => void) | null = null
  private sessionId: string | null = null
  private imageId: string | null = null
  /** 上一次渲染的图片下标:当前图被移除时用它顶到相邻位置,而不是跳回第一张 */
  private lastIndex = 0
  private bodyOverflow = ''
  private swipeStart: { x: number; y: number; pointerId: number } | null = null
  /** 滑动翻页后浏览器仍会补一个 click,用它在 onClick 里吃掉那一次 */
  private suppressClick = false
  private destroyed = false

  /** 构造大图查看弹窗(双击/点遮罩/Esc 关闭) */
  constructor(service: CaptureService, options: DroneImageViewerOptions = {}) {
    this.service = service
    this.options = options
  }

  /** 弹窗当前是否打开 */
  get isOpen(): boolean {
    return this.root !== null && !this.root.hidden
  }

  /** 当前显示的那张影像(未打开 / 已失效时返回 null) */
  get current(): CapturedImage | null {
    const images = this.resolveSession()?.images ?? []
    if (!this.imageId) return null
    return images.find((image) => image.id === this.imageId) ?? null
  }

  /** 打开弹窗;`sessionId` 缺省用采集服务里当前活跃的会话 */
  open(imageId: string, sessionId?: string): void {
    if (this.destroyed) return
    this.sessionId = sessionId ?? this.service.activeSession?.id ?? null
    this.imageId = imageId
    this.mount()
    if (!this.root || !this.refs) return
    this.root.hidden = false
    this.lockScroll()
    this.render()
    this.root.focus()
  }

  /** 关闭弹窗(并整个卸载 DOM / 摘掉键盘监听) */
  close(): void {
    if (!this.root) return
    const wasOpen = !this.root.hidden
    this.unmount()
    if (wasOpen) this.options.onClose?.()
  }

  /** 翻页:正值向后(下一张),负值向前;越界循环 */
  step(delta: number): void {
    const images = this.resolveSession()?.images ?? []
    if (images.length < 2 || !this.imageId) return
    const index = images.findIndex((image) => image.id === this.imageId)
    if (index < 0) return
    const next = (index + delta + images.length) % images.length
    const target = images[next]
    if (!target) return
    this.imageId = target.id
    this.render()
  }

  /** 跳到指定下标(负值 = 最后一张) */
  jump(index: number): void {
    const images = this.resolveSession()?.images ?? []
    if (!images.length) return
    const target = images[index < 0 ? images.length - 1 : Math.min(index, images.length - 1)]
    if (!target) return
    this.imageId = target.id
    this.render()
  }

  /** 下载当前显示的原图 */
  download(): void {
    const image = this.current
    if (!image?.imageUrl) return
    triggerDownload(image.imageUrl, image.fileName || `capture-${this.lastIndex + 1}.png`)
  }

  /** 关闭并移除弹窗 */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.unmount()
    if (this.options.injectStyles !== false) document.getElementById(STYLE_ID)?.remove()
  }

  // ───────────────────────────── 内部 ─────────────────────────────

  private resolveSession(): CaptureSession | null {
    if (this.sessionId) {
      const session = this.service.getSession(this.sessionId)
      if (session) return session
    }
    return this.service.activeSession
  }

  private mount(): void {
    if (this.root || typeof document === 'undefined') return
    if (this.options.injectStyles !== false) ensureStyles()

    const root = document.createElement('div')
    root.className = 'dview'
    root.hidden = true
    root.tabIndex = -1
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-label', '影像查看')
    if (this.options.zIndex && this.options.zIndex !== DEFAULT_Z_INDEX) {
      root.style.zIndex = String(this.options.zIndex)
    }
    root.innerHTML = this.template()
    document.body.appendChild(root)

    this.root = root
    this.refs = {
      mask: this.query('[data-role="mask"]'),
      stage: this.query('[data-role="stage"]'),
      img: this.query<HTMLImageElement>('[data-role="img"]'),
      empty: this.query('[data-role="empty"]'),
      idx: this.query('[data-role="idx"]'),
      name: this.query('[data-role="name"]'),
      meta: this.query('[data-role="meta"]'),
      prev: this.query<HTMLButtonElement>('[data-action="prev"]'),
      next: this.query<HTMLButtonElement>('[data-action="next"]'),
      download: this.query<HTMLButtonElement>('[data-action="download"]'),
    }

    root.addEventListener('click', this.onClick)
    this.refs.stage.addEventListener('pointerdown', this.onPointerDown)
    this.refs.stage.addEventListener('pointerup', this.onPointerUp)
    this.refs.stage.addEventListener('pointercancel', this.onPointerCancel)
    this.refs.img.addEventListener('error', this.onImageError)
    // 捕获阶段接管键盘,才能压住面板挂在冒泡阶段的键盘飞行(见模块头注释 2)
    window.addEventListener('keydown', this.onKeyDown, { capture: true })
    // 影像被移除 / 清空时同步:当前这张没了就顶到相邻位置,一张不剩就关掉
    this.unsubscribe = this.service.subscribe(() => {
      if (this.root && !this.root.hidden) this.render()
    })
  }

  private unmount(): void {
    window.removeEventListener('keydown', this.onKeyDown, { capture: true })
    this.unsubscribe?.()
    this.unsubscribe = null
    this.root?.remove()
    this.root = null
    this.refs = null
    this.swipeStart = null
    this.unlockScroll()
  }

  private render(): void {
    const root = this.root
    const refs = this.refs
    if (!root || !refs) return

    const images = this.resolveSession()?.images ?? []
    if (!images.length) {
      // 全被删光了:没什么可看,直接收起
      this.close()
      return
    }

    let index = this.imageId ? images.findIndex((image) => image.id === this.imageId) : -1
    if (index < 0) index = Math.max(0, Math.min(this.lastIndex, images.length - 1))
    const image = images[index]
    if (!image) {
      this.close()
      return
    }
    this.imageId = image.id
    const moved = index !== this.lastIndex
    this.lastIndex = index

    root.dataset.status = image.validation.status
    refs.idx.textContent = `#${index + 1} / ${images.length}`
    refs.name.textContent = image.fileName || '(未命名)'
    refs.name.title = image.fileName
    refs.meta.innerHTML = describeImage(image, index)

    const single = images.length < 2
    refs.prev.hidden = single
    refs.next.hidden = single
    refs.download.hidden = this.options.downloadable === false || !image.imageUrl

    if (image.imageUrl) {
      refs.img.hidden = false
      refs.empty.hidden = true
      // data URL 可能有几 MB,别在每次入库渲染时重复赋值把解码器打满
      if (refs.img.getAttribute('src') !== image.imageUrl) refs.img.src = image.imageUrl
    } else {
      refs.img.hidden = true
      refs.img.removeAttribute('src')
      refs.empty.hidden = false
      refs.empty.textContent = '这张影像没有可用的预览地址。'
    }

    if (moved) this.options.onNavigate?.(image, index)
  }

  private readonly onClick = (event: MouseEvent): void => {
    if (this.suppressClick) {
      this.suppressClick = false
      return
    }
    const target = event.target as HTMLElement | null
    const actionEl = target?.closest<HTMLElement>('[data-action]')
    switch (actionEl?.dataset.action) {
      case 'close':
        this.close()
        return
      case 'prev':
        this.step(-1)
        return
      case 'next':
        this.step(1)
        return
      case 'download':
        this.download()
        return
      default:
        break
    }
    // 点空白(遮罩 / 图片以外的大图区)关闭;点图片本身不关,免得想放大人被弹出去
    const refs = this.refs
    if (refs && (target === this.root || target === refs.mask || target === refs.stage)) {
      this.close()
    }
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    const target = event.target as HTMLElement | null
    // 按钮上按下的指针不参与滑动(否则点「下一张」也会被当成滑动起点)
    if (target?.closest('[data-action]')) return
    this.swipeStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
    try {
      this.refs?.stage.setPointerCapture(event.pointerId)
    } catch {
      /* 不支持 pointer capture 的环境忽略 */
    }
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const start = this.swipeStart
    this.swipeStart = null
    if (!start || start.pointerId !== event.pointerId) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy)) return
    this.suppressClick = true
    this.step(dx < 0 ? 1 : -1)
  }

  private readonly onPointerCancel = (): void => {
    this.swipeStart = null
  }

  private readonly onImageError = (): void => {
    const refs = this.refs
    if (!refs) return
    refs.img.hidden = true
    refs.empty.hidden = false
    refs.empty.textContent = '影像地址已失效(可能已被移除或回收)。'
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.destroyed || !this.root || this.root.hidden) return
    // Ctrl / Cmd / Alt 组合键留给宿主与浏览器:面板的 Ctrl+K / Ctrl+L 拍照录像照常可用
    if (event.ctrlKey || event.metaKey || event.altKey) return
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        this.close()
        break
      case 'ArrowLeft':
        event.preventDefault()
        this.step(-1)
        break
      case 'ArrowRight':
        event.preventDefault()
        this.step(1)
        break
      case 'Home':
        event.preventDefault()
        this.jump(0)
        break
      case 'End':
        event.preventDefault()
        this.jump(-1)
        break
      default:
        break
    }
    // 独占键盘:面板的键盘飞行挂在 window 冒泡阶段,这里在捕获阶段截住,
    // 于是弹窗开着时 WASD / 方向键不会再顺带把无人机飞出去。
    event.stopPropagation()
  }

  private lockScroll(): void {
    if (typeof document === 'undefined') return
    this.bodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }

  private unlockScroll(): void {
    if (typeof document === 'undefined') return
    document.body.style.overflow = this.bodyOverflow
  }

  private query<T extends HTMLElement = HTMLElement>(selector: string): T {
    const root = this.root
    if (!root) throw new Error('[DroneImageViewer] 弹窗尚未挂载')
    const el = root.querySelector<T>(selector)
    if (!el) throw new Error(`[DroneImageViewer] 缺少节点:${selector}`)
    return el
  }

  private template(): string {
    return `
      <div class="dview-mask" data-role="mask" data-action="close"></div>
      <div class="dview-frame">
        <div class="dview-bar">
          <span class="dview-idx" data-role="idx">–</span>
          <span class="dview-name" data-role="name">–</span>
          <button type="button" class="dview-icon" data-action="download" title="下载原图" aria-label="下载原图">↓</button>
          <button type="button" class="dview-icon" data-action="close" title="关闭 (Esc)" aria-label="关闭">×</button>
        </div>
        <div class="dview-stage" data-role="stage">
          <img class="dview-img" data-role="img" alt="">
          <p class="dview-empty" data-role="empty" hidden></p>
          <button type="button" class="dview-nav dview-prev" data-action="prev" title="上一张 (←)" aria-label="上一张">‹</button>
          <button type="button" class="dview-nav dview-next" data-action="next" title="下一张 (→)" aria-label="下一张">›</button>
        </div>
        <div class="dview-meta" data-role="meta"></div>
        <div class="dview-hint">← / → 翻页 · Esc 关闭 · 触屏可左右滑动</div>
      </div>
    `
  }
}
