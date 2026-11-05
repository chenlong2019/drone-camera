import { describe, expect, it } from 'vitest'
import { planObliqueSurvey } from '../lib/drone-camera/drone-survey'
import { DroneSim } from '../lib/drone-camera/drone-sim'

describe('园区倾斜摄影航线规划', () => {
  it('把 Three.js x/z 测区转换为可执行航点，并为每个测绘站生成五向取景', () => {
    const plan = planObliqueSurvey({
      id: 'campus-demo',
      area: { center: [20, -10], size: [80, 60] },
      targetHeight: 24,
      altitude: 36,
      tiltDeg: 40,
      speed: 7,
      hoverSeconds: 2,
    })

    expect(plan.id).toBe('campus-demo')
    expect(plan.stationCount).toBeGreaterThan(0)
    expect(plan.shots).toHaveLength(plan.waypoints.length)
    expect(plan.shots.length).toBe(plan.stationCount * 5)
    expect(plan.waypoints.every((waypoint) => waypoint.action === 'photo')).toBe(true)
    expect(plan.waypoints.every((waypoint) => waypoint.speed === 7)).toBe(true)
    expect(plan.waypoints.every((waypoint) => waypoint.hoverSeconds === 2)).toBe(true)
    expect(plan.waypoints[0]?.x).toBeCloseTo(plan.shots[0]?.position[0] ?? 0)
    expect(plan.waypoints[0]?.z).toBeCloseTo(-(plan.shots[0]?.position[1] ?? 0))
    expect(plan.waypoints[0]?.altitude).toBeCloseTo(plan.shots[0]?.position[2] ?? 0)
  })

  it('地面测区保持零高度目标,并把 Three.js z 轴反向映射到 ENU', () => {
    const plan = planObliqueSurvey({
      area: { center: [36, 30], size: [160, 136] },
      targetHeight: 0,
      altitude: 35,
    })

    expect(plan.target.center).toEqual([36, -30, 0])
    expect(plan.target.size).toEqual([160, 136, 0])
    expect(plan.waypoints.every((waypoint) => waypoint.altitude > 0)).toBe(true)
  })

  it('保留摄影测量规划器的覆盖告警与估算时长', () => {
    const plan = planObliqueSurvey({
      area: { center: [0, 0], size: [20, 20] },
      altitude: 25,
      tiltDeg: 0,
    })

    expect(plan.geometry.pattern).toBe('grid-tilt')
    expect(plan.estimatedSeconds).toBeGreaterThan(0)
    expect(Array.isArray(plan.warnings)).toBe(true)
  })

  it('任务悬停阶段允许机体自转到倾斜取景航向', () => {
    const sim = new DroneSim()
    sim.mission = [{
      x: 0,
      z: 0,
      altitude: 20,
      speed: 6,
      hoverSeconds: 5,
      gimbalPitch: -40,
      action: 'photo',
    }]
    sim.position.y = 20
    ;(sim as unknown as { satellites: number }).satellites = 18
    sim.phase = 'waypoint'
    sim.missionStatus = 'running'
    sim.missionIndex = 0
    sim.missionStage = 'hover'
    sim.spinTo(90)
    sim.step(1 / 60)

    expect(sim.heading).toBeGreaterThan(0)
    expect(sim.spinTarget).toBe(90)
  })
})
