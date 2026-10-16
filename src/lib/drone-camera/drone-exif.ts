/**
 * 零依赖 JPEG EXIF / GPS 解析器。
 *
 * 用途:真实无人机照片导入时,把「拍摄时间 / 机型 / 焦距 / 图像尺寸 / GPS 经纬高」
 * 从文件里读出来,填进统一的 `CapturedImage.metadata`(见 drone-capture)。
 *
 * 为什么自己写而不引三方库:本库除 `three` 外不接受运行时依赖(见 lib/index.ts 的设计约定),
 * 而 V1 只需要 JPEG 的 EXIF 基本项 —— 一个 APP1/TIFF 顺序读就够了,不值得为它挂一个包。
 *
 * 覆盖范围(够用即止,不做全谱):
 * - 只认 JPEG(SOI 0xFFD8 → APP1 0xFFE1 "Exif\0\0" → TIFF),PNG / HEIC 一律返回 null;
 * - IFD0:Make / Model / Orientation / DateTime / ExifIFD 指针 / GPSIFD 指针;
 * - Exif IFD:曝光时间 / 光圈 / ISO / 原始拍摄时间 / 焦距 / 35mm 等效焦距 / 像素宽高;
 * - GPS IFD:纬度(度分秒 + N/S)/ 经度(度分秒 + E/W)/ 海拔(含海平面下标志);
 * - 字节序 II(小端)/ MM(大端)都支持;值内联(≤4 字节)与偏移两种存放方式都处理。
 *
 * 解析策略是**尽力而为、绝不抛错**:任何一段越界或类型不认识都只记进 `warnings` 并跳过,
 * 已经读到的字段原样保留 —— 因为「元数据缺失」本身就是需要展示给用户的信息,
 * 不该因为某个 tag 坏了就让整张照片导入失败。
 */
/** EXIF GPS 信息(已转成十进制度) */
export interface ExifGps {
  /** 十进制度,北纬为正 */
  latitude?: number
  /** 十进制度,东经为正 */
  longitude?: number
  /** 海拔(米);altitudeRef = 1 表示海平面以下,此处已取负 */
  altitude?: number
  /** 原始海拔标志:0 = 海平面以上,1 = 海平面以下 */
  altitudeRef?: number
}

/** EXIF 解析结果(字段全部可选 —— 缺失就是缺失,不填默认值) */
export interface ExifData {
  make?: string
  model?: string
  lensModel?: string
  /** 原始拍摄时间(相机本地时间,无时区),格式 `YYYY-MM-DDTHH:MM:SS` */
  dateTimeOriginal?: string
  /** 文件修改时间(EXIF DateTime) */
  dateTime?: string
  /** 拍照方向(1~8,见 EXIF 规范;1 = 正常) */
  orientation?: number
  focalLengthMm?: number
  /** 35mm 等效焦距 —— 换算内参的关键字段 */
  focalLength35mm?: number
  exposureTimeSeconds?: number
  fNumber?: number
  isoSpeed?: number
  /** 图像宽高(EXIF 里记录的原始像素尺寸) */
  pixelXDimension?: number
  pixelYDimension?: number
  gps?: ExifGps
  /** 解析过程中的异常/缺失说明(诊断用) */
  warnings: string[]
}

// ── TIFF tag 常量(只列用得到的) ──
const TAG_MAKE = 0x010f
const TAG_MODEL = 0x0110
const TAG_ORIENTATION = 0x0112
const TAG_DATE_TIME = 0x0132
const TAG_EXIF_IFD = 0x8769
const TAG_GPS_IFD = 0x8825
const TAG_EXPOSURE_TIME = 0x829a
const TAG_F_NUMBER = 0x829d
const TAG_ISO_SPEED = 0x8827
const TAG_DATE_TIME_ORIGINAL = 0x9003
const TAG_FOCAL_LENGTH = 0x920a
const TAG_PIXEL_X = 0xa002
const TAG_PIXEL_Y = 0xa003
const TAG_FOCAL_LENGTH_35MM = 0xa405
const TAG_LENS_MODEL = 0xa434

const GPS_LAT_REF = 0x0001
const GPS_LAT = 0x0002
const GPS_LON_REF = 0x0003
const GPS_LON = 0x0004
const GPS_ALT_REF = 0x0005
const GPS_ALT = 0x0006

