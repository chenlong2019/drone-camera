/**
 * 3D Gaussian Splatting 数据层:解析 .ply(3DGS 标准输出)与 .splat,提供投影数学。
 *
 * 为什么单独一层:解析与"怎么画"无关。查看器需要的是四个扁平数组(位置 / 尺度 / 旋转 /
 * 颜色),而文件格式有三种常见来源:
 *
 * 1. **3DGS 训练器输出的 .ply** —— `scale_*` 存的是 **log σ**、`opacity` 存的是 **logit**、
 *    颜色存在 **球谐 DC 系数**里。这三处都必须在读入时还原,否则看到的是"一坨黑点、
 *    大小完全不对"——这是接 3DGS 时最常见的第一个坑。
 * 2. **.splat**(antimatter15 格式) —— 32 字节定长记录,scale 已是线性的、颜色/四元数是
 *    8 位量化。搬进浏览器最快的格式,但精度只有 8 位。
 * 3. **普通点云 .ply**(red/green/blue) —— 没有尺度和旋转。这里按各向同性小球处理,
 *    半径由点云包围盒推出来;能看,但它不是 splat,只是"能看着确认位姿对不对"。
 *
 * 关于球谐:标准 3DGS 带 3 阶球谐(45 个 `f_rest_*`),能随视角变色。本模块**只解 DC 项**
 * (视角无关的基础色),并把丢弃的系数个数记在 `droppedShCoefficients` 里 —— 查看器 HUD 会
 * 显式标注,不让人误以为看到了完整效果。
 *
 * ```ts
 * const { cloud, format, warnings } = parseSplat(await file.arrayBuffer())
 * const box = cloud.bounds            // 自动取景用
 * ```
 */

/** 球谐 0 阶基函数。3DGS 存的是 `(color - 0.5) / SH_C0` 的系数。 */
export const SH_C0 = 0.28209479177387814

/** 一条 Gaussian 的扁平数据(全部按 splat 顺序连续存放,便于直接上传纹理) */
export interface SplatCloud {
  /** splat 数量 */
  count: number
  /** 位置 xyz,长度 count*3 */
  center: Float32Array
  /** 三维尺度 σ(已从 log 还原),长度 count*3 */
  scale: Float32Array
  /** 旋转四元数 wxyz(已归一化),长度 count*4 */
  rotation: Float32Array
  /** 线性 RGB + 不透明度(已从 logit 还原),长度 count*4 */
  rgba: Float32Array
  /** 球谐阶数:0 = 只有 DC 项 */
  shDegree: number
  /** 被丢弃的高阶球谐系数个数(每 splat) */
  droppedShCoefficients: number
  /** 数据来源描述(文件名 / 'sample') */
  name: string
  /** 包围盒,由 `computeSplatBounds` 填充 */
  bounds: SplatBounds
}

export interface SplatBounds {
  min: [number, number, number]
  max: [number, number, number]
  center: [number, number, number]
  /** 包围球半径(取包围盒对角线一半) */
  radius: number
}

export type SplatFormat = 'ply-binary' | 'ply-ascii' | 'splat'

export interface SplatParseResult {
  cloud: SplatCloud
  format: SplatFormat
  /** 不影响渲染、但值得提醒的事(丢球谐、点云降级、数值截断等) */
  warnings: string[]
}

export interface SplatParseOptions {
  /** 数据来源名(文件名),用于标题与错误信息 */
  name?: string
  /** 点云(无尺度字段)时的统一半径;不传则按包围盒对角线 / 400 自动推 */
  pointRadius?: number
  /** 丢弃不透明度低于该值的 splat,默认 1/255(与渲染的 alpha 截断一致) */
  minOpacity?: number
}

/* ────────────────────────────── 解析 ────────────────────────────── */

const PLY_TYPE_SIZE: Record<string, number> = {
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
}

interface PlyProperty {
  name: string
  type: string
  size: number
  /** 相对元素起始的字节偏移 */
  offset: number
}

interface PlyElement {
  name: string
  count: number
  stride: number
  properties: PlyProperty[]
}

interface PlyHeader {
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian'
  elements: PlyElement[]
  /** 头部结束(含 `end_header\n`)的字节偏移 */
  dataOffset: number
}

