/**
 * 面向测区的自主航线与倾斜摄影采集。
 *
 * 该模块把已有的几何规划器、航线任务和 CaptureService 串成一个可复用的
 * 浏览器 API。测区使用 Three.js 世界坐标约定(x, z)，内部转换到摄影测量
 * 模块使用的 ENU(x, north) 坐标，因此调用方不需要自己处理 z 轴反向。
 */
import type { CapturedImage, CaptureService } from './drone-capture'
import type { MissionPanelHost } from './drone-control'
import {
  planReconCapture,
  reconPlanToWaypoints,
  type ReconPlan,
  type ReconShot,
  type ReconTarget,
} from './drone-recon-capture'
import type { MissionWaypoint } from './drone-sim'

export type SurveyPoint = [number, number]

/** Three.js 世界坐标中的矩形测区，center/size 使用 [x, z]。 */
export interface SurveyArea {
  center: SurveyPoint
  size: SurveyPoint
}

export interface ObliqueSurveyOptions {
  /** 用于 manifest.recon.group 的稳定标识。 */
  id?: string
  area: SurveyArea
  /** 被测建筑群的最高表面高度，单位米。 */
  targetHeight?: number
  /** 相对被测表面的飞行高度，单位米。 */
  altitude: number
  horizontalFovDeg?: number
  verticalFovDeg?: number
  alongTrackOverlap?: number
  sideOverlap?: number
  /** 0 表示只采集正射，正值表示正射 + 四向倾斜。 */
  tiltDeg?: number
  /** 航线飞行速度，单位 m/s。 */
  speed?: number
  /** 每张影像在航点处的悬停时间，给云台转向和取景留出时间。 */
  hoverSeconds?: number
}

export interface ObliqueSurveyPlan {
  id: string
  area: SurveyArea
  target: ReconTarget
  /** 底层摄影测量规划结果，包含每个拍摄点的真实朝向和覆盖指标。 */
  geometry: ReconPlan
  shots: ReconShot[]
  /** 可直接传给 DroneFly/CesiumDroneAdapter.setMission() 的航点。 */
  waypoints: MissionWaypoint[]
  stationCount: number
  speed: number
  hoverSeconds: number
  estimatedSeconds: number
  warnings: string[]
}

export type ObliqueSurveyRunState = 'idle' | 'running' | 'paused' | 'done' | 'cancelled' | 'failed'

export interface ObliqueSurveyProgress {
  state: ObliqueSurveyRunState
  index: number
  total: number
  captured: number
  failed: number
  heading: number | null
  message?: string
}

export interface ObliqueSurveyResult {
  state: 'done' | 'cancelled' | 'failed'
  planId: string
  sessionId: string
  total: number
  captured: number
  failed: number
  error?: string
}

export interface ObliqueSurveyFlightHost extends MissionPanelHost {
  /** 设置机体绝对航向；在测绘点悬停时用于四向倾斜取景。 */
  spinBodyTo(headingDeg: number | null): void
  getBodyHeading(): number
}

export interface ObliqueSurveyRunnerOptions {
  onFinished?: (result: ObliqueSurveyResult) => void
  headingTimeoutMs?: number
  /** Same-view retries after a null frame; 0 disables retries. */
  captureRetries?: number
}

