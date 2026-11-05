import { describe, expect, it } from 'vitest'
import {
  DepthSorter,
  SH_C0,
  computeSplatBounds,
  createReconstructionSample,
  detectSplatFormat,
  encodePointCloudPly,
  encodeSplatBinary,
  parseSplat,
  quaternionToMat3,
  sortSplatIndices,
  splatScreenAxes,
  viewRotationFromBasis,
} from '@/lib/drone-camera/drone-splat'
import type { Mat3, SplatCloud } from '@/lib/drone-camera/drone-splat'

/* ───────────────────────── PLY 构造工具 ───────────────────────── */

type PlyType = 'float' | 'uchar' | 'double'

interface PlyPropertyDef {
  name: string
  type: PlyType
}

const TYPE_SIZE: Record<PlyType, number> = { float: 4, uchar: 1, double: 8 }

function writeValue(view: DataView, offset: number, type: PlyType, value: number): void {
  if (type === 'float') view.setFloat32(offset, value, true)
  else if (type === 'uchar') view.setUint8(offset, value)
  else view.setFloat64(offset, value, true)
}

function buildPly(
  properties: PlyPropertyDef[],
  rows: number[][],
  format: 'binary_little_endian' | 'ascii' = 'binary_little_endian',
): Uint8Array {
  const headerLines = [
    'ply',
    `format ${format} 1.0`,
    'comment 由测试构造，用来验证 3DGS 的属性还原',
    `element vertex ${rows.length}`,
    ...properties.map((property) => `property ${property.type} ${property.name}`),
    'end_header',
  ]
  const header = `${headerLines.join('\n')}\n`
  const headerBytes = new TextEncoder().encode(header)

  if (format === 'ascii') {
    const body = rows.map((row) => row.join(' ')).join('\n')
    const bodyBytes = new TextEncoder().encode(`${body}\n`)
    const out = new Uint8Array(headerBytes.length + bodyBytes.length)
    out.set(headerBytes, 0)
    out.set(bodyBytes, headerBytes.length)
    return out
  }

  const stride = properties.reduce((sum, property) => sum + TYPE_SIZE[property.type], 0)
  const out = new Uint8Array(headerBytes.length + stride * rows.length)
  out.set(headerBytes, 0)
  const view = new DataView(out.buffer)
  rows.forEach((row, rowIndex) => {
    let offset = headerBytes.length + rowIndex * stride
    properties.forEach((property, column) => {
      writeValue(view, offset, property.type, row[column] ?? 0)
      offset += TYPE_SIZE[property.type]
    })
  })
  return out
}

const DGS_PROPERTIES: PlyPropertyDef[] = [
  { name: 'x', type: 'float' },
  { name: 'y', type: 'float' },
  { name: 'z', type: 'float' },
  { name: 'f_dc_0', type: 'float' },
  { name: 'f_dc_1', type: 'float' },
  { name: 'f_dc_2', type: 'float' },
  { name: 'opacity', type: 'float' },
  { name: 'scale_0', type: 'float' },
  { name: 'scale_1', type: 'float' },
  { name: 'scale_2', type: 'float' },
  { name: 'rot_0', type: 'float' },
  { name: 'rot_1', type: 'float' },
  { name: 'rot_2', type: 'float' },
  { name: 'rot_3', type: 'float' },
]

/** 一行 3DGS 顶点:x y z | f_dc rgb | opacity | 三个 log σ | 四元数 */
function dgsRow(
  x: number,
  y: number,
  z: number,
  dc: number,
  opacity: number,
  logScale: [number, number, number],
  quat: [number, number, number, number] = [1, 0, 0, 0],
): number[] {
  return [x, y, z, dc, dc, dc, opacity, ...logScale, ...quat]
}

function makeCloud(overrides: Partial<SplatCloud> = {}): SplatCloud {
  const count = overrides.count ?? 1
  return {
    count,
    center: new Float32Array([0, 0, 0]),
    scale: new Float32Array([0.1, 0.1, 0.1]),
    rotation: new Float32Array([1, 0, 0, 0]),
    rgba: new Float32Array([0.5, 0.5, 0.5, 1]),
    shDegree: 0,
    droppedShCoefficients: 0,
    name: 'test',
    bounds: computeSplatBounds(new Float32Array([0, 0, 0]), 1),
    ...overrides,
  }
}

