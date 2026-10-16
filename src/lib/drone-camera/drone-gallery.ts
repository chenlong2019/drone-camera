/**
 * 影像集弹窗(原生 DOM):把整个影像集从采集面板里**搬出来单独看** —— 按「组合」分组、
 * 每组一键合成、点缩略图看大图。
 *
 * 为什么要独立成弹窗:采集面板只有 300 多像素宽,缩略图、统计、详情、导出全塞在里面,
 * 既要滚动又看不见全局;而"翻影像集"本身就是一件需要大面积的事。
 * 于是面板只留**动作**(拍 / 停 / 导入 / 导出),影像的**浏览与合成**归这里。
 *
 * 三处刻意的设计:
 *
 * 1. **挂 `document.body`,不做面板的后代** —— 面板带 `backdrop-filter`,
 *    会为 `position: fixed` 的后代创建新的包含块(弹窗会被裁在面板里)。
 *    同一坑在悬浮摇杆层与大图查看器上各踩过一次。
 *
 * 2. **不同组合各自成块**。广角、180° 与球形 360° 扫描是同一次会话里
 *    来源完全不同的两批数据:混在一格里既看不出归属,也没法单独合成。
 *    分块后每组有自己的标题、色标、张数、是否拍完与「一键合成」。
 *
 * 3. **键盘在 window 捕获阶段接管,且上层弹窗优先**。控制面板的键盘飞行挂在冒泡阶段,
 *    弹窗开着时 WASD / 方向键必须被截住;而球面全景查看器 / 大图查看器盖在本弹窗之上时
 *    (层级更高),本弹窗的按键处理**直接让位**,否则 Esc 会先关掉下面这层、把上面的弹窗留在屏幕上。
 *
 * 4. **合成结果默认落到球面查看器**,不是平面大图。等距柱状图是全景的**存储格式**,
 *    平铺在屏幕上看不出"四面八方";点「360° 环视」把同一张图贴回球面拖动环视 ——
 *    与真机相册打开球面全景是同一件事(见 drone-panorama-viewer)。
 *
 * ```ts
 * const gallery = new DroneGallery(service)
 * gallery.open()                     // 打开(缺省看当前会话)
 * gallery.stitch(groupKey)           // 程序化触发某组合成
 * gallery.close()                    // 关闭;destroy() 彻底卸载
 * ```
 */
import type { CaptureService, CaptureSession } from './drone-capture'
import type { ImageGroup } from './drone-image-utils'
import {
  escapeHtml,
  formatBytes,
  groupSessionImages,
  imageTileLabel,
  createOriginalImagesZip,
  triggerDownload,
  VALIDATION_BADGES,
  VALIDATION_LABELS,
} from './drone-image-utils'
import type { PanoramaStitchResult, PanoramaStitcher } from './drone-panorama'
import { createEquirectStitcher } from './drone-stitch'
import { DroneImageViewer } from './drone-image-viewer'
import type { DroneImageViewerOptions } from './drone-image-viewer'
import { DronePanoramaViewer } from './drone-panorama-viewer'
import type { DronePanoramaViewerOptions } from './drone-panorama-viewer'

/** 影像集弹窗构造选项 */
export interface DroneGalleryOptions {
  /** 是否注入自带样式,默认 true */
  injectStyles?: boolean
  /** 弹窗层级,默认 900(大图查看器会自动排在它之上) */
  zIndex?: number
  /** 标题,默认「影像集」 */
  title?: string
  /**
   * 大图查看器:点缩略图时打开。不传则本弹窗自己建一个(并在销毁时一并卸载);
   * `viewerEnabled: false` 可整块关掉"点缩略图看大图"。
   */
  viewer?: DroneImageViewer | null
  /** 是否启用"点缩略图看大图",默认 true(显式传了 `viewer` 时以传入的为准) */
  viewerEnabled?: boolean
  /** 建自带查看器时透传的细项 */
  viewerOptions?: DroneImageViewerOptions
  /**
   * 全景查看器:点合成结果时打开,**把等距柱状图贴回球面拖动环视**(真机相册的体验)。
   * 不传则本弹窗自己建一个(并在销毁时一并卸载);`panoramaViewerEnabled: false` 关掉它
   * (那时合成结果仍可下载,只是不再有球面浏览)。
   */
  panoramaViewer?: DronePanoramaViewer | null
  /** 是否启用球面全景查看,默认 true(显式传了 `panoramaViewer` 时以传入的为准) */
  panoramaViewerEnabled?: boolean
  /** 建自带全景查看器时透传的细项 */
  panoramaViewerOptions?: DronePanoramaViewerOptions
  /**
   * 合成器。「一键合成」用它把一组全景照片拼成一张图;
   * 不传 = 库内自带的等距柱状拼接(见 drone-stitch);传 `null` = 关掉合成按钮。
   */
  stitcher?: PanoramaStitcher | null
  /** 关闭回调(点 × / 点遮罩 / Esc) */
  onClose?: () => void
  /** 某组合成结束的回调(失败时 result 为 null) */
  onStitched?: (group: ImageGroup, result: PanoramaStitchResult | null) => void
}

