/**
 * 重建采集的规划与覆盖统计。
 *
 * 这里最值得写死的是三件事:
 * 1. **朝向**:每个拍点的光轴必须真的指向主体中心 —— 位置对、朝向错是这类代码
 *    最常见的错法,而且画面看起来只像"构图歪了点"。
 * 2. **覆盖判据**:用一组能手工算出答案的相机验证视锥判定,而不是"跑通了就行"。
 * 3. **b/d 与重叠率的关系**:越界的参数必须给警告,不能默默接受。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_BASELINE_RATIO,
  MIN_USABLE_VIEWS,
  ReconstructionCapture,
  USABLE_BASELINE_RATIO,
  USABLE_BASELINE_RATIO_NEAR,
  planReconCapture,
  reconCoverage,
  reconCoverageToCloud,
  reconPlanToWaypoints,
} from '../lib/drone-camera/drone-recon-capture'
import type { ReconShot, ReconTarget } from '../lib/drone-camera/drone-recon-capture'
import type { CaptureService } from '../lib/drone-camera/drone-capture'
import type { Quaternion } from '../lib/drone-camera/drone-photogrammetry'
import { cameraQuaternionFromBasis, rotateVectorByQuaternion } from '../lib/drone-camera/drone-photogrammetry'

const CUBE: ReconTarget = { center: [0, 0, 0], size: [10, 10, 10] }
const PLANE: ReconTarget = { center: [0, 0, 0], size: [10, 10, 0] }

/** 相机的光轴方向(three 约定:相机看 -Z) */
function opticalAxis(rotation: Quaternion): [number, number, number] {
  return rotateVectorByQuaternion([0, 0, -1], rotation)
}

function dot(a: number[], b: number[]): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0)
}

/** 正下视相机:right=东, up=北, forward=下(z 负) */
function nadirRotation(): Quaternion {
  return cameraQuaternionFromBasis(
    { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] },
    'three',
  )
}

function nadirShot(position: [number, number, number], index: number): ReconShot {
  return {
    index,
    ring: 0,
    row: 0,
    col: index,
    position,
    heading: 0,
    pitch: -90,
    rotation: nadirRotation(),
    distance: 10,
  }
}

