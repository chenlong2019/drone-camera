#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { CaptureAgent, RUNS_ROOT, acquire, atomicWrite } from './runtime.mjs'
import { PlatformClient, receiptToFrame } from './platform-client.mjs'
import { digest, safeId, validateTask } from './task.mjs'

export class PlatformWorker {
  constructor({ url = 'http://127.0.0.1:8090', root, workerId, client = new PlatformClient(url), agentOptions = {}, onProgress = () => {} } = {}) {
    this.client = client
    this.root = path.resolve(root ?? path.join(RUNS_ROOT, 'platform', digest(client.baseUrl).slice(0, 16)))
    this.workerId = safeId(workerId ?? `worker-${digest(`${hostname()}\0${this.root}`).slice(0, 24)}`)
    this.agentOptions = agentOptions; this.onProgress = onProgress
  }
  async runOnce({ maxShots = Infinity, signal } = {}) {
    if (signal?.aborted) return { stopped: true }
    mkdirSync(this.root, { recursive: true })
    const release = acquire(this.root, 'worker.lock')
    try {
      const claim = await this.client.request('/api/v1/capture-tasks/claim', { worker_id: this.workerId })
      if (!claim) return { idle: true, workerId: this.workerId }
      return await this.execute(claim, { maxShots, signal })
    } finally { release() }
  }
  async execute(claim, { maxShots, signal }) {
    const task = validateTask(claim.task.plan), route = `/api/v1/capture-tasks/${task.taskId}`
    const lease = { worker_id: this.workerId, lease_token: claim.lease_token }
    const controller = new AbortController()
    const stop = () => controller.abort()
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    let lostLease = false, timer, pending = Promise.resolve(), inFlight, agent, finalStatus
    const heartbeat = async () => {
      const state = agent.load(task.taskId)
      const remote = await this.client.request(`${route}/heartbeat`, { ...lease, scene_version: state.sceneVersion, completed: state.completed.length })
      if (remote.pause_requested) controller.abort()
      return remote
    }
    // Coalesce periodic heartbeats: an outage must not build an unbounded retry queue.
    const pulse = () => {
      if (inFlight) return inFlight
      const current = heartbeat()
      inFlight = current
      pending = current.catch((error) => {
        lostLease = true; controller.abort(); this.onProgress({ type: 'lease-lost', error: error.message })
      }).finally(() => { inFlight = null })
      return current
    }
    try {
      agent = new CaptureAgent({ ...this.agentOptions, root: this.root, onProgress: this.onProgress, onReceipt: async (receipt, state) => {
        if (lostLease) throw new Error('Platform lease was lost; local receipt is preserved')
        const frame = receiptToFrame(receipt, state, agent.directory(task.taskId))
        await this.client.request(`${route}/frames`, { ...lease, frame })
        await pulse()
        this.onProgress({ type: 'frame-registered', shotId: receipt.image.id })
      } })
      const checkpoint = path.join(agent.directory(task.taskId), 'checkpoint.json')
      if (!existsSync(checkpoint)) agent.prepare(task)
      const state = agent.load(task.taskId)
      if (state.taskHash !== digest(JSON.stringify(task))) throw new Error('Local task ID contains a different plan')
      await pulse()
      timer = setInterval(() => void pulse().catch(() => {}), 10000)
      // A server-committed frame can restore a lost local file without re-flying.
      const manifest = await this.client.request(`/api/v1/datasets/${claim.task.dataset_id}/manifest`)
      for (const frame of manifest.frames) {
        const receipt = frame.metadata?.sourceReceipt
        const shot = task.shots.find((item) => item.id === frame.metadata?.shotId)
        if (!shot || agent.receipt(agent.directory(task.taskId), state, shot)) continue
        if (!receipt || receipt.taskHash !== state.taskHash || receipt.sceneVersion !== state.sceneVersion || receipt.image.id !== shot.id || receipt.image.file !== `images/${shot.id}.png`) throw new Error('Server receipt does not match local task')
        const bytes = await this.client.request(`/api/v1/datasets/${claim.task.dataset_id}/images/${frame.frameId}`, undefined, { binary: true })
        if (digest(bytes) !== receipt.image.contentHash) throw new Error('Server image does not match committed receipt')
        atomicWrite(path.join(agent.directory(task.taskId), receipt.image.file), bytes)
        atomicWrite(path.join(agent.directory(task.taskId), 'receipts', `${shot.id}.json`), JSON.stringify(receipt, null, 2) + '\n')
      }
      const result = await agent.run(task.taskId, { maxShots, signal: controller.signal })
      clearInterval(timer); timer = null
      await pending
      if (lostLease) throw new Error('Platform lease was lost; resume after the lease expires')
      finalStatus = result.status
      return await this.client.request(`${route}/finish`, { ...lease, status: result.status })
    } catch (error) {
      clearInterval(timer); timer = null
      await pending
      // Completion may have committed even when its HTTP response was lost.
      try {
        const remote = await this.client.request(route)
        if (remote.status === 'completed' || remote.status === finalStatus) return remote
        await this.client.request(`${route}/finish`, { ...lease, status: 'failed', error: error.message.slice(0, 2000) })
      } catch { /* An expired lease remains reclaimable; durable photos stay on disk. */ }
      throw error
    } finally {
      clearInterval(timer)
      signal?.removeEventListener('abort', stop)
    }
  }
}

async function main() {
  const args = process.argv.slice(2), options = {}, execution = {}, allowed = ['--url', '--worker-id', '--root', '--max-shots']
  let once = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--once') { once = true; continue }
    if (!allowed.includes(arg) || !args[i + 1]) throw new Error('Usage: node agent/platform-worker.mjs [--url URL] [--worker-id ID] [--root DIR] [--once] [--max-shots N]')
    const value = args[++i]
    if (arg === '--max-shots') execution.maxShots = Number(value)
    else options[{ '--url': 'url', '--worker-id': 'workerId', '--root': 'root' }[arg]] = value
  }
  if (execution.maxShots !== undefined && (!Number.isInteger(execution.maxShots) || execution.maxShots < 1 || execution.maxShots > 200)) throw new Error('--max-shots must be 1–200')
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())
  process.on('SIGTERM', () => controller.abort())
  const worker = new PlatformWorker({ ...options, onProgress: (event) => process.stderr.write(JSON.stringify(event) + '\n') })
  do {
    try { process.stdout.write(JSON.stringify(await worker.runOnce({ ...execution, signal: controller.signal })) + '\n') }
    catch (error) { if (once) throw error; process.stderr.write(JSON.stringify({ error: error.message }) + '\n') }
    if (!once && !controller.signal.aborted) await delay(3000, undefined, { signal: controller.signal }).catch(() => {})
  } while (!once && !controller.signal.aborted)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  process.stderr.write(error.message + '\n'); process.exitCode = 1
})
