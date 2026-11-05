#!/usr/bin/env node
/**
 * 端到端链路验证:假 SITL → 网桥 → MavlinkSource → DroneSim。
 *
 * 全在 Node 里跑,不开浏览器,也不需要装 PX4。验证的五件事:
 *   1. 帧解析(含 CRC/CRC_EXTRA)—— `crcErrors` 必须为 0;
 *   2. 坐标换算(经纬高 → 本地 ENU)—— 起飞点应落在原点附近;
 *   3. 指令回环(解锁/起飞/位置/航线/降落)—— 每一步都看 `DroneSim` 的真实状态变化;
 *   4. 模式映射(HEARTBEAT.custom_mode → 面板文案);
 *   5. 断链行为(关掉 SITL 后 `online()` 必须转 false)。
 *
 *   node mavlink/verify-loop.mjs            # 现代握手(MISSION_REQUEST_INT)
 *   node mavlink/verify-loop.mjs --legacy   # 老式握手(MISSION_REQUEST + 浮点 ITEM)
 *
 * 假飞控默认按 PX4 契约拒绝非法请求(见 fake-sitl.mjs),所以这个脚本能过
 * 意味着源码在真机时序下也成立,而不只是"假飞控好说话"。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createJiti } from 'jiti'

const here = dirname(fileURLToPath(import.meta.url))
const jiti = createJiti(import.meta.url)
const { DroneSim } = await jiti.import('../src/lib/drone-camera/drone-sim.ts')
const { MavlinkSource } = await jiti.import('../src/lib/drone-camera/drone-mavlink-source.ts')

// 老式握手用另一组端口,两种模式可以同时跑
const LEGACY = process.argv.includes('--legacy')
const UDP_PORT = LEGACY ? 14572 : 14571
const WS_PORT = LEGACY ? 8139 : 8138

const children = []
function shutdown() {
  for (const child of children) child.kill()
}
process.on('exit', shutdown)
process.on('SIGINT', () => {
  shutdown()
  process.exit(1)
})

function start(script, args) {
  const child = spawn(process.execPath, [join(here, script), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (text) => process.env.VERBOSE && process.stdout.write(`  [${script}] ${text}`))
  child.stderr.on('data', (text) => process.stdout.write(`  [${script}!] ${text}`))
  return child
}

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function waitFor(predicate, label, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve(true)
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, 80)
    void label
  })
}

// ─────────────────────────────── 启动链路 ───────────────────────────────

console.log('启动网桥与假 SITL…')
start('bridge.mjs', ['--listen', String(UDP_PORT), '--port', String(WS_PORT), '--quiet'])
await new Promise((resolve) => setTimeout(resolve, 300))
start('fake-sitl.mjs', [
  '--to',
  `127.0.0.1:${UDP_PORT}`,
  '--quiet',
  ...(LEGACY ? ['--legacy-mission'] : []),
])
await new Promise((resolve) => setTimeout(resolve, 600))

const sim = new DroneSim()
const events = []
const source = new MavlinkSource({
  url: `ws://127.0.0.1:${WS_PORT}`,
  onEvent: (level, text) => events.push(`${level}:${text}`),
})

source.attach(sim)
await source.connect()

// 模拟渲染循环:固定 60 Hz 推进内核
const loop = setInterval(() => sim.step(1 / 60), 1000 / 60)

// ─────────────────────────────── 1. 遥测接入 ───────────────────────────────
const linked = await waitFor(() => source.online() && sim.satellites >= 6, 'link')
record('链路建立 + 心跳', linked, linked ? `卫星 ${sim.satellites} 颗` : '超时')

const nearHome = await waitFor(
  () => Math.abs(sim.position.x) < 2 && Math.abs(sim.position.z) < 2,
  'home',
)
record(
  '坐标换算(经纬高 → 本地 ENU)',
  nearHome,
  `位置 (${sim.position.x.toFixed(2)}, ${sim.position.y.toFixed(2)}, ${sim.position.z.toFixed(2)})`,
)

const snapshot = sim.snapshot()
record(
  '模式映射(PX4 custom_mode)',
  snapshot.modeLabel === 'POSCTL',
  `modeLabel = ${snapshot.modeLabel}`,
)
record(
  '电池遥测直通',
  Math.abs(sim.batteryPercent - 98) < 5,
  `${sim.batteryPercent.toFixed(1)}% / ${sim.batteryVoltage.toFixed(1)}V`,
)

// ─────────────────────────────── 2. 起飞 ───────────────────────────────
sim.autoTakeOff()
const climbed = await waitFor(() => sim.position.y > 10, 'takeoff', 25000)
record('一键起飞(ARM + NAV_TAKEOFF)', climbed, `高度 ${sim.position.y.toFixed(1)} m`)

const hovered = await waitFor(() => sim.snapshot().modeLabel === 'AUTO.LOITER', 'loiter', 8000)
record('起飞后自动转悬停', hovered, `modeLabel = ${sim.snapshot().modeLabel}`)

// ─────────────────────────────── 3. 位置指令 ───────────────────────────────
// 渲染后端的 flyTo 在外部模式下会转到 dispatchExternal,这里直接走同一入口
sim.dispatchExternal({ type: 'goto', x: 18, y: 12, z: 6 })
const moved = await waitFor(
  () => Math.hypot(sim.position.x - 18, sim.position.z - 6) < 2.5 && Math.abs(sim.position.y - 12) < 2,
  'goto',
  25000,
)
record(
  'flyTo → SET_POSITION_TARGET_LOCAL_NED',
  moved,
  `位置 (${sim.position.x.toFixed(1)}, ${sim.position.y.toFixed(1)}, ${sim.position.z.toFixed(1)})`,
)
record(
  '飞控侧模式切到 OFFBOARD',
  sim.snapshot().modeLabel.startsWith('OFFBOARD'),
  `modeLabel = ${sim.snapshot().modeLabel}`,
)

// ─────────────────────────────── 4. 航线上传 ───────────────────────────────
sim.setMission([
  { x: 20, z: 0, altitude: 15 },
  { x: 20, z: 14, altitude: 15 },
])
const missionStarted = sim.startMission()
const progressed = await waitFor(
  () => sim.snapshot().modeLabel === 'AUTO.MISSION' && sim.missionIndex >= 0,
  'mission',
  25000,
)
record(
  LEGACY ? '老式航线上传(MISSION_COUNT → MISSION_REQUEST → 浮点 ITEM → ACK)' : '航线上传握手(MISSION_COUNT → ITEM_INT → ACK)',
  missionStarted && progressed,
  `已切 AUTO.MISSION,当前航点 ${sim.missionIndex + 1}`,
)

const reached = await waitFor(() => sim.position.z > 8, 'mission-fly', 45000)
record('航线执行(飞控自己飞)', reached, `位置 x=${sim.position.x.toFixed(1)}`)

// ─────────────────────────────── 5. 降落 ───────────────────────────────
sim.startLanding()
const landed = await waitFor(() => sim.position.y < 0.3 && !sim.snapshot().airborne, 'land', 25000)
record('自动降落', landed && climbed, `高度 ${sim.position.y.toFixed(2)} m`)

// ─────────────────────────────── 6. 协议卫生 ───────────────────────────────
const stats = source.parserStats()
record(
  'CRC 校验 0 失败',
  stats.frames > 100 && stats.crcErrors === 0,
  `帧 ${stats.frames} / CRC 失败 ${stats.crcErrors}`,
)

// ─────────────────────────────── 7. 断链 ───────────────────────────────
children[1].kill()
const dropped = await waitFor(() => !source.online(), 'timeout', 6000)
record('心跳超时判定掉线', dropped, `online() = ${source.online()}`)

clearInterval(loop)
await source.close()
shutdown()

const failed = results.filter((row) => !row.ok)
console.log('')
console.log(`${results.length - failed.length}/${results.length} 项通过`)
if (failed.length > 0) {
  console.log('事件日志(最后 12 条):')
  for (const line of events.slice(-12)) console.log(`  ${line}`)
  process.exitCode = 1
}
