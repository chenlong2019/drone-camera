#!/usr/bin/env node
/**
 * 假 SITL —— 不装 PX4 也能端到端验证 MAVLink 接入。
 *
 * 它在 UDP 上吐**真实格式**的 MAVLink 2 帧(帧头、CRC_EXTRA、payload 重排全部照规范),
 * 并且会响应地面站指令:解锁、起飞、降落、返航、切模式、上传航线、位置指令。
 * 于是浏览器侧的解析器 / 坐标换算 / 模式映射 / 指令回环都被完整走一遍。
 *
 *   node mavlink/fake-sitl.mjs                     # 往 127.0.0.1:14550 发
 *   node mavlink/fake-sitl.mjs --to 127.0.0.1:14550 --lat 39.906 --lon 116.391
 *
 * 与真 SITL 的差别只在于「飞控逻辑」是这里手写的简化版,协议层完全一致 ——
 * 所以它同时也是「如何从外部驱动 DroneSim」的参考实现。
 *
 * ⚠️ 默认按 **PX4 的行为契约** 拒绝非法请求(见 CONTRACT 常量):
 *    - 未解锁就起飞 → COMMAND_DENIED(2)
 *    - 解锁是异步的(preflight check 要时间),期间起飞同样被拒
 *    - OFFBOARD 超过 1 s 没有 setpoint → 判定 offboard lost,退回 POSCTL
 *    - 无 RC 输入切 MANUAL → 立刻 failsafe 回 POSCTL
 *    - 上位机不应答航点请求 → 重试 3 次后 MISSION_ACK(REJECTED)
 *    --lenient 关掉这些规则(旧行为,只验证协议层)
 */
import dgram from 'node:dgram'
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url)
const { encodeMessage, MavlinkParser } = await jiti.import('../src/lib/drone-camera/drone-mavlink.ts')
const { MAV_CMD } = await jiti.import('../src/lib/drone-camera/drone-mavlink-defs.ts')
const { createEcefEnuFrame, enuToEcef, ecefToGeodetic, geodeticToEcef, ecefToEnu } = await jiti.import(
  '../src/lib/drone-camera/drone-photogrammetry.ts',
)

function parseArgs(argv) {
  const options = {
    to: '127.0.0.1:14550',
    lat: 39.906,
    lon: 116.391,
    alt: 50,
    quiet: false,
    /** false = 按 PX4 契约拒绝非法请求;--lenient 关掉 */
    strict: true,
    /** 航线上传握手用老式 MISSION_REQUEST(浮点)而不是 MISSION_REQUEST_INT */
    legacyMission: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    switch (argv[index]) {
      case '--to':
        options.to = value
        index += 1
        break
      case '--lat':
        options.lat = Number(value)
        index += 1
        break
      case '--lon':
        options.lon = Number(value)
        index += 1
        break
      case '--alt':
        options.alt = Number(value)
        index += 1
        break
      case '--quiet':
        options.quiet = true
        break
      case '--lenient':
        options.strict = false
        break
      case '--legacy-mission':
        options.legacyMission = true
        break
      case '--help':
      case '-h':
        console.log(
          '假 SITL:往 <host:port> 发 MAVLink 2 遥测并响应地面站指令\n' +
            '  --to h:p   目标地址,默认 127.0.0.1:14550(网桥的 --listen)\n' +
            '  --lat/--lon/--alt  返航点地理坐标\n' +
            '  --lenient        不按 PX4 契约拒绝非法请求(只验协议)\n' +
            '  --legacy-mission 航线上传走老式 MISSION_REQUEST(浮点)',
        )
        process.exit(0)
        break
      default:
        break
    }
  }
  const [host, port] = options.to.split(':')
  options.remote = { host, port: Number(port) }
  return options
}

const options = parseArgs(process.argv.slice(2))
const log = (...args) => {
  if (!options.quiet) console.log('[fake-sitl]', ...args)
}

const TAKEOFF_ALTITUDE = 20
const MAX_SPEED = 6
const MAX_CLIMB = 2

