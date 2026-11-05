/**
 * 渲染器契约 —— 库对 three 渲染器的最小依赖面。
 *
 * 背景:库 historically 声明 `renderer: WebGPURenderer`,把使用方锁死在 WebGPU 上。
 * 实际盘点后,库内部对渲染器的全部用法只有两个:
 *   1. `renderer.render(scene, camera)` —— 推进一帧(含拍照/录像的离屏重渲);
 *   2. `renderer.domElement` —— 读画布像素(copyElement / toDataURL)。
 * 这两件事 `WebGPURenderer` 与 `WebGLRenderer` 都天然满足。所以把类型放宽成
 * 结构化契约:**以 WebGPU 为主(推荐,支持 TSL 材质与后期),WebGL 亦可(功能完整,
 * 但宿主自己的 TSL 材质/后期不可用 —— 那是使用方的事,库不依赖)**。
 *
 * ⚠️ 刻意用 import type + 结构化接口,不在库里 import WebGPURenderer/WebGLRenderer
 * 的运行时类 —— 库因此与 three/webgpu 的构建产物解耦,打包体积与后端选择都归使用方。
 */
import type * as THREE from 'three'

/** 渲染后端标识 */
export type DroneRendererKind = 'webgpu' | 'webgl'

/**
 * 库可接受的最小渲染器形状。
 * WebGPURenderer / WebGLRenderer 都是超集,可直接传入,无需适配器。
 */
export interface DroneRendererLike {
  readonly domElement: HTMLCanvasElement
  render(scene: THREE.Scene, camera: THREE.Camera): void
  /** WebGPURenderer 专属(异步初始化后端);WebGLRenderer 没有,使用方需自行判别 */
  init?(): Promise<unknown>
  setSize(width: number, height: number, updateStyle?: boolean): void
  /** WebGPU 与传统 WebGL 渲染器都有该对象;WebGPU 下仅 forceWebGL 后端真正消费阴影配置 */
  shadowMap: { enabled: boolean; type: number }
  toneMapping: number
  toneMappingExposure: number
  dispose(): void
}

/**
 * 判别渲染器后端。鸭子判断,不引运行时类:
 * - WebGPURenderer 实例带 `backend`(WebGPUBackend 或 forceWebGL 时的 WebGLBackend);
 * - 传统 WebGLRenderer 没有 `backend`,但有 `isWebGLRenderer` 标志。
 *
 * 注意 `WebGPURenderer({ forceWebGL: true })` 判为 **'webgpu'** —— 它跑的是
 * NodeMaterial 体系(TSL 材质可用),只是绘制命令走 WebGL2,与传统 WebGLRenderer
 * 是两回事。
 */
export function rendererKindOf(renderer: object): DroneRendererKind {
  if ('backend' in renderer || (renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer) {
    return 'webgpu'
  }
  return 'webgl'
}