/** TIFF 字段类型 → 单值字节数(1 BYTE / 2 ASCII / 3 SHORT / 4 LONG / 5 RATIONAL / 7 UNDEFINED / 9 SLONG / 10 SRATIONAL) */
const TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
}

/** 一个 IFD 条目在文件里的位置与形状 */
interface IfdEntry {
  type: number
  count: number
  /** 条目自身在 DataView 中的偏移(8 字节值域从这里开始) */
  offset: number
}

type Ifd = Map<number, IfdEntry>

function readU16(view: DataView, offset: number, little: boolean): number {
  return view.getUint16(offset, little)
}

function readU32(view: DataView, offset: number, little: boolean): number {
  return view.getUint32(offset, little)
}

/** 读一个 IFD(标签 → 条目),越界即止;返回条目表与下一个 IFD 的偏移 */
function readIfd(view: DataView, tiffStart: number, ifdOffset: number, little: boolean): Ifd {
  const entries: Ifd = new Map()
  const countOffset = tiffStart + ifdOffset
  if (countOffset + 2 > view.byteLength) return entries
  const count = readU16(view, countOffset, little)
  for (let i = 0; i < count; i += 1) {
    const offset = countOffset + 2 + i * 12
    if (offset + 12 > view.byteLength) break
    const tag = readU16(view, offset, little)
    const type = readU16(view, offset + 2, little)
    const valueCount = readU32(view, offset + 4, little)
    entries.set(tag, { type, count: valueCount, offset })
  }
  return entries
}

/** 取条目值域的起始偏移:总长 ≤ 4 字节时值内联在条目里,否则是个指向 TIFF 起点的偏移 */
function valueStart(
  view: DataView,
  tiffStart: number,
  entry: IfdEntry,
  little: boolean,
): number | null {
  const size = TYPE_SIZE[entry.type]
  if (!size) return null
  if (size * entry.count <= 4) return entry.offset + 8
  const start = tiffStart + readU32(view, entry.offset + 8, little)
  return start < view.byteLength ? start : null
}

/** 第 index 个分量(用于 RATIONAL / SRATIONAL —— 它们是分子+分母两个 4 字节字) */
function readComponent(
  view: DataView,
  tiffStart: number,
  entry: IfdEntry,
  little: boolean,
  index: number,
): number | undefined {
  const size = TYPE_SIZE[entry.type]
  const start = valueStart(view, tiffStart, entry, little)
  if (!size || start === null) return undefined
  const offset = start + index * size
  if (offset + size > view.byteLength) return undefined
  switch (entry.type) {
    case 1:
    case 2:
    case 6:
    case 7:
      return view.getUint8(offset)
    case 3:
      return readU16(view, offset, little)
    case 8:
      return view.getInt16(offset, little)
    case 4:
      return readU32(view, offset, little)
    case 9:
      return view.getInt32(offset, little)
    case 11:
      return view.getFloat32(offset, little)
    case 12:
      return view.getFloat64(offset, little)
    default:
      return undefined
  }
}

/**
 * 实数型字段取第 index 个值。
 *
 * EXIF 里实数有三种写法,都必须认:
 * - `RATIONAL`(5)/`SRATIONAL`(10):分子 + 分母两个 4 字节字 —— 相机固件走这条;
 * - `FLOAT`(11)/`DOUBLE`(12):IEEE 浮点 —— 一些转换工具(含 Pillow 的默认行为)走这条。
 * 只支持前者的话,这类文件的曝光/光圈/焦距会读出一串垃圾数(不是读不到,而是**读错**,
 * 比缺失更危险),所以这里显式分流。
 */
function readRational(
  view: DataView,
  tiffStart: number,
  entry: IfdEntry | undefined,
  little: boolean,
  index = 0,
): number | undefined {
  if (!entry) return undefined
  if (entry.type === 11 || entry.type === 12) {
    return readComponent(view, tiffStart, entry, little, index)
  }
  const size = TYPE_SIZE[entry.type]
  const start = valueStart(view, tiffStart, entry, little)
  if (start === null) return undefined
  const offset = start + index * (size ?? 8)
  if (offset + 8 > view.byteLength) return undefined
  const numerator =
    entry.type === 10 ? view.getInt32(offset, little) : readU32(view, offset, little)
  const denominator =
    entry.type === 10 ? view.getInt32(offset + 4, little) : readU32(view, offset + 4, little)
  if (denominator === 0) return undefined
  return numerator / denominator
}

