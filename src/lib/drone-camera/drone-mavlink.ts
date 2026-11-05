/**
 * MAVLink 2 编解码器(零依赖,不碰 DOM、不碰 three)。
 *
 * 只做两件事:**字节流 ↔ 结构体**。不做连接、不做重连、不做状态机 ——
 * 那些在 `drone-mavlink-source.ts`。这样本模块可以直接在 Node、Worker、
 * 浏览器里跑,也能拿来解析飞行日志(tlog 就是 MAVLink 帧的裸拼)。
 *
 * 支持范围:
 * - MAVLink **2**(0xFD)完整支持:含 3 字节 msgid、可选签名(跳过)、payload 尾零截断;
 * - MAVLink **1**(0xFE)基本支持(UDP/TCP 上不动字节转义,串口链路的 0xFE 转义不支持);
 * - 未知消息 ID 一律跳过而不报错 —— 飞控会主动推送一大堆本库不关心的消息,
 *   把它们当成错误会让链路噪声淹没真实问题。
 *
 * 校验分两档(`crc`):
 * - `'strict'`:CRC 不对直接丢帧,适合对接真机时确认链路健康;
 * - `'lenient'`(默认):校验不过仍然解析,只累计 `crcErrors` 并按消息名记录。
 *   理由很实际 —— CRC_EXTRA 抄错的表现就是「帧都收到了但全被丢掉」,
 *   静默丢帧比宽容解析难查得多;宽容模式下数据照常流动,错误计数照样看得见。
 */
import {
  CRC_EXTRA,
  MAV_TYPE_SIZE,
  MAVLINK_MSG_ID,
  MESSAGE_DEFS,
  wireOrder,
  type MavFieldDef,
  type MavMessageName,
} from './drone-mavlink-defs'

export const MAVLINK_STX_V1 = 0xfe
export const MAVLINK_STX_V2 = 0xfd
/** v2 头长度(不含 magic) */
const HEADER_V2 = 9
/** v1 头长度(不含 magic) */
const HEADER_V1 = 5
/** v2 签名长度 */
const SIGNATURE_LENGTH = 13
/** MAVLINK_IFLAG_SIGNED */
const IFLAG_SIGNED = 0x01

/** 解码后的字段值:标量 / 数值数组 / 字符串(char 数组) */
export type MavValue = number | number[] | string

/** 解码后的消息 */
export interface DecodedMessage {
  name: MavMessageName
  msgId: number
  version: 1 | 2
  seq: number
  sysId: number
  compId: number
  /** 校验是否通过(宽容模式下仍会产出 crcOk=false 的消息) */
  crcOk: boolean
  /** 字段名 → 值(已按 wire 顺序还原成声明语义) */
  values: Record<string, MavValue>
}

/** 解析器统计:诊断链路问题的唯一手段 */
export interface MavlinkStats {
  /** 收到的字节数 */
  bytes: number
  /** 成功解出的帧数 */
  frames: number
  /** 校验失败的帧数(容忍模式下这些帧仍会交给 onMessage) */
  crcErrors: number
  /** 未知消息 ID 的帧数(正常现象,飞控会推很多本库不要的消息) */
  unknownFrames: number
  /** 因 magic 不匹配丢掉的字节数(重同步代价) */
  resyncBytes: number
}

export interface MavlinkParserOptions {
  /** 校验模式,缺省 'lenient' */
  crc?: 'strict' | 'lenient'
  /** 每解出一条已知消息回调一次 */
  onMessage?: (message: DecodedMessage) => void
  /** 校验失败回调(容忍模式下用来定位 CRC_EXTRA 抄错的消息) */
  onCrcError?: (message: DecodedMessage) => void
}

// ──────────────────────────────────────────────────────────────
// X25 / CRC-16-MCRF4XX —— 标准校验向量 "123456789" → 0x6F91
// ──────────────────────────────────────────────────────────────

const CRC_INIT = 0xffff

/** 累积 X25 校验(就地返回,避免小对象分配) */
export function crcAccumulate(crc: number, bytes: Uint8Array, start = 0, end = bytes.length): number {
  for (let index = start; index < end; index += 1) {
    let tmp = bytes[index]! ^ (crc & 0xff)
    tmp = (tmp ^ (tmp << 4)) & 0xff
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
  }
  return crc
}

// ──────────────────────────────────────────────────────────────
// 解码
// ──────────────────────────────────────────────────────────────