/** 合成器里可能带的进度回调(库内拼接器有,宿主自建的可选) */
type ProgressAwareStitcher = PanoramaStitcher & {
  onProgress?: ((done: number, total: number) => void) | null
}

/** 单组的合成状态 */
interface StitchState {
  status: 'running' | 'done' | 'error'
  done: number
  total: number
  message?: string
  result?: PanoramaStitchResult | null
}

const STYLE_ID = 'drone-gallery-styles'
const DEFAULT_Z_INDEX = 900
/** 每组最多渲染这么多张缩略图(再多只报数),避免长全景解码过多原尺寸照片拖垮页面 */
const MAX_THUMBS_PER_GROUP = 24
/** 分组色标的色相起点与步进(不同组合一眼能分开) */
const HUE_BASE = 205
const HUE_STEP = 47

const GALLERY_CSS = `
.dgallery {
  --dg-text: #e9eff9;
  --dg-muted: rgba(233, 239, 249, 0.58);
  --dg-border: rgba(255, 255, 255, 0.12);
  --dg-accent: #35a7ff;
  --dg-ok: #37d67a;
  --dg-warn: #f5a623;
  --dg-bad: #ff5f5f;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.dgallery {
  position: fixed; inset: 0; z-index: ${DEFAULT_Z_INDEX};
  display: flex; align-items: center; justify-content: center;
  padding: max(10px, env(safe-area-inset-top)) 10px max(10px, env(safe-area-inset-bottom));
  color: var(--dg-text);
  outline: none;
}
.dgallery[hidden] { display: none; }
.dgallery-mask {
  position: absolute; inset: 0; background: rgba(6, 9, 14, 0.86);
  -webkit-backdrop-filter: blur(7px); backdrop-filter: blur(7px);
}
.dgallery-frame {
  position: relative; z-index: 1;
  display: flex; flex-direction: column;
  width: min(100%, 1180px); height: 100%; overflow: hidden;
  border: 1px solid var(--dg-border); border-radius: 12px;
  background: rgba(15, 19, 27, 0.95);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
}
.dgallery-bar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-bottom: 1px solid var(--dg-border);
}
.dgallery-title { font-weight: 600; }
.dgallery-session {
  max-width: 200px; min-height: 26px; padding: 2px 6px; cursor: pointer;
  border: 1px solid var(--dg-border); border-radius: 7px;
  background: rgba(255, 255, 255, 0.06); color: var(--dg-text); font: inherit;
}
.dgallery-stats { color: var(--dg-muted); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dgallery-stats .is-ok { color: var(--dg-ok); }
.dgallery-stats .is-warn { color: var(--dg-warn); }
.dgallery-stats .is-bad { color: var(--dg-bad); }
.dgallery-spacer { flex: 1; min-width: 4px; }
.dgallery-icon {
  flex: 0 0 auto; width: 26px; height: 26px; padding: 0; cursor: pointer;
  border: 1px solid var(--dg-border); border-radius: 7px;
  background: rgba(255, 255, 255, 0.06); color: var(--dg-text); font: inherit; line-height: 1;
}
.dgallery-icon:hover { background: rgba(255, 255, 255, 0.14); }
.dgallery-chips {
  flex: 0 0 auto; display: flex; gap: 6px; align-items: center;
  padding: 6px 10px; overflow-x: auto; border-bottom: 1px solid var(--dg-border);
}
.dgallery-chips[hidden] { display: none; }
.dgallery-chip {
  flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px;
  min-height: 24px; padding: 2px 8px; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--dg-border); border-radius: 999px;
  background: rgba(255, 255, 255, 0.05); color: var(--dg-text); font: inherit; font-size: 12px;
}
.dgallery-chip:hover { background: rgba(255, 255, 255, 0.12); }
.dgallery-chip i { width: 8px; height: 8px; border-radius: 50%; background: var(--dg-group, var(--dg-accent)); }
.dgallery-body {
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 10px; -webkit-overflow-scrolling: touch;
}
.dgallery-group { margin-bottom: 16px; }
.dgallery-group:last-child { margin-bottom: 4px; }
.dgallery-group-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 7px 9px; margin-bottom: 8px; border-radius: 9px;
  border: 1px solid var(--dg-border);
  border-left: 3px solid var(--dg-group, var(--dg-accent));
  background: rgba(255, 255, 255, 0.035);
}
.dgallery-group-title { font-weight: 600; }
.dgallery-group-sub { color: var(--dg-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.dgallery-group-sub .is-warn { color: var(--dg-warn); }
.dgallery-group-sub .is-ok { color: var(--dg-ok); }
.dgallery-btn {
  min-height: 26px; padding: 3px 10px; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--dg-border); border-radius: 8px;
  background: rgba(255, 255, 255, 0.06); color: var(--dg-text); font: inherit; font-size: 12px;
}
.dgallery-btn:hover { background: rgba(255, 255, 255, 0.13); }
.dgallery-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
.dgallery-btn.dgallery-primary { background: var(--dg-accent); border-color: transparent; color: #04121f; font-weight: 600; }
.dgallery-btn.dgallery-on { background: var(--dg-bad); border-color: transparent; color: #fff; font-weight: 600; }
.dgallery-thumbs {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(94px, 1fr)); gap: 6px;
}
.dgallery-thumb {
  position: relative; aspect-ratio: 4 / 3; padding: 0; overflow: hidden; cursor: pointer;
  border: 1px solid var(--dg-border); border-radius: 7px; background: rgba(255, 255, 255, 0.04);
}
.dgallery-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dgallery-thumb[data-selected="true"] { border-color: var(--dg-accent); box-shadow: 0 0 0 1px var(--dg-accent); }
.dgallery-thumb[data-status="warning"] { border-color: var(--dg-warn); }
.dgallery-thumb[data-status="invalid"] { border-color: var(--dg-bad); }
.dgallery-badge {
  position: absolute; left: 3px; top: 3px; min-width: 14px; height: 14px; padding: 0 3px;
  border-radius: 4px; font-size: 10px; line-height: 14px; text-align: center; font-weight: 700;
  background: rgba(0, 0, 0, 0.6); color: #fff;
}
.dgallery-thumb[data-status="valid"] .dgallery-badge { background: var(--dg-ok); color: #04140a; }
.dgallery-thumb[data-status="warning"] .dgallery-badge { background: var(--dg-warn); color: #241500; }
.dgallery-thumb[data-status="invalid"] .dgallery-badge { background: var(--dg-bad); }
.dgallery-tag {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 1px 4px;
  font-size: 9px; line-height: 14px; color: #fff; font-variant-numeric: tabular-nums;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.72), rgba(0, 0, 0, 0));
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dgallery-note { margin: 6px 0 0; color: var(--dg-muted); font-size: 11px; }
.dgallery-note.is-warn { color: var(--dg-warn); }
.dgallery-note[hidden] { display: none; }
.dgallery-card {
  display: flex; gap: 10px; align-items: flex-start; margin-top: 8px; padding: 8px;
  border: 1px solid rgba(53, 167, 255, 0.5); border-radius: 9px;
  background: rgba(53, 167, 255, 0.08);
}
.dgallery-card[hidden] { display: none; }
.dgallery-card-img {
  flex: 0 0 auto; max-width: 46%; max-height: 150px; min-width: 80px;
  border-radius: 6px; background: #05070b; object-fit: contain; display: block; cursor: zoom-in;
}
.dgallery-card-side { flex: 1; min-width: 0; }
.dgallery-card-title { font-weight: 600; }
.dgallery-card-meta { color: var(--dg-muted); font-size: 11px; margin: 2px 0 7px; }
.dgallery-card-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.dgallery-diagnostic { margin-top: 8px; border: 1px solid var(--dg-border); border-radius: 8px; }
.dgallery-diagnostic summary { padding: 7px 9px; cursor: pointer; color: var(--dg-text); }
.dgallery-diagnostic-content { padding: 0 9px 9px; }
.dgallery-diagnostic-help { margin: 0 0 8px; color: var(--dg-muted); font-size: 12px; }
.dgallery-diagnostic-img {
  display: block; width: 100%; max-height: 58vh; object-fit: contain;
  background: #080b10; border-radius: 6px;
}
.dgallery-diagnostic-legend { display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 8px 0 0; padding: 0; list-style: none; }
.dgallery-diagnostic-legend li { display: flex; align-items: center; gap: 6px; color: var(--dg-muted); font-size: 11px; }
.dgallery-diagnostic-swatch { width: 12px; height: 12px; flex: 0 0 auto; border-radius: 3px; background: var(--dg-shot-color); }
.dgallery-foot {
  flex: 0 0 auto; padding: 6px 10px; border-top: 1px solid var(--dg-border);
  color: var(--dg-muted); font-size: 11px;
}
@media (max-height: 560px) {
  .dgallery-thumbs { grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); }
  .dgallery-card-img { max-height: 96px; }
}
@media (pointer: coarse) {
  .dgallery-icon { width: 32px; height: 32px; }
  .dgallery-btn { min-height: 32px; }
}
`

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = GALLERY_CSS
  document.head.appendChild(style)
}