/**
 * PX4 的行为契约参数。
 *
 * 这几个数字都对应真机上的默认配置,不是随便取的:
 *   obLossMs      = COM_OF_LOSS_T(1.0 s)—— 超过就判 offboard lost
 *   armDelayMs    = preflight check(解锁不是瞬间完成的)
 *   missionRetry  = 航点请求的重试节奏(mavlink 模块默认 3 次后放弃)
 */
const CONTRACT = {
  obLossMs: 1000,
  obWarnMs: 500,
  armDelayMs: 300,
  missionRetryMs: 1500,
  missionMaxRetry: 3,
  /** PX4 的 COM_ARM_BAT_MIN 默认 0.1(10%) */
  armMinBattery: 10,
}

/** 严格模式:按 PX4 契约拒绝;--lenient 时全部放行 */
const strict = options.strict

const home = { longitude: options.lon, latitude: options.lat, altitude: options.alt }
const frame = createEcefEnuFrame(home)

/** 机体状态(本地 ENU:x 东 / y 上 / z 南) */
const state = {
  armed: false,
  /** PX4 打包模式:主模式 bit16,子模式 bit24 */
  mainMode: 3, // POSCTL
  subMode: 0,
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  heading: 0,
  battery: 98,
  gpsBars: 12,
  /** 起飞/返航使用的巡航高度(由 NAV_TAKEOFF 的 param7 决定) */
  cruiseAltitude: TAKEOFF_ALTITUDE,
  /** 位置指令目标(goto / 任务航点) */
  target: null,
  /** 已上传的航线(本地坐标) */
  mission: [],
  missionIndex: -1,
  /** 任务上传握手:已收到的航点数 */
  upload: null,
  bootMs: 0,
  /** 最近一次收到位置指令的时刻(ms,用于 offboard 超时判定) */
  lastSetpointMs: -1,
  /** offboard 超时是否已经处理过(避免每帧重复切模式) */
  obLost: false,
  /** 0.5 s 无 setpoint 的告警是否已经打过(避免每帧刷屏) */
  obWarned: false,
  /** 解锁请求的生效时刻(异步解锁) */
  armPendingAt: -1,
  /** 切进 MANUAL 后等待 failsafe 的时刻 */
  manualSinceMs: -1,
  /** 航点请求重试记录 */
  missionRetry: null,
}

// ─────────────────────────────── UDP ───────────────────────────────

const socket = dgram.createSocket('udp4')
let seq = 0

socket.on('error', (error) => console.error('[fake-sitl] UDP 错误:', error.message))

const parser = new MavlinkParser({
  crc: 'strict',
  onMessage: (message) => handleMessage(message),
})

socket.on('message', (buffer) => parser.push(new Uint8Array(buffer)))
socket.bind(0, '127.0.0.1', () => {
  log(`已绑定本地端口 ${socket.address().port}，发往 ${options.to}`)
  log(`返航点 ${home.latitude}, ${home.longitude}, ${home.altitude}m`)
})

function send(name, values) {
  const bytes = encodeMessage(name, values, { sysId: 1, compId: 1, seq: seq++ })
  socket.send(Buffer.from(bytes), options.remote.port, options.remote.host)
}

// ─────────────────────────────── 指令处理 ───────────────────────────────

function ack(command, result = 0) {
  send('COMMAND_ACK', { command, result })
}

/** 飞控文字消息(真机会刷很多,面板/日志要能吃下) */
function statusText(text, severity = 6) {
  send('STATUSTEXT', { severity, text })
}

/** 拒绝一条指令:COMMAND_DENIED(MAV_RESULT=2)+ 一条 STATUSTEXT —— 真机也是这么给的 */
function deny(command, reason) {
  ack(command, 2)
  statusText(reason, 4)
  log(`拒绝指令 ${command}:${reason}`)
}