const decoder = new TextDecoder('utf-8')

/** 按 wire 顺序读一个字段 */
function readField(view: DataView, offset: number, field: MavFieldDef): { value: MavValue; next: number } {
  const count = field.len ?? 1
  const size = MAV_TYPE_SIZE[field.type]
  if (field.len && field.type === 'char') {
    // 尾零截断后字符串常常"没写满":有多少读多少,缺的按 NUL 处理
    const available = Math.max(0, Math.min(count, view.byteLength - offset))
    const raw = new Uint8Array(view.buffer, view.byteOffset + offset, available)
    const end = raw.indexOf(0)
    const text = decoder.decode(end === -1 ? raw : raw.subarray(0, end))
    return { value: text, next: offset + count }
  }
  if (field.len) {
    const values: number[] = []
    for (let index = 0; index < count; index += 1) {
      const at = offset + index * size
      values.push(at + size <= view.byteLength ? readScalar(view, at, field.type) : 0)
    }
    return { value: values, next: offset + count * size }
  }
  // 标量越界(帧被截断):按 0 处理,与接收端补零语义一致
  if (offset + size > view.byteLength) return { value: 0, next: offset + size }
  return { value: readScalar(view, offset, field.type), next: offset + size }
}

function readScalar(view: DataView, offset: number, type: MavFieldDef['type']): number {
  switch (type) {
    case 'uint8_t':
      return view.getUint8(offset)
    case 'int8_t':
      return view.getInt8(offset)
    case 'char':
      return view.getUint8(offset)
    case 'uint16_t':
      return view.getUint16(offset, true)
    case 'int16_t':
      return view.getInt16(offset, true)
    case 'uint32_t':
      return view.getUint32(offset, true)
    case 'int32_t':
      return view.getInt32(offset, true)
    case 'uint64_t':
      // 64 位整数在 JS 里只能近似;本库用到的 64 位字段都是时间戳,精度足够
      return Number(view.getBigUint64(offset, true))
    case 'int64_t':
      return Number(view.getBigInt64(offset, true))
    case 'float':
      return view.getFloat32(offset, true)
    case 'double':
      return view.getFloat64(offset, true)
    default:
      return 0
  }
}

/** 把 payload 按定义解成字段表 */
export function decodePayload(name: MavMessageName, payload: Uint8Array): Record<string, MavValue> {
  const def = MESSAGE_DEFS[name]
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const values: Record<string, MavValue> = {}
  let offset = 0
  for (const field of wireOrder(def)) {
    const result = readField(view, offset, field)
    values[field.name] = result.value
    offset = result.next
  }
  return values
}

/**
 * 流式解析器 —— 一个实例对应一条链路。
 *
 * 内部维护滚动缓冲区:TCP / WebSocket 会把一帧切成任意片段,也可能把几帧粘在一起,
 * 所以必须能跨 `push()` 调用拼帧。magic 对不上时逐字节前移重同步(丢掉的字节计入
 * `resyncBytes`,链路噪声大时这个数会明显上涨)。
 */
export class MavlinkParser {
  readonly stats: MavlinkStats = {
    bytes: 0,
    frames: 0,
    crcErrors: 0,
    unknownFrames: 0,
    resyncBytes: 0,
  }

  private buffer = new Uint8Array(0)
  private readonly mode: 'strict' | 'lenient'
  private readonly onMessage?: (message: DecodedMessage) => void
  private readonly onCrcError?: (message: DecodedMessage) => void

  constructor(options: MavlinkParserOptions = {}) {
    this.mode = options.crc ?? 'lenient'
    this.onMessage = options.onMessage
    this.onCrcError = options.onCrcError
  }

