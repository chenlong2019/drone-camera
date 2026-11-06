import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CaptureAgent } from '../runtime.mjs'
import { SCENE_ID, validateTask } from '../task.mjs'

function task(taskId = 'test-task') {
  return { schemaVersion: 1, taskId, sceneId: SCENE_ID, maxAttempts: 2,
    shots: [0, 1, 2].map((i) => ({ id: `shot-${i}`, positionEnu: [i * 2, 0, 6], heading: 0, pitch: -25 })) }
}
// Fake renderer exercises orchestration failures; actual PNG decoding, movement and
// shutdown/restart are covered by agent:verify's real Chromium run.
function observation(shot) {
  const camera = { model: 'PINHOLE', width: 16, height: 16, fx: 10, fy: 10, cx: 8, cy: 8 }
  return {
    dataUrl: 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(shot.id)]).toString('base64'),
    dimensions: { width: 16, height: 16 },
    observation: { bodyPositionEnu: shot.positionEnu, heading: shot.heading, gimbalPitch: shot.pitch },
    manifest: { camera, images: [{ position: shot.positionEnu, rotation: [0, 0, 0, 1],
      coordinateFrame: 'local-enu', rotationConvention: 'quaternion [x,y,z,w]; camera forward=-Z, up=+Y',
      captureStatus: 'success', timestamp: '2026-11-06T00:00:00Z', mimeType: 'image/png', width: 16, height: 16,
      quality: { decodable: true, variance: 100, meanLuma: 120 }, intrinsics: camera,
    }] },
  }
}
function fixture(t, overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'drone-agent-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calls = [], lifecycle = []
  const options = { root, fingerprint: () => 'test-scene-v1', toolsFactory: () => ({
    prepare: async () => lifecycle.push('prepare'),
    navigate: async (shot) => calls.push(shot.id),
    capture: async (shot) => observation(shot),
    close: async () => lifecycle.push('close'), ...overrides,
  }) }
  const agent = new CaptureAgent(options)
  agent.prepare(task())
  return { root, options, agent, calls, lifecycle, dir: agent.directory('test-task') }
}

