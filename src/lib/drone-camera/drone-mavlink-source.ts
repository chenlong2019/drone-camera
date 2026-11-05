/**
 * MAVLink 接入层 —— 把真飞控(PX4 / ArduPilot SITL 或真机)的遥测喂给 `DroneSim`,
 * 并把面板上的操作翻译成 MAVLink 指令。
 *
 * 分层很硬:
 *
 *   MavlinkParser(纯字节 ↔ 结构体)
 *        ↓
 *   MavlinkSource(本文件:连接 / 归一化 / 指令 / 坐标换算)
 *        ↓
 *   DroneSim.applyExternalState()  ← 面板、鹰眼图、采集服务全部读它
 *
 * 这一层只做「翻译」,不碰渲染 —— 所以同一个 source 既能驱动 three 后端,也能驱动
 * Cesium 后端,切换后端不需要改一行接入代码。
 *
 * 坐标换算的锚点很关键:`GLOBAL_POSITION_INT` 给的是全球经纬高,而 `DroneSim` 要的是
 * 「相对返航点的本地米」。所以必须有一个 home 锚点(优先用飞控上报的 `HOME_POSITION`,
 * 没有就用第一帧定位),然后用 WGS84 → ECEF → ENU 换算。这条链路复用 `drone-photogrammetry`
 * 里已经验证过的纯函数,不另写一套。
 */
import {
  createEcefEnuFrame,
  ecefToEnu,
  ecefToGeodetic,
  enuToEcef,
  geodeticToEcef,
  type EcefEnuFrame,
  type GeodeticCoordinate,
} from './drone-photogrammetry'
import { MavlinkParser, encodeMessage, type DecodedMessage, type MavlinkStats, type MavValue } from './drone-mavlink'
import { MAV_CMD, MAV_FRAME, MAVLINK_MSG_ID } from './drone-mavlink-defs'
import type {
  DroneSim,
  ExternalCommand,
  ExternalFlightSource,
  ExternalFlightState,
  FlightPhase,
  FlightMode,
  StickState,
} from './drone-sim'
import { NEUTRAL_STICK } from './drone-sim'

const RAD_TO_DEG = 180 / Math.PI

/** MAV_AUTOPILOT 枚举(只区分本库有专门模式表的两种) */
const AUTOPILOT_PX4 = 12
const AUTOPILOT_ARDUPILOT = 3

/** base_mode 里的解锁位 */
const MODE_FLAG_SAFETY_ARMED = 0x80

/** PX4 主模式名 */
const PX4_MAIN_MODE_LABELS: Record<number, string> = {
  1: 'MANUAL',
  2: 'ALTCTL',
  3: 'POSCTL',
  4: 'AUTO',
  5: 'ACRO',
  6: 'OFFBOARD',
  7: 'STABILIZED',
  8: 'RATTITUDE',
}

/** PX4 AUTO 子模式名 */
const PX4_SUB_MODE_LABELS: Record<number, string> = {
  1: 'READY',
  2: 'TAKEOFF',
  3: 'LOITER',
  4: 'MISSION',
  5: 'RTL',
  6: 'LAND',
  7: 'RTGS',
  8: 'FOLLOW_TARGET',
  9: 'PRECLAND',
}

/** ArduPilot(Copter)飞行模式名 */
const ARDUPILOT_MODE_LABELS: Record<number, string> = {
  0: 'STABILIZE',
  1: 'ACRO',
  2: 'ALT_HOLD',
  3: 'AUTO',
  4: 'GUIDED',
  5: 'LOITER',
  6: 'RTL',
  7: 'CIRCLE',
  9: 'LAND',
  11: 'DRIFT',
  13: 'SPORT',
  14: 'FLIP',
  15: 'AUTOTUNE',
  16: 'POSHOLD',
  17: 'BRAKE',
  18: 'THROW',
  19: 'AVOID_ADSB',
  20: 'GUIDED_NOGPS',
  21: 'SMART_RTL',
  22: 'FLOWHOLD',
  23: 'FOLLOW',
  24: 'ZIGZAG',
}

/** 链路状态:给 UI 显示"连上了没、延迟多少、丢了多少帧" */
export interface MavlinkLinkStatus {
  connected: boolean
  /** 最近一次心跳距今(毫秒);Infinity 表示从未收到 */
  heartbeatAgeMs: number
  /** 已解出的帧数 */
  frames: number
  /** 校验失败帧数(持续增长说明 CRC_EXTRA 或链路有问题) */
  crcErrors: number
  /** 飞控机型与自驾仪名称(如 "PX4" / "ArduPilot") */
  autopilot: string
  /** 当前模式原文(如 "POSCTL" / "AUTO.MISSION") */
  mode: string
  armed: boolean
}

export interface MavlinkSourceOptions {
  /** WebSocket 地址,如 ws://127.0.0.1:8118(由 mavlink/bridge.mjs 提供 UDP→WS) */
  url: string
  /**
   * 返航点地理坐标。缺省时用飞控上报的 HOME_POSITION,再缺就用第一帧定位当锚点。
   * 只有 SITL 没上报 home、又要严格对齐某一处地标时才需要手动指定。
   */
  home?: GeodeticCoordinate
  /** 本端 system id(缺省 255 = 地面站) */
  sysId?: number
  /** 本端 component id(缺省 190 = MAV_COMP_ID_MISSIONPLANNER) */
  compId?: number
  /** 目标飞控 system id(缺省 1) */
  targetSystem?: number
  /** 目标飞控 component id(缺省 1 = MAV_COMP_ID_AUTOPILOT1) */
  targetComponent?: number
  /** 心跳超时(毫秒),超过即判定掉线;缺省 3000 */
  timeoutMs?: number
  /** "起飞"按钮的目标高度(米),缺省 12 */
  takeoffAltitude?: number
  /** 断线是否自动重连,缺省 true */
  autoReconnect?: boolean
  /** CRC 校验模式,缺省 'lenient'(见 drone-mavlink 说明) */
  crc?: 'strict' | 'lenient'
  /** 事件回调(转成面板日志) */
  onEvent?: (level: 'info' | 'warn' | 'error' | 'success', text: string) => void
  /** 链路状态变化回调(约 1 秒一次) */
  onStatus?: (status: MavlinkLinkStatus) => void
}

/** 面板"起飞"按钮缺省的目标高度(米)。真机的起飞高度必须显式给定,不会自己猜 */
const DEFAULT_TAKEOFF_ALTITUDE = 12

