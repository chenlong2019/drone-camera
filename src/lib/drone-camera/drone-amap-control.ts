/**
 * 高德地图屏的「飞行控制」适配层:把 `AmapDroneMap` + `DroneSim` 包装成 `DronePanelHost`,
 * 于是现成的 `DroneControlPanel`(双虚拟摇杆 / 键盘 / 起飞降落返航 / 挡位 / 速度倍率)
 * 一行不改就能挂到地图屏上 —— 与 three 的 `DroneFly`、Cesium 的 `CesiumDroneAdapter` 同级。
 *
 * 为什么单独一个文件:
 * - `drone-amap.ts` 只负责「地图 + 覆盖物」,不该被飞行面板的接口绑住;
 * - 面板接口在 `drone-control.ts`,是纯类型依赖,不会把 three / Cesium 拖进来。
 *
 * 能力边界(地图屏不是三维仿真,这里如实降级而不是假装支持):
 * | 能力 | 地图屏 | 说明 |
 * |---|---|---|
 * | 飞控操作(起飞/降落/返航/摇杆/挡位/速度) | 完整 | 全部落到 `DroneSim`,与另两屏同源 |
 * | 视角模式 | 映射到地图相机 | 观察者=不跟随、跟随=正北朝上、机载=机头朝上贴地平线 |
 * | 拍照 / 录像取景 | 降级 | 地图画布跨域瓦片,拿不到像素;`requestPhoto()` 只登记张数并返回 null |
 * | 云台俯仰 | 只写飞控真值 | 没有机体模型可看,画面不变 |
 * | 机臂折叠 | 只记状态 | 同上 |
 *
 * ⚠️ 地图相机倾角上限 83°、最近视距 zoom 20 —— 「机载」只是**贴地平线的追尾视角**,
 * 不是真 FPV(真 FPV 要在机体内部往外看,那必须交给 three / Cesium 两屏)。
 */
import type { DronePanelHost } from './drone-control'
import type { CameraMode, PhotoShot } from './drone-fly'
import type { CaptureCameraState, CaptureViewOverride } from './drone-capture'
import type { ChecklistItem, DroneSim, FlightMode, FlightPhase, StickState } from './drone-sim'
import type { AmapDroneMap } from './drone-amap'

/**
 * 相机模式 → 地图相机参数的映射。
 *
 * - `orbit`(观察者):取消跟随,倾角 45°,正北朝上 —— 自由看地图,飞机飞出去也不追赶;
 * - `follow`(跟随):跟随 + 正北朝上,倾角 55° —— 位移看得清、地图方向不转,不容易迷路;
 * - `fpv`(机载):跟随 + **机头朝上** + 倾角 78°(接近上限 83°)+ zoom 19 —— 能得到的最近"追尾"观感。
 *
 * 朝向锁(`headingLock`)不是一次性的:每帧把地图旋转到 `-heading`,机头才持续朝屏幕上方。
 */
const VIEW_PRESETS: Record<
  CameraMode,
  { follow: boolean; pitch: number; zoom: number; headingLock: boolean }
> = {
  orbit: { follow: false, pitch: 45, zoom: 17, headingLock: false },
  follow: { follow: true, pitch: 55, zoom: 17, headingLock: false },
  fpv: { follow: true, pitch: 78, zoom: 19, headingLock: true },
}

/** 朝向锁的更新阈值(度):小于这个角度不重设地图旋转,避免每帧调相机 */
const HEADING_LOCK_EPSILON_DEG = 0.5

export interface AmapDroneAdapterOptions {
  /** 飞行内核(必填):与地图共用同一个实例,面板写的就是地图读的 */
  sim: DroneSim
  /** 地图宿主;`open()` 之前可以先传 null,拿到实例后再 `attach()` */
  map?: AmapDroneMap | null
  /** 初始相机模式,默认 'follow' */
  cameraMode?: CameraMode
}

/**
 * 把地图屏接成一块可以"打杆"的屏幕。
 *
 * 面板每 200ms 从这里读真值、每次操作调这里的方法,所有飞行语义都直接透传给 `DroneSim` ——
 * 所以地图屏飞出来的轨迹与 three / Cesium 两屏**逐帧一致**(同一份内核、同一套挡位表)。
 */
