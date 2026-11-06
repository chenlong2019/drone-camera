import { HeadlessDrone } from '../mcp/headless-driver.mjs'
import { SCENE_PATH } from './task.mjs'

/** A private simulation session per Agent execution, independent of MCP's manual
 * drone session. No MAVLink URL, external-device transport, or arbitrary JS tool.
 */
export class SimulationTools {
  constructor() { this.driver = new HeadlessDrone({ pagePath: SCENE_PATH, viewport: { width: 960, height: 720 } }) }
  async prepare() {
    await this.driver.ensure()
    await this.assertInternal()
    const result = await this.driver.run({ cmd: 'takeoff' })
    if (!result.ok) throw new Error(result.error)
  }
  async assertInternal() {
    const internal = await this.driver.page.evaluate(() => !window.__droneDemo.droneFly.sim.external)
    if (!internal) throw new Error('Capture Agent supports internal simulation only')
  }
  async navigate(shot) {
    await this.assertInternal()
    const page = this.driver.page
    await page.evaluate((s) => {
      const fly = window.__droneDemo.droneFly
      if (!fly.airborne) throw new Error('Aircraft is not airborne')
      fly.stopMission('Agent selects next pending capture point')
      fly.spinBodyTo(null)
      fly.setMissionConfig({ autoSpeed: 6, headingMode: 'auto', pathMode: 'straight', finishAction: 'hover', loop: false })
      if (!fly.setMission([{ x: s.positionEnu[0], z: -s.positionEnu[1], altitude: s.positionEnu[2], speed: 6, hoverSeconds: 0, gimbalPitch: s.pitch, action: 'none' }])) {
        throw new Error('Mission rejected')
      }
      if (!fly.startMission()) throw new Error('Mission could not start')
    }, shot)
    await page.waitForFunction((s) => {
      const sim = window.__droneDemo.droneFly.sim
      return sim.phase === 'flying' && sim.missionStatus === 'idle' &&
        Math.hypot(sim.position.x - s.positionEnu[0], -sim.position.z - s.positionEnu[1], sim.position.y - s.positionEnu[2]) <= 0.6
    }, shot, { timeout: 60000 })
    const spin = await this.driver.run({ cmd: 'spin_to', heading: shot.heading })
    if (!spin.ok) throw new Error(spin.error)
    await page.evaluate((pitch) => window.__droneDemo.droneFly.setGimbalPitch(pitch), shot.pitch)
    await page.waitForFunction((s) => {
      const sim = window.__droneDemo.droneFly.sim
      return Math.abs(sim.gimbalPitch - s.pitch) < 0.5 && Math.hypot(sim.velocity.x, sim.velocity.y, sim.velocity.z) < 0.2
    }, shot, { timeout: 10000 })
  }
  async capture(shot, sceneVersion) {
    await this.assertInternal()
    return this.driver.page.evaluate(async ({ s, version }) => {
      const { captureService: capture, droneFly: fly } = window.__droneDemo
      const { buildCaptureManifest } = await import('/src/lib/drone-camera/drone-capture-manifest.ts')
      const session = capture.createSession({ source: 'virtual-camera', name: 'agent-shot', sceneId: 'three-demo-city-webgl-husky-v1', sceneVersion: version })
      try {
        const image = await capture.captureVirtualImage(session.id, { view: { pitch: s.pitch } })
        if (!image?.imageUrl) throw new Error('Camera returned no image')
        // Decode actual bytes in the rendering process; reject black/blank captures.
        const bitmap = await createImageBitmap(await (await fetch(image.imageUrl)).blob())
        const canvas = document.createElement('canvas')
        canvas.width = 64; canvas.height = 64
        const ctx = canvas.getContext('2d')
        ctx.drawImage(bitmap, 0, 0, 64, 64)
        const pixels = ctx.getImageData(0, 0, 64, 64).data
        let sum = 0, squares = 0
        for (let i = 0; i < pixels.length; i += 4) {
          const luma = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]
          sum += luma; squares += luma * luma
        }
        const meanLuma = sum / 4096, variance = squares / 4096 - meanLuma * meanLuma
        const dimensions = { width: bitmap.width, height: bitmap.height }
        bitmap.close()
        const manifest = buildCaptureManifest(session)
        manifest.images[0].quality = { decodable: true, meanLuma, variance, blank: variance < 0.01 }
        return { dataUrl: image.imageUrl, manifest, dimensions, observation: {
          // Observed after shutter; camera pose itself is latched in PhotoShot.camera.
          bodyPositionEnu: [fly.sim.position.x, -fly.sim.position.z, fly.sim.position.y],
          heading: fly.sim.heading, elapsed: fly.sim.elapsed, gimbalPitch: fly.sim.gimbalPitch,
        } }
      } finally { capture.removeSession(session.id) }
    }, { s: shot, version: sceneVersion })
  }
  async close() {
    try {
      if (this.driver.page) await this.driver.page.evaluate(() => {
        const fly = window.__droneDemo?.droneFly
        if (fly && !fly.sim.external) { fly.stopMission('Agent stopped'); fly.spinBodyTo(null); fly.hover() }
      }).catch(() => {})
    } finally { await this.driver.teardown() }
  }
}