function toUint8(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

/** 先看 magic 再决定走哪条解析路径;.splat 没有 magic,只能靠"长度是 32 的整数倍"认。 */
export function detectSplatFormat(data: ArrayBuffer | Uint8Array): SplatFormat | null {
  const bytes = toUint8(data)
  if (bytes.length >= 3 && bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79) return 'ply-binary'
  if (bytes.length > 0 && bytes.length % 32 === 0) return 'splat'
  return null
}

const END_HEADER = 'end_header'

/**
 * 按**字节**找 `end_header` 之后的第一个换行。
 *
 * 不能先 decode 成字符串再用 `indexOf` 的返回值当字节偏移:头部里一个中文注释能让
 * 字符下标比字节偏移小一大截,数据段整体错位,读出来的坐标是天文数字(实测 4.5e30)
 * —— 而且不会抛错,只会"画面完全不对",是最难查的一类 bug。
 */
function findDataOffset(bytes: Uint8Array): number {
  const limit = Math.min(bytes.length, 1 << 17)
  const needle = [...END_HEADER].map((char) => char.charCodeAt(0))
  for (let i = 0; i + needle.length <= limit; i += 1) {
    let matched = true
    for (let k = 0; k < needle.length; k += 1) {
      if (bytes[i + k] !== needle[k]) {
        matched = false
        break
      }
    }
    if (!matched) continue
    for (let k = i + needle.length; k < limit; k += 1) {
      if (bytes[k] === 0x0a) return k + 1
    }
  }
  throw new Error('PLY 头部不完整:找不到 end_header')
}

function readPlyHeader(bytes: Uint8Array): PlyHeader {
  const dataOffset = findDataOffset(bytes)
  const headerText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, dataOffset))
  const lines = headerText.split(/\r?\n/)
  if (!headerText.startsWith('ply')) throw new Error('PLY 头部不以 ply 开头')

  let format: PlyHeader['format'] | null = null
  const elements: PlyElement[] = []
  let current: PlyElement | null = null

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    const key = parts[0]
    if (key === 'format') {
      const value = parts[1]
      if (value === 'ascii' || value === 'binary_little_endian' || value === 'binary_big_endian') {
        format = value
      } else {
        throw new Error(`不支持的 PLY 格式:${String(value)}`)
      }
    } else if (key === 'element') {
      const name = parts[1] ?? ''
      const count = Number.parseInt(parts[2] ?? '0', 10)
      if (!Number.isFinite(count) || count < 0) throw new Error(`PLY 元素 ${name} 的数量无效`)
      current = { name, count, stride: 0, properties: [] }
      elements.push(current)
    } else if (key === 'property' && current) {
      // `property list <count-type> <item-type> <name>` 只出现在面片元素里,与顶点无关,跳过
      if (parts[1] === 'list') continue
      const type = parts[1] ?? ''
      const name = parts[2] ?? ''
      const size = PLY_TYPE_SIZE[type]
      if (size === undefined) throw new Error(`PLY 未知属性类型:${type}`)
      current.properties.push({ name, type, size, offset: current.stride })
      current.stride += size
    }
  }

  if (format === null) throw new Error('PLY 头部缺少 format 行')
  if (format === 'binary_big_endian') throw new Error('不支持 big-endian PLY(3DGS 输出均为 little-endian)')
  const vertex = elements.find((element) => element.name === 'vertex')
  if (!vertex) throw new Error('PLY 里没有 vertex 元素')
  if (vertex.count === 0) throw new Error('PLY 的 vertex 数量为 0')

  // 数据段从 end_header 的换行之后开始(字节偏移,见 findDataOffset)
  return { format, elements, dataOffset }
}

function readPlyValue(view: DataView, type: string, offset: number): number {
  switch (type) {
    case 'char':
    case 'int8':
      return view.getInt8(offset)
    case 'uchar':
    case 'uint8':
      return view.getUint8(offset)
    case 'short':
    case 'int16':
      return view.getInt16(offset, true)
    case 'ushort':
    case 'uint16':
      return view.getUint16(offset, true)
    case 'int':
    case 'int32':
      return view.getInt32(offset, true)
    case 'uint':
    case 'uint32':
      return view.getUint32(offset, true)
    case 'float':
    case 'float32':
      return view.getFloat32(offset, true)
    case 'double':
    case 'float64':
      return view.getFloat64(offset, true)
    default:
      return 0
  }
}

/** 3DGS 训练器输出里,顶点属性名的固定含义 */
const CENTER_KEYS = ['x', 'y', 'z'] as const
const SCALE_KEYS = ['scale_0', 'scale_1', 'scale_2'] as const
const ROTATION_KEYS = ['rot_0', 'rot_1', 'rot_2', 'rot_3'] as const
const DC_KEYS = ['f_dc_0', 'f_dc_1', 'f_dc_2'] as const

interface VertexLayout {
  element: PlyElement
  /** 数据段里该元素第一行的绝对字节偏移 */
  base: number
  center: [PlyProperty, PlyProperty, PlyProperty]
  scale: [PlyProperty, PlyProperty, PlyProperty] | null
  rotation: [PlyProperty, PlyProperty, PlyProperty, PlyProperty] | null
  opacity: PlyProperty | null
  dc: [PlyProperty, PlyProperty, PlyProperty] | null
  rgb: [PlyProperty, PlyProperty, PlyProperty] | null
  /** 每 splat 保留的高阶球谐系数个数 */
  restCount: number
  /** 由 `f_rest_*` 的个数反推的球谐阶数 */
  shDegree: number
}

function propOf(element: PlyElement, name: string): PlyProperty | null {
  return element.properties.find((property) => property.name === name) ?? null
}

function tuple3(element: PlyElement, names: readonly [string, string, string]): [PlyProperty, PlyProperty, PlyProperty] | null {
  const a = propOf(element, names[0])
  const b = propOf(element, names[1])
  const c = propOf(element, names[2])
  return a && b && c ? [a, b, c] : null
}

function layoutOf(header: PlyHeader, warnings: string[]): VertexLayout {
  const vertex = header.elements.find((element) => element.name === 'vertex')
  if (!vertex) throw new Error('PLY 里没有 vertex 元素')

  let base = header.dataOffset
  for (const element of header.elements) {
    if (element === vertex) break
    base += element.count * element.stride
  }

  const center = tuple3(vertex, CENTER_KEYS)
  if (!center) throw new Error('PLY 顶点缺少 x/y/z')

  const scale = tuple3(vertex, SCALE_KEYS)
  const rotation = (() => {
    const values = ROTATION_KEYS.map((key) => propOf(vertex, key))
    if (values.some((value) => value === null)) return null
    return values as [PlyProperty, PlyProperty, PlyProperty, PlyProperty]
  })()
  const dc = tuple3(vertex, DC_KEYS)
  const rgb = tuple3(vertex, ['red', 'green', 'blue'] as const)
  const opacity = propOf(vertex, 'opacity')

  if (!scale) warnings.push('PLY 没有 scale_* 字段,按点云处理:所有 splat 用同一半径')
  if (!rotation) warnings.push('PLY 没有 rot_* 字段,按点云处理:所有 splat 各向同性')

  const restCount = vertex.properties.filter((property) => property.name.startsWith('f_rest_')).length
  let shDegree = 0
  if (restCount >= 45) shDegree = 3
  else if (restCount >= 24) shDegree = 2
  else if (restCount >= 9) shDegree = 1

  return { element: vertex, base, center, scale, rotation, opacity, dc, rgb, restCount, shDegree }
}

interface RawVertex {
  count: number
  center: Float32Array
  scale: Float32Array | null
  rotation: Float32Array | null
  rgba: Float32Array
}