/** 等解锁 ACK 的上限(毫秒)。超过就认为自检没过,取消起飞而不是干等 */
const TAKEOFF_ACK_TIMEOUT_MS = 6000

/**
 * setpoint 流的发送间隔(毫秒)。
 *
 * PX4 的 OFFBOARD 要求持续收到 setpoint:超过 `COM_OF_LOSS_T`(默认 1.0 s)没有新指令
 * 就判定 offboard lost,按 `COM_OBL_RC_ACT` 退回位置模式。100 ms = 10 Hz,留了 10 倍余量。
 */
const SETPOINT_INTERVAL_MS = 100

/** 判定"已到达目标点"的半径(米):到这个距离就交回位置模式悬停,不再占着 OFFBOARD */
const ARRIVE_RADIUS_M = 0.8

/**
 * 摇杆流(MANUAL_CONTROL)的发送间隔(毫秒)。
 *
 * 20 Hz:POSCTL 的速度指令是**连续量**,发一次就完事等于没发。同时 PX4 的
 * `manual_control` 对输入有超时判定,停发会被当成遥控丢失 → 触发失效保护。
 */
const MANUAL_CONTROL_INTERVAL_MS = 50

/** 摇杆死区:小于此行程视为中位(键盘是 ±1 的开关量,面板摇杆会抖) */
const STICK_DEADZONE = 0.02

/** 打杆接管时切 POSCTL 的最小重试间隔(毫秒):COMMAND_LONG 不能每帧刷 */
const TAKEOVER_RETRY_MS = 1500

/**
 * 这些模式已经吃 MANUAL_CONTROL,不用再切模式(PX4 + ArduPilot 的两种叫法都收进来)。
 * 其余模式(AUTO.\* / OFFBOARD / MISSION / RTL …)下打杆是**被飞控静默忽略**的。
 */
const MANUAL_MODE_LABELS = new Set([
  'POSCTL',
  'ALTCTL',
  'STABILIZED',
  'MANUAL',
  'ACRO',
  'POSHOLD',
  'ALT_HOLD',
  'STABILIZE',
])

/** 摇杆值清洗:NaN/越界一律夹回 [-1, 1](键盘与面板两路都可能给出脏值) */
function sanitizeStick(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-1, Math.min(1, value))
}

/**
 * MAVLink 数据源 —— 一个实例对一条链路。
 *
 * 用法(两种后端通用,因为接入点在内核而不是渲染器):
 *
 * ```ts
 * const source = new MavlinkSource({ url: 'ws://127.0.0.1:8118' })
 * source.attach(drone.sim)   // 接管:此后画面上的一切都由真飞控驱动
 * await source.connect()
 * ```
 */
export class MavlinkSource implements ExternalFlightSource {
  private readonly options: Required<
    Pick<MavlinkSourceOptions, 'sysId' | 'compId' | 'targetSystem' | 'targetComponent' | 'timeoutMs' | 'autoReconnect' | 'crc'>
  > &
    MavlinkSourceOptions

  private readonly parser: MavlinkParser
  private socket: WebSocket | null = null
  private sim: DroneSim | null = null

  /** 最新一帧遥测(各消息各存一份,读到就更新) */
  private telemetry = {
    heartbeatAt: 0,
    heartbeat: null as DecodedMessage | null,
    attitude: null as DecodedMessage | null,
    globalPosition: null as DecodedMessage | null,
    localPosition: null as DecodedMessage | null,
    gpsRaw: null as DecodedMessage | null,
    sysStatus: null as DecodedMessage | null,
    battery: null as DecodedMessage | null,
    vfrHud: null as DecodedMessage | null,
    mount: null as DecodedMessage | null,
    gimbal: null as DecodedMessage | null,
    home: null as DecodedMessage | null,
    missionCurrent: null as DecodedMessage | null,
  }

  /** 本地坐标锚点(懒建立:拿到第一份可用定位才建) */
  private frame: EcefEnuFrame | null = null
  /** 有未消费的新数据时才重建 ExternalFlightState,避免每帧做一遍浮点换算 */
  private dirty = false
  private lastState: ExternalFlightState | null = null
  private lastReadAt = 0

  /** 航线上传状态机:等飞控逐个索要航点 */
  private pendingMission: {
    items: Array<{ latitude: number; longitude: number; altitude: number }>
    onResult?: (ok: boolean, detail: string) => void
    /** 上传成功后是否立刻切到 AUTO.MISSION(真机必须先切模式才会执行) */
    startAfterUpload: boolean
  } | null = null

  /** 起飞在等解锁 ACK(真机 arm 是异步的,提前发 NAV_TAKEOFF 会被拒) */
  private pendingTakeoff: { altitude: number; deadline: number } | null = null

  /** OFFBOARD 的 setpoint 流:目标是"持续发",不是"发一次" */
  private setpointTimer: ReturnType<typeof setInterval> | null = null
  private setpointTarget: { x: number; y: number; z: number; heading?: number } | null = null

  /** 用户摇杆的最新行程;`stickStreaming` 期间按 20 Hz 重发给飞控 */
  private stickState: StickState = { ...NEUTRAL_STICK }
  private manualTimer: ReturnType<typeof setInterval> | null = null
  /** 打杆接管的时间戳与告知标记(切 POSCTL 失败时允许重试,但日志只写一次) */
  private takeoverAt = 0
  private takeoverNotified = false
  private takeoverAttempts = 0
  /** 「起飞完成后交还手动控制」待办:见 checkPostTakeover */
  private takeoverAfterTakeoff = false

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private statusTimer: ReturnType<typeof setInterval> | null = null
  /** 地面站心跳:1 Hz。不给飞控发心跳,它会一直报 "Connection to ground station lost" */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  /** 主动关闭标记:区分"用户关掉"与"链路断了" */
  private closedByUser = false

  constructor(options: MavlinkSourceOptions) {
    this.options = {
      sysId: 255,
      compId: 190,
      targetSystem: 1,
      targetComponent: 1,
      timeoutMs: 3000,
      autoReconnect: true,
      crc: 'lenient',
      ...options,
    }
    this.parser = new MavlinkParser({
      crc: this.options.crc,
      onMessage: (message) => this.ingest(message),
      onCrcError: () => {
        // 只在第一次出现时提示,避免刷屏
        if (this.parser.stats.crcErrors === 1) {
          this.emit('warn', 'MAVLink 校验失败:CRC 或 CRC_EXTRA 不匹配(已按宽容模式继续解析)')
        }
      },
    })
  }

  // ─────────────────────────── 连接管理 ───────────────────────────