  /** 喂入任意长度的字节片段,内部可能一次性解出 0~N 帧 */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.stats.bytes += chunk.length
    this.append(chunk)
    this.drain()
  }

  /** 清空缓冲区(重连时用) */
  reset(): void {
    this.buffer = new Uint8Array(0)
  }

  private append(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length)
    merged.set(this.buffer, 0)
    merged.set(chunk, this.buffer.length)
    this.buffer = merged
  }

  private drain(): void {
    let cursor = 0
    while (cursor < this.buffer.length) {
      const magic = this.buffer[cursor]!
      if (magic !== MAVLINK_STX_V1 && magic !== MAVLINK_STX_V2) {
        cursor += 1
        this.stats.resyncBytes += 1
        continue
      }
      const version: 1 | 2 = magic === MAVLINK_STX_V2 ? 2 : 1
      const headerLength = version === 2 ? HEADER_V2 : HEADER_V1
      if (cursor + 1 + headerLength > this.buffer.length) break // 头还没收全
      const payloadLength = this.buffer[cursor + 1]!
      const incompatFlags = version === 2 ? this.buffer[cursor + 2]! : 0
      const signed = version === 2 && (incompatFlags & IFLAG_SIGNED) !== 0
      const tailLength = 2 + (signed ? SIGNATURE_LENGTH : 0)
      const total = 1 + headerLength + payloadLength + tailLength
      if (cursor + total > this.buffer.length) break // 帧还没收全

      const accepted = this.consume(cursor, version, headerLength, payloadLength, signed)
      if (accepted) {
        cursor += total
      } else {
        // 校验没过:整帧不可信,连长度字节都可能是坏的 —— 只前移 1 字节重新找帧头,
        // 这样"一帧坏掉"不会连带吞掉后面几十帧。代价是可能扫过几个假 magic,
        // 但它们同样会被 CRC 拒掉,链路会自己收敛。
        cursor += 1
        this.stats.resyncBytes += 1
      }
    }
    if (cursor > 0) this.buffer = this.buffer.subarray(cursor)
  }

  /** 消费一帧;返回 false 表示这一帧不可信(调用方应逐字节重同步) */
  private consume(
    start: number,
    version: 1 | 2,
    headerLength: number,
    payloadLength: number,
    signed: boolean,
  ): boolean {
    const buffer = this.buffer
    // v2 头在 magic 之后是 9 字节:len(1) incompat(1) compat(1) seq(1) sysid(1) compid(1) msgid(3)
    // 所以 msgid 落在 start+7..start+9,payload 从 start+10 开始
    const msgId =
      version === 2
        ? buffer[start + 7]! | (buffer[start + 8]! << 8) | (buffer[start + 9]! << 16)
        : buffer[start + 5]!
    const seq = version === 2 ? buffer[start + 4]! : buffer[start + 2]!
    const sysId = version === 2 ? buffer[start + 5]! : buffer[start + 3]!
    const compId = version === 2 ? buffer[start + 6]! : buffer[start + 4]!
    const payloadStart = start + 1 + headerLength
    const payload = buffer.subarray(payloadStart, payloadStart + payloadLength)
    const checksumOffset = payloadStart + payloadLength

    const name = messageNameOf(msgId)
    // 未知消息:没有 CRC_EXTRA 算不出校验,但头部长度是可信的,整帧跳过即可。
    // 飞控会主动推大量本库不关心的消息,这是常态,不是错误。
    if (!name) {
      this.stats.unknownFrames += 1
      return true
    }

    const received = buffer[checksumOffset]! | (buffer[checksumOffset + 1]! << 8)
    let crc = crcAccumulate(CRC_INIT, buffer, start + 1, checksumOffset)
    crc = crcAccumulate(crc, Uint8Array.of(CRC_EXTRA[name]))
    const crcOk = crc === received
    if (!crcOk) this.stats.crcErrors += 1
    if (!crcOk && this.mode === 'strict') return false

    this.stats.frames += 1
    const message: DecodedMessage = {
      name,
      msgId,
      version,
      seq,
      sysId,
      compId,
      crcOk,
      values: decodePayload(name, payload),
    }
    if (!crcOk) this.onCrcError?.(message)
    this.onMessage?.(message)
    void signed
    return true
  }
}

/** msgid → 消息名(反向表,构造时建一次) */
const NAME_BY_ID = new Map<number, MavMessageName>(
  (Object.keys(MAVLINK_MSG_ID) as MavMessageName[]).map((name) => [MAVLINK_MSG_ID[name], name]),
)

function messageNameOf(msgId: number): MavMessageName | null {
  return NAME_BY_ID.get(msgId) ?? null
}

// ──────────────────────────────────────────────────────────────
// 编码
// ──────────────────────────────────────────────────────────────

let sequence = 0

/** 下一帧的序号(0~255 循环) */
export function nextSequence(): number {
  sequence = (sequence + 1) & 0xff
  return sequence
}

export interface EncodeOptions {
  sysId?: number
  compId?: number
  /** 不传则自动递增 */
  seq?: number
  /** false 时发 MAVLink 1(少数老飞控);缺省 v2 */
  version?: 1 | 2
}