function decodeScale(value: number): number {
  const linear = Math.exp(value)
  // 训练早期的极端值会炸成 Infinity,夹一下免得整个场景被一个 splat 铺满
  return Number.isFinite(linear) ? Math.min(Math.max(linear, 1e-6), 1e4) : 1e-6
}

function decodeOpacity(value: number): number {
  if (!Number.isFinite(value)) return 0
  return 1 / (1 + Math.exp(-value))
}

/** 3DGS:颜色 = 0.5 + SH_C0 * dc(线性),再夹到 [0,1] */
function decodeDc(value: number): number {
  return Math.min(1, Math.max(0, 0.5 + SH_C0 * value))
}

function readBinaryVertices(payload: DataView, layout: VertexLayout, warnings: string[]): RawVertex {
  const { element, base } = layout
  const count = element.count
  const stride = element.stride
  if (base + count * stride > payload.byteLength) {
    throw new Error(`PLY 数据被截断:需要 ${base + count * stride} 字节,实际 ${payload.byteLength}`)
  }

  const center = new Float32Array(count * 3)
  const scale = layout.scale ? new Float32Array(count * 3) : null
  const rotation = layout.rotation ? new Float32Array(count * 4) : null
  const rgba = new Float32Array(count * 4)

  const [px, py, pz] = layout.center
  const scaleProps = layout.scale
  const rotationProps = layout.rotation
  const opacityProp = layout.opacity
  const dcProps = layout.dc
  const rgbProps = layout.rgb
  const rgbIsByte = rgbProps !== null && rgbProps[0].size === 1

  for (let i = 0; i < count; i += 1) {
    const row = base + i * stride
    center[i * 3] = readPlyValue(payload, px.type, row + px.offset)
    center[i * 3 + 1] = readPlyValue(payload, py.type, row + py.offset)
    center[i * 3 + 2] = readPlyValue(payload, pz.type, row + pz.offset)

    if (scale && scaleProps) {
      scale[i * 3] = decodeScale(readPlyValue(payload, scaleProps[0].type, row + scaleProps[0].offset))
      scale[i * 3 + 1] = decodeScale(readPlyValue(payload, scaleProps[1].type, row + scaleProps[1].offset))
      scale[i * 3 + 2] = decodeScale(readPlyValue(payload, scaleProps[2].type, row + scaleProps[2].offset))
    }
    if (rotation && rotationProps) {
      rotation[i * 4] = readPlyValue(payload, rotationProps[0].type, row + rotationProps[0].offset)
      rotation[i * 4 + 1] = readPlyValue(payload, rotationProps[1].type, row + rotationProps[1].offset)
      rotation[i * 4 + 2] = readPlyValue(payload, rotationProps[2].type, row + rotationProps[2].offset)
      rotation[i * 4 + 3] = readPlyValue(payload, rotationProps[3].type, row + rotationProps[3].offset)
    }

    let alpha = 1
    if (opacityProp) alpha = decodeOpacity(readPlyValue(payload, opacityProp.type, row + opacityProp.offset))

    if (dcProps) {
      rgba[i * 4] = decodeDc(readPlyValue(payload, dcProps[0].type, row + dcProps[0].offset))
      rgba[i * 4 + 1] = decodeDc(readPlyValue(payload, dcProps[1].type, row + dcProps[1].offset))
      rgba[i * 4 + 2] = decodeDc(readPlyValue(payload, dcProps[2].type, row + dcProps[2].offset))
    } else if (rgbProps) {
      const divisor = rgbIsByte ? 255 : 1
      rgba[i * 4] = readPlyValue(payload, rgbProps[0].type, row + rgbProps[0].offset) / divisor
      rgba[i * 4 + 1] = readPlyValue(payload, rgbProps[1].type, row + rgbProps[1].offset) / divisor
      rgba[i * 4 + 2] = readPlyValue(payload, rgbProps[2].type, row + rgbProps[2].offset) / divisor
    } else {
      warnings.push('PLY 既无 f_dc_* 也无 red/green/blue,统一显示为灰色')
      rgba[i * 4] = 0.7
      rgba[i * 4 + 1] = 0.72
      rgba[i * 4 + 2] = 0.75
    }
    rgba[i * 4 + 3] = alpha
  }

  return { count, center, scale, rotation, rgba }
}

