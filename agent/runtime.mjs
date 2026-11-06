import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createJiti } from 'jiti'
import { digest, safeId, validateTask } from './task.mjs'
import { SimulationTools } from './simulation-tools.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const RUNS_ROOT = path.join(ROOT, 'agent-runs')
const jiti = createJiti(import.meta.url)
let libraries
async function libs() {
  libraries ??= Promise.all([
    jiti.import('../src/lib/drone-camera/drone-capture-manifest.ts'),
    jiti.import('../src/lib/drone-camera/drone-capture-bundle.ts'),
  ])
  const [manifest, bundle] = await libraries
  return { ...manifest, ...bundle }
}
export function atomicWrite(file, content) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'wx')
  try { writeFileSync(fd, content); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temp, file)
}
const jsonWrite = (file, value) => atomicWrite(file, JSON.stringify(value, null, 2) + '\n')
const jsonRead = (file) => JSON.parse(readFileSync(file, 'utf8'))
const timestamp = () => new Date().toISOString()

/** Fingerprint rendering sources rather than HEAD: a docs-only commit must not
 * invalidate a dataset, while a changed scene or camera model must. */
export function sceneVersion() {
  const parts = []
  function collect(relative) {
    for (const entry of readdirSync(path.join(ROOT, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${relative}/${entry.name}`
      if (entry.isDirectory()) collect(file)
      else if (/\.(ts|vue|json)$/.test(file)) parts.push(file, readFileSync(path.join(ROOT, file), 'utf8').replaceAll('\r\n', '\n'))
    }
  }
  collect('src/lib'); collect('src/components/use-three-demo')
  for (const file of ['package-lock.json', 'mcp/headless-driver.mjs', 'agent/simulation-tools.mjs']) parts.push(file, readFileSync(path.join(ROOT, file), 'utf8').replaceAll('\r\n', '\n'))
  return digest(parts.join('\n'))
}

function acquire(dir) {
  const file = path.join(dir, 'run.lock')
  const token = randomUUID()
  try {
    const fd = openSync(file, 'wx')
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })) } finally { closeSync(fd) }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const owner = jsonRead(file)
    let alive = true
    try { process.kill(owner.pid, 0) } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e }
    if (alive) throw new Error(`Task already running (pid ${owner.pid})`)
    unlinkSync(file)
    return acquire(dir)
  }
  return () => { if (existsSync(file) && jsonRead(file).token === token) unlinkSync(file) }
}

export class CaptureAgent {
  constructor({ root = RUNS_ROOT, toolsFactory = () => new SimulationTools(), fingerprint = sceneVersion, onProgress = () => {} } = {}) {
    this.root = path.resolve(root)
    this.toolsFactory = toolsFactory
    this.fingerprint = fingerprint
    this.onProgress = onProgress
  }
  directory(taskId) { return path.join(this.root, safeId(taskId)) }
  prepare(input) {
    const task = validateTask(input)
    const dir = this.directory(task.taskId)
    mkdirSync(this.root, { recursive: true })
    // Never silently replace a previously prepared task or its completed images.
    mkdirSync(dir)
    const state = {
      schemaVersion: 1, task, taskHash: digest(JSON.stringify(task)), sceneVersion: this.fingerprint(),
      status: 'prepared', createdAt: timestamp(), updatedAt: timestamp(), completed: [], attempts: {}, lastError: null,
    }
    jsonWrite(path.join(dir, 'checkpoint.json'), state)
    this.event(dir, 'prepared', { taskId: task.taskId, shots: task.shots.length })
    return this.summary(state)
  }
  load(taskId) {
    const state = jsonRead(path.join(this.directory(taskId), 'checkpoint.json'))
    const task = validateTask(state.task)
    if (task.taskId !== taskId || state.taskHash !== digest(JSON.stringify(task))) throw new Error('Task/checkpoint hash mismatch')
    return state
  }
  summary(state) {
    return { taskId: state.task.taskId, status: state.status, completed: state.completed.length,
      total: state.task.shots.length, lastError: state.lastError, runDirectory: this.directory(state.task.taskId),
      artifacts: state.artifacts ?? null }
  }
  status(taskId) { return this.summary(this.load(taskId)) }
  pause(taskId) {
    const state = this.load(taskId)
    atomicWrite(path.join(this.directory(taskId), 'pause.request'), 'pause\n')
    return { ...this.summary(state), pauseRequested: true }
  }
  event(dir, type, details = {}) {
    appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ at: timestamp(), type, ...details }) + '\n')
    this.onProgress({ type, ...details })
  }
  checkpoint(dir, state, status = state.status) {
    state.status = status; state.updatedAt = timestamp()
    jsonWrite(path.join(dir, 'checkpoint.json'), state)
  }
  receipt(dir, state, shot) {
    try {
      const entry = jsonRead(path.join(dir, 'receipts', `${shot.id}.json`))
      const file = `images/${shot.id}.png`
      const bytes = readFileSync(path.join(dir, file))
      if (entry.taskHash !== state.taskHash || entry.sceneVersion !== state.sceneVersion ||
          entry.image.id !== shot.id || entry.image.file !== file || digest(bytes) !== entry.image.contentHash) return null
      return entry
    } catch { return null }
  }
  manifest(state, receipts) {
    return {
      schemaVersion: 1, captureId: state.task.taskId, createdAt: state.createdAt,
      coordinateFrame: { world: 'local-enu', local: 'local-enu', units: 'meters', transform: { source: 'local-enu', target: 'local-enu' } },
      camera: receipts[0]?.camera ?? { model: 'PINHOLE', width: 0, height: 0 },
      images: receipts.map((r) => r.image),
    }
  }
  async validate(taskId) {
    const state = this.load(taskId), dir = this.directory(taskId)
    const receipts = state.task.shots.map((s) => this.receipt(dir, state, s)).filter(Boolean)
    const { validateCaptureManifest } = await libs()
    const report = validateCaptureManifest(this.manifest(state, receipts))
    if (receipts.length !== state.task.shots.length) report.errors.push({ severity: 'error', code: 'incomplete-task', message: 'Some planned images are missing or damaged' })
    return { ...report, status: report.errors.length ? 'invalid' : report.warnings.length ? 'warning' : 'valid',
      issues: [...report.errors, ...report.warnings], valid: report.errors.length === 0, passed: report.errors.length === 0 }
  }
  async run(taskId, { maxShots = Infinity, signal } = {}) {
    if (maxShots !== Infinity && (!Number.isInteger(maxShots) || maxShots < 1 || maxShots > 200)) throw new Error('maxShots must be 1–200')
    const dir = this.directory(taskId), release = acquire(dir)
    let tools, state
    try {
      state = this.load(taskId)
      if (state.sceneVersion !== this.fingerprint()) throw new Error('Rendering sources changed; create a new task to avoid mixing scenes')
      const pauseFile = path.join(dir, 'pause.request')
      if (existsSync(pauseFile)) unlinkSync(pauseFile)
      const { validateCaptureManifest, buildCaptureBundle } = await libs()
      // A durable receipt is authoritative even if a process died before checkpoint.
      const receipts = new Map()
      for (const shot of state.task.shots) {
        const receipt = this.receipt(dir, state, shot)
        if (receipt && validateCaptureManifest(this.manifest(state, [receipt])).valid) receipts.set(shot.id, receipt)
      }
      state.completed = [...receipts.keys()]
      state.lastError = null
      state.artifacts = null
      this.checkpoint(dir, state, 'running')
      this.event(dir, 'resume', { reused: receipts.size, total: state.task.shots.length })
      let captured = 0
      for (const shot of state.task.shots) {
        if (receipts.has(shot.id)) continue
        if (captured >= maxShots || signal?.aborted || existsSync(pauseFile)) {
          this.checkpoint(dir, state, 'paused')
          return this.summary(state)
        }
        let accepted = false
        for (let attempt = 1; attempt <= state.task.maxAttempts; attempt++) {
          state.attempts[shot.id] = (state.attempts[shot.id] ?? 0) + 1
          this.checkpoint(dir, state)
          this.event(dir, 'capture-start', { shotId: shot.id, attempt })
          try {
            if (!tools) { tools = this.toolsFactory(); await tools.prepare() }
            await tools.navigate(shot)
            const result = await tools.capture(shot, state.sceneVersion)
            const bytes = Buffer.from(result.dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64')
            if (!result.dataUrl.startsWith('data:image/png;base64,') || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Capture is not PNG')
            const image = { ...result.manifest.images[0], id: shot.id, file: `images/${shot.id}.png`, sizeBytes: bytes.length, contentHash: digest(bytes) }
            if (result.dimensions.width !== image.width || result.dimensions.height !== image.height) throw new Error('Decoded dimensions disagree with camera metadata')
            const measured = result.observation
            if (Math.hypot(...measured.bodyPositionEnu.map((v, i) => v - shot.positionEnu[i])) > 0.75 ||
                Math.abs(((measured.heading - shot.heading + 540) % 360) - 180) > 1 || Math.abs(measured.gimbalPitch - shot.pitch) > 1) throw new Error('Aircraft did not reach requested capture pose')
            const entry = { taskHash: state.taskHash, sceneVersion: state.sceneVersion, camera: result.manifest.camera, image,
              observation: measured, shot, capturedAt: timestamp() }
            const validation = validateCaptureManifest(this.manifest(state, [...receipts.values(), entry]))
            if (!validation.valid) throw new Error(validation.errors.map((i) => `${i.code}: ${i.message}`).join('; '))
            atomicWrite(path.join(dir, image.file), bytes)
            jsonWrite(path.join(dir, 'receipts', `${shot.id}.json`), entry)
            receipts.set(shot.id, entry)
            state.completed = [...receipts.keys()]
            this.checkpoint(dir, state)
            this.event(dir, 'capture-saved', { shotId: shot.id, completed: receipts.size })
            accepted = true; captured++
            break
          } catch (error) {
            this.event(dir, 'capture-failed', { shotId: shot.id, attempt, error: error.message })
            // A timed-out operation cannot run into the retry. Recreate its browser.
            await tools?.close().catch(() => {}); tools = null
            if (attempt === state.task.maxAttempts) throw error
          }
        }
        if (!accepted) throw new Error(`Capture failed: ${shot.id}`)
      }
      const ordered = state.task.shots.map((s) => receipts.get(s.id))
      const manifest = this.manifest(state, ordered)
      const validation = await this.validate(taskId)
      jsonWrite(path.join(dir, 'validation.json'), validation)
      if (!validation.valid) throw new Error('Dataset validation failed; see validation.json')
      const bundle = buildCaptureBundle({ manifest, images: ordered.map((r) => ({ id: r.image.id, bytes: readFileSync(path.join(dir, r.image.file)), mimeType: 'image/png' })) })
      if (bundle.missing.length || bundle.colmap.skipped.length || bundle.colmap.imageCount !== state.task.shots.length) throw new Error('Incomplete COLMAP export')
      atomicWrite(path.join(dir, 'capture-colmap.zip'), bundle.bytes)
      jsonWrite(path.join(dir, 'manifest.json'), manifest)
      state.artifacts = { manifest: path.join(dir, 'manifest.json'), validation: path.join(dir, 'validation.json'), bundle: path.join(dir, 'capture-colmap.zip') }
      this.checkpoint(dir, state, 'completed')
      this.event(dir, 'completed', { images: receipts.size })
      return this.summary(state)
    } catch (error) {
      if (state) {
        state.lastError = error.message
        this.checkpoint(dir, state, 'failed')
        this.event(dir, 'failed', { error: error.message })
      }
      throw error
    } finally {
      try { await tools?.close() } finally { release() }
    }
  }
}