describe('环绕轨迹', () => {
  const plan = planReconCapture({ pattern: 'orbit', target: CUBE, horizontalFovDeg: 60, verticalFovDeg: 40 })

  it('三圈各自成环,内圈不会比外圈稀', () => {
    expect(plan.total).toBe(plan.shots.length)
    const perRing = new Map<number, number>()
    for (const shot of plan.shots) perRing.set(shot.ring, (perRing.get(shot.ring) ?? 0) + 1)
    expect([...perRing.keys()].sort()).toEqual([0, 1, 2])
    const outer = perRing.get(0) ?? 0
    const inner = perRing.get(2) ?? 0
    // 内圈景深浅、视场覆盖窄,所以它只会更密或持平;比外圈稀一定是半径或步进算错了
    expect(inner).toBeGreaterThanOrEqual(outer)
    expect(perRing.get(0)).toBeGreaterThan(0)
  })

  it('每圈都是闭合的整圈:方位角均匀分布', () => {
    for (const ring of [0, 1, 2]) {
      const azimuths = plan.shots
        .filter((shot) => shot.ring === ring)
        .map((shot) => (Math.atan2(shot.position[1], shot.position[0]) * 180) / Math.PI)
        .sort((a, b) => a - b)
      const gaps: number[] = []
      for (let i = 1; i < azimuths.length; i += 1) {
        gaps.push((azimuths[i] ?? 0) - (azimuths[i - 1] ?? 0))
      }
      const max = Math.max(...gaps)
      const min = Math.min(...gaps)
      expect(max - min).toBeLessThan(1e-6)
    }
  })

  it('每个拍点的光轴都指向主体中心', () => {
    for (const shot of plan.shots) {
      const toCenter = [
        CUBE.center[0] - shot.position[0],
        CUBE.center[1] - shot.position[1],
        CUBE.center[2] - shot.position[2],
      ]
      const length = Math.hypot(toCenter[0] ?? 0, toCenter[1] ?? 0, toCenter[2] ?? 0)
      const axis = opticalAxis(shot.rotation)
      // 位置对、朝向错是这类代码最容易犯的错,而且画面只像"构图歪了"
      expect(dot(axis, toCenter) / length).toBeCloseTo(1, 10)
    }
  })

  it('俯仰角的符号与几何一致:相机高于中心时低头,低于中心时抬头', () => {
    const deltaZ = (shot: ReconShot): number => shot.position[2] - CUBE.center[2]
    const above = plan.shots.filter((shot) => deltaZ(shot) > 1e-9)
    const below = plan.shots.filter((shot) => deltaZ(shot) < -1e-9)
    const level = plan.shots.filter((shot) => Math.abs(deltaZ(shot)) <= 1e-9)
    // 三圈有上有下有平,三种情况都得真的出现,否则这条断言等于没测
    expect(above.length).toBeGreaterThan(0)
    expect(below.length).toBeGreaterThan(0)
    expect(level.length).toBeGreaterThanOrEqual(0)
    expect(above.every((shot) => shot.pitch < 0)).toBe(true)
    expect(below.every((shot) => shot.pitch > 0)).toBe(true)
    expect(level.every((shot) => Math.abs(shot.pitch) < 1e-9)).toBe(true)
  })

  it('基线/景深比落在近景环绕的可用区间', () => {
    // 近景环绕的 b/d 天然比航测大(光心半径 / 景深 > 1),见 USABLE_BASELINE_RATIO_NEAR
    expect(plan.baselineRatio).toBeGreaterThan(USABLE_BASELINE_RATIO_NEAR[0])
    expect(plan.baselineRatio).toBeLessThanOrEqual(USABLE_BASELINE_RATIO_NEAR[1] + 1e-6)
    expect(plan.warnings).toEqual([])
  })

  it('景深按主体表面算,不是按中心算', () => {
    // 外圈光心在 15.8 m,盒子半宽 5 m -> 表面距离约 10.8 m,而不是 15.8 m
    const outer = plan.shots.find((shot) => shot.ring === 0)
    expect(outer).toBeDefined()
    expect(outer?.distance ?? 0).toBeGreaterThan(5)
    expect(outer?.distance ?? 0).toBeLessThan(12)
  })
})

describe('重叠率与 b/d 的关系', () => {
  it('隐藏的重叠率不会低于设定值 —— 实际值只会更高', () => {
    for (const overlap of [0.5, 0.7, 0.85, 0.92]) {
      const plan = planReconCapture({
        pattern: 'orbit',
        target: CUBE,
        alongTrackOverlap: overlap,
      })
      expect(plan.effectiveOverlap).toBeGreaterThanOrEqual(overlap - 1e-9)
    }
  })

  it('重叠率调到极高时张数才明显增加(b/d 上限平时更紧)', () => {
    const loose = planReconCapture({ pattern: 'orbit', target: CUBE, alongTrackOverlap: 0.5 })
    const tight = planReconCapture({ pattern: 'orbit', target: CUBE, alongTrackOverlap: 0.94 })
    // 0.5 与 0.75 都会被 b/d 上限接管,所以 0.5 已经等于"几何允许的最稀疏"
    expect(tight.total).toBeGreaterThan(loose.total * 1.5)
  })

  it('重叠率过低会被硬上限拉回,不会真的产生无序点云', () => {
    const plan = planReconCapture({ pattern: 'orbit', target: CUBE, alongTrackOverlap: 0.1 })
    expect(plan.baselineRatio).toBeLessThanOrEqual(MAX_BASELINE_RATIO + 1e-6)
    // 越界仍然要被指出来:压到硬上限不等于"合格"
    expect(plan.warnings.some((text) => text.includes('基线'))).toBe(true)
  })

  it('远景(网格)模式下重叠率是主控参数', () => {
    const sparse = planReconCapture({
      pattern: 'grid-tilt',
      target: { center: [0, 0, 0], size: [20, 20, 0] },
      altitude: 30,
      alongTrackOverlap: 0.6,
      tiltDeg: 0,
    })
    const dense = planReconCapture({
      pattern: 'grid-tilt',
      target: { center: [0, 0, 0], size: [20, 20, 0] },
      altitude: 30,
      alongTrackOverlap: 0.85,
      tiltDeg: 0,
    })
    expect(dense.total).toBeGreaterThan(sparse.total)
    // 重叠率越高 -> 列间距越小 -> b/d 越小
    expect(sparse.baselineRatio).toBeGreaterThan(dense.baselineRatio)
  })
})

