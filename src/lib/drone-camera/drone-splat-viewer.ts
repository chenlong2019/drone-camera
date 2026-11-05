/**
 * 3D Gaussian Splatting 查看器(原生 DOM + 手写 WebGL2,零依赖)。
 *
 * 它补的是"第三种表达":同一份重建数据,网格是硬表面,点云是无序点,splat 是**带朝向的
 * 椭球 + 不透明度**,按深度排序后做 alpha 混合 —— 画面是"软"的,拉近不会暴露三角面。
 *
 * 三处必须讲清楚的实现选择:
 *
 * 1. **EWA 投影,不是"画个点"**。每个高斯有三根尺度轴和一个四元数,投影到屏幕是一个椭圆:
 *      Σ_cam = (V·R)·diag(σ²)·(V·R)ᵀ,  Σ_2D = J·Σ_cam·Jᵀ
 *    J 是透视投影的雅可比。这个椭圆有多大、朝哪转,全靠 Σ_2D 的 2×2 特征分解决定。
 *    真机上"远处的点闪成噪点"就是**漏了低通项** `uMinVariance`(0.3 px²),投影面积小于
 *    一个像素时它在相邻帧之间来回跳。
 *
 * 2. **每帧排序,用基数排序**。alpha 混合不可交换:近的先画、远的后画,近处就被遮住了。
 *    顺序错的表现不是"某处黑",而是整片半透明雾。`Array.sort` 对 5 万条约 8~12ms,
 *    这里用两轮 16 位 LSD 基数排序(O(2n))约 1~2ms,并把排好的**下标**上传,而不是把
 *    整个属性缓冲重排重传 —— 后者 20 万条时是 9MB/帧。
 *
 * 3. **属性放 float 纹理,下标做实例属性**。着色器按 `aIndex` 用 `texelFetch` 取每个
 *    splat 的位置/尺度/四元数/颜色,于是"排序"只是重排一个 Uint32 数组再 bufferSubData。
 *
 * ```ts
 * const viewer = new DroneSplatViewer()
 * viewer.open(sampleCloud)              // 也可以 open() 直接看内置示例
 * viewer.loadFile(file)                 // 用户拖进来的 .ply / .splat
 * ```
 */
import { createReconstructionSample, DepthSorter, parseSplat } from './drone-splat'
import type { SplatCloud } from './drone-splat'

export interface DroneSplatViewerOptions {
  /** 是否注入自带样式,默认 true */
  injectStyles?: boolean
  /** 弹窗层级,默认 1150(排在影像集 1100 之上) */
  zIndex?: number
  /** 初始标题 */
  title?: string
  /** 是否提供「导入」按钮(本地 .ply / .splat),默认 true */
  importable?: boolean
  /**
   * 追加到工具栏的按钮(按顺序排在「导入」之后)。
   *
   * 数据源由宿主决定 —— 查看器只管画 splat,不该知道"采集位姿"或"示例场景"是什么。
   * 典型用法:宿主在这里放一个「示例场景」按钮,让用户从真实数据切回内置示例。
   */
  extraActions?: Array<{ label: string; className?: string; onClick: () => void }>
  /** 打开时若没有任何数据,是否自动载入内置示例,默认 true */
  sampleOnOpen?: boolean
  /** 世界上方向:3DGS 数据多为 y 向上;COLMAP 坐标系是 y 向下,可传 'z' 或 '-y' */
  upAxis?: 'y' | 'z' | '-y'
  /** alpha 低于该值的片元直接丢弃,默认 1/255 */
  alphaCutoff?: number
  /** 关闭回调(× / 遮罩 / Esc) */
  onClose?: () => void
}

export interface DroneSplatViewerStats {
  count: number
  /** 平滑后的帧率 */
  fps: number
  /** 最近一次排序耗时(ms) */
  sortMs: number
  sorting: boolean
  name: string
}

type SplatViewerSource = string | SplatCloud

interface ViewerRefs {
  root: HTMLDivElement
  mask: HTMLElement
  stage: HTMLElement
  canvas: HTMLCanvasElement
  title: HTMLElement
  hud: HTMLElement
  note: HTMLElement
  sortButton: HTMLButtonElement
  file: HTMLInputElement
}

interface SplatTextures {
  center: WebGLTexture
  scale: WebGLTexture
  quat: WebGLTexture
  color: WebGLTexture
  /** 每条 splat 一列的纹理布局宽度 */
  width: number
  height: number
}

interface SplatGpuState {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  cornerBuffer: WebGLBuffer
  indexBuffer: WebGLBuffer
  textures: SplatTextures
  uniforms: {
    center: WebGLUniformLocation | null
    scale: WebGLUniformLocation | null
    quat: WebGLUniformLocation | null
    color: WebGLUniformLocation | null
    texWidth: WebGLUniformLocation | null
    view: WebGLUniformLocation | null
    viewport: WebGLUniformLocation | null
    focal: WebGLUniformLocation | null
    minVariance: WebGLUniformLocation | null
    radiusSigma: WebGLUniformLocation | null
    alphaCutoff: WebGLUniformLocation | null
  }
}

const STYLE_ID = 'drone-splat-viewer-styles'
const DEFAULT_Z_INDEX = 1150
const DEG = Math.PI / 180
/** 纹理布局宽度:2048 列 × 2048 行 = 400 万条上限,远超浏览器能流畅渲染的量级 */
const TEX_WIDTH = 2048
/** 3σ 之后高斯值已衰减到 1%,再大只是白烧填充率 */
const RADIUS_SIGMA = 3
/** 低通项:防远处 splat 小于一像素时闪烁(与论文一致的经验值) */
const MIN_VARIANCE = 0.3
const DEFAULT_FOV_DEG = 45
const MAX_PITCH_DEG = 89
/** 排序耗时超过这个值就每两帧才排一次,保证画面刷新率优先 */
const SORT_BUDGET_MS = 12

