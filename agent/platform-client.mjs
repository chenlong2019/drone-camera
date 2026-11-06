import { readFileSync } from 'node:fs'
import path from 'node:path'
import { digest } from './task.mjs'

export function enuToPlatform(position, rotation) {
  if (position?.length !== 3 || rotation?.length !== 4 || ![...position, ...rotation].every(Number.isFinite)) throw new Error('Invalid measured camera pose')
  if (Math.abs(rotation.reduce((sum, v) => sum + v * v, 0) - 1) > 1e-3) throw new Error('Camera rotation must have unit length')
  const [east, north, up] = position, [x, y, z, w] = rotation, s = Math.SQRT1_2
  // Left multiplication by Rx(-90°) rotates the WORLD basis. Camera axes stay -Z/+X/+Y.
  return {
    positionM: { x: east, y: up, z: -north },
    quaternionXyzw: { x: s * (x - w), y: s * (y + z), z: s * (z - y), w: s * (w + x) },
    coordinateFrame: 'platform-world',
  }
}

export function captureFrameId(taskId, shotId) { return `capture-${digest(`${taskId}\0${shotId}`).slice(0, 40)}` }

export function receiptToFrame(receipt, state, directory) {
  const { image, observation } = receipt
  const shotIndex = state.task.shots.findIndex((shot) => shot.id === image.id)
  if (shotIndex < 0 || receipt.taskHash !== state.taskHash || receipt.sceneVersion !== state.sceneVersion || image.coordinateFrame !== 'local-enu' ||
      image.file !== `images/${image.id}.png` || image.rotationConvention !== 'quaternion [x,y,z,w]; active camera-local-to-world rotation; camera forward=-Z, right=+X, up=+Y') throw new Error('Receipt does not match the bounded task or camera convention')
  const bytes = readFileSync(path.join(directory, image.file))
  if (digest(bytes) !== image.contentHash) throw new Error('Committed image is missing or damaged')
  const camera = image.intrinsics ?? receipt.camera
  return {
    frameId: captureFrameId(state.task.taskId, image.id), imageDataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    width: image.width, height: image.height, simulationTime: observation.elapsed, capturedAt: image.timestamp,
    cameraPose: enuToPlatform(image.position, image.rotation),
    cameraIntrinsics: Object.fromEntries(['width', 'height', 'fx', 'fy', 'cx', 'cy', 'distortion'].filter((key) => camera[key] !== undefined).map((key) => [key, camera[key]])),
    metadata: {
      source: 'drone-camera-agent', captureTaskId: state.task.taskId, shotId: image.id, shotIndex,
      sceneVersion: state.sceneVersion, simulationSessionId: receipt.simulationSessionId ?? `legacy-${image.id}`,
      sourceCoordinateFrame: 'local-enu', sourceReceipt: receipt,
    },
  }
}

export class PlatformClient {
  constructor(baseUrl, { fetcher = fetch, attempts = 3, timeoutMs = 15000 } = {}) {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Expected an HTTP service URL without credentials, query or fragment')
    this.baseUrl = url.href.replace(/\/$/, '')
    this.fetcher = fetcher; this.attempts = attempts; this.timeoutMs = timeoutMs
  }
  async request(route, body, { binary = false } = {}) {
    let error
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        const response = await this.fetcher(`${this.baseUrl}${route}`, {
          method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 1800)
          const failure = new Error(`Platform HTTP ${response.status}: ${detail}`)
          failure.status = response.status
          throw failure
        }
        return binary ? Buffer.from(await response.arrayBuffer()) : await response.json()
      } catch (failure) {
        error = failure
        if (failure.status && failure.status < 500 && failure.status !== 429) throw failure
        if (attempt < this.attempts) await new Promise((resolve) => setTimeout(resolve, 200 * attempt))
      }
    }
    throw error
  }
}