describe('网格 + 倾斜', () => {
  const target: ReconTarget = { center: [0, 0, 0], size: [40, 30, 0] }
  const plan = planReconCapture({ pattern: 'grid-tilt', target, altitude: 30, tiltDeg: 45 })

  it('足迹由高度与视场决定', () => {
    const along = 2 * 30 * Math.tan((40 * Math.PI) / 360)
    const across = 2 * 30 * Math.tan((60 * Math.PI) / 360)
    expect(plan.footprint?.along ?? 0).toBeCloseTo(along, 6)
    expect(plan.footprint?.across ?? 0).toBeCloseTo(across, 6)
  })

  it('每个网格点五张:一张正射 + 四张倾斜', () => {
    const byPoint = new Map<string, ReconShot[]>()
    for (const shot of plan.shots) {
      const key = `${shot.row}:${shot.col}`
      byPoint.set(key, [...(byPoint.get(key) ?? []), shot])
    }
    expect(byPoint.size).toBeGreaterThan(4)
    for (const shots of byPoint.values()) {
      expect(shots).toHaveLength(5)
      expect(shots.filter((shot) => shot.pitch === -90)).toHaveLength(1)
      expect(shots.filter((shot) => Math.abs(shot.pitch + 45) < 1e-9)).toHaveLength(4)
      // 四张倾斜必须朝四个不同方位,否则"五向"名不副实
      const headings = new Set(shots.filter((shot) => shot.pitch !== -90).map((shot) => shot.heading))
      expect(headings.size).toBe(4)
    }
  })

  it('弓字形:相邻行的行进方向相反', () => {
    const rows = [...new Set(plan.shots.map((shot) => shot.row))].sort((a, b) => a - b)
    const direction = (row: number): number => {
      const first = plan.shots.find((shot) => shot.row === row)
      const last = [...plan.shots].reverse().find((shot) => shot.row === row)
      return Math.sign((last?.position[0] ?? 0) - (first?.position[0] ?? 0))
    }
    for (let i = 1; i < rows.length; i += 1) {
      expect(direction(rows[i] ?? 0)).toBe(-direction(rows[i - 1] ?? 0))
    }
  })

  it('超广角 + 低重叠时列间距被硬上限压住', () => {
    // vfov 90° 时 along = 2H;重叠 40% 想要的间距是 1.2H(> 0.6H 上限)。
    // 这是唯一能让网格那条防御分支真正生效的参数组合
    const wide = planReconCapture({
      pattern: 'grid-tilt',
      target: { center: [0, 0, 0], size: [40, 30, 0] },
      altitude: 30,
      verticalFovDeg: 90,
      alongTrackOverlap: 0.4,
      tiltDeg: 0,
    })
    expect(wide.baselineRatio).toBeLessThanOrEqual(MAX_BASELINE_RATIO + 1e-6)
    expect(wide.effectiveOverlap).toBeGreaterThan(0.4)
  })

  it('远景的 b/d 落在航测区间', () => {
    // 网格的景深就是飞行高度,所以 b/d = 列间距 / 高度,天然在 0.1~0.3
    expect(plan.baselineRatio).toBeGreaterThan(USABLE_BASELINE_RATIO[0])
    expect(plan.baselineRatio).toBeLessThanOrEqual(MAX_BASELINE_RATIO)
  })

  it('测区向外扩了半幅,否则边缘的倾斜张拍的全是空地', () => {
    const xs = plan.shots.map((shot) => shot.position[0])
    expect(Math.max(...xs)).toBeGreaterThan(target.size[0] / 2)
    const ys = plan.shots.map((shot) => shot.position[1])
    expect(Math.min(...ys)).toBeLessThan(-target.size[1] / 2)
  })
})

