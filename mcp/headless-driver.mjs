/**
 * 无头驱动 —— 把整个无人机 demo 变成"Blender 式"的可编程后端。
 *
 * 架构(与 Blender 同构):
 *   blender --background --python script.py     <->  node mcp/drone-cli.mjs run task.json
 *   blender 的 Python API                       <->  本驱动(page.evaluate 调库 API)
 *   MCP server(AI 客户端调用)                    <->  node mcp/drone-mcp-server.mjs
 *
 * 为什么用 Chromium 当"无头渲染器"而不是 headless-gl:
 *   渲染栈(three + WebGL + GLTF + canvas 2D)整条跑在浏览器里最保真,
 *   且本项目既有验证脚本(tmp-shots/verify-*.mjs)已证明这条路稳定。
 *   驱动按需拉起 vite dev server + chromium,命令串行执行,空闲自动回收,
 *   对调用方(CLI / MCP)表现得就像一个本地服务。
 *
 * 用法:
 *   import { runCommand } from './headless-driver.mjs'
 *   const r = await runCommand({ cmd: 'state' })
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACTS = path.join(ROOT, 'tmp-shots', 'mcp-out')
const CHROME_ARGS = ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
const PAGE_READY_TIMEOUT_MS = 90000
const DEFAULT_CMD_TIMEOUT_MS = 180000
const PANORAMA_CMD_TIMEOUT_MS = 300000

/** 找 chromium:环境变量优先,再按 ms-playwright 里最新构建号找(playwright 升级后自愈) */
function findChrome() {
  const envPath = process.env.DRONE_MCP_CHROME
  if (envPath && existsSync(envPath)) return envPath
  const base = path.join(
    process.env.LOCALAPPDATA ?? path.join(process.env.HOME ?? '', '.cache'),
    'ms-playwright',
  )
  if (!existsSync(base)) return null
  const builds = readdirSync(base)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse()
  for (const build of builds) {
    const candidates = [
      path.join(base, build, 'chrome-win64', 'chrome.exe'),
      path.join(base, build, 'Chrome.app', 'Contents', 'MacOS', 'Chromium'),
      path.join(base, build, 'chrome-linux', 'chrome'),
    ]
    for (const exe of candidates) if (existsSync(exe)) return exe
  }
  return null
}

/** 挑一个空闲端口(listen 0 让系统分配,拿到就关) */
function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** 杀进程树(Windows 上 vite 会带 esbuild 子进程,SIGTERM 杀不干净) */
function killTree(pid) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {})
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      /* 已经没了 */
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/** 把页面里的 data:/blob: 图片地址取回来落盘,返回 { file, bytes } */
async function saveImageFromPage(page, url, name) {
  const base64 = await page.evaluate(async (src) => {
    try {
      const res = await fetch(src)
      const blob = await res.blob()
      return await new Promise((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
        reader.onerror = () => resolve('')
        reader.readAsDataURL(blob)
      })
    } catch {
      return ''
    }
  }, url)
  if (!base64) return null
  mkdirSync(ARTIFACTS, { recursive: true })
  const file = path.join(ARTIFACTS, name)
  const buf = Buffer.from(base64, 'base64')
  writeFileSync(file, buf)
  return { file, bytes: buf.length }
}

export class HeadlessDrone {
  constructor(options = {}) {
    this.idleMs = options.idleMs ?? 600000
    this.viewport = options.viewport ?? { width: 1280, height: 800 }
    this.server = null
    this.serverPort = 0
    this.browser = null
    this.page = null
    this.pageErrors = []
    this.queue = Promise.resolve()
    this.idleTimer = null
    this.booting = null
  }

  // ───────────────────────────── 生命周期 ─────────────────────────────

  /** 确保 server + browser + page 就绪(并发调用只会启动一次) */
  async ensure() {
    if (this.page) return
    if (!this.booting) this.booting = this.boot().finally(() => (this.booting = null))
    await this.booting
  }

