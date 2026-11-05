import { describe, expect, it } from 'vitest'
import {
  CAPTURE_BUNDLE_MIME,
  buildCaptureBundle,
  captureBundleFileName,
  crc32,
  decodeDataUrl,
  writeZipStore,
} from '../lib/drone-camera/drone-capture-bundle'
import { exportColmapDataset } from '../lib/drone-camera/drone-colmap-export'
import type { CaptureManifest, CaptureManifestImage } from '../lib/drone-camera/drone-capture-manifest'

const WIDTH = 1280
const HEIGHT = 720
const TIMESTAMP = '2026-10-20T08:00:00.000Z'
const FIXED_NOW = new Date(Date.UTC(2026, 9, 20, 8, 0, 0))

// ─────────────────────────── 参照实现:最小 ZIP 阅读器 ───────────────────────────

interface ReadEntry {
  path: string
  bytes: Uint8Array
  crc: number
  method: number
  /** 中央目录里的标志位 */
  flags: number
  /** local header 里的标志位 —— 两者可以不一致,而不少解压器只看 local header */
  localFlags: number
}

/**
 * 独立于被测代码的 ZIP 解析(只有 ~40 行,故意不复用被测的编码器):
 * 从 EOCD 反查中央目录 → 逐条读 local header → 取数据。
 * 用真解压器逻辑验证,才能抓到"中央目录 offset 差一格"这种编码器内部自洽但外部打不开的错。
 */
