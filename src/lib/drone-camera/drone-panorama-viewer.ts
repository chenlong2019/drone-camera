/**
 * 全景查看器(原生 DOM + 手写 WebGL):把等距柱状全景图**贴回球面**拖动环视 ——
 * 一张平面的长条图,在这里变成能看四面八方的"球形照片"(真机相册里点开全景图的那种体验)。
 *
 * 为什么需要它:等距柱状图(2:1 长条)是全景的**存储格式**,不是**观看格式**。
 * 一张 3600×1800 的条带摊在屏幕上看不出"四面八方";只要把它沿球面反投影,同一个文件
 * 立刻变成可自由环视的球面 —— 这正是 DJI 相册打开球面全景时的做法。
 *
 * 三处刻意的设计:
 *
 * 1. **手写 WebGL,而不是引 three**。three 是库的 peerDependency,但影像集/查看器这一层
 *    是"与渲染后端无关"的纯 DOM 模块(Cesium 宿主也在用)。为了看一张全景图把整个 three
 *    拖进这条链路并不划算 —— 整件事只需要一个全屏三角形 + 一段反投影的片元着色器,
 *    没有几何体、没有光照、没有材质。
 *
 * 2. **反投影用与 drone-stitch 完全相同的球面基**,两端必须同源才对得上:
 *      forward(θ,φ) = [sinθ·cosφ, sinφ, -cosθ·cosφ]   θ 向右增、φ 为绝对仰角(天顶 +90°)
 *      u = (θ - thetaStart) / spanTheta, v = (phiTop - φ) / spanPhi
 *    合成时是"球面方向 → 等距柱状像素",这里是"屏幕像素 → 球面方向 → 等距柱状像素"。
 *    相机基 {right, up, forward} 由 θ/φ 直接构造(right = forward × ∂forward/∂φ,推导见
 *    `cameraBasis`),于是**拖动只是改两个标量**,没有欧拉角奇点、不用四元数/矩阵库。
 *
 * 3. **挂 `document.body` + 键盘走 window 捕获阶段**(与影像集、大图弹窗同一套约定):
 *    面板的 `backdrop-filter` 会为 `position: fixed` 的后代换包含块;而面板的键盘飞行监听
 *    挂在冒泡阶段,弹窗开着时按方向键必须只环视、绝不顺带把无人机飞出去。
 *
 * ```ts
 * const viewer = new DronePanoramaViewer()
 * viewer.open(result.url, '合成全景图')   // 也接受合成结果对象
 * viewer.close()                          // destroy() 彻底卸载
 * ```
 */
import type { PanoramaStitchResult } from './drone-panorama'
import { triggerDownload } from './drone-image-utils'

/** 全景查看器构造选项 */
export interface DronePanoramaViewerOptions {
  /** 是否注入自带样式,默认 true */
  injectStyles?: boolean
  /** 弹窗层级,默认 1100(排在影像集弹窗之上) */
  zIndex?: number
  /** 初始朝向(方位角,度),默认 0 = 输出图正中(即该组的起始航向) */
  initialYawDeg?: number
  /** 初始仰角(度),默认 0 = 平视 */
  initialPitchDeg?: number
  /** 初始垂直视野角(度),默认 75 */
  initialFovDeg?: number
  /** 垂直视野角上下限,默认 25 ~ 110 */
  minFovDeg?: number
  maxFovDeg?: number
  /** 是否提供「下载原图」按钮,默认 true */
  downloadable?: boolean
  /**
   * 是否提供「导入图片」按钮(从本地选一张等距柱状全景图看球面),默认 false。
   * 影像集弹窗里已有自己的入口,那里不需要;独立打开的查看器(比如 demo 页的按钮)开着才方便。
   */
  importable?: boolean
  /** 关闭回调(点 × / 点遮罩 / Esc) */
  onClose?: () => void
}

interface ViewerRefs {
  mask: HTMLElement
  stage: HTMLElement
  canvas: HTMLCanvasElement
  title: HTMLElement
  hud: HTMLElement
  note: HTMLElement
  download: HTMLButtonElement
  file: HTMLInputElement
}

interface Uniforms {
  texture: WebGLUniformLocation | null
  tanHalf: WebGLUniformLocation | null
  aspect: WebGLUniformLocation | null
  right: WebGLUniformLocation | null
  up: WebGLUniformLocation | null
  forward: WebGLUniformLocation | null
  thetaStart: WebGLUniformLocation | null
  spanTheta: WebGLUniformLocation | null
  phiTop: WebGLUniformLocation | null
  spanPhi: WebGLUniformLocation | null
  wrap: WebGLUniformLocation | null
  textureWidth: WebGLUniformLocation | null
}