/* ───────────────────────── 解析 ───────────────────────── */

describe('PLY 解析(3DGS 语义)', () => {
  it('scale_* 是 log σ、opacity 是 logit、颜色是球谐 DC —— 三处都要还原', () => {
    const ply = buildPly(DGS_PROPERTIES, [
      dgsRow(1, 2, 3, 1, 0, [0, Math.log(2), Math.log(0.5)]),
    ])
    const { cloud } = parseSplat(ply)

    expect(cloud.count).toBe(1)
    expect([cloud.center[0], cloud.center[1], cloud.center[2]]).toEqual([1, 2, 3])
    // exp(0)=1、exp(ln2)=2、exp(ln0.5)=0.5
    expect(cloud.scale[0]).toBeCloseTo(1, 6)
    expect(cloud.scale[1]).toBeCloseTo(2, 6)
    expect(cloud.scale[2]).toBeCloseTo(0.5, 6)
    // logit(0) = sigmoid(0) = 0.5
    expect(cloud.rgba[3]).toBeCloseTo(0.5, 6)
    // 0.5 + SH_C0 * dc
    expect(cloud.rgba[0]).toBeCloseTo(0.5 + SH_C0, 6)
  })

  it('四元数被归一化,并且还原成世界系姿态', () => {
    const ply = buildPly(DGS_PROPERTIES, [dgsRow(0, 0, 0, 0, 4, [0, 0, 0], [2, 0, 0, 0])])
    const { cloud } = parseSplat(ply)
    const [w, x, y, z] = [cloud.rotation[0], cloud.rotation[1], cloud.rotation[2], cloud.rotation[3]]
    expect(Math.hypot(w ?? 0, x ?? 0, y ?? 0, z ?? 0)).toBeCloseTo(1, 6)
    expect(w).toBeCloseTo(1, 6)
  })

  it('ASCII 与二进制产出完全一致的数值', () => {
    const rows = [
      dgsRow(0.5, -1.5, 2, 0.3, -2, [Math.log(0.2), Math.log(0.1), Math.log(0.4)]),
      dgsRow(-3, 0, 1, -0.5, 3, [Math.log(0.05), Math.log(0.05), Math.log(0.05)]),
    ]
    const binary = parseSplat(buildPly(DGS_PROPERTIES, rows)).cloud
    const ascii = parseSplat(buildPly(DGS_PROPERTIES, rows, 'ascii')).cloud

    expect(ascii.count).toBe(binary.count)
    for (let i = 0; i < binary.count; i += 1) {
      for (let k = 0; k < 3; k += 1) {
        expect(ascii.center[i * 3 + k]).toBeCloseTo(binary.center[i * 3 + k] ?? 0, 5)
        expect(ascii.scale[i * 3 + k]).toBeCloseTo(binary.scale[i * 3 + k] ?? 0, 5)
      }
      for (let k = 0; k < 4; k += 1) {
        expect(ascii.rgba[i * 4 + k]).toBeCloseTo(binary.rgba[i * 4 + k] ?? 0, 5)
      }
    }
  })

  it('球谐高阶系数被丢弃,但要说清丢了多少', () => {
    const properties: PlyPropertyDef[] = [
      ...DGS_PROPERTIES,
      ...Array.from({ length: 45 }, (_, index) => ({ name: `f_rest_${index}`, type: 'float' as PlyType })),
    ]
    const row = [...dgsRow(0, 0, 0, 0, 0, [0, 0, 0]), ...Array.from({ length: 45 }, () => 0)]
    const { cloud, warnings } = parseSplat(buildPly(properties, [row]))

    expect(cloud.shDegree).toBe(3)
    expect(cloud.droppedShCoefficients).toBe(45)
    expect(warnings.some((warning) => warning.includes('球谐'))).toBe(true)
  })

  it('普通点云(red/green/blue uchar)降级成各向同性小球', () => {
    const properties: PlyPropertyDef[] = [
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
      { name: 'red', type: 'uchar' },
      { name: 'green', type: 'uchar' },
      { name: 'blue', type: 'uchar' },
    ]
    const { cloud, warnings } = parseSplat(
      buildPly(properties, [
        [0, 0, 0, 255, 0, 0],
        [10, 0, 0, 0, 255, 0],
      ]),
    )

    expect(cloud.rgba[0]).toBeCloseTo(1, 6)
    expect(cloud.rgba[1]).toBeCloseTo(0, 6)
    expect(cloud.rgba[3]).toBeCloseTo(1, 6)
    // 三个轴同长 = 点云
    expect(cloud.scale[0]).toBeCloseTo(cloud.scale[1] ?? -1, 9)
    expect(cloud.scale[1]).toBeCloseTo(cloud.scale[2] ?? -1, 9)
    // 自动半径 = 对角线 / 400
    expect(cloud.scale[0]).toBeCloseTo(10 / 400, 6)
    expect(warnings.some((warning) => warning.includes('点云'))).toBe(true)
  })

  it('可以指定点云半径', () => {
    const properties: PlyPropertyDef[] = [
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
      { name: 'red', type: 'uchar' },
      { name: 'green', type: 'uchar' },
      { name: 'blue', type: 'uchar' },
    ]
    const { cloud } = parseSplat(
      buildPly(properties, [
        [0, 0, 0, 9, 9, 9],
        [1, 0, 0, 9, 9, 9],
      ]),
      { pointRadius: 0.25 },
    )
    expect(cloud.scale[0]).toBeCloseTo(0.25, 6)
  })

  it('数据被截断时报错,而不是画出一个残缺场景', () => {
    const ply = buildPly(DGS_PROPERTIES, [dgsRow(0, 0, 0, 0, 0, [0, 0, 0])])
    expect(() => parseSplat(ply.subarray(0, ply.length - 10))).toThrow(/截断/)
  })

  it('缺少 x/y/z 直接报错', () => {
    const properties: PlyPropertyDef[] = [
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
    ]
    expect(() => parseSplat(buildPly(properties, [[0, 0]]))).toThrow(/x\/y\/z/)
  })

  it('识别不了的数据给出明确错误', () => {
    expect(() => parseSplat(new Uint8Array([1, 2, 3, 4]))).toThrow(/无法识别/)
    expect(detectSplatFormat(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('几乎全透明的 splat 被剔除,并给出提示', () => {
    const ply = buildPly(DGS_PROPERTIES, [
      dgsRow(0, 0, 0, 0, 10, [0, 0, 0]),
      dgsRow(1, 0, 0, 0, -20, [0, 0, 0]),
    ])
    const { cloud, warnings } = parseSplat(ply)
    expect(cloud.count).toBe(1)
    expect(warnings.some((warning) => warning.includes('剔除'))).toBe(true)
  })
})

describe('.splat 解析与编码', () => {
  it('编码 → 解析可以来回,8 位量化的误差在 1/255 以内', () => {
    const cloud: SplatCloud = {
      ...makeCloud({ count: 3 }),
      count: 3,
      center: new Float32Array([1, 2, 3, -4, 5, -6, 0.25, 0.5, 0.75]),
      scale: new Float32Array([0.02, 0.03, 0.04, 0.1, 0.1, 0.1, 1, 2, 3]),
      rotation: new Float32Array([
        1, 0, 0, 0,
        Math.SQRT1_2, Math.SQRT1_2, 0, 0,
        0.5, 0.5, 0.5, 0.5,
      ]),
      rgba: new Float32Array([
        1, 0, 0, 1,
        0, 1, 0, 0.5,
        0.25, 0.5, 0.75, 1,
      ]),
    }
    const bytes = encodeSplatBinary(cloud)
    expect(bytes.length).toBe(3 * 32)

    const { cloud: decoded, format } = parseSplat(bytes)
    expect(format).toBe('splat')
    expect(decoded.count).toBe(3)
    for (let i = 0; i < 3; i += 1) {
      for (let k = 0; k < 3; k += 1) {
        expect(decoded.center[i * 3 + k]).toBeCloseTo(cloud.center[i * 3 + k] ?? 0, 5)
        expect(decoded.scale[i * 3 + k]).toBeCloseTo(cloud.scale[i * 3 + k] ?? 0, 5)
      }
      // 颜色与 alpha 是 8 位量化
      for (let k = 0; k < 4; k += 1) {
        expect(Math.abs((decoded.rgba[i * 4 + k] ?? 0) - (cloud.rgba[i * 4 + k] ?? 0))).toBeLessThan(1 / 255 + 1e-6)
      }
      // 四元数用 (q * 128 + 128) 存,范围 ±1 刚好用满一个字节
      for (let k = 0; k < 4; k += 1) {
        expect(Math.abs((decoded.rotation[i * 4 + k] ?? 0) - (cloud.rotation[i * 4 + k] ?? 0))).toBeLessThan(1 / 128 + 1e-6)
      }
    }
  })

  it('长度不是 32 的整数倍就按"无法识别"拒绝', () => {
    expect(() => parseSplat(new Uint8Array(33))).toThrow(/无法识别/)
    // 32 的整数倍但不含合法浮点:仍然会被当成 .splat,只是内容荒诞
    expect(() => parseSplat(new Uint8Array(64))).toThrow(/不透明度/)
  })
})

describe('普通点云 PLY 导出', () => {
  it('保留位置和颜色,并仍能被内置 PLY 解析器读取', () => {
    const center = new Float32Array([1.25, -2.5, 0, 3, 4, 0.5])
    const rgba = new Float32Array([0, 0.5, 1, 1, 1, 0.25, 0, 1])
    const cloud: SplatCloud = {
      count: 2,
      center,
      scale: new Float32Array(6),
      rotation: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]),
      rgba,
      shDegree: 0,
      droppedShCoefficients: 0,
      name: 'ground coverage',
      bounds: computeSplatBounds(center, 2),
    }

    const encoded = new TextEncoder().encode(encodePointCloudPly(cloud))
    expect(new TextDecoder().decode(encoded.slice(0, 3))).toBe('ply')
    const { cloud: decoded } = parseSplat(encoded)

    expect(decoded.count).toBe(2)
    expect(Array.from(decoded.center)).toEqual([1.25, -2.5, 0, 3, 4, 0.5])
    expect(decoded.rgba[0]).toBeCloseTo(0, 5)
    expect(decoded.rgba[1]).toBeCloseTo(0.5, 2)
    expect(decoded.rgba[2]).toBeCloseTo(1, 5)
    expect(decoded.rgba[4]).toBeCloseTo(1, 5)
    expect(decoded.rgba[5]).toBeCloseTo(0.25, 2)
    expect(decoded.rgba[6]).toBeCloseTo(0, 5)
  })
})

/* ───────────────────────── 投影数学 ───────────────────────── */

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const FOCAL = 800

function rotateZQuarterTurn(): Mat3 {
  // 相机绕视轴转 90°(world→camera 的逆)
  return viewRotationFromBasis([0, 1, 0], [-1, 0, 0], [0, 0, 1])
}

describe('EWA 投影:椭球 → 屏幕椭圆', () => {
  it('各向同性球在深度 z 处的半径 = f·σ/z', () => {
    const axes = splatScreenAxes(IDENTITY, [0, 0, 10], [0.1, 0.1, 0.1], [1, 0, 0, 0], FOCAL, 0)
    expect(axes).not.toBeNull()
    expect(axes?.majorPx).toBeCloseTo((FOCAL * 0.1) / 10, 6)
    expect(axes?.minorPx).toBeCloseTo((FOCAL * 0.1) / 10, 6)
  })

  it('长轴的世界朝向决定屏幕上的方向', () => {
    const axes = splatScreenAxes(IDENTITY, [0, 0, 10], [0.4, 0.05, 0.05], [1, 0, 0, 0], FOCAL, 0)
    expect(axes?.majorPx).toBeCloseTo((FOCAL * 0.4) / 10, 6)
    expect(axes?.minorPx).toBeCloseTo((FOCAL * 0.05) / 10, 6)
    // 长轴在屏幕 x 方向
    expect(Math.abs(axes?.axis1[0] ?? 0)).toBeCloseTo(axes?.majorPx ?? 0, 5)
    expect(axes?.axis1[1] ?? 1).toBeCloseTo(0, 6)
  })

  it('相机绕视轴转 90°,长轴从屏幕 x 转到屏幕 y', () => {
    const axes = splatScreenAxes(rotateZQuarterTurn(), [0, 0, 10], [0.4, 0.05, 0.05], [1, 0, 0, 0], FOCAL, 0)
    expect(axes?.majorPx).toBeCloseTo((FOCAL * 0.4) / 10, 6)
    expect(Math.abs(axes?.axis1[1] ?? 0)).toBeCloseTo(axes?.majorPx ?? 0, 5)
    expect(axes?.axis1[0] ?? 1).toBeCloseTo(0, 6)
  })

  it('把长轴转进视线方向,屏幕面积应按比例缩小(而不是不变)', () => {
    const quarterTurnAboutY: [number, number, number, number] = [Math.SQRT1_2, 0, Math.SQRT1_2, 0]
    const axes = splatScreenAxes(IDENTITY, [0, 0, 10], [0.4, 0.05, 0.05], quarterTurnAboutY, FOCAL, 0)
    // 长轴指向相机 → 投影后的长半轴只剩另外两根短轴
    expect(axes?.majorPx).toBeCloseTo((FOCAL * 0.05) / 10, 5)
  })

  it('低通项把极小的投影撑到亚像素以上(否则远处会闪)', () => {
    const without = splatScreenAxes(IDENTITY, [0, 0, 500], [0.01, 0.01, 0.01], [1, 0, 0, 0], FOCAL, 0)
    const withLowPass = splatScreenAxes(IDENTITY, [0, 0, 500], [0.01, 0.01, 0.01], [1, 0, 0, 0], FOCAL, 0.3)
    expect(without?.majorPx).toBeLessThan(0.02)
    expect(withLowPass?.majorPx).toBeCloseTo(Math.sqrt((without?.majorPx ?? 0) ** 2 + 0.3), 6)
  })

  it('离屏点与相机后方的点返回 null(不做除法)', () => {
    expect(splatScreenAxes(IDENTITY, [0, 0, -3], [0.1, 0.1, 0.1], [1, 0, 0, 0], FOCAL)).toBeNull()
    expect(splatScreenAxes(IDENTITY, [0, 0, 0], [0.1, 0.1, 0.1], [1, 0, 0, 0], FOCAL)).toBeNull()
  })

  it('偏移量改变投影形状:轴心越偏,二阶项越强', () => {
    const center = splatScreenAxes(IDENTITY, [0, 0, 10], [0.4, 0.05, 0.05], [1, 0, 0, 0], FOCAL, 0)
    const offset = splatScreenAxes(IDENTITY, [5, 0, 10], [0.4, 0.05, 0.05], [1, 0, 0, 0], FOCAL, 0)
    // 偏到画面边缘后,长轴被 J 的 z 项"压扁"了一点
    expect(offset?.majorPx ?? 0).toBeGreaterThan(center?.majorPx ?? 0)
  })
})

describe('四元数 → 旋转矩阵', () => {
  it('单位四元数是单位矩阵', () => {
    expect(quaternionToMat3([1, 0, 0, 0])).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
  })

  it('绕 y 轴 90° 把 x 轴送到 -z', () => {
    const m = quaternionToMat3([Math.SQRT1_2, 0, Math.SQRT1_2, 0])
    // 第三列 = R · (0,0,1) = 第一行第三个数,即 R 作用于 x 轴得到的第一列
    expect(m[0]).toBeCloseTo(0, 6)
    expect(m[2]).toBeCloseTo(1, 6)
    expect(m[6]).toBeCloseTo(-1, 6)
  })
})

/* ───────────────────────── 排序 ───────────────────────── */

describe('深度排序', () => {
  it('从远到近:alpha 混合必须先画远的', () => {
    const depths = new Float32Array([3, 1, 5, 2])
    expect(Array.from(sortSplatIndices(depths, 4))).toEqual([2, 0, 3, 1])
  })

  it('与参考实现(先排序下标再取值)结果一致', () => {
    const count = 997
    const depths = new Float32Array(count)
    let seed = 42
    for (let i = 0; i < count; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648
      // 只取正值:相机后方的点在着色器里会被裁掉,它们的顺序没有意义(见 DepthSorter)
      depths[i] = (seed / 2147483648) * 120 + 0.001
    }
    const order = sortSplatIndices(depths, count)
    for (let i = 1; i < count; i += 1) {
      expect(depths[order[i - 1] ?? 0]).toBeGreaterThanOrEqual(depths[order[i] ?? 0] ?? 0)
    }
  })

  it('负数与 NaN 深度沉到末尾,不会污染排序', () => {
    const depths = new Float32Array([2, Number.NaN, -4, 7])
    expect(Array.from(sortSplatIndices(depths, 4))).toEqual([3, 0, 1, 2])
  })

  it('缓冲可以复用:先大后小不串数据', () => {
    const sorter = new DepthSorter()
    const big = new Float32Array(5000).fill(1)
    sorter.sort(big, 5000)
    const small = new Float32Array([1, 9, 4])
    expect(Array.from(sorter.sort(small, 3))).toEqual([1, 2, 0])
    expect(sorter.capacity).toBeGreaterThanOrEqual(5000)
  })
})

/* ───────────────────────── 示例数据 ───────────────────────── */

describe('内置示例数据', () => {
  it('数量、数值范围与包围盒都合理', () => {
    const cloud = createReconstructionSample()
    expect(cloud.count).toBeGreaterThan(20000)
    expect(cloud.center.length).toBe(cloud.count * 3)

    // 2.9 万条逐条 expect 要 17 万次断言调用,全量并行下会拖过 5s 超时;
    // 这里在循环里只做普通比较,聚合成几个布尔值再断言
    let finite = true
    let alphaOk = true
    let scaleOk = true
    let colorOk = true
    for (let i = 0; i < cloud.count; i += 1) {
      const alpha = cloud.rgba[i * 4 + 3] ?? 0
      alphaOk = alphaOk && alpha > 0 && alpha <= 1
      for (let k = 0; k < 3; k += 1) {
        const channel = cloud.rgba[i * 4 + k] ?? -1
        colorOk = colorOk && channel >= 0 && channel <= 1
        finite = finite && Number.isFinite(cloud.center[i * 3 + k])
        scaleOk = scaleOk && (cloud.scale[i * 3 + k] ?? 0) > 0
      }
    }
    expect(finite).toBe(true)
    expect(alphaOk).toBe(true)
    expect(scaleOk).toBe(true)
    expect(colorOk).toBe(true)

    expect(cloud.bounds.radius).toBeGreaterThan(20)
    expect(cloud.bounds.radius).toBeLessThan(80)
  })

  it('同一种子产出完全相同的数据(测试才能断言数量)', () => {
    const a = createReconstructionSample({ seed: 7 })
    const b = createReconstructionSample({ seed: 7 })
    expect(a.count).toBe(b.count)
    expect(a.center[100]).toBe(b.center[100])
  })

  it('编码成 .splat 再解析,数量不减(量化不会吞点)', () => {
    const cloud = createReconstructionSample()
    const decoded = parseSplat(encodeSplatBinary(cloud)).cloud
    expect(decoded.count).toBe(cloud.count)
  })
})

/* ───────────────────────── 包围盒 ───────────────────────── */

describe('包围盒', () => {
  it('空数据返回零盒而不是 NaN', () => {
    const bounds = computeSplatBounds(new Float32Array(0), 0)
    expect(bounds.radius).toBe(0)
    expect(Number.isFinite(bounds.center[0])).toBe(true)
  })

  it('中心与半径按对角线算', () => {
    const center = new Float32Array([-1, -1, -1, 3, 3, 3])
    const bounds = computeSplatBounds(center, 2)
    expect(bounds.center).toEqual([1, 1, 1])
    expect(bounds.radius).toBeCloseTo(Math.hypot(4, 4, 4) / 2, 6)
  })
})
