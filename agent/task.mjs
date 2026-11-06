import { createHash } from 'node:crypto'

export const SCENE_PATH = '/three-demo?model=husky&renderer=webgl&scenery=city&hdri=0'
export const SCENE_ID = 'three-demo-city-webgl-husky-v1'
export function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}
export function safeId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) {
    throw new Error('ID must contain 1–80 letters, digits, underscores or hyphens')
  }
  return value
}
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown field: ${key}`)
}
function number(value, low, high, name) {
  if (!Number.isFinite(value) || value < low || value > high) throw new Error(`Invalid ${name}: expected ${low}..${high}`)
  return value
}

/** Bounded structured task. Coordinates are BODY positions in ENU, in metres.
 * Captured camera centres are measured separately and never invented from the plan.
 */
export function validateTask(input) {
  fields(input, ['schemaVersion', 'taskId', 'sceneId', 'shots', 'maxAttempts'])
  if (input.schemaVersion !== 1 || input.sceneId !== SCENE_ID) throw new Error('Unsupported task version or sceneId')
  if (!Array.isArray(input.shots) || input.shots.length < 2 || input.shots.length > 200) throw new Error('Expected 2–200 shots')
  const ids = new Set()
  const shots = input.shots.map((shot) => {
    fields(shot, ['id', 'positionEnu', 'heading', 'pitch'])
    const id = safeId(shot.id)
    if (ids.has(id)) throw new Error(`Duplicate shot: ${id}`)
    ids.add(id)
    if (!Array.isArray(shot.positionEnu) || shot.positionEnu.length !== 3) throw new Error('positionEnu must be [east,north,up]')
    return {
      id,
      positionEnu: shot.positionEnu.map((v, i) => number(v, i === 2 ? 1 : -100, i === 2 ? 100 : 100, 'positionEnu')),
      heading: number(shot.heading, 0, 360, 'heading'),
      pitch: number(shot.pitch, -90, 60, 'pitch'),
    }
  })
  const maxAttempts = number(input.maxAttempts ?? 2, 1, 3, 'maxAttempts')
  if (!Number.isInteger(maxAttempts)) throw new Error('maxAttempts must be an integer')
  return { schemaVersion: 1, taskId: safeId(input.taskId), sceneId: SCENE_ID, maxAttempts, shots }
}

export const TASK_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 }, taskId: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$' },
    sceneId: { const: SCENE_ID }, maxAttempts: { type: 'integer', minimum: 1, maximum: 3 },
    shots: { type: 'array', minItems: 2, maxItems: 200, items: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$' },
        positionEnu: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        heading: { type: 'number', minimum: 0, maximum: 360 }, pitch: { type: 'number', minimum: -90, maximum: 60 },
      }, required: ['id', 'positionEnu', 'heading', 'pitch'],
    } },
  }, required: ['schemaVersion', 'taskId', 'sceneId', 'shots'],
}