const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 aCorner;
in uint aIndex;

uniform sampler2D uCenter;   // xyz = 中心,w = 不透明度
uniform sampler2D uScale;    // xyz = σ
uniform sampler2D uQuat;     // xyzw = 四元数(w,x,y,z)
uniform sampler2D uColor;    // rgb = 基础色
uniform int uTexWidth;
uniform mat4 uView;
uniform vec2 uViewport;
uniform float uFocalPx;
uniform float uMinVariance;
uniform float uRadiusSigma;

out vec4 vColor;
out vec2 vLocal;

mat3 quatToMat3(vec4 q) {
  float w = q.x, x = q.y, y = q.z, z = q.w;
  return mat3(
    1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
    2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
    2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y)
  );
}

void main() {
  ivec2 texel = ivec2(int(aIndex) % uTexWidth, int(aIndex) / uTexWidth);
  vec4 centerAlpha = texelFetch(uCenter, texel, 0);
  vec3 sigma = texelFetch(uScale, texel, 0).xyz;
  vec4 quat = texelFetch(uQuat, texel, 0);
  vec3 rgb = texelFetch(uColor, texel, 0).rgb;

  vec4 viewPos = uView * vec4(centerAlpha.xyz, 1.0);
  float z = -viewPos.z;

  // 在相机后方 / 完全透明的 splat:推到裁剪体外,交给光栅化丢弃
  if (z < 0.05 || centerAlpha.w < 0.004) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = vec4(0.0);
    vLocal = vec2(0.0);
    return;
  }

  mat3 V = mat3(uView);
  mat3 M = V * quatToMat3(quat);
  M[0] = M[0] * sigma.x;
  M[1] = M[1] * sigma.y;
  M[2] = M[2] * sigma.z;
  mat3 cov = M * transpose(M);

  float invZ = 1.0 / z;
  vec3 t0 = vec3(uFocalPx * invZ, 0.0, -uFocalPx * viewPos.x * invZ * invZ);
  vec3 t1 = vec3(0.0, uFocalPx * invZ, -uFocalPx * viewPos.y * invZ * invZ);

  float ca = dot(t0, cov * t0) + uMinVariance;
  float cb = dot(t0, cov * t1);
  float cc = dot(t1, cov * t1) + uMinVariance;

  float mid = 0.5 * (ca + cc);
  float disc = sqrt(max(0.0, mid * mid - (ca * cc - cb * cb)));
  float l1 = mid + disc;
  float l2 = max(mid - disc, 0.0);
  vec2 e1 = abs(cb) > 1e-9
    ? normalize(vec2(cb, l1 - ca))
    : (ca >= cc ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 e2 = vec2(-e1.y, e1.x);

  vec2 offsetPx = uRadiusSigma * (sqrt(l1) * e1 * aCorner.x + sqrt(l2) * e2 * aCorner.y);
  vec2 ndcCenter = vec2(viewPos.x, viewPos.y) * invZ * (2.0 * uFocalPx / uViewport);
  gl_Position = vec4(ndcCenter + offsetPx * (2.0 / uViewport), 0.0, 1.0);

  vLocal = aCorner * uRadiusSigma;
  vColor = vec4(rgb, centerAlpha.w);
}
`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec4 vColor;
in vec2 vLocal;
uniform float uAlphaCutoff;
out vec4 outColor;

void main() {
  // vLocal 以 σ 为单位:角点 3σ 处 exp(-4.5) ≈ 1.1%
  float alpha = vColor.a * exp(-0.5 * dot(vLocal, vLocal));
  if (alpha < uAlphaCutoff) discard;
  // 预乘 alpha:配合 ONE / ONE_MINUS_SRC_ALPHA,从远到近叠加即得到正确结果
  outColor = vec4(vColor.rgb * alpha, alpha);
}
`

