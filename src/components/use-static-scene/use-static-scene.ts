/**
 * 「边境营地」静态场景的宿主层：渲染器 / 相机 / 天空 / 光照 / 后期。
 *
 * 与 use-three-demo 的区别：这里没有飞控、没有面板、没有每帧仿真，
 * 只有「一次性建景 + 每帧渲染」。相机默认缓慢环绕（电影感），
 * 一旦用户拖拽就停住，交还控制权 —— 不强制交互，也不阻止交互。
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { PMREMGenerator, PostProcessing, WebGPURenderer } from 'three/webgpu'
import { pass } from 'three/tsl'
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js'
import { StaticScene } from './static-scene'
import type { StaticSceneStats } from './static-scene'
import { assetUrl } from '@/utils/asset-url'

const HDRI_URL = assetUrl('hdri/spruit_sunrise_4k.hdr')

/**
 * 太阳方向：与 HDRI 里的太阳一致（方位 36.6° / 仰角 8.4°，由像素亮度反推）。
 * 低角度是这张图的关键——阴影拉到建筑高度的 6~7 倍，画面立刻有「时刻」。
 */
const SUN_DIRECTION = new THREE.Vector3(80, 15, 59).normalize()

/** 相机初始机位：从东南方斜看村子，主路从画面中间穿出去 */
const CAMERA_POSITION = new THREE.Vector3(92, 27, 110)
const CAMERA_TARGET = new THREE.Vector3(-4, 6, -16)

export interface RenderInfo {
  fps: number
  calls: number
  triangles: number
}

export class UseStaticScene {
  private readonly container: HTMLElement
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private renderer: WebGPURenderer | null = null
  private controls: OrbitControls | null = null
  private content: StaticScene | null = null
  private hdri: THREE.Texture | null = null
  private post: PostProcessing | null = null
  private animationId: number | null = null
  private disposed = false
  private resizeHandler: (() => void) | null = null
  private frames = 0
  private lastStatsTime = 0
  private lastCalls = 0
  private lastTriangles = 0

  /** 渲染统计（HUD 每 1s 读一次，不逐帧写 DOM） */
  onStats: ((info: RenderInfo) => void) | null = null
  /** HDRI 就绪（或失败）后回调，用于收起加载遮罩 */
  onReady: (() => void) | null = null

  constructor(container: HTMLElement) {
    this.container = container
  }

  get contentStats(): StaticSceneStats | null {
    return this.content?.stats ?? null
  }

  async init(): Promise<void> {
    const scene = new THREE.Scene()
    this.scene = scene
    scene.background = new THREE.Color(0x9aa6b2)

    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)

    this.camera = new THREE.PerspectiveCamera(46, width / height, 0.5, 1600)
    this.camera.position.copy(CAMERA_POSITION)

    const renderer = new WebGPURenderer({ antialias: true })
    this.renderer = renderer
    await renderer.init()
    if (this.disposed) return
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    this.container.appendChild(renderer.domElement)

    const controls = new OrbitControls(this.camera, renderer.domElement)
    this.controls = controls
    controls.target.copy(CAMERA_TARGET)
    controls.enableDamping = true
    controls.dampingFactor = 0.055
    controls.enablePan = false
    controls.minDistance = 26
    controls.maxDistance = 430
    // 不让相机钻到地下（略小于 90°，留一点俯视余量）
    controls.maxPolarAngle = Math.PI * 0.495
    controls.minPolarAngle = Math.PI * 0.12
    // 默认缓慢环绕；一旦用户开始拖拽就停下来，避免「我拖它还自己转」
    const autoTour = new URLSearchParams(window.location.search).get('tour') !== '0'
    controls.autoRotate = autoTour
    controls.autoRotateSpeed = 0.32
    controls.addEventListener('start', () => {
      controls.autoRotate = false
    })
    controls.update()

    // 太阳：唯一投影光源。天空的漫射全部交给 HDRI，不再补 AmbientLight
    const sun = new THREE.DirectionalLight(0xffd3a4, 3.4)
    sun.position.copy(SUN_DIRECTION).multiplyScalar(230)
    sun.target.position.set(0, 0, 0)
    sun.castShadow = true
    sun.shadow.mapSize.set(4096, 4096)
    sun.shadow.camera.near = 20
    sun.shadow.camera.far = 620
    sun.shadow.camera.left = -165
    sun.shadow.camera.right = 165
    sun.shadow.camera.top = 165
    sun.shadow.camera.bottom = -165
    // 改过正交范围必须重算投影矩阵，否则仍按默认 ±5m 裁剪（只有原点附近有影子）
    sun.shadow.camera.updateProjectionMatrix()
    sun.shadow.bias = -0.0006
    sun.shadow.normalBias = 0.035
    scene.add(sun)
    scene.add(sun.target)