const HEADING_TOLERANCE_DEG = 1.5

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function headingGap(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

function distance3(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function stationKey(shot: ReconShot): string {
  return `${shot.row}:${shot.col}`
}

/**
 * 规划一块矩形园区的正射 + 四向倾斜摄影航线。
 *
 * 测区坐标是 Three.js 的 [x, z]；输出航点也是 Three.js 的 x/z。规划器内部
 * 会自动换算 ENU north 轴，并为每张影像保留 recon 元数据所需的行列和方向。
 */
export function planObliqueSurvey(options: ObliqueSurveyOptions): ObliqueSurveyPlan {
  const centerX = finite(options.area.center[0], 0)
  const centerZ = finite(options.area.center[1], 0)
  const width = Math.max(1, Math.abs(finite(options.area.size[0], 1)))
  const depth = Math.max(1, Math.abs(finite(options.area.size[1], 1)))
  const targetHeight = Math.max(0, finite(options.targetHeight ?? 0, 0))
  const altitude = Math.max(2, finite(options.altitude, 40))
  const speed = clamp(finite(options.speed ?? 8, 8), 0.5, 16)
  const hoverSeconds = clamp(finite(options.hoverSeconds ?? 3, 3), 0.2, 60)
  const tiltDeg = clamp(finite(options.tiltDeg ?? 45, 45), 0, 80)

  // ReconTarget 的第二维是 ENU north，而 Three.js 场景的 north 是 -z。
  const target: ReconTarget = {
    center: [centerX, -centerZ, targetHeight / 2],
    size: [width, depth, targetHeight],
  }
  const geometry = planReconCapture({
    pattern: 'grid-tilt',
    target,
    altitude,
    tiltDeg,
    horizontalFovDeg: options.horizontalFovDeg,
    verticalFovDeg: options.verticalFovDeg,
    alongTrackOverlap: options.alongTrackOverlap,
    sideOverlap: options.sideOverlap,
  })
  const baseWaypoints = reconPlanToWaypoints(geometry)
  const waypoints = baseWaypoints.map((waypoint) => ({
    ...waypoint,
    speed,
    hoverSeconds,
    action: 'photo' as const,
  }))

  const stationCount = new Set(geometry.shots.map(stationKey)).size
  const origin: [number, number, number] = [0, 0, 0]
  let distance = 0
  let previous = origin
  for (const waypoint of waypoints) {
    const current: [number, number, number] = [waypoint.x, waypoint.z, waypoint.altitude]
    distance += distance3(previous, current)
    previous = current
  }

  return {
    id: options.id?.trim() || 'oblique-survey',
    area: { center: [centerX, centerZ], size: [width, depth] },
    target,
    geometry,
    shots: geometry.shots,
    waypoints,
    stationCount,
    speed,
    hoverSeconds,
    estimatedSeconds: Math.ceil(distance / speed + waypoints.length * hoverSeconds),
    warnings: [...geometry.warnings],
  }
}

/**
 * 执行已经规划好的测绘航线。
 *
 * 调用方需要在自己的渲染循环中于 `flight.animate()` 之后调用 `update()`，
 * 在 `renderer.render()` 之前调用。执行器会等待每个航点的悬停阶段，转到
 * 该倾斜照片要求的航向，再通过 CaptureService 采集带位姿的影像。
 */
export class ObliqueSurveyRunner {
  private readonly flight: ObliqueSurveyFlightHost
  private readonly capture: CaptureService
  private readonly options: ObliqueSurveyRunnerOptions
  private readonly listeners = new Set<(progress: ObliqueSurveyProgress) => void>()
  private plan: ObliqueSurveyPlan | null = null
  private sessionId: string | null = null
  private state: ObliqueSurveyRunState = 'idle'
  private readonly completed = new Set<number>()
  private pendingIndex = -1
  private captureBusy = false
  private readonly captureAttempts = new Map<number, number>()
  private missionSeen = false
  private captured = 0
  private failed = 0
  private token = 0
  private releaseWaypoint: (() => void) | null = null
  private unsubscribeArrival: (() => void) | null = null
  private pendingSince = 0
  private progressState: ObliqueSurveyProgress = {
    state: 'idle',
    index: 0,
    total: 0,
    captured: 0,
    failed: 0,
    heading: null,
  }

  constructor(
    flight: ObliqueSurveyFlightHost,
    capture: CaptureService,
    options: ObliqueSurveyRunnerOptions = {},
  ) {
    this.flight = flight
    this.capture = capture
    this.options = options
  }

  get running(): boolean {
    return this.state === 'running' || this.state === 'paused'
  }

  get progress(): ObliqueSurveyProgress {
    return { ...this.progressState }
  }

  /** True while a rendered frame is being encoded into a captured image. */
  get busy(): boolean {
    return this.captureBusy
  }

  subscribe(listener: (progress: ObliqueSurveyProgress) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 装载规划结果，同时把航点下发给飞控。 */
  load(plan: ObliqueSurveyPlan): boolean {
    if (this.running || this.captureBusy) return false
    // 仿真到点的 photo 动作只计数；成片由 CaptureService 负责，避免重复计数。
    if (!this.flight.setMission(plan.waypoints.map((point) => ({ ...point, action: 'none' })))) return false
    this.plan = plan
    this.sessionId = null
    this.completed.clear()
    this.pendingIndex = -1
    this.captureBusy = false
    this.captureAttempts.clear()
    this.missionSeen = false
    this.captured = 0
    this.failed = 0
    this.state = 'idle'
    this.flight.setMissionConfig({
      autoSpeed: plan.speed,
      headingMode: 'auto',
      pathMode: 'straight',
      finishAction: 'hover',
      loop: false,
    })
    this.flight.setMissionWaypointsVisible(true)
    this.flight.setMissionPathVisible(true)
    this.setProgress({
      state: 'idle',
      index: 0,
      total: plan.shots.length,
      captured: 0,
      failed: 0,
      heading: null,
      message: `已生成 ${plan.stationCount} 个测绘站、${plan.shots.length} 张影像的航线`,
    })
    return true
  }

  start(sessionId: string): boolean {
    const plan = this.plan
    const session = this.capture.getSession(sessionId)
    if (!plan || !session || this.running || this.captureBusy || session.status === 'finished' || session.status === 'failed') {
      return false
    }
    if (this.flight.sim.external) return false
    this.unsubscribeArrival = this.flight.sim.subscribeMissionArrival((index) => this.arrive(index))
    if (!this.flight.startMission()) {
      this.unsubscribeArrival()
      this.unsubscribeArrival = null
      return false
    }
    this.sessionId = sessionId
    this.state = 'running'
    this.completed.clear()
    this.pendingIndex = -1
    this.captureBusy = false
    this.captureAttempts.clear()
    this.missionSeen = true
    this.captured = 0
    this.failed = 0
    this.token += 1
    this.setProgress({
      state: 'running',
      index: 0,
      total: plan.shots.length,
      captured: 0,
      failed: 0,
      heading: null,
      message: '已下发自主航线，等待起飞并进入首个测绘点',
    })
    return true
  }

  pause(reason = '用户暂停'): boolean {
    if (this.state !== 'running' || !this.flight.pauseMission(reason)) return false
    this.state = 'paused'
    this.flight.spinBodyTo(null)
    this.setProgress({ ...this.progressState, state: 'paused', message: reason })
    return true
  }

  resume(): boolean {
    if (this.state !== 'paused' || !this.flight.resumeMission()) return false
    this.state = 'running'
    this.pendingSince = Date.now()
    this.setProgress({ ...this.progressState, state: 'running', message: '继续执行测绘航线' })
    return true
  }

  cancel(reason = '用户取消'): boolean {
    if (!this.running) return false
    this.token += 1
    this.flight.spinBodyTo(null)
    this.flight.stopMission(reason)
    this.release()
    this.state = 'cancelled'
    this.setProgress({ ...this.progressState, state: 'cancelled', message: reason })
    if (this.plan && this.sessionId) this.options.onFinished?.({
      state: 'cancelled', planId: this.plan.id, sessionId: this.sessionId,
      total: this.plan.shots.length, captured: this.captured, failed: this.failed,
    })
    return true
  }

  /** 在渲染循环中调用，负责识别悬停航点并触发带位姿的影像采集。 */
  update(): void {
    if (!this.running || !this.plan || !this.sessionId) return
    const sim = this.flight.sim
    if (sim.missionStatus === 'running') this.missionSeen = true

    if (this.missionSeen && sim.missionStatus === 'idle' && !sim.missionPendingStart && !this.captureBusy) {
      if (this.captured + this.failed !== this.plan.shots.length) {
        this.fail('航线在完成采集前停止，已保留采集影像')
      } else {
        this.finish(this.failed > 0 ? '航线完成，但部分影像采集失败' : '航线与倾斜摄影采集完成')
      }
      return
    }
    if (sim.missionStatus === 'paused') {
      if (this.state !== 'paused') {
        this.state = 'paused'
        this.flight.spinBodyTo(null)
        this.setProgress({ ...this.progressState, state: 'paused', message: '飞控暂停了航线' })
      }
      return
    }
    if (this.state === 'paused') {
      this.state = 'running'
      this.pendingSince = Date.now()
      this.setProgress({ ...this.progressState, state: 'running', message: '继续执行测绘航线' })
    }

    if (this.pendingIndex >= 0) {
      const shot = this.plan.shots[this.pendingIndex]
      if (!shot || this.captureBusy) return
      if (sim.missionStage !== 'hover' || sim.missionIndex !== this.pendingIndex) return
      this.flight.spinBodyTo(shot.heading)
      const heading = this.flight.getBodyHeading()
      if (headingGap(heading, shot.heading) > HEADING_TOLERANCE_DEG) {
        if (Date.now() - this.pendingSince > (this.options.headingTimeoutMs ?? 15000)) {
          this.fail('机体转向超时，已暂停采集')
        }
        return
      }
      this.captureBusy = true
      void this.captureShot(this.pendingIndex, shot, this.token)
      return
    }

  }

  private arrive(index: number): void {
    if (!this.running || !this.plan || this.completed.has(index)) return
    const shot = this.plan.shots[index]
    if (!shot) return this.fail('航线索引超出测绘规划范围')
    this.releaseWaypoint?.()
    this.releaseWaypoint = this.flight.sim.holdMissionWaypoint(index)
    this.pendingIndex = index
    this.pendingSince = Date.now()
    this.flight.spinBodyTo(shot.heading)
    this.setProgress({
      state: this.state, index: index + 1, total: this.plan.shots.length,
      captured: this.captured, failed: this.failed, heading: this.flight.getBodyHeading(),
      message: `航点 ${index + 1}/${this.plan.shots.length}：机体转向 ${shot.heading.toFixed(0)}°`,
    })
  }

  private async captureShot(index: number, shot: ReconShot, token: number): Promise<void> {
    const sessionId = this.sessionId
    const plan = this.plan
    if (!sessionId || !plan) return
    let image: CapturedImage | null
    try {
      image = await this.capture.captureVirtualImage(sessionId, {
      view: { pitch: shot.pitch },
      recon: {
        group: plan.id,
        pattern: 'grid-tilt',
        index: shot.index,
        total: plan.shots.length,
        ring: shot.ring,
        row: shot.row,
        col: shot.col,
      },
      })
    } catch (error) {
      this.captureBusy = false
      if (token === this.token) this.fail(error instanceof Error ? error.message : '影像采集异常')
      return
    }
    const stale = token !== this.token
    this.captureBusy = false
    if (stale) return
    const attempt = (this.captureAttempts.get(index) ?? 0) + 1
    if (!image && attempt <= (this.options.captureRetries ?? 2)) {
      this.captureAttempts.set(index, attempt)
      this.setProgress({
        state: this.state,
        index: index + 1,
        total: plan.shots.length,
        captured: this.captured,
        failed: this.failed,
        heading: this.flight.getBodyHeading(),
        message: `航点 ${index + 1} 取景超时，第 ${attempt + 1} 次尝试`,
      })
      return
    }
    this.pendingIndex = -1
    this.completed.add(index)
    this.captureAttempts.delete(index)
    this.releaseWaypoint?.()
    this.releaseWaypoint = null
    this.flight.spinBodyTo(null)
    if (image) this.captured += 1
    else this.failed += 1
    this.setProgress({
      state: this.state,
      index: index + 1,
      total: plan.shots.length,
      captured: this.captured,
      failed: this.failed,
      heading: this.flight.getBodyHeading(),
      message: image ? `已采集 ${this.captured}/${plan.shots.length} 张影像` : `航点 ${index + 1} 采集失败，继续执行航线`,
    })
  }

  private finish(message: string): void {
    if (this.state !== 'running' || !this.plan || !this.sessionId) return
    this.flight.spinBodyTo(null)
    this.release()
    this.state = this.failed > 0 ? 'failed' : 'done'
    const result: ObliqueSurveyResult = {
      state: this.state,
      planId: this.plan.id,
      sessionId: this.sessionId,
      total: this.plan.shots.length,
      captured: this.captured,
      failed: this.failed,
      error: this.failed > 0 ? message : undefined,
    }
    this.setProgress({
      state: this.state,
      index: this.plan.shots.length,
      total: this.plan.shots.length,
      captured: this.captured,
      failed: this.failed,
      heading: this.flight.getBodyHeading(),
      message,
    })
    this.options.onFinished?.(result)
  }

  private fail(message: string): void {
    this.token += 1
    this.flight.spinBodyTo(null)
    this.flight.stopMission(message)
    this.release()
    this.state = 'failed'
    this.setProgress({ ...this.progressState, state: 'failed', message })
    if (this.plan && this.sessionId) {
      this.options.onFinished?.({
        state: 'failed',
        planId: this.plan.id,
        sessionId: this.sessionId,
        total: this.plan.shots.length,
        captured: this.captured,
        failed: this.failed,
        error: message,
      })
    }
  }

  private setProgress(progress: ObliqueSurveyProgress): void {
    this.progressState = { ...progress }
    for (const listener of this.listeners) listener({ ...this.progressState })
  }

  private release(): void {
    this.releaseWaypoint?.()
    this.releaseWaypoint = null
    this.unsubscribeArrival?.()
    this.unsubscribeArrival = null
    this.pendingIndex = -1
  }
}