  async boot() {
    const { chromium } = await import('@playwright/test')
    const port = await pickPort()
    this.serverPort = port
    this.server = spawn(
      process.execPath,
      [path.join('node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--strictPort'],
      {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    )
    this.server.stderr?.on('data', (d) => process.stderr.write(`[vite] ${d}`))
    await this.waitServer(port)

    const executablePath = findChrome() ?? undefined
    this.browser = await chromium.launch({ executablePath, args: CHROME_ARGS })
    this.page = await this.browser.newPage({ viewport: this.viewport })
    this.page.on('pageerror', (err) => {
      this.pageErrors.push(String(err.message).slice(0, 300))
      if (this.pageErrors.length > 20) this.pageErrors.shift()
    })
    await this.page.goto(`http://127.0.0.1:${port}/three-demo?model=husky`)
    await this.page.waitForFunction(() => window.__droneDemo?.captureService, null, {
      timeout: PAGE_READY_TIMEOUT_MS,
    })
    await this.page.waitForTimeout(1200) // 等模型/装配稳定
  }

  async waitServer(port) {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/three-demo`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) return
      } catch {
        /* 还没起来 */
      }
      await sleep(500)
    }
    throw new Error(`vite dev server 60s 内未就绪(port ${port})`)
  }

  /** 关掉 browser + server(命令串行保证此刻没有命令在飞) */
  async teardown() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    try {
      await this.browser?.close()
    } catch {
      /* 已经没了 */
    }
    this.browser = null
    this.page = null
    if (this.server?.pid) killTree(this.server.pid)
    this.server = null
  }

  touchIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      void this.teardown()
    }, this.idleMs)
    this.idleTimer.unref?.()
  }

  // ───────────────────────────── 命令入口 ─────────────────────────────

  /** 执行一条命令;所有命令串行,超时按命令类型给 */
  async run(command) {
    const started = Date.now()
    const runIt = async () => {
      await this.ensure()
      this.touchIdle()
      const timeoutMs =
        typeof command.timeoutMs === 'number'
          ? command.timeoutMs
          : command.cmd === 'panorama'
            ? PANORAMA_CMD_TIMEOUT_MS
            : DEFAULT_CMD_TIMEOUT_MS
      try {
        const result = await withTimeout(this.dispatch(command), timeoutMs, `命令超时(${timeoutMs}ms)`)
        return { ok: true, cmd: command.cmd, ms: Date.now() - started, ...result }
      } catch (err) {
        return {
          ok: false,
          cmd: command.cmd,
          ms: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }
    const result = this.queue.then(runIt)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async dispatch(command) {
    switch (command.cmd) {
      case 'state':
        return this.cmdState()
      case 'arm':
        return this.cmdArm()
      case 'takeoff':
        return this.cmdTakeoff()
      case 'land':
        return this.cmdLand()
      case 'return_home':
        return this.cmdReturnHome()
      case 'spin_to':
        return this.cmdSpinTo(Number(command.heading))
      case 'camera_mode':
        return this.cmdCameraMode(String(command.mode))
      case 'capture_photo':
        return this.cmdCapturePhoto(command.pitch == null ? null : Number(command.pitch))
      case 'panorama':
        return this.cmdPanorama(String(command.mode ?? 'pano-360'), Number(command.shotIntervalMs ?? 0))
      case 'screenshot':
        return this.cmdScreenshot(command)
      case 'viewer_shot':
        return this.cmdViewerShot(command)
      case 'sessions':
        return this.cmdSessions()
      case 'session_export':
        return this.cmdSessionExport(String(command.id), String(command.format ?? 'json'))
      case 'session_photos':
        return this.cmdSessionPhotos(String(command.id), command.group == null ? null : String(command.group))
      case 'shutdown':
        await this.teardown()
        return { shutdown: true }
      default:
        throw new Error(`未知命令: ${command.cmd}`)
    }
  }

  // ───────────────────────────── 各命令实现 ─────────────────────────────

  async cmdState() {
    const page = this.page
    if (!page) throw new Error('页面未就绪')
    const s = await page.evaluate(() => {
      const d = window.__droneDemo
      const fly = d.droneFly
      const sim = fly.sim
      return {
        phase: fly.phase,
        airborne: fly.airborne,
        altitude: +fly.altitude.toFixed(2),
        position: [+sim.position.x.toFixed(2), +sim.position.y.toFixed(2), +sim.position.z.toFixed(2)],
        heading: +sim.heading.toFixed(1),
        gimbalPitch: sim.gimbalPitch,
        gimbalYaw: sim.gimbalYaw,
        batteryPercent: sim.batteryPercent,
        photoCount: sim.photoCount,
        cameraMode: fly.cameraMode,
        obstacles: sim.obstacles.length,
        spinTarget: sim.spinTarget,
        armsFolded: fly.armsFolded,
        legsDeployed: fly.legsDeployed,
        scenery: !!d.scenery,
        sessions: d.captureService.sessions.size,
      }
    })
    return { ...s, pageErrors: this.pageErrors.length, serverPort: this.serverPort }
  }

  /** 开机 + 展臂,等到 standby(不起飞) */
  async cmdArm() {
    const page = this.page
    if (!page) throw new Error('页面未就绪')
    await page.evaluate(() => {
      const fly = window.__droneDemo.droneFly
      fly.powerOn()
      fly.setArmsFolded(false)
    })
    await page.waitForFunction(() => window.__droneDemo.droneFly.phase === 'standby', null, { timeout: 60000 })
    return { phase: 'standby' }
  }

  /** 起飞(没开机先自动 arm),等到 flying 并悬停稳定 */
  async cmdTakeoff() {
    const page = this.page
    if (!page) throw new Error('页面未就绪')
    const phase = await page.evaluate(() => window.__droneDemo.droneFly.phase)
    if (phase !== 'flying') {
      if (phase !== 'standby') await this.cmdArm()
      await page.evaluate(() => window.__droneDemo.droneFly.takeOff())
      await page.waitForFunction(() => window.__droneDemo.droneFly.phase === 'flying', null, { timeout: 60000 })
    }
    await page.waitForTimeout(900) // 等增稳收敛
    return this.cmdState()
  }

  async cmdLand() {
    const page = this.page
    if (!page) throw new Error('页面未就绪')
    await page.evaluate(() => window.__droneDemo.droneFly.land())
    await page.waitForFunction(() => window.__droneDemo.droneFly.phase === 'standby', null, { timeout: 90000 })
    return { phase: 'standby' }
  }

  async cmdReturnHome() {
    const page = this.page
    if (!page) throw new Error('页面未就绪')
    await page.evaluate(() => window.__droneDemo.droneFly.returnHome())
    return { returnHome: true }
  }

  /** 把机身转到指定航向并等稳(全景拍摄的水平覆盖全靠它) */
  async cmdSpinTo(headingDeg) {
    if (!Number.isFinite(headingDeg)) throw new Error('heading 必须是数字')
    const page = this.page
    if (!page) throw new Error('页面未就绪')
    const reached = await page.evaluate(async (target) => {
      const fly = window.__droneDemo.droneFly
      fly.spinBodyTo(target)
      const gap = (a, b) => Math.abs(((a - b + 540) % 360) - 180)
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const h = fly.getBodyHeading()
        if (h !== null && gap(h, target) <= 0.5) return true
        await new Promise((r) => setTimeout(r, 16))
      }
      return false
    }, headingDeg)
    return { heading: headingDeg, reached }
  }

  async cmdCameraMode(mode) {
    if (!['orbit', 'follow', 'fpv'].includes(mode)) {
      throw new Error(`mode 只能是 orbit/follow/fpv,收到 ${mode}`)
    }
    const page = this.page
    if (!page) throw new Error('页面未就绪')
    await page.evaluate((m) => window.__droneDemo.droneFly.setCameraMode(m), mode)
    await page.waitForTimeout(350)
    return { cameraMode: mode }
  }

  /** 单拍一张(可选俯仰覆盖),落盘返回路径与元数据 */
  async cmdCapturePhoto(pitch) {
    const page = this.page
    if (!page) throw new Error('页面未就绪')
    const phase = await page.evaluate(() => window.__droneDemo.droneFly.phase)
    if (phase !== 'flying') await this.cmdTakeoff()
    const info = await page.evaluate(async (viewPitch) => {
      const d = window.__droneDemo
      const service = d.captureService
      const session =
        service.activeSession ?? service.createSession({ source: 'virtual-camera', name: 'mcp' })
      const image = await service.captureVirtualImage(session.id, {
        view: viewPitch == null ? null : { pitch: viewPitch },
      })
      if (!image) return null
      return {
        sessionId: session.id,
        imageUrl: image.imageUrl,
        width: image.width,
        height: image.height,
        panorama: image.metadata?.panorama ?? null,
        photoCount: d.droneFly.sim.photoCount,
      }
    }, pitch)
    if (!info?.imageUrl) throw new Error('拍照失败(取景后端没给出成片)')
    const saved = await saveImageFromPage(page, info.imageUrl, `photo-${stamp()}.png`)
    // url 可能是 data:(几 MB 的 base64),落盘后就不回传了,免得污染 stdout/MCP 通道
    const { imageUrl: _dropped, ...rest } = info
    return { ...rest, file: saved?.file ?? null, bytes: saved?.bytes ?? 0 }
  }

  /**
   * 全景拍摄(默认 360°):自动起飞 -> PanoramaCapture 扫描 -> 库内等距柱状拼接 -> 落盘。
   * 返回 stitched 文件路径与覆盖度(coverage < 0.9 一般意味着有层没拍全)。
   */
  async cmdPanorama(mode, shotIntervalMs) {
    if (!['pano-wide', 'pano-180', 'pano-360'].includes(mode)) {
      throw new Error(`mode 只能是 pano-wide/pano-180/pano-360,收到 ${mode}`)
    }
    const page = this.page
    if (!page) throw new Error('页面未就绪')
    await this.cmdTakeoff()
    const info = await page.evaluate(
      async ({ mode: m, interval }) => {
        const d = window.__droneDemo
        const service = d.captureService
        const panoMod = await import('/src/lib/drone-camera/drone-panorama.ts')
        const stitchMod = await import('/src/lib/drone-camera/drone-stitch.ts')
        const session =
          service.activeSession ?? service.createSession({ source: 'virtual-camera', name: 'mcp' })
        const pano = new panoMod.PanoramaCapture(service, {
          shotIntervalMs: interval,
          stitcher: stitchMod.createEquirectStitcher(),
        })
        const result = await pano.start(session.id, m)
        if (!result) return { error: '扫描器没返回结果' }
        const stitched = result.stitched ?? null
        return {
          group: result.group,
          mode: result.mode,
          total: result.total,
          captured: result.captured,
          cancelled: result.cancelled,
          error: result.error ?? null,
          stitched: stitched
            ? {
                url: stitched.url ?? null,
                width: stitched.width ?? null,
                height: stitched.height ?? null,
                coverage: stitched.coverage ?? null,
                name: stitched.name ?? null,
              }
            : null,
        }
      },
      { mode, interval: shotIntervalMs },
    )
    if (info.error) throw new Error(String(info.error))
    if (!info.stitched?.url) throw new Error('扫描完成但没有拼接产物(可能被取消或拼接器没注入)')
    const saved = await saveImageFromPage(page, String(info.stitched.url), `pano-${mode}-${stamp()}.png`)
    // url 是 data: 时会带来几 MB base64,落盘后剔除,只留摘要
    const { url: _dropped, ...stitched } = info.stitched
    return { ...info, stitched, file: saved?.file ?? null, bytes: saved?.bytes ?? 0 }
  }

  /** 当前画面截图(mode 参数可先切视角) */
  async cmdScreenshot(command) {
    const page = this.page
    if (!page) throw new Error('页面未就绪')
    if (command.mode) await this.cmdCameraMode(String(command.mode))
    const raw = typeof command.name === 'string' && command.name ? command.name : `shot-${stamp()}.png`
    const name = raw.endsWith('.png') ? raw : `${raw}.png`
    mkdirSync(ARTIFACTS, { recursive: true })
    const file = path.join(ARTIFACTS, name)
    await page.screenshot({ path: file })
    return { file, bytes: readFileSync(file).length }
  }

  /**
   * 用球面查看器看一张全景图(本地文件),按给定角度取景后截图。
   * 给 AI 的"验收环":拍完 -> 指定方位/仰角/视野看 -> 截图自查。
   * 单独 new 一个查看器实例(初始角度即取景角),看完即毁,不碰 demo 自己的那个。
   */
  async cmdViewerShot(command) {
    const page = this.page
    if (!page) throw new Error('页面未就绪')
    const file = String(command.file ?? '')
    if (!file || !existsSync(file)) throw new Error(`文件不存在: ${file}`)
    const base64 = readFileSync(file).toString('base64')
    const yaw = Number(command.yaw ?? 0)
    const pitch = Number(command.pitch ?? 0)
    const fov = Number(command.fov ?? 75)
    const view = await page.evaluate(
      async ({ b64, yaw: y, pitch: p, fov: f, name }) => {
        const mod = await import('/src/lib/drone-camera/drone-panorama-viewer.ts')
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
        const url = URL.createObjectURL(blob)
        const viewer = new mod.DronePanoramaViewer({
          initialYawDeg: y,
          initialPitchDeg: p,
          initialFovDeg: f,
          downloadable: false,
        })
        viewer.open(url, name)
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          const note = document.querySelector('.divp-note')
          if (note?.hasAttribute('hidden')) break
          await new Promise((r) => setTimeout(r, 100))
        }
        await new Promise((r) => setTimeout(r, 250)) // 等一帧上纹理
        // 先别关:截图要在查看器开着的时候拍(挂到 window 上,截图后由下一步销毁)
        window.__mcpViewer = { viewer, url }
        return viewer.view
      },
      { b64: base64, yaw, pitch, fov, name: path.basename(file) },
    )
    if (!view) throw new Error('查看器 8s 内没把图贴上球面')
    const raw = typeof command.name === 'string' && command.name ? command.name : `view-${stamp()}.png`
    const name = raw.endsWith('.png') ? raw : `${raw}.png`
    mkdirSync(ARTIFACTS, { recursive: true })
    const out = path.join(ARTIFACTS, name)
    await page.screenshot({ path: out })
    await page.evaluate(() => {
      const kept = window.__mcpViewer
      window.__mcpViewer = null
      kept?.viewer.destroy()
      if (kept?.url) URL.revokeObjectURL(kept.url)
    })
    return { file: out, bytes: readFileSync(out).length, view }
  }

  async cmdSessions() {
    const page = this.page
    if (!page) throw new Error('页面未就绪')
    const list = await page.evaluate(() => {
      const service = window.__droneDemo.captureService
      return [...service.sessions.values()].map((s) => ({
        id: s.id,
        name: s.options?.name ?? null,
        source: s.options?.source ?? null,
        status: s.status,
        images: s.images.length,
        createdAt: s.createdAt,
      }))
    })
    return { sessions: list }
  }

  async cmdSessionExport(id, format) {
    if (!['json', 'csv'].includes(format)) throw new Error('format 只能是 json/csv')
    const page = this.page
    if (!page) throw new Error('页面未就绪')
    const text = await page.evaluate(
      ({ id: sid, format: fmt }) => window.__droneDemo.captureService.exportSession(sid, fmt),
      { id, format },
    )
    if (!text) throw new Error(`导出失败(会话 ${id} 不存在?)`)
    mkdirSync(ARTIFACTS, { recursive: true })
    const file = path.join(ARTIFACTS, `session-${id}.${format}`)
    writeFileSync(file, text)
    return { file, bytes: Buffer.byteLength(text) }
  }

  /** 把某会话(可选某全景组)的全部照片落盘 */
  async cmdSessionPhotos(id, group) {
    const page = this.page
    if (!page) throw new Error('页面未就绪')
    const images = await page.evaluate(
      ({ id: sid, group: g }) => {
        const session = window.__droneDemo.captureService.sessions.get(sid)
        if (!session) return null
        return session.images
          .filter((i) => (g ? i.metadata?.panorama?.group === g : true))
          .map((i, index) => ({
            index,
            url: i.imageUrl,
            col: i.metadata?.panorama?.col ?? null,
            row: i.metadata?.panorama?.row ?? null,
            bodyYaw: i.metadata?.panorama?.bodyYaw ?? null,
            pitch: i.metadata?.panorama?.pitch ?? null,
          }))
      },
      { id, group },
    )
    if (!images) throw new Error(`会话 ${id} 不存在`)
    const files = []
    for (const img of images) {
      const saved = await saveImageFromPage(page, img.url, `session-${id}-${String(img.index).padStart(2, '0')}.png`)
      if (saved) files.push(saved.file)
    }
    return { count: files.length, files }
  }
}

/** 进程级单例:CLI 与 MCP server 共用同一个驱动实例 */
export const driver = new HeadlessDrone()

/** 供 CLI/MCP 调用的统一入口 */
export async function runCommand(command) {
  return driver.run(command)
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    void driver.teardown().finally(() => process.exit(0))
  })
}
