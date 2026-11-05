/**
 * 海湾场景的天空 —— firstapp `water-sky/materials/sky.ts` 的 TSL 版。
 *
 * 为什么必须重写:three-demo 用的是 `WebGPURenderer`,而 GLSL `ShaderMaterial`
 * 在 WebGPU 后端不可用(firstapp 用 WebGLRenderer 才有那个前提)。所以把天空的
 * 解析式翻译成 `three/tsl` 节点;同一份 `skyColorNode` 也被海面材质复用来算
 * 反射方向上的天色 —— 天空与水面共享同一个太阳方向和云层,与上游一致。
 *
 * 相对上游的降级:
 *   - 云层 FBM 7 octave → 3 octave(天空占屏比例小,肉眼无差);
 *   - 保留日落混合项但默认 sunset = 0(白天),参数留着以后接滑杆。
 *
 * ⚠️ TS 类型:TSL 节点类型极长,内部一律用 `any` 承接再在边界收口 ——
 * 这里要的是着色器表达式正确,不是把节点类型在 TS 里复刻一遍。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn,
  dot,
  exp,
  float,
  fract,
  max,
  mix,
  normalize,
  positionLocal,
  pow,
  sin,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'

/** 天空/水面/太阳灯共用的时间与大气参数(场景只有一份,模块级足够) */
export const skyTime = uniform(0) as any
export const skySunHeight = uniform(0.58) as any
export const skyCloudDensity = uniform(0.76) as any
export const skySunset = uniform(0) as any
/** 夜晚系数 0~1:压暗天空/云/雾、点亮星空与月亮(海面材质也读它同步夜化) */
export const skyNight = uniform(0) as any

/** 太阳方向:光照与海面反射共用,改这里两处一起变 */
export function sunDirectionFor(sunHeight: number): THREE.Vector3 {
  return new THREE.Vector3(0.3, Math.max(0.12, sunHeight), -0.76).normalize()
}

/** sRGB → 线性(常量,编译期折叠),对应上游 `skyLinear` */
function srgb(r: number, g: number, b: number): any {
  return vec3(Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2))
}

const hash21 = Fn(([p]: any) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453))) as any

/** 值噪声(双线性 + smoothstep 插值) */
const noise2 = Fn(([p]: any) => {
  const i = p.floor()
  const f = p.fract()
  const u = f.mul(f).mul(float(3).sub(f.mul(2)))
  const a = hash21(i)
  const b = hash21(i.add(vec2(1, 0)))
  const c = hash21(i.add(vec2(0, 1)))
  const d = hash21(i.add(vec2(1, 1)))
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y)
}) as any

/** 3 octave FBM(上游 7 octave 的轻量版) */
const fbm = Fn(([p]: any) => {
  const a = noise2(p)
  const b = noise2(p.mul(2.07).add(vec2(12.7, 8.9)))
  const c = noise2(p.mul(4.29).add(vec2(31.3, 5.1)))
  return a.mul(0.57).add(b.mul(0.29)).add(c.mul(0.14))
}) as any

/**
 * 天空颜色:输入单位方向,输出线性色。
 *
 * 结构与上游一致:高度渐变 → 云层遮蔽 → 地平线雾 → 太阳三层光斑。
 * 海面按反射方向调用本函数,所以海天线、云影与高光天然对得上。
 */