  /** 接管一个仿真内核(把遥测写进去,并让面板指令改走 MAVLink) */
  attach(sim: DroneSim): void {
    this.sim?.detachExternalSource()
    this.sim = sim
    sim.attachExternalSource(this)
  }

  /** 解除接管并断开连接 */
  async close(): Promise<void> {
    this.closedByUser = true
    this.stopTimers()
    this.stopSetpointStream()
    this.stopManualStream()
    this.setpointTarget = null
    this.pendingTakeoff = null
    this.sim?.detachExternalSource()
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onclose = null
      socket.onmessage = null
      socket.onerror = null
      try {
        socket.close()
      } catch {
        // 关闭失败不影响后续:对象已经丢弃,GC 会回收底层连接
      }
    }
  }

  /** 建立连接(已连上则直接返回) */
  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState <= 1) return
    this.closedByUser = false
    this.parser.reset()
    const socket = new WebSocket(this.options.url)
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    socket.onmessage = (event: MessageEvent) => {
      const data: unknown = event.data
      if (data instanceof ArrayBuffer) {
        this.parser.push(new Uint8Array(data))
        return
      }
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        void data.arrayBuffer().then((buffer) => this.parser.push(new Uint8Array(buffer)))
        return
      }
      // 文本帧留给网桥送诊断信息(JSON),本层只打日志不解析
      if (typeof data === 'string') this.emit('info', data)
    }
    // `settle` 保证 connect() 的 Promise 只会结算一次,并且**一定会结算**。
    // 早期实现靠"5 秒后检查 readyState 是否还是 CONNECTING"来判断超时,
    // 但端口没人监听时 readyState 会直接变成 CLOSED(3) —— Promise 永远挂着,
    // 上层"连不上就回退内置飞控"的逻辑也就永远不会执行。这是一个真实踩过的坑。
    let opened = false
    let settle: ((error?: Error) => void) | null = null
    const finish = (error?: Error): void => {
      const callback = settle
      settle = null
      callback?.(error)
    }

    socket.onerror = () => {
      this.emit('error', `MAVLink 网桥连接失败:${this.options.url}`)
      // 运行期出错时链路对象还在,由 onclose 统一收尾;首连失败则立刻让 connect() 失败
      if (!opened) finish(new Error(`无法连接 ${this.options.url}`))
    }
    socket.onclose = () => {
      if (opened) this.emit('warn', 'MAVLink 链路已断开')
      this.emitStatus()
      if (!opened) finish(new Error(`连接已被关闭:${this.options.url}`))
      if (!this.closedByUser && this.options.autoReconnect) {
        this.reconnectTimer = setTimeout(() => void this.connect(), 2000)
      }
    }
    await new Promise<void>((resolve, reject) => {
      settle = (error) => (error ? reject(error) : resolve())
      socket.onopen = () => {
        opened = true
        this.emit('success', `已连接 MAVLink 网桥 ${this.options.url}`)
        this.startStatusTimer()
        finish()
      }
      setTimeout(() => finish(new Error(`连接超时:${this.options.url}`)), 5000)
    })
  }

  private stopTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.statusTimer) clearInterval(this.statusTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.reconnectTimer = null
    this.statusTimer = null
    this.heartbeatTimer = null
  }

  private startStatusTimer(): void {
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.statusTimer = setInterval(() => this.emitStatus(), 1000)
    // MAV_TYPE_GCS + MAV_AUTOPILOT_INVALID:告诉飞控"我在线,但我不是飞控"
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      this.send(
        this.encode('HEARTBEAT', {
          type: 6,
          autopilot: 8,
          base_mode: 0,
          custom_mode: 0,
          system_status: 4,
          mavlink_version: 3,
        }),
      )
    }, 1000)
  }

  // ─────────────────────────── ExternalFlightSource ───────────────────────────

  /** 链路是否在线(心跳还没超时) */
  online(): boolean {
    return this.socket?.readyState === 1 && this.heartbeatAgeMs() < this.options.timeoutMs
  }

  /**
   * 协议层统计(帧数 / CRC 失败数 / 未知消息数)。
   *
   * `crcErrors` 持续增长基本只有两种可能:链路真在丢包,或者 CRC_EXTRA 抄错了。
   * 把它暴露出来是为了让第二种情况**看得见**,而不是表现为"数据莫名其妙不更新"。
   */
  parserStats(): Readonly<MavlinkStats> {
    return { ...this.parser.stats }
  }

  /** 取最新状态;没有新数据时返回 null(内核会保持上一帧的值) */
  read(): ExternalFlightState | null {
    if (!this.dirty) return this.lastState
    this.dirty = false
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const delta = this.lastReadAt > 0 ? (now - this.lastReadAt) / 1000 : 0
    this.lastReadAt = now
    const state = this.buildState(delta)
    this.lastState = state
    return state
  }

  /**
   * 摇杆 → MANUAL_CONTROL(真飞控的"手动接管")。
   *
   * 三个必须知道的点:
   *
   * 1. **AUTO.\* / OFFBOARD 下打杆没有任何反应** —— PX4 只把 MANUAL_CONTROL 喂给
   *    手动挡。所以第一次有效打杆要先把模式切到 POSCTL,这就是真机地面站的接管语义。
   * 2. **必须连续发**(20 Hz)。POSCTL 的速度指令是连续量,而且 `manual_control`
   *    有输入超时,停发会被判成遥控丢失 → 失效保护。
   * 3. **轴映射按 PX4 的实现**(mavlink_receiver.cpp,不是 MAVLink 文档的老写法):
   *    x→pitch、y→roll、r→yaw 都是 ÷1000;z 是 `(z/1000)*2-1`,
   *    也就是 **z ∈ [0,1000] 且 500 为中位**(油门兼容旧定义)。
   */
  stick(stick: Readonly<StickState>): void {
    this.stickState = { ...stick }
    if (!this.online()) return
    const active =
      Math.max(
        Math.abs(stick.pitch),
        Math.abs(stick.roll),
        Math.abs(stick.throttle),
        Math.abs(stick.yaw),
      ) > STICK_DEADZONE
    // 从未打杆过的中位值不发:链路一接上就抢遥控权没有意义
    if (!active && !this.manualTimer) return
    if (active) this.requestManualTakeover()
    this.startManualStream()
    this.sendManualControl()
  }

  /** 打杆接管:把手动挡切过来,并掐掉会跟摇杆打架的 OFFBOARD setpoint 流 */
  private requestManualTakeover(): void {
    if (!this.isArmed()) {
      // 地面未解锁:MANUAL_CONTROL 会被飞控直接丢弃,提示一次就够,别刷屏
      if (!this.takeoverNotified) {
        this.takeoverNotified = true
        this.emit('warn', '摇杆需要先解锁起飞(面板「起飞」),未解锁时飞控不接收手动杆量')
      }
      return
    }
    const label = this.modeText()
    if (MANUAL_MODE_LABELS.has(label)) {
      this.takeoverNotified = false
      this.takeoverAttempts = 0
      return
    }
    // 起降过程中 PX4 一律拒收切模式(打了也是白打,重发还可能干扰 TAKEOFF 流程)。
    // 交给 checkPostTakeover:等它转成 LOITER 再接管。
    if (label === 'AUTO.TAKEOFF' || label === 'AUTO.LAND') {
      if (!this.takeoverNotified) {
        this.takeoverNotified = true
        this.emit('info', `飞控正在${label === 'AUTO.TAKEOFF' ? '起飞' : '降落'},完成后摇杆自动接管`)
      }
      return
    }
    const now = Date.now()
    if (now - this.takeoverAt < TAKEOVER_RETRY_MS) return
    this.takeoverAt = now
    // 位置指令的 setpoint 流每 100 ms 会把飞机拉回旧目标,不清掉就和摇杆对着干
    this.stopSetpointStream()
    this.setpointTarget = null
    this.sendCustomMode(this.manualModeNumber())
    if (!this.takeoverNotified) {
      this.takeoverNotified = true
      this.emit('info', `打杆接管:切到 POSCTL 手动控制(当前 ${label}),松开即刹停悬停`)
    }
    this.takeoverAttempts += 1
    // ⚠️ 不能设重试上限:PX4 在 AUTO.TAKEOFF / AUTO.LAND 期间会拒绝切模式,
    // 只有等它转成 LOITER 才受理。1.5 s 一条 COMMAND_LONG 的代价可以忽略,
    // 停了反而会让用户以为"打杆又没反应"。
    if (this.takeoverAttempts === 8) {
      this.emit('warn', '飞控还在执行起降动作(TAKEOFF/LAND),等它转入悬停后摇杆会自动生效')
    }
  }

  /**
   * 起飞完成后交还手动控制(每次心跳判一次)。
   *
   * PX4 在 AUTO.TAKEOFF 期间**拒绝**切模式,所以"打杆接管"在整个爬升段都不会生效 ——
   * 用户看到的就是"起飞后打杆没反应"。等它自己转成 AUTO.LOITER 的那一刻切 POSCTL,
   * 摇杆立刻可用。真机地面站也是这个语义:自动起飞完成 → 手动接管。
   */
  private checkPostTakeover(): void {
    if (!this.takeoverAfterTakeoff) return
    if (!this.isArmed()) return
    if (this.modeText() !== 'AUTO.LOITER') return
    this.takeoverAfterTakeoff = false
    this.sendCustomMode(this.manualModeNumber())
    this.emit('success', '起飞完成,已交给摇杆(POSCTL),可直接打杆飞行')
  }

  private startManualStream(): void {    if (this.manualTimer) return
    this.manualTimer = setInterval(() => {
      if (!this.online()) {
        this.stopManualStream()
        return
      }
      this.sendManualControl()
    }, MANUAL_CONTROL_INTERVAL_MS)
  }

  private stopManualStream(): void {
    if (this.manualTimer) clearInterval(this.manualTimer)
    this.manualTimer = null
  }

  private sendManualControl(): void {
    const stick = this.stickState
    this.send(
      this.encode('MANUAL_CONTROL', {
        // target 填飞控 sysid;填 0 表示"广播给链路上任何一架",多机时会误控
        target: this.options.targetSystem,
        x: Math.round(sanitizeStick(stick.pitch) * 1000),
        y: Math.round(sanitizeStick(stick.roll) * 1000),
        // z:0~1000,500 = 中位(PX4 内部再换算回 -1~1)
        z: Math.round((sanitizeStick(stick.throttle) + 1) * 500),
        r: Math.round(sanitizeStick(stick.yaw) * 1000),
        buttons: 0,
      }),
    )
  }

  /** 手动挡模式号:PX4 是主模式 POSCTL(3),ArduPilot 是 POSHOLD */
  private manualModeNumber(): number {
    return this.autopilotId() === AUTOPILOT_PX4 ? 3 << 16 : 16
  }

  /** 面板指令 → MAVLink */
  command(command: ExternalCommand): void {
    const { targetSystem: ts, targetComponent: tc } = this.options
    switch (command.type) {
      case 'arm':
        this.sendCommand(MAV_CMD.COMPONENT_ARM_DISARM, [command.armed ? 1 : 0])
        break
      case 'takeoff': {
        const altitude = this.options.takeoffAltitude ?? DEFAULT_TAKEOFF_ALTITUDE
        // 起飞完成后自动交还手动控制,否则用户在自动爬升段打杆会长时间"没反应"
        this.takeoverAfterTakeoff = true
        if (this.isArmed()) {
          this.sendTakeoff(altitude)
          break
        }
        // 解锁是异步的(preflight check),ACK 没回来就发 NAV_TAKEOFF 会被 COMMAND_DENIED。
        // 所以排队等 ACK,而不是两帧连发 —— 这一点在真 SITL 上是必现的。
        this.pendingTakeoff = { altitude, deadline: Date.now() + TAKEOFF_ACK_TIMEOUT_MS }
        this.sendCommand(MAV_CMD.COMPONENT_ARM_DISARM, [1])
        this.emit('info', '已发送解锁,等待飞控自检通过后起飞')
        break
      }
      case 'land':
        this.sendCommand(MAV_CMD.NAV_LAND, [0, 0, 0, Number.NaN, 0, 0, 0])
        break
      case 'rth':
        this.sendCommand(MAV_CMD.NAV_RETURN_TO_LAUNCH, [])
        break
      case 'mode':
        this.sendCustomMode(this.modeNumberFor(command.mode))
        break
      case 'goto':
        this.gotoLocal(command.x, command.y, command.z, command.heading)
        break
      case 'missionStart':
        this.uploadMission(this.sim?.mission ?? [], undefined, true)
        break
      case 'missionPause':
        this.sendCommand(193 /* MAV_CMD_DO_PAUSE_CONTINUE */, [0])
        break
      case 'missionResume':
        this.sendCommand(193 /* MAV_CMD_DO_PAUSE_CONTINUE */, [1])
        break
      case 'missionStop':
        // 停止任务 = 留在原地悬停,与内置语义一致
        this.sendCustomMode(this.loiterModeNumber())
        break
      default:
        break
    }
    void ts
    void tc
  }

  // ─────────────────────────── 遥测摄入 ───────────────────────────

  private ingest(message: DecodedMessage): void {
    const t = this.telemetry
    switch (message.name) {
      case 'HEARTBEAT':
        t.heartbeat = message
        t.heartbeatAt = Date.now()
        this.dirty = true
        this.checkPostTakeover()
        break
      case 'ATTITUDE':
        t.attitude = message
        this.dirty = true
        break
      case 'GLOBAL_POSITION_INT':
        t.globalPosition = message
        this.dirty = true
        break
      case 'LOCAL_POSITION_NED':
        t.localPosition = message
        this.dirty = true
        break
      case 'GPS_RAW_INT':
        t.gpsRaw = message
        this.dirty = true
        break
      case 'SYS_STATUS':
        t.sysStatus = message
        this.dirty = true
        break
      case 'BATTERY_STATUS':
        t.battery = message
        this.dirty = true
        break
      case 'VFR_HUD':
        t.vfrHud = message
        this.dirty = true
        break
      case 'MOUNT_ORIENTATION':
        t.mount = message
        this.dirty = true
        break
      case 'GIMBAL_DEVICE_ATTITUDE_STATUS':
        t.gimbal = message
        this.dirty = true
        break
      case 'HOME_POSITION':
        t.home = message
        // 收到 home 就重建锚点:此前用第一帧定位当的临时锚点会被它替换
        this.rebuildFrame(true)
        this.dirty = true
        break
      case 'MISSION_CURRENT':
        t.missionCurrent = message
        break
      case 'MISSION_REQUEST_INT':
        this.onMissionRequest(message, true)
        break
      case 'MISSION_REQUEST':
        // 老固件/未协商协议的链路会发这个(要求回浮点版 MISSION_ITEM)
        this.onMissionRequest(message, false)
        break
      case 'MISSION_ACK':
        this.onMissionAck(message)
        break
      case 'COMMAND_ACK':
        this.onCommandAck(message)
        break
      case 'STATUSTEXT':
        this.onStatusText(message)
        break
      default:
        break
    }
  }

  private heartbeatAgeMs(): number {
    if (this.telemetry.heartbeatAt === 0) return Number.POSITIVE_INFINITY
    return Date.now() - this.telemetry.heartbeatAt
  }

  // ─────────────────────────── 状态归一化 ───────────────────────────

  /**
   * 把遥测拼成 `ExternalFlightState`。
   *
   * 位置优先用 `LOCAL_POSITION_NED`(已经是本地米,最省事且没有投影误差),
   * 没有再用 `GLOBAL_POSITION_INT` 走经纬高 → ENU。
   */
  private buildState(delta: number): ExternalFlightState | null {
    const t = this.telemetry
    if (!t.attitude && !t.globalPosition && !t.localPosition) return this.lastState

    const position = this.resolvePosition()
    if (!position) return this.lastState

    const attitude = t.attitude?.values
    const heading = attitude ? ((attitude.yaw as number) * RAD_TO_DEG + 360) % 360 : 0
    const tiltPitch = attitude ? (attitude.pitch as number) * RAD_TO_DEG : 0
    const tiltRoll = attitude ? (attitude.roll as number) * RAD_TO_DEG : 0

    const armed = this.isArmed()
    const modeText = this.modeText()
    const battery = this.batteryInfo()
    const satelliteCount = (t.gpsRaw?.values.satellites_visible as number | undefined) ?? 0
    const throttle = (t.vfrHud?.values.throttle as number | undefined) ?? 0

    return {
      position,
      // 速度为 0 时也给出显式值,免得内核走位置差分放大噪声
      velocity: this.resolveVelocity(delta),
      heading,
      tiltPitch,
      tiltRoll,
      phase: this.resolvePhase(armed, position.y),
      motorLoad: armed ? Math.max(0.05, Math.min(1, throttle / 100)) : 0,
      batteryPercent: battery.percent,
      batteryVoltage: battery.voltage,
      batteryCurrent: battery.current,
      satellites: satelliteCount,
      gimbalPitch: this.resolveGimbalPitch(),
      gimbalYaw: this.resolveGimbalYaw(),
      modeLabel: modeText,
      positionSource: satelliteCount >= 6 ? 'gps' : armed ? 'atti' : 'gps',
      missionIndex: (this.telemetry.missionCurrent?.values.seq as number | undefined) ?? undefined,
    }
  }

  /** 位置:优先本地 NED,其次经纬高 → ENU */
  private resolvePosition(): { x: number; y: number; z: number } | null {
    const local = this.telemetry.localPosition?.values
    if (local) {
      // MAVLink LOCAL_POSITION_NED:x 北 / y 东 / z 下;本库:x 东 / y 上 / z 南
      return { x: local.y as number, y: -(local.z as number), z: -(local.x as number) }
    }
    const frame = this.rebuildFrame(false)
    const global = this.telemetry.globalPosition?.values
    if (!frame || !global) return null
    const geo: GeodeticCoordinate = {
      longitude: (global.lon as number) * 1e-7,
      latitude: (global.lat as number) * 1e-7,
      altitude: (global.alt as number) / 1000,
    }
    const [east, north, up] = ecefToEnu(geodeticToEcef(geo), frame)
    return { x: east, y: up, z: -north }
  }

  /** 速度(本地 x 东 / y 上 / z 南,米每秒) */
  private resolveVelocity(delta: number): { x: number; y: number; z: number } | undefined {
    const local = this.telemetry.localPosition?.values
    if (local) {
      // vx 北 / vy 东 / vz 下 → 本库 x 东 / y 上 / z 南
      return { x: local.vy as number, y: -(local.vz as number), z: -(local.vx as number) }
    }
    const global = this.telemetry.globalPosition?.values
    if (global) {
      // GLOBAL_POSITION_INT 的速度是 cm/s,vx 北 / vy 东 / vz 下
      return {
        x: (global.vy as number) / 100,
        y: -(global.vz as number) / 100,
        z: -(global.vx as number) / 100,
      }
    }
    void delta
    return undefined
  }

  /**
   * 建立 / 重建本地坐标锚点。
   * 优先 `HOME_POSITION`(飞控自己记的返航点,和真机行为一致),其次第一个定位点。
   */
  private rebuildFrame(force: boolean): EcefEnuFrame | null {
    const home = this.telemetry.home?.values
    if (home) {
      const geo: GeodeticCoordinate = {
        longitude: (home.longitude as number) * 1e-7,
        latitude: (home.latitude as number) * 1e-7,
        altitude: (home.altitude as number) / 1000,
      }
      if (force || !this.frame) this.frame = createEcefEnuFrame(geo)
      return this.frame
    }
    if (this.options.home) {
      if (force || !this.frame) this.frame = createEcefEnuFrame(this.options.home)
      return this.frame
    }
    if (!this.frame) {
      const global = this.telemetry.globalPosition?.values
      if (!global) return null
      // 第一帧定位当锚点:此刻的位置就成为本地原点(和"上电时记返航点"同义)
      this.frame = createEcefEnuFrame({
        longitude: (global.lon as number) * 1e-7,
        latitude: (global.lat as number) * 1e-7,
        // 用相对高度当锚点高度,这样 y 坐标天然就是"离起飞点的高度"
        altitude: (global.alt as number) / 1000 - (global.relative_alt as number) / 1000,
      })
    }
    return this.frame
  }

  private isArmed(): boolean {
    const baseMode = (this.telemetry.heartbeat?.values.base_mode as number | undefined) ?? 0
    return (baseMode & MODE_FLAG_SAFETY_ARMED) !== 0
  }

  private autopilotId(): number {
    return (this.telemetry.heartbeat?.values.autopilot as number | undefined) ?? 0
  }

  private autopilotName(): string {
    const id = this.autopilotId()
    if (id === AUTOPILOT_PX4) return 'PX4'
    if (id === AUTOPILOT_ARDUPILOT) return 'ArduPilot'
    return '未知自驾仪'
  }

  /** PX4 的 custom_mode 是打包的:主模式在 bit16-23,子模式在 bit24-31 */
  private px4Modes(): { main: number; sub: number } {
    const custom = (this.telemetry.heartbeat?.values.custom_mode as number | undefined) ?? 0
    return { main: (custom >> 16) & 0xff, sub: (custom >> 24) & 0xff }
  }

  private modeText(): string {
    const custom = (this.telemetry.heartbeat?.values.custom_mode as number | undefined) ?? 0
    if (this.autopilotId() === AUTOPILOT_PX4) {
      const { main, sub } = this.px4Modes()
      const mainLabel = PX4_MAIN_MODE_LABELS[main] ?? `MODE ${main}`
      if (main !== 4) return mainLabel
      return `${mainLabel}.${PX4_SUB_MODE_LABELS[sub] ?? `SUB ${sub}`}`
    }
    if (this.autopilotId() === AUTOPILOT_ARDUPILOT) {
      return ARDUPILOT_MODE_LABELS[custom] ?? `MODE ${custom}`
    }
    return `MODE ${custom}`
  }

  /** 模式 → 面板显示用的飞行阶段 */
  private resolvePhase(armed: boolean, altitude: number): FlightPhase {
    const px4 = this.autopilotId() === AUTOPILOT_PX4
    const custom = (this.telemetry.heartbeat?.values.custom_mode as number | undefined) ?? 0
    const { main, sub } = this.px4Modes()

    // 返航 / 降落优先判定(PX4 看 AUTO 子模式,ArduPilot 看顶层模式号)
    const isRtl = px4 ? main === 4 && sub === 5 : custom === 6 || custom === 21
    const isLand = px4 ? main === 4 && sub === 6 : custom === 9
    const isMission = px4 ? main === 4 && sub === 4 : custom === 3
    const isTakeoff = px4 && main === 4 && sub === 2

    if (isLand) return 'landing'
    if (isRtl) return 'rth'
    if (isTakeoff) return 'takingOff'
    if (!armed) return altitude > 0.2 ? 'landing' : 'standby'
    if (isMission) return 'waypoint'
    return altitude > 0.2 ? 'flying' : 'motorsOn'
  }

  private batteryInfo(): { percent?: number; voltage?: number; current?: number } {
    const battery = this.telemetry.battery?.values
    if (battery) {
      const cells = Array.isArray(battery.voltages) ? (battery.voltages as number[]) : []
      // 逐节电压单位 mV;未使用的节填 UINT16_MAX,要跳过
      const totalMv = cells.reduce((sum, mv) => (mv > 0 && mv !== 0xffff ? sum + mv : sum), 0)
      const remaining = battery.battery_remaining as number | undefined
      return {
        percent: remaining !== undefined && remaining >= 0 ? remaining : undefined,
        voltage: totalMv > 0 ? totalMv / 1000 : undefined,
        current: ((battery.current_battery as number | undefined) ?? 0) / 100,
      }
    }
    const sys = this.telemetry.sysStatus?.values
    if (sys) {
      const remaining = sys.battery_remaining as number | undefined
      return {
        percent: remaining !== undefined && remaining >= 0 ? remaining : undefined,
        voltage: ((sys.voltage_battery as number | undefined) ?? 0) / 1000 || undefined,
        current: ((sys.current_battery as number | undefined) ?? 0) / 100,
      }
    }
    return {}
  }

  /** 云台俯仰:优先 MOUNT_ORIENTATION(度,正=抬头),其次四元数解算 */
  private resolveGimbalPitch(): number | undefined {
    const mount = this.telemetry.mount?.values
    if (mount && Number.isFinite(mount.pitch as number)) return mount.pitch as number
    const q = this.telemetry.gimbal?.values.q
    if (Array.isArray(q) && q.length === 4) return quaternionToEuler(q as number[]).pitch
    return undefined
  }

  private resolveGimbalYaw(): number | undefined {
    const mount = this.telemetry.mount?.values
    if (mount && Number.isFinite(mount.yaw as number)) return mount.yaw as number
    const q = this.telemetry.gimbal?.values.q
    if (Array.isArray(q) && q.length === 4) return quaternionToEuler(q as number[]).yaw
    return undefined
  }

  // ─────────────────────────── 指令下发 ───────────────────────────

  /** 发一帧(未连接则丢弃:重连后自然会重新对齐状态) */
  private send(frame: Uint8Array): void {
    const socket = this.socket
    if (!socket || socket.readyState !== 1) return
    // 复制进独立的 ArrayBuffer:一来避开 subarray 的 byteOffset 陷阱,
    // 二来 ArrayBufferLike 里还可能是 SharedArrayBuffer,不是合法的 WebSocket 载荷类型
    const payload = new ArrayBuffer(frame.byteLength)
    new Uint8Array(payload).set(frame)
    socket.send(payload)
  }

  private encode(name: Parameters<typeof encodeMessage>[0], values: Record<string, number | string | number[]>) {
    return encodeMessage(name, values, {
      sysId: this.options.sysId,
      compId: this.options.compId,
    })
  }

  /** COMMAND_LONG:一条消息覆盖解锁/起飞/降落/返航/切模式 */
  private sendCommand(command: number, params: number[]): void {
    const values: Record<string, number> = {
      target_system: this.options.targetSystem,
      target_component: this.options.targetComponent,
      command,
      confirmation: 0,
    }
    for (let index = 0; index < 7; index += 1) {
      values[`param${index + 1}`] = params[index] ?? 0
    }
    this.send(this.encode('COMMAND_LONG', values))
  }

  private sendCustomMode(customMode: number): void {
    // param1 = MAV_MODE_FLAG_CUSTOM_MODE_ENABLED(1),param2 = custom_mode
    this.sendCommand(MAV_CMD.DO_SET_MODE, [1, customMode])
  }

  /** 面板挡位 → 自驾仪的模式号(只做"最接近"的映射,不强求语义一致) */
  private modeNumberFor(mode: FlightMode): number {
    if (this.autopilotId() === AUTOPILOT_PX4) {
      // ⚠️ PX4 的三挡(Cine/Normal/Sport)是遥控器上的拨杆,MAVLink 只能切主模式。
      // MANUAL(1) 是摇杆直通,没有 RC 输入时飞控会直接 failsafe —— 所以一律给 POSCTL。
      // 外部接管下"挡位"没有真实语义,速度上限由飞控参数决定,这里不假装能改。
      void mode
      return 3 << 16
    }
    // ArduPilot:cine→LOITER(稳)、normal→POSHOLD、sport→SPORT
    return mode === 'sport' ? 13 : mode === 'cine' ? 5 : 16
  }

  private loiterModeNumber(): number {
    if (this.autopilotId() === AUTOPILOT_PX4) return (4 << 16) | (3 << 24)
    return 5
  }

  /** 本地位置指令:需要自驾仪处在接受外部位置指令的模式 */
  private gotoLocal(x: number, y: number, z: number, heading?: number): void {
    // PX4 只有 OFFBOARD 接受 setpoint;ArduPilot 是 GUIDED
    const px4 = this.autopilotId() === AUTOPILOT_PX4
    this.setpointTarget = { x, y, z, heading }
    // ⚠️ 顺序不能反:先把 setpoint 流铺好,再切模式。
    // 反过来的话,从"切模式成功"到"第一帧 setpoint 到达"之间有个空窗,
    // 而 PX4 的 COM_OF_LOSS_T 只有 1 s —— 链路稍慢就直接判 offboard lost。
    // 关键认知:setpoint 不是一次性指令,而是一条持续的数据流。
    this.startSetpointStream()
    this.sendSetpoint()
    this.sendCustomMode(px4 ? 6 << 16 : 4)
    this.emit('info', `位置指令 → (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`)
  }

  /** 起一条 10 Hz 的 setpoint 流 */
  private startSetpointStream(): void {
    this.stopSetpointStream()
    this.setpointTimer = setInterval(() => {
      if (!this.online()) {
        // 链路断了:留着定时器没有意义,飞控自己会触发失效保护
        this.stopSetpointStream()
        return
      }
      const target = this.setpointTarget
      if (!target) {
        this.stopSetpointStream()
        return
      }
      if (this.reachedTarget(target)) {
        // 到点了就交回位置模式悬停(继续占着 OFFBOARD 没有意义,还会挡住后续指令)
        this.stopSetpointStream()
        this.sendCustomMode(this.loiterModeNumber())
        this.emit('info', '已到达目标点,切换悬停')
        return
      }
      this.sendSetpoint()
    }, SETPOINT_INTERVAL_MS)
  }

  private stopSetpointStream(): void {
    if (this.setpointTimer) clearInterval(this.setpointTimer)
    this.setpointTimer = null
  }

  private reachedTarget(target: { x: number; y: number; z: number }): boolean {
    const position = this.lastState?.position
    if (!position) return false
    return Math.hypot(
      position.x - target.x,
      position.y - target.y,
      position.z - target.z,
    ) < ARRIVE_RADIUS_M
  }

  private sendSetpoint(): void {
    const target = this.setpointTarget
    if (!target) return
    // type_mask:bit0-2 位置忽略位(0=用)、bit3-5 速度忽略位(1=忽略)、
    //           bit6-8 加速度忽略、bit9 力忽略、bit10 偏航忽略、bit11 偏航速率忽略
    // 这里只控位置 + 可选偏航:速度/加速度/力全部忽略
    const ignoreVelocity = 0b111 << 3
    const ignoreAccel = 0b111 << 6
    const ignoreForce = 1 << 9
    const ignoreYaw = target.heading === undefined ? 1 << 10 : 0
    const ignoreYawRate = 1 << 11
    const typeMask = ignoreVelocity | ignoreAccel | ignoreForce | ignoreYaw | ignoreYawRate
    this.send(
      this.encode('SET_POSITION_TARGET_LOCAL_NED', {
        time_boot_ms: Date.now() & 0xffffffff,
        target_system: this.options.targetSystem,
        target_component: this.options.targetComponent,
        coordinate_frame: 1, // MAV_FRAME_LOCAL_NED
        type_mask: typeMask,
        x: target.x,
        y: -target.z, // 本库 z 向南,NED y 向北
        z: -target.y, // 本库 y 向上,NED z 向下
        yaw: target.heading === undefined ? 0 : (target.heading * Math.PI) / 180,
      }),
    )
  }

  private sendTakeoff(altitude: number): void {
    this.sendCommand(MAV_CMD.NAV_TAKEOFF, [0, 0, 0, Number.NaN, 0, 0, altitude])
    this.emit('info', `起飞指令已下发(${altitude} m)`)
  }

  /**
   * 上传航线:MAVLink 的航线上传是**飞控逐个索要**的握手,不是一把推过去。
   *
   *   MISSION_COUNT(n) → 飞控发 MISSION_REQUEST_INT(seq) → 我方发 MISSION_ITEM_INT(seq)
   *   → …… 直到飞控回 MISSION_ACK
   */
  uploadMission(
    waypoints: Array<{ x: number; z: number; altitude: number }>,
    onResult?: (ok: boolean, detail: string) => void,
    startAfterUpload = false,
  ): void {
    const frame = this.rebuildFrame(false)
    if (!frame) {
      onResult?.(false, '还没有本地坐标锚点,无法把航点转成经纬度')
      return
    }
    if (waypoints.length === 0) {
      onResult?.(false, '航点列表为空')
      return
    }
    const items = waypoints.map((waypoint) => {
      const [east, north] = [waypoint.x, -waypoint.z]
      const ecef = enuToEcef([east, north, waypoint.altitude], frame)
      const geo = ecefToGeodetic(ecef)
      return {
        latitude: geo.latitude,
        longitude: geo.longitude,
        altitude: waypoint.altitude,
      }
    })
    this.pendingMission = { items, onResult, startAfterUpload }
    this.send(
      this.encode('MISSION_COUNT', {
        target_system: this.options.targetSystem,
        target_component: this.options.targetComponent,
        count: items.length,
      }),
    )
    this.emit('info', `航线已下发(${items.length} 个航点),等待飞控逐点索要`)
  }

  /**
   * 应答飞控的航点索要。
   *
   * 两种问法要回两种答法:问 `MISSION_REQUEST_INT` 回 1e7 定点经纬度,
   * 问老式 `MISSION_REQUEST` 回浮点度数。回错了飞控会一直重问,最后整条航线被拒。
   */
  private onMissionRequest(message: DecodedMessage, useInt: boolean): void {
    const pending = this.pendingMission
    if (!pending) return
    const seq = (message.values.seq as number | undefined) ?? 0
    const item = pending.items[seq]
    if (!item) return
    const common = {
      target_system: this.options.targetSystem,
      target_component: this.options.targetComponent,
      seq,
      command: MAV_CMD.NAV_WAYPOINT,
      current: seq === 0 ? 1 : 0,
      autocontinue: 1,
      param1: 0,
      param2: 0,
      param3: 0,
      param4: Number.NaN,
      z: item.altitude,
    }
    if (useInt) {
      this.send(
        this.encode('MISSION_ITEM_INT', {
          ...common,
          frame: MAV_FRAME.GLOBAL_RELATIVE_ALT_INT,
          x: Math.round(item.latitude * 1e7),
          y: Math.round(item.longitude * 1e7),
        }),
      )
      return
    }
    this.send(
      this.encode('MISSION_ITEM', {
        ...common,
        frame: MAV_FRAME.GLOBAL_RELATIVE_ALT,
        x: item.latitude,
        y: item.longitude,
      }),
    )
  }

  private onMissionAck(message: DecodedMessage): void {
    const pending = this.pendingMission
    if (!pending) return
    this.pendingMission = null
    const type = (message.values.type as number | undefined) ?? 0
    const ok = type === 0
    pending.onResult?.(ok, ok ? '航线已接受' : `航线被拒绝(type=${type})`)
    this.emit(ok ? 'success' : 'error', ok ? '飞控已接受航线' : `飞控拒绝航线(type=${type})`)
    if (ok && pending.startAfterUpload) {
      // 真机上传完不会自己开始,必须切到 AUTO.MISSION(PX4)或 AUTO(ArduPilot)
      this.sendCustomMode(this.autopilotId() === AUTOPILOT_PX4 ? (4 << 16) | (4 << 24) : 3)
    }
  }

  private onCommandAck(message: DecodedMessage): void {
    const result = (message.values.result as number | undefined) ?? 0
    const command = (message.values.command as number | undefined) ?? 0

    // 解锁 ACK 回来才发 NAV_TAKEOFF:真机的 preflight check 不是瞬间的,
    // 抢跑的那一帧会被 COMMAND_DENIED 吃掉(严格契约的 SITL 也是这么表现的)
    if (command === MAV_CMD.COMPONENT_ARM_DISARM) {
      const pending = this.pendingTakeoff
      if (pending) {
        this.pendingTakeoff = null
        if (result === 0) this.sendTakeoff(pending.altitude)
        else this.emit('error', `解锁被拒,起飞已取消(result=${result})`)
      }
    }

    if (result === 0) return
    this.emit('warn', `指令 ${command} 被拒绝(result=${result})`)
  }

  private onStatusText(message: DecodedMessage): void {
    const text = (message.values.text as string | undefined) ?? ''
    if (!text) return
    const severity = (message.values.severity as number | undefined) ?? 6
    // MAV_SEVERITY:0-3 危险/错误,4 警告,5-6 提示,7 调试
    const level = severity <= 3 ? 'error' : severity === 4 ? 'warn' : 'info'
    this.emit(level, `飞控:${text}`)
  }

  // ─────────────────────────── 事件与状态 ───────────────────────────

  private emit(level: 'info' | 'warn' | 'error' | 'success', text: string): void {
    this.options.onEvent?.(level, text)
    this.sim?.pushEvent(level, text)
  }

  private emitStatus(): void {
    // 解锁迟迟不回 ACK:不要无限等,直接报掉(真机上就是自检没过)
    if (this.pendingTakeoff && Date.now() > this.pendingTakeoff.deadline) {
      this.pendingTakeoff = null
      this.emit('error', '解锁超时,起飞已取消(飞控可能没通过自检)')
    }

    const status: MavlinkLinkStatus = {
      connected: this.online(),
      heartbeatAgeMs: this.heartbeatAgeMs(),
      frames: this.parser.stats.frames,
      crcErrors: this.parser.stats.crcErrors,
      autopilot: this.autopilotName(),
      mode: this.modeText(),
      armed: this.isArmed(),
    }
    this.options.onStatus?.(status)
  }
}