function handleMessage(message) {
  const values = message.values
  switch (message.name) {
    case 'COMMAND_LONG': {
      const command = values.command
      switch (command) {
        case MAV_CMD.COMPONENT_ARM_DISARM: {
          const arm = (values.param1 ?? 0) > 0.5
          if (!arm) {
            state.armed = false
            state.armPendingAt = -1
            state.mainMode = 3
            state.subMode = 0
            state.target = null
            ack(command, 0)
            log('已上锁')
            return
          }
          if (state.armed) {
            ack(command, 0)
            return
          }
          if (strict) {
            // 真机 preflight check 的拒绝条件
            if (state.position.y > 1) return deny(command, 'ARM DENIED: ALREADY IN AIR')
            if (state.battery < CONTRACT.armMinBattery) {
              return deny(command, 'ARM DENIED: LOW BATTERY')
            }
            // 解锁不是瞬间完成的:ACK 要等 preflight check 走完才回
            if (state.armPendingAt < 0) {
              state.armPendingAt = state.bootMs + CONTRACT.armDelayMs
              log(`解锁请求已受理,preflight check ${CONTRACT.armDelayMs} ms`)
            }
            return
          }
          state.armed = true
          ack(command, 0)
          log('已解锁(电机起转)')
          return
        }
        case MAV_CMD.NAV_TAKEOFF: {
          if (!state.armed) {
            if (strict) return deny(command, 'TAKEOFF DENIED: NOT ARMED')
            ack(command, 2)
            log('拒绝起飞:未解锁')
            return
          }
          // OFFBOARD 里不接受起飞指令(要退出 offboard 才能切 AUTO.TAKEOFF)
          if (strict && state.mainMode === 6) {
            return deny(command, 'TAKEOFF DENIED: IN OFFBOARD')
          }
          const altitude = (values.param7 ?? 0) > 0 ? values.param7 : TAKEOFF_ALTITUDE
          state.cruiseAltitude = altitude
          state.mainMode = 4
          state.subMode = 2
          state.target = { x: state.position.x, y: altitude, z: state.position.z }
          ack(command, 0)
          log(`起飞至 ${altitude} m`)
          return
        }
        case MAV_CMD.NAV_LAND:
          state.mainMode = 4
          state.subMode = 6
          state.target = { x: state.position.x, y: 0, z: state.position.z }
          ack(command, 0)
          log('开始降落')
          return
        case MAV_CMD.NAV_RETURN_TO_LAUNCH:
          state.mainMode = 4
          state.subMode = 5
          state.target = { x: 0, y: state.cruiseAltitude, z: 0 }
          ack(command, 0)
          log('开始返航')
          return
        case MAV_CMD.DO_SET_MODE: {
          const custom = values.param2 ?? 0
          const main = (custom >> 16) & 0xff
          const sub = (custom >> 24) & 0xff
          if (strict) {
            // PX4 主模式 1..8,其余是非法值
            if (main < 1 || main > 8) return deny(command, `MODE DENIED: UNKNOWN MAIN ${main}`)
            // 地面不允许进 OFFBOARD(必须先 arm)
            if (main === 6 && !state.armed) return deny(command, 'OFFBOARD DENIED: NOT ARMED')
          }
          state.mainMode = main
          state.subMode = sub
          state.obLost = false
          state.obWarned = false
          // 进入 OFFBOARD 时从**这一刻**开始计 COM_OF_LOSS_T,而不是"从未收到就立刻丢"。
          // 真机的计时器是在模式切换时重启的,否则第一帧 setpoint 还没到就被判失败了。
          state.lastSetpointMs = main === 6 ? state.bootMs : -1
          if (main === 3) state.target = null
          // MANUAL(1)是直接透传 RC 摇杆的,记下切进去的时刻
          state.manualSinceMs = main === 1 && state.armed ? state.bootMs : -1
          ack(command, 0)
          log(`模式切换 → main=${main} sub=${sub}`)
          return
        }
        case 193: {
          // MAV_CMD_DO_PAUSE_CONTINUE
          const resume = (values.param1 ?? 0) > 0.5
          state.mainMode = 4
          state.subMode = resume ? 4 : 3
          ack(command, 0)
          log(resume ? '任务继续' : '任务暂停')
          return
        }
        default:
          ack(command, 3)
          log(`不支持的命令 ${command}`)
          return
      }
    }
    case 'MISSION_COUNT': {
      const count = values.count ?? 0
      if (count <= 0) {
        send('MISSION_ACK', { target_system: 255, target_component: 190, type: 2 })
        return
      }
      state.upload = { count, items: new Array(count).fill(null) }
      state.missionRetry = { seq: 0, atMs: state.bootMs, tries: 0 }
      log(`收到航线:${count} 个航点,开始逐点索要`)
      requestWaypoint(0)
      return
    }
    case 'MISSION_ITEM':
    case 'MISSION_ITEM_INT': {
      const upload = state.upload
      if (!upload) return
      const seqNo = values.seq ?? 0
      // 浮点版本经纬度就是度;INT 版本是 1e7 定点
      const scaled = message.name === 'MISSION_ITEM_INT'
      const lat = scaled ? (values.x ?? 0) * 1e-7 : (values.x ?? 0)
      const lon = scaled ? (values.y ?? 0) * 1e-7 : (values.y ?? 0)
      upload.items[seqNo] = geoToLocal(lat, lon, values.z ?? 0)
      const next = seqNo + 1
      if (next < upload.count) {
        state.missionRetry = { seq: next, atMs: state.bootMs, tries: 0 }
        requestWaypoint(next)
        return
      }
      // 真机要求 0..n-1 全部到齐,缺一个都不收
      const missing = upload.items.findIndex((item) => !item)
      if (missing >= 0) {
        state.upload = null
        state.missionRetry = null
        send('MISSION_ACK', { target_system: 255, target_component: 190, type: 1 })
        statusText(`MISSION REJECTED: MISSING ITEM ${missing}`, 4)
        log(`航线不完整(缺第 ${missing} 点),已拒绝`)
        return
      }
      state.mission = upload.items
      state.missionIndex = -1
      state.upload = null
      state.missionRetry = null
      send('MISSION_ACK', { target_system: 255, target_component: 190, type: 0 })
      log(`航线接收完成:${state.mission.length} 个航点`)
      return
    }
    case 'SET_POSITION_TARGET_LOCAL_NED': {
      if (!state.armed) return
      // 真机只在 OFFBOARD 里接受外部 setpoint;别的模式下静默丢弃(不报错,只是不动)
      if (strict && state.mainMode !== 6) {
        statusText('SETPOINT IGNORED: NOT IN OFFBOARD', 4)
        return
      }
      if (!strict && state.mainMode !== 6 && state.mainMode !== 4) {
        log('位置指令被忽略:不在 OFFBOARD / AUTO 模式')
        return
      }
      // NED → 本地:y 北 → z 南取负,z 下 → y 上取负
      state.target = {
        x: values.x ?? state.position.x,
        y: -(values.z ?? 0),
        z: -(values.y ?? 0),
      }
      state.lastSetpointMs = state.bootMs
      state.obLost = false
      state.obWarned = false
      if (state.subMode !== 0) state.subMode = 0
      log(`位置指令 → (${state.target.x.toFixed(1)}, ${state.target.y.toFixed(1)}, ${state.target.z.toFixed(1)})`)
      return
    }
    default:
      return
  }
}

