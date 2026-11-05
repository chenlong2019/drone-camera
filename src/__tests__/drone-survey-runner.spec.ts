import { describe, expect, it } from 'vitest'
import { CaptureService, type CaptureCameraState, type VirtualShot } from '../lib/drone-camera/drone-capture'
import { DroneSim } from '../lib/drone-camera/drone-sim'
import { ObliqueSurveyRunner, planObliqueSurvey, type ObliqueSurveyFlightHost } from '../lib/drone-camera/drone-survey'

function setup() {
  const sim = new DroneSim()
  sim.powerOn()
  for (let i = 0; i < 300; i++) sim.step(1 / 60)
  sim.phase = 'flying'
  sim.position.y = 20
  const full = planObliqueSurvey({ area: { center: [0, 0], size: [4, 4] }, altitude: 20, hoverSeconds: 0.2 })
  const plan = { ...full, shots: full.shots.slice(0, 10), waypoints: full.waypoints.slice(0, 10), stationCount: 2 }
  const host = {
    sim,
    setMission: sim.setMission.bind(sim),
    setMissionConfig: sim.setMissionConfig.bind(sim),
    startMission: sim.startMission.bind(sim),
    pauseMission: sim.pauseMission.bind(sim),
    resumeMission: sim.resumeMission.bind(sim),
    stopMission: sim.stopMission.bind(sim),
    spinBodyTo: sim.spinTo.bind(sim),
    getBodyHeading: () => sim.heading,
    setMissionWaypointsVisible: () => {},
    setMissionPathVisible: () => {},
  } as unknown as ObliqueSurveyFlightHost
  let resolve: ((shot: VirtualShot | null) => void) | undefined
  let reject: ((error: Error) => void) | undefined
  const requested: Array<{ index: number; heading: number; position: number[] }> = []
  const camera = (): CaptureCameraState => ({
    pose: { position: [sim.position.x, -sim.position.z, sim.position.y], rotation: [0, 0, 0, 1], coordinateFrame: 'local-enu' },
    intrinsics: { width: 640, height: 480, fx: 500, fy: 500, cx: 320, cy: 240, calibrationSource: 'known' },
    frame: { width: 640, height: 480 },
  })
  const capture = new CaptureService({ provider: {
    getCaptureCamera: camera,
    setCaptureView: () => {},
    requestPhoto: () => new Promise((ok, fail) => {
      requested.push({ index: sim.missionIndex, heading: sim.heading, position: [...camera().pose.position] })
      resolve = ok
      reject = fail
    }),
  } })
  const session = capture.createSession({ source: 'virtual-camera', name: 'test' })
  const runner = new ObliqueSurveyRunner(host, capture, { captureRetries: 0 })
  runner.load(plan)
  runner.start(session.id)
  // Model a low frame rate: many physical substeps between render/update calls.
  const frame = () => {
    for (let i = 0; i < 180; i++) sim.step(1 / 60)
    runner.update()
  }
  return { sim, plan, runner, session, frame, requested,
    async finishPhoto() {
      resolve?.({ width: 640, height: 480, dataUrl: 'data:image/png;base64,AAAA', camera: camera() })
      resolve = undefined
      await Promise.resolve()
      await Promise.resolve()
    },
    async failPhoto() {
      reject?.(new Error('render failed'))
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe('survey execution across slow render frames', () => {
  it('waits for image completion and captures each planned view once at the correct location and heading', async () => {
    const task = setup()
    for (let frame = 0; frame < 150 && task.runner.running; frame++) {
      task.frame()
      if (task.requested.length > task.session.images.length) {
        const at = { ...task.sim.position }
        const index = task.sim.missionIndex
        // Capture stays pending while multiple flight frames elapse.
        for (let i = 0; i < 8; i++) task.frame()
        expect(task.sim.position).toEqual(at)
        expect(task.sim.missionIndex).toBe(index)
        await task.finishPhoto()
      }
    }
    expect(task.runner.progress.state).toBe('done')
    expect(task.session.images).toHaveLength(10)
    expect(task.requested.map((item) => item.index)).toEqual([0,1,2,3,4,5,6,7,8,9])
    task.requested.forEach((actual, i) => {
      const shot = task.plan.shots[i]!
      expect(Math.abs(((actual.heading - shot.heading + 540) % 360) - 180)).toBeLessThan(1.5)
      expect(Math.hypot(...actual.position.map((p, axis) => p - shot.position[axis]!))).toBeLessThan(1)
    })
    expect(task.session.images.map((image) => image.metadata.recon?.index)).toEqual([1,2,3,4,5,6,7,8,9,10])
  })

  it('keeps user pause while an in-flight capture completes, then continues without duplicates', async () => {
    const task = setup()
    for (let i=0; i<80 && task.requested.length===0; i++) task.frame()
    expect(task.requested).toHaveLength(1)
    expect(task.runner.pause()).toBe(true)
    await task.finishPhoto()
    task.frame()
    expect(task.runner.progress.state).toBe('paused')
    expect(task.runner.resume()).toBe(true)
    for (let i=0; i<80 && task.requested.length<2; i++) task.frame()
    expect(task.requested.map((s)=>s.index)).toEqual([0,1])
    task.runner.cancel()
    await task.finishPhoto()
    expect(task.runner.progress.state).toBe('cancelled')
    expect(task.sim.missionStatus).toBe('idle')
    expect(task.sim.spinTarget).toBeNull()
  })

  it('exits capture exceptions and manual mission stops instead of waiting forever', async () => {
    const task = setup()
    for (let i=0; i<80 && task.requested.length===0; i++) task.frame()
    await task.failPhoto()
    expect(task.runner.progress.state).toBe('failed')
    expect(task.sim.missionStatus).toBe('idle')
    const stopped = setup()
    stopped.sim.stopMission()
    stopped.runner.update()
    expect(stopped.runner.progress.state).toBe('failed')
  })

  it('clears a waypoint hold when the flight core is paused through its own API', async () => {
    const task = setup()
    const holdState = () => (task.sim as unknown as { missionWaypointHold: unknown }).missionWaypointHold
    for (let i = 0; i < 80 && !(task.sim.missionStage === 'hover' && holdState()); i++) task.frame()
    expect(holdState()).not.toBeNull()
    expect(task.sim.pauseMission('manual')).toBe(true)
    expect(holdState()).toBeNull()
    task.frame()
    expect(task.runner.progress.state).toBe('paused')
    await task.finishPhoto()
    task.frame()
    expect(task.runner.progress.state).toBe('paused')
    task.runner.cancel()
  })
})