interface Program {
  program: WebGLProgram
  buffer: WebGLBuffer
  texture: WebGLTexture
  uniforms: Uniforms
}

const STYLE_ID = 'drone-panorama-viewer-styles'
const DEFAULT_Z_INDEX = 1100
const DEG = Math.PI / 180
/** 滚轮一格(约 100 deltaY)对应的视野倍率手感系数 */
const WHEEL_ZOOM_RATE = 0.0015
/** 松手后的惯性衰减(每帧乘这个系数)与停下的阈值(度/帧) */
const INERTIA_DECAY = 0.9
const INERTIA_MIN = 0.03
/** 仰角上限略小于 90°,免得在极点附近翻滚 */
const MAX_PITCH_DEG = 89
const DEFAULT_FOV_DEG = 75
const DEFAULT_MIN_FOV_DEG = 25
const DEFAULT_MAX_FOV_DEG = 110
/** 全景图默认覆盖整颗球:输出图最左列 = 方位 -180°,最上行 = 仰角 +90° */
const SPHERE_THETA_START_DEG = -180
const SPHERE_SPAN_THETA_DEG = 360
const SPHERE_PHI_TOP_DEG = 90
const SPHERE_SPAN_PHI_DEG = 180
const DEFAULT_PROJECTION = {
  thetaStart: SPHERE_THETA_START_DEG,
  spanTheta: SPHERE_SPAN_THETA_DEG,
  phiTop: SPHERE_PHI_TOP_DEG,
  spanPhi: SPHERE_SPAN_PHI_DEG,
  wrapsTheta: true,
}

/**
 * 全屏三角形的顶点着色器:不需要任何几何体 —— 相机射线在片元着色器里按屏幕坐标现算。
 * 输出 `vUv` 覆盖 [0,1]²(左上角 = 屏幕左上角)。
 */
const VERTEX_SHADER = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

/**
 * 反投影:屏幕像素 → 相机射线 → 球面方位/仰角 → 等距柱状 UV。
 *
 * 球面基与 drone-stitch 逐字一致(见模块头注释 2),`uWrap` 为 1 时方位在接缝处回绕
 * (整球输出),为 0 时钳制(非整圈的带状输出)。
 */
const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uTanHalf;
uniform float uAspect;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform float uThetaStart;
uniform float uSpanTheta;
uniform float uPhiTop;
uniform float uSpanPhi;
uniform float uWrap;
uniform float uTextureWidth;
const float PI = 3.141592653589793;

