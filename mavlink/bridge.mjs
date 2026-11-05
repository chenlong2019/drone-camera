#!/usr/bin/env node
/**
 * MAVLink 网桥:UDP ⇄ WebSocket。零依赖,只用 Node 内置模块。
 *
 * 为什么必须有这一层:浏览器没有 UDP socket,PX4 / ArduPilot SITL 只吐 UDP。
 * 网桥把 UDP 数据报原样搬进 WebSocket 二进制帧(不做任何解析/改写),于是
 * 「协议解析」这件事留在浏览器侧的 `MavlinkParser` 里,网桥永远不需要跟着
 * MAVLink 版本升级 —— 它只是根管子。
 *
 *   node mavlink/bridge.mjs                       # 监听 14550,UDP 回发到学习到的对端
 *   node mavlink/bridge.mjs --listen 14551 --port 8118
 *   node mavlink/bridge.mjs --target 127.0.0.1:14540   # 固定回发目标(连真 SITL 时用)
 *
 * 对端学习:第一个进来的 UDP 数据报决定了「往哪回」。SITL 通常从 14540/14550 发过来,
 * 回包原路返回即可;如果 SITL 只收不发(纯监听),就用 --target 显式指定。
 */
import { createHash } from 'node:crypto'
import dgram from 'node:dgram'
import http from 'node:http'

/**
 * WebSocket 魔法字符串(RFC 6455)。
 * 校验方式:key `dGhlIHNhbXBsZSBub25jZQ==` 必须算出 `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`,
 * 对不上就是这里抄错了 —— 浏览器会直接报 "Incorrect hash received"。
 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function parseArgs(argv) {
  const options = { listen: 14550, port: 8118, host: '127.0.0.1', target: null, quiet: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]
    switch (arg) {
      case '--listen':
        options.listen = Number(value)
        index += 1
        break
      case '--port':
        options.port = Number(value)
        index += 1
        break
      case '--host':
        options.host = value
        index += 1
        break
      case '--target': {
        const [host, port] = String(value).split(':')
        options.target = { host, port: Number(port) }
        index += 1
        break
      }
      case '--quiet':
        options.quiet = true
        break
      case '--help':
      case '-h':
        console.log(
          [
            'MAVLink 网桥(UDP → WebSocket)',
            '',
            '  --listen <port>   UDP 监听端口,默认 14550',
            '  --port <port>     WebSocket 端口,默认 8118',
            '  --host <addr>     WebSocket 绑定地址,默认 127.0.0.1',
            '  --target h:p      固定 UDP 回发目标(缺省用首个数据报的对端)',
            '  --quiet           只打错误',
          ].join('\n'),
        )
        process.exit(0)
        break
      default:
        break
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const log = (...args) => {
  if (!options.quiet) console.log('[bridge]', ...args)
}

// ─────────────────────────────── UDP 侧 ───────────────────────────────

const udp = dgram.createSocket('udp4')
/** 学习到的对端:首个发来数据的地址 */
let peer = options.target ? { ...options.target } : null

udp.on('error', (error) => console.error('[bridge] UDP 错误:', error.message))

udp.on('message', (message, remote) => {
  if (!peer) {
    peer = { host: remote.address, port: remote.port }
    log(`UDP 对端已锁定:${peer.host}:${peer.port}`)
  }
  broadcast(message)
  counters.udpIn += 1
  counters.udpBytes += message.length
})

udp.bind(options.listen, '0.0.0.0', () => {
  log(`UDP 监听 0.0.0.0:${options.listen}`)
})

// ─────────────────────────────── WebSocket 侧 ───────────────────────────────

const clients = new Set()
const counters = { udpIn: 0, udpBytes: 0, wsIn: 0, wsBytes: 0 }

/** 组一个服务端 → 客户端的帧(服务端不掩码) */
function encodeFrame(opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

function broadcast(payload) {
  if (clients.size === 0) return
  const frame = encodeFrame(0x2, payload)
  for (const socket of clients) {
    if (!socket.destroyed && socket.writable) socket.write(frame)
  }
}

/**
 * 解客户端帧(客户端必须掩码)。
 * 返回 { frames: Buffer[], rest: Buffer }:可能一次收到多帧,也可能半帧。
 */
function decodeClientFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (cursor + 2 > buffer.length) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    const maskKey = masked ? buffer.subarray(cursor, cursor + 4) : null
    if (masked) cursor += 4
    if (cursor + length > buffer.length) break
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
    if (maskKey) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= maskKey[index % 4]
      }
    }
    frames.push({ opcode, payload })
    offset = cursor + length
  }
  return { frames, rest: buffer.subarray(offset) }
}

const server = http.createServer((request, response) => {
  // 普通 HTTP 请求:给一行状态,方便用浏览器 / curl 探活
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  const status = [
    'MAVLink 网桥运行中',
    `UDP 监听: 0.0.0.0:${options.listen}`,
    `对端:     ${peer ? `${peer.host}:${peer.port}` : '尚未收到数据'}`,
    `WS 客户端: ${clients.size}`,
    `统计:     udp ${counters.udpIn} 包 / ws 上行 ${counters.wsIn} 包`,
  ].join('\n')
  response.end(`${status}\n`)
})

server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return
  }
  const accept = createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64')
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  )

  clients.add(socket)
  let pending = Buffer.alloc(0)
  log(`WebSocket 客户端接入,当前 ${clients.size} 个`)

  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    const { frames, rest } = decodeClientFrames(pending)
    pending = rest
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        socket.end()
        continue
      }
      if (frame.opcode === 0x9) {
        // ping → pong
        socket.write(encodeFrame(0xa, frame.payload))
        continue
      }
      if (frame.opcode !== 0x2 && frame.opcode !== 0x0) continue
      // 浏览器发来的 MAVLink:原样塞回 UDP
      counters.wsIn += 1
      counters.wsBytes += frame.payload.length
      if (peer) {
        udp.send(frame.payload, peer.port, peer.host)
      }
    }
  })

  const cleanup = () => {
    if (!clients.delete(socket)) return
    log(`WebSocket 客户端断开,剩余 ${clients.size} 个`)
  }
  socket.on('close', cleanup)
  socket.on('error', cleanup)
})

server.listen(options.port, options.host, () => {
  log(`WebSocket 监听 ws://${options.host}:${options.port}`)
  log(`把浏览器的 source 地址指向 ws://${options.host}:${options.port}`)
})

const shutdown = () => {
  log('正在关闭…')
  for (const socket of clients) socket.destroy()
  server.close()
  udp.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
