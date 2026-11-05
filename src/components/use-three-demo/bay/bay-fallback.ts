/**
 * 海湾布景的 WebGL 降级材质 —— 传统 `WebGLRenderer` 跑不了 TSL(NodeMaterial 体系
 * 只存在于 WebGPURenderer,包括其 forceWebGL 后端),所以给 ?renderer=webgl 的
 * 使用方一套普通材质版本:观感略简(没有镜面倒影与解析云层),但海是海、天是天。
 *
 * 与 TSL 版共用同一张 CPU 坡度贴图(ripple-texture)派生的法线贴图,波纹形态一致;
 * 天空用顶点色渐变球替代解析云层。接口(createSkyDome / WaterSurface)与 TSL 版
 * 完全同构,BayScenery 按 rendererKind 二选一,其余代码零改动。
 */
import * as THREE from 'three'
import { RIPPLE_TILE, createRippleTexture } from './ripple-texture'
import type { SkyDome } from './bay-sky'
import type { WaterOptions, WaterSurface } from './bay-water'

/** 坡度 DataTexture → 8-bit 法线贴图:n = normalize(-dh/dx, 1, -dh/dy) */
function rippleToNormalMap(): THREE.DataTexture {
  const slope = createRippleTexture()
  const size = slope.image.width
  const src = slope.image.data as Float32Array
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i += 1) {
    const sx = src[i * 4]!
    const sy = src[i * 4 + 1]!
    // 梯度量级 ~O(1),直接归一化;轻微增强凹凸感
    const inv = 1 / Math.hypot(sx * 1.6, sy * 1.6, 1)
    data[i * 4] = Math.round((-sx * 1.6 * inv * 0.5 + 0.5) * 255)
    data[i * 4 + 1] = Math.round((-sy * 1.6 * inv * 0.5 + 0.5) * 255)
    data[i * 4 + 2] = Math.round((inv * 0.5 + 0.5) * 255)
    data[i * 4 + 3] = 255
  }
  slope.dispose()
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

/** 顶点色渐变天空:zenith → horizon 线性插值 + 地平线亮带(与 TSL 版同一组色) */
export function createFallbackSkyDome(radius: number): SkyDome {
  const geometry = new THREE.SphereGeometry(radius, 48, 32)
  const pos = geometry.getAttribute('position')
  const colors = new Float32Array(pos.count * 3)
  const zenith = new THREE.Color(0.19, 0.4, 0.62).convertSRGBToLinear()
  const horizon = new THREE.Color(0.68, 0.74, 0.78).convertSRGBToLinear()
  const band = new THREE.Color(0.82, 0.86, 0.88).convertSRGBToLinear()
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i += 1) {
    const h = Math.max(pos.getY(i) / radius, 0)
    c.copy(horizon).lerp(zenith, Math.pow(h, 0.55))
    // 地平线亮带:0~6° 内向亮灰提一点,海天线才接得上
    if (h < 0.1) c.lerp(band, (1 - h / 0.1) * 0.5)
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'bay-sky-dome'
  mesh.frustumCulled = false
  return {
    mesh,
    update() {
      /* 静态渐变,没有云层动画 */
    },
    follow(eye: THREE.Vector3) {
      mesh.position.copy(eye)
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}

/**
 * 降级海面:MeshStandardMaterial + 法线贴图滚动。
 * 反射靠 scene.environment(HDRI),没有桥体镜面倒影 —— WebGPU 主路径才有的能力。
 */
export function createFallbackWaterSurface(options: WaterOptions = {}): WaterSurface {
  const size = options.size ?? 5500
  const segments = options.segments ?? 200
  const level = options.level ?? 0

  const normalMap = rippleToNormalMap()
  // 每个 tile 覆盖 ~180m:波纹密度与 TSL 版的 5-band 叠加观感接近
  const repeat = size / 180
  normalMap.repeat.set(repeat, repeat)
  const material = new THREE.MeshStandardMaterial({
    color: 0x0d3527,
    roughness: 0.16,
    metalness: 0.6,
    normalMap,
    normalScale: new THREE.Vector2(1.5, 1.5),
    envMapIntensity: 1.25,
    fog: false,
  })
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments)
  geometry.rotateX(-Math.PI / 2)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'bay-water'
  mesh.position.y = level
  mesh.frustumCulled = false

  return {
    mesh,
    update(timeSeconds) {
      // 法线贴图沿两个速度滚动:错速让波纹有"互相穿过"的流动感
      normalMap.offset.set(timeSeconds * 0.008, timeSeconds * 0.0055)
    },
    follow(x, z) {
      mesh.position.x = x
      mesh.position.z = z
    },
    dispose() {
      geometry.dispose()
      material.dispose()
      normalMap.dispose()
    },
  }
}

/** RIPPLE_TILE 仅供实现对齐检查;未被引用时保持树摇 */
export const FALLBACK_TILE = RIPPLE_TILE
