#!/usr/bin/env node
/**
 * 图传中转（视频同传）：WebSocket 单向上行 + 扇出下行，零依赖。
 *
 * 为什么需要这一层：浏览器之间无法直接互联（没有 UDP、没有固定 IP、也没有信令服务器），
 * 而"另一台设备看机载画面"本质上只需要一根能推帧的管子。所以这里不转码、不解析画面，
 * 只把发布端（无人机页面）推来的 JPEG 帧原样扇出给所有观看端（手机 / 另一台电脑）：
 *
 *   无人机页面 --ws/wss--> relay --ws--> 手机观页、另一台电脑
 *
 * 三条关键设计（都是踩过的坑）：
 *   1. **缓存最后一帧**：观看端可能在飞机已经飞起来之后才打开链接，没有缓存就要等下一帧，
 *      弱网/低帧率下会看到一段黑屏。这里给新加入的观看端立刻补发最近的一帧与 OSD；
 *   2. **背压丢帧而不是排队**：`socket.write` 会把慢客户端的数据堆在内存里，几百帧之后就变成
 *      越来越大的延迟（画面"越来越慢"而不是"越来越卡"）。超过阈值直接丢这一帧，只计数；
 *   3. **角色由查询参数决定**：`?role=pub` 发布、`?role=view` 观看。同一条链路同时承载
 *      二进制帧与文本 OSD/统计，不需要第二个端口。
 *
 *   node video-link/relay.mjs                    # 0.0.0.0:8130
 *   node video-link/relay.mjs --port 9000
 *   node video-link/relay.mjs --host 127.0.0.1   # 只给本机调试
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** WebSocket 魔法字符串（RFC 6455）：算错就是浏览器报 "Incorrect hash received" */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 单个观看端允许积压的上限：超过就丢帧。约等于 640×360 q0.6 的 2~3 帧 */
const MAX_VIEWER_BACKLOG = 256 * 1024
/** 发布端积压上限：超过说明链路已经撑不住，丢帧比无限排队好（排队 = 延迟越滚越大） */
const MAX_PUBLISHER_BACKLOG = 512 * 1024

function parseArgs(argv) {
  const options = { port: 8130, host: '0.0.0.0', quiet: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]
    switch (arg) {
      case '--port':
        options.port = Number(value)
        index += 1
        break
      case '--host':
        options.host = value
        index += 1
        break
      case '--quiet':
        options.quiet = true
        break
      case '--help':
      case '-h':
        console.log(
          [
            '图传中转（视频同传）',
            '',
            '  --port <port>   HTTP + WebSocket 端口，默认 8130',
            '  --host <addr>   绑定地址，默认 0.0.0.0（局域网可访问）',
            '  --quiet         只打错误',
            '',
            '观看端：http://<本机局域网 IP>:8130/',
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
  if (!options.quiet) console.log('[link]', ...args)
}

// ─────────────────────────────── 状态 ───────────────────────────────

/** 发布端（无人机页面）。同一时刻只保留一个：新连接顶掉旧的，避免两个页面抢同一个画面 */
let publisher = null
/** 观看端 */
const viewers = new Set()
/** 观看端序号:信令路由用(每个观看端一个稳定 id,跨重连不复用) */
let viewerSeq = 0

/** 最近一帧与最近一份 OSD：新观看端加入时立刻补发，不用等下一帧 */
let latestFrame = null
let latestMeta = null
/** 统计用（每秒清零） */
const counters = { frames: 0, bytes: 0, dropped: 0, startedAt: Date.now() }
/** 上一秒的统计结果（/stats 与 hello 用） */
const last = { fps: 0, kbps: 0 }

// ─────────────────────── WebSocket 帧编解码 ───────────────────────

/** 组一个服务端 → 客户端的帧（服务端不掩码） */
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

/** 解客户端帧（客户端必须掩码）；可能一次收到多帧，也可能半帧 */
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

/** 文本消息（服务端 → 客户端） */
function sendText(socket, value) {
  if (!socket || socket.destroyed || !socket.writable) return false
  socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(value))))
  return true
}

/** 二进制帧（服务端 → 客户端）；积压超阈值就丢，返回是否发出 */
function sendFrame(socket, frame, limit) {
  if (!socket || socket.destroyed || !socket.writable) return false
  if (socket.writableLength > limit) return false
  socket.write(encodeFrame(0x2, frame))
  return true
}

// ─────────────────────────────── 广播 ───────────────────────────────

function broadcastFrame(frame) {
  for (const viewer of viewers) {
    if (sendFrame(viewer.socket, frame, MAX_VIEWER_BACKLOG)) {
      viewer.sentFrames += 1
    } else {
      viewer.dropped += 1
      counters.dropped += 1
    }
  }
}

function broadcastText(value) {
  for (const viewer of viewers) sendText(viewer.socket, value)
}

/** 局域网观看地址（发布端页面上要显示"用手机打开这个"） */
function watchUrls() {
  const port = options.port
  const urls = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      urls.push(`http://${item.address}:${port}/`)
    }
  }
  if (urls.length === 0) urls.push(`http://127.0.0.1:${port}/`)
  return urls
}

// ───────────────────────────── HTTP 侧 ─────────────────────────────

function readWatchPage() {
  try {
    return fs.readFileSync(path.join(HERE, 'watch.html'))
  } catch {
    return Buffer.from('<!doctype html><meta charset="utf-8"><h1>缺少 watch.html</h1>')
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://placeholder')
  if (url.pathname === '/stats') {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(
      JSON.stringify({
        publisher: publisher ? true : false,
        viewers: viewers.size,
        fps: last.fps,
        kbps: last.kbps,
        dropped: counters.dropped,
        watch: watchUrls(),
        uptimeSeconds: Math.round((Date.now() - counters.startedAt) / 1000),
      }),
    )
    return
  }
  if (url.pathname === '/' || url.pathname === '/watch' || url.pathname === '/index.html') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(readWatchPage())
    return
  }
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('ok\n')
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('图传中转：/ 观看页，/stats 状态，/health 探活\n')
})