function readAsciiVertices(
  text: string,
  layout: VertexLayout,
  elements: readonly PlyElement[],
  warnings: string[],
): RawVertex {
  const { element } = layout
  // ASCII 的所有元素混在一段文本里:先把 vertex 之前的元素跳过
  const tokens = text.split(/\s+/).filter((token) => token.length > 0)
  const names = element.properties.map((property) => property.name)
  const indexOf = (name: string): number => names.indexOf(name)

  let cursor = 0
  for (const other of elements) {
    if (other === element) break
    cursor += other.count * other.properties.length
  }

  const count = element.count
  const need = count * names.length
  if (cursor + need > tokens.length) {
    throw new Error(`ASCII PLY 数据不完整:需要 ${cursor + need} 个数值,实际 ${tokens.length}`)
  }

  const center = new Float32Array(count * 3)
  const scale = layout.scale ? new Float32Array(count * 3) : null
  const rotation = layout.rotation ? new Float32Array(count * 4) : null
  const rgba = new Float32Array(count * 4)

  const ix = indexOf('x')
  const iy = indexOf('y')
  const iz = indexOf('z')
  const iScale = layout.scale ? ['scale_0', 'scale_1', 'scale_2'].map(indexOf) : null
  const iRot = layout.rotation ? ['rot_0', 'rot_1', 'rot_2', 'rot_3'].map(indexOf) : null
  const iDc = layout.dc ? ['f_dc_0', 'f_dc_1', 'f_dc_2'].map(indexOf) : null
  const iRgb = layout.rgb ? ['red', 'green', 'blue'].map(indexOf) : null
  const rgbIsByte = layout.rgb !== null && layout.rgb[0].size === 1
  const iOpacity = layout.opacity ? indexOf('opacity') : -1

  const num = (index: number): number => Number.parseFloat(tokens[cursor + index] ?? '0')

  for (let i = 0; i < count; i += 1) {
    center[i * 3] = num(ix)
    center[i * 3 + 1] = num(iy)
    center[i * 3 + 2] = num(iz)
    if (scale && iScale) {
      scale[i * 3] = decodeScale(num(iScale[0] ?? -1))
      scale[i * 3 + 1] = decodeScale(num(iScale[1] ?? -1))
      scale[i * 3 + 2] = decodeScale(num(iScale[2] ?? -1))
    }
    if (rotation && iRot) {
      rotation[i * 4] = num(iRot[0] ?? -1)
      rotation[i * 4 + 1] = num(iRot[1] ?? -1)
      rotation[i * 4 + 2] = num(iRot[2] ?? -1)
      rotation[i * 4 + 3] = num(iRot[3] ?? -1)
    }
    rgba[i * 4 + 3] = iOpacity >= 0 ? decodeOpacity(num(iOpacity)) : 1
    if (iDc) {
      rgba[i * 4] = decodeDc(num(iDc[0] ?? -1))
      rgba[i * 4 + 1] = decodeDc(num(iDc[1] ?? -1))
      rgba[i * 4 + 2] = decodeDc(num(iDc[2] ?? -1))
    } else if (iRgb) {
      const divisor = rgbIsByte ? 255 : 1
      rgba[i * 4] = num(iRgb[0] ?? -1) / divisor
      rgba[i * 4 + 1] = num(iRgb[1] ?? -1) / divisor
      rgba[i * 4 + 2] = num(iRgb[2] ?? -1) / divisor
    } else {
      warnings.push('PLY 既无 f_dc_* 也无 red/green/blue,统一显示为灰色')
      rgba[i * 4] = 0.7
      rgba[i * 4 + 1] = 0.72
      rgba[i * 4 + 2] = 0.75
    }
    cursor += names.length
  }

  return { count, center, scale, rotation, rgba }
}

/** .splat:32 字节定长记录,scale 已是线性,颜色 / 四元数是 8 位量化 */
function readSplatRecords(bytes: Uint8Array): RawVertex {
  if (bytes.length % 32 !== 0) throw new Error('.splat 文件长度必须是 32 的整数倍')
  const count = bytes.length / 32
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const center = new Float32Array(count * 3)
  const scale = new Float32Array(count * 3)
  const rotation = new Float32Array(count * 4)
  const rgba = new Float32Array(count * 4)

  for (let i = 0; i < count; i += 1) {
    const row = i * 32
    center[i * 3] = view.getFloat32(row, true)
    center[i * 3 + 1] = view.getFloat32(row + 4, true)
    center[i * 3 + 2] = view.getFloat32(row + 8, true)
    // .splat 的 scale 已经是 σ,不再取指数
    scale[i * 3] = Math.min(Math.max(view.getFloat32(row + 12, true), 1e-6), 1e4)
    scale[i * 3 + 1] = Math.min(Math.max(view.getFloat32(row + 16, true), 1e-6), 1e4)
    scale[i * 3 + 2] = Math.min(Math.max(view.getFloat32(row + 20, true), 1e-6), 1e4)
    rgba[i * 4] = view.getUint8(row + 24) / 255
    rgba[i * 4 + 1] = view.getUint8(row + 25) / 255
    rgba[i * 4 + 2] = view.getUint8(row + 26) / 255
    rgba[i * 4 + 3] = view.getUint8(row + 27) / 255
    for (let k = 0; k < 4; k += 1) {
      const raw = view.getUint8(row + 28 + k)
      // 参考实现的解码是 (raw-128)/128,值域 [-1, 0.9922]:恒等旋转(w=1 → raw=255)
      // **必然**落在正边界上 —— 这不是数据坏了,是这个 8 位格式的固有量化。
      // 所以这里不做"到达边界就警告"的检查:那会对每一个正常文件都误报。
      rotation[i * 4 + k] = (raw - 128) / 128
    }
  }

  return { count, center, scale, rotation, rgba }
}

function normalizeQuaternions(rotation: Float32Array, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const w = rotation[i * 4]
    const x = rotation[i * 4 + 1]
    const y = rotation[i * 4 + 2]
    const z = rotation[i * 4 + 3]
    const length = Math.hypot(w ?? 0, x ?? 0, y ?? 0, z ?? 0)
    if (!Number.isFinite(length) || length < 1e-8) {
      rotation[i * 4] = 1
      rotation[i * 4 + 1] = 0
      rotation[i * 4 + 2] = 0
      rotation[i * 4 + 3] = 0
      continue
    }
    rotation[i * 4] = (w ?? 0) / length
    rotation[i * 4 + 1] = (x ?? 0) / length
    rotation[i * 4 + 2] = (y ?? 0) / length
    rotation[i * 4 + 3] = (z ?? 0) / length
  }
}

/** 计算包围盒;空点云返回零盒而不是 NaN,调用方不必再判空 */
export function computeSplatBounds(center: Float32Array, count: number): SplatBounds {
  if (count <= 0) {
    return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], radius: 0 }
  }
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < count; i += 1) {
    const x = center[i * 3] ?? 0
    const y = center[i * 3 + 1] ?? 0
    const z = center[i * 3 + 2] ?? 0
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ)
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    radius: diagonal / 2,
  }
}

function defaultPointRadius(bounds: SplatBounds): number {
  const diagonal = bounds.radius * 2
  return diagonal > 0 ? Math.max(diagonal / 400, 1e-4) : 0.01
}

/**
 * 解析 .ply(3DGS / 点云)或 .splat。
 *
 * 三条路径共用同一份输出结构,调用方不必关心来源——这是"查看器只认 SplatCloud"的前提。
 */
