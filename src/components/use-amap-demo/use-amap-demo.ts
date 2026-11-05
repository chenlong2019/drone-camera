import { AmapDroneAdapter, AmapDroneMap, DroneControlPanel, DroneSim, gcj02OffsetMeters } from '@/lib'
import type { AmapMapInstance, AmapMapState, CameraMode } from '@/lib'

/** 高德 web 端 key / 安全密钥(构建期注入;缺 key 时页面给出可读提示而不是白屏) */
const AMAP_KEY = (import.meta.env.VITE_AMAP_KEY ?? '').trim()
const AMAP_SECURITY = (import.meta.env.VITE_AMAP_JSC0DE ?? '').trim()

/** 场景原点(WGS84);sim 的本地米坐标以它为零点 */
const ORIGIN = { longitude: 116.391, latitude: 39.906, altitude: 0 }

export interface AmapDemoSnapshot {
  ready: boolean
  error: string | null
  /** 真值(本地 ENU,米) */
  local: { x: number; y: number; z: number }
  altitude: number
  heading: number
  /** 云台俯仰真值(度,-90 俯视 ~ 60 仰视) */
  gimbalPitch: number
  phase: string
  airborne: boolean
  /** 地图侧状态 */
  map: AmapMapState | null
  /** 场景原点处 GCJ 相对 WGS84 的偏移(米):换坐标系时最直观的诊断数字 */
  originOffset: { east: number; north: number }
  hasKey: boolean
  /** 当前视角模式(观察者 / 跟随 / 机载) */
  cameraMode: CameraMode
}

export interface AmapDemoApi {
  init(): Promise<void>
  destroy(): void
  getSnapshot(): AmapDemoSnapshot
  /** 执行默认航线(地面会先自动起飞) */
  runMission(): boolean
  land(): boolean
  returnHome(): boolean
  setSatellite(on: boolean): void
  setFollow(on: boolean): void
  fitView(): void
  /** 倾角(0 俯视 ↔ 83 贴地平线) */
  setPitch(pitch: number): void
  /** 地图旋转(正北 0,顺时针为正) */
  setRotation(rotation: number): void
  /** 回到正俯视、正北朝上 */
  resetView(): void
  /** 切视角模式(观察者 / 跟随 / 机载):映射到地图相机参数 */
  setCameraMode(mode: CameraMode): void
  /** 当前视角模式 */
  getCameraMode(): CameraMode
  /** 底层 AMap.Map 实例(验证脚本做覆盖物对照实验用) */
  rawMap(): AmapMapInstance | null
}

/**
 * 高德地图 demo 的装配层。
 *
 * 这里刻意**不引入任何渲染器**:DroneSim 本身零依赖,`step()` 就是纯数学推进,
 * 所以「一块真实地图 + 一份真实飞控真值」的最小闭环只需要 rAF + 一个覆盖物宿主。
 * 三维那两页(three / Cesium)与这一页共享同一个 sim 语义,只是把真值画到不同的画布上。
 */
export function useAmapDemo(container: HTMLElement): AmapDemoApi {
  const sim = new DroneSim()
  /**
   * 面板宿主适配器:先建好(此时还没地图),地图 open 出来后再 attach。
   * 这样面板可以立刻挂上 —— 键盘与摇杆从第一帧就能打杆,不必等瓦片加载完。
   */
  const host = new AmapDroneAdapter({ sim, cameraMode: 'follow' })
  let panel: DroneControlPanel | null = null
  let map: AmapDroneMap | null = null
  let frameHandle = 0
  let lastFrame = 0
  let error: string | null = null

  function tick(now: number): void {
    const delta = lastFrame ? Math.min((now - lastFrame) / 1000, 0.1) : 0
    lastFrame = now
    sim.step(delta)
    // 机载视角下把地图旋转锁到机头方向(其余模式是空操作)
    host.tick()
    map?.sync(now)
    frameHandle = window.requestAnimationFrame(tick)
  }

  async function init(): Promise<void> {
    if (!AMAP_KEY) {
      error = '未配置 VITE_AMAP_KEY:在 .env.local 里填上高德 web 端 key 后重启 dev server'
      return
    }
    sim.powerOn()
    sim.resetMissionToDefault()
    map = new AmapDroneMap({
      container,
      sim,
      origin: ORIGIN,
      key: AMAP_KEY,
      securityCode: AMAP_SECURITY,
      zoom: 17,
      // 3D 视角:0° 倾角时与 2D 完全一样,但旋转/倾斜随时可用(2.0 不能运行期切 viewMode)
      viewMode: '3D',
      pitch: 45,
      rotation: 0,
      buildings: true,
      satellite: true,
      follow: true,
      // 覆盖物同步由本文件的 rAF 驱动(与 sim 同一节拍),不让地图自己再跑一条循环
      autoTick: false,
    })
    try {
      await map.open()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
      return
    }
    host.attach(map)
    // 控制面板:双摇杆悬浮在两下角 + 键盘(WASD / 方向键)。
    // 停靠右上,把左下角留给「3D 视角」滑块、右下角留给本页的控制条。
    panel = new DroneControlPanel(host, {
      container,
      position: 'top-right',
      title: '无人机 · 地图屏',
    })
    lastFrame = 0
    frameHandle = window.requestAnimationFrame(tick)
  }

  function getSnapshot(): AmapDemoSnapshot {
    const position = sim.position
    return {
      ready: Boolean(map?.getState().ready),
      error,
      local: { x: position.x, y: position.y, z: position.z },
      // sim 没有 altitude getter:AGL 就是 position.y(相对起飞点)
      altitude: position.y,
      heading: sim.heading,
      gimbalPitch: sim.gimbalPitch ?? 0,
      phase: sim.phase,
      airborne: sim.airborne,
      map: map?.getState() ?? null,
      originOffset: gcj02OffsetMeters(ORIGIN.longitude, ORIGIN.latitude),
      hasKey: Boolean(AMAP_KEY),
      cameraMode: host.cameraMode,
    }
  }

  function destroy(): void {
    if (frameHandle) {
      window.cancelAnimationFrame(frameHandle)
      frameHandle = 0
    }
    // 先拆面板再拆地图:面板的键盘监听与摇杆悬浮层都挂在容器上,
    // 地图销毁时容器内部会被清空,顺序反了会留下悬空监听。
    panel?.destroy()
    panel = null
    host.attach(null)
    map?.destroy()
    map = null
  }

  return {
    init,
    destroy,
    getSnapshot,
    runMission: () => sim.startMission(),
    land: () => sim.startLanding(),
    returnHome: () => sim.startRth('demo'),
    setSatellite: (on: boolean) => map?.setSatellite(on),
    setFollow: (on: boolean) => map?.setFollow(on),
    fitView: () => map?.fitView(),
    setPitch: (pitch: number) => map?.setPitch(pitch),
    setRotation: (rotation: number) => map?.setRotation(rotation),
    resetView: () => {
      map?.setPitch(0)
      map?.setRotation(0)
    },
    setCameraMode: (mode: CameraMode) => host.setCameraMode(mode),
    getCameraMode: () => host.cameraMode,
    /** 底层 AMap.Map 实例(验证脚本做覆盖物对照实验用) */
    rawMap: () => map?.getMapInstance() ?? null,
  }
}
