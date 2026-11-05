import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CaptureService } from '@/lib/drone-camera/drone-capture'
import { DroneControlPanel } from '@/lib/drone-camera/drone-panel'
import type { MissionPanel } from '@/lib/drone-camera/mission-panel'
import {
  ObliqueSurveyRunner,
  planObliqueSurvey,
  type ObliqueSurveyPlan,
  type ObliqueSurveyProgress,
} from '@/lib/drone-camera/drone-survey'
import { createDroneControl } from '@/lib/drone-camera/drone-engine'
import type { DroneFly } from '@/lib/drone-camera/drone-fly'
import type { ObstacleSpec } from '@/lib/drone-camera/drone-world'
import type { SplatCloud } from '@/lib/drone-camera/drone-splat'
import campusPlan from './campus/campus-plan.json'

export type DigitalCampusStage = 'loading' | 'ready' | 'preparing' | 'running' | 'paused' | 'done' | 'cancelled' | 'failed'

export interface DigitalCampusSnapshot {
  stage: DigitalCampusStage
  stations: number
  total: number
  captured: number
  failed: number
  estimatedSeconds: number
  altitude: number
  tiltDeg: number
  warnings: string[]
  message: string
  fps: number
  flightAltitude: number
  waypoint: number
  pointCloudPoints: number
}

export interface DigitalCampusDemoOptions {
  altitude?: number
  tiltDeg?: number
}

// 覆盖中央草坪，并向西/北扩到相邻内环路边缘；只按地面采样，不重建建筑体量。
const DEFAULT_AREA = { center: [36, 30] as [number, number], size: [160, 136] as [number, number] }
const DEFAULT_TARGET_HEIGHT = 0
const POINT_CLOUD_SAMPLE_STEP = 2

function makeSnapshot(overrides: Partial<DigitalCampusSnapshot> = {}): DigitalCampusSnapshot {
  return {
    stage: 'loading',
    stations: 0,
    total: 0,
    captured: 0,
    failed: 0,
    estimatedSeconds: 0,
    altitude: 35,
    tiltDeg: 38,
    warnings: [],
    message: '正在加载数字园区与飞控内核…',
    fps: 0,
    flightAltitude: 0,
    waypoint: 0,
    pointCloudPoints: 0,
    ...overrides,
  }
}

function buildEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene): THREE.WebGLRenderTarget {
  const skyCanvas = document.createElement('canvas')
  skyCanvas.width = 1024
  skyCanvas.height = 512
  const context = skyCanvas.getContext('2d')!
  const gradient = context.createLinearGradient(0, 0, 0, 512)
  gradient.addColorStop(0, '#6098c7')
  gradient.addColorStop(0.43, '#d3e7f5')
  gradient.addColorStop(0.55, '#f6f8fa')
  gradient.addColorStop(1, '#96a790')
  context.fillStyle = gradient
  context.fillRect(0, 0, 1024, 512)
  const texture = new THREE.CanvasTexture(skyCanvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.mapping = THREE.EquirectangularReflectionMapping
  const pmrem = new THREE.PMREMGenerator(renderer)
  const environment = pmrem.fromEquirectangular(texture)
  scene.environment = environment.texture
  scene.environmentIntensity = 0.42
  texture.dispose()
  pmrem.dispose()
  return environment
}

function campusObstacles(): ObstacleSpec[] {
  return campusPlan.buildings.map((building) => ({
    name: `campus-${building.id}`,
    label: building.name,
    x: building.x,
    z: building.z,
    width: building.podiumWidth ?? building.width,
    depth: building.podiumDepth ?? building.depth,
    height: (building.baseHeight ?? 0) + building.height + (building.roofRoomHeight ?? 0),
    color: 0x6a8391,
  }))
}

export class DigitalCampusDemo {
  private readonly root: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly panelHost: HTMLElement
  private readonly listeners = new Set<(snapshot: DigitalCampusSnapshot) => void>()
  private readonly options: DigitalCampusDemoOptions
  private snapshotValue: DigitalCampusSnapshot
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private controls: OrbitControls | null = null
  private drone: DroneFly | null = null
  private capture: CaptureService | null = null
  private runner: ObliqueSurveyRunner | null = null
  private sessionId = ''
  private plan: ObliqueSurveyPlan | null = null
  private panel: DroneControlPanel | null = null
  private missionPanel: MissionPanel | null = null
  private missionPanelPromise: Promise<MissionPanel> | null = null
  private runnerUnsubscribe: (() => void) | null = null
  private captureUnsubscribe: (() => void) | null = null
  private animationFrame = 0
  private startTimer: number | null = null
  private destroyed = false
  private environment: THREE.WebGLRenderTarget | null = null
  private lastFrameAt = 0
  private frameCount = 0
  private telemetryAt = 0
  private telemetryFrames = 0
  private readonly launchPosition = new THREE.Vector3(-35, 0, 100)
  private pointCloud: SplatCloud | null = null
  private pointCloudMesh: THREE.Points | null = null
  private readonly mountTimings: Record<string, number> = {}
  private mountStartedAt = 0

  constructor(root: HTMLElement, canvas: HTMLCanvasElement, panelHost: HTMLElement, options: DigitalCampusDemoOptions = {}) {
    this.root = root
    this.canvas = canvas
    this.panelHost = panelHost
    this.options = options
    this.snapshotValue = makeSnapshot({
      altitude: options.altitude ?? 35,
      tiltDeg: options.tiltDeg ?? 38,
    })
  }

  get snapshot(): DigitalCampusSnapshot {
    return { ...this.snapshotValue, warnings: [...this.snapshotValue.warnings] }
  }

  private markMount(label: string): void {
    this.mountTimings[label] = Math.round(performance.now() - this.mountStartedAt)
  }

  subscribe(listener: (snapshot: DigitalCampusSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => this.listeners.delete(listener)
  }

  async mount(): Promise<void> {
    if (this.renderer) return
    this.mountStartedAt = performance.now()
    this.markMount('start')
    // Start the route-only campus chunk before WebGL setup; Vite can fetch it while the renderer boots.
    const campusPromise = import('./campus/createCampusModel')
      .then((module) => module.createCampusModel({ vegetationDetail: 'flight' }))
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.02
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer = renderer

    const scene = new THREE.Scene()
    scene.name = 'digital-campus-drone-demo'
    scene.background = new THREE.Color('#dceaf4')
    scene.fog = new THREE.Fog('#dceaf4', 360, 1050)
    this.environment = buildEnvironment(renderer, scene)
    this.markMount('environment')
    this.scene = scene

    const camera = new THREE.PerspectiveCamera(38, 1, 0.35, 2200)
    camera.position.set(248, 224, 307)
    this.camera = camera
    const controls = new OrbitControls(camera, this.canvas)
    controls.target.set(0, 22, 0)
    controls.enableDamping = true
    controls.dampingFactor = 0.07
    controls.minDistance = 16
    controls.maxDistance = 1500
    controls.maxPolarAngle = Math.PI * 0.54
    this.controls = controls

    const [campus, drone] = await Promise.all([
      campusPromise,
      createDroneControl({
        engine: 'three',
        scene,
        camera,
        renderer,
        controls,
        obstacles: campusObstacles(),
      }),
    ])
    this.markMount('campusAndDrone')
    scene.add(campus.root)
    const lights = new THREE.Group()
    const sun = new THREE.DirectionalLight('#fff8ed', campusPlan.lighting.intensity)
    sun.position.fromArray(campusPlan.lighting.sun)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    Object.assign(sun.shadow.camera, { left: -240, right: 240, top: 240, bottom: -240, near: 10, far: 700 })
    sun.shadow.bias = -0.00018
    sun.shadow.normalBias = 0.16
    // 园区静态阴影只绘制一次；不让高密度建筑和树木每帧重复投影。
    sun.shadow.autoUpdate = false
    sun.shadow.needsUpdate = true
    lights.add(sun, new THREE.HemisphereLight('#eaf5ff', '#9aaa9a', campusPlan.lighting.hemisphere))
    const fill = new THREE.DirectionalLight('#d7e8ff', 0.4)
    fill.position.set(180, 150, -100)
    lights.add(fill)
    scene.add(lights)

    this.drone = drone
    if (this.destroyed) {
      drone.destroy()
      this.drone = null
      return
    }
    drone.setCameraMode('orbit')
    drone.sim.setSpeedScale(3)
    drone.world?.setGroundVisible(false)
    drone.world?.setObstaclesVisible(false)
    drone.sim.position = { ...this.launchPosition }
    drone.model?.traverse((node) => { node.castShadow = false })

    const capture = new CaptureService({ provider: drone })
    this.capture = capture
    this.createSession()
    this.panel = new DroneControlPanel(drone, {
      container: this.panelHost,
      position: 'top-right',
      title: '飞控控制',
      captureService: capture,
      panorama: false,
      adaptive: false,
    })
    this.runner = new ObliqueSurveyRunner(drone, capture, {
      onFinished: (result) => {
        if (result.state === 'done' || result.state === 'failed') capture.finishSession(result.sessionId)
        if (result.state === 'done' || result.state === 'cancelled' || result.state === 'failed') void this.buildPointCloud()
      },
    })
    this.runnerUnsubscribe = this.runner.subscribe((progress) => this.applyProgress(progress))
    this.captureUnsubscribe = capture.subscribe(() => this.emit())
    this.markMount('panels')
    this.buildPlan(this.options.altitude ?? 35, this.options.tiltDeg ?? 38)
    this.markMount('plan')
    this.resize()
    window.addEventListener('resize', this.resize)
    this.snapshotValue = { ...this.snapshotValue, stage: 'ready', message: '航线已生成，点击开始自主采集。' }
    this.emit()
    this.render()
  }

  buildPlan(altitude: number, tiltDeg: number): boolean {
    if (!this.runner || this.runner.running) return false
    this.clearPointCloud()
    const plan = planObliqueSurvey({
      id: 'digital-campus-center-roads',
      area: DEFAULT_AREA,
      targetHeight: DEFAULT_TARGET_HEIGHT,
      altitude,
      tiltDeg,
      horizontalFovDeg: 60,
      verticalFovDeg: 40,
      alongTrackOverlap: 0.5,
      sideOverlap: 0.4,
      speed: 8,
      hoverSeconds: 1.5,
    })
    if (!this.runner.load(plan)) return false
    // 同一测绘站有五张照片，逐照片绘制标牌会重复叠画数百个透明网格。
    // 默认显示航线和当前目标；全部航点仍可从列表查看。
    this.drone?.setMissionWaypointsVisible(false)
    this.plan = plan
    this.snapshotValue = {
      ...this.snapshotValue,
      stage: 'ready',
      stations: plan.stationCount,
      total: plan.shots.length,
      captured: 0,
      failed: 0,
      estimatedSeconds: plan.estimatedSeconds,
      altitude,
      tiltDeg,
      warnings: [...plan.warnings],
      message: '航线已生成，点击开始自主采集。',
    }
    this.drone?.frameMission()
    this.emit()
    return true
  }

  start(): void {
    const drone = this.drone
    const runner = this.runner
    if (!drone || !runner || !this.plan || runner.running || this.snapshotValue.stage === 'preparing') return
    if (this.capture?.getSession(this.sessionId)?.status !== 'created') {
      this.createSession()
      runner.load(this.plan)
      drone.setMissionWaypointsVisible(false)
    }
    drone.setArmsFolded(false)
    drone.powerOn()
    if (!drone.airborne) drone.sim.position = { ...this.launchPosition }
    drone.sim.config.timeScale = 10
    this.snapshotValue = { ...this.snapshotValue, stage: 'preparing', message: '正在展开机臂、预热传感器并等待定位…' }
    this.emit()
    const startedAt = performance.now()
    const tryStart = (): void => {
      this.startTimer = null
      if (this.destroyed || !this.runner || !this.capture) return
      const ready = drone.airborne || drone.sim.canTakeOff
      if (ready && this.runner.start(this.sessionId)) return
      if (performance.now() - startedAt < 15000) {
        this.startTimer = window.setTimeout(tryStart, 120)
      } else {
        const problem = drone.preflightChecks.filter((item) => item.blocking && !item.ok).map((item) => item.label).join('、')
        this.snapshotValue = { ...this.snapshotValue, stage: 'failed', message: `起飞前检查未通过：${problem || '飞行器未就绪'}` }
        this.emit()
      }
    }
    this.startTimer = window.setTimeout(tryStart, 180)
  }

  togglePause(): void {
    const runner = this.runner
    if (!runner) return
    if (runner.progress.state === 'paused') runner.resume()
    else runner.pause()
  }

  cancel(): void {
    if (this.startTimer !== null) window.clearTimeout(this.startTimer)
    this.startTimer = null
    if (this.snapshotValue.stage === 'preparing') {
      this.snapshotValue = { ...this.snapshotValue, stage: 'cancelled', message: '已取消起飞。' }
      this.emit()
    } else {
      this.runner?.cancel()
    }
  }

  showFlightPanel(visible: boolean): void {
    this.panel?.setVisible(visible)
  }

  private async ensureMissionPanel(): Promise<MissionPanel | null> {
    const drone = this.drone
    if (!drone) return null
    if (this.missionPanel) return this.missionPanel
    this.missionPanelPromise ??= import('@/lib/drone-camera/mission-panel')
      .then(({ MissionPanel }) => new MissionPanel(drone, {
        container: this.panelHost,
        position: 'top-left',
        title: '测绘航线',
        sceneEdit: false,
        adaptive: false,
        visible: false,
      }))
    const panel = await this.missionPanelPromise
    if (!this.missionPanel) this.missionPanel = panel
    return this.missionPanel
  }

  showMissionPanel(visible: boolean): void {
    if (!visible) {
      this.missionPanel?.setVisible(false)
      return
    }
    void this.ensureMissionPanel().then((panel) => panel?.setVisible(true))
  }

  /** 开发环境的只读诊断，验证交互与渲染循环使用。 */
  getDiagnostics() {
    return {
      frames: this.frameCount,
      camera: this.camera?.position.toArray(),
      target: this.controls?.target.toArray(),
      orbitEnabled: this.controls?.enabled,
      mountTimings: { ...this.mountTimings },
      triangles: this.renderer?.info.render.triangles,
      drawCalls: this.renderer?.info.render.calls,
      sceneGroups: this.scene?.children.map((group) => {
        let meshes = 0
        group.traverse((node) => { if (node instanceof THREE.Mesh) meshes += 1 })
        return { name: group.name, meshes }
      }),
      phase: this.drone?.phase,
      missionStage: this.drone?.sim.missionStage,
      progress: this.runner?.progress,
      captureBusy: this.runner?.busy,
      ...this.snapshot,
    }
  }

  frameMission(): void {
    this.drone?.frameMission()
  }

  resetView(): void {
    const camera = this.camera
    const controls = this.controls
    if (!camera || !controls) return
    this.drone?.setOrbitCamera(new THREE.Vector3(248, 224, 307), new THREE.Vector3(0, 22, 0))
    controls.update()
  }

  exportManifest(): string {
    return this.capture?.exportManifest(this.sessionId) ?? ''
  }

  async exportPointCloud(): Promise<string> {
    if (!this.pointCloud) return ''
    const { encodePointCloudPly } = await import('@/lib/drone-camera/drone-splat')
    return encodePointCloudPly(this.pointCloud)
  }

  private clearPointCloud(): void {
    this.pointCloud = null
    const mesh = this.pointCloudMesh
    if (!mesh) return
    this.scene?.remove(mesh)
    mesh.geometry.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((item) => item.dispose())
    else material.dispose()
    this.pointCloudMesh = null
    this.snapshotValue = { ...this.snapshotValue, pointCloudPoints: 0 }
  }

  private replacePointCloudMesh(): void {
    const scene = this.scene
    const cloud = this.pointCloud
    if (!scene || !cloud || cloud.count === 0) return
    this.clearPointCloud()
    this.pointCloud = cloud

    // Planner/coverage use ENU (x east, y north, z up); Three.js uses (x, up, -north).
    const positions = new Float32Array(cloud.count * 3)
    const colors = new Float32Array(cloud.count * 3)
    for (let i = 0; i < cloud.count; i += 1) {
      positions[i * 3] = cloud.center[i * 3] ?? 0
      positions[i * 3 + 1] = cloud.center[i * 3 + 2] ?? 0
      positions[i * 3 + 2] = -(cloud.center[i * 3 + 1] ?? 0)
      colors[i * 3] = cloud.rgba[i * 4] ?? 0
      colors[i * 3 + 1] = cloud.rgba[i * 4 + 1] ?? 0
      colors[i * 3 + 2] = cloud.rgba[i * 4 + 2] ?? 0
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const material = new THREE.PointsMaterial({
      size: 1.1,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    })
    const mesh = new THREE.Points(geometry, material)
    mesh.name = 'digital-campus-survey-point-cloud'
    mesh.frustumCulled = false
    this.pointCloudMesh = mesh
    scene.add(mesh)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.startTimer !== null) window.clearTimeout(this.startTimer)
    this.runner?.cancel('页面卸载')
    this.runnerUnsubscribe?.()
    this.captureUnsubscribe?.()
    this.panel?.destroy()
    this.missionPanel?.destroy()
    this.missionPanelPromise = null
    this.drone?.destroy()
    this.controls?.dispose()
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    const textures = new Set<THREE.Texture>()
    this.scene?.traverse((node) => {
      if (node instanceof THREE.Mesh || node instanceof THREE.Line || node instanceof THREE.Points) {
        geometries.add(node.geometry)
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          materials.add(material)
          for (const value of Object.values(material)) {
            if (value instanceof THREE.Texture) textures.add(value)
          }
        }
      }
      if (node instanceof THREE.DirectionalLight || node instanceof THREE.SpotLight) node.shadow.dispose()
    })
    for (const geometry of geometries) geometry.dispose()
    for (const material of materials) material.dispose()
    for (const texture of textures) texture.dispose()
    this.environment?.dispose()
    this.scene?.clear()
    for (const session of this.capture?.listSessions() ?? []) {
      this.capture?.clearImages(session.id)
      this.capture?.removeSession(session.id)
    }
    this.renderer?.dispose()
    window.removeEventListener('resize', this.resize)
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame)
    this.listeners.clear()
  }

  private createSession(): void {
    if (!this.capture) return
    const session = this.capture.createSession({
      source: 'virtual-camera',
      name: '数字园区中心与环路地面点云',
      sceneId: 'digital-campus',
      sceneVersion: campusPlan.revision,
    })
    this.sessionId = session.id
  }

  private async buildPointCloud(): Promise<void> {
    const plan = this.plan
    const session = this.capture?.getSession(this.sessionId)
    if (!plan || !session) return
    const capturedIndexes = new Set(session.images.map((image) => image.metadata.recon?.index))
    const shots = plan.geometry.shots.filter((shot) => capturedIndexes.has(shot.index + 1))
    if (shots.length === 0) {
      this.clearPointCloud()
      return
    }
    const { reconCoverage, reconCoverageToCloud } = await import('@/lib/drone-camera/drone-recon-capture')
    const coverage = reconCoverage(shots, plan.target, {
      sampleStep: POINT_CLOUD_SAMPLE_STEP,
      fov: {
        horizontalFovDeg: plan.geometry.horizontalFovDeg,
        verticalFovDeg: plan.geometry.verticalFovDeg,
      },
    })
    const observedSamples = coverage.samples.filter((sample) => sample.views > 0)
    if (observedSamples.length === 0) {
      this.clearPointCloud()
      return
    }
    const cloud = reconCoverageToCloud(observedSamples, {
      sampleStep: coverage.sampleStep,
      name: '数字园区中心与环路地面覆盖',
    })
    this.pointCloud = cloud
    this.replacePointCloudMesh()
    const usablePercent = Math.round(coverage.summary.usable * 100)
    const phase = this.snapshotValue.stage === 'done' ? '采集完成' : '已保留部分采集'
    this.snapshotValue = {
      ...this.snapshotValue,
      pointCloudPoints: cloud.count,
      message: `${phase}，生成 ${cloud.count} 个地面点（可用覆盖 ${usablePercent}%）。`,
    }
  }

  private applyProgress(progress: ObliqueSurveyProgress): void {
    const stage: DigitalCampusStage =
      progress.state === 'running'
        ? 'running'
        : progress.state === 'paused'
          ? 'paused'
          : progress.state === 'done'
            ? 'done'
            : progress.state === 'cancelled'
              ? 'cancelled'
              : progress.state === 'failed'
              ? 'failed'
              : this.snapshotValue.stage
    this.snapshotValue = {
      ...this.snapshotValue,
      stage,
      captured: progress.captured,
      failed: progress.failed,
      message: progress.message ?? this.snapshotValue.message,
    }
    this.emit()
  }

  private emit(): void {
    const snapshot = this.snapshot
    for (const listener of this.listeners) listener(snapshot)
  }

  private readonly resize = (): void => {
    const renderer = this.renderer
    const camera = this.camera
    if (!renderer || !camera) return
    const width = this.root.clientWidth || window.innerWidth
    const height = this.root.clientHeight || window.innerHeight
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25, 1600 / width))
    renderer.setSize(width, height, false)
    camera.aspect = width / Math.max(1, height)
    camera.updateProjectionMatrix()
  }

  private readonly render = (): void => {
    if (this.destroyed || !this.drone || !this.renderer || !this.scene || !this.camera || !this.controls) return
    const now = performance.now()
    const delta = this.lastFrameAt ? Math.min((now - this.lastFrameAt) / 1000, 0.25) : 0
    this.lastFrameAt = now
    this.drone.animate(delta)
    if (this.drone.isOrbitView) this.controls.update(delta)
    this.runner?.update()
    this.drone.onBeforeRender()
    this.renderer.render(this.scene, this.camera)
    this.drone.onAfterRender()
    if (this.mountStartedAt && this.mountTimings.firstFrame === undefined) {
      this.markMount('firstFrame')
    }
    this.frameCount += 1
    this.telemetryFrames += 1
    if (now - this.telemetryAt >= 1000) {
      this.snapshotValue = { ...this.snapshotValue,
        fps: this.telemetryAt ? Math.round(this.telemetryFrames * 1000 / (now - this.telemetryAt)) : 0,
        flightAltitude: this.drone.altitude,
        waypoint: Math.max(0, this.drone.sim.missionIndex + 1),
      }
      this.telemetryAt = now
      this.telemetryFrames = 0
      this.emit()
    }
    this.animationFrame = requestAnimationFrame(this.render)
  }
}
