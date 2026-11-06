import test from 'node:test'
import assert from 'node:assert/strict'
import { Quaternion, Vector3 } from 'three'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { enuToPlatform, captureFrameId, receiptToFrame, PlatformClient } from '../platform-client.mjs'
import { digest } from '../task.mjs'

test('position and rotation transform the same measured camera basis from ENU', () => {
  for (const rotation of [[0, 0, 0, 1], [0.3, 0.2, -0.1, 0.9], [0.5372996083468236, 0, 0, 0.8433914458128855]]) {
    const original = new Quaternion(...rotation).normalize()
    const converted = enuToPlatform([2, 3, 7], original.toArray())
    assert.deepEqual(converted.positionM, { x: 2, y: 7, z: -3 })
    const target = new Quaternion(...['x', 'y', 'z', 'w'].map((key) => converted.quaternionXyzw[key]))
    for (const axis of [[0, 0, -1], [1, 0, 0], [0, 1, 0]]) {
      const sourceAxis = new Vector3(...axis).applyQuaternion(original)
      const expected = new Vector3(sourceAxis.x, sourceAxis.z, -sourceAxis.y)
      assert.ok(new Vector3(...axis).applyQuaternion(target).distanceTo(expected) < 1e-12)
    }
  }
  assert.throws(() => enuToPlatform([0, 0, 0], [0, 0, 0, 2]), /unit length/)
})

test('receipt adapter retains actual simulation time, source pose and file digest', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'drone-adapter-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const bytes = Buffer.from('adapter payload; actual PNG decoding is verified by the service')
  mkdirSync(path.join(directory, 'images'))
  writeFileSync(path.join(directory, 'images/view-01.png'), bytes)
  const state = { taskHash: 'task-hash', sceneVersion: 'a'.repeat(64), task: { taskId: 'task-1', shots: [{ id: 'view-01' }] } }
  const receipt = {
    taskHash: state.taskHash, sceneVersion: state.sceneVersion, simulationSessionId: 'new-browser', observation: { elapsed: 0.25 },
    camera: { width: 16, height: 12, fx: 10, fy: 10, cx: 8, cy: 6, model: 'PINHOLE' },
    image: { id: 'view-01', file: 'images/view-01.png', width: 16, height: 12, timestamp: '2026-11-06T00:00:00Z',
      position: [2, 3, 7], rotation: [0, 0, 0, 1], coordinateFrame: 'local-enu', contentHash: digest(bytes),
      rotationConvention: 'quaternion [x,y,z,w]; active camera-local-to-world rotation; camera forward=-Z, right=+X, up=+Y' },
  }
  const frame = receiptToFrame(receipt, state, directory)
  assert.equal(frame.simulationTime, 0.25)
  assert.equal(frame.metadata.simulationSessionId, 'new-browser')
  assert.deepEqual(frame.metadata.sourceReceipt, receipt)
  assert.equal(frame.frameId, captureFrameId('task-1', 'view-01'))
  assert.notEqual(frame.frameId, captureFrameId('task-2', 'view-01'))
  writeFileSync(path.join(directory, 'images/view-01.png'), 'damaged')
  assert.throws(() => receiptToFrame(receipt, state, directory), /damaged/)
})

test('HTTP retry repeats an identical request after a committed response is lost', async () => {
  const bodies = []
  const client = new PlatformClient('http://localhost:8090/', { fetcher: async (_url, options) => {
    bodies.push(options.body)
    if (bodies.length === 1) throw new TypeError('connection lost after server commit')
    return new Response(JSON.stringify({ frameId: 'committed-frame' }))
  } })
  const result = await client.request('/frames', { lease_token: 'lease', frame: { frameId: 'committed-frame' } })
  assert.equal(result.frameId, 'committed-frame')
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0], bodies[1])
})

test('HTTP conflicts are surfaced without retrying writes', async () => {
  let count = 0
  const client = new PlatformClient('http://localhost:8090', { fetcher: async () => {
    count++; return new Response(JSON.stringify({ detail: 'lease expired' }), { status: 409 })
  } })
  await assert.rejects(client.request('/frames', {}), /409.*lease expired/)
  assert.equal(count, 1)
})