    // 内容层：全部程序化生成，一次建好不再变
    this.content = new StaticScene(scene)

    // 首帧兜底环境：中性影棚，保证 HDRI 到达前金属件不是黑的
    const pmrem = new PMREMGenerator(renderer)
    const room = new RoomEnvironment()
    scene.environment = pmrem.fromScene(room, 0.04).texture
    scene.environmentIntensity = 0.55
    room.dispose()
    pmrem.dispose()

    // 后期：极轻的泛光，只让太阳与暖窗溢出一点光晕
    const scenePass = pass(scene, this.camera)
    const sceneColor = scenePass.getTextureNode()
    const bloomPass = bloom(sceneColor, 0.42, 0.5, 1.35)
    this.post = new PostProcessing(renderer)
    this.post.outputNode = sceneColor.add(bloomPass)

    this.resizeHandler = () => this.onResize()
    window.addEventListener('resize', this.resizeHandler)

    this.lastStatsTime = performance.now()
    this.animate()
    void this.applyHdri()

    // 开发期调试句柄：截图脚本用它切机位、读绘制统计
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__staticScene = this
    }
  }

  /**
   * 加载真实户外 HDRI：一张图同时给背景、天空漫射、材质反射。
   * 23MB 不阻塞首帧——到达后替换即可；失败就保持影棚兜底，不报错。
   */
  private async applyHdri(): Promise<void> {
    const scene = this.scene
    if (!scene) return
    try {
      const texture = await new RGBELoader().loadAsync(HDRI_URL)
      if (this.disposed || this.scene !== scene) {
        texture.dispose()
        return
      }
      texture.mapping = THREE.EquirectangularReflectionMapping
      scene.environment = texture
      scene.environmentIntensity = 0.9
      scene.background = texture
      scene.backgroundIntensity = 1
      // 雾色取地平线的暖灰，远山没入大气而不是被硬切。
      // 密度标定：0.0019 时 250m 外几乎全白（沿路看向远处会糊成一片），0.0015 保住层次
      scene.fog = new THREE.FogExp2(0xcbb9a4, 0.0015)
      this.hdri = texture
    } catch {
      // 保持兜底环境
    } finally {
      this.onReady?.()
    }
  }

  private animate = (): void => {
    if (this.disposed) return
    this.animationId = requestAnimationFrame(this.animate)

    this.controls?.update()
    if (this.post) this.post.render()
    else if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera)
    }

    // 每秒汇报一次渲染统计（HUD 用）。WebGPU 的 info 跨帧累计，
    // 所以用「相邻两次读数的差」折算出每秒的每帧均值，不依赖 reset 语义。
    this.frames += 1
    const now = performance.now()
    if (now - this.lastStatsTime >= 1000) {
      const fps = Math.round((this.frames * 1000) / (now - this.lastStatsTime))
      const info = this.renderer?.info
      const totalCalls = info?.render.calls ?? 0
      const totalTriangles = info?.render.triangles ?? 0
      this.onStats?.({
        fps,
        calls: Math.max(0, Math.round((totalCalls - this.lastCalls) / this.frames)),
        triangles: Math.max(0, Math.round((totalTriangles - this.lastTriangles) / this.frames)),
      })
      this.lastCalls = totalCalls
      this.lastTriangles = totalTriangles
      this.frames = 0
      this.lastStatsTime = now
    }
  }

  private onResize(): void {
    if (!this.camera || !this.renderer) return
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
  }

  /** 供外部（调试脚本/截图）切换一个固定机位 */
  setView(position: [number, number, number], target: [number, number, number]): void {
    if (!this.camera || !this.controls) return
    this.controls.autoRotate = false
    this.camera.position.set(position[0], position[1], position[2])
    this.controls.target.set(target[0], target[1], target[2])
    this.controls.update()
  }

  dispose(): void {
    this.disposed = true
    if (this.animationId !== null) cancelAnimationFrame(this.animationId)
    this.animationId = null
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler)
    this.resizeHandler = null

    this.controls?.dispose()
    this.controls = null
    this.post = null
    this.content?.dispose()
    this.content = null
    this.hdri?.dispose()
    this.hdri = null

    if (this.renderer) {
      this.renderer.dispose()
      this.renderer.domElement.remove()
    }
    this.renderer = null
    this.scene = null
    this.camera = null
  }
}
