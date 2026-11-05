/**
 * 采集包(capture bundle):把一次采集的**影像二进制 + manifest + COLMAP 三件套**
 * 打成一个 ZIP,解压出来就是一个能直接喂给 `colmap feature_extractor` 的目录。
 *
 * 为什么需要它:浏览器里的采集结果全在内存(`CapturedImage.imageUrl` 就是 data URL),
 * 而 `exportColmapDataset` 是纯函数、`scripts/export-colmap.mjs` 是 CLI —— 两者都要求
 * 磁盘上先有 `manifest.json` 和图片。缺的这一步就是本模块。
 *
 * 三条设计取舍:
 * 1. **ZIP 只用 store(不压缩)**。PNG / JPEG 本身已经压过,deflate 在几十兆图包上
 *    只能省个位数百分比,却要多带一个压缩实现(或引入依赖)。零依赖 + 可预测的字节。
 * 2. **不改写图片数据**。虚拟采集出的是 PNG(无损,SfM 匹配最稳),原样打包。
 * 3. **文件名由本模块统一分配**(`images/00001.png` 这种),并**回写 manifest 的 `file`**。
 *    因为 `images.txt` 的 NAME 直接取 `manifest.images[].file`,两边必须同一份字符串,
 *    否则 COLMAP 报"图片不存在"而三件套看起来完全正常 —— 这类错静默又难查。
 *
 * 因此本模块的输出满足一条不变量:**包内 manifest 列出的图 = 包内 images/ 里的文件,
 * 且三件套由这份(已改名的)manifest 生成**。解压目录里再跑一次 CLI 导出结果应当一致。
 *
 * 纯逻辑:不碰 DOM 下载,不支持 zip64(单个包 4GB 上限,几十兆的量级远够)。
 */
import { exportColmapDataset } from './drone-colmap-export'
import type { ColmapExport, ColmapExportOptions } from './drone-colmap-export'
import type { CaptureManifest, CaptureManifestImage } from './drone-capture-manifest'

/** 采集包里影像目录与其根目录(与 manifest 的 `imageDirectory` 约定一致) */
export const CAPTURE_BUNDLE_IMAGE_DIR = 'images'
export const CAPTURE_BUNDLE_MANIFEST = 'manifest.json'
export const CAPTURE_BUNDLE_MIME = 'application/zip'

/** 一张待打包的影像:要么是 data URL(虚拟采集),要么是已读出的字节(真实照片) */
export interface CaptureBundleImage {
  id: string
  /** `data:image/png;base64,...`;虚拟采集直接给这个 */
  dataUrl?: string
  /** 已解码的字节(Host 自己从 Blob 读);与 dataUrl 二选一 */
  bytes?: Uint8Array
  /** bytes 的 MIME,决定扩展名;缺省从 dataUrl 头里取,再缺省 image/png */
  mimeType?: string
}

export interface CaptureBundleOptions {
  manifest: CaptureManifest
  /** 有影像数据的那些图;没给 dataUrl/bytes 的会被记进 missing 并从清单里移除 */
  images: readonly CaptureBundleImage[]
  /** 包内根目录前缀(默认空;填 `capture-xxx` 则解压多一层) */
  root?: string
  /** 是否写 manifest.json,默认 true */
  includeManifest?: boolean
  /** 三件套的小数位数,透传给 exportColmapDataset */
  precision?: number
  /** 相机模型,透传给 exportColmapDataset */
  cameraModel?: ColmapExportOptions['cameraModel']
  /** 打包时间(写入 zip 头);测试传固定值即可拿到确定性字节 */
  now?: () => Date
}

export interface CaptureBundleEntry {
  path: string
  bytes: number
}

export interface CaptureBundleResult {
  bytes: Uint8Array
  /** 已按真实打包文件名重写 file 字段的清单(与包内文件一一对应) */
  manifest: CaptureManifest
  /** 由上面那份清单生成的三件套,文本与包内 `cameras.txt` 等逐字节一致 */
  colmap: ColmapExport
  /** 包内文件清单(按写入顺序),用于 UI 展示与测试断言 */
  files: CaptureBundleEntry[]
  /** manifest 里本该有、但这次没拿到影像数据的图 */
  missing: Array<{ id: string; reason: string }>
  warnings: string[]
  totalBytes: number
}

export interface ZipEntryInput {
  path: string
  bytes: Uint8Array
}

// ─────────────────────────────── ZIP(store) ───────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** 标准 CRC-32(IEEE 802.3);zip 的每个条目都要求它,错了解压工具会直接报“数据损坏” */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface DosStamp {
  time: number
  date: number
}

/** Date → MS-DOS 时间戳;zip 的年份基线是 1980,更早的一律夹到 1980-01-01 */
function toDosStamp(now: Date): DosStamp {
  const year = Math.max(1980, now.getFullYear())
  const month = now.getMonth() + 1
  const day = now.getDate()
  return {
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
    date: ((year - 1980) << 9) | (month << 5) | day,
  }
}

