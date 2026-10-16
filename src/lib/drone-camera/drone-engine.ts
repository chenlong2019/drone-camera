/**
 * 引擎装配层 —— 用 `engine` 字段选择渲染后端,一处配置换整套渲染实现。
 *
 * 库里有两套完整的飞行控制器,都实现同一个 `DronePanelHost` 接口:
 *
 *   engine: 'three'  → DroneFly            three.js + WebGPURenderer 的飞行沙盒
 *   engine: 'cesium' → CesiumDroneAdapter  地球(ENU/ECEF)坐标系下的飞行
 *
 * 两者的差别只在"真值怎么变成画面":飞行内核都是同一个 DroneSim,控制面板 /
 * 航线面板 / 鹰眼图 / 键盘控制完全不区分后端。所以选后端这件事只该发生一次 ——
 * 就在本工厂里,调用方拿到实例后只管用,不需要知道下面挂的是谁。
 *
 * ```ts
 * // three(自带场景)
 * const drone = await createDroneControl({
 *   engine: 'three', scene, camera, renderer, controls, modelUrl: '/models/dji_mini4_pro.glb',
 * })
 *
 * // Cesium(先确保 /Cesium/Cesium.js 已就绪)
 * await loadCesiumScript('/Cesium/Cesium.js')
 * const drone = await createDroneControl({ engine: 'cesium', viewer, lon: 116.391, lat: 39.906 })
 *
 * // 之后再靠判别字段访问引擎特有成员
 * if (drone.engine === 'three') drone.setGimbalStabilization('physical')
 * ```
 *
 * `engine` 缺省为 `'three'`(与历史 API 一致:`new DroneFly(...)` + `initialize()`)。
 */
import type * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { WebGPURenderer } from 'three/webgpu'

import type { DronePanelHost } from './drone-control'
import { DroneFly, type DroneFlyInitializeOptions } from './drone-fly'
import { CesiumDroneAdapter, type CesiumDroneOptions } from './drone-cesium'

/** 渲染后端标识 */
export type DroneEngine = 'three' | 'cesium'

/**
 * three 后端参数:场景四件套 + `DroneFly.initialize()` 的全部选项
 * (modelUrl / obstacles)。
 */
export interface ThreeDroneEngineOptions extends DroneFlyInitializeOptions {
  /** 后端标识;缺省 'three' */
  engine?: 'three'
  scene: THREE.Scene<THREE.Object3DEventMap>
  camera: THREE.PerspectiveCamera
  renderer: WebGPURenderer
  controls?: OrbitControls<THREE.Camera> | null
}

/** Cesium 后端参数:本质就是 CesiumDroneOptions,只多一个必需的 engine 判别字段 */
export interface CesiumDroneEngineOptions extends CesiumDroneOptions {
  engine: 'cesium'
}

/** `createDroneControl()` 的参数(判别联合) */
export type DroneControlOptions = ThreeDroneEngineOptions | CesiumDroneEngineOptions

/**
 * 引擎无关的控制器句柄 —— 两套实现都满足。
 *
 * 它是 `DronePanelHost`(面板 / 航线面板 / 鹰眼图真正依赖的那 22 项能力)
 * 加上一个 `engine` 判别字段,于是:
 * - 只做通用控制时,写 `(drone: DroneEngineHost) => void` 就够了,不必写联合类型;
 * - 需要引擎特有成员时,再用 `engine` 收窄到具体类。
 */
export interface DroneEngineHost extends DronePanelHost {
  readonly engine: DroneEngine
}

/** 按 `engine` 装配并初始化:three 走 DroneFly.initialize,Cesium 走 CesiumDroneAdapter.start */
export function createDroneControl(options: ThreeDroneEngineOptions): Promise<DroneFly>
export function createDroneControl(options: CesiumDroneEngineOptions): Promise<CesiumDroneAdapter>
export function createDroneControl(options: DroneControlOptions): Promise<DroneEngineHost>
export async function createDroneControl(
  options: DroneControlOptions,
): Promise<DroneFly | CesiumDroneAdapter> {
  if (options.engine === 'cesium') {
    const adapter = new CesiumDroneAdapter(options)
    await adapter.start()
    return adapter
  }
  const { engine: _engine, scene, camera, renderer, controls, ...init } = options
  const fly = new DroneFly(scene, camera, renderer, controls ?? null)
  await fly.initialize(init)
  return fly
}
