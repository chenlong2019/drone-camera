import { CaptureAgent } from './runtime.mjs'
import { TASK_SCHEMA } from './task.mjs'

const taskId = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$' }
const idSchema = { type: 'object', properties: { taskId }, required: ['taskId'], additionalProperties: false }
export const AGENT_TOOLS = [
  { name: 'agent_prepare', description: '校验并保存仿真采集计划。固定 city 场景，坐标为机体 ENU 米制；不会启动飞行。', inputSchema: TASK_SCHEMA },
  { name: 'agent_run', description: '执行或恢复已保存任务。默认每次采集一个拍点，返回 paused 后继续调用即可；已有有效图片复用。仅内置仿真。',
    inputSchema: { ...idSchema, properties: { taskId, maxShots: { type: 'integer', minimum: 1, maximum: 20, default: 1 } } } },
  { name: 'agent_status', description: '读取磁盘检查点、完成数量、错误和最终数据包地址，不启动浏览器。', inputSchema: idSchema },
  { name: 'agent_pause', description: '请求暂停，当前拍点落盘后生效。可再次 agent_run 恢复。', inputSchema: idSchema },
  { name: 'agent_validate', description: '核对已保存图片的 SHA-256、位姿、内参和计划完整性，返回质量报告。', inputSchema: idSchema },
]
const agent = new CaptureAgent()
let active = null

export async function callAgentTool(name, args) {
  if (name === 'agent_prepare') return agent.prepare(args)
  const allowed = name === 'agent_run' ? ['taskId', 'maxShots'] : ['taskId']
  if (!args || Object.keys(args).some((k) => !allowed.includes(k))) throw new Error('Invalid Agent tool arguments')
  if (name === 'agent_status') return agent.status(args.taskId)
  if (name === 'agent_pause') return agent.pause(args.taskId)
  if (name === 'agent_validate') return agent.validate(args.taskId)
  if (name !== 'agent_run') throw new Error('Unknown Agent tool')
  if (active) throw new Error('Another Agent execution is running; use agent_status or agent_pause')
  const maxShots = args.maxShots ?? 1
  if (!Number.isInteger(maxShots) || maxShots < 1 || maxShots > 20) throw new Error('maxShots must be 1–20')
  const controller = new AbortController()
  const promise = agent.run(args.taskId, { maxShots, signal: controller.signal })
  active = { promise, controller }
  try { return await promise } finally { active = null }
}

export async function shutdownAgent() {
  if (!active) return
  active.controller.abort()
  await active.promise.catch(() => {})
}
