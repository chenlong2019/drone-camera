#!/usr/bin/env node
/**
 * Blender 式 CLI —— 不开浏览器窗口也能指挥无人机。
 *
 *   node mcp/drone-cli.mjs state                          # 当前真值
 *   node mcp/drone-cli.mjs takeoff                        # 自动开机展臂起飞
 *   node mcp/drone-cli.mjs spin_to --heading 90           # 机身转到 90°
 *   node mcp/drone-cli.mjs capture_photo --pitch -20      # 单拍(俯仰 -20°)
 *   node mcp/drone-cli.mjs panorama --mode pano-360       # 拍全景 + 拼接,落盘 PNG
 *   node mcp/drone-cli.mjs screenshot --mode fpv          # 当前画面截图
 *   node mcp/drone-cli.mjs viewer_shot --file xx.png --yaw 120 --pitch -10
 *   node mcp/drone-cli.mjs sessions                       # 采集会话列表
 *   node mcp/drone-cli.mjs run task.json                  # 批处理(见下)
 *   node mcp/drone-cli.mjs shutdown                       # 关掉后台渲染进程
 *
 * task.json 形如:
 *   {
 *     "steps": [
 *       { "cmd": "takeoff" },
 *       { "cmd": "panorama", "mode": "pano-360" },
 *       { "cmd": "viewer_shot", "file": "tmp-shots/mcp-out/pano-pano-360-xxx.png",
 *         "yaw": 90, "pitch": -10, "name": "check-east" },
 *       { "cmd": "land" }
 *     ]
 *   }
 * 产物与 report.json 一起落在 tmp-shots/mcp-out/。
 *
 * 所有输出都是单行 JSON(最后一行),方便 AI / 脚本解析;日志走 stderr。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { driver, runCommand } from './headless-driver.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'tmp-shots', 'mcp-out')

/** argv → 命令对象:--key value / --flag / 位置参数 */
function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        args[key] = true
      } else {
        args[key] = next
        i += 1
      }
    } else {
      args._.push(token)
    }
  }
  return args
}

function toNumber(value, fallback) {
  if (value === undefined || value === true) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 把 CLI 参数归一成驱动命令 */
function buildCommand(args) {
  const name = args._[0]
  if (!name) throw new Error('缺少命令名,试试:state / takeoff / panorama / run ...')
  const cmd = { cmd: name }
  if (name === 'spin_to') cmd.heading = toNumber(args.heading, NaN)
  if (name === 'camera_mode') cmd.mode = args.mode ?? 'orbit'
  if (name === 'capture_photo') cmd.pitch = args.pitch === undefined ? null : toNumber(args.pitch, null)
  if (name === 'panorama') {
    cmd.mode = args.mode ?? 'pano-360'
    cmd.shotIntervalMs = toNumber(args.shotIntervalMs, 0)
  }
  if (name === 'screenshot') {
    if (args.mode) cmd.mode = args.mode
    if (args.name) cmd.name = args.name
  }
  if (name === 'viewer_shot') {
    cmd.file = args.file
    cmd.yaw = toNumber(args.yaw, 0)
    cmd.pitch = toNumber(args.pitch, 0)
    cmd.fov = toNumber(args.fov, 75)
    if (args.name) cmd.name = args.name
  }
  if (name === 'session_export') {
    cmd.id = args.id
    cmd.format = args.format ?? 'json'
  }
  if (name === 'session_photos') {
    cmd.id = args.id
    if (args.group) cmd.group = args.group
  }
  return cmd
}

async function runBatch(steps) {
  const results = []
  for (const [index, step] of steps.entries()) {
    process.stderr.write(`[run] ${index + 1}/${steps.length} ${step.cmd}\n`)
    const result = await runCommand(step)
    results.push(result)
    if (result.ok === false) {
      process.stderr.write(`[run] 第 ${index + 1} 步失败,中止:${result.error}\n`)
      break
    }
  }
  return results
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let payload
  if (args._[0] === 'run') {
    const file = args.file ?? args._[1]
    if (!file) throw new Error('run 需要 task.json 路径:node mcp/drone-cli.mjs run task.json')
    const task = JSON.parse(readFileSync(path.resolve(file), 'utf8'))
    const steps = Array.isArray(task) ? task : task.steps
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('task.json 里没有 steps 数组')
    const results = await runBatch(steps)
    const ok = results.length === steps.length && results.every((r) => r.ok !== false)
    mkdirSync(OUT, { recursive: true })
    const report = path.join(OUT, `report-${Date.now()}.json`)
    writeFileSync(report, JSON.stringify({ ok, steps: results }, null, 2))
    payload = { ok, steps: results.length, report, results }
  } else {
    payload = await runCommand(buildCommand(args))
  }
  // 单行 JSON 到 stdout(AI 直接吃);teardown 幂等,shutdown 命令内部已收过
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  await driver.teardown()
}

main().catch(async (err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  await driver.teardown().catch(() => {})
  process.exit(1)
})