export function parseSplat(
  data: ArrayBuffer | Uint8Array,
  options: SplatParseOptions = {},
): SplatParseResult {
  const bytes = toUint8(data)
  if (bytes.length === 0) throw new Error('数据为空')
  const warnings: string[] = []
  const name = options.name ?? ''

  const format = detectSplatFormat(bytes)
  let raw: RawVertex
  let shDegree = 0
  let dropped = 0
  let resolvedFormat: SplatFormat

  if (format === 'splat') {
    raw = readSplatRecords(bytes)
    resolvedFormat = 'splat'
  } else if (format === 'ply-binary') {
    const header = readPlyHeader(bytes)
    const layout = layoutOf(header, warnings)
    resolvedFormat = header.format === 'ascii' ? 'ply-ascii' : 'ply-binary'
    shDegree = layout.shDegree
    dropped = layout.restCount
    if (header.format === 'ascii') {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(header.dataOffset))
      raw = readAsciiVertices(text, layout, header.elements, warnings)
    } else {
      raw = readBinaryVertices(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), layout, warnings)
    }
  } else {
    throw new Error('无法识别的格式:只支持 3DGS .ply 与 .splat')
  }

  const count = raw.count
  if (count === 0) throw new Error('没有读到任何 splat')

  const bounds = computeSplatBounds(raw.center, count)
  const rotation = raw.rotation ?? new Float32Array(count * 4)
  if (!raw.rotation) {
    for (let i = 0; i < count; i += 1) rotation[i * 4] = 1
  }
  normalizeQuaternions(rotation, count)

  let scale = raw.scale
  if (!scale) {
    const radius = options.pointRadius ?? defaultPointRadius(bounds)
    scale = new Float32Array(count * 3)
    for (let i = 0; i < count; i += 1) {
      scale[i * 3] = radius
      scale[i * 3 + 1] = radius
      scale[i * 3 + 2] = radius
    }
  }

  // 球谐高阶系数直接丢弃,但要说清丢了多少 —— 沉默降级会让"效果不对"变成玄学
  if (dropped > 0) {
    warnings.push(`已丢弃 ${dropped} 个高阶球谐系数(每 splat),只渲染 DC 基础色:旋转视角不会变色`)
  }

  const cloud: SplatCloud = {
    count,
    center: raw.center,
    scale,
    rotation,
    rgba: raw.rgba,
    shDegree,
    droppedShCoefficients: dropped,
    name,
    bounds,
  }

  const minOpacity = options.minOpacity ?? 1 / 255
  const filtered = filterByOpacity(cloud, minOpacity)
  return { cloud: filtered.cloud, format: resolvedFormat, warnings: filtered.removed > 0
      ? [...warnings, `已剔除 ${filtered.removed} 个几乎透明的 splat(不透明度 < ${minOpacity.toFixed(4)})`]
      : warnings }
}

/** 剔除透明 splat:它们不改变画面,却要参与排序与光栅化 */
function filterByOpacity(cloud: SplatCloud, minOpacity: number): { cloud: SplatCloud; removed: number } {
  if (minOpacity <= 0) return { cloud, removed: 0 }
  let keep = 0
  for (let i = 0; i < cloud.count; i += 1) {
    if ((cloud.rgba[i * 4 + 3] ?? 0) >= minOpacity) keep += 1
  }
  if (keep === cloud.count) return { cloud, removed: 0 }
  if (keep === 0) throw new Error('所有 splat 的不透明度都低于阈值,没有可显示的内容')

  const center = new Float32Array(keep * 3)
  const scale = new Float32Array(keep * 3)
  const rotation = new Float32Array(keep * 4)
  const rgba = new Float32Array(keep * 4)
  let write = 0
  for (let i = 0; i < cloud.count; i += 1) {
    if ((cloud.rgba[i * 4 + 3] ?? 0) < minOpacity) continue
    for (let k = 0; k < 3; k += 1) {
      center[write * 3 + k] = cloud.center[i * 3 + k] ?? 0
      scale[write * 3 + k] = cloud.scale[i * 3 + k] ?? 0
    }
    for (let k = 0; k < 4; k += 1) {
      rotation[write * 4 + k] = cloud.rotation[i * 4 + k] ?? 0
      rgba[write * 4 + k] = cloud.rgba[i * 4 + k] ?? 0
    }
    write += 1
  }
  return {
    cloud: { ...cloud, count: keep, center, scale, rotation, rgba, bounds: computeSplatBounds(center, keep) },
    removed: cloud.count - keep,
  }
}

/**
 * 编码成 .splat(32 字节/条)。反向用途有两处:把解析结果另存,以及测试里造样本 ——
 * 有了它,验证脚本不需要仓库里躺一个二进制大文件。
 */
export function encodeSplatBinary(cloud: SplatCloud): Uint8Array {
  const bytes = new Uint8Array(cloud.count * 32)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < cloud.count; i += 1) {
    const row = i * 32
    view.setFloat32(row, cloud.center[i * 3] ?? 0, true)
    view.setFloat32(row + 4, cloud.center[i * 3 + 1] ?? 0, true)
    view.setFloat32(row + 8, cloud.center[i * 3 + 2] ?? 0, true)
    view.setFloat32(row + 12, cloud.scale[i * 3] ?? 0, true)
    view.setFloat32(row + 16, cloud.scale[i * 3 + 1] ?? 0, true)
    view.setFloat32(row + 20, cloud.scale[i * 3 + 2] ?? 0, true)
    for (let k = 0; k < 4; k += 1) {
      const value = Math.round((cloud.rgba[i * 4 + k] ?? 0) * 255)
      view.setUint8(row + 24 + k, Math.min(255, Math.max(0, value)))
    }
    for (let k = 0; k < 4; k += 1) {
      const q = cloud.rotation[i * 4 + k] ?? 0
      const raw = Math.round(q * 128 + 128)
      view.setUint8(row + 28 + k, Math.min(255, Math.max(0, raw)))
    }
  }
  return bytes
}