export class AmapDroneAdapter implements DronePanelHost {
  readonly sim: DroneSim

  private map: AmapDroneMap | null
  private cameraModeValue: CameraMode
  private armsFoldedValue = false
  private lastLockedHeading: number | null = null
  private captureView: CaptureViewOverride | null = null

  constructor(options: AmapDroneAdapterOptions) {
    this.sim = options.sim
    this.map = options.map ?? null
    this.cameraModeValue = options.cameraMode ?? 'follow'
  }

  /** 地图建好后接上来(面板可以先于地图存在) */
  attach(map: AmapDroneMap | null): void {
    this.map = map
    this.lastLockedHeading = null
    map?.setFpvFrame(this.cameraModeValue === 'fpv')
    this.applyView()
  }

  /** 当前挂载的地图(调试 / 宿主直连地图用) */
  get amap(): AmapDroneMap | null {
    return this.map
  }

  // ————————————————————————————— 真值读取(只读) —————————————————————————————

  get phase(): FlightPhase {
    return this.sim.phase
  }

  get airborne(): boolean {
    return this.sim.airborne
  }

  get flightMode(): FlightMode {
    return this.sim.mode
  }

  /** 相对起飞点的高度(米,AGL) */
  get altitude(): number {
    return this.sim.position.y
  }

  get preflightChecks(): ChecklistItem[] {
    return this.sim.checklist
  }

  /**
   * 机臂是否收拢。
   *
   * 地图屏没有机体模型,折叠不改变任何画面;这里记录状态只为让面板按钮的反馈自洽。
   * 与真机不同:`DroneSim` 不把机臂算进起飞检查项,所以折叠状态下仍可起飞。
   */
  get armsFolded(): boolean {
    return this.armsFoldedValue
  }

  get isRecording(): boolean {
    return this.sim.recording
  }

  get cameraMode(): CameraMode {
    return this.cameraModeValue
  }

  // ————————————————————————————— 操作透传 —————————————————————————————

  powerOn(): void {
    this.sim.powerOn()
  }

  takeOff(): boolean {
    return this.sim.autoTakeOff()
  }

  land(): boolean {
    return this.sim.startLanding()
  }

  returnHome(reason = '用户触发返航'): boolean {
    return this.sim.startRth(reason)
  }

  setStick(stick: Partial<StickState>): void {
    // ⚠️ 未起飞时飞控忽略一切杆量 —— 用户直拖摇杆就是"摇杆不能用"。
    // 地图屏没有三维画面的起飞仪式感,这里按模拟器惯例:**打杆即自动起飞**,
    // 键盘(W/S/方向键)走同一条 setStick 通道,同样生效。
    if (!this.sim.airborne && this.hasStickInput(stick)) {
      this.sim.autoTakeOff()
    }
    this.sim.setStick(stick)
  }

  /** 是否存在非零杆量(standby 下连续到来的零杆量不会反复触发起飞) */
  private hasStickInput(stick: Partial<StickState>): boolean {
    return ['throttle', 'pitch', 'roll', 'yaw'].some(
      (key) => Math.abs(stick[key as keyof StickState] ?? 0) > 1e-3,
    )
  }

  setMode(mode: FlightMode): void {
    this.sim.setMode(mode)
  }

  setArmsFolded(folded: boolean): void {
    this.armsFoldedValue = folded
  }

  /**
   * 切视角:改的是**地图相机**(跟随 / 倾角 / 缩放 / 朝向锁),不是三维相机。
   *
   * 进入 `fpv` 时先按当前航向锁一次朝向,免得等下一帧才转过来。
   */
  setCameraMode(mode: CameraMode): void {
    if (this.cameraModeValue === mode) return
    this.cameraModeValue = mode
    this.lastLockedHeading = null
    // 取景环只是 UI 示意(地图相机进不了机体),但必须跟着模式走,
    // 否则机载选了却毫无视觉回答 —— 这才是用户说"机载没切过去"的直接观感。
    this.map?.setFpvFrame(mode === 'fpv')
    this.applyView()
  }

  /** 云台俯仰:地图屏没有机体模型与云台画面,只写飞控真值(采集/遥测仍能读到) */
  setGimbalPitch(pitch: number): void {
    this.sim.setGimbalPitch(pitch)
  }