/** ASCII 串(以 NUL 结尾,可能被塞在偏移处) */
function readAscii(
  view: DataView,
  tiffStart: number,
  entry: IfdEntry | undefined,
  little: boolean,
): string | undefined {
  if (!entry) return undefined
  const start = valueStart(view, tiffStart, entry, little)
  if (start === null) return undefined
  let text = ''
  for (let i = 0; i < entry.count; i += 1) {
    const offset = start + i
    if (offset >= view.byteLength) break
    const code = view.getUint8(offset)
    if (code === 0) break
    text += String.fromCharCode(code)
  }
  const trimmed = text.trim()
  return trimmed.length ? trimmed : undefined
}

/** 单个数值字段(BYTE / SHORT / LONG / SLONG / RATIONAL / SRATIONAL 统一取第 0 个) */
function readNumber(
  view: DataView,
  tiffStart: number,
  entry: IfdEntry | undefined,
  little: boolean,
): number | undefined {
  if (!entry) return undefined
  if (entry.type === 5 || entry.type === 10) return readRational(view, tiffStart, entry, little)
  return readComponent(view, tiffStart, entry, little, 0)
}

/** 度分秒三元组 → 十进制度(GPS 用 RATIONAL[3]) */
function readDegrees(
  view: DataView,
  tiffStart: number,
  entry: IfdEntry | undefined,
  little: boolean,
): number | undefined {
  if (!entry || entry.count < 3) return undefined
  const degrees = readRational(view, tiffStart, entry, little, 0)
  const minutes = readRational(view, tiffStart, entry, little, 1)
  const seconds = readRational(view, tiffStart, entry, little, 2)
  if (degrees === undefined || minutes === undefined || seconds === undefined) return undefined
  return degrees + minutes / 60 + seconds / 3600
}