/**
 * 把 SplatCloud 导出成普通点云 PLY(ASCII)。位置保留毫米精度,颜色按 PLY
 * 惯例写成 0~255 的 red/green/blue;只丢弃尺度和朝向,适合覆盖采样、稀疏点
 * 等本来就按点显示的数据。完整 3DGS 仍应导出训练器自己的二进制 PLY。
 */
export function encodePointCloudPly(cloud: SplatCloud): string {
  const rows: string[] = [
    'ply',
    'format ascii 1.0',
    `comment ${cloud.name}`,
    `element vertex ${cloud.count}`,
    'property float x',
    'property float y',
    'property float z',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    'end_header',
  ]
  for (let i = 0; i < cloud.count; i += 1) {
    const byte = (index: number): number => {
      const value = Math.round((cloud.rgba[index] ?? 0) * 255)
      return Math.min(255, Math.max(0, value))
    }
    rows.push([
      (cloud.center[i * 3] ?? 0).toFixed(3),
      (cloud.center[i * 3 + 1] ?? 0).toFixed(3),
      (cloud.center[i * 3 + 2] ?? 0).toFixed(3),
      byte(i * 4),
      byte(i * 4 + 1),
      byte(i * 4 + 2),
    ].join(' '))
  }
  return `${rows.join('\n')}\n`
}

/* ──────────────────────── 投影数学(与着色器同源) ──────────────────────── */

export type Mat3 = readonly [number, number, number, number, number, number, number, number, number]
export type Vec3 = readonly [number, number, number]
export type Quat = readonly [number, number, number, number]

/** 四元数(wxyz)→ 行优先 3×3 旋转矩阵 */
export function quaternionToMat3(q: Quat): Mat3 {
  const [w, x, y, z] = q
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
  ]
}

function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
  const out = Array.from({ length: 9 }, () => 0)
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      let sum = 0
      for (let k = 0; k < 3; k += 1) sum += (a[row * 3 + k] ?? 0) * (b[k * 3 + col] ?? 0)
      out[row * 3 + col] = sum
    }
  }
  return out as unknown as Mat3
}

/**
 * 把一条 Gaussian 投影成屏幕上的椭圆(像素单位半轴)。
 *
 * 与 3DGS 论文的 EWA splatting 同一套推导:
 *   Σ_cam = (V·R)·diag(σ²)·(V·R)ᵀ        世界系各向异性 → 相机系
 *   J     = ∂(u,v)/∂(x,y,z) = [[f/z, 0, -f·x/z²], [0, f/z, -f·y/z²]]
 *   Σ_2D  = J·Σ_cam·Jᵀ                    透视投影的局部线性化
 * 再对 2×2 对称阵做特征分解,得到两根正交半轴与长度。
 *
 * `minVariance` 对应论文里的低通项(默认 0.3 像素²):不加它,远处 splat 的投影面积会小于
 * 一个像素,于是闪烁、锯齿、深度排序抖动 —— 这是"远处点像噪点"的根因。
 */
export function splatScreenAxes(
  viewRotation: Mat3,
  centerCamera: Vec3,
  scale: Vec3,
  quaternion: Quat,
  focalPx: number,
  minVariance = 0,
): { axis1: [number, number]; axis2: [number, number]; majorPx: number; minorPx: number } | null {
  const [cx, cy, cz] = centerCamera
  if (!(cz > 1e-6)) return null

  const rotation = quaternionToMat3(quaternion)
  const view = mat3Multiply(viewRotation, rotation)

  // M = V·R,列向量分别乘以 σ 后,Σ = M·Mᵀ
  const m00 = (view[0] ?? 0) * scale[0]
  const m10 = (view[3] ?? 0) * scale[0]
  const m20 = (view[6] ?? 0) * scale[0]
  const m01 = (view[1] ?? 0) * scale[1]
  const m11 = (view[4] ?? 0) * scale[1]
  const m21 = (view[7] ?? 0) * scale[1]
  const m02 = (view[2] ?? 0) * scale[2]
  const m12 = (view[5] ?? 0) * scale[2]
  const m22 = (view[8] ?? 0) * scale[2]

  const c00 = m00 * m00 + m01 * m01 + m02 * m02
  const c01 = m00 * m10 + m01 * m11 + m02 * m12
  const c02 = m00 * m20 + m01 * m21 + m02 * m22
  const c11 = m10 * m10 + m11 * m11 + m12 * m12
  const c12 = m10 * m20 + m11 * m21 + m12 * m22
  const c22 = m20 * m20 + m21 * m21 + m22 * m22

  const jx = focalPx / cz
  const jz = jx
  // J 的两行:[jx, 0, -jx·x/z]、[0, jz, -jz·y/z]
  const t0x = jx
  const t0z = -jx * cx / cz
  const t1y = jz
  const t1z = -jz * cy / cz

  // Σ2D = J Σ Jᵀ,先算 Σ·Jᵀ 的两列
  const a0 = c00 * t0x + c02 * t0z
  const a2 = c02 * t0x + c22 * t0z
  const b0 = c01 * t1y + c02 * t1z
  const b1 = c11 * t1y + c12 * t1z
  const b2 = c12 * t1y + c22 * t1z

  const sb = t0x * b0 + t0z * b2
  let sa = t0x * a0 + t0z * a2
  let sc = t1y * b1 + t1z * b2

  sa += minVariance
  sc += minVariance

  const mid = 0.5 * (sa + sc)
  const det = Math.max(0, sa * sc - sb * sb)
  const disc = Math.sqrt(Math.max(0, mid * mid - det))
  const l1 = mid + disc
  const l2 = Math.max(mid - disc, 0)

  const e1: [number, number] =
    Math.abs(sb) > 1e-12
      ? normalize2(sb, l1 - sa)
      : sa >= sc
        ? [1, 0]
        : [0, 1]
  const e2: [number, number] = [-e1[1], e1[0]]

  const r1 = Math.sqrt(Math.max(l1, 0))
  const r2 = Math.sqrt(l2)
  return {
    axis1: [e1[0] * r1, e1[1] * r1],
    axis2: [e2[0] * r2, e2[1] * r2],
    majorPx: r1,
    minorPx: r2,
  }
}