/**
 * 四元数 → 欧拉角(度)。q 顺序与 MAVLink 一致:[w, x, y, z]。
 * 只用于云台朝向:俯仰限在 ±90°,不处理万向锁的极端情形。
 */
export function quaternionToEuler(q: number[]): { roll: number; pitch: number; yaw: number } {
  const w = q[0] ?? 1
  const x = q[1] ?? 0
  const y = q[2] ?? 0
  const z = q[3] ?? 0
  const sinPitch = 2 * (w * y - z * x)
  const pitch = Math.asin(Math.max(-1, Math.min(1, sinPitch))) * RAD_TO_DEG
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * RAD_TO_DEG
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * RAD_TO_DEG
  return { roll, pitch, yaw: (yaw + 360) % 360 }
}

/**
 * 一步到位:建连接 + 接管内核。
 *
 * ```ts
 * const session = await connectMavlink(drone, { url: 'ws://127.0.0.1:8118' })
 * // …用完了
 * await session.close()
 * ```
 */
export async function connectMavlink(
  host: { sim: DroneSim },
  options: MavlinkSourceOptions,
): Promise<MavlinkSource> {
  const source = new MavlinkSource(options)
  source.attach(host.sim)
  await source.connect()
  return source
}

/** MAVLink 消息 ID 常量再导出,方便调用方订阅自定义消息 */
export { MAVLINK_MSG_ID }