/**
 * 索要第 seq 个航点。
 *
 * --legacy-mission 时发老式 `MISSION_REQUEST`(要求对端回 `MISSION_ITEM` 浮点版本),
 * 这是老固件和未做协议协商的链路的默认行为;现代 PX4 发 `MISSION_REQUEST_INT`。
 */
function requestWaypoint(seqNo) {
  const name = options.legacyMission ? 'MISSION_REQUEST' : 'MISSION_REQUEST_INT'
  send(name, { target_system: 255, target_component: 190, seq: seqNo })
}

/** 经纬高 → 本地 ENU(x 东 / y 上 / z 南) */
function geoToLocal(lat, lon, relativeAltitude) {
  const enu = ecefToEnu(
    geodeticToEcef({ longitude: lon, latitude: lat, altitude: home.altitude + relativeAltitude }),
    frame,
  )
  return { x: enu[0], y: enu[2], z: -enu[1] }
}

// ─────────────────────────────── 飞行模型 ───────────────────────────────

const radians = (deg) => (deg * Math.PI) / 180
const degrees = (rad) => (rad * 180) / Math.PI

function taskTarget() {
  // AUTO.MISSION:按航点顺序飞,最后一点飞完自动返航
  if (state.mainMode === 4 && state.subMode === 4 && state.mission.length > 0) {
    if (state.missionIndex < 0) state.missionIndex = 0
    const waypoint = state.mission[state.missionIndex]
    if (waypoint) {
      const distance = Math.hypot(
        waypoint.x - state.position.x,
        waypoint.z - state.position.z,
      )
      const altitudeGap = Math.abs(waypoint.y - state.position.y)
      if (distance < 1.5 && altitudeGap < 1.2) {
        state.missionIndex += 1
        if (state.missionIndex >= state.mission.length) {
          state.mainMode = 4
          state.subMode = 5
          state.target = { x: 0, y: state.cruiseAltitude, z: 0 }
          state.missionIndex = -1
          return state.target
        }
      }
      return state.mission[state.missionIndex] ?? null
    }
  }
  return state.target
}