function normalize2(x: number, y: number): [number, number] {
  const length = Math.hypot(x, y)
  return length > 1e-12 ? [x / length, y / length] : [1, 0]
}

/** 由相机基(right / up / forward)构造 world→camera 的行优先旋转矩阵 */
export function viewRotationFromBasis(right: Vec3, up: Vec3, forward: Vec3): Mat3 {
  return [
    right[0], right[1], right[2],
    up[0], up[1], up[2],
    -forward[0], -forward[1], -forward[2],
  ]
}

/* ─────────────────────────────── 排序 ─────────────────────────────── */

/**
 * 按深度从远到近排序(LSD 基数排序,16 位一轮、两轮)。
 *
 * 为什么不直接用 `Array.prototype.sort`:每帧都要排一次,`sort` 对 5 万个元素约 8~12ms,
 * 而基数排序是 O(2n) 的计数排序,同样规模约 1~2ms —— 差别就是 60fps 与 40fps。
 * 排序本身不能省:alpha 混合不可交换,顺序错了近处会被远处盖住,表现为"半透明雾"。
 */
export class DepthSorter {
  private keys = new Uint32Array(0)
  private keysFloat!: Float32Array
  private tmpKeys = new Uint32Array(0)
  private tmpIndices = new Uint32Array(0)
  private indices = new Uint32Array(0)
  private readonly histogram = new Uint32Array(65536)

  get capacity(): number {
    return this.indices.length
  }

  ensureCapacity(count: number): void {
    if (this.indices.length >= count) return
    const size = Math.max(1024, 1 << Math.ceil(Math.log2(Math.max(count, 2))))
    this.keys = new Uint32Array(size)
    this.keysFloat = new Float32Array(this.keys.buffer)
    this.tmpKeys = new Uint32Array(size)
    this.tmpIndices = new Uint32Array(size)
    this.indices = new Uint32Array(size)
  }

  /**
   * @param depths 每条 splat 的相机空间深度(z 向前为正)
   * @returns 从远到近的下标数组(长度 = count,复用内部缓冲,下一次调用会被覆盖)
   */
  sort(depths: Float32Array, count: number): Uint32Array {
    this.ensureCapacity(count)
    const keys = this.keys
    const keysFloat = this.keysFloat
    const indices = this.indices

    for (let i = 0; i < count; i += 1) {
      const depth = depths[i] ?? 0
      // 只保留相机前方的深度为正;负值 / NaN 一律当 0,免得浮点位序里符号位破坏单调性
      keysFloat[i] = Number.isFinite(depth) && depth > 0 ? depth : 0
      // 浮点正数按位比较是单调的;取反变成"深度大 → 键小",升序排完即远→近
      keys[i] = ~(keys[i] ?? 0)
      indices[i] = i
    }

    let sourceKeys = keys
    let sourceIndices = indices
    let targetKeys = this.tmpKeys
    let targetIndices = this.tmpIndices

    for (let pass = 0; pass < 2; pass += 1) {
      const shift = pass * 16
      const histogram = this.histogram
      histogram.fill(0)
      for (let i = 0; i < count; i += 1) {
        const bucket = ((sourceKeys[i] ?? 0) >>> shift) & 0xffff
        histogram[bucket] = (histogram[bucket] ?? 0) + 1
      }
      let offset = 0
      for (let bucket = 0; bucket < 65536; bucket += 1) {
        const size = histogram[bucket] ?? 0
        histogram[bucket] = offset
        offset += size
      }
      for (let i = 0; i < count; i += 1) {
        const key = sourceKeys[i] ?? 0
        const bucket = (key >>> shift) & 0xffff
        const position = histogram[bucket] ?? 0
        targetKeys[position] = key
        targetIndices[position] = sourceIndices[i] ?? 0
        histogram[bucket] = position + 1
      }
      const nextKeys = sourceKeys
      const nextIndices = sourceIndices
      sourceKeys = targetKeys
      sourceIndices = targetIndices
      targetKeys = nextKeys
      targetIndices = nextIndices
    }

    // 两轮之后结果在 sourceIndices;若不是内部 indices,就搬回来
    if (sourceIndices !== indices) indices.set(sourceIndices.subarray(0, count))
    return indices.subarray(0, count)
  }
}

/** 一次性排序(测试 / 偶尔用);每帧排序请用 `DepthSorter` 复用缓冲 */
export function sortSplatIndices(depths: Float32Array, count: number): Uint32Array {
  return new DepthSorter().sort(depths, count).slice()
}

/* ───────────────────────── 示例重建数据 ───────────────────────── */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface SplatBuilder {
  push: (
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ) => void
}

function createBuilder(): { builder: SplatBuilder; finish: () => SplatCloud } {
  const center: number[] = []
  const scale: number[] = []
  const rotation: number[] = []
  const rgba: number[] = []
  const builder: SplatBuilder = {
    push(x, y, z, sx, sy, sz, r, g, b, a) {
      center.push(x, y, z)
      scale.push(sx, sy, sz)
      rotation.push(1, 0, 0, 0)
      rgba.push(r, g, b, a)
    },
  }
  const finish = (): SplatCloud => {
    const count = rgba.length / 4
    const centerArray = new Float32Array(center)
    return {
      count,
      center: centerArray,
      scale: new Float32Array(scale),
      rotation: new Float32Array(rotation),
      rgba: new Float32Array(rgba),
      shDegree: 0,
      droppedShCoefficients: 0,
      name: '示例重建数据',
      bounds: computeSplatBounds(centerArray, count),
    }
  }
  return { builder, finish }
}

