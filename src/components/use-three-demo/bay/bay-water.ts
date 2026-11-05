/**
 * 海面 —— firstapp `water-sky/materials/water.ts` 的 TSL 版。
 *
 * 保留的视觉要素(这几项决定"像不像海"):
 *   1. 4 组不同频率/朝向的涌浪,在**世界空间**采样 → 网格跟着相机平移也不会"滑动";
 *   2. 碎波细节:CPU 预生成的可平铺坡度贴图(ripple-texture.ts)按 5 个 band
 *      旋转/缩放/滚动采样 —— 替代原版的逐片元 simplex 解析梯度,观感一致、成本低一个量级;
 *   3. **桥体镜面倒影**:ReflectorNode 把场景镜像渲到贴图,按波浪坡度扰动采样,
 *      等价于原版的 mirror pass(桥塔/桥面/机体都会倒映在水里);
 *   4. 按反射方向实时求天空色(复用 skyColorNode,云和太阳共享方向);
 *   5. 菲涅尔 + 太阳双幂次高光(近处"碎金"远处柔和)+ 波峰亮边 + 距离雾。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  max,
  min,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  reflect,
  reflector,
  sin,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { LEGACY_UNITS_PER_METRE } from './units'
import { RIPPLE_TILE, createRippleTexture } from './ripple-texture'
import { skyColorNode, skyNight } from './bay-sky'
import { decorLayerMask } from './reflect-layer'

const LEGACY = LEGACY_UNITS_PER_METRE

/** 水面参数(与上游同名):只在建材质时读一次,改它需要重建材质 */
const intensity = uniform(0.45) as any
const wind = uniform(0.35) as any
/** 顶点位移与片元着色共用这一份时间,否则波峰会与法线错位 */
const waterTime = uniform(0) as any

/** 风速对波纹相位的加成(上游:`1 + (wind - .35) * .8`) */
function gust(): any {
  return wind.sub(0.35).mul(0.8).add(1.0)
}

/**
 * 涌浪场:返回 vec3(x = 高度, yz = d(高度)/d(xz))。
 *
 * 4 组正弦,振幅递减、频率递增,相位含时间与风 —— 与上游参数逐项对齐
 * (频率 .52/.19、-.17/.43、.91/-.67、-1.37/-.21;振幅 .052/.037/.017/.009)。
 * `p` 是旧单位坐标,所以高度/梯度也是旧单位,调用方负责换算。
 */
const swellField = Fn(([p]: any) => {
  const t = waterTime
  const swell = (freqX: number, freqY: number, amp: number, phase: any) => {
    const freq = vec2(freqX, freqY)
    const angle = dot(p, freq).add(phase)
    return { h: sin(angle).mul(amp), g: cos(angle).mul(amp).mul(freq) }
  }
  const s1 = swell(0.52, 0.19, 0.052, t.mul(float(0.63).add(wind.mul(0.22))))
  const s2 = swell(-0.17, 0.43, 0.037, t.mul(float(0.37).add(wind.mul(0.16))).negate().add(1.7))
  const s3 = swell(0.91, -0.67, 0.017, t.mul(float(0.29).add(wind.mul(0.11))).add(2.4))
  const s4 = swell(-1.37, -0.21, 0.009, t.mul(0.19).negate().add(4.1))
  return vec3(
    s1.h.add(s2.h).add(s3.h).add(s4.h).mul(intensity),
    s1.g.add(s2.g).add(s3.g).add(s4.g).mul(intensity),
  )
}) as any

/** 碎波坡度贴图(全模块共享一张;RepeatWrapping + mipmap 天然抗锯齿) */
const rippleTexture = createRippleTexture()

/**
 * 碎波斜率:5 个 band 采样同一张坡度贴图。
 *
 * 每个 band 有自己的朝向(随风偏转)、频率(0.40→3.83 cycle/unit,与上游一致)、
 * 滚动速度(∝ √频率,模拟色散)与权重(0.86^band)。贴图无缝平铺,
 * 所以不管怎么缩放/旋转都不会露出接缝或重复纹理。
 */