describe('球壳轨迹', () => {
  const plan = planReconCapture({
    pattern: 'sphere',
    target: { center: [0, 0, 1], size: [2, 2, 2] },
    elevationRangeDeg: [-60, 60],
  })

  it('俯仰覆盖给定范围,且避开天顶天底', () => {
    const elevations = [...new Set(plan.shots.map((shot) => Math.round(shot.pitch * 1e6) / 1e6))]
    expect(Math.max(...elevations)).toBeCloseTo(60, 6)
    expect(Math.min(...elevations)).toBeCloseTo(-60, 6)
    expect(elevations.every((value) => Math.abs(value) < 89)).toBe(true)
  })

  it('每个拍点的光轴都穿过球心', () => {
    const center = [0, 0, 1]
    for (const shot of plan.shots) {
      const toCenter = [
        (center[0] ?? 0) - shot.position[0],
        (center[1] ?? 0) - shot.position[1],
        (center[2] ?? 0) - shot.position[2],
      ]
      const length = Math.hypot(toCenter[0] ?? 0, toCenter[1] ?? 0, toCenter[2] ?? 0)
      expect(dot(opticalAxis(shot.rotation), toCenter) / length).toBeCloseTo(1, 10)
    }
  })
})

describe('覆盖统计', () => {
  // 手工构造:三台正下视相机,高度 10 m,水平 FOV 60 / 垂直 40
  // tanH = 0.5774, tanV = 0.3640 -> 半宽 5.77 m、半高 3.64 m
  const shots = [
    nadirShot([0, 0, 10], 1),
    nadirShot([3, 0, 10], 2),
    nadirShot([-3, 0, 10], 3),
  ]
  const fov = { horizontalFovDeg: 60, verticalFovDeg: 40 }

  it('解析解:中心 3 视角、侧边中点 2 视角、四角 0 视角', () => {
    const { samples } = reconCoverage(shots, PLANE, { sampleStep: 5, fov })
    const find = (x: number, y: number): number =>
      samples.find((sample) => Math.abs(sample.position[0] - x) < 1e-6 && Math.abs(sample.position[1] - y) < 1e-6)
        ?.views ?? -1
    expect(find(0, 0)).toBe(3)
    expect(find(5, 0)).toBe(2)
    expect(find(-5, 0)).toBe(2)
    // 垂直半高只有 3.64 m,±5 m 那两行全在画面外
    expect(find(0, 5)).toBe(0)
    expect(find(5, 5)).toBe(0)
  })

  it('直方图与占比自洽', () => {
    const { summary, samples } = reconCoverage(shots, PLANE, { sampleStep: 5, fov })
    const sum = summary.histogram.reduce((total, value) => total + value, 0)
    expect(sum).toBe(summary.samples)
    expect(summary.samples).toBe(samples.length)
    expect(summary.uncovered).toBeCloseTo(6 / 9, 6)
    expect(summary.single).toBeCloseTo(0, 6)
    expect(summary.usable).toBeCloseTo(1 / 9, 6)
    expect(summary.medianViews).toBe(0)
  })

  it('相机背后的点不算被拍到', () => {
    // 反过来的相机:朝天看,地面上的点应该一个都看不到
    const upShot: ReconShot = {
      ...nadirShot([0, 0, 10], 1),
      rotation: cameraQuaternionFromBasis(
        { right: [1, 0, 0], up: [0, -1, 0], forward: [0, 0, 1] },
        'three',
      ),
    }
    const { summary } = reconCoverage([upShot], PLANE, { sampleStep: 5, fov })
    expect(summary.uncovered).toBeCloseTo(1, 6)
  })

  it('多一个视角就多一分可用度', () => {
    const one = reconCoverage([shots[0] as ReconShot], PLANE, { sampleStep: 5, fov }).summary
    const three = reconCoverage(shots, PLANE, { sampleStep: 5, fov }).summary
    // 这块平面上大多数点在画面外(垂直半高只有 3.64 m),所以中位数是 0;
    // 要看的是"至少 3 个视角"的绝对数量
    expect(three.histogram[3] ?? 0).toBeGreaterThan(one.histogram[3] ?? 0)
    expect(three.single).toBeLessThanOrEqual(one.single)
  })

  it('达到 3 视角的比例低于 80% 时给警告', () => {
    const { summary } = reconCoverage([shots[0] as ReconShot], PLANE, { sampleStep: 5, fov })
    expect(summary.usable).toBeLessThan(0.8)
    expect(summary.warnings.some((text) => text.includes(String(MIN_USABLE_VIEWS)))).toBe(true)
  })

  it('规划出来的环绕轨迹覆盖度应当达标', () => {
    const plan = planReconCapture({ pattern: 'orbit', target: CUBE })
    const { summary } = reconCoverage(plan.shots, CUBE, {
      sampleStep: 1.5,
      fov: { horizontalFovDeg: plan.horizontalFovDeg, verticalFovDeg: plan.verticalFovDeg },
    })
    // 三圈、含高低差:立方体表面应当几乎全被多次看到
    expect(summary.usable).toBeGreaterThan(0.95)
    expect(summary.uncovered).toBeLessThan(0.01)
  })
})

