/**
 * 海湾布景 —— three-demo 的默认场景(firstapp「海湾竞速」的静态部分)。
 *
 * 只搬"世界",不搬玩法:天空穹顶 + 海面 + 跨海大桥。车辆、竞速 HUD、天气、
 * 车辆物理一律不要 —— 这一页的主角仍是无人机,布景层与 `demo-scenery.ts` 同角色:
 * 往里加可看的东西 + 交出避障 AABB,删掉它沙盒功能照旧。
 *
 * 尺寸取自 firstapp 的旧单位常量(见 units.ts):桥长 596m、桥面宽 22m、
 * 桥塔高 46m、桥面离海 11m —— 与无人机沙盒的 4000m 底板同一量级。
 *
 * ⚠️ 天空球与海面都**跟着相机走**:three-demo 的相机 far 只有 1000m,
 * 5500m 的原始尺寸会被裁掉(表现为天空黑洞/海面边缘露底),所以按 700m 穹顶 +
 * 1800m 海面收缩,靠世界空间采样的波浪保证移动网格看不出接缝。
 */
import * as THREE from 'three'
import type { ObstacleBox } from '@/lib'
import { createBridge } from './bridge'
import { createCentreline } from './centreline'
import { createSkyDome, type SkyDome } from './bay-sky'
import { skySunHeight, skySunset, skyNight } from './bay-sky'
import type { MedianLampGroup, LampTimeOfDay } from './medianLamps'
import { createWaterSurface, type WaterSurface } from './bay-water'
import { createFallbackSkyDome, createFallbackWaterSurface } from './bay-fallback'
import type { DroneRendererKind } from '@/lib/drone-camera/drone-renderer'
import { fromLegacyUnits as legacy } from './units'
import { DECOR_REFLECT_LAYER } from './reflect-layer'

/** 桥体参数(旧单位换算后):与 firstapp 默认桥一致 */
const BRIDGE_LENGTH = legacy(2600)
const BRIDGE_TURN = 42
const BRIDGE_Z = legacy(-900)
const DECK_WIDTH = legacy(96)
const TOWER_HEIGHT = legacy(200)
const DECK_HEIGHT = legacy(48)
/**
 * 路面顶面的世界高度(bridge.ts 里 deckTop + 路面层厚,约 11.9m)。
 *
 * 整座桥按这个值**下沉**:沙盒把 y=0 当作"地面"(sim.position.y 是相对起飞点的
 * AGL,降落也收在 0),所以让路面顶正好落在 y=0,机体摆在桥上就等于站在地面上,
 * 起飞/降落/返航点语义全都自洽。海面随之落到 y ≈ -11.9。
 */
const ROAD_TOP = DECK_HEIGHT + legacy(3) + legacy(1)
/** 水面略高于库的网格线(粗网格 y=0.004),否则海面上会浮着一层网格 */
const WATER_LEVEL = -ROAD_TOP + 0.012
const SKY_RADIUS = 700
const WATER_SIZE = 1800

export interface BaySceneryCounts {
  bridgeMeshes: number
  waterSegments: number
}

/** 机体起点:同向第一条车道中心(不是桥面正中,那里是绿化隔离带) */
export interface BaySpawn {
  x: number
  z: number
  /** 机体朝向(罗盘角,度):沿桥面走向 */
  heading: number
}

/** 场景时段:白天 / 黄昏 / 夜晚(与路灯的 LampTimeOfDay 同一词汇表) */
export type BayTimeOfDay = LampTimeOfDay


export class BayScenery {
  static dressingDisabled = new URLSearchParams(window.location.search).get('dressing') === '0'
  /** 全部布景挂在同一个 Group 下,销毁时整层摘掉 */
  readonly group = new THREE.Group()
  /** 参与避障的 AABB:桥塔 4 根 + 桥面。水面不算(贴海飞不该被刹停) */
  readonly footprints: ObstacleBox[] = []
  readonly counts: BaySceneryCounts = { bridgeMeshes: 0, waterSegments: 0 }

  private readonly sky: SkyDome
  private readonly water: WaterSurface
  private readonly bridge: THREE.Group
  private readonly eye = new THREE.Vector3()
  /** 桥面中心点(机体起点) */
  readonly spawn: BaySpawn
  private elapsed = 0