interface GalleryRefs {
  mask: HTMLElement
  sessionSelect: HTMLSelectElement
  stats: HTMLElement
  chips: HTMLElement
  body: HTMLElement
  downloadStatus: HTMLElement
}

/**
 * 影像集弹窗:按组合分组的影像浏览 + 每组一键合成。
 *
 * DOM **懒挂载**:构造只记住服务与选项,首次 `open()` 才建节点、注入样式、订阅服务与键盘;
 * `close()` 把整棵 DOM 拆掉(不是藏起来),于是"没打开"时它对本页零影响。
 */
export class DroneGallery {
  private readonly service: CaptureService
  private readonly options: DroneGalleryOptions
  private readonly stitcher: ProgressAwareStitcher | null
  private root: HTMLDivElement | null = null
  private refs: GalleryRefs | null = null
  private unsubscribe: (() => void) | null = null
  private viewer: DroneImageViewer | null = null
  /** viewer 是本弹窗自己建的(销毁时要一并销毁;宿主传进来的不碰) */
  private ownViewer = false
  private panorama: DronePanoramaViewer | null = null
  /** panorama 同上:只有自己建的才由自己销毁 */
  private ownPanorama = false
  private sessionId: string | null = null
  private selectedId: string | null = null
  /** 各组的合成状态(按分组键);合成结果不是会话数据,只活在弹窗生命周期里 */
  private readonly stitches = new Map<string, StitchState>()
  /** 当前正在播报进度的组(拼接器只有一个,逐组串行调用) */
  private progressKey: string | null = null
  private bodyOverflow = ''
  private destroyed = false
  private downloadInProgress = false