/**
 * PX4 的行为契约。放在每一帧开头跑,因为这些是**持续状态**,不是一次性事件:
 * 解锁的 preflight、offboard 的 setpoint 流、MANUAL 的 RC 依赖、航点重试的超时。
 *
 * 真机上这四条都由飞控自己盯着,所以上位机不可能靠「发一条指令就完事」通过。
 */
function contractChecks() {
  // ── 异步解锁:preflight check 走完才真正 armed 并回 ACK ──
  if (state.armPendingAt >= 0 && state.bootMs >= state.armPendingAt) {
    state.armPendingAt = -1
    state.armed = true
    ack(MAV_CMD.COMPONENT_ARM_DISARM, 0)
    statusText('ARMED', 6)
    log('preflight check 通过,已解锁')
  }

  // ── OFFBOARD 必须持续收到 setpoint(COM_OF_LOSS_T 默认 1.0 s) ──
  if (state.mainMode === 6) {
    const age = state.lastSetpointMs < 0 ? Number.POSITIVE_INFINITY : state.bootMs - state.lastSetpointMs
    if (age > CONTRACT.obLossMs) {
      if (!state.obLost) {
        state.obLost = true
        statusText('OFFBOARD LOST', 3)
        log(
          `offboard lost(距今 ${Number.isFinite(age) ? Math.round(age) + ' ms' : '从未'} 未收到 setpoint),` +
            '按 COM_OBL_RC_ACT 退回 POSCTL',
        )
        state.mainMode = 3
        state.subMode = 0
        state.target = null
        state.manualSinceMs = -1
      }
    } else if (age > CONTRACT.obWarnMs && !state.obWarned) {
      state.obWarned = true
      statusText('OFFBOARD SETPOINT TIMEOUT', 4)
    }
  }

  // ── MANUAL 是 RC 直通:没有摇杆输入就触发 failsafe ──
  if (strict && state.mainMode === 1 && state.armed) {
    if (state.manualSinceMs < 0) state.manualSinceMs = state.bootMs
    else if (state.bootMs - state.manualSinceMs > 200) {
      statusText('MANUAL: NO RC INPUT, FAILSAFE', 2)
      log('MANUAL 模式无 RC 输入 → failsafe 回 POSCTL')
      state.mainMode = 3
      state.subMode = 0
      state.manualSinceMs = -1
      state.obLost = false
    }
  }

  // ── 航点请求重试:上位机不应答就放弃整条航线 ──
  const retry = state.missionRetry
  if (retry && state.upload && state.bootMs - retry.atMs > CONTRACT.missionRetryMs) {
    if (retry.tries + 1 >= CONTRACT.missionMaxRetry) {
      state.missionRetry = null
      state.upload = null
      send('MISSION_ACK', { target_system: 255, target_component: 190, type: 1 })
      statusText('MISSION UPLOAD TIMEOUT', 3)
      log(`航点 ${retry.seq} 重试 ${CONTRACT.missionMaxRetry} 次无应答,放弃上传`)
    } else {
      retry.tries += 1
      retry.atMs = state.bootMs
      requestWaypoint(retry.seq)
      log(`重试索要航点 ${retry.seq}(${retry.tries}/${CONTRACT.missionMaxRetry})`)
    }
  }
}