const VIEWER_CSS = `
.dsv {
  --dsv-text: #e9eff9;
  --dsv-muted: rgba(233, 239, 249, 0.58);
  --dsv-border: rgba(255, 255, 255, 0.12);
  --dsv-accent: #67d2ff;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.dsv {
  position: fixed; inset: 0; z-index: ${DEFAULT_Z_INDEX};
  display: flex; align-items: center; justify-content: center;
  padding: max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom));
  color: var(--dsv-text);
  outline: none;
}
.dsv[hidden] { display: none; }
.dsv-mask { position: absolute; inset: 0; background: rgba(3, 5, 8, 0.96); }
.dsv-frame {
  position: relative; z-index: 1;
  display: flex; flex-direction: column;
  width: min(100%, 1420px); height: 100%; overflow: hidden;
  border: 1px solid var(--dsv-border); border-radius: 12px;
  background: rgba(8, 11, 16, 0.97);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
}
.dsv-bar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-bottom: 1px solid var(--dsv-border);
}
.dsv-title { font-weight: 600; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsv-hud { color: var(--dsv-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsv-spacer { flex: 1; min-width: 4px; }
.dsv-btn {
  flex: 0 0 auto; min-height: 26px; padding: 3px 10px; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--dsv-border); border-radius: 7px;
  background: rgba(255, 255, 255, 0.06); color: var(--dsv-text); font: inherit; font-size: 12px;
}
.dsv-btn:hover { background: rgba(255, 255, 255, 0.14); }
.dsv-btn[data-on="false"] { color: var(--dsv-accent); border-color: rgba(103, 210, 255, 0.4); }
.dsv-icon {
  flex: 0 0 auto; width: 26px; height: 26px; padding: 0; cursor: pointer;
  border: 1px solid var(--dsv-border); border-radius: 7px;
  background: rgba(255, 255, 255, 0.06); color: var(--dsv-text); font: inherit; line-height: 1;
}
.dsv-icon:hover { background: rgba(255, 255, 255, 0.14); }
.dsv-stage {
  position: relative; flex: 1; min-height: 0; overflow: hidden;
  background: radial-gradient(circle at 50% 45%, #0b1119, #04060a 72%);
  touch-action: none; cursor: grab;
}
.dsv-stage[data-dragging="true"] { cursor: grabbing; }
.dsv-stage[data-dropping="true"] { outline: 2px dashed var(--dsv-accent); outline-offset: -10px; }
.dsv-canvas { display: block; width: 100%; height: 100%; }
.dsv-canvas[hidden] { display: none; }
.dsv-note {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  margin: 0; padding: 14px 18px; max-width: 76%;
  border: 1px solid var(--dsv-border); border-radius: 10px;
  background: rgba(10, 14, 20, 0.92); color: var(--dsv-muted); text-align: center;
}
.dsv-note[hidden] { display: none; }
.dsv-note[data-tone="error"] { color: #ffb4b4; border-color: rgba(255, 120, 120, 0.35); }
.dsv-foot {
  flex: 0 0 auto; padding: 6px 10px; border-top: 1px solid var(--dsv-border);
  color: var(--dsv-muted); font-size: 11px;
}
.dsv-file { display: none; }
@media (pointer: coarse) {
  .dsv-icon { width: 32px; height: 32px; }
  .dsv-btn { min-height: 32px; }
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeDeg(value: number): number {
  return ((value % 360) + 360) % 360
}

/** Chromium 对失效 pointerId 调 setPointerCapture 会抛异常,包一层不让它冒到页面 */
function capturePointer(element: HTMLElement, pointerId: number): void {
  try {
    const result = element.setPointerCapture(pointerId) as unknown
    if (result instanceof Promise) result.catch(() => undefined)
  } catch {
    /* 合成事件没有真实 pointerId,忽略即可 */
  }
}

function releasePointer(element: HTMLElement, pointerId: number): void {
  try {
    const result = element.releasePointerCapture(pointerId) as unknown
    if (result instanceof Promise) result.catch(() => undefined)
  } catch {
    /* 同上 */
  }
}

/** 千分位:20 万条写成 200,000,比读一长串数字快 */
function formatCount(count: number): string {
  return count.toLocaleString('zh-CN')
}

export class DroneSplatViewer {
  private readonly options: DroneSplatViewerOptions
  private readonly importable: boolean
  private upAxis: 'y' | 'z' | '-y'
  private refs: ViewerRefs | null = null
  private gl: WebGL2RenderingContext | null = null
  private gpu: SplatGpuState | null = null
  private observer: ResizeObserver | null = null
  private rafId = 0
  private bodyOverflow = ''
  private destroyed = false

  private cloud: SplatCloud | null = null
  /** 深度缓冲:每帧按相机位置重算 */
  private depths = new Float32Array(0)
  private readonly sorter = new DepthSorter()
  private sorting = true
  private sortMs = 0
  /** 上一帧排序耗时偏高时,退化为隔帧排序 */
  private sortEveryOther = false
  private frameParity = 0
  private cameraDirty = true
  private drawnCount = 0

  private yaw = 38
  private pitch = 24
  private distance = 20
  private fov = DEFAULT_FOV_DEG
  private target: [number, number, number] = [0, 0, 0]
  private sceneRadius = 10
  private readonly velocity = { yaw: 0, pitch: 0 }

  private readonly pointers = new Map<number, { x: number; y: number }>()
  private pinchDistance = 0
  private panButton = false
  /** 排序关闭时用的"文件顺序"下标,按 count 缓存,免得每帧新建一个数组 */
  private identityOrder = new Uint32Array(0)

  private fps = 0
  private frameCount = 0
  private fpsWindowStart = 0
  private hudDirty = true
  private loadSeq = 0
  private readonly alphaCutoff: number

  constructor(options: DroneSplatViewerOptions = {}) {
    this.options = options
    this.importable = options.importable ?? true
    this.upAxis = options.upAxis ?? 'y'
    this.alphaCutoff = clamp(options.alphaCutoff ?? 1 / 255, 0, 0.5)
  }

  get isOpen(): boolean {
    return this.refs !== null && !this.refs.root.hidden
  }

  get stats(): DroneSplatViewerStats {
    return {
      count: this.cloud?.count ?? 0,
      fps: Math.round(this.fps),
      sortMs: Number(this.sortMs.toFixed(2)),
      sorting: this.sorting,
      name: this.cloud?.name ?? '',
    }
  }

  get currentCloud(): SplatCloud | null {
    return this.cloud
  }

  /**
   * 打开查看器。不传数据时:有上次看过的就还看上次的,没有再载入内置示例
   * (`sampleOnOpen:false` 时留一个"拖入文件"的空态)。
   */
  open(source?: SplatViewerSource, title?: string): void {
    if (this.destroyed) return
    this.mount()
    if (title) this.setTitle(title)
    if (typeof source === 'string') {
      void this.loadUrl(source)
    } else if (source) {
      this.loadCloud(source)
    } else if (!this.cloud && (this.options.sampleOnOpen ?? true)) {
      this.loadCloud(createReconstructionSample(), '示例重建数据')
    }
    this.start()
  }

  close(): void {
    if (!this.refs) return
    this.stop()
    this.refs.root.hidden = true
    this.refs.root.remove()
    this.refs = null
    this.releaseGpu()
    this.unlockScroll()
    this.options.onClose?.()
  }

  destroy(): void {
    if (this.destroyed) return
    // 先解锁滚动再标记销毁:close 里的 unlockScroll 依赖 refs 非空
    if (this.refs) this.close()
    this.destroyed = true
    this.cloud = null
  }

  async loadUrl(url: string): Promise<void> {
    if (!url.trim()) return
    const version = ++this.loadSeq
    this.setNote('正在载入…')
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = await response.arrayBuffer()
      if (version !== this.loadSeq) return
      this.loadBuffer(buffer, url.split('/').pop() ?? url)
    } catch (error) {
      if (version !== this.loadSeq) return
      this.fail(error instanceof Error ? error.message : '载入失败')
    }
  }

  async loadFile(file: File): Promise<void> {
    const version = ++this.loadSeq
    this.setNote(`正在解析 ${file.name}…`)
    try {
      const buffer = await file.arrayBuffer()
      if (version !== this.loadSeq) return
      this.loadBuffer(buffer, file.name)
    } catch (error) {
      if (version !== this.loadSeq) return
      this.fail(error instanceof Error ? error.message : '解析失败')
    }
  }

  /** 直接给 ArrayBuffer(拖拽 / fetch 之外的自定义来源) */
  loadBuffer(buffer: ArrayBuffer, name = 'splat'): void {
    try {
      const result = parseSplat(buffer, { name })
      this.loadCloud(result.cloud, name)
      if (result.warnings.length > 0) {
        this.setNote(result.warnings.join(' · '), 'info', 6000)
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : '解析失败')
    }
  }

  loadCloud(cloud: SplatCloud, title?: string): void {
    if (!this.refs) return
    if (!cloud || cloud.count === 0) {
      this.fail('这份数据里没有可显示的 splat')
      return
    }
    this.cloud = cloud
    this.setTitle(title ?? cloud.name ?? 'Splat 场景')
    this.fitView()
    this.uploadCloud(cloud)
    this.setNote('')
    this.hudDirty = true
    this.cameraDirty = true
  }

  /**
   * 切换世界上方向并重新取景。
   *
   * 三种数据的上方向天然不同:3DGS 训练出来的场景多是 **y 向上**(与训练器一致),
   * 采集位姿在 `local-enu` 里是 **z 向上**,COLMAP 原生世界是 **y 向下**。
   * 上方向错了画面不会报错,只会"歪着转"——所以宁可显式传,不要猜。
   */
  setUpAxis(axis: 'y' | 'z' | '-y', refit = true): void {
    if (this.upAxis === axis) return
    this.upAxis = axis
    if (refit && this.cloud) this.fitView()
    this.cameraDirty = true
  }

  get currentUpAxis(): 'y' | 'z' | '-y' {
    return this.upAxis
  }

  /** 重置到自动取景的机位 */
  resetView(): void {
    this.fitView()
    this.invalidate()
  }

  /** 开关深度排序 —— 关掉即可看到"顺序错 ⇒ 半透明雾"这个经典失效 */
  setSorting(enabled: boolean): void {
    this.sorting = enabled
    if (this.refs) {
      this.refs.sortButton.textContent = enabled ? '排序 开' : '排序 关'
      this.refs.sortButton.dataset.on = String(enabled)
    }
    this.cameraDirty = true
    this.hudDirty = true
  }

  // ───────────────────────────── 内部:DOM ─────────────────────────────

  private mount(): void {
    if (this.refs) {
      this.refs.root.hidden = false
      return
    }
    if (this.options.injectStyles !== false) ensureStyles()

    const root = document.createElement('div')
    root.className = 'dsv'
    root.tabIndex = -1
    root.hidden = false

    const mask = document.createElement('div')
    mask.className = 'dsv-mask'

    const frame = document.createElement('div')
    frame.className = 'dsv-frame'

    const bar = document.createElement('div')
    bar.className = 'dsv-bar'

    const title = document.createElement('span')
    title.className = 'dsv-title'
    title.textContent = this.options.title ?? 'Splat 场景'

    const hud = document.createElement('span')
    hud.className = 'dsv-hud'
    hud.textContent = '—'

    const spacer = document.createElement('span')
    spacer.className = 'dsv-spacer'

    const sortButton = document.createElement('button')
    sortButton.type = 'button'
    sortButton.className = 'dsv-btn dsv-sort'
    sortButton.textContent = '排序 开'
    sortButton.dataset.on = 'true'
    sortButton.addEventListener('click', () => this.setSorting(!this.sorting))

    const resetButton = document.createElement('button')
    resetButton.type = 'button'
    resetButton.className = 'dsv-btn dsv-reset'
    resetButton.textContent = '重置视角'
    resetButton.addEventListener('click', () => this.resetView())

    const importButton = document.createElement('button')
    importButton.type = 'button'
    importButton.className = 'dsv-btn dsv-import'
    importButton.textContent = '导入'
    importButton.hidden = !this.importable

    const actions = (this.options.extraActions ?? []).map((action) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `dsv-btn ${action.className ?? 'dsv-action'}`
      button.textContent = action.label
      button.addEventListener('click', action.onClick)
      return button
    })

    const closeButton = document.createElement('button')
    closeButton.type = 'button'
    closeButton.className = 'dsv-icon dsv-close'
    closeButton.title = '关闭'
    closeButton.textContent = '×'
    closeButton.addEventListener('click', () => this.close())

    const stage = document.createElement('div')
    stage.className = 'dsv-stage'

    const canvas = document.createElement('canvas')
    canvas.className = 'dsv-canvas'

    const note = document.createElement('p')
    note.className = 'dsv-note'

    const foot = document.createElement('div')
    foot.className = 'dsv-foot'
    foot.textContent =
      '拖拽旋转 · 滚轮缩放 · 右键/Shift 拖动平移 · R 重置 · Esc 关闭 · 可把 .ply / .splat 直接拖进来'

    const file = document.createElement('input')
    file.type = 'file'
    file.className = 'dsv-file'
    file.accept = '.ply,.splat'
    file.addEventListener('change', () => {
      const selected = file.files?.[0]
      if (selected) void this.loadFile(selected)
      file.value = ''
    })
    importButton.addEventListener('click', () => file.click())

    bar.append(title, hud, spacer, sortButton, resetButton, importButton, ...actions, closeButton)
    stage.append(canvas, note)
    frame.append(bar, stage, foot)
    root.append(mask, frame, file)
    document.body.appendChild(root)

    mask.addEventListener('click', () => this.close())
    this.bindStage(stage)
    window.addEventListener('keydown', this.onKeyDown, { capture: true })

    this.refs = { root, mask, stage, canvas, title, hud, note, sortButton, file }
    this.lockScroll()
    this.resize()
    this.tryCreateGpu()
  }

  private bindStage(stage: HTMLElement): void {
    stage.addEventListener('contextmenu', (event) => event.preventDefault())

    stage.addEventListener('pointerdown', (event) => {
      stage.dataset.dragging = 'true'
      capturePointer(stage, event.pointerId)
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      this.panButton = event.button === 1 || event.button === 2 || event.shiftKey || event.ctrlKey
      this.velocity.yaw = 0
      this.velocity.pitch = 0
      if (this.pointers.size === 2) this.pinchDistance = this.pinchSpan()
      event.preventDefault()
    })

    stage.addEventListener('pointermove', (event) => {
      const point = this.pointers.get(event.pointerId)
      if (!point) return
      const dx = event.clientX - point.x
      const dy = event.clientY - point.y
      point.x = event.clientX
      point.y = event.clientY

      if (this.pointers.size >= 2) {
        const span = this.pinchSpan()
        if (this.pinchDistance > 0 && span > 0) this.zoomBy(this.pinchDistance / span)
        this.pinchDistance = span
        this.panBy(dx / 2, dy / 2)
        return
      }

      if (this.panButton) {
        this.panBy(dx, dy)
        return
      }
      this.orbitBy(dx, dy)
      this.velocity.yaw = dx * 0.16
      this.velocity.pitch = dy * 0.16
    })

    const finish = (event: PointerEvent): void => {
      releasePointer(stage, event.pointerId)
      this.pointers.delete(event.pointerId)
      if (this.pointers.size === 0) {
        delete stage.dataset.dragging
        this.pinchDistance = 0
      }
    }
    stage.addEventListener('pointerup', finish)
    stage.addEventListener('pointercancel', finish)
    stage.addEventListener('pointerleave', (event) => {
      if (event.buttons === 0) finish(event)
    })

    stage.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        this.zoomBy(Math.exp(clamp(event.deltaY, -240, 240) * 0.0012))
      },
      { passive: false },
    )

    stage.addEventListener('dragover', (event) => {
      event.preventDefault()
      stage.dataset.dropping = 'true'
    })
    stage.addEventListener('dragleave', () => {
      delete stage.dataset.dropping
    })
    stage.addEventListener('drop', (event) => {
      event.preventDefault()
      delete stage.dataset.dropping
      const dropped = event.dataTransfer?.files?.[0]
      if (dropped) void this.loadFile(dropped)
    })
  }

  private pinchSpan(): number {
    const points = [...this.pointers.values()]
    const a = points[0]
    const b = points[1]
    if (!a || !b) return 0
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.isOpen) return
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        this.close()
        break
      case 'r':
      case 'R':
        event.preventDefault()
        this.resetView()
        break
      case 's':
      case 'S':
        event.preventDefault()
        this.setSorting(!this.sorting)
        break
      default:
        break
    }
    // 独占键盘:面板的键盘飞行挂在冒泡阶段,这里在捕获阶段截住
    event.stopPropagation()
  }

  private setTitle(text: string): void {
    if (this.refs) this.refs.title.textContent = text
  }

  private setNote(text: string, tone: 'info' | 'error' = 'info', autoHideMs = 0): void {
    const note = this.refs?.note
    if (!note) return
    note.textContent = text
    note.dataset.tone = tone
    note.hidden = text.length === 0
    if (autoHideMs > 0 && text.length > 0) {
      window.setTimeout(() => {
        if (this.refs?.note.textContent === text) this.refs.note.hidden = true
      }, autoHideMs)
    }
  }

  private fail(message: string): void {
    this.setNote(`打不开这份数据:${message}`, 'error')
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

  // ───────────────────────────── 内部:渲染 ─────────────────────────────

  private tryCreateGpu(): void {
    const refs = this.refs
    if (!refs) return
    const gl = refs.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    })
    if (!gl) {
      refs.canvas.hidden = true
      this.fail('这个浏览器不支持 WebGL2,splat 渲染需要它')
      return
    }
    this.gl = gl

    const program = this.createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER)
    if (!program) {
      refs.canvas.hidden = true
      this.fail('着色器编译失败,没法渲染 splat')
      return
    }

    const vao = gl.createVertexArray()
    const cornerBuffer = gl.createBuffer()
    const indexBuffer = gl.createBuffer()
    if (!vao || !cornerBuffer || !indexBuffer) {
      this.fail('WebGL 资源创建失败')
      return
    }

    gl.bindVertexArray(vao)
    // 两个三角形拼成的四边形,角点落在 ±1
    const corners = new Float32Array([
      -1, -1, 1, -1, -1, 1,
      1, -1, 1, 1, -1, 1,
    ])
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, 0)
    gl.vertexAttribDivisor(1, 1)
    gl.bindVertexArray(null)

    this.gpu = {
      program,
      vao,
      cornerBuffer,
      indexBuffer,
      textures: {
        center: this.createTexture(gl, 1, 1),
        scale: this.createTexture(gl, 1, 1),
        quat: this.createTexture(gl, 1, 1),
        color: this.createTexture(gl, 1, 1),
        width: 1,
        height: 1,
      },
      uniforms: {
        center: gl.getUniformLocation(program, 'uCenter'),
        scale: gl.getUniformLocation(program, 'uScale'),
        quat: gl.getUniformLocation(program, 'uQuat'),
        color: gl.getUniformLocation(program, 'uColor'),
        texWidth: gl.getUniformLocation(program, 'uTexWidth'),
        view: gl.getUniformLocation(program, 'uView'),
        viewport: gl.getUniformLocation(program, 'uViewport'),
        focal: gl.getUniformLocation(program, 'uFocalPx'),
        minVariance: gl.getUniformLocation(program, 'uMinVariance'),
        radiusSigma: gl.getUniformLocation(program, 'uRadiusSigma'),
        alphaCutoff: gl.getUniformLocation(program, 'uAlphaCutoff'),
      },
    }
    gl.clearColor(0.016, 0.02, 0.027, 1)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  private createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram | null {
    const compile = (type: number, source: string): WebGLShader | null => {
      const shader = gl.createShader(type)
      if (!shader) return null
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('[splat] shader', gl.getShaderInfoLog(shader))
        gl.deleteShader(shader)
        return null
      }
      return shader
    }
    const vs = compile(gl.VERTEX_SHADER, vertex)
    const fs = compile(gl.FRAGMENT_SHADER, fragment)
    if (!vs || !fs) return null
    const program = gl.createProgram()
    if (!program) return null
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[splat] link', gl.getProgramInfoLog(program))
      gl.deleteProgram(program)
      return null
    }
    return program
  }

  private createTexture(gl: WebGL2RenderingContext, width: number, height: number): WebGLTexture {
    const texture = gl.createTexture()
    if (!texture) throw new Error('纹理创建失败')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null)
    return texture
  }

  private uploadCloud(cloud: SplatCloud): void {
    const gl = this.gl
    const gpu = this.gpu
    if (!gl || !gpu) return

    const width = Math.min(TEX_WIDTH, cloud.count)
    const height = Math.ceil(cloud.count / width)
    const texels = width * height

    const centerData = new Float32Array(texels * 4)
    const scaleData = new Float32Array(texels * 4)
    const quatData = new Float32Array(texels * 4)
    const colorData = new Float32Array(texels * 4)
    for (let i = 0; i < cloud.count; i += 1) {
      centerData[i * 4] = cloud.center[i * 3] ?? 0
      centerData[i * 4 + 1] = cloud.center[i * 3 + 1] ?? 0
      centerData[i * 4 + 2] = cloud.center[i * 3 + 2] ?? 0
      centerData[i * 4 + 3] = cloud.rgba[i * 4 + 3] ?? 0

      scaleData[i * 4] = cloud.scale[i * 3] ?? 0
      scaleData[i * 4 + 1] = cloud.scale[i * 3 + 1] ?? 0
      scaleData[i * 4 + 2] = cloud.scale[i * 3 + 2] ?? 0

      quatData[i * 4] = cloud.rotation[i * 4] ?? 1
      quatData[i * 4 + 1] = cloud.rotation[i * 4 + 1] ?? 0
      quatData[i * 4 + 2] = cloud.rotation[i * 4 + 2] ?? 0
      quatData[i * 4 + 3] = cloud.rotation[i * 4 + 3] ?? 0

      colorData[i * 4] = cloud.rgba[i * 4] ?? 0
      colorData[i * 4 + 1] = cloud.rgba[i * 4 + 1] ?? 0
      colorData[i * 4 + 2] = cloud.rgba[i * 4 + 2] ?? 0
      colorData[i * 4 + 3] = 1
    }

    const targets: [WebGLTexture, Float32Array][] = [
      [gpu.textures.center, centerData],
      [gpu.textures.scale, scaleData],
      [gpu.textures.quat, quatData],
      [gpu.textures.color, colorData],
    ]
    for (const [texture, data] of targets) {
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data)
    }
    gpu.textures.width = width
    gpu.textures.height = height

    // 下标缓冲一次性扩到 count,之后每帧只 bufferSubData 前 count 个
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.indexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, cloud.count * 4, gl.DYNAMIC_DRAW)

    this.depths = new Float32Array(cloud.count)
    this.sorter.ensureCapacity(cloud.count)
    this.drawnCount = cloud.count
  }

  private resize(): void {
    const refs = this.refs
    const gl = this.gl
    if (!refs) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(refs.stage.clientWidth * dpr))
    const height = Math.max(1, Math.round(refs.stage.clientHeight * dpr))
    if (refs.canvas.width !== width || refs.canvas.height !== height) {
      refs.canvas.width = width
      refs.canvas.height = height
      this.invalidate()
    }
    gl?.viewport(0, 0, width, height)
  }

  private invalidate(): void {
    this.cameraDirty = true
  }

  private start(): void {
    if (this.rafId) return
    this.fpsWindowStart = performance.now()
    this.frameCount = 0
    this.rafId = window.requestAnimationFrame(this.frame)
    if (this.refs && !this.observer) {
      this.observer = new ResizeObserver(() => this.resize())
      this.observer.observe(this.refs.stage)
    }
  }

  private stop(): void {
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
    this.observer?.disconnect()
    this.observer = null
    window.removeEventListener('keydown', this.onKeyDown, { capture: true })
  }

  private readonly frame = (time: number): void => {
    this.rafId = window.requestAnimationFrame(this.frame)
    if (!this.isOpen) return

    this.stepInertia()

    const gl = this.gl
    const gpu = this.gpu
    if (!gl || !gpu || !this.cloud) {
      this.paintEmpty(gl)
      return
    }

    if (this.cameraDirty) {
      this.frameParity = (this.frameParity + 1) % 2
      if (!this.sortEveryOther || this.frameParity === 0) this.updateOrder()
      this.cameraDirty = false
    }
    this.draw(gl, gpu)

    this.frameCount += 1
    if (time - this.fpsWindowStart >= 500) {
      this.fps = (this.frameCount * 1000) / (time - this.fpsWindowStart)
      this.frameCount = 0
      this.fpsWindowStart = time
      this.hudDirty = true
    }
    if (this.hudDirty) {
      this.hudDirty = false
      this.updateHud()
    }
  }

  private paintEmpty(gl: WebGL2RenderingContext | null): void {
    if (!gl) return
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /** 逐条算深度并按远→近重排下标;排序开关关掉时用文件顺序(故意留的失效对照) */
  private updateOrder(): void {
    const gl = this.gl
    const gpu = this.gpu
    const cloud = this.cloud
    if (!gl || !gpu || !cloud) return

    const count = cloud.count
    if (!this.sorting) {
      if (this.identityOrder.length !== count) {
        const identity = new Uint32Array(count)
        for (let i = 0; i < count; i += 1) identity[i] = i
        this.identityOrder = identity
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.indexBuffer)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.identityOrder)
      this.sortMs = 0
      return
    }

    const started = performance.now()
    const [fx, fy, fz, eye] = this.forwardAndEye()
    const depths = this.depths.length >= count ? this.depths : (this.depths = new Float32Array(count))
    const center = cloud.center
    const offset = -(fx * eye[0] + fy * eye[1] + fz * eye[2])
    for (let i = 0; i < count; i += 1) {
      depths[i] = fx * (center[i * 3] ?? 0) + fy * (center[i * 3 + 1] ?? 0) + fz * (center[i * 3 + 2] ?? 0) + offset
    }
    const order = this.sorter.sort(depths, count)
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.indexBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, order)

    this.sortMs = performance.now() - started
    this.sortEveryOther = this.sortMs > SORT_BUDGET_MS
  }

  private draw(gl: WebGL2RenderingContext, gpu: SplatGpuState): void {
    const refs = this.refs
    if (!refs) return
    const width = refs.canvas.width
    const height = refs.canvas.height
    gl.viewport(0, 0, width, height)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const eye = this.eyePosition()
    const view = this.viewMatrix(eye)
    const focal = 0.5 * height / Math.tan((this.fov * DEG) / 2)

    gl.useProgram(gpu.program)
    gl.bindVertexArray(gpu.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, gpu.textures.center)
    gl.uniform1i(gpu.uniforms.center, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, gpu.textures.scale)
    gl.uniform1i(gpu.uniforms.scale, 1)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, gpu.textures.quat)
    gl.uniform1i(gpu.uniforms.quat, 2)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, gpu.textures.color)
    gl.uniform1i(gpu.uniforms.color, 3)

    gl.uniform1i(gpu.uniforms.texWidth, gpu.textures.width)
    gl.uniformMatrix4fv(gpu.uniforms.view, false, view)
    gl.uniform2f(gpu.uniforms.viewport, width, height)
    gl.uniform1f(gpu.uniforms.focal, focal)
    gl.uniform1f(gpu.uniforms.minVariance, MIN_VARIANCE)
    gl.uniform1f(gpu.uniforms.radiusSigma, RADIUS_SIGMA)
    gl.uniform1f(gpu.uniforms.alphaCutoff, this.alphaCutoff)

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.drawnCount)
    gl.bindVertexArray(null)
  }

  // ───────────────────────────── 内部:相机 ─────────────────────────────

  private fitView(): void {
    const cloud = this.cloud
    if (!cloud) return
    const bounds = cloud.bounds
    this.target = [bounds.center[0], bounds.center[1], bounds.center[2]]
    this.sceneRadius = Math.max(bounds.radius, 0.5)
    this.fov = DEFAULT_FOV_DEG
    this.yaw = 38
    // ⚠️ pitch 在本类里是「视线仰角」:正值 = 从下往上看。默认必须取负,
    // 否则 auto-fit 会把相机放到地面以下(实测 eye.y = target − sin28°·d ≈ −19m),
    // 带地面板的数据会被地面整片盖住 —— 而椭球双面可见,画面"看着还有模有样",极难察觉。
    this.pitch = -28
    this.distance = this.fitDistance(bounds)
    this.velocity.yaw = 0
    this.velocity.pitch = 0
    this.cameraDirty = true
  }

  /**
   * 按当前机位把包围盒的 8 个角投到相机的 right/up/forward 轴上,取「刚好装下」的距离。
   *
   * 包围球 fit(r / sin(fov/2))对平坦场景过于保守:60m 的地形斜着看在屏幕上只有二十几米高,
   * 画面四周一大圈黑。按视空间盒 fit 之后,同一份数据的占屏面积大约翻倍。
   */
  private fitDistance(bounds: { min: [number, number, number]; max: [number, number, number] }): number {
    const { right, up, forward } = this.basis()
    const center: [number, number, number] = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ]
    let halfRight = 0
    let halfUp = 0
    let halfForward = 0
    for (let i = 0; i < 8; i += 1) {
      const x = i & 1 ? bounds.max[0] : bounds.min[0]
      const y = i & 2 ? bounds.max[1] : bounds.min[1]
      const z = i & 4 ? bounds.max[2] : bounds.min[2]
      const dx = x - center[0]
      const dy = y - center[1]
      const dz = z - center[2]
      halfRight = Math.max(halfRight, Math.abs(right[0] * dx + right[1] * dy + right[2] * dz))
      halfUp = Math.max(halfUp, Math.abs(up[0] * dx + up[1] * dy + up[2] * dz))
      halfForward = Math.max(halfForward, Math.abs(forward[0] * dx + forward[1] * dy + forward[2] * dz))
    }
    const tanHalf = Math.tan((this.fov * DEG) / 2)
    const aspect = Math.max(
      (this.refs?.stage.clientWidth ?? 16) / Math.max(1, this.refs?.stage.clientHeight ?? 9),
      0.2,
    )
    const fit = Math.max(halfUp / tanHalf, halfRight / (tanHalf * aspect))
    return (fit + halfForward) * 1.06
  }

  private orbitBy(dx: number, dy: number): void {
    // 一屏高 ≈ 一个垂直视野:放得越大转得越慢,与真机手感一致
    const perPixel = (this.fov * DEG) / Math.max(1, this.refs?.stage.clientHeight ?? 1)
    this.yaw = normalizeDeg(this.yaw - (dx * perPixel) / DEG)
    // 下拖 = 相机升高、更俯视(three OrbitControls 同款手感),对应本类的视线仰角变小
    this.pitch = clamp(this.pitch - (dy * perPixel) / DEG, -MAX_PITCH_DEG, MAX_PITCH_DEG)
    this.cameraDirty = true
  }

  private panBy(dx: number, dy: number): void {
    const refs = this.refs
    if (!refs) return
    const height = Math.max(1, refs.stage.clientHeight)
    // 屏幕一像素对应的世界长度 = 2·d·tan(fov/2) / 画布高
    const perPixel = (2 * this.distance * Math.tan((this.fov * DEG) / 2)) / height
    const { right, up } = this.basis()
    this.target = [
      this.target[0] - right[0] * dx * perPixel + up[0] * dy * perPixel,
      this.target[1] - right[1] * dx * perPixel + up[1] * dy * perPixel,
      this.target[2] - right[2] * dx * perPixel + up[2] * dy * perPixel,
    ]
    this.cameraDirty = true
  }

  private zoomBy(factor: number): void {
    const min = this.sceneRadius * 0.02
    const max = this.sceneRadius * 40
    this.distance = clamp(this.distance * factor, min, max)
    this.cameraDirty = true
  }

  private stepInertia(): void {
    if (this.pointers.size > 0) return
    if (Math.abs(this.velocity.yaw) < 0.02 && Math.abs(this.velocity.pitch) < 0.02) return
    this.orbitBy(this.velocity.yaw, this.velocity.pitch)
    this.velocity.yaw *= 0.9
    this.velocity.pitch *= 0.9
  }

  private upVector(): [number, number, number] {
    if (this.upAxis === 'y') return [0, 1, 0]
    if (this.upAxis === '-y') return [0, -1, 0]
    return [0, 0, 1]
  }

  private eyePosition(): [number, number, number] {
    const { forward } = this.basis()
    // 从目标沿 -forward 退开 distance
    return [
      this.target[0] - forward[0] * this.distance,
      this.target[1] - forward[1] * this.distance,
      this.target[2] - forward[2] * this.distance,
    ]
  }

  /** 由 yaw / pitch 构造正交基;up 轴可切换(y 向上 / z 向上) */
  private basis(): {
    right: [number, number, number]
    up: [number, number, number]
    forward: [number, number, number]
  } {
    const yaw = this.yaw * DEG
    const pitch = this.pitch * DEG
    const cp = Math.cos(pitch)
    const sp = Math.sin(pitch)
    const sy = Math.sin(yaw)
    const cy = Math.cos(yaw)
    const up = this.upVector()

    let forward: [number, number, number]
    if (this.upAxis === 'y' || this.upAxis === '-y') {
      forward = [sy * cp, sp, cy * cp]
    } else {
      forward = [cp * cy, cp * sy, sp]
    }
    // right = forward × up(再归一化),up' = right × forward
    let right: [number, number, number] = [
      forward[1] * up[2] - forward[2] * up[1],
      forward[2] * up[0] - forward[0] * up[2],
      forward[0] * up[1] - forward[1] * up[0],
    ]
    const rightLength = Math.hypot(right[0], right[1], right[2]) || 1
    right = [right[0] / rightLength, right[1] / rightLength, right[2] / rightLength]
    const correctedUp: [number, number, number] = [
      right[1] * forward[2] - right[2] * forward[1],
      right[2] * forward[0] - right[0] * forward[2],
      right[0] * forward[1] - right[1] * forward[0],
    ]
    return { right, up: correctedUp, forward }
  }

  /** 列主序 4×4 视图矩阵(与 three 的 lookAt 同一约定) */
  private viewMatrix(eye: [number, number, number]): Float32Array {
    const { right, up, forward } = this.basis()
    const out = new Float32Array(16)
    out[0] = right[0]
    out[1] = up[0]
    out[2] = -forward[0]
    out[3] = 0
    out[4] = right[1]
    out[5] = up[1]
    out[6] = -forward[1]
    out[7] = 0
    out[8] = right[2]
    out[9] = up[2]
    out[10] = -forward[2]
    out[11] = 0
    out[12] = -(right[0] * eye[0] + right[1] * eye[1] + right[2] * eye[2])
    out[13] = -(up[0] * eye[0] + up[1] * eye[1] + up[2] * eye[2])
    out[14] = forward[0] * eye[0] + forward[1] * eye[1] + forward[2] * eye[2]
    out[15] = 1
    return out
  }

  private forwardAndEye(): [
    number,
    number,
    number,
    [number, number, number],
  ] {
    const { forward } = this.basis()
    return [forward[0], forward[1], forward[2], this.eyePosition()]
  }

  private updateHud(): void {
    const refs = this.refs
    if (!refs) return
    const cloud = this.cloud
    if (!cloud) {
      refs.hud.textContent = '—'
      return
    }
    const sortText = this.sorting ? `${this.sortMs.toFixed(1)}ms` : '关闭'
    refs.hud.textContent = `${formatCount(cloud.count)} splats · ${Math.round(this.fps)} fps · 排序 ${sortText}`
  }

  private releaseGpu(): void {
    const gl = this.gl
    const gpu = this.gpu
    if (gl && gpu) {
      gl.deleteBuffer(gpu.cornerBuffer)
      gl.deleteBuffer(gpu.indexBuffer)
      gl.deleteVertexArray(gpu.vao)
      gl.deleteProgram(gpu.program)
      for (const texture of [
        gpu.textures.center,
        gpu.textures.scale,
        gpu.textures.quat,
        gpu.textures.color,
      ]) {
        gl.deleteTexture(texture)
      }
    }
    this.gl = null
    this.gpu = null
  }
}