  /** 构造影像集弹窗:网格相册 + 大图 + 360° 环视入口 */
  constructor(service: CaptureService, options: DroneGalleryOptions = {}) {
    this.service = service
    this.options = options
    this.stitcher =
      options.stitcher === undefined
        ? createEquirectStitcher()
        : (options.stitcher as ProgressAwareStitcher | null)
    if (this.stitcher) {
      this.stitcher.onProgress = (done, total) => {
        const key = this.progressKey
        if (!key) return
        const state = this.stitches.get(key)
        if (!state || state.status !== 'running') return
        state.done = done
        state.total = total
        this.renderStitch(key)
      }
    }
  }

  /** 弹窗当前是否打开 */
  get isOpen(): boolean {
    return this.root !== null && !this.root.hidden
  }

  /** 打开弹窗;`sessionId` 缺省用采集服务里当前活跃的会话 */
  open(sessionId?: string): void {
    if (this.destroyed) return
    this.sessionId = sessionId ?? this.service.activeSession?.id ?? null
    this.mount()
    const root = this.root
    if (!root) return
    root.hidden = false
    this.lockScroll()
    this.render()
    root.focus()
  }

  /** 关闭弹窗(并把整棵 DOM / 键盘监听 / 两个子弹窗一并收走) */
  close(): void {
    if (!this.root) return
    const wasOpen = !this.root.hidden
    this.panorama?.close()
    this.viewer?.close()
    this.unmount()
    if (wasOpen) this.options.onClose?.()
  }

  /** 重新渲染当前会话的分组视图(宿主改了服务状态后可主动调用) */
  refresh(): void {
    if (!this.isOpen) return
    this.render()
  }

  /** 关闭球面全景查看器(没开时是空操作) */
  closePanorama(): void {
    this.panorama?.close()
  }

  /** 程序化合成某一组(与点「一键合成」同一条路径);已在合成中则忽略 */
  async stitch(groupKey: string): Promise<PanoramaStitchResult | null> {
    const session = this.resolveSession()
    const group = session ? groupSessionImages(session.images).find((g) => g.key === groupKey) : null
    if (!group || group.kind !== 'panorama') return null
    const current = this.stitches.get(groupKey)
    if (current?.status === 'running') return null
    if (!this.stitcher) return null

    this.stitches.set(groupKey, { status: 'running', done: 0, total: group.images.length })
    this.progressKey = groupKey
    this.renderStitch(groupKey)
    let result: PanoramaStitchResult | null = null
    try {
      result = await this.stitcher.stitch({
        id: group.key,
        mode: (group.mode ?? 'pano-180') as 'pano-wide' | 'pano-180' | 'pano-360',
        sessionId: session?.id ?? '',
        images: group.images,
      })
    } catch (error) {
      this.stitches.set(groupKey, {
        status: 'error',
        done: 0,
        total: group.images.length,
        message: `合成失败:${(error as Error).message}`,
      })
      this.progressKey = null
      this.renderStitch(groupKey)
      this.options.onStitched?.(group, null)
      return null
    }
    this.progressKey = null

    if (!result) {
      this.stitches.set(groupKey, {
        status: 'error',
        done: 0,
        total: group.images.length,
        message: '这组没法合成(可用影像不足,或图片没有可读的预览地址)',
      })
    } else {
      this.stitches.set(groupKey, {
        status: 'done',
        done: group.images.length,
        total: group.images.length,
        result,
      })
    }
    this.renderStitch(groupKey)
    this.options.onStitched?.(group, result)
    return result
  }

  /** 依次合成当前会话里所有的全景组 */
  async stitchAll(): Promise<void> {
    const session = this.resolveSession()
    if (!session) return
    const groups = groupSessionImages(session.images).filter((group) => group.kind === 'panorama')
    for (const group of groups) await this.stitch(group.key)
  }