  constructor(
    scene: THREE.Scene,
    /** 渲染后端:'webgpu'(默认,走 TSL 材质)或 'webgl'(降级为普通材质) */
    rendererKind: DroneRendererKind = 'webgpu',
  ) {
    this.group.name = 'bay-scenery'
    // 传统 WebGLRenderer 跑不了 NodeMaterial(TSL),二选一;接口同构,其余代码无感
    const tsl = rendererKind !== 'webgl'
    this.sky = tsl ? createSkyDome(SKY_RADIUS) : createFallbackSkyDome(SKY_RADIUS)
    this.water = tsl
      ? createWaterSurface({ size: WATER_SIZE, segments: 256, level: WATER_LEVEL })
      : createFallbackWaterSurface({ size: WATER_SIZE, segments: 200, level: WATER_LEVEL })

    this.bridge = createBridge({
      // 与 firstapp race/config.ts 的 TRACK_OPTIONS 对齐(长度/宽度/塔高/索数),
      // 并开启隔离带绿植(行道树 + 路灯 + 中国结挂饰,异步加载)。
      length: BRIDGE_LENGTH,
      turn: BRIDGE_TURN,
      position: [0, 0, BRIDGE_Z],
      deckWidth: DECK_WIDTH,
      laneCount: 4,
      medianWidth: legacy(6),
      plantedMedian: true,
      towerHeight: TOWER_HEIGHT,
      cableCount: 5,
      railingHeight: legacy(7),
    })
    // 下沉,使路面顶 = y0(见 ROAD_TOP 说明)
    this.bridge.position.y -= ROAD_TOP
    this.group.add(this.bridge)
    this.group.add(this.sky.mesh)
    this.group.add(this.water.mesh)

    this.bridge.traverse((object) => {
      if (object instanceof THREE.Mesh) this.counts.bridgeMeshes += 1
    })
    this.counts.waterSegments = 256
    this.spawn = this.resolveSpawn()
    this.collectFootprints()

    scene.add(this.group)
    // 首帧先把天空/海面摆到原点,避免开局那一瞬看到"穹顶偏在一边"
    this.update(0)
  }

  /**
   * 桥面「同向第一条车道」中心 → 机体起点(世界坐标,x 东 / z 南;y 恒为 0,即路面顶)
   *
   * ⚠️ 中心线的正中是**绿化隔离带**:花坛床面比路面高 1.58m,上面还有行道树与路灯,
   * 机体按中心线落位等于骑在花坛里。所以沿 lateral 偏出「隔离带半宽 + 半个车道宽」,
   * 落在右侧(同向)第一条车道的正中 —— 既在路面上,又贴着全桥的中间。
   * 车道尺寸取自 bridge 的 userData(桥宽/车道数改了这里自动跟着走,不写死数字)。
   */
  private resolveSpawn(): BaySpawn {
    const centreline = createCentreline(BRIDGE_LENGTH, BRIDGE_TURN)
    const mid = centreline.frameAtDistance(BRIDGE_LENGTH / 2)
    const metrics = this.bridge.userData.bridge as
      | { medianWidth: number; laneWidth: number }
      | undefined
    const laneOffset = metrics ? metrics.medianWidth / 2 + metrics.laneWidth / 2 : 0
    return {
      x: mid.position.x + mid.lateral.x * laneOffset,
      z: mid.position.z + BRIDGE_Z + mid.lateral.z * laneOffset,
      heading: (((mid.heading * 180) / Math.PI) % 360 + 360) % 360,
    }
  }

  /**
   * 每帧调用:推进波浪动画,并把天空/海面钉到相机脚下。
   *
   * 相机传空时只推进动画 —— 首帧构造阶段还没有相机,不能因此抛错。
   */
  update(deltaSeconds: number, camera?: THREE.Camera): void {
    if (Number.isFinite(deltaSeconds)) this.elapsed += deltaSeconds
    if (camera) {
      camera.getWorldPosition(this.eye)
      // 主相机要能看到装饰剔除层(反射相机不看它,见 reflect-layer.ts)
      camera.layers.enable(DECOR_REFLECT_LAYER)
    }
    this.sky.follow(this.eye)
    this.sky.update(this.elapsed)
    this.water.follow(this.eye.x, this.eye.z)
    this.water.update(this.elapsed)
    this.applyDecorLayers()
    // ?dressing=0 诊断开关:跳过路灯/中国结的每帧更新
    if (!BayScenery.dressingDisabled) this.updateMedianDressing()
  }

  /**
   * 时段切换:白天 / 黄昏 / 夜晚。
   *
   * 只改 sky 模块的 uniform 与路灯的自发光 —— 数值变化**不重建任何管线**
   * (WebGPU 的 RenderObject 按 (object,material,renderContext,lightsNode) 缓存,
   * uniform 改值走缓存路径,不会重蹈"点跟随卡死"的编译爆发),所以可以随便切。
   * 桥面直射光与环境漫射由宿主(demo 页)同步调整,见 use-three-demo 的 setDayPhase。
   */
  setTimeOfDay(phase: BayTimeOfDay): void {
    skySunset.value = phase === 'dusk' ? 1 : 0
    skyNight.value = phase === 'night' ? 1 : 0
    // 太阳高度:白天 0.58 / 黄昏贴地平线 0.12 / 夜晚把"月亮"挂在 0.45
    skySunHeight.value = { day: 0.58, dusk: 0.12, night: 0.45 }[phase]
    // 路灯组是异步装配的(GLB 到位才 add),还没建出来时静默跳过 —— 下次切换自然补上
    const lamps = this.bridge.getObjectByName('median-street-lamps') as MedianLampGroup | null
    lamps?.setTimeOfDay(phase)
  }