// ─────────────────────────── WebSocket 侧 ───────────────────────────

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
  socket.setNoDelay(true)

  const url = new URL(request.url ?? '/', 'http://placeholder')
  const role = url.searchParams.get('role') === 'pub' ? 'pub' : 'view'
  let pending = Buffer.alloc(0)

  if (role === 'pub') {
    // 顶掉旧发布端：同一条链路只承认最新打开的那个页面
    if (publisher) {
      log('新的发布端接入，关闭旧的')
      publisher.socket.destroy()
    }
    publisher = { socket, frames: 0, bytes: 0 }
    log(`发布端接入（${request.socket.remoteAddress ?? '?'}）`)
    sendText(socket, { t: 'hello', role: 'pub', watch: watchUrls(), port: options.port })
    // 有观看端在等，立刻把最新一帧补给它（重连中的手机会看到静止画面而不是黑屏）
    if (latestFrame) sendFrame(socket, latestFrame, MAX_PUBLISHER_BACKLOG)
  } else {
    const id = `v${(viewerSeq += 1)}`
    const viewer = { id, socket, dropped: 0, sentFrames: 0 }
    socket.__viewerId = id
    viewers.add(viewer)
    log(`观看端接入（${id}），当前 ${viewers.size} 个`)
    sendText(socket, {
      t: 'hello',
      role: 'view',
      id,
      viewers: viewers.size,
      fps: last.fps,
      kbps: last.kbps,
    })
    if (latestFrame) sendFrame(socket, latestFrame, MAX_VIEWER_BACKLOG)
    if (latestMeta) sendText(socket, latestMeta)
  }

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
        socket.write(encodeFrame(0xa, frame.payload))
        continue
      }
      if (frame.opcode === 0x1) {
        // 文本：OSD（发布端）或 ping（观看端）
        let value = null
        try {
          value = JSON.parse(frame.payload.toString('utf8'))
        } catch {
          continue
        }
        if (!value || typeof value !== 'object') continue
        if (value.t === 'ping') {
          sendText(socket, { t: 'pong', id: value.id, client: value.client, server: Date.now() })
          continue
        }
        // WebRTC 信令:点对点路由,绝不缓存、绝不广播给其他观看端。
        // 观看端 → 发布端(补 from);发布端 → 指定观看端(按 to)。
        // 例外:rtc-available / rtc-unavailable 没有 to,是发给全部观看端的能力广播。
        if (typeof value.t === 'string' && value.t.startsWith('rtc-')) {
          if (role === 'pub') {
            if (value.to == null) {
              for (const viewer of viewers) sendText(viewer.socket, value)
            } else {
              const target = [...viewers].find((viewer) => viewer.id === value.to)
              if (target) sendText(target.socket, value)
            }
          } else if (publisher) {
            sendText(publisher.socket, { ...value, from: socket.__viewerId })
          }
          continue
        }
        if (role === 'pub') {
          latestMeta = value
          broadcastText(value)
        }
        continue
      }
      if (frame.opcode !== 0x2 && frame.opcode !== 0x0) continue
      // 二进制：只有发布端的上行算画面
      if (role !== 'pub' || !publisher) continue
      const payload = frame.payload
      publisher.frames += 1
      publisher.bytes += payload.length
      counters.frames += 1
      counters.bytes += payload.length
      latestFrame = payload
      broadcastFrame(payload)
    }
  })

  const cleanup = () => {
    if (role === 'pub' && publisher?.socket === socket) {
      publisher = null
      log('发布端断开')
      broadcastText({ t: 'signal', publisher: false })
      return
    }
    for (const viewer of viewers) {
      if (viewer.socket !== socket) continue
      viewers.delete(viewer)
      log(`观看端断开（${viewer.id}），剩余 ${viewers.size} 个`)
      // 通知发布端:它那边可能还留着这个观看端的 RTCPeerConnection,要靠这条消息清理
      if (publisher) sendText(publisher.socket, { t: 'rtc-bye', from: viewer.id })
      break
    }
  }
  socket.on('close', cleanup)
  socket.on('error', cleanup)
})

// 每秒一次统计：发布端要显示码率与在线人数，观看端要知道自己被丢了多少帧
const statsTimer = setInterval(() => {
  last.fps = counters.frames
  last.kbps = Math.round((counters.bytes * 8) / 1000)
  counters.frames = 0
  counters.bytes = 0

  if (publisher) {
    sendText(publisher.socket, {
      t: 'stats',
      fps: last.fps,
      kbps: last.kbps,
      viewers: viewers.size,
      dropped: counters.dropped,
      watch: watchUrls(),
    })
  }
  for (const viewer of viewers) {
    sendText(viewer.socket, {
      t: 'stats',
      viewers: viewers.size,
      dropped: viewer.dropped,
      fps: last.fps,
      kbps: last.kbps,
    })
  }
}, 1000)

server.listen(options.port, options.host, () => {
  log(`图传中转已启动：http://${options.host}:${options.port}/`)
  for (const url of watchUrls()) log(`观看地址：${url}`)
  log(`发布端连接：ws://<host>:${options.port}/ws?role=pub`)
})

const shutdown = () => {
  clearInterval(statsTimer)
  for (const viewer of viewers) viewer.socket.destroy()
  if (publisher) publisher.socket.destroy()
  server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
