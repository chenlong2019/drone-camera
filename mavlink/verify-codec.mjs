#!/usr/bin/env node
/**
 * 编解码单元验证(不需要网络、不需要 SITL)。
 *
 * 覆盖的是"协议层最容易错、错了又最难看出来"的四类问题:
 *   1. 往返一致:encode → parse 回原值(含数组字段、char 数组、NaN 语义);
 *   2. 分片与粘包:一帧拆成 1 字节多次喂、多帧一次喂,结果必须一样;
 *   3. 重同步:前面塞垃圾字节,后面必须还能解出正确帧;
 *   4. 校验:改一个 payload 字节必须被判定为 CRC 错(lenient 模式仍解析但计数)。
 *
 *   node mavlink/verify-codec.mjs
 */
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url)
const { encodeMessage, MavlinkParser, crcAccumulate } = await jiti.import(
  '../src/lib/drone-camera/drone-mavlink.ts',
)
const { MESSAGE_DEFS, payloadLength, wireOrder, MAVLINK_MSG_ID } = await jiti.import(
  '../src/lib/drone-camera/drone-mavlink-defs.ts',
)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const close = (a, b, tolerance = 1e-4) => Math.abs(a - b) <= tolerance

// ─────────────────────────── 1. CRF 标准向量 ───────────────────────────
const vector = crcAccumulate(
  0xffff,
  new Uint8Array([...'123456789'].map((char) => char.charCodeAt(0))),
)
check('X25 校验标准向量 "123456789" → 0x6F91', vector === 0x6f91, `0x${vector.toString(16).toUpperCase()}`)

// ─────────────────────────── 2. payload 长度自洽 ───────────────────────────
let lengthOk = true
for (const [name, def] of Object.entries(MESSAGE_DEFS)) {
  const frame = encodeMessage(name, {}, {})
  // 帧长 = 1 + 9(v2 头)+ payload + 2(校验);payload 会被截尾零,所以只校验上界
  const maxPayload = payloadLength(def)
  if (frame.length > 1 + 9 + maxPayload + 2) {
    lengthOk = false
    console.log(`  超长:${name} ${frame.length} > ${1 + 9 + maxPayload + 2}`)
  }
}
check('所有消息编码后不超过定义长度', lengthOk, `${Object.keys(MESSAGE_DEFS).length} 条`)

// ─────────────────────────── 3. wire 顺序重排 ───────────────────────────
const heartbeatOrder = wireOrder(MESSAGE_DEFS.HEARTBEAT).map((field) => field.name)
check(
  'wire 顺序按类型宽度降序(custom_mode 在前)',
  heartbeatOrder[0] === 'custom_mode',
  heartbeatOrder.join(','),
)

// ─────────────────────────── 4. 往返一致 ───────────────────────────
{
  const sent = {
    time_boot_ms: 123456,
    roll: 0.123,
    pitch: -0.456,
    yaw: 2.5,
    rollspeed: 0.01,
    pitchspeed: -0.02,
    yawspeed: 0.03,
  }
  const frame = encodeMessage('ATTITUDE', sent, { sysId: 7, compId: 1, seq: 42 })
  let decoded = null
  const parser = new MavlinkParser({ crc: 'strict', onMessage: (message) => (decoded = message) })
  parser.push(frame)
  const values = decoded?.values ?? {}
  const ok =
    decoded?.name === 'ATTITUDE' &&
    decoded.sysId === 7 &&
    decoded.seq === 42 &&
    close(values.time_boot_ms, sent.time_boot_ms, 0) &&
    close(values.roll, sent.roll) &&
    close(values.pitch, sent.pitch) &&
    close(values.yaw, sent.yaw)
  check('ATTITUDE 往返一致', ok, decoded ? `yaw=${values.yaw}` : '未解出')
}

{
  // 数组 + 字符串 + 大整数:三种"边界类型"一起验证
  const frame = encodeMessage(
    'BATTERY_STATUS',
    {
      id: 0,
      battery_function: 2,
      type: 2,
      temperature: 305,
      voltages: [3800, 3801, 3799, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff],
      current_battery: 512,
      current_consumed: 100,
      energy_consumed: 200,
      battery_remaining: 87,
    },
    {},
  )
  let decoded = null
  new MavlinkParser({ crc: 'strict', onMessage: (m) => (decoded = m) }).push(frame)
  const v = decoded?.values ?? {}
  const cells = Array.isArray(v.voltages) ? v.voltages : []
  check(
    'BATTERY_STATUS 数组字段往返一致',
    cells.length === 10 && cells[0] === 3800 && cells[3] === 0xffff && v.battery_remaining === 87,
    `cells[0]=${cells[0]} remaining=${v.battery_remaining}`,
  )
}

{
  const frame = encodeMessage('STATUSTEXT', { severity: 4, text: 'Preflight: EKF ready' }, {})
  let decoded = null
  new MavlinkParser({ crc: 'strict', onMessage: (m) => (decoded = m) }).push(frame)
  check(
    'STATUSTEXT char[50] 往返一致',
    decoded?.values.text === 'Preflight: EKF ready',
    JSON.stringify(decoded?.values.text),
  )
}

