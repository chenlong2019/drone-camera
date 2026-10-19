/**
 * demo 侧的「内容层」布景 —— 城市建筑群 / 自然地形 / 地面标线 / 地标物。
 *
 * ⚠️ 边界:**这一整套只存在于 demo,不进 `src/lib`**。
 * 库(drone-world)只负责飞控沙盒那层骨架:4000m 底板 + 米级/百米网格 + 返航点 + 可选参考障碍物。
 * 这里加的是「场景里有什么可看/可拍的东西」——用最朴素的 three 搭,与库零耦合:
 *   - 库换渲染器(fly / Cesium)、改面板、改拼接算法,都不影响本文件;
 *   - 本文件删掉,沙盒功能一切照旧(只是画面变空)。
 *
 * 为什么布景要参与避障:建筑/地标会把 AABB 收进 {@link DemoScenery.footprints},
 * 由 demo 侧 push 进 `fly.sim.obstacles`(库内该数组就是 `world.collisionBoxes` 的引用)——
 * 于是**避障刹停、鹰眼图轮廓**能看见 demo 自己搭的楼,不必往库里加一行代码。
 * 树/山丘/地面标线不参与(否则林子里和山坡上会被刹停刹到飞不动)。
 *
 * 全部用确定性随机(mulberry32 + 固定种子),同一次刷新得到同一片布景,便于截图回归比对。
 */
import * as THREE from 'three'
import type { ObstacleBox } from '@/lib'

/** mulberry32:小巧的确定性伪随机,同种子 → 同序列 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 水平面上的矩形占位(用于布景之间的互斥摆放) */
interface Rect {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** 布景统计:验证脚本断言用 */
export interface DemoSceneryCounts {
  buildings: number
  trees: number
  hills: number
  props: number
}

/** 单个布景件的可释放资源 */
interface Disposable {
  dispose(): void
}

export class DemoScenery {
  /** 全部布景挂在同一个 Group 下,销毁时整层摘掉 */
  readonly group = new THREE.Group()
  /** 参与避障的 AABB(建筑 + 地标);demo 侧 push 进 sim.obstacles */
  readonly footprints: ObstacleBox[] = []
  readonly counts: DemoSceneryCounts = { buildings: 0, trees: 0, hills: 0, props: 0 }

  private readonly rng: () => number
  private readonly disposables: Disposable[] = []
  /** 已占位区域:后续布景不得落进来(含各自外扩的间隙) */
  private readonly occupied: Rect[] = []

