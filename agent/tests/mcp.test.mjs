import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AGENT_TOOLS } from '../tools.mjs'

test('MCP exposes original commands plus bounded recovery tools', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../mcp/drone-mcp-server.mjs', import.meta.url))], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', (v) => { stdout += v })
  child.stderr.on('data', (v) => { stderr += v })
  const timer = setTimeout(() => child.kill(), 10000)
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agent_run', arguments: { taskId: '../escape', maxShots: 1 } } },
  ].map((v) => JSON.stringify(v)).join('\n') + '\n')
  const code = await exited
  clearTimeout(timer)
  assert.equal(code, 0, stderr)
  const messages = stdout.trim().split('\n').map((v) => JSON.parse(v))
  const tools = messages.find((m) => m.id === 2).result.tools
  assert.equal(tools.length, 19)
  for (const tool of AGENT_TOOLS) assert.ok(tools.some((v) => v.name === tool.name))
  assert.ok(tools.some((v) => v.name === 'drone_takeoff'))
  assert.ok(messages.find((m) => m.id === 3)?.error, 'invalid Agent arguments must fail without booting browser')
})