{
  // NaN 是"该项无效"的协议语义,不能被编码成 0
  const frame = encodeMessage('COMMAND_LONG', { command: 22, param4: Number.NaN }, {})
  let decoded = null
  new MavlinkParser({ crc: 'strict', onMessage: (m) => (decoded = m) }).push(frame)
  check('NaN 语义保留(param4 仍为 NaN)', Number.isNaN(decoded?.values.param4), String(decoded?.values.param4))
}

// ─────────────────────────── 5. 分片与粘包 ───────────────────────────
{
  const frames = [
    encodeMessage('ATTITUDE', { yaw: 1.1 }, { seq: 1 }),
    encodeMessage('GLOBAL_POSITION_INT', { lat: 399060000, lon: 1163910000, alt: 50000 }, { seq: 2 }),
    encodeMessage('HEARTBEAT', { custom_mode: 3 << 16 }, { seq: 3 }),
  ]
  const names = []
  const byteParser = new MavlinkParser({ crc: 'strict', onMessage: (m) => names.push(m.name) })
  for (const frame of frames) {
    for (const byte of frame) byteParser.push(Uint8Array.of(byte))
  }
  check('逐字节喂入仍能拼出 3 帧', names.length === 3, names.join(','))

  const merged = []
  const bulkParser = new MavlinkParser({ crc: 'strict', onMessage: (m) => merged.push(m.name) })
  const total = frames.reduce((sum, frame) => sum + frame.length, 0)
  const all = new Uint8Array(total)
  let cursor = 0
  for (const frame of frames) {
    all.set(frame, cursor)
    cursor += frame.length
  }
  bulkParser.push(all)
  check('一次喂入 3 帧(粘包)全部解出', merged.length === 3, merged.join(','))
}

// ─────────────────────────── 6. 重同步 ───────────────────────────
{
  const frame = encodeMessage('VFR_HUD', { heading: 270, alt: 42 }, {})
  const dirty = new Uint8Array(frame.length + 4)
  dirty.set([0x00, 0x11, 0x22, 0x33], 0) // 前 4 字节是垃圾(不含假 magic)
  dirty.set(frame, 4)
  let decoded = null
  const parser = new MavlinkParser({ crc: 'strict', onMessage: (m) => (decoded = m) })
  parser.push(dirty)
  check(
    '垃圾字节后能重同步并解出正确帧',
    decoded?.name === 'VFR_HUD' && decoded.values.heading === 270,
    `heading=${decoded?.values.heading}`,
  )
}

{
  // 一帧被改坏 + 紧跟一帧正常:坏帧丢掉,后续帧必须还能解出(逐字节重同步的意义)
  const bad = Uint8Array.from(encodeMessage('ATTITUDE', { yaw: 1 }, {}))
  bad[12] = bad[12] ^ 0xff
  const good = encodeMessage('VFR_HUD', { heading: 90 }, {})
  const mixed = new Uint8Array(bad.length + good.length)
  mixed.set(bad, 0)
  mixed.set(good, bad.length)
  const names = []
  const parser = new MavlinkParser({ crc: 'strict', onMessage: (m) => names.push(m.name) })
  parser.push(mixed)
  check(
    '坏帧之后的好帧不被连带吞掉',
    names.length === 1 && names[0] === 'VFR_HUD' && parser.stats.crcErrors === 1,
    `解出 ${names.join(',') || '无'} / crcErrors=${parser.stats.crcErrors}`,
  )
}

// ─────────────────────────── 7. 校验必须拦得住 ───────────────────────────
{
  const frame = encodeMessage('ATTITUDE', { yaw: 0.5 }, {})
  const broken = Uint8Array.from(frame)
  broken[12] = broken[12] ^ 0xff // 篡改 payload 第一个字节
  let called = 0
  const parser = new MavlinkParser({ crc: 'strict', onMessage: () => (called += 1) })
  parser.push(broken)
  check('strict 模式丢弃篡改帧', called === 0 && parser.stats.crcErrors === 1, `crcErrors=${parser.stats.crcErrors}`)

  let lenientCalled = 0
  const lenient = new MavlinkParser({ crc: 'lenient', onMessage: () => (lenientCalled += 1) })
  lenient.push(broken)
  check(
    'lenient 模式仍解析但计数(错误可见)',
    lenientCalled === 1 && lenient.stats.crcErrors === 1,
    `frames=${lenient.stats.frames} crcErrors=${lenient.stats.crcErrors}`,
  )
}

// ─────────────────────────── 8. 未知消息不报错 ───────────────────────────
{
  // 手工造一个 msgid=999 的合法帧:未知消息没有 CRC_EXTRA,解析器应计入 unknownFrames 而非报错
  const payload = Uint8Array.of(1, 2, 3)
  const frame = new Uint8Array(1 + 9 + payload.length + 2)
  frame[0] = 0xfd
  frame[1] = payload.length
  frame[4] = 1
  frame[5] = 1
  frame[6] = 1
  frame[7] = 999 & 0xff
  frame[8] = (999 >> 8) & 0xff
  frame[9] = 0
  frame.set(payload, 10)
  const parser = new MavlinkParser({ crc: 'strict' })
  parser.push(frame)
  check('未知消息 ID 只计数不抛错', parser.stats.unknownFrames === 1, `unknown=${parser.stats.unknownFrames}`)
}

void MAVLINK_MSG_ID
const failed = results.filter((row) => !row.ok)
console.log('')
console.log(`${results.length - failed.length}/${results.length} 项通过`)
if (failed.length > 0) process.exitCode = 1