const rippleSlope = Fn(([p]: any) => {
  const t = waterTime
  const freqs = [0.4, 0.74, 1.31, 2.21, 3.83]
  const amps = [0.028, 0.018, 0.011, 0.0065, 0.0038]
  let slopeX: any = float(0)
  let slopeY: any = float(0)
  for (let i = 0; i < freqs.length; i += 1) {
    const band = float(i)
    const heading = wind.mul(0.65).add(sin(band.mul(2.39996).add(0.6)).mul(0.55))
    const dirX = cos(heading)
    const dirY = sin(heading)
    const freq = float(freqs[i] ?? 0.4)
    // 贴图标称主频 ~6 cycle/tile:要 band 频率 f,采样密度 = f·TILE/6
    const uvScale = freq.mul(RIPPLE_TILE / 6)
    // 沿 band 方向的投影坐标 + 横向 0.48 压缩(与上游一致的拉伸波)
    const along = dot(p, vec2(dirX, dirY)).mul(uvScale)
    const across = dot(p, vec2(dirY.negate(), dirX)).mul(uvScale.mul(0.48))
    // 滚动:速度 ∝ √频率 × 风向加成,方向在 band 间错开
    const speed = freq.sqrt().mul(gust()).mul(float(-0.16).add(float(i).mul(0.043)))
    const sampleUv = vec2(along, across)
      .div(RIPPLE_TILE)
      .add(vec2(t.mul(speed), t.mul(speed.mul(0.27)).add(float(i).mul(0.31))))
    // ⚠️ 不对采样结果做 .xy/.rgb swizzle:Tint(Tint IR)对"纹理 swizzle view"
    // 有 lowering bug("swizzle view instruction still has usages"),
    // 用点积取分量是等价且安全的写法。
    const g = texture(rippleTexture, sampleUv)
    const amp = float(amps[i] ?? 0.004)
    slopeX = slopeX.add(dirX.mul(dot(g, vec4(1, 0, 0, 0))).sub(dirY.mul(dot(g, vec4(0, 1, 0, 0)))).mul(amp))
    slopeY = slopeY.add(dirY.mul(dot(g, vec4(1, 0, 0, 0))).add(dirX.mul(dot(g, vec4(0, 1, 0, 0)))).mul(amp))
  }
  return vec2(slopeX, slopeY).mul(intensity.mul(1.8))
}) as any

export interface WaterSurface {
  mesh: THREE.Mesh
  update(timeSeconds: number): void
  /** 有限海面跟着相机走:波浪在世界空间采样,移动网格看不出接缝 */
  follow(x: number, z: number): void
  dispose(): void
}

export interface WaterOptions {
  /** 单边尺寸(米):默认 5500,比天空穹顶略小 */
  size?: number
  /** 网格分段:320² ≈ 10 万顶点,再高只拖慢顶点着色器 */
  segments?: number
  /** 水面高度(米) */
  level?: number
  /** 镜面反射分辨率比例:0.5 已足够 —— 波纹扰动会掩盖低分辨率 */
  reflectionScale?: number
}

