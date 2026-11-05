#!/usr/bin/env node
/**
 * PX4 行为契约验证 —— 证明假飞控**真的会拒绝**,而不是一路放行。
 *
 * 这个脚本不经过 `MavlinkSource`,它自己就是一个地面站:直接往 UDP 上发
 * 非法请求,看飞控怎么回。测的是「飞控侧的行为契约」,不是我们的代码。
 *
 * 为什么要单独测这一层:上一版 `verify-loop` 13/13 全绿,但接真 PX4 会立刻翻车
 * ——因为假飞控太客气,什么都答应。绿测试掩盖了四个必现缺陷。这几条断言的作用
 * 就是让"客气"这个状态无法再回来。
 *
 *   node mavlink/verify-px4-contract.mjs
 */
import dgram from 'node:dgram'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createJiti } from 'jiti'

const here = dirname(fileURLToPath(import.meta.url))
const jiti = createJiti(import.meta.url)
const { encodeMessage, MavlinkParser } = await jiti.import('../src/lib/drone-camera/drone-mavlink.ts')
const { MAV_CMD, MAV_FRAME } = await jiti.import('../src/lib/drone-camera/drone-mavlink-defs.ts')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 打包 PX4 的 custom_mode:主模式 bit16,子模式 bit24 */
const px4Mode = (main, sub = 0) => (((sub << 24) | (main << 16)) >>> 0)
const mainOf = (custom) => ((custom ?? 0) >> 16) & 0xff
const subOf = (custom) => ((custom ?? 0) >> 24) & 0xff

// ─────────────────────────────── 地面站客户端 ───────────────────────────────

/**
 * 最小地面站:bind 固定端口,等飞控先发包(用它来发现对端地址),
 * 之后就能收发。inbox 保留全部历史,便于做"某段时间内有没有出现过某条消息"的断言。
 */
function createClient(localPort) {
  const socket = dgram.createSocket('udp4')
  const inbox = []
  const waiters = []
  let remote = null
  let seq = 0

  const parser = new MavlinkParser({
    crc: 'strict',
    onMessage: (message) => {
      const entry = { name: message.name, values: message.values, at: Date.now() }
      inbox.push(entry)
      for (const waiter of [...waiters]) {
        if (waiter.match(entry)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(entry)
        }
      }
    },
  })

  socket.on('message', (buffer, rinfo) => {
    if (!remote) remote = { port: rinfo.port, host: rinfo.address }
    parser.push(new Uint8Array(buffer))
  })

  return new Promise((resolve) => {
    socket.bind(localPort, '127.0.0.1', () => {
      resolve({
        send(name, values) {
          if (!remote) throw new Error('还没收到飞控的包,对端地址未知')
          const bytes = encodeMessage(name, values, { sysId: 255, compId: 190, seq: seq++ })
          socket.send(Buffer.from(bytes), remote.port, remote.host)
        },
        /** 等一条满足条件的消息;超时返回 null(不抛,让断言去判断) */
        waitFor(name, predicate = () => true, timeoutMs = 5000) {
          const hit = inbox.find((m) => m.name === name && predicate(m))
          if (hit) return Promise.resolve(hit)
          return new Promise((res) => {
            const waiter = { match: (m) => m.name === name && predicate(m), resolve: res }
            waiters.push(waiter)
            setTimeout(() => {
              const index = waiters.indexOf(waiter)
              if (index >= 0) {
                waiters.splice(index, 1)
                res(null)
              }
            }, timeoutMs)
          })
        },
        clear() {
          inbox.length = 0
        },
        inbox,
        close() {
          try {
            socket.close()
          } catch {
            // 已经关了
          }
        },
      })
    })
  })
}