function writeScalar(view: DataView, offset: number, type: MavFieldDef['type'], value: number): void {
  switch (type) {
    case 'uint8_t':
    case 'char':
      view.setUint8(offset, value & 0xff)
      break
    case 'int8_t':
      view.setInt8(offset, value)
      break
    case 'uint16_t':
      view.setUint16(offset, value & 0xffff, true)
      break
    case 'int16_t':
      view.setInt16(offset, value, true)
      break
    case 'uint32_t':
      view.setUint32(offset, value >>> 0, true)
      break
    case 'int32_t':
      view.setInt32(offset, value, true)
      break
    case 'uint64_t':
      view.setBigUint64(offset, BigInt(Math.max(0, Math.trunc(value))), true)
      break
    case 'int64_t':
      view.setBigInt64(offset, BigInt(Math.trunc(value)), true)
      break
    case 'float':
      view.setFloat32(offset, value, true)
      break
    case 'double':
      view.setFloat64(offset, value, true)
      break
    default:
      break
  }
}

/**
 * 编一帧 MAVLink。
 *
 * 未提供的字段写 0(char 数组写 NUL),`NaN` 会被原样写成 IEEE NaN —— 部分消息
 * (如 MOUNT_ORIENTATION)用 NaN 表示"该值无效",这个语义要保留。
 */
export function encodeMessage(
  name: MavMessageName,
  values: Record<string, number | string | number[]> = {},
  options: EncodeOptions = {},
): Uint8Array {
  const version = options.version ?? 2
  const sysId = options.sysId ?? 255
  const compId = options.compId ?? 190
  const seq = options.seq ?? nextSequence()
  const def = MESSAGE_DEFS[name]
  const fields = wireOrder(def)
  const fullLength = fields.reduce((sum, field) => sum + MAV_TYPE_SIZE[field.type] * (field.len ?? 1), 0)
  const payload = new Uint8Array(fullLength)
  const view = new DataView(payload.buffer)

  let offset = 0
  for (const field of fields) {
    const raw = values[field.name]
    const size = MAV_TYPE_SIZE[field.type]
    if (field.len) {
      if (field.type === 'char') {
        const text = typeof raw === 'string' ? raw : ''
        for (let index = 0; index < field.len; index += 1) {
          payload[offset + index] = text.charCodeAt(index) || 0
        }
      } else {
        const list = Array.isArray(raw) ? raw : []
        for (let index = 0; index < field.len; index += 1) {
          writeScalar(view, offset + index * size, field.type, list[index] ?? 0)
        }
      }
      offset += size * field.len
      continue
    }
    writeScalar(view, offset, field.type, typeof raw === 'number' ? raw : 0)
    offset += size
  }

  // MAVLink 2 允许把 payload 末尾的 0 截掉,接收端自行补零(至少留 1 字节)
  let payloadLength = fullLength
  if (version === 2) {
    while (payloadLength > 1 && payload[payloadLength - 1] === 0) payloadLength -= 1
  } else {
    payloadLength = fullLength
  }

  const headerLength = version === 2 ? HEADER_V2 : HEADER_V1
  const frame = new Uint8Array(1 + headerLength + payloadLength + 2)
  const frameView = new DataView(frame.buffer)
  let cursor = 0
  frame[cursor++] = version === 2 ? MAVLINK_STX_V2 : MAVLINK_STX_V1
  frame[cursor++] = payloadLength
  if (version === 2) {
    frame[cursor++] = 0 // incompat_flags:不签名
    frame[cursor++] = 0 // compat_flags
  }
  frame[cursor++] = seq
  frame[cursor++] = sysId
  frame[cursor++] = compId
  const msgId = MAVLINK_MSG_ID[name]
  if (version === 2) {
    frame[cursor++] = msgId & 0xff
    frame[cursor++] = (msgId >> 8) & 0xff
    frame[cursor++] = (msgId >> 16) & 0xff
  } else {
    frame[cursor++] = msgId & 0xff
  }
  frame.set(payload.subarray(0, payloadLength), cursor)
  cursor += payloadLength

  let crc = crcAccumulate(CRC_INIT, frame, 1, cursor)
  crc = crcAccumulate(crc, Uint8Array.of(CRC_EXTRA[name]))
  frameView.setUint16(cursor, crc, true)
  return frame
}
