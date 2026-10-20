/**
 * 「边境营地」静态场景 —— 纯 three 的程序化布景，零外部模型、零交互逻辑。
 *
 * 设计目标：**一张电影感的定场镜头**，不是可玩场景。
 *   构图：一条土路穿过小村，两侧是灰泥民房/仓库，远处水塔与山脊，
 *         清晨 8° 低角度太阳把所有东西的影子拉长，雾把远山压成剪影。
 *
 * 性能做法（对比 demo-scenery 的「一栋楼一个 mesh」）：
 *   所有建筑按材质归入 8 个「桶」（灰泥 / 混凝土 / 瓦 / 铁皮 / 木 / 漆面 / 玻璃 / 线缆），
 *   最后每桶 merge 成一个 mesh —— 上百栋房子也只有 8 次绘制。
 *   同一张图集靠**顶点色**染出楼与楼之间的色差，于是不需要克隆贴图。
 *   树/灌木/草/石头各一个 InstancedMesh。
 *
 * 全部随机数走固定种子：每次刷新同一片营地，便于截图回归。
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { createSceneSurfaces } from './scene-textures'
import type { SceneSurfaces } from './scene-textures'

const UP = new THREE.Vector3(0, 1, 0)

/** 主路：沿 X、z=0，长 ±215 */
const ROAD_HALF = 4.6
/** 支路：从主路 (-20,0) 拐向营地 (-80,-70) */
const BRANCH = { ax: -20, az: 0, bx: -80, bz: -70, half: 3.4 }

export interface StaticSceneStats {
  buildings: number
  props: number
  trees: number
  bushes: number
  grass: number
  rocks: number
  drawCalls: number
  triangles: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** 点到线段的距离（土路遮罩用） */
function distanceToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax
  const dz = bz - az
  const lengthSq = dx * dx + dz * dz || 1
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / lengthSq))
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t))
}

/**
 * 地形高度：村庄落在半径 115m 的平坦谷底，往外抬升成环形山脊。
 * 平坦区是刻意的——建筑坐得稳，土路不用跟地形抢高差；
 * 起伏全部交给外圈，负责给天际线一个「碗」，画面才不空。
 */
function terrainHeight(x: number, z: number): number {
  const radius = Math.hypot(x, z)
  const blend = smoothstep(115, 235, radius)
  if (blend <= 0) return 0
  const ridge =
    Math.sin(x * 0.0125 + 1.7) * 8 +
    Math.cos(z * 0.0103 - 0.4) * 7 +
    Math.sin((x + z) * 0.021) * 3.5
  return blend * Math.max(3, 11 + ridge)
}

/** 土路遮罩：1 = 路面中心，0 = 完全草地 */
function roadMask(x: number, z: number): number {
  const main = Math.hypot(Math.max(0, Math.abs(x) - 215), z)
  const branch = distanceToSegment(x, z, BRANCH.ax, BRANCH.az, BRANCH.bx, BRANCH.bz)
  const d = Math.min(main, branch)
  return 1 - smoothstep(ROAD_HALF, ROAD_HALF + 3.2, d)
}

/** 把 BoxGeometry 六个面的 UV 按**世界尺寸**缩放，让贴图在所有楼上是同一个比例 */
function scaleBoxUv(geo: THREE.BoxGeometry, w: number, h: number, d: number, tile: number): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute
  // BoxGeometry 面序：+X, -X, +Y, -Y, +Z, -Z，每面 4 个顶点
  const dims: Array<[number, number]> = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ]
  for (let face = 0; face < 6; face += 1) {
    const dim = dims[face] ?? [w, h]
    for (let i = 0; i < 4; i += 1) {
      const index = face * 4 + i
      uv.setXY(index, (uv.getX(index) * dim[0]) / tile, (uv.getY(index) * dim[1]) / tile)
    }
  }
  uv.needsUpdate = true
}

/** 双坡屋顶：脊线沿 X，返回非索引几何（法线按面算，棱角干净） */
function gableRoofGeometry(w: number, d: number, h: number, tile = 1.6): THREE.BufferGeometry {
  const hw = w / 2
  const hd = d / 2
  const slope = Math.hypot(hd, h)
  const positions: number[] = []
  const uvs: number[] = []
  const push = (p: Array<[number, number, number]>, uv: Array<[number, number]>): void => {
    for (const [x, y, z] of p) positions.push(x, y, z)
    for (const [u, v] of uv) uvs.push(u, v)
  }
  // +Z 坡面
  push(
    [
      [-hw, 0, hd],
      [hw, 0, hd],
      [hw, h, 0],
    ],
    [
      [0, 0],
      [w / tile, 0],
      [w / tile, slope / tile],
    ],
  )
  push(
    [
      [-hw, 0, hd],
      [hw, h, 0],
      [-hw, h, 0],
    ],
    [
      [0, 0],
      [w / tile, slope / tile],
      [0, slope / tile],
    ],
  )
  // -Z 坡面
  push(
    [
      [hw, 0, -hd],
      [-hw, 0, -hd],
      [-hw, h, 0],
    ],
    [
      [0, 0],
      [w / tile, 0],
      [w / tile, slope / tile],
    ],
  )
  push(
    [
      [hw, 0, -hd],
      [-hw, h, 0],
      [hw, h, 0],
    ],
    [
      [0, 0],
      [w / tile, slope / tile],
      [0, slope / tile],
    ],
  )
  // 两端的山墙三角
  push(
    [
      [-hw, 0, -hd],
      [-hw, 0, hd],
      [-hw, h, 0],
    ],
    [
      [0, 0],
      [d / tile, 0],
      [d / tile / 2, h / tile],
    ],
  )
  push(
    [
      [hw, 0, hd],
      [hw, 0, -hd],
      [hw, h, 0],
    ],
    [
      [0, 0],
      [d / tile, 0],
      [d / tile / 2, h / tile],
    ],
  )
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.computeVertexNormals()
  return geo
}

/**
 * 材质桶：把同一材质的零件攒起来，最后 merge 成一个 mesh。
 * 每个零件带自己的顶点色（楼与楼、箱与箱的色差），所以一张贴图能长出上百种表面。
 */
class PartBucket {
  private readonly parts: THREE.BufferGeometry[] = []

  add(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, color: THREE.ColorRepresentation): void {
    // merge 要求属性集合一致：统一转成非索引（自定义屋顶本来就是非索引）
    let target = geo
    if (target.index) {
      const flat = target.toNonIndexed()
      target.dispose()
      target = flat
    }
    target.applyMatrix4(matrix)
    if (!target.attributes.uv) {
      const count = target.attributes.position?.count ?? 0
      target.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2))
    }
    const count = target.attributes.position?.count ?? 0
    const tint = new THREE.Color(color)
    const colors = new Float32Array(count * 3)
    for (let i = 0; i < count; i += 1) {
      colors[i * 3] = tint.r
      colors[i * 3 + 1] = tint.g
      colors[i * 3 + 2] = tint.b
    }
    target.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    this.parts.push(target)
  }

  commit(material: THREE.Material): THREE.Mesh | null {
    if (this.parts.length === 0) return null
    const merged = mergeGeometries(this.parts, false)
    for (const part of this.parts) part.dispose()
    this.parts.length = 0
    if (!merged) return null
    merged.computeBoundingSphere()
    const mesh = new THREE.Mesh(merged, material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }
}

/** 场景内的一处占位（树/灌木避开建筑用） */
interface Blocker {
  x: number
  z: number
  r: number
}

export class StaticScene {
  readonly group = new THREE.Group()
  readonly stats: StaticSceneStats = {
    buildings: 0,
    props: 0,
    trees: 0,
    bushes: 0,
    grass: 0,
    rocks: 0,
    drawCalls: 0,
    triangles: 0,
  }

  private readonly rng = mulberry32(20261020)
  private readonly surfaces: SceneSurfaces
  private readonly buckets = new Map<string, PartBucket>()
  private readonly blockers: Blocker[] = []
  private readonly materials: THREE.Material[] = []
  private readonly geometries: THREE.BufferGeometry[] = []

  constructor(scene: THREE.Scene) {
    this.surfaces = createSceneSurfaces()
    this.group.name = 'static-scene'

    this.buildGround()
    this.buildVillage()
    this.buildCamp()
    this.buildFarm()
    this.buildLandmarks()
    this.buildRoadside()
    this.commitBuckets()
    this.buildVegetation()

    scene.add(this.group)
  }

  // ————————————————————————————— 基础工具 —————————————————————————————

  private range(min: number, max: number): number {
    return min + this.rng() * (max - min)
  }

  private pick<T>(list: readonly T[]): T {
    const index = Math.min(list.length - 1, Math.floor(this.rng() * list.length))
    return list[index] as T
  }