export const skyColorNode = Fn(([dir]: any) => {
  const d = normalize(dir)
  const height = max(d.y, 0)
  const sunDir = normalize(vec3(0.3, max(float(0.12), skySunHeight), -0.76))
  const alignment = max(dot(d, sunDir), 0)

  const horizon = mix(srgb(0.66, 0.72, 0.78), srgb(1.0, 0.4, 0.14), skySunset)
  const zenith = mix(srgb(0.19, 0.4, 0.62), srgb(0.13, 0.11, 0.3), skySunset)
  let col = mix(horizon, zenith, smoothstep(float(0.015), mix(float(0.7), float(0.34), skySunset), height))

  // 云层:把方向投影到"云盖"上采样,远处云自然压成层状地平线
  const p = d.xz.div(height.add(0.16)).mul(1.3).add(vec2(skyTime.mul(0.0016), skyTime.mul(-0.001)))
  const broad = fbm(p.mul(1.55).add(vec2(1.7, 8.3)))
  const detail = fbm(p.mul(10.5).add(vec2(13.1, 3.7)))
  const density = broad
    .mul(0.82)
    .add(detail.mul(0.18))
    .add(float(0.045))
    .add(skyCloudDensity.sub(0.76).mul(0.31))
  const mask = smoothstep(float(0.47), float(0.58), density).mul(
    smoothstep(float(0.01), float(0.085), height),
  )
  const shaded = fbm(p.mul(1.55).add(vec2(1.86, 8.42)))
  const relief = smoothstep(
    float(0.0),
    float(1.0),
    broad.sub(shaded).mul(4).add(detail.mul(0.3)).add(0.35),
  )
  const cloud = mix(
    mix(srgb(0.51, 0.57, 0.65), srgb(0.19, 0.1, 0.15), skySunset),
    mix(srgb(0.94, 0.95, 0.97), srgb(1.0, 0.44, 0.13), skySunset),
    relief,
  )
  col = mix(col, cloud, mask)

  // 地平线雾:海天能"接上"全靠这一层
  const haze = exp(height.mul(-28))
  col = mix(col, mix(srgb(0.68, 0.74, 0.78), srgb(1.0, 0.45, 0.2), skySunset), haze.mul(0.6))

  // 夜晚:昼间/黄昏的天色整体压成深蓝夜色,云影与地平线雾一起暗下去
  col = mix(
    col,
    col.mul(vec3(0.05, 0.075, 0.17)).add(vec3(0.006, 0.009, 0.02)),
    skyNight,
  ) as any

  // 星空:云盖同款投影平面上的稀疏亮点(格心小圆点),云遮星、地平线淡出、微微闪烁
  const starGrid = d.xz.div(height.add(0.16)).mul(52)
  const starCell = hash21(starGrid.floor())
  const starDot = starGrid.fract().sub(0.5)
  const star = smoothstep(float(0.05), float(0.008), dot(starDot, starDot))
    .mul(step(float(0.994), starCell))
    .mul(sin(skyTime.mul(float(1.7)).add(starCell.mul(60))).mul(0.3).add(0.7))
    .mul(smoothstep(float(0.02), float(0.2), height))
    .mul(mask.oneMinus())
  col = col.add(vec3(0.85, 0.9, 1.0).mul(star.mul(skyNight).mul(1.4))) as any

  // 太阳(白天/黄昏)与月亮(夜)共享同一方向:夜里弥散光换成冷蓝月晕,亮核收小变白
  col = col.add(
    mix(
      mix(vec3(0.42, 0.43, 0.42), vec3(1.0, 0.4, 0.11), skySunset),
      vec3(0.3, 0.36, 0.55),
      skyNight,
    )
      .mul(pow(alignment, 22))
      .mul(mask.oneMinus().mul(0.36).oneMinus()),
  ) as any
  col = col.add(
    mix(vec3(0.6), vec3(0.55, 0.62, 0.8), skyNight)
      .mul(pow(alignment, 320))
      .mul(mix(float(1), float(0.5), skyNight)),
  )
  col = col.add(mix(vec3(2.0), vec3(1.4, 1.5, 1.8), skyNight).mul(pow(alignment, 6000)))
  return col
}) as any

export interface SkyDome {
  mesh: THREE.Mesh
  update(timeSeconds: number): void
  /** 穹顶跟相机:球心永远在视点,否则走远了会撞到球壁 */
  follow(eye: THREE.Vector3): void
  dispose(): void
}

export function createSkyDome(radius: number): SkyDome {
  const material = new MeshBasicNodeMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  })
  material.colorNode = skyColorNode(normalize(positionLocal))

  const geometry = new THREE.SphereGeometry(radius, 64, 32)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'bay-sky-dome'
  // 穹顶永远包住相机,剔除一次就再也画不出来
  mesh.frustumCulled = false

  return {
    mesh,
    update(timeSeconds) {
      skyTime.value = timeSeconds
    },
    follow(eye) {
      mesh.position.copy(eye)
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