  /**
   * 装饰(树/路灯/中国结)挂到反射剔除层。
   *
   * 装饰组都是异步装配(GLB/FBX 到位后才 add 子对象),所以用"子对象数量连续两帧
   * 不变即收敛"的策略:收敛前每帧扫一遍(开销可忽略),收敛后零开销。
   */
  private decorLayered = false
  private decorLayerSignature = ''

  private applyDecorLayers(): void {
    if (this.decorLayered) return
    const names = ['median-trees', 'median-street-lamps', 'street-lamp-chinese-knots']
    let signature = ''
    for (const name of names) {
      const group = this.bridge.getObjectByName(name)
      if (!group) return // 有组还没建出来,等下一帧
      signature += `${group.children.length},`
      group.traverse((object) => object.layers.set(DECOR_REFLECT_LAYER))
    }
    if (signature === this.decorLayerSignature) this.decorLayered = true
    this.decorLayerSignature = signature
  }

  /**
   * 隔离带装饰的每帧更新:路灯按观察者距离点亮最近的 4 对,中国结按距离换 LOD。
   * medianLamps.updateLighting 内部会联动中国结的 updateDetail(同一观察者),
   * 所以这里只需要找到灯组并调这一个方法。灯组由 createBridge 同步挂入,
   * 但为稳妥仍按帧懒查找,首次命中后缓存。
   */
  private lampsGroup: (THREE.Group & {
    updateLighting(viewerWorldPosition: THREE.Vector3): void
  }) | null = null

  private updateMedianDressing(): void {
    if (!this.lampsGroup) {
      const found = this.bridge.getObjectByName('median-street-lamps') as
        | BayScenery['lampsGroup']
        | undefined
      if (!found || typeof found.updateLighting !== 'function') return
      this.lampsGroup = found
    }
    this.lampsGroup.updateLighting(this.eye)
  }

  dispose(): void {
    this.sky.dispose()
    this.water.dispose()
    // 桥的几何/材质由 createBridge 内部创建,clear() 不会释放,这里逐个收
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    this.bridge.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      geometries.add(object.geometry)
      const owned = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of owned) materials.add(material)
    })
    geometries.forEach((geometry) => geometry.dispose())
    materials.forEach((material) => material.dispose())
    this.group.removeFromParent()
    this.group.clear()
  }

  /** 避障盒:桥塔逐根给精确 AABB,桥面用整体长条(下方留出可钻的净空) */
  private collectFootprints(): void {
    const centreline = createCentreline(BRIDGE_LENGTH, BRIDGE_TURN)
    const legOffset = DECK_WIDTH / 2 + legacy(7)
    const towerHalf = legacy(15) / 2
    // 桥体整体下沉了 ROAD_TOP,避障盒跟着减,否则会悬在半空
    const towerTop = DECK_HEIGHT + legacy(3) + legacy(1.2) + TOWER_HEIGHT - ROAD_TOP

    // 两座桥塔,每座两根立柱(与 bridge.ts 的 towerTs / side 一致)
    for (const t of [0.24, 0.76]) {
      const frame = centreline.frameAtDistance(t * BRIDGE_LENGTH)
      for (const side of [1, -1]) {
        const cx = frame.position.x + frame.lateral.x * side * legOffset
        const cz = frame.position.z + frame.lateral.z * side * legOffset + BRIDGE_Z
        this.footprints.push({
          name: 'bridge-tower',
          minX: cx - towerHalf,
          maxX: cx + towerHalf,
          minY: -ROAD_TOP,
          maxY: towerTop,
          minZ: cz - towerHalf,
          maxZ: cz + towerHalf,
          solid: true,
        })
      }
    }

    // 桥面:弯曲 42° 的 596m 长条,用整体包围盒;底面留到水面上方,桥洞下面仍可飞
    // ⚠️ 避障射线会把盒子按 1.6m 探测半径膨胀(rayBoxDistance),所以这里不能
    // 贴着路面顶(y=0)给盒 —— 否则膨胀后罩住桥面上方 1.6m,起飞到 1.2m 就被
    // 判"前方有障碍"刹停,沿桥飞不动。压成贴桥板下缘的薄板:膨胀后顶面在
    // y≈0.6,1.2m 起飞高度可正常沿桥前飞;俯冲到 0.6m 内仍会被挡,防穿桥板。
    const deckBottom = DECK_HEIGHT - legacy(2) - ROAD_TOP
    const deckTop = deckBottom + 0.4
    this.footprints.push({
      name: 'bridge-deck',
      minX: -BRIDGE_LENGTH / 2,
      maxX: BRIDGE_LENGTH / 2,
      minY: deckBottom,
      maxY: deckTop,
      minZ: BRIDGE_Z - legacy(30),
      maxZ: BRIDGE_Z + legacy(70),
      solid: true,
    })
  }
}