  private bucket(key: string): PartBucket {
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = new PartBucket()
      this.buckets.set(key, bucket)
    }
    return bucket
  }

  /** 结构局部坐标 → 世界矩阵（base 已含位置与朝向） */
  private at(base: THREE.Matrix4, x: number, y: number, z: number, ry = 0): THREE.Matrix4 {
    const local = new THREE.Matrix4().makeRotationY(ry)
    local.setPosition(x, y, z)
    return base.clone().multiply(local)
  }

  private origin(x: number, z: number, rot = 0): THREE.Matrix4 {
    const matrix = new THREE.Matrix4().makeRotationY(rot)
    matrix.setPosition(x, terrainHeight(x, z), z)
    return matrix
  }

  private box(
    key: string,
    w: number,
    h: number,
    d: number,
    base: THREE.Matrix4,
    x: number,
    y: number,
    z: number,
    color: THREE.ColorRepresentation,
    tile = 2,
    ry = 0,
  ): void {
    const geo = new THREE.BoxGeometry(w, h, d)
    scaleBoxUv(geo, w, h, d, tile)
    this.bucket(key).add(geo, this.at(base, x, y, z, ry), color)
  }

  private cyl(
    key: string,
    radiusTop: number,
    radiusBottom: number,
    height: number,
    base: THREE.Matrix4,
    x: number,
    y: number,
    z: number,
    color: THREE.ColorRepresentation,
    options: { segments?: number; rx?: number; ry?: number; rz?: number } = {},
  ): void {
    const geo = new THREE.CylinderGeometry(
      radiusTop,
      radiusBottom,
      height,
      options.segments ?? 12,
      1,
      false,
    )
    const local = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(options.rx ?? 0, options.ry ?? 0, options.rz ?? 0),
    )
    local.setPosition(x, y, z)
    this.bucket(key).add(geo, base.clone().multiply(local), color)
  }

  private sphere(
    key: string,
    radius: number,
    base: THREE.Matrix4,
    x: number,
    y: number,
    z: number,
    scale: [number, number, number],
    color: THREE.ColorRepresentation,
  ): void {
    const geo = new THREE.SphereGeometry(radius, 8, 6)
    const local = new THREE.Matrix4().makeScale(scale[0], scale[1], scale[2])
    local.setPosition(x, y, z)
    this.bucket(key).add(geo, base.clone().multiply(local), color)
  }

  /** 任意两点之间的杆件（塔架腿、斜撑、围栏斜撑） */
  private strut(
    key: string,
    base: THREE.Matrix4,
    a: THREE.Vector3,
    b: THREE.Vector3,
    radius: number,
    color: THREE.ColorRepresentation,
  ): void {
    const direction = new THREE.Vector3().subVectors(b, a)
    const length = direction.length()
    if (length < 1e-4) return
    const geo = new THREE.CylinderGeometry(radius, radius, length, 6, 1, false)
    const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, direction.normalize())
    const middle = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
    const local = new THREE.Matrix4().compose(middle, quaternion, new THREE.Vector3(1, 1, 1))
    this.bucket(key).add(geo, base.clone().multiply(local), color)
  }

  private block(x: number, z: number, radius: number): void {
    this.blockers.push({ x, z, r: radius })
  }

  private isBlocked(x: number, z: number, pad = 0): boolean {
    for (const blocker of this.blockers) {
      if (Math.hypot(blocker.x - x, blocker.z - z) < blocker.r + pad) return true
    }
    return false
  }

  // ————————————————————————————— 地面 —————————————————————————————

  /**
   * 谷底地面：一张 560×560 的网格，顶点色同时编码「草地 / 干草 / 土路 / 营地碎石」，
   * 贴图本身是近白的细节噪点 —— 这样一张图能同时服务所有地面类型，接缝也看不出来。
   */
  private buildGround(): void {
    const size = 560
    const segments = 180
    const geo = new THREE.PlaneGeometry(size, size, segments, segments)
    geo.rotateX(-Math.PI / 2)

    const position = geo.attributes.position as THREE.BufferAttribute
    const colors = new Float32Array(position.count * 3)
    const grassDark = new THREE.Color(0x53602f)
    const grassLight = new THREE.Color(0x79804a)
    const dry = new THREE.Color(0x8a7c4c)
    const dirt = new THREE.Color(0x665841)
    const road = new THREE.Color(0x37342e)
    const gravel = new THREE.Color(0x665f52)
    const rock = new THREE.Color(0x6d6557)
    const color = new THREE.Color()

    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i)
      const z = position.getZ(i)
      const y = terrainHeight(x, z)
      position.setY(i, y)

      // 草色：两层低频噪声叠出斑块，避免一片死绿
      const n1 = Math.sin(x * 0.045 + z * 0.013) * 0.5 + 0.5
      const n2 = Math.sin(x * 0.011 - z * 0.05 + 1.7) * 0.5 + 0.5
      const mix = Math.min(1, Math.max(0, n1 * 0.6 + n2 * 0.55))
      color.copy(grassDark).lerp(grassLight, mix)
      // 干草：第三层噪声，只覆盖一部分，像被晒黄的草皮
      const dryMask = smoothstep(0.55, 0.95, Math.sin(x * 0.021 + z * 0.031 + 2.1) * 0.5 + 0.5)
      color.lerp(dry, dryMask * 0.55)

      // 土路：中心最深（压实 + 车辙），边缘先过渡到枯草色勾一圈边，
      // 否则贴地视角下路面和草的色差被掠射角洗掉，路就「消失」了
      const mask = roadMask(x, z)
      if (mask > 0) {
        color.lerp(dirt, mask * 0.9)
        color.lerp(road, smoothstep(0.5, 1, mask) * 0.95)
      }
      const edge = smoothstep(0.02, 0.16, mask) * (1 - smoothstep(0.35, 0.62, mask))
      if (edge > 0) color.lerp(dry, edge * 0.55)

      // 营地碎石地
      const camp = 1 - smoothstep(24, 44, Math.hypot(x + 84, z + 76))
      if (camp > 0) color.lerp(gravel, camp * 0.75)

      // 坡面露岩：用高度差近似坡度，陡的地方草长不住
      if (y > 1) {
        const slope = Math.abs(terrainHeight(x + 2, z) - y) + Math.abs(terrainHeight(x, z + 2) - y)
        color.lerp(rock, Math.min(0.75, slope * 0.22))
      }

      colors[i * 3] = color.r
      colors[i * 3 + 1] = color.g
      colors[i * 3 + 2] = color.b
    }

    position.needsUpdate = true
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    this.geometries.push(geo)

    // 地面贴图只服务这一张网格，直接改 repeat 即可（不必 clone，clone 反而多一份要释放的纹理）
    const map = this.surfaces.ground.map
    map.repeat.set(96, 96)
    const normalMap = this.surfaces.ground.normalMap
    normalMap.repeat.set(96, 96)

    const material = new THREE.MeshStandardMaterial({
      map,
      normalMap,
      normalScale: new THREE.Vector2(0.7, 0.7),
      vertexColors: true,
      roughness: 0.97,
      metalness: 0,
    })
    this.materials.push(material)

    const ground = new THREE.Mesh(geo, material)
    ground.name = 'STATIC_GROUND'
    ground.receiveShadow = true
    this.group.add(ground)
    this.stats.triangles += (geo.index?.count ?? 0) / 3
  }

  // ————————————————————————————— 建筑构件 —————————————————————————————

  /** 窗：外框 + 玻璃 + 窗台，三块盒子就够读成「窗」 */
  private addWindow(
    base: THREE.Matrix4,
    cx: number,
    cy: number,
    cz: number,
    w: number,
    h: number,
    axis: 'x' | 'z',
    dir: 1 | -1,
    lit: boolean,
  ): void {
    const glassKey = lit ? 'glassLit' : 'glass'
    if (axis === 'z') {
      const z = cz + dir * 0.02
      this.box('concrete', w + 0.3, h + 0.3, 0.12, base, cx, cy, z, 0x8f887c, 1.6)
      this.box(glassKey, w, h, 0.08, base, cx, cy, z + dir * 0.05, 0xffffff, 2)
      this.box('concrete', w + 0.52, 0.1, 0.26, base, cx, cy - h / 2 - 0.13, cz + dir * 0.08, 0xb4ac9e, 1.4)
    } else {
      const x = cx + dir * 0.02
      this.box('concrete', 0.12, h + 0.3, w + 0.3, base, x, cy, cz, 0x8f887c, 1.6)
      this.box(glassKey, 0.08, h, w, base, x + dir * 0.05, cy, cz, 0xffffff, 2)
      this.box('concrete', 0.26, 0.1, w + 0.52, base, cx + dir * 0.08, cy - h / 2 - 0.13, cz, 0xb4ac9e, 1.4)
    }
  }

  private addDoor(base: THREE.Matrix4, x: number, z: number, dir: 1 | -1, w = 1.05, h = 2.2): void {
    this.box('wood', w + 0.2, h + 0.16, 0.14, base, x, h / 2 + 0.02, z + dir * 0.04, 0x5c4630, 1)
    this.box('wood', w, h, 0.1, base, x, h / 2, z + dir * 0.1, 0x6f5539, 1.1)
    // 门槛台阶
    this.box('concrete', w + 0.9, 0.18, 0.8, base, x, 0.09, z + dir * 0.5, 0xa39c90, 1.4)
  }

  private addGable(
    base: THREE.Matrix4,
    w: number,
    d: number,
    h: number,
    y: number,
    color: THREE.ColorRepresentation,
    key = 'roof',
  ): void {
    const geo = gableRoofGeometry(w, d, h, 1.5)
    this.bucket(key).add(geo, this.at(base, 0, y, 0), color)
    // 檐板：屋顶下沿一圈深色，给屋檐一道硬边
    this.box('wood', w + 0.1, 0.16, 0.14, base, 0, y - 0.02, d / 2 - 0.03, 0x4a3524, 1.2)
    this.box('wood', w + 0.1, 0.16, 0.14, base, 0, y - 0.02, -d / 2 + 0.03, 0x4a3524, 1.2)
  }

  /** 民房：基座 + 灰泥墙 + 双坡瓦顶 + 窗门 + 烟囱 */
  private buildHouse(
    x: number,
    z: number,
    rot: number,
    w: number,
    d: number,
    floors: number,
    options: { tint?: number; roof?: number; porch?: boolean } = {},
  ): void {
    const base = this.origin(x, z, rot)
    const floorH = 3.15
    const bodyH = floors * floorH
    const tint = options.tint ?? 0xc9bfa9
    const roofColor = options.roof ?? 0x7d4a38
    const winW = 1.12
    const winH = 1.42

    // 基座（露出地面 0.45，压住墙脚）
    this.box('concrete', w + 0.46, 0.55, d + 0.46, base, 0, 0.27, 0, 0x9d978b, 2.2)
    // 主体
    this.box('plaster', w, bodyH, d, base, 0, 0.45 + bodyH / 2, 0, tint, 2.4)
    // 层间腰线
    for (let f = 1; f < floors; f += 1) {
      this.box('concrete', w + 0.16, 0.15, d + 0.16, base, 0, 0.45 + f * floorH, 0, 0x968f83, 2)
    }
    this.addGable(base, w + 1.5, d + 1.5, floors > 1 ? 2.1 : 1.75, 0.45 + bodyH, roofColor)

    const cols = Math.max(2, Math.round(w / 3.1))
    const doorCol = Math.floor(cols / 2)
    for (let f = 0; f < floors; f += 1) {
      const cy = 0.45 + f * floorH + 1.75
      for (let c = 0; c < cols; c += 1) {
        const cx = (c - (cols - 1) / 2) * (w / cols)
        const lit = this.rng() < 0.22
        if (f === 0 && c === doorCol) {
          this.addDoor(base, cx, d / 2, 1)
        } else {
          this.addWindow(base, cx, cy, d / 2, winW, winH, 'z', 1, lit)
        }
        this.addWindow(base, cx, cy, -d / 2, winW, winH, 'z', -1, this.rng() < 0.18)
      }
      // 山墙侧各一扇
      this.addWindow(base, w / 2, cy, 0, winW, winH, 'x', 1, this.rng() < 0.2)
      this.addWindow(base, -w / 2, cy, 0, winW, winH, 'x', -1, this.rng() < 0.2)
    }

    // 烟囱：偏向山墙一侧，从屋面穿出
    this.box('concrete', 0.72, 2.2, 0.72, base, w * 0.28, 0.45 + bodyH + 1.2, 0.4, 0x8b8174, 1.2)
    this.box('concrete', 0.95, 0.16, 0.95, base, w * 0.28, 0.45 + bodyH + 2.34, 0.4, 0x7d7468, 1.2)

    // 门廊（单层房）：一块雨棚 + 两根柱子
    if (options.porch ?? floors === 1) {
      const px = 0
      this.box('wood', 2.7, 0.14, 1.5, base, px, 2.62, d / 2 + 0.75, 0x4f3b28, 1.2)
      this.box('wood', 0.14, 2.6, 0.14, base, px - 1.2, 1.3, d / 2 + 1.36, 0x50402c, 1)
      this.box('wood', 0.14, 2.6, 0.14, base, px + 1.2, 1.3, d / 2 + 1.36, 0x50402c, 1)
    }

    // 空调外机 / 电表箱：墙上两三个小盒子，远看就是「有人住」
    this.box('metal', 0.86, 0.62, 0.42, base, -w * 0.32, 2.55, d / 2 + 0.22, 0x9aa0a2, 1.2)
    this.box('metal', 0.4, 0.5, 0.22, base, w * 0.33, 1.75, d / 2 + 0.12, 0x8a8f90, 1)

    this.stats.buildings += 1
    this.block(x, z, Math.hypot(w, d) / 2 + 2)
  }

  /** 三层公寓：平屋顶 + 女儿墙 + 屋顶楼梯间 + 水塔，村里最高的民建 */
  private buildBlock(x: number, z: number, rot: number, w: number, d: number, floors: number): void {
    const base = this.origin(x, z, rot)
    const floorH = 3.0
    const bodyH = floors * floorH
    this.box('concrete', w + 0.5, 0.6, d + 0.5, base, 0, 0.3, 0, 0x9a948a, 2.4)
    this.box('plaster', w, bodyH, d, base, 0, 0.6 + bodyH / 2, 0, 0xb6b0a4, 3)
    // 屋顶板 + 女儿墙
    this.box('concrete', w + 0.4, 0.3, d + 0.4, base, 0, 0.6 + bodyH + 0.15, 0, 0x8f8a80, 2)
    const parapet = 0.55
    this.box('concrete', w + 0.4, parapet, 0.3, base, 0, 0.6 + bodyH + 0.3 + parapet / 2, d / 2, 0x8a857b, 1.6)
    this.box('concrete', w + 0.4, parapet, 0.3, base, 0, 0.6 + bodyH + 0.3 + parapet / 2, -d / 2, 0x8a857b, 1.6)
    this.box('concrete', 0.3, parapet, d + 0.4, base, w / 2, 0.6 + bodyH + 0.3 + parapet / 2, 0, 0x8a857b, 1.6)
    this.box('concrete', 0.3, parapet, d + 0.4, base, -w / 2, 0.6 + bodyH + 0.3 + parapet / 2, 0, 0x8a857b, 1.6)
    // 屋顶楼梯间 + 水箱
    this.box('plaster', 3.2, 2.7, 2.6, base, -w * 0.18, 0.6 + bodyH + 1.5, -d * 0.15, 0xa9a296, 2)
    this.box('concrete', 3.5, 0.16, 2.9, base, -w * 0.18, 0.6 + bodyH + 2.9, -d * 0.15, 0x8a857b, 1.6)
    this.cyl('metal', 1.05, 1.05, 1.8, base, w * 0.22, 0.6 + bodyH + 1.2, d * 0.18, 0x8f9490, { segments: 14 })

    const winW = 1.25
    const winH = 1.5
    const cols = Math.max(2, Math.round(w / 3.4))
    for (let f = 0; f < floors; f += 1) {
      const cy = 0.6 + f * floorH + 1.72
      for (let c = 0; c < cols; c += 1) {
        const cx = (c - (cols - 1) / 2) * (w / cols)
        if (f === 0 && c === Math.floor(cols / 2)) {
          this.addDoor(base, cx, d / 2, 1, 1.2, 2.3)
        } else {
          this.addWindow(base, cx, cy, d / 2, winW, winH, 'z', 1, this.rng() < 0.2)
        }
        this.addWindow(base, cx, cy, -d / 2, winW, winH, 'z', -1, this.rng() < 0.15)
      }
      for (let c = 0; c < Math.max(2, Math.round(d / 3.6)); c += 1) {
        const cz = (c - (Math.max(2, Math.round(d / 3.6)) - 1) / 2) * (d / Math.max(2, Math.round(d / 3.6)))
        this.addWindow(base, w / 2, cy, cz, winW, winH, 'x', 1, this.rng() < 0.15)
        this.addWindow(base, -w / 2, cy, cz, winW, winH, 'x', -1, this.rng() < 0.15)
      }
    }
    // 入口雨棚
    this.box('concrete', 3.4, 0.18, 1.8, base, 0, 3.0, d / 2 + 0.9, 0x9a948a, 1.6)
    this.box('metal', 0.12, 2.9, 0.12, base, -1.5, 1.45, d / 2 + 1.7, 0x7f8486, 1)
    this.box('metal', 0.12, 2.9, 0.12, base, 1.5, 1.45, d / 2 + 1.7, 0x7f8486, 1)

    this.stats.buildings += 1
    this.block(x, z, Math.hypot(w, d) / 2 + 2)
  }

  /** 仓库：彩钢墙 + 低坡金属屋顶 + 卷帘门 */
  private buildWarehouse(x: number, z: number, rot: number, w: number, d: number): void {
    const base = this.origin(x, z, rot)
    const height = 6.2
    this.box('concrete', w + 0.5, 0.6, d + 0.5, base, 0, 0.3, 0, 0x9a958a, 2.4)
    this.box('metal', w, height, d, base, 0, 0.6 + height / 2, 0, 0x8d938c, 2.6)
    // 墙脚一圈深色勒脚
    this.box('concrete', w + 0.12, 0.5, d + 0.12, base, 0, 0.85, 0, 0x77716a, 2)
    this.addGable(base, w + 0.9, d + 0.9, 1.9, 0.6 + height, 0x4c5150, 'metal')
    // 卷帘门：门框 + 门帘（横纹）
    const doorW = 4.6
    const doorH = 4.4
    this.box('concrete', doorW + 0.5, doorH + 0.4, 0.24, base, 0, doorH / 2 + 0.2, d / 2 + 0.02, 0x8a8478, 1.6)
    this.box('metal', doorW, doorH, 0.16, base, 0, doorH / 2 + 0.2, d / 2 + 0.14, 0x767b78, 1.2)
    for (let i = 0; i < 9; i += 1) {
      this.box('metal', doorW, 0.06, 0.05, base, 0, 0.45 + i * 0.48, d / 2 + 0.23, 0x5b615e, 1)
    }
    // 高窗
    for (const dx of [-w * 0.32, w * 0.32]) {
      this.addWindow(base, dx, 5.2, d / 2, 1.5, 0.85, 'z', 1, false)
      this.addWindow(base, dx, 5.2, -d / 2, 1.5, 0.85, 'z', -1, false)
    }
    // 外墙通风机
    for (let i = 0; i < 3; i += 1) {
      this.cyl('metal', 0.42, 0.42, 0.24, base, -w / 2 - 0.12, 4.6, -d * 0.25 + i * 1.2, 0x7c8180, {
        segments: 12,
        rz: Math.PI / 2,
      })
    }
    this.stats.buildings += 1
    this.block(x, z, Math.hypot(w, d) / 2 + 2)
  }

  /** 谷仓：木板墙 + 双坡顶 + 大门 + 通风窗 */
  private buildBarn(x: number, z: number, rot: number, w: number, d: number): void {
    const base = this.origin(x, z, rot)
    const height = 5.6
    this.box('concrete', w + 0.4, 0.5, d + 0.4, base, 0, 0.25, 0, 0x8f887b, 2.2)
    this.box('wood', w, height, d, base, 0, 0.5 + height / 2, 0, 0x8a6c47, 1.6)
    this.addGable(base, w + 1.1, d + 1.1, 3.2, 0.5 + height, 0x5a4030, 'metal')
    // 大门：两扇对开 + X 形加固条
    const doorW = 3.6
    const doorH = 4
    this.box('wood', doorW, doorH, 0.18, base, 0, doorH / 2 + 0.1, d / 2 + 0.06, 0x6f5334, 1.2)
    this.strut(
      'wood',
      this.at(base, 0, doorH / 2 + 0.1, d / 2 + 0.18),
      new THREE.Vector3(-doorW / 2 + 0.2, -doorH / 2 + 0.2, 0),
      new THREE.Vector3(doorW / 2 - 0.2, doorH / 2 - 0.2, 0),
      0.07,
      0x4d3a24,
    )
    // 山墙通风窗
    this.box('wood', 0.9, 0.9, 0.12, base, 0, 0.5 + height + 1.5, d / 2 - 0.1, 0x513a26, 1)
    this.stats.buildings += 1
    this.block(x, z, Math.hypot(w, d) / 2 + 2)
  }

  /** 废墟：断墙 + 瓦砾，给村子一点「发生过什么」的叙事 */
  private buildRuin(x: number, z: number, rot: number, w: number, d: number): void {
    const base = this.origin(x, z, rot)
    const wallH = 2.4
    const t = 0.45
    this.box('concrete', w, 0.3, d, base, 0, 0.15, 0, 0x8b857a, 2)
    // 四面墙，各留一个大缺口
    this.box('plaster', w, wallH, t, base, 0, wallH / 2, d / 2, 0xa89f90, 2)
    this.box('plaster', w * 0.45, wallH - 0.7, t, base, -w * 0.27, (wallH - 0.7) / 2, -d / 2, 0xa89f90, 2)
    this.box('plaster', t, wallH * 0.8, d * 0.6, base, w / 2, wallH * 0.4, -d * 0.15, 0xa89f90, 2)
    // 瓦砾堆
    for (let i = 0; i < 14; i += 1) {
      this.box(
        'concrete',
        this.range(0.4, 1.3),
        this.range(0.2, 0.55),
        this.range(0.4, 1.2),
        base,
        this.range(-w / 2, w / 2),
        this.range(0.1, 0.4),
        this.range(-d / 2, d / 2),
        0x8d8577,
        1.2,
        this.range(0, Math.PI),
      )
    }
    this.stats.buildings += 1
    this.block(x, z, Math.hypot(w, d) / 2 + 1.5)
  }

  // ————————————————————————————— 村落 —————————————————————————————

  private buildVillage(): void {
    const houses: Array<[number, number, number, number, number, number]> = [
      // x, z, rot, w, d, floors
      [-16, 17, 0.02, 9, 7, 2],
      [8, 20, 0.05, 8, 6.5, 1],
      [34, 17, -0.08, 12, 9, 3],
      [-44, 19, 0.03, 10, 8, 1],
      [-70, 14, 0.14, 8, 7, 1],
      [-14, -18, 0.0, 9, 7, 1],
      [10, -20, -0.06, 8, 7, 2],
      [-46, -24, -0.12, 9, 7, 1],
      [66, -13, 0.2, 8, 7, 1],
      [58, 45, 0.5, 10, 8, 2],
      [-52, 46, -0.35, 9, 7, 1],
      [16, 51, 0.1, 12, 9, 2],
      [-24, 53, 0.2, 8, 6, 1],
      [-60, 62, 0.26, 9, 7, 1],
    ]
    const tints = [0xc9bfa9, 0xbfb49c, 0xd0c6b1, 0xb3a894, 0xc4b79e, 0xa89e8c]
    const roofs = [0x7d4a38, 0x6b4132, 0x5a4c42, 0x74503c]
    for (const [x, z, rot, w, d, floors] of houses) {
      // 12×9×3 的那栋当公寓（平屋顶 + 女儿墙），其余是坡顶民房
      if (w === 12 && floors === 3) this.buildBlock(x, z, rot, w, d, floors)
      else {
        this.buildHouse(x, z, rot, w, d, floors, {
          tint: this.pick(tints),
          roof: this.pick(roofs),
          porch: floors === 1 && this.rng() < 0.7,
        })
      }
    }
    // 仓库：东侧村口一座（彩钢），西侧一座（沿支路，长边朝路）
    this.buildWarehouse(40, -20, 0.06, 16, 10)
    this.buildWarehouse(-92, 26, Math.PI / 2, 18, 11)
    this.buildRuin(-36, -54, 0.4, 10, 8)
    // 废墟别压路：主路半宽 4.6m，z=6 时墙体（d/2=4.5）会伸进路面
    this.buildRuin(96, 18, -0.3, 9, 9)
  }

  // ————————————————————————————— 营地 —————————————————————————————

  /**
   * 营地：集装箱堆场 + 瞭望塔 + 铁丝网 + 沙袋 + 油桶/木箱/轮胎。
   * 位置在村西 (-84,-76)，视觉上给画面左后方一个「工业/军事」的对比色块。
   */
  private buildCamp(): void {
    const cx = -84
    const cz = -76
    this.block(cx, cz, 26)

    // 集装箱：两只并排、一只压在中间（略微错位，不是整齐堆叠）
    const containers: Array<[number, number, number, number, number]> = [
      [-10, -4, 0.02, 0x8d4636, 1],
      [-10, -0.8, 0.03, 0x35545c, 1],
      [-9.6, -2.4, 0.06, 0x5c6b3c, 2],
      [6, 2.5, 1.57, 0x7a5a35, 1],
    ]
    for (const [dx, dz, rot, color, level] of containers) {
      const base = this.origin(cx + dx, cz + dz, rot)
      const h = 2.65
      const y = level === 2 ? h + 0.06 : 0
      this.box('metal', 12, h, 2.6, base, 0, y + h / 2, 0, color, 2.6)
      // 端门：两侧各一条竖框 + 横锁杆
      for (const side of [-1, 1]) {
        this.box('metal', 0.12, h - 0.2, 2.62, base, side * 5.95, y + h / 2, 0, 0x4a4038, 1.4)
        for (const bar of [-0.7, 0.7]) {
          this.box('metal', 0.08, h - 0.5, 0.08, base, side * 6.02, y + h / 2, bar, 0x6a6a64, 1)
        }
      }
      // 角件
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          this.box('metal', 0.34, 0.28, 0.34, base, sx * 5.85, y + h - 0.16, sz * 1.16, 0x5f5b52, 1)
        }
      }
      this.stats.props += 1
    }

    // 瞭望塔：四腿 + 横撑 + 平台 + 小屋 + 顶棚
    const towerBase = this.origin(cx - 16, cz - 10, 0.25)
    const legBottom = 1.6
    const legTop = 0.9
    const towerH = 7.2
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        this.strut(
          'metal',
          towerBase,
          new THREE.Vector3(sx * legBottom, 0, sz * legBottom),
          new THREE.Vector3(sx * legTop, towerH, sz * legTop),
          0.11,
          0x6a6c66,
        )
      }
    }
    for (const y of [2.2, 4.4, 6.6]) {
      const half = legBottom + (legTop - legBottom) * (y / towerH)
      const corners: Array<[number, number]> = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]
      for (let i = 0; i < 4; i += 1) {
        const a = corners[i] ?? [0, 0]
        const b = corners[(i + 1) % 4] ?? [0, 0]
        this.strut(
          'metal',
          towerBase,
          new THREE.Vector3(a[0] * half, y, a[1] * half),
          new THREE.Vector3(b[0] * half, y, b[1] * half),
          0.07,
          0x6a6c66,
        )
      }
    }
    // 平台与护栏
    this.box('wood', 4.4, 0.22, 4.4, towerBase, 0, towerH, 0, 0x6d5638, 1.2)
    for (const [dx, dz, w, d] of [
      [0, 2.1, 4.4, 0.1],
      [0, -2.1, 4.4, 0.1],
      [2.1, 0, 0.1, 4.4],
      [-2.1, 0, 0.1, 4.4],
    ] as Array<[number, number, number, number]>) {
      this.box('wood', w, 0.9, d, towerBase, dx, towerH + 0.55, dz, 0x5f4a30, 1)
    }
    // 小屋
    this.box('wood', 3.2, 2.3, 3.2, towerBase, 0, towerH + 1.3, 0, 0x7a6244, 1.4)
    this.box('metal', 3.6, 0.12, 3.6, towerBase, 0, towerH + 2.5, 0, 0x5b5f5a, 1.4)
    this.addWindow(towerBase, 0, towerH + 1.5, 1.62, 1.1, 0.8, 'z', 1, false)
    // 梯子
    for (let i = 0; i < 9; i += 1) {
      this.box('metal', 0.06, 0.06, 0.5, towerBase, -1.9, 0.6 + i * 0.8, 1.9, 0x62655f, 1)
    }
    this.stats.props += 1

    // 围栏：一圈木桩 + 两道横杆（正面 x∈[-4,4] 留门洞，横杆也不要跨过去）
    const fenceHalfW = 22
    const fenceHalfD = 17
    const isGate = (x: number): boolean => Math.abs(x) < 4.6
    for (let x = -fenceHalfW; x <= fenceHalfW; x += 2.6) {
      for (const z of [-fenceHalfD, fenceHalfD]) {
        if (z > 0 && isGate(x)) continue
        this.box('wood', 0.14, 1.5, 0.14, this.origin(cx + x, cz + z), 0, 0.75, 0, 0x5c4830, 1)
      }
      // 横杆的中心在 x+1.3，跨到下一根桩；门洞处整段跳过
      if (isGate(x + 1.3)) continue
      for (const y of [0.55, 1.15]) {
        this.box('wood', 2.6, 0.09, 0.07, this.origin(cx + x + 1.3, cz + fenceHalfD), 0, y, 0, 0x6a5335, 1)
        this.box('wood', 2.6, 0.09, 0.07, this.origin(cx + x + 1.3, cz - fenceHalfD), 0, y, 0, 0x6a5335, 1)
      }
    }
    for (let z = -fenceHalfD; z <= fenceHalfD; z += 2.6) {
      for (const x of [-fenceHalfW, fenceHalfW]) {
        this.box('wood', 0.14, 1.5, 0.14, this.origin(cx + x, cz + z), 0, 0.75, 0, 0x5c4830, 1)
      }
      for (const y of [0.55, 1.15]) {
        this.box('wood', 0.07, 0.09, 2.6, this.origin(cx - fenceHalfW, cz + z + 1.3), 0, y, 0, 0x6a5335, 1)
        this.box('wood', 0.07, 0.09, 2.6, this.origin(cx + fenceHalfW, cz + z + 1.3), 0, y, 0, 0x6a5335, 1)
      }
    }
    this.stats.props += 1

    // 沙袋掩体：三层错缝堆叠
    const sandBase = this.origin(cx + 4, cz + 9, 0.2)
    for (let row = 0; row < 3; row += 1) {
      for (let i = 0; i < 5; i += 1) {
        const offset = row % 2 === 0 ? 0 : 0.18
        this.sphere(
          'sand',
          0.36,
          sandBase,
          -2.0 + i * 0.9 + offset,
          0.18 + row * 0.34,
          0,
          [1.15, 0.62, 0.85],
          row === 2 ? 0x9b8f74 : 0x8b8068,
        )
      }
    }
    this.stats.props += 1

    // 油桶 / 木箱 / 托盘 / 轮胎
    const props: Array<[number, number, 'barrel' | 'crate' | 'tire' | 'pallet', number]> = [
      [2, -6, 'barrel', 0x7a4c33],
      [3.1, -6.2, 'barrel', 0x35545c],
      [2.6, -7.4, 'barrel', 0x6b6a3a],
      [1.4, -7.1, 'barrel', 0x7a4c33],
      [5.6, -7.8, 'crate', 0x8a6a44],
      [6.5, -7.6, 'crate', 0x7d5f3c],
      [6.4, -8.5, 'crate', 0x8a6a44],
      [-4.2, 6.4, 'pallet', 0x8b7048],
      [-3.2, 7.6, 'crate', 0x7a5c38],
      [-2.4, 7.5, 'crate', 0x8a6a44],
      [7.4, 4.2, 'tire', 0x1e2022],
      [8.2, 4.8, 'tire', 0x1e2022],
      [8.0, 4.3, 'tire', 0x2a2c2e],
    ]
    for (const [dx, dz, kind, color] of props) {
      const base = this.origin(cx + dx, cz + dz, this.range(0, Math.PI))
      if (kind === 'barrel') {
        this.cyl('paint', 0.3, 0.3, 0.92, base, 0, 0.46, 0, color, { segments: 14 })
        this.cyl('paint', 0.31, 0.31, 0.05, base, 0, 0.3, 0, 0x4a4038, { segments: 14 })
        this.cyl('paint', 0.31, 0.31, 0.05, base, 0, 0.66, 0, 0x4a4038, { segments: 14 })
      } else if (kind === 'crate') {
        this.box('wood', 0.95, 0.95, 0.95, base, 0, 0.48, 0, color, 1)
        this.box('wood', 1.0, 0.08, 0.08, base, 0, 0.95, 0, 0x53402a, 1)
      } else if (kind === 'tire') {
        const geo = new THREE.TorusGeometry(0.34, 0.14, 8, 14)
        const local = new THREE.Matrix4().makeRotationX(Math.PI / 2)
        local.setPosition(0, 0.14, 0)
        this.bucket('rubber').add(geo, base.clone().multiply(local), color)
      } else {
        this.box('wood', 1.3, 0.12, 1.1, base, 0, 0.06, 0, color, 1)
        this.box('wood', 1.3, 0.12, 1.1, base, 0, 0.18, 0, color, 1)
      }
      this.stats.props += 1
    }

    // 两辆卡车（简化到「能读出是车」：车头、车厢、轮子）
    this.buildTruck(cx + 12, cz + 9, 0.35, 0x5c6650)
    this.buildTruck(cx - 6, cz + 12, -0.2, 0x6b5647)
  }

  private buildTruck(x: number, z: number, rot: number, color: number): void {
    const base = this.origin(x, z, rot)
    this.box('paint', 2.3, 0.5, 5.6, base, 0, 0.72, 0, color, 2)
    this.box('paint', 2.15, 1.35, 1.9, base, 0, 1.5, 1.75, color, 2)
    this.box('glass', 1.95, 0.62, 0.06, base, 0, 1.72, 2.7, 0xffffff, 2)
    this.box('paint', 2.25, 1.5, 3.2, base, 0, 1.7, -1.1, color, 2)
    this.box('metal', 2.1, 1.35, 3.0, base, 0, 1.72, -1.1, 0x8a8d84, 2)
    for (const sx of [-1, 1]) {
      for (const sz of [1.9, -1.7]) {
        this.cyl('rubber', 0.48, 0.48, 0.34, base, sx * 1.05, 0.48, sz, 0x1b1d1f, {
          segments: 14,
          rz: Math.PI / 2,
        })
      }
    }
    this.stats.props += 1
  }

  // ————————————————————————————— 农场 —————————————————————————————

  private buildFarm(): void {
    const bx = 88
    const bz = 76
    this.block(bx, bz, 14)
    this.buildBarn(bx, bz, -0.35, 15, 9)

    // 筒仓
    const silo = this.origin(bx - 14, bz + 6, 0)
    this.cyl('concrete', 2.6, 2.8, 14, silo, 0, 7, 0, 0xa8a196, { segments: 20 })
    this.cyl('metal', 2.7, 2.7, 0.5, silo, 0, 12.4, 0, 0x8a8d84, { segments: 20 })
    this.cyl('metal', 2.7, 0.7, 2.4, silo, 0, 13.9, 0, 0x7f837c, { segments: 20 })
    this.box('metal', 0.1, 12, 0.1, silo, 2.85, 6, 0, 0x6d6f68, 1)
    this.box('metal', 0.1, 12, 0.1, silo, 3.35, 6, 0, 0x6d6f68, 1)
    for (let i = 0; i < 14; i += 1) {
      this.box('metal', 0.6, 0.05, 0.05, silo, 3.1, 1 + i * 0.8, 0, 0x6d6f68, 1)
    }
    this.stats.props += 1

    // 干草卷
    for (let i = 0; i < 8; i += 1) {
      const hay = this.origin(bx + 12 + this.range(-3, 3), bz - 12 + i * 1.6, this.range(0, Math.PI))
      this.cyl('wood', 0.65, 0.65, 1.2, hay, 0, 0.65, 0, 0xb79c5e, {
        segments: 12,
        rz: Math.PI / 2,
      })
      this.stats.props += 1
    }

    // 牧场围栏
    for (let i = 0; i < 9; i += 1) {
      this.box('wood', 0.12, 1.2, 0.12, this.origin(bx - 22 + i * 3.2, bz - 20), 0, 0.6, 0, 0x5e4931, 1)
      this.box('wood', 0.12, 1.2, 0.12, this.origin(bx - 22 + i * 3.2, bz - 6), 0, 0.6, 0, 0x5e4931, 1)
    }
    for (const y of [0.5, 0.95]) {
      this.box('wood', 26, 0.08, 0.07, this.origin(bx - 9, bz - 20), 0, y, 0, 0x6a5335, 1)
      this.box('wood', 26, 0.08, 0.07, this.origin(bx - 9, bz - 6), 0, y, 0, 0x6a5335, 1)
    }
  }

  // ————————————————————————————— 地标 —————————————————————————————

  /** 水塔 + 输电塔：远处两个竖向元素，把天际线从「一条线」变成「有节奏」 */
  private buildLandmarks(): void {
    // 水塔：四腿 + 圆罐 + 锥顶 + 爬梯
    const tx = 26
    const tz = -96
    const base = this.origin(tx, tz, 0.2)
    const legR = 3.6
    const tankY = 13
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        this.strut(
          'metal',
          base,
          new THREE.Vector3(sx * legR, 0, sz * legR),
          new THREE.Vector3(sx * 1.9, tankY, sz * 1.9),
          0.17,
          0x77807c,
        )
      }
    }
    for (const y of [4.5, 8.5]) {
      const half = legR + (1.9 - legR) * (y / tankY)
      const corners: Array<[number, number]> = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]
      for (let i = 0; i < 4; i += 1) {
        const a = corners[i] ?? [0, 0]
        const b = corners[(i + 1) % 4] ?? [0, 0]
        this.strut(
          'metal',
          base,
          new THREE.Vector3(a[0] * half, y, a[1] * half),
          new THREE.Vector3(b[0] * half, y, b[1] * half),
          0.09,
          0x77807c,
        )
      }
    }
    this.cyl('metal', 4.2, 4.2, 0.35, base, 0, tankY, 0, 0x6d746f, { segments: 22 })
    this.cyl('metal', 4.0, 4.3, 4.6, base, 0, tankY + 2.5, 0, 0x8b9089, { segments: 22 })
    this.cyl('metal', 4.25, 4.25, 0.3, base, 0, tankY + 4.9, 0, 0x6d746f, { segments: 22 })
    this.cyl('metal', 0.35, 4.1, 2.1, base, 0, tankY + 6.1, 0, 0x7d837c, { segments: 22 })
    // 爬梯
    this.box('metal', 0.08, 12, 0.08, base, 3.3, 6, 0.4, 0x62655f, 1)
    this.box('metal', 0.08, 12, 0.08, base, 3.9, 6, 0.4, 0x62655f, 1)
    for (let i = 0; i < 16; i += 1) {
      this.box('metal', 0.7, 0.05, 0.05, base, 3.6, 0.8 + i * 0.75, 0.4, 0x62655f, 1)
    }
    this.stats.props += 1
    this.block(tx, tz, 7)

    // 高压输电塔：格构塔，给远景一个尖顶
    const px = -128
    const pz = -46
    const pbase = this.origin(px, pz, 0.3)
    const h = 34
    const baseHalf = 3.4
    const topHalf = 0.9
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        this.strut(
          'metal',
          pbase,
          new THREE.Vector3(sx * baseHalf, 0, sz * baseHalf),
          new THREE.Vector3(sx * topHalf, h, sz * topHalf),
          0.13,
          0x6c7069,
        )
      }
    }
    for (const t of [0.2, 0.45, 0.7, 0.9]) {
      const half = baseHalf + (topHalf - baseHalf) * t
      const y = h * t
      const corners: Array<[number, number]> = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]
      for (let i = 0; i < 4; i += 1) {
        const a = corners[i] ?? [0, 0]
        const b = corners[(i + 1) % 4] ?? [0, 0]
        this.strut(
          'metal',
          pbase,
          new THREE.Vector3(a[0] * half, y, a[1] * half),
          new THREE.Vector3(b[0] * half, y, b[1] * half),
          0.08,
          0x6c7069,
        )
      }
    }
    // 横担
    this.box('metal', 9, 0.22, 0.22, pbase, 0, h - 3, 0, 0x6c7069, 1.4)
    this.box('metal', 6.5, 0.2, 0.2, pbase, 0, h - 1.2, 0, 0x6c7069, 1.4)
    this.stats.props += 1
    this.block(px, pz, 5)
  }

  // ————————————————————————————— 道路设施 —————————————————————————————

  private buildRoadside(): void {
    // 电线杆：沿主路北侧，每 44m 一根，杆间挂三根下垂的线
    const poleXs = [-154, -110, -66, -22, 22, 66, 110, 154]
    const tops: THREE.Vector3[] = []
    for (const x of poleXs) {
      const z = 7.6
      const base = this.origin(x, z, 0)
      this.cyl('wood', 0.17, 0.24, 9.2, base, 0, 4.6, 0, 0x5b4830, { segments: 8 })
      this.box('wood', 2.4, 0.14, 0.14, base, 0, 8.5, 0, 0x53412c, 1)
      this.box('wood', 1.8, 0.12, 0.12, base, 0, 7.6, 0, 0x53412c, 1)
      // 绝缘子
      for (const dx of [-1, 0, 1]) {
        this.cyl('glass', 0.09, 0.09, 0.26, base, dx * 1.05, 8.7, 0, 0x2a3a3a, { segments: 6 })
      }
      tops.push(new THREE.Vector3(x, 8.7, z))
      this.stats.props += 1
    }
    for (let i = 0; i < tops.length - 1; i += 1) {
      const a = tops[i]
      const b = tops[i + 1]
      if (!a || !b) continue
      for (const dx of [-1.05, 0, 1.05]) {
        const from = new THREE.Vector3(a.x + dx, a.y, a.z)
        const to = new THREE.Vector3(b.x + dx, b.y, b.z)
        const points: THREE.Vector3[] = []
        for (let s = 0; s <= 8; s += 1) {
          const t = s / 8
          const point = new THREE.Vector3().lerpVectors(from, to, t)
          point.y -= Math.sin(Math.PI * t) * 1.35
          points.push(point)
        }
        const curve = new THREE.CatmullRomCurve3(points)
        const geo = new THREE.TubeGeometry(curve, 12, 0.035, 4, false)
        this.bucket('wire').add(geo, new THREE.Matrix4(), 0x14161a)
      }
    }

    // 路灯：南侧四盏，暖色灯头
    for (const x of [-72, -30, 12, 54]) {
      const base = this.origin(x, -6.4, 0)
      this.cyl('metal', 0.1, 0.14, 5.6, base, 0, 2.8, 0, 0x54595a, { segments: 8 })
      this.box('metal', 0.09, 0.09, 1.5, base, 0, 5.55, 0.7, 0x54595a, 1)
      this.box('metal', 0.7, 0.16, 0.42, base, 0, 5.62, 1.42, 0x4c5152, 1)
      this.box('glassLit', 0.52, 0.06, 0.3, base, 0, 5.53, 1.42, 0xffe0a8, 1)
      this.stats.props += 1
    }

    // 报废车辆：散在路肩上，锈色
    this.buildCar(-9, 2.2, 0.03, 0x6d3a2c)
    this.buildCar(28, -2.6, 0.02, 0x3f4a4c)
    this.buildCar(-58, 2.4, 0.12, 0x5a5145)
    this.buildCar(74, 1.8, -0.05, 0x6a5738)

    // 路边护栏：村口一段
    for (let i = 0; i < 10; i += 1) {
      this.box('metal', 0.1, 0.75, 0.1, this.origin(-30 + i * 2.2, 5.4), 0, 0.38, 0, 0x7b7f7c, 1)
    }
    this.box('metal', 22, 0.22, 0.08, this.origin(-20.1, 5.4), 0, 0.62, 0, 0x8a8e88, 2)
  }

  private buildCar(x: number, z: number, rot: number, color: number): void {
    const base = this.origin(x, z, rot)
    this.box('paint', 1.9, 0.62, 4.4, base, 0, 0.62, 0, color, 2)
    this.box('paint', 1.72, 0.58, 2.1, base, 0, 1.18, -0.15, color, 2)
    // 车窗：比车厢略宽一点点（0.02），才能从侧面看见，否则被车厢盒子吞掉
    this.box('glass', 1.76, 0.42, 2.06, base, 0, 1.28, -0.15, 0xffffff, 2)
    this.box('paint', 1.74, 0.14, 2.12, base, 0, 1.5, -0.15, color, 2)
    for (const sx of [-1, 1]) {
      for (const sz of [1.45, -1.45]) {
        this.cyl('rubber', 0.36, 0.36, 0.26, base, sx * 0.92, 0.36, sz, 0x1b1d1f, {
          segments: 12,
          rz: Math.PI / 2,
        })
      }
    }
    this.stats.props += 1
  }

  // ————————————————————————————— 材质提交 —————————————————————————————

  /**
   * 八个材质桶 → 八个 mesh。
   * 顺序有意义：先建材质再 merge，最后按材质属性单独处理投影（草/线不投影）。
   */
  private commitBuckets(): void {
    const s = this.surfaces
    const standard = (
      opts: THREE.MeshStandardMaterialParameters,
    ): THREE.MeshStandardMaterial => {
      const material = new THREE.MeshStandardMaterial({ vertexColors: true, ...opts })
      this.materials.push(material)
      return material
    }

    const materials: Record<string, THREE.MeshStandardMaterial> = {
      plaster: standard({
        map: s.plaster.map,
        normalMap: s.plaster.normalMap,
        normalScale: new THREE.Vector2(0.85, 0.85),
        roughness: 0.93,
        metalness: 0.02,
      }),
      concrete: standard({
        map: s.concrete.map,
        normalMap: s.concrete.normalMap,
        normalScale: new THREE.Vector2(0.9, 0.9),
        roughness: 0.9,
        metalness: 0.02,
      }),
      roof: standard({
        map: s.roof.map,
        normalMap: s.roof.normalMap,
        normalScale: new THREE.Vector2(1, 1),
        roughness: 0.85,
        metalness: 0.04,
      }),
      metal: standard({
        map: s.metal.map,
        normalMap: s.metal.normalMap,
        normalScale: new THREE.Vector2(1.2, 1.2),
        roughness: 0.58,
        metalness: 0.4,
      }),
      wood: standard({
        map: s.wood.map,
        normalMap: s.wood.normalMap,
        normalScale: new THREE.Vector2(0.9, 0.9),
        roughness: 0.88,
        metalness: 0.02,
      }),
      paint: standard({ roughness: 0.52, metalness: 0.45 }),
      glass: standard({
        color: 0xffffff,
        roughness: 0.08,
        metalness: 0.85,
        envMapIntensity: 1.8,
      }),
      glassLit: standard({
        color: 0xffffff,
        emissive: new THREE.Color(0xffb861),
        emissiveIntensity: 2.4,
        roughness: 0.2,
        metalness: 0.4,
      }),
      sand: standard({ roughness: 0.98, metalness: 0 }),
      rubber: standard({ roughness: 0.95, metalness: 0 }),
      wire: standard({ color: 0x9fa4a0, roughness: 0.7, metalness: 0.5 }),
    }

    const shadowless = new Set(['glass', 'glassLit', 'wire'])
    for (const [key, bucket] of this.buckets) {
      const material = materials[key]
      if (!material) continue
      const mesh = bucket.commit(material)
      if (!mesh) continue
      mesh.name = `STATIC_${key.toUpperCase()}`
      if (shadowless.has(key)) mesh.castShadow = false
      this.group.add(mesh)
      this.stats.drawCalls += 1
      const position = mesh.geometry.attributes.position
      this.stats.triangles += (position?.count ?? 0) / 3
    }
  }

  // ————————————————————————————— 植被 —————————————————————————————

  /**
   * 树 / 灌木 / 草 / 石头，全部 InstancedMesh。
   * 树的冠层每棵 3 团（不同偏移与缩放），比单个球更像 foliage；
   * 草用交叉面片 + alphaTest，只放在近景，远处交给地面顶点色。
   */
  private buildVegetation(): void {
    const treeCount = 240
    const treePositions: Array<{ x: number; z: number; y: number; height: number; radius: number }> = []
    let attempts = 0
    while (treePositions.length < treeCount && attempts < treeCount * 40) {
      attempts += 1
      const angle = this.range(0, Math.PI * 2)
      const radius = this.range(26, 205)
      const x = Math.sin(angle) * radius
      const z = Math.cos(angle) * radius
      // 路两侧留出净空（约 ±10.5m）：树冠直径可达 6m，只清 7m 的话冠子会伸进路面，
      // 沿路放置的相机也会一头扎进树冠里
      const dMain = Math.hypot(Math.max(0, Math.abs(x) - 215), z)
      const dBranch = distanceToSegment(x, z, BRANCH.ax, BRANCH.az, BRANCH.bx, BRANCH.bz)
      if (Math.min(dMain, dBranch) < 10.5) continue
      if (this.isBlocked(x, z, 3)) continue
      if (treePositions.some((t) => Math.hypot(t.x - x, t.z - z) < 3.4)) continue
      // 村庄半径（< 95m）里只留零星几棵：村子要能「读出来」，森林在外圈
      if (radius < 95 && this.rng() > 0.15) continue
      treePositions.push({
        x,
        z,
        y: terrainHeight(x, z),
        height: this.range(5.6, 11),
        radius: this.range(0.16, 0.28),
      })
    }

    // 树干
    const trunkGeo = new THREE.CylinderGeometry(0.72, 1, 1, 7)
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c4a34, roughness: 0.95, metalness: 0 })
    this.materials.push(trunkMat)
    this.geometries.push(trunkGeo)
    const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, treePositions.length)
    const matrix = new THREE.Matrix4()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    treePositions.forEach((tree, index) => {
      matrix.compose(
        new THREE.Vector3(tree.x, tree.y + tree.height * 0.42, tree.z),
        quaternion,
        scale.set(tree.radius, tree.height * 0.84, tree.radius),
      )
      trunkMesh.setMatrixAt(index, matrix)
    })
    trunkMesh.instanceMatrix.needsUpdate = true
    trunkMesh.castShadow = true
    trunkMesh.receiveShadow = true
    trunkMesh.name = 'STATIC_TREE_TRUNK'
    trunkMesh.computeBoundingSphere()
    this.group.add(trunkMesh)

    // 树冠：每棵 3 团
    const blobs = 3
    const leafGeo = new THREE.IcosahedronGeometry(1, 1)
    const leafMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0,
      flatShading: true,
    })
    this.materials.push(leafMat)
    this.geometries.push(leafGeo)
    const leafMesh = new THREE.InstancedMesh(leafGeo, leafMat, treePositions.length * blobs)
    const palette = [0x4d5f2c, 0x5f6c31, 0x77772f, 0x8a7136, 0x6a5f2c, 0x53652f]
    const leafColor = new THREE.Color()
    let leafIndex = 0
    treePositions.forEach((tree) => {
      // 树冠 = 一大团 + 两侧小团，压扁（y×0.75）并贴近树干顶端，
      // 避免「棒棒糖 / 气球」感：冠幅约占树高的 45%，而不是 60%+
      const crown = tree.height * 0.5
      const crownY = tree.y + tree.height * 0.72
      const main = crown * 0.66
      for (let b = 0; b < blobs; b += 1) {
        const angle = this.rng() * Math.PI * 2
        const spread = b === 0 ? 0 : crown * 0.42
        const r = b === 0 ? main : main * this.range(0.52, 0.72)
        const px = tree.x + Math.cos(angle) * spread
        const pz = tree.z + Math.sin(angle) * spread
        const py = crownY + (b === 0 ? crown * 0.06 : this.range(-0.35, 0.45))
        quaternion.setFromAxisAngle(UP, this.rng() * Math.PI * 2)
        matrix.compose(new THREE.Vector3(px, py, pz), quaternion, scale.set(r, r * 0.75, r))
        leafMesh.setMatrixAt(leafIndex, matrix)
        leafColor.setHex(this.pick(palette))
        leafColor.offsetHSL(0, 0, this.range(-0.04, 0.04))
        leafMesh.setColorAt(leafIndex, leafColor)
        leafIndex += 1
      }
    })
    leafMesh.instanceMatrix.needsUpdate = true
    if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true
    leafMesh.castShadow = true
    leafMesh.receiveShadow = true
    leafMesh.name = 'STATIC_TREE_LEAF'
    leafMesh.computeBoundingSphere()
    this.group.add(leafMesh)
    this.stats.trees = treePositions.length

    // 灌木
    const bushes: Array<{ x: number; z: number; y: number; r: number }> = []
    attempts = 0
    while (bushes.length < 420 && attempts < 420 * 22) {
      attempts += 1
      const angle = this.range(0, Math.PI * 2)
      const radius = this.range(12, 190)
      const x = Math.sin(angle) * radius
      const z = Math.cos(angle) * radius
      if (Math.abs(z) < 7 && Math.abs(x) < 215) continue
      if (distanceToSegment(x, z, BRANCH.ax, BRANCH.az, BRANCH.bx, BRANCH.bz) < 6) continue
      if (this.isBlocked(x, z, 1.2)) continue
      bushes.push({ x, z, y: terrainHeight(x, z), r: this.range(0.5, 1.35) })
    }
    const bushGeo = new THREE.IcosahedronGeometry(1, 1)
    const bushMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0,
      flatShading: true,
    })
    this.materials.push(bushMat)
    this.geometries.push(bushGeo)
    const bushMesh = new THREE.InstancedMesh(bushGeo, bushMat, bushes.length)
    bushes.forEach((bush, index) => {
      quaternion.setFromAxisAngle(UP, this.rng() * Math.PI * 2)
      matrix.compose(
        new THREE.Vector3(bush.x, bush.y + bush.r * 0.42, bush.z),
        quaternion,
        scale.set(bush.r, bush.r * 0.62, bush.r * 0.92),
      )
      bushMesh.setMatrixAt(index, matrix)
      leafColor.setHex(this.pick([0x3f5228, 0x4a5a2c, 0x5b6030, 0x6b6534]))
      bushMesh.setColorAt(index, leafColor)
    })
    bushMesh.instanceMatrix.needsUpdate = true
    if (bushMesh.instanceColor) bushMesh.instanceColor.needsUpdate = true
    bushMesh.castShadow = true
    bushMesh.receiveShadow = true
    bushMesh.name = 'STATIC_BUSH'
    bushMesh.computeBoundingSphere()
    this.group.add(bushMesh)
    this.stats.bushes = bushes.length

    // 草簇：交叉面片
    const planeA = new THREE.PlaneGeometry(1, 1)
    const planeB = new THREE.PlaneGeometry(1, 1)
    planeB.rotateY(Math.PI / 2)
    const tuftGeo = mergeGeometries([planeA, planeB], false) ?? planeA
    planeA.dispose()
    planeB.dispose()
    tuftGeo.translate(0, 0.5, 0)
    this.geometries.push(tuftGeo)
    const grassMat = new THREE.MeshStandardMaterial({
      map: this.surfaces.grass,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
      color: 0xffffff,
    })
    this.materials.push(grassMat)

    const tufts: Array<{ x: number; z: number; y: number; h: number; w: number; rot: number }> = []
    attempts = 0
    while (tufts.length < 2800 && attempts < 2800 * 14) {
      attempts += 1
      const angle = this.range(0, Math.PI * 2)
      const radius = this.range(6, 135)
      const x = Math.sin(angle) * radius
      const z = Math.cos(angle) * radius
      if (this.isBlocked(x, z, 0.4)) continue
      if (roadMask(x, z) > 0.35) continue
      tufts.push({
        x,
        z,
        y: terrainHeight(x, z),
        h: this.range(0.5, 1.15),
        w: this.range(0.7, 1.5),
        rot: this.range(0, Math.PI),
      })
    }
    const grassMesh = new THREE.InstancedMesh(tuftGeo, grassMat, tufts.length)
    tufts.forEach((tuft, index) => {
      quaternion.setFromAxisAngle(UP, tuft.rot)
      matrix.compose(new THREE.Vector3(tuft.x, tuft.y, tuft.z), quaternion, scale.set(tuft.w, tuft.h, tuft.w))
      grassMesh.setMatrixAt(index, matrix)
      // 草的贴图本身带绿，实例色只做「偏黄/偏青」的轻微偏移，给太绿会叠成黑
      leafColor.setHex(this.pick([0xd8cfa4, 0xc9c08c, 0xe2d8ae, 0xb9bd86]))
      grassMesh.setColorAt(index, leafColor)
    })
    grassMesh.instanceMatrix.needsUpdate = true
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true
    grassMesh.castShadow = false
    grassMesh.receiveShadow = true
    grassMesh.name = 'STATIC_GRASS'
    grassMesh.computeBoundingSphere()
    this.group.add(grassMesh)
    this.stats.grass = tufts.length

    // 石头：偏灰暗、偏小，集中在村外——太亮太近会像「散落的白球」
    const rocks: Array<{ x: number; z: number; y: number; s: number }> = []
    attempts = 0
    while (rocks.length < 90 && attempts < 90 * 20) {
      attempts += 1
      const angle = this.range(0, Math.PI * 2)
      const radius = this.range(85, 240)
      const x = Math.sin(angle) * radius
      const z = Math.cos(angle) * radius
      if (this.isBlocked(x, z, 1)) continue
      if (roadMask(x, z) > 0.08) continue
      rocks.push({ x, z, y: terrainHeight(x, z), s: this.range(0.35, 1.3) })
    }
    const rockGeo = new THREE.IcosahedronGeometry(1, 0)
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x6f6a5e,
      roughness: 0.96,
      metalness: 0.02,
      flatShading: true,
    })
    this.materials.push(rockMat)
    this.geometries.push(rockGeo)
    const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, rocks.length)
    rocks.forEach((rock, index) => {
      quaternion.setFromEuler(new THREE.Euler(this.range(0, 0.5), this.range(0, Math.PI), this.range(0, 0.5)))
      matrix.compose(
        new THREE.Vector3(rock.x, rock.y + rock.s * 0.25, rock.z),
        quaternion,
        scale.set(rock.s, rock.s * 0.62, rock.s * 0.9),
      )
      rockMesh.setMatrixAt(index, matrix)
    })
    rockMesh.instanceMatrix.needsUpdate = true
    rockMesh.castShadow = true
    rockMesh.receiveShadow = true
    rockMesh.name = 'STATIC_ROCK'
    rockMesh.computeBoundingSphere()
    this.group.add(rockMesh)
    this.stats.rocks = rocks.length

    this.stats.drawCalls += 5
  }

  /** 摘掉场景并释放所有 GPU 资源 */
  dispose(): void {
    this.group.removeFromParent()
    this.group.clear()
    for (const material of this.materials) material.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    for (const texture of this.surfaces.all) texture.dispose()
    this.materials.length = 0
    this.geometries.length = 0
    this.blockers.length = 0
    this.buckets.clear()
  }
}