function readZip(bytes: Uint8Array): ReadEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd === -1) throw new Error('找不到 EOCD')
  const count = view.getUint16(eocd + 10, true)
  const cdSize = view.getUint32(eocd + 12, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  if (cdOffset + cdSize !== eocd) throw new Error('中央目录长度与 EOCD 偏移不自洽')

  const decoder = new TextDecoder()
  const entries: ReadEntry[] = []
  let cursor = cdOffset
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error(`第 ${index} 条中央目录签名错`)
    const crc = view.getUint32(cursor + 16, true)
    const size = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const path = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))

    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`${path} 的 local header 偏移错`)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const localPath = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength))
    if (localPath !== path) throw new Error(`${path} 的中央目录名与 local header 名不一致`)

    entries.push({
      path,
      bytes: bytes.subarray(dataStart, dataStart + size),
      crc,
      method: view.getUint16(cursor + 10, true),
      flags: view.getUint16(cursor + 8, true),
      localFlags: view.getUint16(localOffset + 6, true),
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

// ───────────────────────────────── 夹具 ─────────────────────────────────

/** 1×1 PNG(67 字节),真图而不是随机字节 —— 顺带验证二进制原样透传 */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
  0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d,
  0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

function pngDataUrl(): string {
  return `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`
}

function makeImage(index: number, overrides: Partial<CaptureManifestImage> = {}): CaptureManifestImage {
  const angle = (index / 8) * Math.PI * 2
  // 站在半径 12m 的环上朝圆心看:局部 +Z 朝后(three 约定),四元数用单位阵只为测结构
  return {
    id: `img-${index}`,
    file: `images/virtual-${index}.png`,
    timestamp: TIMESTAMP,
    position: [Math.cos(angle) * 12, 3, Math.sin(angle) * 12],
    rotation: [0, 0, 0, 1],
    // 四元数的约定是必填字段(COLMAP 导出要靠它判断是否需要转基),不能省
    rotationConvention: 'opengl',
    captureStatus: 'success',
    mimeType: 'image/png',
    sizeBytes: PNG_BYTES.length,
    width: WIDTH,
    height: HEIGHT,
    coordinateFrame: 'project-local',
    ...overrides,
  }
}

function makeManifest(count: number): CaptureManifest {
  return {
    schemaVersion: 1,
    captureId: 'recon-demo',
    createdAt: TIMESTAMP,
    coordinateFrame: {
      world: 'project-local',
      local: 'project-local',
      units: 'meters',
      transform: { source: 'project-local', target: 'project-local' },
    },
    camera: {
      model: 'PINHOLE',
      width: WIDTH,
      height: HEIGHT,
      fx: 760,
      fy: 760,
      cx: WIDTH / 2,
      cy: HEIGHT / 2,
      projection: 'perspective',
    },
    images: Array.from({ length: count }, (_, index) => makeImage(index)),
  }
}

function imagesFor(manifest: CaptureManifest, skip: string[] = []) {
  return manifest.images
    .filter((image) => !skip.includes(image.id))
    .map((image) => ({ id: image.id, dataUrl: pngDataUrl() }))
}

// ───────────────────────────────── 用例 ─────────────────────────────────

describe('crc32', () => {
  it('标准校验向量 123456789 → 0xCBF43926', () => {
    // 这个向量是 ZIP / PNG / gzip 共用的,算错说明查表或初值/终值取反写错了
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('空输入为 0', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('改一个字节 CRC 就变', () => {
    const a = new Uint8Array([1, 2, 3, 4])
    const b = new Uint8Array([1, 2, 3, 5])
    expect(crc32(a)).not.toBe(crc32(b))
  })
})

describe('decodeDataUrl', () => {
  it('base64 PNG 解出原始字节与 MIME', () => {
    const decoded = decodeDataUrl(pngDataUrl())
    expect(decoded?.mimeType).toBe('image/png')
    expect(decoded?.bytes.length).toBe(PNG_BYTES.length)
    expect(Array.from(decoded!.bytes)).toEqual(Array.from(PNG_BYTES))
  })

  it('blob 地址返回 null —— 写进包里必然打不开', () => {
    expect(decodeDataUrl('blob:http://localhost/abc-123')).toBeNull()
  })

  it('非 base64 的 data URL 走百分号解码', () => {
    const decoded = decodeDataUrl('data:image/svg+xml,%3Csvg%2F%3E')
    expect(new TextDecoder().decode(decoded!.bytes)).toBe('<svg/>')
  })

  it('截断的 data URL 返回 null 而不是抛错', () => {
    expect(decodeDataUrl('data:image/png;base64')).toBeNull()
    expect(decodeDataUrl('data:image/png;base64,@@@@')).toBeNull()
  })
})

describe('writeZipStore', () => {
  it('单条目可被独立解析器读回,字节与 CRC 都对得上', () => {
    const bytes = writeZipStore([{ path: 'a.txt', bytes: new TextEncoder().encode('hello') }], FIXED_NOW)
    const entries = readZip(bytes)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.path).toBe('a.txt')
    expect(new TextDecoder().decode(entries[0]!.bytes)).toBe('hello')
    expect(entries[0]!.crc).toBe(crc32(new TextEncoder().encode('hello')))
    expect(entries[0]!.method).toBe(0)
    // 两处都要标:有的解压器只读 local header,只写一处就会出现"资源管理器里乱码、命令行正常"
    expect(entries[0]!.flags & 0x0800).toBe(0x0800)
    expect(entries[0]!.localFlags & 0x0800).toBe(0x0800)
  })

  it('多条目时中央目录偏移逐条正确(差一格就会读到乱码)', () => {
    const entries = writeZipStore(
      [
        { path: 'a.txt', bytes: new Uint8Array([1, 2, 3]) },
        { path: 'dir/b.bin', bytes: new Uint8Array(100).fill(7) },
        { path: 'images/00001.png', bytes: PNG_BYTES },
      ],
      FIXED_NOW,
    )
    const read = readZip(entries)
    expect(read.map((entry) => entry.path)).toEqual(['a.txt', 'dir/b.bin', 'images/00001.png'])
    expect(read[1]!.bytes.length).toBe(100)
    expect(Array.from(read[2]!.bytes)).toEqual(Array.from(PNG_BYTES))
  })

  it('中文文件名按 UTF-8 存,读回来一致', () => {
    const bytes = writeZipStore([{ path: '采集/说明.txt', bytes: new Uint8Array([9]) }], FIXED_NOW)
    expect(readZip(bytes)[0]!.path).toBe('采集/说明.txt')
  })

  it('空包也是合法 ZIP(EOCD 记录 0 条)', () => {
    const bytes = writeZipStore([], FIXED_NOW)
    expect(bytes.length).toBe(22)
    expect(readZip(bytes)).toHaveLength(0)
  })
})

describe('buildCaptureBundle', () => {
  it('包内是 manifest + 三件套 + 每张图一个文件', () => {
    const manifest = makeManifest(4)
    const bundle = buildCaptureBundle({ manifest, images: imagesFor(manifest), now: () => FIXED_NOW })
    const entries = readZip(bundle.bytes)

    expect(entries.map((entry) => entry.path)).toEqual([
      'manifest.json',
      'cameras.txt',
      'images.txt',
      'points3D.txt',
      'images/00001.png',
      'images/00002.png',
      'images/00003.png',
      'images/00004.png',
    ])
    expect(bundle.files).toHaveLength(8)
    expect(bundle.totalBytes).toBe(bundle.bytes.length)
    expect(CAPTURE_BUNDLE_MIME).toBe('application/zip')
  })

  it('影像二进制原样透传(不是重新编码,也不是 base64 文本)', () => {
    const manifest = makeManifest(1)
    const bundle = buildCaptureBundle({ manifest, images: imagesFor(manifest), now: () => FIXED_NOW })
    const image = readZip(bundle.bytes).find((entry) => entry.path.startsWith('images/'))!
    expect(Array.from(image.bytes)).toEqual(Array.from(PNG_BYTES))
  })

  it('manifest 里的 file 与包内路径、以及 images.txt 的 NAME 三方一致', () => {
    const manifest = makeManifest(3)
    const bundle = buildCaptureBundle({ manifest, images: imagesFor(manifest), now: () => FIXED_NOW })

    const packedManifest = JSON.parse(
      new TextDecoder().decode(readZip(bundle.bytes).find((entry) => entry.path === 'manifest.json')!.bytes),
    ) as CaptureManifest
    const zipImagePaths = readZip(bundle.bytes)
      .map((entry) => entry.path)
      .filter((path) => path.startsWith('images/'))

    // 不变量:清单列的 = 包里有的
    expect(packedManifest.images.map((image) => image.file)).toEqual(zipImagePaths)

    // images.txt 每张图两行,第二行是空观测;NAME 是第 10 列
    const names = bundle.colmap.imagesTxt
      .split('\n')
      .filter((line) => /^\d+ /.test(line) && !line.startsWith('#'))
      .map((line) => line.trim().split(/\s+/)[9])
    expect(names).toEqual(zipImagePaths)
  })

  it('序号定宽补零,拍 12 张时排序仍是拍摄顺序', () => {
    const manifest = makeManifest(12)
    const bundle = buildCaptureBundle({ manifest, images: imagesFor(manifest), now: () => FIXED_NOW })
    const paths = bundle.manifest.images.map((image) => image.file)
    expect(paths[0]).toBe('images/00001.png')
    expect(paths[9]).toBe('images/00010.png')
    expect([...paths].sort()).toEqual(paths)
  })

  it('扩展名跟随 MIME:JPEG 出来是 .jpg', () => {
    const manifest = makeManifest(1)
    const jpegHeader = 'data:image/jpeg;base64,'
    const bundle = buildCaptureBundle({
      manifest,
      images: [{ id: 'img-0', dataUrl: `${jpegHeader}${Buffer.from(PNG_BYTES).toString('base64')}` }],
      now: () => FIXED_NOW,
    })
    expect(bundle.manifest.images[0]!.file).toBe('images/00001.jpg')
  })

  it('没影像数据的图从清单移除 —— 否则 COLMAP 找不到文件', () => {
    const manifest = makeManifest(3)
    const bundle = buildCaptureBundle({
      manifest,
      images: imagesFor(manifest, ['img-1']),
      now: () => FIXED_NOW,
    })
    expect(bundle.manifest.images.map((image) => image.id)).toEqual(['img-0', 'img-2'])
    expect(bundle.missing).toEqual([{ id: 'img-1', reason: '本次没有提供影像数据' }])
    expect(bundle.colmap.imageCount).toBe(2)
    // 移除后序号连续,不留空洞
    expect(bundle.manifest.images.map((image) => image.file)).toEqual(['images/00001.png', 'images/00002.png'])
  })

  it('blob: 地址被识别成"不可打包"并说明原因', () => {
    const manifest = makeManifest(1)
    const bundle = buildCaptureBundle({
      manifest,
      images: [{ id: 'img-0', dataUrl: 'blob:http://localhost/x' }],
      now: () => FIXED_NOW,
    })
    expect(bundle.manifest.images).toHaveLength(0)
    expect(bundle.missing[0]!.reason).toContain('blob 地址只在当前页面有效')
  })

  it('空字节被拒(0 字节文件会让 COLMAP 直接中断整个特征提取)', () => {
    const manifest = makeManifest(1)
    const bundle = buildCaptureBundle({
      manifest,
      images: [{ id: 'img-0', bytes: new Uint8Array(0) }],
      now: () => FIXED_NOW,
    })
    expect(bundle.manifest.images).toHaveLength(0)
    expect(bundle.missing[0]!.reason).toContain('0 字节')
  })

  it('data URL 载荷为空也拒(0 尺寸画布 toDataURL 就是这个形状)', () => {
    const manifest = makeManifest(1)
    const bundle = buildCaptureBundle({
      manifest,
      images: [{ id: 'img-0', dataUrl: 'data:image/png;base64,' }],
      now: () => FIXED_NOW,
    })
    expect(bundle.manifest.images).toHaveLength(0)
    expect(bundle.missing).toHaveLength(1)
    expect(bundle.files.map((file) => file.path)).not.toContain('images/00001.png')
  })

  it('root 前缀只加到包内路径,清单里的 file 仍是相对路径', () => {
    const manifest = makeManifest(2)
    const bundle = buildCaptureBundle({
      manifest,
      images: imagesFor(manifest),
      root: '/capture-recon/',
      now: () => FIXED_NOW,
    })
    const paths = readZip(bundle.bytes).map((entry) => entry.path)
    expect(paths[0]).toBe('capture-recon/manifest.json')
    expect(paths).toContain('capture-recon/images/00001.png')
    // COLMAP 的 --image_path 指向 root,所以 file 必须是相对 root 的
    expect(bundle.manifest.images[0]!.file).toBe('images/00001.png')
  })

  it('includeManifest=false 时不写 manifest.json', () => {
    const manifest = makeManifest(1)
    const bundle = buildCaptureBundle({
      manifest,
      images: imagesFor(manifest),
      includeManifest: false,
      now: () => FIXED_NOW,
    })
    expect(bundle.files.map((file) => file.path)).not.toContain('manifest.json')
  })

  it('包内三件套与直接调 exportColmapDataset 逐字节一致', () => {
    const manifest = makeManifest(3)
    const bundle = buildCaptureBundle({ manifest, images: imagesFor(manifest), now: () => FIXED_NOW })
    const direct = exportColmapDataset(bundle.manifest)
    const entries = readZip(bundle.bytes)
    expect(new TextDecoder().decode(entries.find((entry) => entry.path === 'images.txt')!.bytes)).toBe(
      direct.imagesTxt,
    )
    expect(new TextDecoder().decode(entries.find((entry) => entry.path === 'cameras.txt')!.bytes)).toBe(
      direct.camerasTxt,
    )
    expect(new TextDecoder().decode(entries.find((entry) => entry.path === 'points3D.txt')!.bytes)).toBe(
      direct.points3Dtxt,
    )
  })

  it('没有位姿的图照样打包,但会说明它没进 images.txt', () => {
    const manifest = makeManifest(2)
    manifest.images[1] = makeImage(1, { position: undefined, rotation: undefined })
    const bundle = buildCaptureBundle({ manifest, images: imagesFor(manifest), now: () => FIXED_NOW })
    expect(bundle.colmap.imageCount).toBe(1)
    expect(bundle.files.filter((file) => file.path.startsWith('images/'))).toHaveLength(2)
    expect(bundle.warnings.join(' ')).toContain('没进 images.txt')
  })

  it('同样的输入与时间戳 → 同样的字节(可复现)', () => {
    const manifest = makeManifest(2)
    const a = buildCaptureBundle({ manifest, images: imagesFor(manifest), now: () => FIXED_NOW })
    const b = buildCaptureBundle({ manifest, images: imagesFor(manifest), now: () => FIXED_NOW })
    expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes))
  })

  it('空清单也能出包(只有表头),并给出警告', () => {
    const bundle = buildCaptureBundle({
      manifest: { ...makeManifest(0), images: [] },
      images: [],
      now: () => FIXED_NOW,
    })
    expect(bundle.colmap.imageCount).toBe(0)
    expect(bundle.files.map((file) => file.path)).toEqual([
      'manifest.json',
      'cameras.txt',
      'images.txt',
      'points3D.txt',
    ])
    expect(bundle.warnings.join(' ')).toContain('包里没有任何影像')
  })
})

describe('captureBundleFileName', () => {
  it('用 captureId 命名并去掉非法字符', () => {
    expect(captureBundleFileName(makeManifest(1))).toBe('recon-demo-colmap.zip')
    expect(captureBundleFileName({ ...makeManifest(1), captureId: 'cap/2026 10:20' })).toBe(
      'cap-2026-10-20-colmap.zip',
    )
  })

  it('没有 captureId 时兜底成 capture', () => {
    expect(captureBundleFileName({ ...makeManifest(0), captureId: '' })).toBe('capture-colmap.zip')
    expect(captureBundleFileName({ ...makeManifest(0), captureId: '///' })).toBe('capture-colmap.zip')
  })
})