/**
 * 写一个 store 模式的 ZIP。
 *
 * 结构就是三段:local header + data(每条),central directory(一份索引),EOCD(收尾)。
 * 中央目录里的 offset 必须指向对应 local header 的**起点**,算错一格解压器就会读到乱码。
 * 文件名统一标 UTF-8(通用标志位 11),否则中文会话名在 Windows 资源管理器里会变问号。
 */
export function writeZipStore(entries: readonly ZipEntryInput[], now: Date = new Date()): Uint8Array {
  const encoder = new TextEncoder()
  const stamp = toDosStamp(now)
  const prepared = entries.map((entry) => {
    const name = encoder.encode(entry.path)
    return { name, bytes: entry.bytes, crc: crc32(entry.bytes) }
  })

  const localSize = prepared.reduce((sum, item) => sum + 30 + item.name.length + item.bytes.length, 0)
  const centralSize = prepared.reduce((sum, item) => sum + 46 + item.name.length, 0)
  const output = new Uint8Array(localSize + centralSize + 22)
  const view = new DataView(output.buffer)
  const offsets: number[] = []

  let cursor = 0
  for (const item of prepared) {
    offsets.push(cursor)
    view.setUint32(cursor, 0x04034b50, true) // local file header
    view.setUint16(cursor + 4, 20, true) // version needed
    view.setUint16(cursor + 6, 0x0800, true) // flags: UTF-8 文件名
    view.setUint16(cursor + 8, 0, true) // method: store
    view.setUint16(cursor + 10, stamp.time, true)
    view.setUint16(cursor + 12, stamp.date, true)
    view.setUint32(cursor + 14, item.crc, true)
    view.setUint32(cursor + 18, item.bytes.length, true)
    view.setUint32(cursor + 22, item.bytes.length, true)
    view.setUint16(cursor + 26, item.name.length, true)
    view.setUint16(cursor + 28, 0, true) // extra field 长度
    output.set(item.name, cursor + 30)
    output.set(item.bytes, cursor + 30 + item.name.length)
    cursor += 30 + item.name.length + item.bytes.length
  }

  const centralStart = cursor
  for (let index = 0; index < prepared.length; index += 1) {
    const item = prepared[index]!
    view.setUint32(cursor, 0x02014b50, true) // central directory header
    view.setUint16(cursor + 4, 20, true) // version made by
    view.setUint16(cursor + 6, 20, true) // version needed
    view.setUint16(cursor + 8, 0x0800, true)
    view.setUint16(cursor + 10, 0, true)
    view.setUint16(cursor + 12, stamp.time, true)
    view.setUint16(cursor + 14, stamp.date, true)
    view.setUint32(cursor + 16, item.crc, true)
    view.setUint32(cursor + 20, item.bytes.length, true)
    view.setUint32(cursor + 24, item.bytes.length, true)
    view.setUint16(cursor + 28, item.name.length, true)
    view.setUint16(cursor + 30, 0, true) // extra
    view.setUint16(cursor + 32, 0, true) // comment
    view.setUint16(cursor + 34, 0, true) // disk number
    view.setUint16(cursor + 36, 0, true) // internal attrs
    view.setUint32(cursor + 38, 0, true) // external attrs
    view.setUint32(cursor + 42, offsets[index]!, true)
    output.set(item.name, cursor + 46)
    cursor += 46 + item.name.length
  }

  view.setUint32(cursor, 0x06054b50, true) // EOCD
  view.setUint16(cursor + 4, 0, true)
  view.setUint16(cursor + 6, 0, true)
  view.setUint16(cursor + 8, prepared.length, true)
  view.setUint16(cursor + 10, prepared.length, true)
  view.setUint32(cursor + 12, cursor - centralStart, true)
  view.setUint32(cursor + 16, centralStart, true)
  view.setUint16(cursor + 20, 0, true)
  return output
}

// ──────────────────────────── data URL / 扩展名 ────────────────────────────

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
}

