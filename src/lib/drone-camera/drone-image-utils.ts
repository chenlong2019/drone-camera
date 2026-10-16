/**
 * 影像展示工具(采集面板与弹窗查看器共用)。
 *
 * 抽出来的原因很实在:同一张影像的"元数据文案"会出现在两处 —— 面板选中后的详情区、
 * 弹窗查看器的信息条。两套实现早晚会漂移(改了一处忘了另一处),所以统一放在这里;
 * 组件文件保持"只写自己的 DOM 逻辑"。
 *
 * 这里只放**无状态、无副作用**(除了 triggerDownload 的下载动作)的小函数,不引任何依赖。
 */
import type { CapturedImage } from './drone-capture'

/**
 * 极简 HTML 转义。
 *
 * 所有插进 innerHTML 的外部文本(文件名、校验消息、EXIF 字段……)都必须过这一道 ——
 * 真实照片的文件名完全由用户提供。
 */
export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }
  return text.replace(/[&<>"']/g, (ch) => map[ch] ?? ch)
}

/** 人类可读的字节数 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '–'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 触发浏览器下载(真实照片的 Blob URL 与导出的 data URL 共用) */
export function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/** 将会话里的原始照片打包为不压缩 ZIP,避免重复压缩 JPEG/PNG 并控制额外内存占用。 */
export async function createOriginalImagesZip(images: CapturedImage[]): Promise<Blob> {
  if (images.length === 0) throw new Error('当前会话没有可打包的图片')
  if (images.length > 0xffff) throw new RangeError('图片数量超过 ZIP 格式支持的上限')

  const encoder = new TextEncoder()
  const parts: BlobPart[] = []
  const centralDirectory: Uint8Array<ArrayBuffer>[] = []
  const usedNames = new Set<string>()
  let offset = 0
  const now = new Date()
  const dosTime =
    (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)
  const dosDate =
    ((Math.max(1980, now.getFullYear()) - 1980) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate()

  for (const [index, image] of images.entries()) {
    let source: Blob
    if (image.localBlob) {
      source = image.localBlob
    } else if (image.imageUrl) {
      const response = await fetch(image.imageUrl)
      if (!response.ok) throw new Error(`读取图片失败(${image.fileName}):HTTP ${response.status}`)
      source = await response.blob()
    } else {
      throw new Error(`图片缺少原始数据:${image.fileName}`)
    }

    const baseName = safeArchiveFileName(image.fileName)
    let fileName = baseName
    if (usedNames.has(fileName)) {
      const dot = baseName.lastIndexOf('.')
      const stem = dot > 0 ? baseName.slice(0, dot) : baseName
      const extension = dot > 0 ? baseName.slice(dot) : ''
      fileName = `${stem}-${String(index + 1).padStart(3, '0')}${extension}`
      while (usedNames.has(fileName)) {
        fileName = `${stem}-${String(index + 1).padStart(3, '0')}-${usedNames.size}${extension}`
      }
    }
    usedNames.add(fileName)
    const nameBytes = encoder.encode(fileName)
    if (nameBytes.length > 0xffff) throw new RangeError(`图片文件名过长:${image.fileName}`)
    if (source.size > 0xffffffff) throw new RangeError(`图片超过 ZIP 单文件大小上限:${image.fileName}`)
    const crc = await blobCrc32(source)

    const localHeader = new Uint8Array(new ArrayBuffer(30 + nameBytes.length))
    const localView = new DataView(localHeader.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0x0800, true)
    localView.setUint16(8, 0, true)
    localView.setUint16(10, dosTime, true)
    localView.setUint16(12, dosDate, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, source.size, true)
    localView.setUint32(22, source.size, true)
    localView.setUint16(26, nameBytes.length, true)
    localHeader.set(nameBytes, 30)
    parts.push(localHeader, source)

    const centralHeader = new Uint8Array(new ArrayBuffer(46 + nameBytes.length))
    const centralView = new DataView(centralHeader.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0x0800, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint16(12, dosTime, true)
    centralView.setUint16(14, dosDate, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, source.size, true)
    centralView.setUint32(24, source.size, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    centralHeader.set(nameBytes, 46)
    centralDirectory.push(centralHeader)

    offset += localHeader.length + source.size
    if (offset > 0xffffffff) throw new RangeError('图片总大小超过 ZIP 格式支持的上限')
  }

  const directorySize = centralDirectory.reduce((size, entry) => size + entry.length, 0)
  if (directorySize > 0xffffffff || offset + directorySize > 0xffffffff) {
    throw new RangeError('图片总大小超过 ZIP 格式支持的上限')
  }
  const endRecord = new Uint8Array(new ArrayBuffer(22))
  const endView = new DataView(endRecord.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, images.length, true)
  endView.setUint16(10, images.length, true)
  endView.setUint32(12, directorySize, true)
  endView.setUint32(16, offset, true)
  for (const entry of centralDirectory) parts.push(entry)
  parts.push(endRecord)
  return new Blob(parts, { type: 'application/zip' })
}

function safeArchiveFileName(fileName: string): string {
  const safe = fileName
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return safe || 'image'
}

async function blobCrc32(blob: Blob): Promise<number> {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }

  let crc = 0xffffffff
  const bytes = new Uint8Array(await blob.arrayBuffer())
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** 校验状态对应的中文标签 */
export const VALIDATION_LABELS: Record<CapturedImage['validation']['status'], string> = {
  valid: '有效',
  warning: '警告',
  invalid: '无效',
  pending: '待检',
}

/** 缩略图角标字符 */
export const VALIDATION_BADGES: Record<CapturedImage['validation']['status'], string> = {
  valid: '✓',
  warning: '!',
  invalid: '×',
  pending: '·',
}

/** 全景模式的中文名(不引 drone-panorama,免得文案模块反向依赖拍摄模块) */
export function panoramaModeLabel(mode: string): string {
  if (mode === 'pano-wide') return '广角'
  if (mode === 'pano-180') return '180° 全景'
  if (mode === 'pano-360') return '360° 全景'
  return mode
}

/**
 * 一组同源影像(同一次全景扫描,或"未分组的单张")。
 *
 * 「组合」在图集里是**各自成块**展示的:广角、180° 与球形 360° 扫描不应混在同一组里
 * 混在一堆缩略图里 —— 既看不出哪几张是一组,也没法对某一组单独合成。
 */
export interface ImageGroup {
  /** 分组键:全景组用 `metadata.panorama.group`,单张桶用固定值 */
  key: string
  kind: 'panorama' | 'single'
  /** 展示名,如「180° 全景」/「单张影像」 */
  label: string
  /** 全景模式标识(`pano-wide` / `pano-180` / `pano-360`);单张组为 undefined */
  mode?: string
  /** 组内影像(已按组内序号排序) */
  images: CapturedImage[]
  /** 组内影像在会话里的原始序号(1 起,与 `images` 一一对应) */
  indexes: number[]
  /** 该组是否已拍满(张数达到预设总张数);单张组恒为 false */
  complete: boolean
  /** 预设总张数(全景组才有) */
  total?: number
}

/** 未分组影像的桶键 */
export const UNGROUPED_KEY = '__ungrouped__'

/**
 * 把会话里的影像按「组合」切开 —— 全景组按 `metadata.panorama.group` 聚合(保持首次出现顺序),
 * 其余归入一个「单张影像」桶并排在最后。
 *
 * 顺序刻意保持"首次出现"而不是按组名排序:索引用的是 `index`/`session.images` 的下标,
 * 换个顺序就会让面板里显示的 `#n` 与图集里的不一致。
 */
export function groupSessionImages(images: CapturedImage[]): ImageGroup[] {
  const order: string[] = []
  const groups = new Map<string, ImageGroup>()
  const singles: ImageGroup = {
    key: UNGROUPED_KEY,
    kind: 'single',
    label: '单张影像',
    images: [],
    indexes: [],
    complete: false,
  }

  // 先把 (影像, 原始序号) 配对收进来:组内要按"组内序号"重排,而 `indexes` 报的是
  // 会话里的原始序号(与 `session.images` 的下标一致,面板里的 `#n` 才对得上)
  const pairs = new Map<string, Array<{ image: CapturedImage; sequence: number }>>()
  images.forEach((image, index) => {
    const pano = image.metadata.panorama
    const key = pano?.group
    if (!key) {
      singles.images.push(image)
      singles.indexes.push(index + 1)
      return
    }
    let bucket = pairs.get(key)
    if (!bucket) {
      bucket = []
      pairs.set(key, bucket)
      order.push(key)
    }
    bucket.push({ image, sequence: index + 1 })
  })

  const result: ImageGroup[] = []
  for (const key of order) {
    const bucket = pairs.get(key)
    if (!bucket?.length) continue
    const first = bucket[0]
    const pano = first?.image.metadata.panorama
    if (!pano) continue
    bucket.sort(
      (a, b) => (a.image.metadata.panorama?.index ?? 0) - (b.image.metadata.panorama?.index ?? 0),
    )
    const total = pano.total ?? bucket.length
    result.push({
      key,
      kind: 'panorama',
      mode: pano.mode,
      label: panoramaModeLabel(pano.mode),
      images: bucket.map((entry) => entry.image),
      indexes: bucket.map((entry) => entry.sequence),
      total,
      complete: total > 0 && bucket.length >= total,
    })
  }
  if (singles.images.length) result.push(singles)
  return result
}

/** 缩略图右上角的定位标签(全景影像显示"第几方位 / 第几层",其余显示序号) */
export function imageTileLabel(image: CapturedImage, sequence: number): string {
  const pano = image.metadata.panorama
  if (!pano) return `#${sequence}`
  return `#${sequence} · ${pano.bodyYaw}°/${pano.pitch}°`
}

/** 单张影像的元数据详情文本(面板详情区 / 弹窗查看器共用;含 `<b>` 等受控标签) */
export function describeImage(image: CapturedImage, index: number): string {
  const pose = image.cameraPose
  const intrinsics = image.cameraIntrinsics
  const lines: string[] = []
  lines.push(`<b>#${index + 1} ${escapeHtml(image.fileName)}</b>`)
  lines.push(
    `来源 ${image.source} · ${escapeHtml(image.mimeType || '未知类型')} · ${formatBytes(image.sizeBytes)} · ${escapeHtml(image.capturedAt)}`,
  )
  if (intrinsics) {
    const digits = (value: number | undefined): string =>
      value === undefined ? '–' : value.toFixed(2)
    lines.push(
      `内参 [${intrinsics.calibrationSource}] ${intrinsics.width}×${intrinsics.height} · fx ${digits(intrinsics.fx)} / fy ${digits(intrinsics.fy)}` +
        (intrinsics.horizontalFovDeg === undefined
          ? ''
          : ` · 水平 FOV ${intrinsics.horizontalFovDeg.toFixed(2)}°`),
    )
  }
  if (pose) {
    const round = (value: number): string => value.toFixed(3)
    lines.push(
      `位姿 [${pose.coordinateFrame}] 位置 (${pose.position.map(round).join(', ')}) ` +
        `四元数 (${pose.rotation.map((v) => v.toFixed(4)).join(', ')})`,
    )
  } else {
    lines.push('位姿 – (无相机位置/朝向记录)')
  }
  const meta = image.metadata
  const geo =
    meta.longitude !== undefined && meta.latitude !== undefined
      ? `${meta.longitude.toFixed(7)}, ${meta.latitude.toFixed(7)}` +
        (meta.altitude === undefined ? '' : ` @ ${meta.altitude.toFixed(1)}m`)
      : '无'
  lines.push(`经纬高 ${geo}`)
  if (meta.cameraModel) lines.push(`相机 ${escapeHtml(meta.cameraModel)}`)
  if (meta.sceneId) lines.push(`场景 ${escapeHtml(meta.sceneId)}`)
  if (meta.engine) lines.push(`产出后端 ${escapeHtml(meta.engine)}`)
  const pano = meta.panorama
  if (pano) {
    lines.push(
      `<b>全景</b> ${escapeHtml(pano.mode)} · 组 ${escapeHtml(pano.group)} · 第 ${pano.index}/${pano.total} 张` +
        ` · 网格 第 ${pano.col + 1} 方位 / 第 ${pano.row + 1} 层` +
        ` · 机身偏航 ${pano.bodyYaw}° / 取景俯仰 ${pano.pitch}°`,
    )
  }
  lines.push(
    `<b>校验</b> ${VALIDATION_LABELS[image.validation.status]}` +
      (image.validation.messages.length
        ? `\n<span class="is-warn">${image.validation.messages.map(escapeHtml).join('\n')}</span>`
        : ''),
  )
  return lines.join('\n')
}
