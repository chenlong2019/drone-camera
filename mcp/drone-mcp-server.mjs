#!/usr/bin/env node
/**
 * MCP server(stdio) —— 让任何 AI 客户端直接指挥这台无人机。
 *
 * 协议:MCP over stdio = 换行分隔的 JSON-RPC 2.0(每条消息一行)。
 *   initialize -> notifications/initialized -> tools/list -> tools/call ...
 *
 * 不引官方 SDK:握手面很小(initialize/tools/list/tools/call/ping),
 * 手写 ~150 行即可,少一个依赖少一处版本坑;要上生产再换 @modelcontextprotocol/sdk。
 *
 * 日志一律走 stderr —— stdout 是协议通道,混任何东西进去都会破坏通信。
 *
 * 注册(WorkBuddy / Claude Desktop 等):见 mcp/README.md,核心就一条:
 *   { "mcpServers": { "drone-camera": { "command": "node",
 *       "args": ["D:/project/drone-camera/mcp/drone-mcp-server.mjs"] } } }
 */
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { runCommand } from './headless-driver.mjs'

const SERVER_INFO = { name: 'drone-camera', version: '1.0.0' }
const PROTOCOL_VERSION = '2024-11-05'

/** 工具表:name / 描述 / JSON Schema。命名 drone_* 前缀,和库里的 Drone* 类一眼对应 */
const TOOLS = [
  {
    name: 'drone_state',
    description:
      '读取无人机当前真值:飞行阶段、位置、航向、云台俯仰/偏航、电量、已拍张数、视角模式、障碍物数、采集会话数。任何操作前先调它确认状态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'drone_takeoff',
    description: '自动开机、展开机臂并起飞到 1.2m 悬停(已飞行则直接返回当前状态)。拍照/全景前必须调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'drone_land',
    description: '原地降落并等待落地(phase 回到 standby)。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'drone_return_home',
    description: '中断当前任务自动返航(回到起飞点上方后悬停)。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'drone_spin_to',
    description: '把机身原地转到指定航向(度,0=初始朝向,顺时针)。全景拍摄的水平覆盖就是靠它逐格转动。',
    inputSchema: {
      type: 'object',
      properties: { heading: { type: 'number', description: '目标航向(度)' } },
      required: ['heading'],
      additionalProperties: false,
    },
  },
  {
    name: 'drone_camera_mode',
    description: '切换观察视角:orbit(环绕)/ follow(跟随)/ fpv(机载第一人称)。',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['orbit', 'follow', 'fpv'] } },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'drone_capture_photo',
    description:
      '用虚拟相机拍一张照片并落盘(未飞行会自动起飞)。可选 pitch 指定取景俯仰角。返回文件路径与拍摄时的位姿元数据。',
    inputSchema: {
      type: 'object',
      properties: { pitch: { type: 'number', description: '取景俯仰角(度),不传用当前云台俯仰' } },
      additionalProperties: false,
    },
  },
  {
    name: 'drone_panorama',
    description:
      '拍摄并拼接全景。pano-wide = 3x3 共 9 张;pano-180 = 7x3 共 21 张;pano-360 = 8 方位,俯仰环拍层数按相机垂直视场自动计算,另补天顶/天底,实际张数随相机视场变化。360 输出 2:1 整球,广角/180 输出局部投影。未飞行会自动起飞。返回 PNG 路径、实际张数与有效覆盖率。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['pano-wide', 'pano-180', 'pano-360'], description: '默认 pano-360' },
        shotIntervalMs: { type: 'number', description: '每张间隔毫秒,默认 0' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'drone_screenshot',
    description: '对当前三维画面截图,以图片形式返回(可在调用前切换视角)。用于查看场景、验证飞行姿态。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['orbit', 'follow', 'fpv'], description: '先切到这个视角再截' },
        name: { type: 'string', description: '文件名(可选)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'drone_viewer_shot',
    description:
      '用 360 球面查看器打开一张本地等距柱状全景图,按指定方位角/仰角/视野取景并截图返回。用于"拍完自查":指定角度检查全景内容(接缝、覆盖、构图)。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '全景图路径(通常是 drone_panorama 返回的 file)' },
        yaw: { type: 'number', description: '方位角(度),默认 0' },
        pitch: { type: 'number', description: '仰角(度,向上为正),默认 0' },
        fov: { type: 'number', description: '垂直视野(度,25~110),默认 75' },
        name: { type: 'string', description: '截图文件名(可选)' },
      },
      required: ['file'],
      additionalProperties: false,
    },
  },
  {
    name: 'drone_sessions',
    description: '列出全部采集会话(id/名称/状态/张数/创建时间)。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'drone_session_export',
    description: '导出一个采集会话的元数据(每张照片的位姿/网格位置)为 JSON 或 CSV 文件。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '会话 id(drone_sessions 里拿)' },
        format: { type: 'string', enum: ['json', 'csv'], description: '默认 json' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'drone_session_photos',
    description: '把某个会话(可选某个全景组)的全部照片落盘,返回文件清单。用于逐张核查画质。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        group: { type: 'string', description: '全景组 id(可选,不传=整个会话)' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'drone_shutdown',
    description: '关掉后台的无头渲染进程(vite + chromium),释放资源。会话空闲 10 分钟也会自动关。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

/** 截图类工具把文件读回来以 image content 返回,AI 直接能"看" */
function fileToImageContent(file) {
  try {
    const data = readFileSync(file).toString('base64')
    return { type: 'image', data, mimeType: 'image/png' }
  } catch {
    return null
  }
}

function toolResult(payload) {
  // 文本永远给全量结果(含 file 路径);截图类工具再附一张 image content,AI 直接能看
  const content = [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
  if (payload.ok !== false && payload.file && String(payload.file).endsWith('.png')) {
    const image = fileToImageContent(String(payload.file))
    if (image) content.push(image)
  }
  return { content, isError: payload.ok === false }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handleRequest(message) {
  const { id, method, params = {} } = message
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          '无人机控制系统无头驱动。典型流程:drone_takeoff -> drone_panorama -> drone_viewer_shot 自查 -> drone_land。',
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      const name = String(params.name ?? '')
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) throw new Error(`未知工具: ${name}`)
      const args = params.arguments ?? {}
      // 工具名 drone_xxx -> 驱动命令 xxx
      const result = await runCommand({ cmd: name.replace(/^drone_/, ''), ...args })
      return toolResult(result)
    }
    case 'resources/list':
      return { resources: [] }
    case 'prompts/list':
      return { prompts: [] }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
  }
}

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', async (line) => {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  // 通知(没有 id)不回包
  if (message.id === undefined || message.id === null) return
  try {
    const result = await handleRequest(message)
    send({ jsonrpc: '2.0', id: message.id, result })
  } catch (err) {
    const code = typeof err?.code === 'number' ? err.code : -32603
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code, message: err instanceof Error ? err.message : String(err) },
    })
  }
})

rl.on('close', () => process.exit(0))
process.stderr.write(`[drone-mcp] ${SERVER_INFO.name} v${SERVER_INFO.version} 就绪(stdio,等 AI 客户端连接)\n`)
