import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { DroneControlPanel, DroneFly, MissionPanel } from '@/lib'
import { WebGPURenderer } from 'three/webgpu'

export class UseLibDemo {
  private container: HTMLElement
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private renderer: WebGPURenderer | null = null
  private controls: OrbitControls | null = null
  private animateId: number | null = null
  droneFly?: DroneFly
  /** 库提供的原生 DOM 控制面板(右上:飞行控制 + 双摇杆 + 云台/拍照/录像) */
  private controlPanel: DroneControlPanel | null = null
  /** 库提供的原生 DOM 航线规划面板(左上:任务/参数/航点列表/场景内编辑) */
  private missionPanel: MissionPanel | null = null

  constructor(container: HTMLElement) {
    this.container = container
  }

  async init(): Promise<void> {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x87ceeb)

    const width = this.container.clientWidth
    const height = this.container.clientHeight

    this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000)
    this.camera.position.set(4, 4, 5)

    this.renderer = new WebGPURenderer({ antialias: true })
    await this.renderer.init()
    this.renderer.setSize(width, height)
    this.container.appendChild(this.renderer.domElement)

    // 轨道控制器
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.05

    // 灯光
    const dirLight = new THREE.DirectionalLight(0xffffff, 1)
    dirLight.position.set(3, 5, 4)
    this.scene.add(dirLight)
    const ambientLight = new THREE.AmbientLight(0x404040)
    this.scene.add(ambientLight)

    // 地面 / 网格 / 坐标参照全部交给库的沙盒世界(DroneWorld):它自带 4000m 底板 + 米级细网格 + 百米粗网格。
    // demo 这里原本还叠了一层 20x20 灰地板、20x20 蓝网格和一根 AxesHelper(正正压在同一个 y=0 上,
    // 与库的底板同面闪烁),以及一个自转的红色方块 —— 都是 firstapp 模板的演示残留,与无人机沙盒无关,已清掉。
    await this.InitdRroneFly('/models/dji_mini4_pro.glb')

    window.addEventListener('resize', this.onResize.bind(this))
    this.animate()
  }

  public async InitdRroneFly(url: string): Promise<void> {
    const fly = new DroneFly(this.scene, this.camera, this.renderer, this.controls)
    // 障碍物(建筑 / 灯杆 / 天桥 / 树)不在 modelUrl 里,而是由库的世界层按规格程序化生成。
    // 这里传空数组 = 清空它们,沙盒只剩地面网格 + 返航点 + 无人机;
    // 想恢复内置那 7 个参考物就传 DEFAULT_OBSTACLES,想换成自己的楼群/街区就传自定义 ObstacleSpec[]。
    await fly.initialize({ modelUrl: url, obstacles: [] })
    this.droneFly = fly

    // 上电:走完自检 → 预热 → 待机,面板上「起飞」随即可用(真机也是先开机再用遥控器)
    fly.powerOn()
    // 展开机臂:「机臂已展开」是起飞前检查的阻塞项,真机也得先展臂(面板上也有对应按钮)
    fly.setArmsFolded(false)

    // 控制面板由库直接生成(原生 DOM,不依赖 Vue):视角切换 + 双虚拟摇杆 + 云台 / 拍照 / 录像
    this.controlPanel = new DroneControlPanel(fly, {
      container: this.container,
      position: 'top-right',
    })

    // 航线规划面板(同样原生 DOM):执行/暂停/停止任务、任务参数、航点列表、三维场景内编辑。
    // 摆在左上角与右上角的控制面板对开;场景内编辑默认可用(初始就是观察者视角)
    this.missionPanel = new MissionPanel(fly, {
      container: this.container,
      position: 'top-left',
    })

    // 开发期调试句柄:方便在浏览器控制台 / 自动化脚本里读飞控真值(生产构建会被剔除)
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__droneDemo = this
    }
  }

  private animate(): void {
    this.animateId = requestAnimationFrame(this.animate.bind(this))

    // 每帧推进无人机仿真与相机 —— 视角切换/云台转动都是在这里生效的,漏调则画面永远不变
    this.droneFly?.animate()

    // 只有观察者(轨道)视角才交给 OrbitControls;机载/跟随视角下它的
    // 每帧 lookAt(target) 会把相机拽回"看着飞机",覆盖云台取景
    if (!this.droneFly || this.droneFly.isOrbitView) {
      this.controls?.update()
    }

    // 拍照 / 录像钩子:摆云台取景 → 渲染 → 同一任务内拷屏并还原相机。
    // 不调这三个钩子,拍照会一直"相机未就绪"超时,录像录到的是用户视角而非云台画面;
    // 未拍照且未录制时三者全部零开销,每帧调用没有代价
    this.droneFly?.captureRecordingFrame()
    this.droneFly?.onBeforeRender()

    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera)
    }

    this.droneFly?.onAfterRender()
  }

  private onResize(): void {
    if (!this.camera || !this.renderer) return
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }

  async destroy(): Promise<void> {
    if (this.animateId !== null) {
      cancelAnimationFrame(this.animateId)
    }
    window.removeEventListener('resize', this.onResize.bind(this))

    this.controls?.dispose()

    this.controlPanel?.destroy()
    this.controlPanel = null

    this.missionPanel?.destroy()
    this.missionPanel = null

    if (this.droneFly) {
      this.droneFly.destroy()
    }

    if (this.renderer) {
      this.renderer.dispose()
      this.container.removeChild(this.renderer.domElement)
    }

    this.scene = null
    this.camera = null
    this.renderer = null
    this.controls = null
  }
}