function step(deltaSeconds) {
  state.bootMs += deltaSeconds * 1000
  contractChecks()
  const target = taskTarget()

  let desired = { x: 0, y: 0, z: 0 }
  if (target && state.armed) {
    const dx = target.x - state.position.x
    const dz = target.z - state.position.z
    const dy = target.y - state.position.y
    const horizontal = Math.hypot(dx, dz)
    if (horizontal > 0.05) {
      const speed = Math.min(MAX_SPEED, horizontal * 1.2)
      desired.x = (dx / horizontal) * speed
      desired.z = (dz / horizontal) * speed
    }
    if (Math.abs(dy) > 0.05) {
      desired.y = Math.sign(dy) * Math.min(MAX_CLIMB, Math.abs(dy) * 0.8)
    }
  }

  // 一阶惯性:速度平滑靠近目标值
  const response = Math.min(1, deltaSeconds * 2.5)
  state.velocity.x += (desired.x - state.velocity.x) * response
  state.velocity.y += (desired.y - state.velocity.y) * response
  state.velocity.z += (desired.z - state.velocity.z) * response

  state.position.x += state.velocity.x * deltaSeconds
  state.position.y = Math.max(0, state.position.y + state.velocity.y * deltaSeconds)
  state.position.z += state.velocity.z * deltaSeconds

  // 机头朝向速度方向;慢速时保持上一朝向
  const horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z)
  if (horizontalSpeed > 0.35) {
    const targetHeading = degrees(Math.atan2(state.velocity.x, -state.velocity.z))
    let difference = ((targetHeading - state.heading + 540) % 360) - 180
    difference = Math.max(-90 * deltaSeconds, Math.min(90 * deltaSeconds, difference))
    state.heading = (state.heading + difference + 360) % 360
  }

  // 触地判定:降落到 0 米就上锁
  if (state.mainMode === 4 && state.subMode === 6 && state.position.y <= 0.02) {
    state.position.y = 0
    state.velocity = { x: 0, y: 0, z: 0 }
    state.armed = false
    state.mainMode = 3
    state.subMode = 0
    state.target = null
    log('已落地并上锁')
  }
  if (state.mainMode === 4 && state.subMode === 2 && state.position.y >= state.cruiseAltitude - 0.2) {
    state.subMode = 3
    log('起飞完成,进入悬停')
  }
  if (state.armed) state.battery = Math.max(0, state.battery - deltaSeconds * 0.08)
}

// ─────────────────────────────── 遥测输出 ───────────────────────────────

function tiltPitch() {
  // 前飞低头:sim 约定「正 = 抬头」,与 MAVLink ATTITUDE.pitch 一致
  const forward =
    state.velocity.x * Math.sin(radians(state.heading)) -
    state.velocity.z * Math.cos(radians(state.heading))
  return -Math.min(25, Math.abs(forward) * 4) * Math.sign(forward || 1)
}

function geoPosition() {
  const ecef = enuToEcef([state.position.x, -state.position.z, state.position.y], frame)
  return ecefToGeodetic(ecef)
}

let lastSend = 0
let fastTickCounter = 0