/**
 * 生成一份"看起来像真重建"的示例数据:地形 + 两栋楼 + 一座水塔 + 一片树。
 *
 * 为什么不用示例 .ply:仓库里躺一个几十 MB 的二进制资产,既污染 git,又让"打开就能用"变成
 * "先去下载"。程序化生成是确定性的(固定种子),测试可以直接断言数量与包围盒。
 */
export function createReconstructionSample(options: { seed?: number } = {}): SplatCloud {
  const random = mulberry32(options.seed ?? 20261020)
  const { builder, finish } = createBuilder()

  // 1. 地形:60m × 60m,0.45m 网格;起伏用两个正弦叠加,颜色随高度在草绿与土黄之间过渡
  const half = 30
  const step = 0.45
  for (let x = -half; x <= half; x += step) {
    for (let z = -half; z <= half; z += step) {
      const height =
        Math.sin(x * 0.09) * 1.1 + Math.cos(z * 0.13) * 0.7 + Math.sin((x + z) * 0.21) * 0.25
      const noise = random() * 0.16
      const wet = Math.max(0, Math.min(1, 0.5 + height * 0.28))
      builder.push(
        x + (random() - 0.5) * step * 0.6,
        height + noise,
        z + (random() - 0.5) * step * 0.6,
        step * 0.62,
        step * 0.22,
        step * 0.62,
        0.24 + (1 - wet) * 0.22 + random() * 0.04,
        0.34 + wet * 0.26 + random() * 0.04,
        0.19 + (1 - wet) * 0.12,
        0.96,
      )
    }
  }

  // 2. 建筑:三个盒子,按外表面撒点(内部不铺,省一半以上的 splat)
  const blocks = [
    { x: 9, z: -7, w: 7, d: 9, h: 6.5, tone: [0.62, 0.64, 0.68] as const },
    { x: -12, z: 6, w: 9, d: 6, h: 4.2, tone: [0.55, 0.52, 0.5] as const },
    { x: 2, z: 17, w: 5, d: 5, h: 9.5, tone: [0.7, 0.68, 0.62] as const },
  ]
  for (const block of blocks) {
    const cell = 0.5
    const { x, z, w, d, h, tone } = block
    const x0 = x - w / 2
    const x1 = x + w / 2
    const z0 = z - d / 2
    const z1 = z + d / 2
    for (let u = 0; u <= 1.0001; u += cell / w) {
      for (let v = 0; v <= 1.0001; v += cell / d) {
        const px = x0 + u * w
        const pz = z0 + v * d
        // 顶面
        builder.push(px, h, pz, 0.34, 0.12, 0.34, tone[0] * 1.08, tone[1] * 1.08, tone[2] * 1.08, 0.97)
        // 底面(地面以下,给个暗色,俯视时不至于穿帮)
        builder.push(px, 0, pz, 0.34, 0.12, 0.34, tone[0] * 0.4, tone[1] * 0.4, tone[2] * 0.4, 0.5)
      }
    }
    for (let y = 0; y <= h; y += cell) {
      for (let u = 0; u <= 1.0001; u += cell / Math.max(w, d)) {
        const px = x0 + u * w
        const pz = z0 + u * d
        for (const [sx, sz, shade] of [
          [px, z0, 1.0],
          [px, z1, 0.82],
          [x0, pz, 0.9],
          [x1, pz, 0.74],
        ] as const) {
          builder.push(sx, y, sz, 0.3, 0.3, 0.12, tone[0] * shade, tone[1] * shade, tone[2] * shade, 0.97)
        }
      }
    }
  }

  // 3. 水塔:圆柱侧面 + 顶盖,给场景一个能看出"法线方向"的曲面
  const towerX = -6
  const towerZ = -16
  const towerR = 2.2
  const towerH = 11
  for (let y = 0; y <= towerH; y += 0.35) {
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 48) {
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const shade = 0.72 + 0.28 * Math.max(0, cos * 0.8 + sin * 0.4)
      builder.push(
        towerX + cos * towerR,
        y,
        towerZ + sin * towerR,
        0.26,
        0.26,
        0.1,
        0.55 * shade,
        0.57 * shade,
        0.6 * shade,
        0.97,
      )
    }
  }
  for (let r = 0; r <= towerR; r += 0.22) {
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / Math.max(8, Math.round((Math.PI * 2 * Math.max(r, 0.22)) / 0.24))) {
      builder.push(
        towerX + Math.cos(angle) * r,
        towerH + 0.4,
        towerZ + Math.sin(angle) * r,
        0.24,
        0.1,
        0.24,
        0.42,
        0.46,
        0.5,
        0.97,
      )
    }
  }

  // 4. 树:锥形冠层 + 细树干,顺带在场景里制造一些遮挡关系(排序错了立刻能看出来)
  for (let t = 0; t < 70; t += 1) {
    const angle = random() * Math.PI * 2
    const distance = 8 + random() * 22
    const tx = Math.cos(angle) * distance
    const tz = Math.sin(angle) * distance
    if (Math.abs(tx - 9) < 6 && Math.abs(tz + 7) < 7) continue
    const trunk = 1.6 + random() * 1.4
    const crown = 1.1 + random() * 0.9
    for (let y = 0; y < trunk; y += 0.4) {
      builder.push(tx, y, tz, 0.12, 0.22, 0.12, 0.28, 0.2, 0.14, 0.95)
    }
    for (let i = 0; i < 46; i += 1) {
      const spread = Math.cbrt(random()) * crown
      const theta = random() * Math.PI * 2
      const phi = Math.acos(1 - 2 * random())
      const ox = Math.sin(phi) * Math.cos(theta) * spread
      const oz = Math.sin(phi) * Math.sin(theta) * spread
      const oy = Math.cos(phi) * spread * 0.85
      builder.push(
        tx + ox,
        trunk + crown * 0.55 + oy,
        tz + oz,
        0.24,
        0.3,
        0.24,
        0.16 + random() * 0.08,
        0.30 + random() * 0.12,
        0.14 + random() * 0.06,
        0.94,
      )
    }
  }

  return finish()
}