test('restart reuses verified files and produces a complete COLMAP bundle', async (t) => {
  const { agent, options, calls, lifecycle, dir } = fixture(t)
  assert.equal((await agent.run('test-task', { maxShots: 1 })).status, 'paused')
  const original = readFileSync(path.join(dir, 'images/shot-0.png'))
  const resumed = new CaptureAgent(options)
  assert.equal((await resumed.run('test-task')).status, 'completed')
  assert.deepEqual(calls, ['shot-0', 'shot-1', 'shot-2'])
  assert.deepEqual(readFileSync(path.join(dir, 'images/shot-0.png')), original)
  assert.deepEqual(lifecycle, ['prepare', 'close', 'prepare', 'close'])
  assert.equal((await resumed.validate('test-task')).valid, true)
  assert.equal(readFileSync(path.join(dir, 'capture-colmap.zip')).subarray(0, 2).toString(), 'PK')
  await resumed.run('test-task')
  assert.equal(calls.length, 3, 'completed task must not fly or recapture')
})
test('receipts repair a checkpoint that lagged behind a successful write', async (t) => {
  const { agent, options, calls, dir } = fixture(t)
  await agent.run('test-task', { maxShots: 1 })
  const state = agent.load('test-task')
  state.completed = []; state.status = 'running'
  writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify(state))
  await new CaptureAgent(options).run('test-task')
  assert.deepEqual(calls, ['shot-0', 'shot-1', 'shot-2'])
})
test('corrupted files are detected then only the missing shot is recaptured', async (t) => {
  const { agent, calls, dir } = fixture(t)
  await agent.run('test-task')
  writeFileSync(path.join(dir, 'images/shot-1.png'), 'broken')
  assert.equal((await agent.validate('test-task')).valid, false)
  await agent.run('test-task')
  assert.deepEqual(calls, ['shot-0', 'shot-1', 'shot-2', 'shot-1'])
  assert.equal((await agent.validate('test-task')).valid, true)
})
test('failed capture retries with a new renderer, bounded by the plan', async (t) => {
  let count = 0
  const { agent, lifecycle } = fixture(t, { capture: async (shot) => {
    if (++count === 1) throw new Error('temporary renderer failure')
    return observation(shot)
  } })
  assert.equal((await agent.run('test-task')).status, 'completed')
  assert.equal(agent.load('test-task').attempts['shot-0'], 2)
  assert.deepEqual(lifecycle, ['prepare', 'close', 'prepare', 'close'])
})
test('exhausted retries persist failure and later resume completes', async (t) => {
  let broken = true
  const { agent, dir } = fixture(t, { capture: async (shot) => {
    if (broken) throw new Error('camera unavailable')
    return observation(shot)
  } })
  await assert.rejects(agent.run('test-task'), /camera unavailable/)
  assert.equal(agent.status('test-task').status, 'failed')
  assert.equal(agent.load('test-task').attempts['shot-0'], 2)
  assert.equal(existsSync(path.join(dir, 'run.lock')), false)
  broken = false
  assert.equal((await agent.run('test-task')).status, 'completed')
})
test('a changed scene cannot be mixed into a partially captured dataset', async (t) => {
  const { agent, options, calls } = fixture(t)
  await agent.run('test-task', { maxShots: 1 })
  await assert.rejects(new CaptureAgent({ ...options, fingerprint: () => 'different' }).run('test-task'), /sources changed/)
  assert.deepEqual(calls, ['shot-0'])
})
test('pause request drains the in-flight capture and prevents the next one', async (t) => {
  const f = fixture(t)
  f.agent.onProgress = (event) => { if (event.type === 'capture-saved') f.agent.pause('test-task') }
  assert.equal((await f.agent.run('test-task')).status, 'paused')
  assert.deepEqual(f.calls, ['shot-0'])
})
test('live lock rejects another writer; aborted run preserves its task', async (t) => {
  const { agent, options, dir } = fixture(t)
  writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: process.pid, token: 'active' }))
  await assert.rejects(new CaptureAgent(options).run('test-task'), /already running/)
  assert.equal(agent.status('test-task').status, 'prepared')
})
test('invalid geometry or blank images cannot be marked complete', async (t) => {
  const { agent, dir } = fixture(t, { capture: async (shot) => {
    const result = observation(shot)
    result.manifest.images[0].quality.blank = true
    return result
  } })
  await assert.rejects(agent.run('test-task'), /blank-image/)
  assert.equal(existsSync(path.join(dir, 'capture-colmap.zip')), false)
  assert.equal(agent.status('test-task').completed, 0)
})
test('position observed at capture must satisfy requested point', async (t) => {
  const { agent } = fixture(t, { capture: async (shot) => {
    const result = observation(shot)
    result.observation.bodyPositionEnu = [100, 100, 100]
    return result
  } })
  await assert.rejects(agent.run('test-task'), /requested capture pose/)
})
test('task validation rejects unsafe IDs, unknown capabilities and duplicate points IDs', () => {
  assert.throws(() => validateTask({ ...task(), taskId: '../escape' }), /ID/)
  assert.throws(() => validateTask({ ...task(), mavlinkUrl: 'ws://device' }), /Unknown field/)
  const duplicate = task(); duplicate.shots[1].id = duplicate.shots[0].id
  assert.throws(() => validateTask(duplicate), /Duplicate shot/)
})
test('preparing an existing task never resets its checkpoint', (t) => {
  const { agent } = fixture(t)
  assert.throws(() => agent.prepare(task()), /EEXIST/)
  assert.equal(agent.status('test-task').status, 'prepared')
})

test('failed remote registration preserves the receipt and does not retry the shutter', async (t) => {
  const { agent, options, calls, dir } = fixture(t)
  agent.onReceipt = async () => { throw new Error('upload response lost') }
  await assert.rejects(agent.run('test-task'), /upload response lost/)
  assert.deepEqual(calls, ['shot-0'])
  assert.equal(agent.load('test-task').attempts['shot-0'], 1)
  const original = readFileSync(path.join(dir, 'images/shot-0.png'))
  const registered = []
  const resumed = new CaptureAgent({ ...options, onReceipt: async (receipt) => registered.push(receipt.image.id) })
  await resumed.run('test-task')
  assert.deepEqual(registered, ['shot-0', 'shot-1', 'shot-2'])
  assert.deepEqual(calls, ['shot-0', 'shot-1', 'shot-2'])
  assert.deepEqual(readFileSync(path.join(dir, 'images/shot-0.png')), original)
})

test('new browser executions identify simulation clock resets without altering elapsed time', async (t) => {
  const { agent, options, dir } = fixture(t)
  await agent.run('test-task', { maxShots: 1 })
  await new CaptureAgent(options).run('test-task')
  const receipts = [0, 1, 2].map((i) => JSON.parse(readFileSync(path.join(dir, 'receipts', `shot-${i}.json`))))
  assert.notEqual(receipts[0].simulationSessionId, receipts[1].simulationSessionId)
  assert.equal(receipts[1].simulationSessionId, receipts[2].simulationSessionId)
})