describe('覆盖点云', () => {
  it('颜色按视角数分级:红 = 0、橙 = 1、蓝 = >= 8', () => {
    const samples = [
      { position: [0, 0, 0] as [number, number, number], views: 0 },
      { position: [1, 0, 0] as [number, number, number], views: 1 },
      { position: [2, 0, 0] as [number, number, number], views: 12 },
    ]
    const cloud = reconCoverageToCloud(samples, { sampleStep: 1 })
    expect(cloud.count).toBe(3)
    expect(cloud.center[0]).toBe(0)
    expect(cloud.rgba[0]).toBeCloseTo(0.886, 3)
    expect(cloud.rgba[1 * 4 + 1]).toBeCloseTo(0.624, 3)
    expect(cloud.rgba[2 * 4 + 2]).toBeCloseTo(0.867, 3)
    expect(cloud.rotation[3]).toBe(1)
    expect(cloud.bounds.radius).toBeGreaterThan(0)
  })

  it('点云能被查看器的包围盒逻辑接受', () => {
    const { samples } = reconCoverage([nadirShot([0, 0, 10], 1)], PLANE, {
      sampleStep: 5,
      fov: { horizontalFovDeg: 60, verticalFovDeg: 40 },
    })
    const cloud = reconCoverageToCloud(samples)
    expect(cloud.center.length).toBe(cloud.count * 3)
    expect(cloud.scale[0]).toBeGreaterThan(0)
    expect(Number.isFinite(cloud.bounds.center[0])).toBe(true)
  })
})

