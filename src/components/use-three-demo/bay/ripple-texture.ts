/**
 * 碎波坡度贴图 —— 原版 GLSL 里 simplex 噪声解析梯度的替代品。
 *
 * 原版逐片元算 5 个 band 的 simplexGradient(解析导数);WebGPU/TSL 下移植
 * simplex 成本高,而"碎波"本质是一张**无特征方向、无重复感**的坡度场 ——
 * 用 CPU 预生成一张可平铺的坡度纹理,shader 里按 band 旋转/缩放/滚动采样,
 * 观感与 simplex 细节几乎无差,成本却低一个数量级。
 *
 * 可平铺的诀窍:所有波的频率向量都取**整数**(m, n),高度场 h(x,y) 在 [0,TILE)²
 * 上严格周期 —— 不需要 4D simplex 环面采样那套重活。
 */
import * as THREE from 'three'

/** 贴图覆盖的世界尺寸(旧单位):band 的采样频率由 TILE 决定 */
export const RIPPLE_TILE = 24

/** 单个波:整数频率向量 + 振幅 + 相位 */
interface Wave {
  mx: number
  my: number
  amp: number
  phase: number
}

/** 确定性伪随机(同种子同海面,改参数对比时不会"海面变了") */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 波谱:整数频率 |k| ∈ [2, 26],幅度 ∝ |k|^-1.35(能量随频率衰减,
 * 对应真实海谱的饱和段),方向均匀随机 —— 与 simplex 的各向同性一致。
 */
function buildWaves(count: number, seed: number): Wave[] {
  const rand = mulberry32(seed)
  const waves: Wave[] = []
  for (let i = 0; i < count; i += 1) {
    const mx = Math.round(rand() * 24 + 2) * (rand() < 0.5 ? -1 : 1)
    const my = Math.round(rand() * 24 + 2) * (rand() < 0.5 ? -1 : 1)
    const k = Math.hypot(mx, my)
    waves.push({ mx, my, amp: 1 / Math.pow(k, 1.35), phase: rand() * Math.PI * 2 })
  }
  return waves
}

/**
 * 生成 RGBA 坡度贴图:R = dh/dx,G = dh/dy,B = 高度(留作波峰亮边),A = 1。
 * 梯度用解析导数(不是差分),法线因此与原版一样"干净"。
 */
export function createRippleTexture(size = 256, waveCount = 96): THREE.DataTexture {
  const waves = buildWaves(waveCount, 20261021)
  const data = new Float32Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x / size) * Math.PI * 2
      const v = (y / size) * Math.PI * 2
      let hx = 0
      let hy = 0
      let h = 0
      for (const w of waves) {
        const angle = w.mx * u + w.my * v + w.phase
        const cos = Math.cos(angle)
        h += w.amp * Math.sin(angle)
        hx += w.amp * w.mx * cos
        hy += w.amp * w.my * cos
      }
      const o = (y * size + x) * 4
      data[o] = hx
      data[o + 1] = hy
      data[o + 2] = h
      data[o + 3] = 1
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}