/** EXIF 时间 `YYYY:MM:DD HH:MM:SS` → `YYYY-MM-DDTHH:MM:SS`(保持相机本地时间,不加时区) */
function normalizeExifTime(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw)
  if (!match) return undefined
  const [, y, mo, d, h, mi, s] = match
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`
}

/** 读 TIFF(EXIF 段正文,起点即 TIFF header) */
function readTiff(view: DataView, tiffStart: number): ExifData | null {
  if (tiffStart + 8 > view.byteLength) return null
  const byteOrder = readU16(view, tiffStart, false)
  let little: boolean
  if (byteOrder === 0x4949) little = true
  else if (byteOrder === 0x4d4d) little = false
  else return null
  if (readU16(view, tiffStart + 2, little) !== 0x002a) return null

  const warnings: string[] = []
  const ifd0Offset = readU32(view, tiffStart + 4, little)
  if (ifd0Offset === 0) return null
  const ifd0 = readIfd(view, tiffStart, ifd0Offset, little)
  if (ifd0.size === 0) return null

  const data: ExifData = { warnings }

  data.make = readAscii(view, tiffStart, ifd0.get(TAG_MAKE), little)
  data.model = readAscii(view, tiffStart, ifd0.get(TAG_MODEL), little)
  data.orientation = readNumber(view, tiffStart, ifd0.get(TAG_ORIENTATION), little)
  data.dateTime = normalizeExifTime(readAscii(view, tiffStart, ifd0.get(TAG_DATE_TIME), little))

  // Exif 子 IFD
  const exifIfdPointer = readNumber(view, tiffStart, ifd0.get(TAG_EXIF_IFD), little)
  const exifIfd =
    exifIfdPointer !== undefined ? readIfd(view, tiffStart, exifIfdPointer, little) : null
  if (exifIfd) {
    data.lensModel = readAscii(view, tiffStart, exifIfd.get(TAG_LENS_MODEL), little)
    data.dateTimeOriginal = normalizeExifTime(
      readAscii(view, tiffStart, exifIfd.get(TAG_DATE_TIME_ORIGINAL), little),
    )
    data.exposureTimeSeconds = readRational(view, tiffStart, exifIfd.get(TAG_EXPOSURE_TIME), little)
    data.fNumber = readRational(view, tiffStart, exifIfd.get(TAG_F_NUMBER), little)
    data.isoSpeed = readNumber(view, tiffStart, exifIfd.get(TAG_ISO_SPEED), little)
    data.focalLengthMm = readRational(view, tiffStart, exifIfd.get(TAG_FOCAL_LENGTH), little)
    data.focalLength35mm = readNumber(view, tiffStart, exifIfd.get(TAG_FOCAL_LENGTH_35MM), little)
    data.pixelXDimension = readNumber(view, tiffStart, exifIfd.get(TAG_PIXEL_X), little)
    data.pixelYDimension = readNumber(view, tiffStart, exifIfd.get(TAG_PIXEL_Y), little)
  } else {
    warnings.push('缺少 Exif 子 IFD(焦距 / 原始拍摄时间等字段不可得)')
  }

  // GPS 子 IFD
  const gpsIfdPointer = readNumber(view, tiffStart, ifd0.get(TAG_GPS_IFD), little)
  const gpsIfd =
    gpsIfdPointer !== undefined ? readIfd(view, tiffStart, gpsIfdPointer, little) : null
  if (gpsIfd) {
    const gps: ExifGps = {}
    const lat = readDegrees(view, tiffStart, gpsIfd.get(GPS_LAT), little)
    const latRef = readAscii(view, tiffStart, gpsIfd.get(GPS_LAT_REF), little)
    if (lat !== undefined) gps.latitude = latRef?.toUpperCase() === 'S' ? -lat : lat
    const lon = readDegrees(view, tiffStart, gpsIfd.get(GPS_LON), little)
    const lonRef = readAscii(view, tiffStart, gpsIfd.get(GPS_LON_REF), little)
    if (lon !== undefined) gps.longitude = lonRef?.toUpperCase() === 'W' ? -lon : lon
    const altitude = readRational(view, tiffStart, gpsIfd.get(GPS_ALT), little)
    const altitudeRef = readNumber(view, tiffStart, gpsIfd.get(GPS_ALT_REF), little)
    if (altitudeRef !== undefined) gps.altitudeRef = altitudeRef
    if (altitude !== undefined) gps.altitude = altitudeRef === 1 ? -altitude : altitude
    if (Object.keys(gps).length) data.gps = gps
  } else {
    warnings.push('照片不含 GPS 信息(无法做地理定位,只能当作局部坐标成果)')
  }

  return data
}

/**
 * 解析 JPEG 的 EXIF 段。
 *
 * @returns 解析结果;不是 JPEG / 没有 EXIF 段 / 结构不可识别时返回 `null`。
 */
export function parseJpegExif(bytes: Uint8Array): ExifData | null {
  if (bytes.byteLength < 4) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // SOI
  if (readU16(view, 0, false) !== 0xffd8) return null

  let offset = 2
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) {
      offset += 1
      continue
    }
    const marker = view.getUint8(offset + 1)
    // 填充 / 无长度段
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    // SOS:压缩数据开始,后面不会再有元数据
    if (marker === 0xda) break
    const length = readU16(view, offset + 2, false)
    if (length < 2) break
    const segmentStart = offset + 4
    if (marker === 0xe1) {
      // APP1 且有效载荷以 "Exif\0\0" 开头
      const isExif =
        segmentStart + 6 <= view.byteLength &&
        readU32(view, segmentStart, false) === 0x45786966 &&
        readU16(view, segmentStart + 4, false) === 0x0000
      if (isExif) return readTiff(view, segmentStart + 6)
    }
    offset = segmentStart + length - 2
  }
  return null
}

/** 从 Blob / File 读前若干字节解析 EXIF(只取头部,不必读整张图) */
export async function readJpegExif(file: Blob, maxBytes = 256 * 1024): Promise<ExifData | null> {
  const head = file.slice(0, Math.min(maxBytes, file.size))
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await head.arrayBuffer())
  } catch {
    return null
  }
  try {
    return parseJpegExif(bytes)
  } catch {
    return null
  }
}
