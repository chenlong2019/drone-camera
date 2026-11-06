/** Real renderer + separate CLI processes, not a mocked HTTP/PNG smoke test. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { CaptureAgent, RUNS_ROOT } from './runtime.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function cli(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['agent/cli.mjs', ...args], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.on('data', (data) => { output += data })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`CLI failed (${code}): ${output}`))
      try { resolve(JSON.parse(output.trim().split('\n').at(-1))) } catch (e) { reject(e) }
    })
  })
}
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const task = JSON.parse(readFileSync(path.join(ROOT, 'agent/examples/city-capture.json')))
task.taskId = `verification-${Date.now()}`
const agent = new CaptureAgent()
agent.prepare(task)
const dir = path.join(RUNS_ROOT, task.taskId)
const partial = await cli('run', task.taskId, '--max-shots', '1')
assert.equal(partial.status, 'paused')
assert.equal(partial.completed, 1)
const firstHash = hash(path.join(dir, 'images/view-01.png'))
const completed = await cli('resume', task.taskId)
assert.equal(completed.status, 'completed')
assert.equal(completed.completed, 3)
assert.equal(hash(path.join(dir, 'images/view-01.png')), firstHash)
assert.equal((await agent.validate(task.taskId)).valid, true)
const checkpoint = agent.load(task.taskId)
assert.equal(checkpoint.attempts['view-01'], 1)
const report = { ok: true, taskId: task.taskId, firstRun: partial, secondRun: completed, firstImageUnchanged: true }
writeFileSync(path.join(dir, 'restart-verification.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