  /** 关闭并移除弹窗(含嵌套的大图/全景查看器) */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    // ⚠️ 顺序即正确性:两个子弹窗各自锁过 body 的 overflow,解锁必须**后锁的先解**
    // (全景查看器 / 大图查看器都盖在本弹窗之上,它们保存的"上一层值"才是 'hidden'),
    // 先拆它们再拆自己,bodyOverflow 才会一路回退到进场前的空串。反序会残留 overflow:hidden。
    this.panorama?.close()
    this.viewer?.close()
    if (this.ownPanorama) this.panorama?.destroy()
    if (this.ownViewer) this.viewer?.destroy()
    this.panorama = null
    this.viewer = null
    this.unmount()
    if (this.options.injectStyles !== false) document.getElementById(STYLE_ID)?.remove()
  }

  // ───────────────────────────── 内部:生命周期 ─────────────────────────────

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
    root.className = 'dgallery'
    root.hidden = true
    root.tabIndex = -1
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-label', this.options.title ?? '影像集')
    if (this.options.zIndex && this.options.zIndex !== DEFAULT_Z_INDEX) {
      root.style.zIndex = String(this.options.zIndex)
    }
    root.innerHTML = this.template()
    document.body.appendChild(root)
    this.root = root
    this.refs = {
      mask: this.query('[data-role="mask"]'),
      sessionSelect: this.query<HTMLSelectElement>('[data-role="session"]'),
      stats: this.query('[data-role="stats"]'),
      chips: this.query('[data-role="chips"]'),
      body: this.query('[data-role="body"]'),
      downloadStatus: this.query('[data-role="download-status"]'),
    }

    if (this.options.viewer) {
      this.viewer = this.options.viewer
      this.ownViewer = false
    } else if (this.options.viewerEnabled !== false) {
      // 层级排在影像集之上:大图弹窗盖住图集,Esc 先关大图(见模块头注释 3)
      this.viewer = new DroneImageViewer(this.service, {
        ...this.options.viewerOptions,
        zIndex: (this.options.zIndex ?? DEFAULT_Z_INDEX) + 100,
        onNavigate: (image, index) => {
          this.selectedId = image.id
          this.syncSelection()
          this.options.viewerOptions?.onNavigate?.(image, index)
        },
      })
      this.ownViewer = true
    }

    if (this.options.panoramaViewer) {
      this.panorama = this.options.panoramaViewer
      this.ownPanorama = false
    } else if (this.options.panoramaViewerEnabled !== false) {
      // 层级排在影像集(与大图弹窗)之上:球面浏览是全屏独占地看一张图,Esc 先关它
      this.panorama = new DronePanoramaViewer({
        ...this.options.panoramaViewerOptions,
        zIndex: (this.options.zIndex ?? DEFAULT_Z_INDEX) + 200,
      })
      this.ownPanorama = true
    }

    root.addEventListener('click', this.onClick)
    this.refs.sessionSelect.addEventListener('change', this.onSessionChange)
    window.addEventListener('keydown', this.onKeyDown, { capture: true })
    this.unsubscribe = this.service.subscribe(() => this.render())
  }

  private unmount(): void {
    window.removeEventListener('keydown', this.onKeyDown, { capture: true })
    this.unsubscribe?.()
    this.unsubscribe = null
    this.root?.remove()
    this.root = null
    this.refs = null
    this.unlockScroll()
  }

  // ───────────────────────────── 内部:渲染 ─────────────────────────────

  private render(): void {
    const refs = this.refs
    const root = this.root
    if (!root || !refs || root.hidden) return
    const session = this.resolveSession()

    // 会话选择器
    const sessions = this.service.listSessions()
    const signature = sessions.map((item) => `${item.id}:${item.options.name}`).join('|')
    if (refs.sessionSelect.dataset.signature !== signature) {
      refs.sessionSelect.dataset.signature = signature
      refs.sessionSelect.innerHTML = sessions
        .map(
          (item) =>
            `<option value="${escapeHtml(item.id)}">${escapeHtml(item.options.name)} · ${item.images.length}</option>`,
        )
        .join('')
    } else {
      const options = refs.sessionSelect.options
      sessions.forEach((item, i) => {
        const option = options[i]
        if (!option) return
        const text = `${item.options.name} · ${item.images.length}`
        if (option.textContent !== text) option.textContent = text
      })
    }
    if (session) refs.sessionSelect.value = session.id

    const images = session?.images ?? []
    const downloadButton = root.querySelector<HTMLButtonElement>(
      '[data-action="download-originals"]',
    )
    if (downloadButton) {
      downloadButton.disabled = images.length === 0 || this.downloadInProgress
      downloadButton.textContent = this.downloadInProgress ? '正在打包…' : '打包原图'
    }
    const groups = groupSessionImages(images)
    const valid = images.filter((image) => image.validation.status === 'valid').length
    const warning = images.filter((image) => image.validation.status === 'warning').length
    const invalid = images.filter((image) => image.validation.status === 'invalid').length
    refs.stats.innerHTML = session
      ? `共 <b>${images.length}</b> 张 · ${groups.length} 组 · ` +
        `<span class="is-ok">有效 ${valid}</span> · <span class="is-warn">警告 ${warning}</span> · ` +
        `<span class="is-bad">无效 ${invalid}</span>`
      : '未创建会话'

    refs.chips.hidden = groups.length < 2
    // 「合成全部」只在真的有全景组时才有意义(否则点了什么都不会发生)
    const stitchAll = root.querySelector<HTMLButtonElement>('[data-action="stitch-all"]')
    if (stitchAll) {
      stitchAll.hidden = !groups.some((group) => group.kind === 'panorama' && group.images.length >= 2)
    }
    refs.chips.innerHTML = groups
      .map(
        (group, i) =>
          `<button type="button" class="dgallery-chip" data-action="jump" data-key="${escapeHtml(group.key)}">` +
          `<i style="--dg-group:${groupColor(i)}"></i>${escapeHtml(group.label)} · ${group.images.length}</button>`,
      )
      .join('')

    if (!images.length) {
      refs.body.innerHTML = `<p class="dgallery-note">${
        session ? '这个会话里还没有影像。' : '未创建会话。'
      }</p>`
      return
    }

    // 重渲染会重建缩略图 DOM,先把滚动位置记下来(否则扫描过程中每入库一张就跳回顶部)
    const scrollTop = refs.body.scrollTop
    refs.body.innerHTML = groups
      .map((group, i) => this.groupMarkup(group, i))
      .join('')
    refs.body.scrollTop = scrollTop
    for (const group of groups) this.renderStitch(group.key)
    this.syncSelection()
  }

  private groupMarkup(group: ImageGroup, colorIndex: number): string {
    const shown = group.images.slice(0, MAX_THUMBS_PER_GROUP)
    const hidden = group.images.length - shown.length
    const color = groupColor(colorIndex)
    const parts: string[] = []
    parts.push(
      `<section class="dgallery-group" data-key="${escapeHtml(group.key)}" style="--dg-group:${color}">`,
    )
    parts.push('<div class="dgallery-group-head">')
    parts.push(`<span class="dgallery-group-title">${escapeHtml(group.label)}</span>`)
    let sub = `<span class="dgallery-group-sub">${group.images.length} 张`
    if (group.kind === 'panorama') {
      sub += ` / ${group.total ?? group.images.length} 张`
      sub += group.complete
        ? ` · <span class="is-ok">已拍完</span>`
        : ` · <span class="is-warn">未拍完</span>`
      sub += ` · 组 ${escapeHtml(group.key)}`
    }
    sub += `</span>`
    parts.push(sub)
    parts.push('<span class="dgallery-spacer"></span>')
    if (group.kind === 'panorama' && group.images.length >= 2 && this.stitcher) {
      parts.push(
        `<button type="button" class="dgallery-btn dgallery-primary" data-action="stitch" data-key="${escapeHtml(group.key)}">一键合成</button>`,
      )
    }
    parts.push('</div>')

    parts.push('<div class="dgallery-thumbs">')
    shown.forEach((image, i) => {
      const sequence = group.indexes[i] ?? i + 1
      parts.push(
        `<button type="button" class="dgallery-thumb" data-action="select-image" data-id="${escapeHtml(image.id)}" ` +
          `data-status="${image.validation.status}" ` +
          `title="#${sequence} ${escapeHtml(image.fileName)} · ${VALIDATION_LABELS[image.validation.status]}" aria-label="查看第 ${sequence} 张">` +
          (image.imageUrl ? `<img src="${image.imageUrl}" alt="" loading="lazy">` : '') +
          `<span class="dgallery-badge">${VALIDATION_BADGES[image.validation.status]}</span>` +
          `<span class="dgallery-tag">${escapeHtml(imageTileLabel(image, sequence))}</span>` +
          `</button>`,
      )
    })
    parts.push('</div>')
    if (hidden > 0) {
      parts.push(
        `<p class="dgallery-note">还有 ${hidden} 张未在此列出(共 ${group.images.length} 张)。</p>`,
      )
    }
    parts.push(`<div data-role="stitch" data-key="${escapeHtml(group.key)}"></div>`)
    parts.push('</section>')
    return parts.join('')
  }

  /** 只刷新某一组的合成区(合成进度高频更新,整表重绘会闪) */
  private renderStitch(groupKey: string): void {
    const refs = this.refs
    if (!refs) return
    const slot = refs.body.querySelector<HTMLElement>(
      `[data-role="stitch"][data-key="${cssEscape(groupKey)}"]`,
    )
    if (!slot) return
    const button = refs.body.querySelector<HTMLButtonElement>(
      `[data-action="stitch"][data-key="${cssEscape(groupKey)}"]`,
    )
    const state = this.stitches.get(groupKey)
    if (!state) {
      slot.innerHTML = ''
      if (button) {
        button.disabled = false
        button.textContent = '一键合成'
        button.classList.remove('dgallery-on')
      }
      return
    }
    if (state.status === 'running') {
      if (button) {
        button.disabled = true
        button.classList.add('dgallery-on')
        button.textContent =
          state.total > 0 ? `合成中 ${state.done}/${state.total}` : `合成中 ${state.done}`
      }
      slot.innerHTML = `<p class="dgallery-note">等距柱状拼接中,逐张反投影…</p>`
      return
    }
    if (state.status === 'error') {
      if (button) {
        button.disabled = false
        button.classList.remove('dgallery-on')
        button.textContent = '重试合成'
      }
      slot.innerHTML = `<p class="dgallery-note is-warn">${escapeHtml(state.message ?? '合成失败')}</p>`
      return
    }
    const result = state.result
    if (button) {
      button.disabled = false
      button.classList.remove('dgallery-on')
      button.textContent = '重新合成'
    }
    if (!result?.url) {
      slot.innerHTML = `<p class="dgallery-note is-warn">合成完成,但没有可用的图片地址。</p>`
      return
    }
    const bits: string[] = []
    if (result.width && result.height) bits.push(`${result.width}×${result.height}`)
    if (typeof result.coverage === 'number') bits.push(`实拍覆盖 ${Math.round(result.coverage * 100)}%`)
    const size = estimateDataUrlBytes(result.url)
    if (size > 0) bits.push(formatBytes(size))
    const diagnostic = result.diagnosticUrl
      ? `<details class="dgallery-diagnostic">` +
        `<summary>拍摄覆盖检查（看颜色即可）</summary>` +
        `<div class="dgallery-diagnostic-content">` +
        `<p class="dgallery-diagnostic-help">这不是照片，是拍摄覆盖地图：红色表示没有任何照片拍到，拼接只能猜着补；黄色表示只有一张照片拍到，容易出现接缝；绿色表示至少两张照片重叠。找墙出现的位置看颜色即可。</p>` +
        `<img class="dgallery-diagnostic-img" src="${result.diagnosticUrl}" alt="平面全景覆盖图">` +
        `<ul class="dgallery-diagnostic-legend">` +
        `<li><i class="dgallery-diagnostic-swatch" style="--dg-shot-color:#ef4444"></i><span>红：没拍到 ${Math.round((result.diagnosticCoverage?.uncovered ?? 0) * 100)}%</span></li>` +
        `<li><i class="dgallery-diagnostic-swatch" style="--dg-shot-color:#facc15"></i><span>黄：只拍到一次 ${Math.round((result.diagnosticCoverage?.single ?? 0) * 100)}%</span></li>` +
        `<li><i class="dgallery-diagnostic-swatch" style="--dg-shot-color:#22c55e"></i><span>绿：有照片重叠 ${Math.round((result.diagnosticCoverage?.overlap ?? 0) * 100)}%</span></li>` +
        `</ul></div></details>`
      : ''
    slot.innerHTML =
      `<div class="dgallery-card">` +
      `<img class="dgallery-card-img" data-action="view-panorama" data-key="${escapeHtml(groupKey)}" src="${result.url}" alt="合成全景">` +
      `<div class="dgallery-card-side">` +
      `<div class="dgallery-card-title">合成全景图</div>` +
      `<div class="dgallery-card-meta">等距柱状 360°×180° · ${bits.map(escapeHtml).join(' · ')}</div>` +
      `<div class="dgallery-card-actions">` +
      `<button type="button" class="dgallery-btn dgallery-primary" data-action="view-panorama" data-key="${escapeHtml(groupKey)}">360° 环视</button>` +
      `<button type="button" class="dgallery-btn" data-action="download-stitch" data-key="${escapeHtml(groupKey)}">下载</button>` +
      `</div></div></div>` +
      diagnostic
  }

  /**
   * 只刷新选中态(缩略图高亮 + 结果卡片不重绘)。
   * 大图弹窗里翻页会高频走到这里,整表重绘(几十上百个 `<img>`)纯属浪费。
   */
  private syncSelection(): void {
    const refs = this.refs
    if (!refs) return
    for (const el of refs.body.querySelectorAll<HTMLElement>('.dgallery-thumb')) {
      el.dataset.selected = String(el.dataset.id === this.selectedId)
    }
  }

  // ───────────────────────────── 内部:交互 ─────────────────────────────

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null
    const actionEl = target?.closest<HTMLElement>('[data-action]')
    if (!actionEl) {
      // 点遮罩关弹窗;点画面其它地方不关(免得想细看的人被弹出去)
      if (target === this.root || target === this.refs?.mask) this.close()
      return
    }
    const action = actionEl.dataset.action ?? ''
    switch (action) {
      case 'close':
        this.close()
        break
      case 'jump': {
        const key = actionEl.dataset.key ?? ''
        const section = this.refs?.body.querySelector<HTMLElement>(
          `.dgallery-group[data-key="${cssEscape(key)}"]`,
        )
        section?.scrollIntoView({ block: 'start' })
        break
      }
      case 'select-image': {
        const id = actionEl.dataset.id ?? ''
        this.selectedId = id
        this.syncSelection()
        this.viewer?.open(id, this.resolveSession()?.id)
        break
      }
      case 'stitch':
        void this.stitch(actionEl.dataset.key ?? '')
        break
      case 'download-originals':
        void this.downloadOriginals()
        break
      case 'stitch-all':
        void this.stitchAll()
        break
      case 'view-panorama': {
        const key = actionEl.dataset.key ?? ''
        const result = this.stitches.get(key)?.result
        if (result?.url) this.panorama?.open(result, '合成全景图')
        break
      }
      case 'download-stitch': {
        const key = actionEl.dataset.key ?? ''
        const result = this.stitches.get(key)?.result
        if (result?.url) triggerDownload(result.url, result.name ?? `${key}-pano.png`)
        break
      }
      default:
        break
    }
  }

  private readonly onSessionChange = (): void => {
    const refs = this.refs
    if (!refs) return
    const session = this.service.getSession(refs.sessionSelect.value)
    if (!session) return
    // 「当前会话」= 服务里 updatedAt 最新的那个(与采集面板同一套语义)
    session.updatedAt = new Date().toISOString()
    this.sessionId = session.id
    this.selectedId = null
    this.viewer?.close()
    this.panorama?.close()
    this.render()
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.destroyed || !this.root || this.root.hidden) return
    // 球面全景查看器 / 大图查看器盖在上面时整体让位:否则 Esc 会先关掉影像集,
    // 把上面那层留在屏幕上(见模块头注释 3)
    if (this.panorama?.isOpen || this.viewer?.isOpen) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
    }
    // 独占键盘:面板的键盘飞行挂在冒泡阶段,这里在捕获阶段截住,
    // 翻图集时 WASD / 方向键不会顺带把无人机飞出去
    event.stopPropagation()
  }

  private async downloadOriginals(): Promise<void> {
    if (this.downloadInProgress) return
    const session = this.resolveSession()
    if (!session?.images.length) {
      this.setDownloadStatus('当前会话没有可下载的图片。')
      return
    }
    this.downloadInProgress = true
    this.setDownloadStatus(`正在打包 ${session.images.length} 张原图…`)
    this.render()
    try {
      const archive = await createOriginalImagesZip(session.images)
      const url = URL.createObjectURL(archive)
      const fileBase =
        session.options.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '影像集'
      triggerDownload(url, `${fileBase}-原始图片.zip`)
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      this.setDownloadStatus(`已打包下载 ${session.images.length} 张原图。`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setDownloadStatus(`打包下载失败：${message}`)
    } finally {
      this.downloadInProgress = false
      this.render()
    }
  }

  private setDownloadStatus(message: string): void {
    if (this.refs) this.refs.downloadStatus.textContent = message
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
    if (!root) throw new Error('[DroneGallery] 弹窗尚未挂载')
    const el = root.querySelector<T>(selector)
    if (!el) throw new Error(`[DroneGallery] 缺少节点:${selector}`)
    return el
  }

  private template(): string {
    const title = escapeHtml(this.options.title ?? '影像集')
    const canStitchAll = Boolean(this.stitcher)
    return `
      <div class="dgallery-mask" data-role="mask" data-action="close"></div>
      <div class="dgallery-frame">
        <div class="dgallery-bar">
          <span class="dgallery-title">${title}</span>
          <select class="dgallery-session" data-role="session" title="切换会话"></select>
          <span class="dgallery-stats" data-role="stats">–</span>
          <span class="dgallery-spacer"></span>
          ${
            canStitchAll
              ? '<button type="button" class="dgallery-btn" data-action="stitch-all" title="把当前会话里所有全景组依次合成">合成全部</button>'
              : ''
          }
          <button type="button" class="dgallery-btn" data-action="download-originals" title="将当前会话的原图打包为 ZIP">打包原图</button>
          <button type="button" class="dgallery-icon" data-action="close" title="关闭 (Esc)" aria-label="关闭">×</button>
        </div>
        <div class="dgallery-chips" data-role="chips" hidden></div>
        <div class="dgallery-body" data-role="body"></div>
        <div class="dgallery-foot"><span>点缩略图看大图 · 全景组「一键合成」后可「360° 环视」拖动看四周 · Esc 关闭</span><span data-role="download-status" aria-live="polite"></span></div>
      </div>
    `
  }
}

/** 分组色标(按出现顺序给色相,不引调色板依赖) */
function groupColor(index: number): string {
  const hue = (HUE_BASE + index * HUE_STEP) % 360
  return `hsl(${hue} 78% 62%)`
}

/** 从 data URL 的头估算字节数(给结果卡片报个体积,不必真解码) */
function estimateDataUrlBytes(url: string): number {
  if (!url.startsWith('data:')) return 0
  const comma = url.indexOf(',')
  if (comma < 0) return 0
  const body = url.length - comma - 1
  const padding = url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((body * 3) / 4) - padding)
}

/** 选择器里嵌动态字符串时的最小转义(分组键可能带 `-` `.` `:` 等) */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}