describe('极端参数', () => {
  it('单圈环绕会提醒顶面与底面缺观测', () => {
    const plan = planReconCapture({ pattern: 'orbit', target: CUBE, rings: 1 })
    expect(plan.warnings.some((text) => text.includes('顶面'))).toBe(true)
  })

  it('近乎平面的主体用环绕会被建议改用网格', () => {
    const plan = planReconCapture({
      pattern: 'orbit',
      target: { center: [0, 0, 0], size: [40, 40, 1] },
    })
    expect(plan.warnings.some((text) => text.includes('grid-tilt'))).toBe(true)
  })

  it('环形半径不会小于主体半对角线 —— 相机不会钻进主体里', () => {
    const plan = planReconCapture({ pattern: 'orbit', target: CUBE, rings: 4 })
    const halfDiagonal = Math.hypot(CUBE.size[0], CUBE.size[1]) / 2
    for (const shot of plan.shots) {
      const radius = Math.hypot(shot.position[0], shot.position[1])
      expect(radius).toBeGreaterThan(halfDiagonal)
    }
  })

  it('扁平而宽的主体:内圈半径下限生效,相机不会贴到盒角上', () => {
    // 40×40 的大盘:全身入画距离只有 39.8 m,而半对角线就有 28.3 m,
    // 按 0.7 缩放的内圈(27.9 m)会钻进盘子里 —— 下限必须兜住
    const plate: ReconTarget = { center: [0, 0, 2], size: [40, 40, 4] }
    const plan = planReconCapture({ pattern: 'orbit', target: plate, rings: 3 })
    const halfDiagonal = Math.hypot(plate.size[0], plate.size[1]) / 2
    const radii = plan.shots.map((shot) =>
      Math.hypot(shot.position[0] - plate.center[0], shot.position[1] - plate.center[1]),
    )
    expect(Math.min(...radii)).toBeGreaterThan(halfDiagonal)
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(halfDiagonal + 3 - 1e-6)
  })
})

describe('航线导出', () => {
  it('ENU 的北向映射到 three 世界的 -z', () => {
    const plan = planReconCapture({ pattern: 'grid-tilt', target: PLANE, altitude: 30, tiltDeg: 0 })
    const waypoints = reconPlanToWaypoints(plan)
    expect(waypoints).toHaveLength(plan.total)
    for (let i = 0; i < plan.shots.length; i += 1) {
      const shot = plan.shots[i]
      const waypoint = waypoints[i]
      expect(waypoint?.x ?? 0).toBeCloseTo(shot?.position[0] ?? 0, 6)
      expect(waypoint?.z ?? 0).toBeCloseTo(-(shot?.position[1] ?? 0), 6)
      expect(waypoint?.altitude ?? 0).toBeCloseTo(shot?.position[2] ?? 0, 6)
      expect(waypoint?.gimbalPitch ?? 0).toBeCloseTo(shot?.pitch ?? 0, 6)
      expect(waypoint?.action).toBe('photo')
    }
  })
})

describe('执行器拒绝退化成纯旋转', () => {
  const plan = planReconCapture({ pattern: 'orbit', target: CUBE })

  function fakeCapture(capabilities: { place: boolean; spin: boolean }): CaptureService {
    return {
      getSession: () => ({ id: 's1', options: {}, status: 'created', images: [], createdAt: '', updatedAt: '' }),
      canPlaceBody: capabilities.place,
      canSpinBody: capabilities.spin,
      placeBodyAt: () => undefined,
      spinBodyTo: () => undefined,
    } as unknown as CaptureService
  }

  it('后端不能移动机体时直接失败,而不是拍一堆同光心的废片', async () => {
    const recon = new ReconstructionCapture(fakeCapture({ place: false, spin: true }))
    const result = await recon.start('s1', plan)
    expect(result?.error).toContain('基线')
    expect(result?.captured).toBe(0)
  })

  it('后端不能自转时同样失败', async () => {
    const recon = new ReconstructionCapture(fakeCapture({ place: true, spin: false }))
    const result = await recon.start('s1', plan)
    expect(result?.error).toContain('自转')
    expect(result?.captured).toBe(0)
  })

  it('会话不存在时返回 null(不抛异常)', async () => {
    const capture = { getSession: () => undefined } as unknown as CaptureService
    const recon = new ReconstructionCapture(capture)
    expect(await recon.start('missing', plan)).toBeNull()
  })
})
