/**
 * CRC_EXTRA 计算与交叉校验 —— MAVLink 协议里最阴的坑。
 *
 * 每帧尾部除了 X25 校验和,还要把「消息定义的 CRC_EXTRA」混进种子,于是同名消息
 * 只要字段定义不同就天然不兼容。CRC_EXTRA 不是随便定的常数,是从 XML 字段定义
 * 按规范算出来的(mavgen 的 message_checksum):
 *
 *   crc = x25crc(0xffff, "消息名 ")          // 注意:是消息名,不是 msgid
 *   for field in wire 顺序的基础字段:        // wire 顺序 = 按类型宽度降序,非声明顺序
 *     crc.accumulate(类型名 + " ")           // 数组只取基础类型,如 "char"
 *     crc.accumulate(字段名 + " ")
 *     if 数组: crc.accumulate_byte(长度)
 *   crc_extra = (crc & 0xFF) ^ (crc >> 8)
 *
 * 两个最容易记反的点:① 开头累积的是消息名;② 遍历的是重排后的 wire 顺序。
 * msgid 只用于帧校验(X25 种子),不参与 CRC_EXTRA。
 *
 * 本脚本用「解码器里那张字段定义表」重算一遍,与硬编码的 CRC_EXTRA 表逐条比对。
 * 两边一致说明定义没抄错;不一致就一定有一边是错的,必须先修再用 ——
 * 否则线上表现为「帧收到了但全被丢」，最难查。
 *
 *   node mavlink/verify-crc-extra.mjs
 */
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url)
const defs = await jiti.import('../src/lib/drone-camera/drone-mavlink-defs.ts')
const { MESSAGE_DEFS, CRC_EXTRA, MAVLINK_MSG_ID, wireOrder } = defs

const X25_INIT = 0xffff

function x25Accumulate(crc, bytes) {
  for (const byte of bytes) {
    let tmp = byte ^ (crc & 0xff)
    tmp = (tmp ^ (tmp << 4)) & 0xff
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
  }
  return crc
}

const ascii = (text) => Array.from(text, (char) => char.charCodeAt(0))

function computeCrcExtra(name, def) {
  let crc = x25Accumulate(X25_INIT, ascii(`${name} `))
  // 只遍历「wire 顺序里的基础字段」:扩展字段既不参与 CRC_EXTRA,也永远排在末尾
  for (const field of wireOrder(def)) {
    if (field.ext) continue
    crc = x25Accumulate(crc, ascii(`${field.type} `))
    crc = x25Accumulate(crc, ascii(`${field.name} `))
    if (field.len) crc = x25Accumulate(crc, [field.len])
  }
  return ((crc & 0xff) ^ (crc >> 8)) & 0xff
}

const pad = (value, width) => String(value).padEnd(width)
const rows = []
let failed = 0

for (const [name, def] of Object.entries(MESSAGE_DEFS)) {
  const msgid = MAVLINK_MSG_ID[name]
  const computed = computeCrcExtra(name, def)
  const expected = CRC_EXTRA[name]
  const ok = computed === expected
  if (!ok) failed += 1
  rows.push({ name, msgid, expected, computed, ok })
}

console.log(`${pad('message', 32)}${pad('id', 6)}${pad('table', 7)}${pad('computed', 10)}result`)
console.log('-'.repeat(62))
for (const row of rows) {
  console.log(
    `${pad(row.name, 32)}${pad(row.msgid, 6)}${pad(row.expected, 7)}${pad(row.computed, 10)}${
      row.ok ? 'OK' : 'MISMATCH'
    }`,
  )
}
console.log('-'.repeat(62))
console.log(`${rows.length - failed}/${rows.length} 条定义与硬编码表一致`)
if (failed > 0) {
  console.log('存在不一致：字段定义或硬编码表有一边写错了，解码会静默丢帧。')
  process.exitCode = 1
}