  /** 视角复位:回到当前模式的默认倾角 / 朝向,并重新按模式设定跟随 */
  resetCamera(): void {
    this.lastLockedHeading = null
    this.applyView()
  }

  /** 直接移动机体(地图覆盖物下一帧就跟上) */
  flyTo(target: { x?: number; y?: number; z?: number; heading?: number; pitch?: number; roll?: number }): void {
    if (this.sim.external && this.sim.dispatchExternal({
      type: 'goto',
      x: target.x ?? this.sim.position.x,
      y: target.y ?? this.sim.position.y,
      z: target.z ?? this.sim.position.z,
      heading: target.heading,
    })) {
      return
    }
    const position = this.sim.position
    if (target.x !== undefined) position.x = target.x
    if (target.y !== undefined) position.y = Math.max(0, target.y)
    if (target.z !== undefined) position.z = target.z
    if (target.heading !== undefined) this.sim.heading = target.heading
  }

  /** 变焦:只写飞控真值(地图的 zoom 由视角模式与用户滑块各自控制) */
  zoomTo(zoom: number): void {
    this.sim.setZoom(zoom)
  }

  /**
   * 拍照。
   *
   * 地图画布的瓦片是跨域资源,`toDataURL` 会被污染保护拦下;
   * 而这一屏本来就没有"取景画面"可言,所以不假装返回图片:
   * 照实登记张数(面板角标会 +1),返回 null 让调用方知道没有像素产出。
   */
  async requestPhoto(): Promise<PhotoShot | null> {
    this.sim.takePhoto()
    return null
  }

  /** 地图屏没有取景相机 —— 采集服务在这屏不可用(全景 / 影像集请用三维两屏) */
  getCaptureCamera(): CaptureCameraState | null {
    return null
  }

  /** 记录全景取景覆盖:地图屏没有取景相机,`getCaptureCamera()` 恒为 null,这里只留存不生效 */
  setCaptureView(override: CaptureViewOverride | null): void {
    this.captureView = override
  }

  /** 当前记录的取景覆盖(调试用;地图屏不会把它应用到任何相机上) */
  get captureViewOverride(): CaptureViewOverride | null {
    return this.captureView
  }

  /** 机体自转(地图上表现为机头方向变化,机载模式下地图会跟着转) */
  spinBodyTo(headingDeg: number | null): void {
    this.sim.spinTo(headingDeg)
  }

  getBodyHeading(): number {
    return this.sim.heading
  }

  startRecording(): boolean {
    if (this.sim.recording) return false
    this.sim.setRecordingState(true)
    return true
  }

  /** 地图屏录不出 webm(没有渲染器帧源),停止后返回 null 并保留时长统计 */
  async stopRecording(): Promise<Blob | null> {
    this.sim.setRecordingState(false)
    return null
  }

  /**
   * 每帧调用一次(跟地图的 `sync` 同一个节拍):机载模式下把地图旋转锁到机头方向。
   *
   * 只在航向变化超过 `HEADING_LOCK_EPSILON_DEG` 时才调 `setRotation` ——
   * 地图每次设旋转都会重排相机,60fps 无脑设会明显掉帧。
   */
  tick(): void {
    const preset = VIEW_PRESETS[this.cameraModeValue]
    if (!preset.headingLock || !this.map) return
    const target = -this.sim.heading
    if (this.lastLockedHeading !== null && Math.abs(target - this.lastLockedHeading) < HEADING_LOCK_EPSILON_DEG) {
      return
    }
    this.lastLockedHeading = target
    this.map.setRotation(target)
  }

  /** 把当前模式的参数写到地图上 */
  private applyView(): void {
    const preset = VIEW_PRESETS[this.cameraModeValue]
    if (!this.map) return
    this.map.setFollow(preset.follow)
    this.map.setPitch(preset.pitch)
    this.map.setZoom(preset.zoom)
    if (preset.headingLock) {
      const target = -this.sim.heading
      this.lastLockedHeading = target
      this.map.setRotation(target)
    } else {
      this.lastLockedHeading = null
      this.map.setRotation(0)
    }
  }
}