/** 起一个假 SITL,并等到它的第一帧(拿到对端地址) */
async function startSitl(port, extraArgs = []) {
  const child = spawn(
    process.execPath,
    [join(here, 'fake-sitl.mjs'), '--to', `127.0.0.1:${port}`, '--quiet', ...extraArgs],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const client = await createClient(port)
  // 心跳 1 Hz + 启动开销,给 6 s
  const first = await client.waitFor('HEARTBEAT', () => true, 6000)
  if (!first) throw new Error('假 SITL 没发心跳')
  return { child, client, stop: () => { client.close(); child.kill() } }
}

/** COMMAND_LONG 的完整参数:PX4 会校验,缺字段虽然按 0 编码但测试里写全更清楚 */
function commandLong(fields) {
  const values = { target_system: 1, target_component: 1, confirmation: 0 }
  for (let index = 1; index <= 7; index += 1) values[`param${index}`] = 0
  return { ...values, ...fields }
}

// ─────────────────────────── 主实例:严格契约下的拒绝行为 ───────────────────────────

const sitl = await startSitl(14601)
const { client } = sitl

console.log('\n── 解锁是异步的:抢跑的起飞必须被拒 ──')
{
  client.clear()
  const armAt = Date.now()
  client.send('COMMAND_LONG', commandLong({ command: MAV_CMD.COMPONENT_ARM_DISARM, param1: 1 }))
  // 故意不等待,立刻发起飞 —— 这就是上一版源码干的事
  client.send('COMMAND_LONG', commandLong({ command: MAV_CMD.NAV_TAKEOFF, param7: 10 }))

  const denied = await client.waitFor(
    'COMMAND_ACK',
    (m) => m.values.command === MAV_CMD.NAV_TAKEOFF,
    3000,
  )
  check(
    '解锁未完成时起飞被拒(COMMAND_DENIED)',
    denied?.values.result === 2,
    `result=${denied?.values.result ?? '无应答'}`,
  )

  const armed = await client.waitFor(
    'COMMAND_ACK',
    (m) => m.values.command === MAV_CMD.COMPONENT_ARM_DISARM,
    3000,
  )
  const delay = armed ? armed.at - armAt : -1
  check('解锁 ACK 是延迟回来的(preflight check)', armed?.values.result === 0 && delay >= 200, `${delay} ms`)
}

console.log('\n── 起飞到 10 m ──')
{
  client.send('COMMAND_LONG', commandLong({ command: MAV_CMD.NAV_TAKEOFF, param7: 10 }))
  const climbing = await client.waitFor(
    'HEARTBEAT',
    (m) => mainOf(m.values.custom_mode) === 4 && subOf(m.values.custom_mode) === 2,
    4000,
  )
  check('NAV_TAKEOFF → AUTO.TAKEOFF', Boolean(climbing), climbing ? '已进入 AUTO.TAKEOFF' : '没有切模式')

  const airborne = await client.waitFor(
    'GLOBAL_POSITION_INT',
    (m) => (m.values.relative_alt ?? 0) > 8000,
    20000,
  )
  check('爬升到目标高度', Boolean(airborne), airborne ? `${(airborne.values.relative_alt / 1000).toFixed(1)} m` : '未到达')
}

/** 发一帧位置 setpoint(目标在本地 20 m 外、10 m 高) */
function sendSetpoint() {
  client.send('SET_POSITION_TARGET_LOCAL_NED', {
    time_boot_ms: Date.now() & 0xffffffff,
    target_system: 1,
    target_component: 1,
    coordinate_frame: 1,
    type_mask: 0b0001111111111000,
    x: 20,
    y: 0,
    z: -10,
    vx: 0,
    vy: 0,
    vz: 0,
    afx: 0,
    afy: 0,
    afz: 0,
    yaw: 0,
    yaw_rate: 0,
  })
}

console.log('\n── OFFBOARD 的 setpoint 是流,不是一次性指令 ──')
{
  // ⚠️ 顺序:先起流再切模式。反过来的话,从切模式成功到第一帧 setpoint 到达
  // 之间有个空窗,而 COM_OF_LOSS_T 只有 1 s,心跳又只有 1 Hz —— 会直接丢掉 OFFBOARD。
  const stream = setInterval(sendSetpoint, 100)
  client.send('COMMAND_LONG', commandLong({ command: MAV_CMD.DO_SET_MODE, param1: 1, param2: px4Mode(6) }))
  const inOffboard = await client.waitFor('HEARTBEAT', (m) => mainOf(m.values.custom_mode) === 6, 5000)
  check('已切到 OFFBOARD', Boolean(inOffboard))

  // 故意断流:这就是"只发一次"的写法
  clearInterval(stream)
  const stoppedAt = Date.now()
  const lost = await client.waitFor(
    'STATUSTEXT',
    (m) => m.at >= stoppedAt && String(m.values.text ?? '').includes('OFFBOARD LOST'),
    5000,
  )
  check(
    `断流后判 offboard lost(${lost ? `${lost.at - stoppedAt} ms` : '未发生'})`,
    Boolean(lost),
  )

  const fellBack = await client.waitFor(
    'HEARTBEAT',
    (m) => m.at >= stoppedAt && mainOf(m.values.custom_mode) === 3,
    5000,
  )
  check('offboard lost → 退回 POSCTL(COM_OBL_RC_ACT)', Boolean(fellBack))
}

console.log('\n── 持续 setpoint 流能维持 OFFBOARD ──')
{
  client.clear()
  const preStream = setInterval(sendSetpoint, 100)
  client.send('COMMAND_LONG', commandLong({ command: MAV_CMD.DO_SET_MODE, param1: 1, param2: px4Mode(6) }))
  await client.waitFor('HEARTBEAT', (m) => mainOf(m.values.custom_mode) === 6, 5000)
  clearInterval(preStream)
  const streamStart = Date.now()

  const stream = setInterval(sendSetpoint, 100)

  await sleep(3200)
  clearInterval(stream)

  const lostDuringStream = client.inbox.some(
    (m) => m.name === 'STATUSTEXT' && String(m.values.text ?? '').includes('OFFBOARD LOST') && m.at > streamStart,
  )
  check('10 Hz setpoint 流 3 s 内不掉出 OFFBOARD', !lostDuringStream)

  const lastBeat = [...client.inbox].reverse().find((m) => m.name === 'HEARTBEAT')
  check(
    '流维持期间模式仍是 OFFBOARD',
    mainOf(lastBeat?.values.custom_mode) === 6,
    `main=${mainOf(lastBeat?.values.custom_mode)}`,
  )

  // 目标是本地 20 m 北(NED y = 20),看它有没有真的飞出去
  const moved = await client.waitFor('LOCAL_POSITION_NED', (m) => (m.values.y ?? 0) > 3, 4000)
  check('setpoint 生效(向北飞出 3 m 以上)', Boolean(moved), moved ? `NED y=${moved.values.y.toFixed(1)}` : '没动')
}

console.log('\n── MANUAL 是 RC 直通,无输入必须 failsafe ──')
{
  client.clear()
  client.send('COMMAND_LONG', commandLong({ command: MAV_CMD.DO_SET_MODE, param1: 1, param2: px4Mode(1) }))
  const failsafe = await client.waitFor(
    'STATUSTEXT',
    (m) => String(m.values.text ?? '').includes('NO RC INPUT'),
    4000,
  )
  check('切 MANUAL 且无 RC → failsafe', Boolean(failsafe))
  const backToPos = await client.waitFor('HEARTBEAT', (m) => mainOf(m.values.custom_mode) === 3, 4000)
  check('failsafe 后落回 POSCTL', Boolean(backToPos))
}

sitl.stop()

// ─────────────────────────── 老式航线上传握手 ───────────────────────────

console.log('\n── 老式 MISSION_REQUEST(浮点经纬度)──')
{
  const legacy = await startSitl(14602, ['--legacy-mission'])
  const c = legacy.client
  c.clear()
  c.send('MISSION_COUNT', { target_system: 1, target_component: 1, count: 1 })

  const request = await c.waitFor('MISSION_REQUEST', () => true, 4000)
  check('飞控发的是老式 MISSION_REQUEST(不是 _INT)', Boolean(request), `seq=${request?.values.seq}`)

  // 回浮点版本 MISSION_ITEM:经纬度是度,不是 1e7 定点
  c.send('MISSION_ITEM', {
    target_system: 1,
    target_component: 1,
    seq: 0,
    frame: MAV_FRAME.GLOBAL_RELATIVE_ALT,
    command: MAV_CMD.NAV_WAYPOINT,
    current: 1,
    autocontinue: 1,
    param1: 0,
    param2: 0,
    param3: 0,
    param4: Number.NaN,
    x: 39.9061,
    y: 116.3911,
    z: 15,
  })
  const ackOk = await c.waitFor('MISSION_ACK', (m) => m.values.type === 0, 5000)
  check('浮点航点被接受(MISSION_ACK=0)', Boolean(ackOk), `type=${ackOk?.values.type}`)
  legacy.stop()
}

console.log('\n── 上位机不应答航点 → 重试后拒收 ──')
{
  const silent = await startSitl(14603)
  const c = silent.client
  c.clear()
  const startedAt = Date.now()
  c.send('MISSION_COUNT', { target_system: 1, target_component: 1, count: 2 })
  // 什么都不回,等飞控自己放弃
  const rejected = await c.waitFor('MISSION_ACK', (m) => m.values.type === 1, 9000)
  const elapsed = rejected ? rejected.at - startedAt : -1
  check('超时后 MISSION_ACK=REJECTED(1)', Boolean(rejected), `${elapsed} ms`)
  const retried = c.inbox.filter((m) => m.name === 'MISSION_REQUEST_INT').length
  check('索要航点重试过(共 3 次)', retried === 3, `实际 ${retried} 次`)
  silent.stop()
}

// ─────────────────────────────── 汇总 ───────────────────────────────

const passed = results.filter((item) => item.ok).length
console.log(`\n${passed}/${results.length} 项通过`)
if (passed !== results.length) {
  console.log('有断言失败:要么飞控又变客气了,要么源码又退回"发一条就完事"的写法。')
  process.exitCode = 1
}