function extensionFor(mime: string | undefined): string {
  if (!mime) return 'png'
  const clean = mime.split(';')[0]!.trim().toLowerCase()
  const known = MIME_EXTENSION[clean]
  if (known) return known
  const guess = clean.replace(/^image\//, '').replace(/[^a-z0-9]/g, '')
  return guess || 'png'
}

const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/

/**
 * `data:image/png;base64,xxx` → 字节。
 * 非 base64 的 data URL(百分号编码的 SVG / 文本)也认,走 decodeURIComponent;
 * `blob:` 之类的地址直接返回 null —— 它只在当前页面有效,写进包里必然打不开。
 */
export function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mimeType: string } | null {
  if (!dataUrl.startsWith('data:')) return null
  const comma = dataUrl.indexOf(',')
  if (comma === -1) return null
  const header = dataUrl.slice(5, comma)
  const payload = dataUrl.slice(comma + 1)
  const mimeType = header.split(';')[0]!.trim() || 'application/octet-stream'
  if (header.includes(';base64')) {
    if (!BASE64_RE.test(payload)) return null
    if (typeof atob !== 'function') return null
    const binary = atob(payload.replace(/\s/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return { bytes, mimeType }
  }
  try {
    return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mimeType }
  } catch {
    return null
  }
}

// ──────────────────────────────── 组装 ────────────────────────────────

/** `images/00001.png`:定宽序号保证解压后文件名排序 = 拍摄顺序,也避开任何空格/中文 */
function imagePathFor(index: number): string {
  return `${CAPTURE_BUNDLE_IMAGE_DIR}/${String(index + 1).padStart(5, '0')}`
}

function prefixPath(root: string | undefined, path: string): string {
  const clean = (root ?? '').replace(/^\/+|\/+$/g, '')
  return clean ? `${clean}/${path}` : path
}

/**
 * 打包一次采集。
 *
 * 顺序很重要:先按"有数据的图"改清单 → 用改后的清单导三件套 → 再写 zip。
 * 这样 `images.txt` 里的 NAME 与包内路径天然同源,不存在"清单和图各说各话"。
 */
export function buildCaptureBundle(options: CaptureBundleOptions): CaptureBundleResult {
  const { manifest, images } = options
  const warnings: string[] = []
  const missing: Array<{ id: string; reason: string }> = []
  const byId = new Map<string, CaptureBundleImage>()
  for (const image of images) byId.set(image.id, image)

  const sourceImages = Array.isArray(manifest?.images) ? manifest.images : []
  const packedImages: CaptureManifestImage[] = []
  const filesToWrite: ZipEntryInput[] = []

  for (const image of sourceImages) {
    const source = byId.get(image.id)
    if (!source) {
      missing.push({ id: image.id, reason: '本次没有提供影像数据' })
      continue
    }
    let decoded: { bytes: Uint8Array; mimeType: string } | null = null
    if (source.bytes && source.bytes.length > 0) {
      decoded = { bytes: source.bytes, mimeType: source.mimeType ?? image.mimeType ?? 'image/png' }
    } else if (typeof source.dataUrl === 'string') {
      decoded = decodeDataUrl(source.dataUrl)
      if (!decoded) {
        missing.push({
          id: image.id,
          reason: source.dataUrl.startsWith('data:')
            ? 'data URL 无法解码'
            : '不是 data URL(blob 地址只在当前页面有效,请先读成字节)',
        })
        continue
      }
      if (source.mimeType) decoded.mimeType = source.mimeType
    }
    if (!decoded || decoded.bytes.length === 0) {
      missing.push({ id: image.id, reason: '影像为空(0 字节)' })
      continue
    }

    const path = `${imagePathFor(packedImages.length)}.${extensionFor(decoded.mimeType)}`
    packedImages.push({ ...image, file: path })
    filesToWrite.push({ path: prefixPath(options.root, path), bytes: decoded.bytes })
  }

  if (missing.length > 0) {
    warnings.push(
      `${missing.length} 张图没有影像数据,已从清单移除 —— 留在清单里会让 COLMAP 找不到文件`,
    )
  }
  if (packedImages.length === 0) warnings.push('包里没有任何影像,三件套会是空的')

  const bundleManifest: CaptureManifest = { ...manifest, images: packedImages }
  const colmap = exportColmapDataset(bundleManifest, {
    ...(options.precision === undefined ? {} : { precision: options.precision }),
    ...(options.cameraModel === undefined ? {} : { cameraModel: options.cameraModel }),
  })
  if (colmap.skipped.length > 0) {
    warnings.push(
      `${colmap.skipped.length} 张图没进 images.txt:${colmap.skipped
        .slice(0, 3)
        .map((entry) => `${entry.imageId}(${entry.reason})`)
        .join('、')}${colmap.skipped.length > 3 ? ' 等' : ''}`,
    )
  }

  const textEncoder = new TextEncoder()
  const head: ZipEntryInput[] = []
  if (options.includeManifest !== false) {
    head.push({
      path: prefixPath(options.root, CAPTURE_BUNDLE_MANIFEST),
      bytes: textEncoder.encode(JSON.stringify(bundleManifest, null, 2)),
    })
  }
  head.push(
    { path: prefixPath(options.root, 'cameras.txt'), bytes: textEncoder.encode(colmap.camerasTxt) },
    { path: prefixPath(options.root, 'images.txt'), bytes: textEncoder.encode(colmap.imagesTxt) },
    { path: prefixPath(options.root, 'points3D.txt'), bytes: textEncoder.encode(colmap.points3Dtxt) },
  )

  const allEntries = [...head, ...filesToWrite]
  const bytes = writeZipStore(allEntries, options.now?.() ?? new Date())

  return {
    bytes,
    manifest: bundleManifest,
    colmap,
    files: allEntries.map((entry) => ({ path: entry.path, bytes: entry.bytes.length })),
    missing,
    warnings: [...warnings, ...colmap.warnings],
    totalBytes: bytes.length,
  }
}

/** 建议的下载文件名:`<captureId>-colmap.zip`,去掉路径非法字符 */
export function captureBundleFileName(manifest: CaptureManifest): string {
  const raw = (manifest?.captureId ?? '').trim() || 'capture'
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${safe || 'capture'}-colmap.zip`
}