  constructor(scene: THREE.Scene, seed = 20261014) {
    this.rng = mulberry32(seed)
    this.group.name = 'demo-scenery'

    // 摆放顺序:先定跑道/停机坪与地标(占位)→ 再铺城市 → 再种树 → 最后远山。
    // 后面的每一类都回避前面已占的区域,于是不会出现"楼长在跑道上""树穿过楼"。
    this.buildCityGround()
    this.buildGroundMarkings()
    this.buildLandmarks()
    this.buildCity()
    this.buildForest()
    this.buildHills()

    // 阴影统一开关:逐个 mesh 记容易漏(漏一个,影子就断一截),traverse 一遍全覆盖。
    // 城市地面/建筑/树/地标全部参与投影与接收,清晨低角度长影才完整。
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true
        obj.receiveShadow = true
      }
    })

    scene.add(this.group)
  }

  // ————————————————————————————— 摆放工具 —————————————————————————————

  private range(min: number, max: number): number {
    return min + this.rng() * (max - min)
  }

  private pick<T>(list: readonly T[]): T | undefined {
    if (list.length === 0) return undefined
    const index = Math.min(list.length - 1, Math.floor(this.rng() * list.length))
    return list[index]
  }

  /** 把一块矩形登记为"已占用"(pad 为外扩间隙) */
  private occupy(minX: number, maxX: number, minZ: number, maxZ: number, pad = 0): void {
    this.occupied.push({ minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad })
  }

  /** 该矩形是否与已占位区域相交 */
  private isFree(minX: number, maxX: number, minZ: number, maxZ: number): boolean {
    for (const r of this.occupied) {
      if (maxX > r.minX && minX < r.maxX && maxZ > r.minZ && minZ < r.maxZ) return false
    }
    return true
  }

  private keep<T extends Disposable>(item: T): T {
    this.disposables.push(item)
    return item
  }

  /** 登记一个碰撞盒:AABB + 标签,供避障/鹰眼图使用 */
  private footprint(
    label: string,
    minX: number,
    maxX: number,
    maxY: number,
    minZ: number,
    maxZ: number,
  ): void {
    this.footprints.push({ name: label, minX, maxX, minY: 0, maxY, minZ, maxZ, solid: true })
  }

  // ————————————————————————————— 贴图工厂 —————————————————————————————

  /** 楼体幕墙:深色底 + 一格一格的窗(部分亮暖色),同一张图同时当 map 与 emissiveMap */
  private makeFacadeTexture(): THREE.CanvasTexture {
    const cols = 6
    const rows = 12
    const cell = 32
    const canvas = document.createElement('canvas')
    canvas.width = cols * cell
    canvas.height = rows * cell
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#39424d'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      // 幕墙竖向分隔线:让"层"读得出来
      ctx.fillStyle = '#2b333c'
      for (let r = 0; r <= rows; r += 1) ctx.fillRect(0, r * cell - 1, canvas.width, 3)
      for (let c = 0; c <= cols; c += 1) ctx.fillRect(c * cell - 1, 0, 3, canvas.height)
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const lit = this.rng()
          // 亮窗 ≈ 30%:全亮会像霓虹招牌,全暗又看不出是楼
          ctx.fillStyle = lit > 0.7 ? '#ffd79a' : lit > 0.55 ? '#8fa4b6' : '#1b2229'
          ctx.fillRect(c * cell + 7, r * cell + 8, cell - 14, cell - 16)
        }
      }
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 4
    return this.keep(texture)
  }

  /** 停机坪:H 标 + 圆环 + 虚线环,画满整张方形画布(圆形几何体的 UV 正好把圆铺满) */
  private makeHelipadTexture(): THREE.CanvasTexture {
    const size = 512
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const c = size / 2
      ctx.fillStyle = '#20262c'
      ctx.beginPath()
      ctx.arc(c, c, c - 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#e8eef4'
      ctx.lineWidth = 16
      ctx.beginPath()
      ctx.arc(c, c, c - 22, 0, Math.PI * 2)
      ctx.stroke()
      // 内圈虚线环(航空标线的常见画法)
      ctx.lineWidth = 7
      ctx.setLineDash([26, 20])
      ctx.beginPath()
      ctx.arc(c, c, c - 74, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      // 大 H
      ctx.fillStyle = '#eef3f8'
      const barW = 34
      const barH = 150
      const gap = 66
      ctx.fillRect(c - gap / 2 - barW, c - barH / 2, barW, barH)
      ctx.fillRect(c + gap / 2, c - barH / 2, barW, barH)
      ctx.fillRect(c - gap / 2 - barW, c - 17, gap + barW * 2, 34)
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 4
    return this.keep(texture)
  }

  /** 跑道:沥青底 + 中线虚线段 + 两端横向斑马线 */
  private makeRunwayTexture(): THREE.CanvasTexture {
    const w = 512
    const h = 128
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#23272c'
      ctx.fillRect(0, 0, w, h)
      // 沥青颗粒噪点
      for (let i = 0; i < 2600; i += 1) {
        const g = 30 + Math.floor(this.rng() * 22)
        ctx.fillStyle = `rgb(${g},${g + 2},${g + 4})`
        ctx.fillRect(this.rng() * w, this.rng() * h, 2, 2)
      }
      ctx.fillStyle = '#e6ecf2'
      // 中线虚线(每 3m 一段,这里按画布比例切成 10 段)
      const dash = w / 18
      for (let i = 0; i < 9; i += 1) {
        ctx.fillRect(i * dash * 2 + dash * 0.5, h / 2 - 3, dash, 6)
      }
      // 两端入口斑马线(垂直于跑道方向)
      const stripe = 12
      for (let i = 0; i < 6; i += 1) {
        const y = 16 + i * (stripe + 6)
        ctx.fillRect(18, y, 46, stripe)
        ctx.fillRect(w - 64, y, 46, stripe)
      }
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 4
    return this.keep(texture)
  }

  /** 道路:沥青 + 中央黄虚线。`alongU` 决定虚线沿 U(局部 X)还是 V(局部 Y)方向排 */
  private makeRoadTexture(alongU: boolean): THREE.CanvasTexture {
    // 画布长边恒等于"路的行进方向",虚线就画在长边上 —— 免去贴图旋转,
    // 之后只要按路的尺寸设 repeat,虚线自然铺满整条路
    const w = alongU ? 256 : 64
    const h = alongU ? 64 : 256
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#26292d'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#d9c26a'
      if (alongU) {
        for (let i = 0; i < 8; i += 1) ctx.fillRect(i * 32 + 6, h / 2 - 3, 20, 6)
        ctx.fillStyle = 'rgba(226,232,238,0.35)'
        ctx.fillRect(0, 3, w, 2)
        ctx.fillRect(0, h - 5, w, 2)
      } else {
        for (let i = 0; i < 8; i += 1) ctx.fillRect(w / 2 - 3, i * 32 + 6, 6, 20)
        ctx.fillStyle = 'rgba(226,232,238,0.35)'
        ctx.fillRect(3, 0, 2, h)
        ctx.fillRect(w - 5, 0, 2, h)
      }
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.anisotropy = 4
    return this.keep(texture)
  }

  // ————————————————————————————— 地面标线 —————————————————————————————

  /**
   * 地面层:起飞坪 + 跑道 + 两条十字道路。
   * 全部抬到 y≈0.03,躲开库的底板(y=-0.012)与米级网格(y=0)的同面闪烁。
   */
  /**
   * 城市地面:一块半径 170m 的暖深灰盘,盖住库沙盒的近黑底板(0x0a1216)与网格。
   * 为什么必须盖:沙盒底板是「赛博黑 + 青网格」,与写实城市/真实天空是两套语言,
   * 同框时观众立刻出戏;地面接收 HDRI 天空光的暖色反弹,画面下半部才不再是死黑。
   * y=0.008:盖过细网格(0)/粗网格(0.004),让位给停机坪(0.03)与跑道。
   */
  private buildCityGround(): void {
    const geo = this.keep(new THREE.CircleGeometry(170, 72))
    const mat = this.keep(
      new THREE.MeshStandardMaterial({
        color: 0x2a2d28,
        roughness: 0.96,
        metalness: 0.0,
      }),
    )
    const ground = new THREE.Mesh(geo, mat)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = 0.008
    ground.receiveShadow = true
    ground.name = 'SCENERY_CITY_GROUND'
    this.group.add(ground)
    this.counts.props += 1
  }

  private buildGroundMarkings(): void {
    // 起飞坪——就压在起飞点(原点)上,舱内/地面视角拍全景时脚下有内容
    const padRadius = 6.5
    const padGeo = this.keep(new THREE.CircleGeometry(padRadius, 56))
    const padMat = this.keep(
      new THREE.MeshStandardMaterial({
        map: this.makeHelipadTexture(),
        roughness: 0.88,
        metalness: 0.02,
      }),
    )
    const pad = new THREE.Mesh(padGeo, padMat)
    pad.rotation.x = -Math.PI / 2
    pad.position.y = 0.03
    pad.name = 'SCENERY_HELIPAD'
    this.group.add(pad)
    this.counts.props += 1

    // 跑道:沿 X 铺,放在 z=+96;横跨 120m × 16m
    const runwayZ = 96
    const runwayGeo = this.keep(new THREE.PlaneGeometry(120, 16))
    const runwayMat = this.keep(
      new THREE.MeshStandardMaterial({
        map: this.makeRunwayTexture(),
        roughness: 0.92,
        metalness: 0.02,
      }),
    )
    const runway = new THREE.Mesh(runwayGeo, runwayMat)
    runway.rotation.x = -Math.PI / 2
    runway.position.set(0, 0.028, runwayZ)
    runway.name = 'SCENERY_RUNWAY'
    this.group.add(runway)
    this.counts.props += 1
    // 跑道走廊 + 两端进近净空:禁止摆楼(留出 60m 长的空域)
    this.occupy(-64, 64, runwayZ - 9, runwayZ + 9, 4)

    // 两条十字道路(东西 / 南北各一条),给城市一个骨架。
    // PlaneGeometry 的 U 轴 = 局部 X = 世界 X,V 轴 = 局部 Y = 世界 -Z:
    // 所以 alongX 的路取 (len, 9) 且虚线沿 U,alongZ 的路取 (9, len) 且虚线沿 V。
    const roads: Array<{ x: number; z: number; len: number; along: 'x' | 'z' }> = [
      { x: 0, z: -58, len: 240, along: 'x' },
      { x: 62, z: 0, len: 260, along: 'z' },
    ]
    for (const road of roads) {
      const alongX = road.along === 'x'
      const texture = this.makeRoadTexture(alongX)
      // 每 8m 一个循环,让虚线间距与米级网格同量级
      if (alongX) texture.repeat.set(Math.round(road.len / 8), 1)
      else texture.repeat.set(1, Math.round(road.len / 8))
      const material = this.keep(
        new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, metalness: 0.02 }),
      )
      const geo = this.keep(new THREE.PlaneGeometry(alongX ? road.len : 9, alongX ? 9 : road.len))
      const mesh = new THREE.Mesh(geo, material)
      mesh.rotation.x = -Math.PI / 2
      mesh.position.set(road.x, 0.026, road.z)
      mesh.name = 'SCENERY_ROAD'
      this.group.add(mesh)
      this.counts.props += 1
      if (alongX) this.occupy(road.x - road.len / 2, road.x + road.len / 2, road.z - 5, road.z + 5, 2)
      else this.occupy(road.x - 5, road.x + 5, road.z - road.len / 2, road.z + road.len / 2, 2)
    }
  }

  // ————————————————————————————— 地标物 —————————————————————————————

  /** 用一根根"杆"拼格构塔/拱/雕塑:单位圆柱 + InstancedMesh,每根给一条 matrix */
  private addStruts(
    segments: Array<[THREE.Vector3, THREE.Vector3]>,
    radius: number,
    material: THREE.Material,
    name: string,
  ): void {
    if (segments.length === 0) return
    const geo = this.keep(new THREE.CylinderGeometry(1, 1, 1, 6))
    const mesh = new THREE.InstancedMesh(geo, material, segments.length)
    const matrix = new THREE.Matrix4()
    const quat = new THREE.Quaternion()
    const mid = new THREE.Vector3()
    const dir = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    const scale = new THREE.Vector3()
    segments.forEach(([a, b], index) => {
      dir.subVectors(b, a)
      const length = dir.length()
      if (length < 1e-4) return
      mid.addVectors(a, b).multiplyScalar(0.5)
      quat.setFromUnitVectors(up, dir.normalize())
      scale.set(radius, length, radius)
      matrix.compose(mid, quat, scale)
      mesh.setMatrixAt(index, matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.name = name
    this.group.add(mesh)
  }

  /** 铁塔 + 拱门 + 雕塑:三个高辨识度大物件,给全景/环绕拍摄当视觉锚点 */
  private buildLandmarks(): void {
    const steel = this.keep(
      new THREE.MeshStandardMaterial({ color: 0x93a2ad, roughness: 0.45, metalness: 0.72 }),
    )
    const brass = this.keep(
      new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.28, metalness: 0.9 }),
    )
    const concrete = this.keep(
      new THREE.MeshStandardMaterial({ color: 0x6d7681, roughness: 0.85, metalness: 0.05 }),
    )

    // —— ① 四脚格构塔(通信塔):锥形收口 + 5 道横撑 + 塔顶天线 + 航空障碍灯
    const towerX = -58
    const towerZ = -62
    const towerH = 44
    const baseHalf = 5.6
    const topHalf = 1.5
    const legs: Array<[THREE.Vector3, THREE.Vector3]> = []
    const corners: Array<[number, number]> = [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]
    const halfAt = (t: number): number => baseHalf + (topHalf - baseHalf) * t
    for (const [sx, sz] of corners) {
      legs.push([
        new THREE.Vector3(towerX + sx * baseHalf, 0, towerZ + sz * baseHalf),
        new THREE.Vector3(towerX + sx * topHalf, towerH, towerZ + sz * topHalf),
      ])
    }
    for (const t of [0.18, 0.38, 0.58, 0.78, 0.95]) {
      const half = halfAt(t)
      const y = towerH * t
      const ring: Array<[number, number]> = [
        [1, 1],
        [1, -1],
        [-1, -1],
        [-1, 1],
      ]
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i]
        const b = ring[(i + 1) % ring.length]
        if (!a || !b) continue
        legs.push([
          new THREE.Vector3(towerX + a[0] * half, y, towerZ + a[1] * half),
          new THREE.Vector3(towerX + b[0] * half, y, towerZ + b[1] * half),
        ])
      }
    }
    // 塔顶桅杆
    legs.push([
      new THREE.Vector3(towerX, towerH, towerZ),
      new THREE.Vector3(towerX, towerH + 9, towerZ),
    ])
    this.addStruts(legs, 0.34, steel, 'SCENERY_TOWER')

    const beaconGeo = this.keep(new THREE.SphereGeometry(0.45, 12, 10))
    const beaconMat = this.keep(
      new THREE.MeshStandardMaterial({ color: 0xff4d4d, emissive: 0xff2222, emissiveIntensity: 2.2 }),
    )
    const beacon = new THREE.Mesh(beaconGeo, beaconMat)
    beacon.position.set(towerX, towerH + 9.4, towerZ)
    beacon.name = 'SCENERY_TOWER_BEACON'
    this.group.add(beacon)
    this.counts.props += 1
    this.footprint('布景·铁塔', towerX - baseHalf, towerX + baseHalf, towerH, towerZ - baseHalf, towerZ + baseHalf)
    this.occupy(towerX - baseHalf, towerX + baseHalf, towerZ - baseHalf, towerZ + baseHalf, 6)

    // —— ② 半圆拱门:半径 11 的圆环切上半圈,两端落地
    const archX = 74
    const archZ = -34
    const archGeo = this.keep(new THREE.TorusGeometry(11, 1.05, 10, 40, Math.PI))
    const arch = new THREE.Mesh(archGeo, steel)
    arch.position.set(archX, 0, archZ)
    arch.rotation.y = -Math.PI / 5
    arch.name = 'SCENERY_ARCH'
    this.group.add(arch)
    this.counts.props += 1
    this.footprint('布景·拱门', archX - 12, archX + 12, 13, archZ - 12, archZ + 12)
    this.occupy(archX - 12, archX + 12, archZ - 12, archZ + 12, 4)

    // —— ③ 环形雕塑:混凝土基座 + 黄铜环面纽结
    const knotX = -76
    const knotZ = 38
    const baseGeo = this.keep(new THREE.CylinderGeometry(2.1, 2.7, 1.6, 20))
    const base = new THREE.Mesh(baseGeo, concrete)
    base.position.set(knotX, 0.8, knotZ)
    base.name = 'SCENERY_KNOT_BASE'
    this.group.add(base)
    const knotGeo = this.keep(new THREE.TorusKnotGeometry(2.7, 0.62, 128, 16))
    const knot = new THREE.Mesh(knotGeo, brass)
    knot.position.set(knotX, 5.6, knotZ)
    knot.name = 'SCENERY_KNOT'
    this.group.add(knot)
    this.counts.props += 2
    this.footprint('布景·雕塑', knotX - 3.4, knotX + 3.4, 9, knotZ - 3.4, knotZ + 3.4)
    this.occupy(knotX - 3.4, knotX + 3.4, knotZ - 3.4, knotZ + 3.4, 4)
  }

  // ————————————————————————————— 城市 —————————————————————————————

  /**
   * 环形城市:以起飞点为心、42~135m 的环带上摆 26 栋楼。
   * 越靠近"内环"越高(模拟市中心),外圈矮下去,形成天际线。
   * 每栋楼用同一张幕墙贴图 clone 后按楼体尺寸设 repeat —— 窗格大小在楼与楼之间保持一致。
   */
  private buildCity(): void {
    const texture = this.makeFacadeTexture()
    const tint = [
      new THREE.Color(0xb9c4cf),
      new THREE.Color(0x9fadba),
      new THREE.Color(0xc7cfd6),
      new THREE.Color(0x8f9daa),
      new THREE.Color(0xa9b6bf),
    ]

    const target = 26
    let placed = 0
    let attempts = 0
    while (placed < target && attempts < target * 24) {
      attempts += 1
      const angle = this.range(0, Math.PI * 2)
      // 半径偏内(市中心高、外圈矮)
      const radius = this.range(42, 135)
      const width = this.range(7, 16)
      const depth = this.range(7, 16)
      const x = Math.sin(angle) * radius
      const z = Math.cos(angle) * radius
      const halfW = width / 2
      const halfD = depth / 2
      if (!this.isFree(x - halfW, x + halfW, z - halfD, z + halfD)) continue
      // 内环高、外圈低;再叠一点随机,避免整齐得像栅栏
      const central = 1 - Math.min(1, (radius - 42) / 93)
      const height = this.range(8, 20) + central * this.range(0, 24)

      const boxGeo = this.keep(new THREE.BoxGeometry(width, height, depth))
      const map = this.keep(texture.clone())
      map.needsUpdate = true
      map.repeat.set(Math.max(1, Math.round(width / 3.2)), Math.max(1, Math.round(height / 3.6)))
      const material = this.keep(
        new THREE.MeshStandardMaterial({
          map,
          emissiveMap: map,
          emissive: new THREE.Color(0xffffff),
          emissiveIntensity: 0.55,
          color: this.pick(tint)?.clone() ?? new THREE.Color(0xb9c4cf),
          roughness: 0.68,
          metalness: 0.18,
        }),
      )
      const mesh = new THREE.Mesh(boxGeo, material)
      mesh.position.set(x, height / 2, z)
      mesh.name = 'SCENERY_BUILDING'
      this.group.add(mesh)

      this.footprint(`布景·楼${placed + 1}`, x - halfW, x + halfW, height, z - halfD, z + halfD)
      this.occupy(x - halfW, x + halfW, z - halfD, z + halfD, 2.5)
      this.counts.buildings += 1
      placed += 1
    }
  }

  // ————————————————————————————— 树林 —————————————————————————————

  /**
   * 树林:树干 / 阔叶球冠 / 针叶锥冠各一个 InstancedMesh —— 74 棵树只花 3 次绘制。
   * 落点在 22~150m 的环带上随机撒,与建筑/道路互斥,彼此间距 ≥3.2m。
   */
  private buildForest(): void {
    const trunkPositions: Array<{ x: number; z: number; height: number; radius: number }> = []
    const broadleaf: Array<{ x: number; y: number; z: number; r: number }> = []
    const conifer: Array<{ x: number; y: number; z: number; r: number; h: number }> = []

    const target = 74
    let placed = 0
    let attempts = 0
    while (placed < target && attempts < target * 30) {
      attempts += 1
      const angle = this.range(0, Math.PI * 2)
      const radius = this.range(22, 150)
      const x = Math.sin(angle) * radius
      const z = Math.cos(angle) * radius
      // 别贴着起飞坪长树
      if (Math.hypot(x, z) < 16) continue
      if (!this.isFree(x - 1.6, x + 1.6, z - 1.6, z + 1.6)) continue
      // 树与树之间留出冠幅
      let tooClose = false
      for (const other of trunkPositions) {
        if (Math.hypot(other.x - x, other.z - z) < 3.2) {
          tooClose = true
          break
        }
      }
      if (tooClose) continue

      const trunkH = this.range(1.6, 3.4)
      trunkPositions.push({ x, z, height: trunkH, radius: this.range(0.13, 0.22) })
      if (this.rng() < 0.62) {
        const r = this.range(1.5, 2.6)
        broadleaf.push({ x, y: trunkH + r * 0.55, z, r })
      } else {
        const r = this.range(1.1, 1.7)
        const h = this.range(3.4, 6.2)
        conifer.push({ x, y: trunkH + h / 2, z, r, h })
      }
      this.occupy(x - 1.6, x + 1.6, z - 1.6, z + 1.6, 0.6)
      placed += 1
    }

    const trunkGeo = this.keep(new THREE.CylinderGeometry(0.72, 1, 1, 6))
    const trunkMat = this.keep(
      new THREE.MeshStandardMaterial({ color: 0x53412f, roughness: 0.9, metalness: 0.02 }),
    )
    const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, trunkPositions.length)
    trunkMesh.name = 'SCENERY_TREE_TRUNK'
    const matrix = new THREE.Matrix4()
    const quat = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    trunkPositions.forEach((tree, index) => {
      matrix.compose(
        new THREE.Vector3(tree.x, tree.height / 2, tree.z),
        quat,
        scale.set(tree.radius, tree.height, tree.radius),
      )
      trunkMesh.setMatrixAt(index, matrix)
    })
    trunkMesh.instanceMatrix.needsUpdate = true
    this.group.add(trunkMesh)

    const leafMat = this.keep(
      new THREE.MeshStandardMaterial({
        color: 0x3f6b46,
        roughness: 0.92,
        metalness: 0.02,
        flatShading: true,
      }),
    )
    const needleMat = this.keep(
      new THREE.MeshStandardMaterial({
        color: 0x2c5240,
        roughness: 0.94,
        metalness: 0.02,
        flatShading: true,
      }),
    )

    const leafGeo = this.keep(new THREE.IcosahedronGeometry(1, 0))
    const leafMesh = new THREE.InstancedMesh(leafGeo, leafMat, broadleaf.length)
    leafMesh.name = 'SCENERY_TREE_LEAF'
    broadleaf.forEach((tree, index) => {
      quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng() * Math.PI)
      matrix.compose(
        new THREE.Vector3(tree.x, tree.y, tree.z),
        quat,
        scale.set(tree.r, tree.r * 0.92, tree.r),
      )
      leafMesh.setMatrixAt(index, matrix)
    })
    leafMesh.instanceMatrix.needsUpdate = true
    this.group.add(leafMesh)

    const coneGeo = this.keep(new THREE.ConeGeometry(1, 1, 7))
    const coneMesh = new THREE.InstancedMesh(coneGeo, needleMat, conifer.length)
    coneMesh.name = 'SCENERY_TREE_CONE'
    conifer.forEach((tree, index) => {
      quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng() * Math.PI)
      matrix.compose(new THREE.Vector3(tree.x, tree.y, tree.z), quat, scale.set(tree.r, tree.h, tree.r))
      coneMesh.setMatrixAt(index, matrix)
    })
    coneMesh.instanceMatrix.needsUpdate = true
    this.group.add(coneMesh)

    this.counts.trees = trunkPositions.length
  }

  // ————————————————————————————— 远山 —————————————————————————————

  /**
   * 远山:低模二十面体半球,压扁后埋进地里当丘陵,flatShading 出棱面。
   * 放在 170~330m 的外圈,给天际线一个底,也让高空/全景画面不至于空成一条水平线。
   */
  private buildHills(): void {
    const material = this.keep(
      new THREE.MeshStandardMaterial({
        color: 0x3c4a44,
        roughness: 0.95,
        metalness: 0.02,
        flatShading: true,
      }),
    )
    const geometry = this.keep(new THREE.IcosahedronGeometry(1, 2))

    const target = 7
    let placed = 0
    let attempts = 0
    while (placed < target && attempts < 60) {
      attempts += 1
      const angle = this.range(0, Math.PI * 2)
      const radius = this.range(170, 330)
      const r = this.range(22, 52)
      const x = Math.sin(angle) * radius
      const z = Math.cos(angle) * radius
      // 山之间别叠太狠
      if (!this.isFree(x - r * 0.7, x + r * 0.7, z - r * 0.7, z + r * 0.7)) continue
      const h = this.range(9, 26)
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(x, -h * 0.32, z)
      mesh.scale.set(r, h, r * this.range(0.8, 1.25))
      mesh.rotation.y = this.range(0, Math.PI * 2)
      mesh.name = 'SCENERY_HILL'
      this.group.add(mesh)
      this.occupy(x - r * 0.7, x + r * 0.7, z - r * 0.7, z + r * 0.7, 0)
      this.counts.hills += 1
      placed += 1
    }
  }

  /** 摘掉整层布景并释放几何 / 材质 / 贴图 */
  dispose(): void {
    this.group.removeFromParent()
    this.group.clear()
    for (const item of this.disposables) item.dispose()
    this.disposables.length = 0
    this.footprints.length = 0
  }
}