/** 海面颜色:光照全部在片元里解析计算(与上游一致,不吃 scene 灯) */
function waterColor(mirror: any): any {
  const t = waterTime
  const world = positionWorld
  const s = vec2(world.x, world.z).mul(LEGACY)
  const swell = swellField(s)
  const distanceToEye = world.distance(cameraPosition).mul(LEGACY)
  // 远处涌浪几何失真,按视距淡出,交给细波纹
  const resolved = smoothstep(float(450), float(1800), distanceToEye).oneMinus()
  const slope = swell.yz.mul(resolved).add(rippleSlope(s))
  const normal = normalize(vec3(slope.x.negate(), 1.0, slope.y.negate()))
  const view = normalize(cameraPosition.sub(world))
  const facing = max(dot(normal, view), 0)
  const fresnel = float(0.02).add(pow(facing.oneMinus(), 5).mul(0.98))

  // 水体颜色:低频明暗区分深水与浅滩(上游用 simplex,这里两组正弦)
  const shoal = sin(s.x.mul(0.0032).add(4.5))
    .add(sin(s.y.mul(0.0027).add(9.1)))
    .mul(0.25)
    .add(0.5)
  const depthChange = smoothstep(float(0.27), float(0.79), shoal)
  const body = mix(vec3(0.012, 0.055, 0.033), vec3(0.05, 0.145, 0.092), depthChange.mul(0.65))

  // 反射方向上的真实天色:海面"是水"的核心
  const sky = skyColorNode(reflect(view.negate(), normal))

  // 俯瞰时反射方向几乎汇成一束,补一层缓慢漂移的云影,否则俯视像灰纸
  const topView = smoothstep(float(0.7), float(0.98), facing)
  const drift = sin(s.x.mul(0.00135).add(t.mul(0.0016)))
    .add(sin(s.y.mul(0.0011).sub(t.mul(0.001))))
    .mul(0.25)
    .add(0.5)
  const projected = mix(
    vec3(0.02, 0.09, 0.16),
    vec3(0.16, 0.2, 0.24),
    smoothstep(float(0.34), float(0.68), drift),
  )
  const reflectionColor = mix(sky, projected, topView.mul(0.65))

  // —— 镜面倒影(等价上游 mirror pass)——
  // 桥塔/桥面/机体被 ReflectorNode 镜像渲到贴图;采样坐标按波浪坡度扰动,
  // 倒影在浪尖上被打碎而不是"画上去的"。远处(>600m)分辨率撑不住,退回解析天空。
  const brokenBySlope = float(1).sub(clamp(slope.length().mul(2.2), float(0), float(0.45)))
  const mirrorFade = smoothstep(float(600), float(1400), distanceToEye).oneMinus()
  const mirrorWeight = brokenBySlope.mul(mirrorFade).mul(0.62)
  const reflected = mix(reflectionColor, mirror.rgb, mirrorWeight)

  const reflectionWeight = clamp(float(0.28).add(fresnel.mul(0.35)), float(0.1), float(0.44))
  let color = mix(body, reflected, reflectionWeight)

  // 太阳高光:近处银光"碎金"(高幂次),远处按视距放宽幂次免得闪成噪点
  const sunDir = normalize(vec3(0.3, 0.58, -0.76))
  const halfDir = normalize(sunDir.add(view))
  const highlight = max(dot(normal, halfDir), 0)
  const unresolved = smoothstep(float(0.15), float(1), positionWorld.distance(cameraPosition).mul(0.02))
  const silver = pow(highlight, mix(float(1900), float(400), unresolved))
  // 夜里换成月光方向高光且大幅衰减(白天银光"碎金",夜晚冷蓝微光)
  color = color.add(
    mix(vec3(0.93, 0.97, 1.0), vec3(0.45, 0.55, 0.85), skyNight)
      .mul(silver.mul(mix(float(0.62), float(0.18), skyNight))),
  )

  // 波峰亮边:坡度大的地方加一线亮色,俯瞰时浪形才读得出来(夜里跟着变暗)
  const crest = smoothstep(float(0.009), float(0.035), slope.length())
  color = color.add(vec3(0.08, 0.11, 0.095).mul(crest.mul(topView).mul(mix(float(1), float(0.4), skyNight))))

  // 夜晚:水体与倒影一起沉进深蓝,只留月光与微弱环境反光
  color = color
    .mul(mix(vec3(1), vec3(0.1, 0.13, 0.26), skyNight))
    .add(vec3(0.002, 0.0035, 0.008).mul(skyNight))

  // 距离雾:远处融进地平线,海天线没有硬边;夜雾跟着天色变深
  const haze = exp(max(distanceToEye.sub(120), 0).mul(-0.0005)).oneMinus()
  return mix(
    color,
    mix(vec3(0.23, 0.33, 0.34), vec3(0.02, 0.035, 0.07), skyNight),
    min(haze.mul(0.9), 0.96),
  )
}

export function createWaterSurface(options: WaterOptions = {}): WaterSurface {
  const size = options.size ?? 5500
  const segments = options.segments ?? 320
  const level = options.level ?? 0

  const material = new MeshBasicNodeMaterial({ fog: false })
  // 镜面反射节点:target 挂在水面 mesh 上,反射平面 = mesh 的局部 XY(已转到水平)
  const mirror = reflector({
    resolutionScale: options.reflectionScale ?? 0.5,
  }) as any
  // 反射相机剔除装饰层:虚拟相机是主相机 clone 的,layers 一并复制,
  // 在这里把装饰层扣掉 —— 树/路灯/中国结不进反射 pass(见 reflect-layer.ts)
  const reflectorBase = mirror.reflector as {
    getVirtualCamera: (camera: THREE.Camera) => THREE.Camera
  }
  const origGetVirtualCamera = reflectorBase.getVirtualCamera.bind(reflectorBase)
  reflectorBase.getVirtualCamera = (camera) => {
    const virtualCamera = origGetVirtualCamera(camera)
    virtualCamera.layers.mask = camera.layers.mask & ~decorLayerMask
    return virtualCamera
  }
  // 顶点抬升:世界空间采样,振幅由旧单位换回米
  const worldPos = positionWorld
  const p = vec2(worldPos.x, worldPos.z).mul(LEGACY)
  material.positionNode = positionLocal.add(vec3(0, swellField(p).x.div(LEGACY), 0))
  material.colorNode = waterColor(mirror)

  const geometry = new THREE.PlaneGeometry(size, size, segments, segments)
  geometry.rotateX(-Math.PI / 2)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'bay-water'
  mesh.position.y = level
  mesh.frustumCulled = false
  // ReflectorNode 需要 target 与反射面同位姿;挂在 mesh 上即继承水平面
  mesh.add(mirror.target)

  return {
    mesh,
    update(timeSeconds) {
      waterTime.value = timeSeconds
    },
    follow(x, z) {
      mesh.position.x = x
      mesh.position.z = z
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