function telemetry() {
  const now = Date.now()
  if (now - lastSend < 100) return
  lastSend = now
  fastTickCounter += 1

  const geo = geoPosition()
  const baseMode = (state.armed ? 0x80 : 0) | 0x01

  // 心跳:真机 PX4 的 GCS 链路是 1 Hz(宽松模式下沿用 2 Hz)
  if (fastTickCounter % (strict ? 10 : 5) === 1) {
    send('HEARTBEAT', {
      type: 2, // MAV_TYPE_QUADROTOR
      autopilot: 12, // PX4
      base_mode: baseMode,
      custom_mode: ((state.subMode << 24) | (state.mainMode << 16)) >>> 0,
      system_status: state.armed ? 4 : 3,
      mavlink_version: 3,
    })
    send('SYS_STATUS', {
      onboard_control_sensors_present: 0x7fffffff,
      onboard_control_sensors_enabled: 0x7fffffff,
      onboard_control_sensors_health: 0x7fffffff,
      load: 300,
      voltage_battery: 11200,
      current_battery: state.armed ? 420 : 12,
      battery_remaining: Math.round(state.battery),
      drop_rate_comm: 0,
      errors_comm: 0,
      errors_count1: 0,
      errors_count2: 0,
      errors_count3: 0,
      errors_count4: 0,
    })
    send('GPS_RAW_INT', {
      time_usec: state.bootMs * 1000,
      fix_type: 3,
      lat: Math.round(geo.latitude * 1e7),
      lon: Math.round(geo.longitude * 1e7),
      alt: Math.round(geo.altitude * 1000),
      eph: 80,
      epv: 120,
      vel: Math.round(Math.hypot(state.velocity.x, state.velocity.z) * 100),
      cog: Math.round(state.heading * 100),
      satellites_visible: state.gpsBars,
    })
    send('BATTERY_STATUS', {
      id: 0,
      battery_function: 2,
      type: 2,
      temperature: 310,
      voltages: [3700, 3700, 3700, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff],
      current_battery: state.armed ? 420 : 12,
      current_consumed: 120,
      energy_consumed: 0,
      battery_remaining: Math.round(state.battery),
    })
    send('HOME_POSITION', {
      latitude: Math.round(home.latitude * 1e7),
      longitude: Math.round(home.longitude * 1e7),
      altitude: Math.round(home.altitude * 1000),
      x: 0,
      y: 0,
      z: 0,
      q: [1, 0, 0, 0],
      approach_x: 0,
      approach_y: 0,
      approach_z: 0,
    })
  }

  send('ATTITUDE', {
    time_boot_ms: state.bootMs,
    roll: 0,
    pitch: radians(tiltPitch()),
    yaw: radians(state.heading),
    rollspeed: 0,
    pitchspeed: 0,
    yawspeed: 0,
  })
  send('LOCAL_POSITION_NED', {
    time_boot_ms: state.bootMs,
    x: -state.position.z, // NED x = 北 → 本库 z 是南,取负
    y: state.position.x, // NED y = 东
    z: -state.position.y, // NED z = 下
    vx: -state.velocity.z,
    vy: state.velocity.x,
    vz: -state.velocity.y,
  })
  send('GLOBAL_POSITION_INT', {
    time_boot_ms: state.bootMs,
    lat: Math.round(geo.latitude * 1e7),
    lon: Math.round(geo.longitude * 1e7),
    alt: Math.round(geo.altitude * 1000),
    relative_alt: Math.round(state.position.y * 1000),
    vx: Math.round(-state.velocity.z * 100),
    vy: Math.round(state.velocity.x * 100),
    vz: Math.round(-state.velocity.y * 100),
    hdg: Math.round(state.heading * 100),
  })
  send('VFR_HUD', {
    airspeed: Math.hypot(state.velocity.x, state.velocity.z),
    groundspeed: Math.hypot(state.velocity.x, state.velocity.z),
    heading: Math.round(state.heading),
    throttle: state.armed ? 55 : 0,
    alt: state.position.y,
    climb: state.velocity.y,
  })
  if (fastTickCounter % 2 === 0) {
    send('MOUNT_ORIENTATION', {
      time_boot_ms: state.bootMs,
      roll: 0,
      pitch: -25,
      yaw: 0,
    })
  }
  if (state.mainMode === 4 && state.subMode === 4 && state.missionIndex >= 0) {
    send('MISSION_CURRENT', { seq: state.missionIndex, total: state.mission.length })
  }
}

// ─────────────────────────────── 主循环 ───────────────────────────────

const TICK = 0.05
setInterval(() => {
  step(TICK)
  telemetry()
}, TICK * 1000)

log(
  `假 SITL 已启动(遥测 ${10} Hz / 心跳 ${strict ? 1 : 2} Hz,` +
    `${strict ? 'PX4 严格契约' : '宽松模式'}${options.legacyMission ? ' / 老式航线握手' : ''})。Ctrl+C 退出。`,
)