vec4 sampleWrappedTexture(float u, float v) {
  float texel = u * uTextureWidth - 0.5;
  float texel0 = floor(texel);
  float blend = fract(texel);
  float x0 = mix(clamp(texel0, 0.0, uTextureWidth - 1.0), mod(texel0, uTextureWidth), uWrap);
  float x1 = mix(clamp(texel0 + 1.0, 0.0, uTextureWidth - 1.0), mod(texel0 + 1.0, uTextureWidth), uWrap);
  float u0 = (x0 + 0.5) / uTextureWidth;
  float u1 = (x1 + 0.5) / uTextureWidth;
  return mix(texture2D(uTex, vec2(u0, v)), texture2D(uTex, vec2(u1, v)), blend);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 dir = normalize(uRight * (ndc.x * uTanHalf * uAspect) + uUp * (ndc.y * uTanHalf) + uForward);
  float phi = asin(clamp(dir.y, -1.0, 1.0)) / PI * 180.0;
  float theta = atan(dir.x, -dir.z) / PI * 180.0;
  float u = (theta - uThetaStart) / uSpanTheta;
  u = mix(clamp(u, 0.0, 1.0), fract(u), uWrap);
  float v = clamp((uPhiTop - phi) / uSpanPhi, 0.0, 1.0);
  gl_FragColor = sampleWrappedTexture(u, v);
}
`

const VIEWER_CSS = `
.divp {
  --divp-text: #e9eff9;
  --divp-muted: rgba(233, 239, 249, 0.58);
  --divp-border: rgba(255, 255, 255, 0.12);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.divp {
  position: fixed; inset: 0; z-index: ${DEFAULT_Z_INDEX};
  display: flex; align-items: center; justify-content: center;
  padding: max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom));
  color: var(--divp-text);
  outline: none;
}
.divp[hidden] { display: none; }
.divp-mask {
  position: absolute; inset: 0; background: rgba(3, 5, 8, 0.96);
  -webkit-backdrop-filter: blur(7px); backdrop-filter: blur(7px);
}
.divp-frame {
  position: relative; z-index: 1;
  display: flex; flex-direction: column;
  width: min(100%, 1420px); height: 100%; overflow: hidden;
  border: 1px solid var(--divp-border); border-radius: 12px;
  background: rgba(10, 13, 19, 0.96);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
}
.divp-bar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-bottom: 1px solid var(--divp-border);
}
.divp-title { font-weight: 600; }
.divp-hud { color: var(--divp-muted); font-variant-numeric: tabular-nums; }
.divp-spacer { flex: 1; min-width: 4px; }
.divp-btn {
  flex: 0 0 auto; min-height: 26px; padding: 3px 10px; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--divp-border); border-radius: 7px;
  background: rgba(255, 255, 255, 0.06); color: var(--divp-text); font: inherit; font-size: 12px;
}
.divp-btn:hover { background: rgba(255, 255, 255, 0.14); }
.divp-btn[hidden] { display: none; }
.divp-icon {
  flex: 0 0 auto; width: 26px; height: 26px; padding: 0; cursor: pointer;
  border: 1px solid var(--divp-border); border-radius: 7px;
  background: rgba(255, 255, 255, 0.06); color: var(--divp-text); font: inherit; line-height: 1;
}
.divp-icon:hover { background: rgba(255, 255, 255, 0.14); }
.divp-stage {
  position: relative; flex: 1; min-height: 0; overflow: hidden;
  background: radial-gradient(circle at 50% 45%, #0a1018, #04060a 70%);
  touch-action: none; cursor: grab;
}
.divp-stage[data-dragging="true"] { cursor: grabbing; }
.divp-canvas { display: block; width: 100%; height: 100%; }
.divp-canvas[hidden] { display: none; }
.divp-note {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  margin: 0; padding: 14px 18px; max-width: 80%;
  border: 1px solid var(--divp-border); border-radius: 10px;
  background: rgba(10, 14, 20, 0.9); color: var(--divp-muted); text-align: center;
}
.divp-note[hidden] { display: none; }
.divp-foot {
  flex: 0 0 auto; padding: 6px 10px; border-top: 1px solid var(--divp-border);
  color: var(--divp-muted); font-size: 11px;
}
@media (pointer: coarse) {
  .divp-icon { width: 32px; height: 32px; }
  .divp-btn { min-height: 32px; }
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

/**
 * 由方位角 / 仰角构造相机的正交基。
 *
 * 用与 drone-stitch 同一套球面参数:
 *   forward(θ,φ) = [sinθ·cosφ, sinφ, -cosθ·cosφ]
 *   up(θ,φ)      = ∂forward/∂φ = [-sinθ·sinφ, cosφ, cosθ·sinφ]
 *   right        = forward × up = [cosθ, 0, sinθ]   ← 与仰角无关,始终水平
 * 三者两两正交(right·up = 0、forward·up = 0),所以屏幕射线直接线性组合即可,
 * 不必过一遍旋转矩阵,也不会在极点附近遇到万向节问题。
 */
function cameraBasis(yawDeg: number, pitchDeg: number): {
  forward: [number, number, number]
  up: [number, number, number]
  right: [number, number, number]
} {
  const theta = yawDeg * DEG
  const phi = pitchDeg * DEG
  const ct = Math.cos(theta)
  const st = Math.sin(theta)
  const cp = Math.cos(phi)
  const sp = Math.sin(phi)
  return {
    forward: [st * cp, sp, -ct * cp],
    up: [-st * sp, cp, ct * sp],
    right: [ct, 0, st],
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function resolveFov(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return clamp(value, min, max)
}

/** 把角度规整到 [0, 360) —— HUD 上的方位读数 */
function normalizeDeg(value: number): number {
  return ((value % 360) + 360) % 360
}

/**
 * 全景查看器:一张带有球面投影范围的等距柱状图 + 可拖动环视的球面局部或整球。
 *
 * DOM **懒挂载**:构造只记住选项,首次 `open()` 才建节点、注入样式、建 WebGL 上下文;
 * `close()` 把整棵 DOM 与 GL 资源一并拆掉,于是"没打开"时它对页面零影响。
 */
export class DronePanoramaViewer {
  private readonly options: DronePanoramaViewerOptions
  private readonly minFov: number
  private readonly maxFov: number
  private root: HTMLDivElement | null = null
  private refs: ViewerRefs | null = null
  private program: Program | null = null
  private gl: WebGLRenderingContext | null = null
  private observer: ResizeObserver | null = null
  private source = ''
  private fileName = 'panorama.png'
  /** 导入的本地文件对应的 blob 地址(换图 / destroy 时 revoke;close 不 revoke,重开要复用) */
  private importUrl: string | null = null
  /** 导入文件的文件名(重开时用作标题) */
  private importName = ''
  private image: HTMLImageElement | null = null
  private projection = { ...DEFAULT_PROJECTION }
  /** 图片加载序号:onload 回调是异步的,换图 / 关闭后旧回调必须作废 */
  private loadSeq = 0
  private ready = false
  /** 视角状态:两个标量就能完全描述朝向 */
  private yaw = 0
  private pitch = 0
  private fov = DEFAULT_FOV_DEG
  private readonly velocity = { yaw: 0, pitch: 0 }
  private readonly pointers = new Map<number, { x: number; y: number }>()
  private lastPointer: { x: number; y: number } | null = null
  private pinchDistance = 0
  private rafId = 0
  private dirty = true
  private bodyOverflow = ''
  private destroyed = false

  /** 构造球面全景查看器(手写 WebGL 零依赖;可传初始角与导入开关) */
  constructor(options: DronePanoramaViewerOptions = {}) {
    this.options = options
    this.minFov = resolveFov(options.minFovDeg ?? DEFAULT_MIN_FOV_DEG, 5, 170, DEFAULT_MIN_FOV_DEG)
    this.maxFov = resolveFov(options.maxFovDeg ?? DEFAULT_MAX_FOV_DEG, this.minFov, 170, DEFAULT_MAX_FOV_DEG)
    this.yaw = options.initialYawDeg ?? 0
    this.pitch = clamp(options.initialPitchDeg ?? 0, -MAX_PITCH_DEG, MAX_PITCH_DEG)
    this.fov = clamp(options.initialFovDeg ?? DEFAULT_FOV_DEG, this.minFov, this.maxFov)
  }

  /** 弹窗当前是否打开 */
  get isOpen(): boolean {
    return this.root !== null && !this.root.hidden
  }

  /** 当前朝向(度),便于宿主做联动 */
  get view(): { yaw: number; pitch: number; fov: number } {
    return { yaw: this.yaw, pitch: this.pitch, fov: this.fov }
  }

  /**
   * 打开弹窗;`source` 是等距柱状全景图的地址(data URL / blob / http 均可)。
   * 不传 = 只开一个"导入"入口(配 `importable` 用),选了图再进来。
   */
  open(source?: string | PanoramaStitchResult, title?: string): void {
    if (this.destroyed) return
    this.mount()
    const root = this.root
    if (!root || !this.refs) return
    if (!source) {
      // 无图打开:导入过就还看上次那张(关闭不该弄丢用户的图),没导入过才给"去导入"空态
      if (this.importUrl) {
        this.source = this.importUrl
        this.projection = { ...DEFAULT_PROJECTION }
        this.refs.title.textContent = this.importName || '360° 全景'
        root.hidden = false
        this.lockScroll()
        this.reset()
        this.loadImage(this.importUrl)
        root.focus()
        return
      }
      this.source = ''
      this.image = null
      this.ready = false
      this.refs.title.textContent = title ?? '360° 全景'
      root.hidden = false
      this.lockScroll()
      this.reset()
      this.invalidate()
      this.setNote('还没有全景图 —— 点右上「导入图片」,选一张等距柱状全景图(2:1 长条)。')
      root.focus()
      return
    }
    const url = typeof source === 'string' ? source : source.url
    if (!url) return
    this.source = url
    this.projection =
      typeof source === 'string'
        ? { ...DEFAULT_PROJECTION }
        : { ...DEFAULT_PROJECTION, ...source.equirectangular }
    const name = typeof source === 'string' ? title : title ?? source.name
    this.fileName = name && /\.\w{2,5}$/.test(name) ? name : `${this.slug(name ?? 'panorama')}.png`
    this.refs.title.textContent = name ?? '全景图'
    root.hidden = false
    this.lockScroll()
    this.reset()
    this.loadImage(url)
    root.focus()
  }

  /** 关闭弹窗(整个卸载 DOM 并释放 GL 资源) */
  close(): void {
    if (!this.root) return
    const wasOpen = !this.root.hidden
    this.unmount()
    if (wasOpen) this.options.onClose?.()
  }

  /** 视角复位到初始状态 */
  reset(): void {
    this.yaw = this.options.initialYawDeg ?? 0
    this.pitch = clamp(this.options.initialPitchDeg ?? 0, -MAX_PITCH_DEG, MAX_PITCH_DEG)
    this.fov = clamp(this.options.initialFovDeg ?? DEFAULT_FOV_DEG, this.minFov, this.maxFov)
    this.velocity.yaw = 0
    this.velocity.pitch = 0
    this.invalidate()
  }

  /** 下载当前这张全景原图 */
  download(): void {
    if (!this.source) return
    triggerDownload(this.source, this.fileName)
  }

  /** 关闭弹窗并释放 GL 资源与 blob 地址 */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.unmount()
    if (this.importUrl) {
      URL.revokeObjectURL(this.importUrl)
      this.importUrl = null
    }
    if (this.options.injectStyles !== false) document.getElementById(STYLE_ID)?.remove()
  }

  // ───────────────────────────── 内部:生命周期 ─────────────────────────────

  private mount(): void {
    if (this.root || typeof document === 'undefined') return
    if (this.options.injectStyles !== false) ensureStyles()

    const root = document.createElement('div')
    root.className = 'divp'
    root.hidden = true
    root.tabIndex = -1
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-label', '全景查看')
    if (this.options.zIndex && this.options.zIndex !== DEFAULT_Z_INDEX) {
      root.style.zIndex = String(this.options.zIndex)
    }
    root.innerHTML = this.template()
    document.body.appendChild(root)
    this.root = root
    this.refs = {
      mask: this.query('[data-role="mask"]'),
      stage: this.query('[data-role="stage"]'),
      canvas: this.query<HTMLCanvasElement>('[data-role="canvas"]'),
      title: this.query('[data-role="title"]'),
      hud: this.query('[data-role="hud"]'),
      note: this.query('[data-role="note"]'),
      download: this.query<HTMLButtonElement>('[data-action="download"]'),
      file: this.query<HTMLInputElement>('[data-role="file"]'),
    }
    this.refs.file.addEventListener('change', this.onImportFile)

    root.addEventListener('click', this.onClick)
    const stage = this.refs.stage
    stage.addEventListener('pointerdown', this.onPointerDown)
    stage.addEventListener('pointermove', this.onPointerMove)
    stage.addEventListener('pointerup', this.onPointerUp)
    stage.addEventListener('pointercancel', this.onPointerUp)
    stage.addEventListener('wheel', this.onWheel, { passive: false })
    stage.addEventListener('dblclick', this.onDoubleClick)
    // 捕获阶段接管键盘,才能压住面板挂在冒泡阶段的键盘飞行(见模块头注释 3)
    window.addEventListener('keydown', this.onKeyDown, { capture: true })

    const gl = this.createContext()
    if (!gl) {
      this.refs.canvas.hidden = true
      this.setNote('这个浏览器不支持 WebGL,没法把全景贴到球面上 —— 已回退成平面长图。')
      this.fallbackImage()
    } else if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.syncSize())
      this.observer.observe(stage)
    }
  }

  private unmount(): void {
    window.removeEventListener('keydown', this.onKeyDown, { capture: true })
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
    this.observer?.disconnect()
    this.observer = null
    this.image = null
    this.pointers.clear()
    this.lastPointer = null
    this.pinchDistance = 0
    this.disposeGL()
    this.root?.remove()
    this.root = null
    this.refs = null
    this.ready = false
    this.unlockScroll()
  }

  // ───────────────────────────── 内部:WebGL ─────────────────────────────

  private createContext(): WebGLRenderingContext | null {
    const canvas = this.refs?.canvas
    if (!canvas) return null
    const gl =
      (canvas.getContext('webgl', { alpha: false, antialias: false }) as WebGLRenderingContext | null) ??
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null)
    if (!gl) return null
    this.gl = gl

    const program = this.buildProgram(gl)
    if (!program) {
      this.gl = null
      return null
    }
    this.program = program

    // 图片不是 2 次幂,只能 CLAMP_TO_EDGE;shader 在接缝处显式跨首尾做线性采样。
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.clearColor(0.02, 0.03, 0.05, 1)

    canvas.addEventListener('webglcontextlost', this.onContextLost)
    canvas.addEventListener('webglcontextrestored', this.onContextRestored)
    this.syncSize()
    return gl
  }

  private buildProgram(gl: WebGLRenderingContext): Program | null {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    if (!vertex || !fragment) return null
    const program = gl.createProgram()
    const buffer = gl.createBuffer()
    const texture = gl.createTexture()
    if (!program || !buffer || !texture) return null
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program)
      return null
    }
    gl.useProgram(program)

    // 两个三角形铺满裁剪空间;它们的 uv 由顶点着色器线性插值成屏幕坐标
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1])
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0)

    return {
      program,
      buffer,
      texture,
      uniforms: {
        texture: gl.getUniformLocation(program, 'uTex'),
        tanHalf: gl.getUniformLocation(program, 'uTanHalf'),
        aspect: gl.getUniformLocation(program, 'uAspect'),
        right: gl.getUniformLocation(program, 'uRight'),
        up: gl.getUniformLocation(program, 'uUp'),
        forward: gl.getUniformLocation(program, 'uForward'),
        thetaStart: gl.getUniformLocation(program, 'uThetaStart'),
        spanTheta: gl.getUniformLocation(program, 'uSpanTheta'),
        phiTop: gl.getUniformLocation(program, 'uPhiTop'),
        spanPhi: gl.getUniformLocation(program, 'uSpanPhi'),
        wrap: gl.getUniformLocation(program, 'uWrap'),
        textureWidth: gl.getUniformLocation(program, 'uTextureWidth'),
      },
    }
  }

  private disposeGL(): void {
    const gl = this.gl
    const program = this.program
    this.program = null
    this.gl = null
    if (!gl) return
    this.refs?.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    this.refs?.canvas.removeEventListener('webglcontextrestored', this.onContextRestored)
    if (program) {
      gl.deleteTexture(program.texture)
      gl.deleteBuffer(program.buffer)
      gl.deleteProgram(program.program)
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault()
    this.ready = false
  }

  private readonly onContextRestored = (): void => {
    this.ready = false
    this.program = null
    this.gl = null
    const gl = this.createContext()
    if (gl && this.image) this.uploadTexture(this.image)
  }

  /** 把图片上传成纹理并开始渲染 */
  private loadImage(url: string): void {
    this.ready = false
    const seq = ++this.loadSeq
    if (this.gl) {
      this.refs?.canvas.removeAttribute('hidden')
      this.setNote('正在把全景图贴上球面…')
    }
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      // 序号不匹配 = 打开期间换过图或已关闭,这次加载作废
      if (this.destroyed || !this.root || seq !== this.loadSeq) return
      this.image = image
      if (this.gl && this.program) {
        this.uploadTexture(image)
        this.refs?.note.setAttribute('hidden', '')
      } else {
        this.fallbackImage()
      }
    }
    image.onerror = () => {
      if (seq !== this.loadSeq) return
      this.setNote('全景图加载失败(地址可能已失效)。')
    }
    image.src = url
  }

  private uploadTexture(image: HTMLImageElement): void {
    const gl = this.gl
    const program = this.program
    if (!gl || !program) return
    gl.bindTexture(gl.TEXTURE_2D, program.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.useProgram(program.program)
    gl.uniform1f(program.uniforms.textureWidth, image.naturalWidth || image.width)
    this.ready = true
    this.invalidate()
  }

  /** 没有 WebGL 时的退路:直接把等距柱状长图铺出来(至少能看) */
  private fallbackImage(): void {
    const refs = this.refs
    if (!refs || !this.source) return
    refs.canvas.hidden = true
    const img = document.createElement('img')
    img.src = this.source
    img.alt = '全景图'
    img.style.cssText = 'position:absolute;inset:0;margin:auto;max-width:100%;max-height:100%;object-fit:contain;'
    refs.stage.appendChild(img)
  }

  private setNote(text: string): void {
    const refs = this.refs
    if (!refs) return
    refs.note.textContent = text
    refs.note.removeAttribute('hidden')
  }

  private syncSize(): void {
    const canvas = this.refs?.canvas
    const stage = this.refs?.stage
    if (!canvas || !stage) return
    const dpr = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(stage.clientWidth * dpr))
    const height = Math.max(1, Math.round(stage.clientHeight * dpr))
    if (canvas.width === width && canvas.height === height) return
    canvas.width = width
    canvas.height = height
    this.invalidate()
  }

  private invalidate(): void {
    this.dirty = true
    this.schedule()
  }

  private schedule(): void {
    if (this.rafId || this.destroyed) return
    if (this.refs && this.root?.hidden) return
    this.rafId = window.requestAnimationFrame(this.onFrame)
  }

  private readonly onFrame = (): void => {
    this.rafId = 0
    const v = this.velocity
    if (Math.abs(v.yaw) > INERTIA_MIN || Math.abs(v.pitch) > INERTIA_MIN) {
      this.yaw += v.yaw
      this.pitch = clamp(this.pitch + v.pitch, -MAX_PITCH_DEG, MAX_PITCH_DEG)
      v.yaw *= INERTIA_DECAY
      v.pitch *= INERTIA_DECAY
      this.dirty = true
      this.schedule()
    } else {
      v.yaw = 0
      v.pitch = 0
    }
    if (!this.dirty) return
    this.dirty = false
    this.draw()
  }

  private draw(): void {
    const gl = this.gl
    const program = this.program
    const canvas = this.refs?.canvas
    if (!gl || !program || !canvas) return
    if (!canvas.width || !canvas.height) return
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (!this.ready) {
      this.updateHud()
      return
    }
    const basis = cameraBasis(this.yaw, this.pitch)
    const u = program.uniforms
    gl.uniform1f(u.tanHalf, Math.tan((this.fov * DEG) / 2))
    gl.uniform1f(u.aspect, canvas.width / canvas.height)
    gl.uniform3f(u.right, basis.right[0], basis.right[1], basis.right[2])
    gl.uniform3f(u.up, basis.up[0], basis.up[1], basis.up[2])
    gl.uniform3f(u.forward, basis.forward[0], basis.forward[1], basis.forward[2])
    gl.uniform1f(u.thetaStart, this.projection.thetaStart)
    gl.uniform1f(u.spanTheta, this.projection.spanTheta)
    gl.uniform1f(u.phiTop, this.projection.phiTop)
    gl.uniform1f(u.spanPhi, this.projection.spanPhi)
    gl.uniform1f(u.wrap, this.projection.wrapsTheta ? 1 : 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    this.updateHud()
  }

  private updateHud(): void {
    const hud = this.refs?.hud
    if (!hud) return
    hud.textContent =
      `方位 ${Math.round(normalizeDeg(this.yaw))}° · 仰角 ${Math.round(this.pitch)}° · ` +
      `视野 ${Math.round(this.fov)}°`
  }

  // ───────────────────────────── 内部:交互 ─────────────────────────────

  /** 用户从本地选了一张全景图:转 blob 地址喂给查看器(旧导入的地址一并释放) */
  private readonly onImportFile = (event: Event): void => {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = '' // 允许下次再选同一张(change 不触发的问题)
    if (!file) return
    if (this.importUrl) URL.revokeObjectURL(this.importUrl)
    this.importUrl = URL.createObjectURL(file)
    this.importName = file.name
    this.open(this.importUrl, file.name)
  }

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null
    const actionEl = target?.closest<HTMLElement>('[data-action]')
    switch (actionEl?.dataset.action) {
      case 'close':
        this.close()
        return
      case 'reset':
        this.reset()
        return
      case 'download':
        this.download()
        return
      case 'import':
        this.refs?.file.click()
        return
      default:
        break
    }
    // 只有点遮罩(而不是画面)才关,免得想细看的人一拖就被弹出去
    if (target === this.root || target === this.refs?.mask) this.close()
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    const target = event.target as HTMLElement | null
    if (target?.closest('[data-action]')) return
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    try {
      this.refs?.stage.setPointerCapture(event.pointerId)
    } catch {
      /* 不支持 pointer capture 的环境忽略 */
    }
    this.velocity.yaw = 0
    this.velocity.pitch = 0
    if (this.pointers.size === 1) {
      this.lastPointer = { x: event.clientX, y: event.clientY }
    } else {
      this.lastPointer = null
      this.pinchDistance = this.currentPinchDistance()
    }
    this.refs?.stage.setAttribute('data-dragging', 'true')
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return
    const previous = this.pointers.get(event.pointerId)
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (this.pointers.size >= 2) {
      // 双指:距离变化 = 缩放视野,中点位移 = 继续平移
      const distance = this.currentPinchDistance()
      if (this.pinchDistance > 0 && distance > 0) {
        this.zoomBy(this.pinchDistance / distance)
      }
      this.pinchDistance = distance
      if (previous) {
        this.rotateBy((event.clientX - previous.x) * 0.5, (event.clientY - previous.y) * 0.5, true)
      }
      return
    }

    const last = this.lastPointer
    if (!last) return
    const dx = event.clientX - last.x
    const dy = event.clientY - last.y
    this.lastPointer = { x: event.clientX, y: event.clientY }
    this.rotateBy(dx, dy, false)
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return
    this.pointers.delete(event.pointerId)
    if (this.pointers.size === 1) {
      const remaining = this.pointers.values().next().value
      this.lastPointer = remaining ? { x: remaining.x, y: remaining.y } : null
      this.pinchDistance = 0
    } else if (this.pointers.size === 0) {
      this.lastPointer = null
      this.pinchDistance = 0
      this.refs?.stage.removeAttribute('data-dragging')
    }
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    this.velocity.yaw = 0
    this.velocity.pitch = 0
    // 向上滚(deltaY < 0)= 视野收窄 = 放大;指数映射让每一格滚轮的"倍率"恒定
    this.zoomBy(Math.exp(event.deltaY * WHEEL_ZOOM_RATE))
  }

  private readonly onDoubleClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null
    if (target?.closest('[data-action]')) return
    this.reset()
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.destroyed || !this.root || this.root.hidden) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const step = event.shiftKey ? 15 : 5
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        this.close()
        break
      case 'ArrowLeft':
        event.preventDefault()
        this.yaw -= step
        this.invalidate()
        break
      case 'ArrowRight':
        event.preventDefault()
        this.yaw += step
        this.invalidate()
        break
      case 'ArrowUp':
        event.preventDefault()
        this.pitch = clamp(this.pitch + step, -MAX_PITCH_DEG, MAX_PITCH_DEG)
        this.invalidate()
        break
      case 'ArrowDown':
        event.preventDefault()
        this.pitch = clamp(this.pitch - step, -MAX_PITCH_DEG, MAX_PITCH_DEG)
        this.invalidate()
        break
      case '+':
      case '=':
        event.preventDefault()
        this.zoomBy(0.85)
        break
      case '-':
      case '_':
        event.preventDefault()
        this.zoomBy(1 / 0.85)
        break
      case '0':
      case 'Home':
        event.preventDefault()
        this.reset()
        break
      default:
        break
    }
    // 独占键盘:面板的键盘飞行挂在冒泡阶段,这里在捕获阶段截住
    event.stopPropagation()
  }

  /**
   * 拖动换算:一屏高恰好对应一个垂直视野,于是"每像素转多少度"= fov / 画布高。
   * 视野越小(放得越大)拖得越慢,手感与真机一致。
   * 符号按"抓住画面拖"约定:右拖 = 画面右移 = 视线左转,下拖 = 画面下移 = 视线抬高。
   */
  private rotateBy(dx: number, dy: number, continuous: boolean): void {
    const height = this.refs?.stage.clientHeight ?? 0
    if (!height) return
    const perPixel = this.fov / height
    const deltaYaw = -dx * perPixel
    const deltaPitch = dy * perPixel
    this.yaw += deltaYaw
    this.pitch = clamp(this.pitch + deltaPitch, -MAX_PITCH_DEG, MAX_PITCH_DEG)
    if (!continuous) {
      // 惯性:松手后按最后一次的帧增量继续滑一小段(拖动中始终覆盖成最新值)
      this.velocity.yaw = deltaYaw
      this.velocity.pitch = deltaPitch
    }
    this.invalidate()
  }

  private zoomBy(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return
    this.fov = clamp(this.fov * factor, this.minFov, this.maxFov)
    this.invalidate()
  }

  private currentPinchDistance(): number {
    const points = [...this.pointers.values()]
    if (points.length < 2) return 0
    const [a, b] = points
    if (!a || !b) return 0
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  // ───────────────────────────── 内部:杂项 ─────────────────────────────

  private lockScroll(): void {
    if (typeof document === 'undefined') return
    this.bodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }

  private unlockScroll(): void {
    if (typeof document === 'undefined') return
    document.body.style.overflow = this.bodyOverflow
  }

  private slug(value: string): string {
    const cleaned = value.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
    return cleaned || 'panorama'
  }

  private query<T extends HTMLElement = HTMLElement>(selector: string): T {
    const root = this.root
    if (!root) throw new Error('[DronePanoramaViewer] 弹窗尚未挂载')
    const el = root.querySelector<T>(selector)
    if (!el) throw new Error(`[DronePanoramaViewer] 缺少节点:${selector}`)
    return el
  }

  private template(): string {
    const download = this.options.downloadable === false ? ' hidden' : ''
    const importer = this.options.importable ? '' : ' hidden'
    return `
      <div class="divp-mask" data-role="mask" data-action="close"></div>
      <div class="divp-frame">
        <div class="divp-bar">
          <span class="divp-title" data-role="title">全景图</span>
          <span class="divp-hud" data-role="hud"></span>
          <span class="divp-spacer"></span>
          <button type="button" class="divp-btn" data-action="reset" title="视角复位 (0)">复位</button>
          <button type="button" class="divp-btn" data-action="import" title="从本地导入等距柱状全景图"${importer}>导入图片</button>
          <button type="button" class="divp-btn" data-action="download" title="下载原图"${download}>下载原图</button>
          <button type="button" class="divp-icon" data-action="close" title="关闭 (Esc)" aria-label="关闭">×</button>
        </div>
        <div class="divp-stage" data-role="stage">
          <canvas class="divp-canvas" data-role="canvas"></canvas>
          <p class="divp-note" data-role="note" hidden></p>
        </div>
        <div class="divp-foot">拖动环视球面 · 滚轮 / 双指缩放 · 方向键微调(Shift 加速) · 双击或 0 复位 · Esc 关闭</div>
      </div>
      <input type="file" accept="image/*" data-role="file" hidden />
    `
  }
}

/** 编译单个着色器;失败时返回 null(调用方回退到平面图),并把编译日志打到控制台便于定位 */
function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('[DronePanoramaViewer] 着色器编译失败:', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}
