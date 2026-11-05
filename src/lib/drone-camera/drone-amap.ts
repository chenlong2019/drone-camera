/**
 * 高德 JS API 2.0 封装 —— 独立地图宿主 + 无人机覆盖物同步。
 *
 * ## 为什么是「独立宿主」而不是「Cesium 底图」
 * AMap JS API 自带渲染引擎(Canvas/DOM),它是**整块地图**,不是瓦片源:既不能塞进
 * Cesium 的 WebGL 场景,也不能当 `ImageryProvider`。所以本模块的定位是库里的
 * 「第二块屏」——一块真正的中国地图,读同一份 `DroneSim` 真值画机体 / 航线 / 航迹,
 * 与 three / Cesium 两条三维路径并存且互不干扰。
 *
 * ## 坐标系是这里唯一真正麻烦的事
 * sim 的真值是 WGS84(ENU 相对场景原点),而 AMap 全域是 **GCJ-02(火星坐标)**,
 * 两者在北京差约 500m。不做转换的表现不是"报错",而是**机体浮在隔壁街区**,
 * 看起来还挺合理 —— 所以本模块默认按 `frame: 'gcj'` 输出,把真值先搬到高德坐标系,
 * 并同时导出 `wgs84ToGcj02` / `gcj02ToWgs84` 供宿主与其它引擎对接。
 *
 * 正解(GCJ 加密)是公开的解析式,但**不可解析求逆**,反解用不动点迭代:
 * `w = w + (target - fwd(w))`,十几次内收敛到 1e-9 度(约 0.1mm),足够任何相机/航点用途。
 *
 * ## 脚本加载的两个硬约束
 * 1. **安全密钥必须在脚本注入前**写到 `window._AMapSecurityConfig` 上,晚一步就是
 *    `INVALID_USER_SCODE`(地图整块不出来),而且这个错误只在控制台里,不抛异常;
 * 2. 同一个 key 只注入一次(单例 Promise),重复调用共享同一块脚本 —— 组件重挂载
 *    时不能把已加载的 AMap 再灌一遍,否则 `AMap.Map` 会拿到两套内部状态。
 *
 * ```ts
 * const map = new AmapDroneMap({
 *   container: el,
 *   key: import.meta.env.VITE_AMAP_KEY,
 *   securityCode: import.meta.env.VITE_AMAP_JSC0DE,
 *   origin: { longitude: 116.391, latitude: 39.906, altitude: 0 },
 *   sim,
 * })
 * await map.open()
 * // …每帧由宿主调用 map.sync(),或让它自己跑 rAF(默认)
 * map.destroy()
 * ```
 */

import type { DroneSim } from './drone-sim'
import {
  createEcefEnuFrame,
  ecefToGeodetic,
  enuToEcef,
  type GeodeticCoordinate,
} from './drone-photogrammetry'

/** 经纬度(度);不带高度的轻量表示,坐标转换的输入输出都用它 */
export interface LonLat {
  lon: number
  lat: number
}

/**
 * 输出坐标系。
 * - `gcj`:高德原生(默认)。地图上看到的位置与高德 App / 网页一致;
 * - `wgs84`:不做加密补偿。只在"贴自建 WGS84 瓦片"或境外场景用。
 */
export type AmapFrame = 'gcj' | 'wgs84'

export const AMAP_SCRIPT_VERSION = '2.0'

/** 高德脚本的默认地址(不含 key) */
const AMAP_SCRIPT_BASE = 'https://webapi.amap.com/maps'

// ─────────────────────────────── GCJ-02 坐标转换 ───────────────────────────────

/** 克拉索夫斯基椭球参数(GCJ-02 加密算法就是用这套,不是 WGS84);ee 的字面量刻意截到 double 精度 */
const GCJ_A = 6378245.0
const GCJ_EE = 0.006693421622965943
const RAD = Math.PI / 180

/**
 * 粗判是否在中国境外。加密算法只在中国境内生效,境外直接返回原值 ——
 * 用包围盒而不是国界多边形:边界上几公里的误差对无人机场景没有意义,
 * 但漏判会让整片区域偏 500m。
 */
export function isOutsideChina(lon: number, lat: number): boolean {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3
  return ret
}

function transformLon(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3
  return ret
}

/** WGS84 → GCJ-02(火星坐标)。境外原样返回。 */
export function wgs84ToGcj02(lon: number, lat: number): LonLat {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new RangeError('lon/lat must be finite numbers')
  }
  if (isOutsideChina(lon, lat)) return { lon, lat }

  let dLat = transformLat(lon - 105, lat - 35)
  let dLon = transformLon(lon - 105, lat - 35)
  const radLat = lat * RAD
  let magic = Math.sin(radLat)
  magic = 1 - GCJ_EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI)
  dLon = (dLon * 180) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return { lon: lon + dLon, lat: lat + dLat }
}

/**
 * GCJ-02 → WGS84。
 *
 * 加密式不可解析求逆,用不动点迭代:每一轮按"把当前解正解回去差多少"来修正。
 * 12 轮 / 1e-9 度(≈0.1mm)在境内全域都足够;实测 3~4 轮就到 1e-11。
 */
export function gcj02ToWgs84(lon: number, lat: number, tolerance = 1e-9, maxIterations = 12): LonLat {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new RangeError('lon/lat must be finite numbers')
  }
  if (isOutsideChina(lon, lat)) return { lon, lat }

  let current: LonLat = { lon, lat }
  for (let i = 0; i < maxIterations; i += 1) {
    const forward = wgs84ToGcj02(current.lon, current.lat)
    const dLon = lon - forward.lon
    const dLat = lat - forward.lat
    current = { lon: current.lon + dLon, lat: current.lat + dLat }
    if (Math.abs(dLon) < tolerance && Math.abs(dLat) < tolerance) break
  }
  return current
}

/**
 * 该点处 GCJ 相对 WGS84 的偏移量(米)。
 *
 * 用途是**诊断**:换坐标系时把偏移打进日志/UI,比"感觉有点偏"可查得多。
 * 北京约 (东 +510m, 北 −230m);越往西南偏移方向越偏斜,所以不要拿单点常量去修正全域。
 */
export function gcj02OffsetMeters(lon: number, lat: number): { east: number; north: number } {
  const gcj = wgs84ToGcj02(lon, lat)
  const metersPerDegLat = 111_132.952613
  const metersPerDegLon = metersPerDegLat * Math.cos(lat * RAD)
  return {
    east: (gcj.lon - lon) * metersPerDegLon,
    north: (gcj.lat - lat) * metersPerDegLat,
  }
}

/** 本地 ENU 米坐标 → WGS84 经纬高。`x` 东 / `y` 上 / `z` 南(与 sim 同约定)。 */
export function localToGeodetic(
  origin: GeodeticCoordinate,
  x: number,
  y: number,
  z: number,
): GeodeticCoordinate {
  const frame = createEcefEnuFrame(origin)
  // ⚠️ 轴序是 [east, north, up],sim 的约定是 x 东 / y 上 / z 南:
  //    north = -z(不是 z),up = y(不是 z)。写反的表现是"爬升 120m 却往北挪了 120m",
  //    而经纬度看起来仍然合理 —— 只有拿高度/南北分开断言才抓得到。
  return ecefToGeodetic(enuToEcef([x, -z, y], frame))
}

/** 本地 ENU 米坐标 → 目标坐标系的经纬度(不带高度)。 */
export function localToLonLat(
  origin: GeodeticCoordinate,
  x: number,
  y: number,
  z: number,
  frame: AmapFrame = 'gcj',
): LonLat {
  const geodetic = localToGeodetic(origin, x, y, z)
  return frame === 'wgs84'
    ? { lon: geodetic.longitude, lat: geodetic.latitude }
    : wgs84ToGcj02(geodetic.longitude, geodetic.latitude)
}

/** 把 WGS84 经纬度投影到目标坐标系;`frame: 'wgs84'` 时原样返回(便于统一调用)。 */
export function projectLonLat(lon: number, lat: number, frame: AmapFrame = 'gcj'): LonLat {
  return frame === 'wgs84' ? { lon, lat } : wgs84ToGcj02(lon, lat)
}

// ───────────────────────────────── 脚本加载 ─────────────────────────────────

/** AMap 命名空间的极小投影:只声明本模块真正调用的成员,避免为一个 key 引入整套 @types */
export interface AmapNamespace {
  Map: new (container: HTMLElement, options?: Record<string, unknown>) => AmapMapInstance
  Marker: new (options?: Record<string, unknown>) => AmapOverlayInstance
  Polyline: new (options?: Record<string, unknown>) => AmapOverlayInstance
  Circle: new (options?: Record<string, unknown>) => AmapOverlayInstance
  /** 多边形:云台取景锥用它画(需要 bubble: true 才支持 setPath) */
  Polygon: new (options?: Record<string, unknown>) => AmapOverlayInstance
  Pixel?: new (x: number, y: number) => unknown
  TileLayer?: {
    Satellite: new (options?: Record<string, unknown>) => unknown
    RoadNet: new (options?: Record<string, unknown>) => unknown
  }
  /** 3D 建筑体块层(它挂在 AMap 顶层,不在 TileLayer 下);只有 3D 视角 + 高缩放才看得见 */
  Buildings?: new (options?: Record<string, unknown>) => unknown
  plugin?: (names: string | string[], ready: () => void) => void
}

export interface AmapMapInstance {
  add(overlays: unknown | unknown[]): void
  remove(overlays: unknown | unknown[]): void
  setCenter(position: [number, number], immediately?: boolean, duration?: number): void
  setZoom(zoom: number): void
  getZoom?(): number
  setPitch?(pitch: number): void
  setRotation?(rotation: number): void
  getPitch?(): number
  getRotation?(): number
  getCenter?(): { getLng(): number; getLat(): number }
  setFitView?(overlays?: unknown[], immediately?: boolean, avoid?: number[]): void
  destroy(): void
  on(event: string, handler: () => void): void
  off?(event: string, handler: () => void): void
}

export interface AmapOverlayInstance {
  setPosition?(position: [number, number]): void
  setAngle?(angle: number): void
  setPath?(path: Array<[number, number]>): void
  show?(): void
  hide?(): void
}

export interface AmapLoadOptions {
  /** web 端 key(控制台 → 应用管理 → Web端(JS API)) */
  key: string
  /** 安全密钥 jscode;2021-12 之后新建的 key 必须配,否则报 INVALID_USER_SCODE */
  securityCode?: string
  /** 需要预加载的插件(如 'AMap.Geocoder');本模块的覆盖物不需要任何插件 */
  plugins?: readonly string[]
  version?: string
  /** 超时(毫秒),默认 15s */
  timeoutMs?: number
}

/** 加载失败时抛这个,带上可读的 code,便于宿主给用户一句人话 */
export class AmapLoadError extends Error {
  readonly code: 'NO_KEY' | 'SCRIPT_ERROR' | 'TIMEOUT' | 'NO_NAMESPACE'
  constructor(code: AmapLoadError['code'], message: string) {
    super(message)
    this.name = 'AmapLoadError'
    this.code = code
  }
}

/** 已注入的脚本(按 key+版本区分);组件重挂载时复用同一块,不能重复注入 */
const pendingLoads = new Map<string, Promise<AmapNamespace>>()

/** 组装脚本地址(key 放参数里;插件名以逗号分隔,高德要求 `plugin=A,B`) */
export function buildAmapScriptUrl(options: AmapLoadOptions): string {
  const params = new URLSearchParams()
  params.set('v', options.version ?? AMAP_SCRIPT_VERSION)
  params.set('key', options.key)
  if (options.plugins?.length) params.set('plugin', options.plugins.join(','))
  return `${AMAP_SCRIPT_BASE}?${params.toString()}`
}

interface AmapGlobalWindow {
  AMap?: AmapNamespace & Record<string, unknown>
  _AMapSecurityConfig?: { securityJsCode?: string }
}

/**
 * 注入并解析 AMap JS API 2.0。同一 `key|version` 只注入一次。
 *
 * 安全密钥在**注入前**写入全局配置 —— 这是官方要求,顺序反了地图不出来且不抛错。
 */
export function loadAmapJs(options: AmapLoadOptions): Promise<AmapNamespace> {
  if (!options.key || !options.key.trim()) {
    return Promise.reject(new AmapLoadError('NO_KEY', '缺少高德 key(VITE_AMAP_KEY)'))
  }
  const cacheKey = `${options.key}|${options.version ?? AMAP_SCRIPT_VERSION}`
  const cached = pendingLoads.get(cacheKey)
  if (cached) return cached

  const promise = new Promise<AmapNamespace>((resolve, reject) => {
    const scope = window as unknown as AmapGlobalWindow
    if (scope.AMap?.Map) {
      resolve(scope.AMap)
      return
    }
    if (options.securityCode) {
      // 必须在脚本加载前设置:高德在脚本自执行阶段就读取这个全局对象
      scope._AMapSecurityConfig = { securityJsCode: options.securityCode }
    }

    const url = buildAmapScriptUrl(options)
    const script = document.createElement('script')
    script.src = url
    script.async = true
    script.dataset.amapKey = options.key

    const timeoutMs = options.timeoutMs ?? 15_000
    let settled = false
    const cleanup = (): void => {
      window.clearTimeout(timer)
      script.onload = null
      script.onerror = null
    }
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      pendingLoads.delete(cacheKey)
      reject(new AmapLoadError('TIMEOUT', `高德脚本 ${timeoutMs}ms 内未就绪`))
    }, timeoutMs)

    script.onload = () => {
      if (settled) return
      settled = true
      cleanup()
      const amap = (window as unknown as AmapGlobalWindow).AMap
      if (!amap?.Map) {
        pendingLoads.delete(cacheKey)
        reject(new AmapLoadError('NO_NAMESPACE', '脚本已加载但没有 window.AMap(通常是 key 无效)'))
        return
      }
      resolve(amap)
    }
    script.onerror = () => {
      if (settled) return
      settled = true
      cleanup()
      pendingLoads.delete(cacheKey)
      reject(new AmapLoadError('SCRIPT_ERROR', '高德脚本加载失败(网络或域名白名单)'))
    }
    document.head.appendChild(script)
  })

  pendingLoads.set(cacheKey, promise)
  return promise
}

/** 只给测试/热重载用:清掉"已加载"缓存,让下一次 loadAmapJs 重新注入 */
export function resetAmapLoaderForTests(): void {
  pendingLoads.clear()
}

// ───────────────────────────────── 地图宿主 ─────────────────────────────────

const STYLE_ID = 'drone-amap-styles'

/**
 * 云台取景锥的示意参数。
 *
 * 相机水平 FOV 固定 60°(与 three 后端一致),所以锥的张角是 ±30°;
 * 最大半径是**平视时的截断**:俯角趋近 0 时地面落点在无穷远,
 * 不截断会画出一个盖住整张地图的扇形。
 */
const VIEW_CONE_HALF_FOV = 30
const VIEW_CONE_MAX_RADIUS = 120
/** 地面覆盖半径的下限:俯角 -90° 时恰好落在机体正下方,留一点面积才看得见 */
const VIEW_CONE_MIN_RADIUS = 2
/** 低于这个高度不画锥(贴地/滑行时没有视场,画出来只是一团噪声) */
const VIEW_CONE_MIN_ALTITUDE = 0.5

/**
 * 机载模式的缩放基准。
 *
 * 云台俯角固定时,地面覆盖半径 ∝ 高度,所以「高度翻倍 = 视野翻倍」——对应地图 zoom 减 1 档。
 * 不这样做的话,按 W 爬升在地图上只是画面往前平移,比例尺不变,看不出飞高了。
 *
 * 基准取 12m(而不是 30m):高德卫星影像最高只到 19 档,再往里就是拉伸糊图,
 * 所以低空必须先顶到 19 档,把可用的变化量留给 12m 以上的常用爬升段。
 * 档位量化到 0.5:连续变化会让高德每次都重算瓦片层级,飞行中表现为画面抖/糊。
 */
const FPV_REF_ALTITUDE = 12
const FPV_BASE_ZOOM = 19
const FPV_MIN_ZOOM = 16
const FPV_MAX_ZOOM = 19
const FPV_ZOOM_STEP = 0.5

/**
 * 云台视场在地面的落点半径(米)。
 *
 * `pitch` 是飞控真值:负 = 下俯,0 = 平视,正 = 上仰。
 * 返回 0 表示"不该画"(在地面);返回极大值被截断到 `VIEW_CONE_MAX_RADIUS`。
 */
export function viewConeRadius(altitude: number, pitch: number): number {
  if (!Number.isFinite(altitude) || altitude <= VIEW_CONE_MIN_ALTITUDE) return 0
  const downward = -Math.min(pitch, 0)
  // 平视或上仰:地面落点在视距外,截断成一条长扇形(示意"看得很远")
  if (downward < 2) return VIEW_CONE_MAX_RADIUS
  const distance = altitude / Math.tan((downward * Math.PI) / 180)
  if (!Number.isFinite(distance)) return VIEW_CONE_MAX_RADIUS
  return Math.min(Math.max(distance, VIEW_CONE_MIN_RADIUS), VIEW_CONE_MAX_RADIUS)
}

/** 覆盖物配色:与库内其它面板同一套暗色令牌,但内联注入,免得宿主还要引 css */
const STYLE_TEXT = `
.dam-drone {
  width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  /* 白描边 + 深投影:卫星图上蓝底白边的辨识度远高于纯蓝 */
  filter: drop-shadow(0 0 2px #fff) drop-shadow(0 2px 6px rgba(0, 0, 0, 0.55));
}
.dam-drone::before {
  content: '';
  width: 0; height: 0;
  border-left: 10px solid transparent;
  border-right: 10px solid transparent;
  border-bottom: 28px solid #35a7ff;
}
/* 原点处机体与返航点重叠,如果两个图形一样大,看起来就是一个色块 —— 用大小差把语义分开 */
.dam-home {
  width: 14px; height: 14px;
  border-radius: 50%;
  border: 2px solid #fbbf24;
  background: rgba(251, 191, 36, 0.2);
  box-sizing: border-box;
}
/* 脉冲光晕:让人一眼锁定机体的当前位置;圆环旋转不变形,挂 ::after 即可 */
@keyframes dam-pulse {
  0%   { transform: scale(0.6); opacity: 0.85; }
  70%  { transform: scale(1.6); opacity: 0; }
  100% { transform: scale(1.6); opacity: 0; }
}
.dam-drone::after {
  content: '';
  position: absolute;
  left: 0; top: 0;
  width: 34px; height: 34px;
  border-radius: 50%;
  border: 2px solid #35a7ff;
  animation: dam-pulse 2.2s ease-out infinite;
  pointer-events: none;
}
.dam-drone { position: relative; }
/*
 * 机载视角的取景环(纯示意):虚线圆 + 十字准星。
 * 高德相机进不了机体内部,所以"机载"只能是追尾观感 —— 这一层的作用是
 * 让切到机载时画面有明确的视觉回答,而不是只把地图转个方向。
 * 取景环挂成机体 marker 的子节点,跟着 marker 的 angle 一起转,天然对齐机头。
 */
.dam-fpv {
  position: absolute;
  left: 50%; top: 50%;
  width: 78px; height: 78px;
  margin: -39px 0 0 -39px;
  border: 1px dashed rgba(53, 167, 255, 0.85);
  border-radius: 50%;
  opacity: 0;
  transition: opacity 0.18s ease;
  pointer-events: none;
}
.dam-fpv::before,
.dam-fpv::after {
  content: '';
  position: absolute;
  background: rgba(53, 167, 255, 0.75);
}
.dam-fpv::before { left: 50%; top: 0; width: 1px; height: 100%; }
.dam-fpv::after  { top: 50%; left: 0; height: 1px; width: 100%; }
.dam-drone.is-fpv .dam-fpv { opacity: 1; }
/* 高度标签:俯视地图上爬升没有位移,这行数字是唯一的视觉反馈 */
.dam-alt {
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(4, 18, 31, 0.82);
  border: 1px solid rgba(53, 167, 255, 0.6);
  color: #d6ecff;
  font: 600 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}
`

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  document.head.appendChild(style)
}

export interface AmapDroneMapOptions {
  /** 地图容器;缺省时抛错(不像面板那样贴 body —— 地图需要明确尺寸) */
  container: HTMLElement
  /** 飞行内核:只读真值(位置/航向/航线/返航点),不写任何状态 */
  sim: DroneSim
  /** 场景原点(WGS84);sim 的本地米坐标以它为零点 */
  origin: GeodeticCoordinate
  /** web 端 key(与 `amap` 二选一:传了 amap 就跳过脚本加载,方便测试/复用) */
  key?: string
  securityCode?: string
  plugins?: readonly string[]
  version?: string
  /** 注入的 AMap 命名空间;给了就不加载脚本 */
  amap?: AmapNamespace
  /** 输出坐标系,默认 'gcj'(与高德底图对齐) */
  frame?: AmapFrame
  /** 初始缩放,默认 17(街区级) */
  zoom?: number
  /**
   * 视角模式,默认 `'3D'`。
   *
   * 注意:`viewMode` 是**建图参数**,2.0 不支持运行时切换 —— 想从 2D 变 3D 只能重建地图。
   * 所以默认就开 3D:`pitch = 0` 看起来与 2D 完全一样,但右键旋转/拖拽倾斜随时可用,
   * 不需要为了换个视角销毁整块地图。
   */
  viewMode?: '2D' | '3D'
  /** 初始倾角(度,0 = 正俯视,上限 83),默认 45;仅 3D 模式有效 */
  pitch?: number
  /** 初始旋转角(度,正北为 0,顺时针),默认 0;仅 3D 模式有效 */
  rotation?: number
  /** 是否叠加 3D 建筑体块层,默认 true(需 3D 视角且 zoom ≥ 16) */
  buildings?: boolean
  /** 是否叠加卫星影像层,默认 true */
  satellite?: boolean
  /** 是否叠加路网注记层,默认 true */
  roadNet?: boolean
  /** 机体是否始终居中(跟随模式),默认 true */
  follow?: boolean
  /** 航迹最多保留的点数,默认 600(约 10 分钟的 1Hz 采样) */
  trailLimit?: number
  /**
   * 相邻航迹点的最小间隔(米),默认 1.5。
   * 不设阈值的话 60fps 会把 polyline 撑成几万个点,一次 setPath 就掉帧。
   */
  trailStepM?: number
  /** 宿主自控节拍时设为 false,改为手动调 sync() */
  autoTick?: boolean
  /** 是否注入样式,默认 true */
  injectStyles?: boolean
}

export interface AmapMapState {
  ready: boolean
  frame: AmapFrame
  follow: boolean
  satellite: boolean
  zoom: number
  /** 机体当前位置(输出坐标系下的经纬度) */
  drone: LonLat | null
  /** 相对起飞点的高度(米,AGL)—— 俯视地图上唯一能反映爬升的数字 */
  altitude: number
  /** 云台俯仰(度,负=俯视);地图屏没有取景画面,这里是飞控真值的只读回显 */
  gimbalPitch: number
  /**
   * 云台取景锥的地面半径(米)。
   *
   * 这是**示意**而非照片画面:把云台视场投到地面,半径 = 高度 / tan(俯角)。
   * 0 = 地面(没有落点),`VIEW_CONE_MAX_RADIUS` = 平视/上仰(落点在视距外,截断)。
   */
  viewRadius: number
  heading: number
  waypoints: number
  trail: number
  /** GCJ 相对 WGS84 的偏移(米),诊断用 */
  offsetMeters: { east: number; north: number } | null
  /** 当前倾角(度);0 = 正俯视 */
  pitch: number
  /** 当前旋转角(度) */
  rotation: number
  /** 视角模式(建图时定,运行期不变) */
  viewMode: '2D' | '3D'
}

export class AmapDroneMap {
  private readonly options: AmapDroneMapOptions
  private readonly frame: AmapFrame
  private amap: AmapNamespace | null = null
  private map: AmapMapInstance | null = null
  private satelliteLayer: unknown = null
  private roadNetLayer: unknown = null
  private buildingsLayer: unknown = null
  private droneMarker: AmapOverlayInstance | null = null
  /** 机体 marker 的根节点(要按视角模式切 `is-fpv` 类,marker 的 content 只能给一次) */
  private droneEl: HTMLElement | null = null
  /** 云台取景锥(多边形):顶点在机体,弧线是地面落点 */
  private viewCone: AmapOverlayInstance | null = null
  private viewConeAdded = false
  /** 上一次画锥的签名(半径 + 航向),避免每帧 setPath 拖累瓦片线程 */
  private viewConeSignature = ''
  /** 机体 marker 当前是否带机载取景环 */
  private fpvFrame = false
  /** 机载模式全量状态:相机坐进云台 + 隐藏机体标记/取景锥/高度标签 */
  private fpvMode = false
  /** 机载模式下上次写入的镜像倾角(云台变化 < 0.5° 不重设,和航向锁同一个节流思路) */
  private lastFpvPitch: number | null = null
  /** 机载模式下上次写入的缩放(高度变化 < 0.05 档不重设) */
  private lastFpvZoom: number | null = null
  private altMarker: AmapOverlayInstance | null = null
  private altitudeEl: HTMLElement | null = null
  private lastAltText = ''
  private altVisible = false
  private homeMarker: AmapOverlayInstance | null = null
  private missionLine: AmapOverlayInstance | null = null
  private trailLine: AmapOverlayInstance | null = null
  /** 折线是否已挂到地图上(空 path 不能上屏,见 createOverlays 的说明) */
  private missionVisible = false
  private trailVisible = false
  private trail: Array<[number, number]> = []
  private missionSignature = ''
  private lastTrailPoint: LonLat | null = null
  private frameHandle = 0
  private destroyed = false
  private ready = false
  private lastFollowAt = 0
  private state: AmapMapState

  constructor(options: AmapDroneMapOptions) {
    if (!options.container) throw new Error('AmapDroneMap 需要一个容器元素')
    this.options = options
    this.frame = options.frame ?? 'gcj'
    this.state = {
      ready: false,
      frame: this.frame,
      follow: options.follow ?? true,
      satellite: options.satellite ?? true,
      zoom: options.zoom ?? 17,
      drone: null,
      altitude: 0,
      gimbalPitch: options.sim.gimbalPitch,
      viewRadius: 0,
      heading: 0,
      waypoints: 0,
      trail: 0,
      offsetMeters: null,
      viewMode: options.viewMode ?? '3D',
      pitch: options.pitch ?? 45,
      rotation: options.rotation ?? 0,
    }
  }

  /** 加载脚本 → 建地图 → 铺覆盖物 → 起循环。重复调用是幂等的。 */
  async open(): Promise<void> {
    if (this.ready || this.destroyed) return
    const amap =
      this.options.amap ??
      (await loadAmapJs({
        key: this.options.key ?? '',
        securityCode: this.options.securityCode,
        plugins: this.options.plugins,
        version: this.options.version,
      }))
    if (this.destroyed) return
    this.amap = amap
    if (this.options.injectStyles !== false) ensureStyles()

    const startPoint = this.droneLonLat()
    const center: [number, number] = [startPoint.lon, startPoint.lat]
    // 图层引用显式持有:不要靠 layers 的下标回填 —— 一旦某个层被关掉,下标就全错位了
    const layers: unknown[] = []
    this.satelliteLayer = this.options.satellite ?? true ? this.createLayer('Satellite') : null
    if (this.satelliteLayer) layers.push(this.satelliteLayer)
    this.roadNetLayer = this.options.roadNet ?? true ? this.createLayer('RoadNet') : null
    if (this.roadNetLayer) layers.push(this.roadNetLayer)
    this.buildingsLayer = this.options.buildings ?? true ? this.createBuildings() : null
    if (this.buildingsLayer) layers.push(this.buildingsLayer)

    const viewMode = this.options.viewMode ?? '3D'
    this.map = new amap.Map(this.options.container, {
      viewMode,
      zoom: this.options.zoom ?? 17,
      center,
      // 3D 才有倾角与旋转;2D 模式传进去会被忽略
      ...(viewMode === '3D'
        ? { pitch: this.options.pitch ?? 45, rotation: this.options.rotation ?? 0 }
        : {}),
      // AMap 2.0 的 layers 参数里 base 层要显式给,否则不会自动补默认底图
      layers: layers.length ? layers : undefined,
      // 3D 视角下这两项默认是开的,但显式写出来免得被某些容器/样式覆盖
      rotateEnable: viewMode === '3D',
      pitchEnable: viewMode === '3D',
      resizeEnable: true,
      showLabel: true,
    })

    await new Promise<void>((resolve) => {
      // 'complete' 在首帧瓦片就绪后触发;没有再兜一层超时,免得永远等下去
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        resolve()
      }
      this.map?.on('complete', finish)
      window.setTimeout(finish, 4000)
    })
    if (this.destroyed) return

    this.createOverlays()
    this.ready = true
    this.state.ready = true
    // 回读真实视角:3D 模式下高德可能对初始 pitch 做夹取,以它为准
    const view = this.getView()
    this.state.pitch = view.pitch
    this.state.rotation = view.rotation
    this.state.zoom = view.zoom
    this.sync()

    if (this.options.autoTick !== false) this.startLoop()
  }

  private createBuildings(): unknown {
    const Ctor = this.amap?.Buildings
    if (!Ctor) return null
    // zooms 是"从第几级开始画到第几级";17 级街区视角正好,再远就是一堆灰块
    return new Ctor({ zooms: [15, 18], heightFactor: 1.6, wallColor: '#3b4252', roofColor: '#4c566a' })
  }

  private createLayer(kind: 'Satellite' | 'RoadNet'): unknown {
    const TileLayer = this.amap?.TileLayer
    const Ctor = TileLayer?.[kind]
    if (!Ctor) return null
    return new Ctor({ zIndex: kind === 'Satellite' ? 0 : 1 })
  }

  private createOverlays(): void {
    const amap = this.amap
    const map = this.map
    if (!amap || !map) return

    // ⚠️ 折线**不能**用空 path 构造后立刻 add:高德会在控制台刷
    //    "error Polyline path"(它拿不到顶点就直接拒绘),而且这条错误每建一次地图就出现若干条。
    // 所以两个图层先建出来但不挂地图,等真的有 ≥2 个点时再 add + setPath(见 syncTrail / syncMission)。
    this.trailLine = new amap.Polyline({
      strokeColor: '#35a7ff',
      strokeWeight: 4,
      strokeOpacity: 0.85,
      showDir: false,
      lineJoin: 'round',
      lineCap: 'round',
    })
    this.missionLine = new amap.Polyline({
      strokeColor: '#fbbf24',
      strokeWeight: 3,
      strokeOpacity: 0.9,
      strokeStyle: 'dashed',
      strokeDasharray: [8, 6],
      lineJoin: 'round',
    })
    // 机体 marker 的 content 给 DOM 节点而不是 HTML 字符串:机载视角要切 `is-fpv`
    // (加一圈虚线取景环 + 十字准星),字符串形式每次都得重建 marker 才能换类。
    const droneEl = document.createElement('div')
    droneEl.className = 'dam-drone'
    const fpvEl = document.createElement('div')
    fpvEl.className = 'dam-fpv'
    droneEl.appendChild(fpvEl)
    this.droneEl = droneEl

    this.droneMarker = new amap.Marker({
      position: [this.droneLonLat().lon, this.droneLonLat().lat],
      content: droneEl,
      offset: amap.Pixel ? new amap.Pixel(-18, -18) : undefined,
      anchor: 'center',
      zIndex: 120,
      // angle 是顺时针角度;sim.heading 同为罗盘角(正北 0°),直接用
      angle: this.options.sim.heading,
    })
    // 云台取景锥:和两条折线一样先建不挂(空 path 上屏会刷 "error Polygon path"),
    // 等 syncViewCone 拿到 ≥3 个顶点再 add + setPath。
    this.viewCone = new amap.Polygon({
      bubble: true,
      fillColor: '#35a7ff',
      // 实测:0.3 的淡蓝叠在深色建筑上完全隐形(同位置 0.5 的对照方块却极其醒目),
      // 0.45 才能在卫星图 / 3D 斜视两种背景下都稳住
      fillOpacity: 0.45,
      strokeColor: '#ffffff',
      strokeWeight: 2.5,
      strokeOpacity: 0.9,
      strokeStyle: 'dashed',
      zIndex: 90,
    })
    this.viewCone.hide?.()
    // 高度标签:地图是俯视投影,爬升在地面上**完全看不出位移**(平面图钉纹丝不动),
    // 只有这块浮在机体检上方的数字能反映高度 —— 也是「拖杆到底改没改高度」的唯一视觉证据。
    // content 直接给 DOM 节点(不是 HTML 字符串),这样每帧只改 textContent,不必重建 marker。
    const altitudeEl = document.createElement('div')
    altitudeEl.className = 'dam-alt'
    altitudeEl.textContent = '0.0m'
    this.altitudeEl = altitudeEl
    this.altMarker = new amap.Marker({
      position: [this.droneLonLat().lon, this.droneLonLat().lat],
      content: altitudeEl,
      anchor: 'bottom-center',
      offset: amap.Pixel ? new amap.Pixel(0, -30) : undefined,
      zIndex: 130,
    })
    this.altMarker.hide?.()

    const home = this.options.sim.homePosition
    const homePoint = this.pointLonLat(home.x, 0, home.z)
    this.homeMarker = new amap.Marker({
      position: [homePoint.lon, homePoint.lat],
      content: '<div class="dam-home"></div>',
      offset: amap.Pixel ? new amap.Pixel(-7, -7) : undefined,
      anchor: 'center',
      zIndex: 100,
    })
    map.add([this.homeMarker, this.droneMarker, this.altMarker].filter(Boolean))
  }

  /**
   * 折线的「有料才上屏」:第一次拿到 ≥2 个点时补一次 setPath + add。
   *
   * @param line 目标折线(可能还没挂到地图上)
   * @param added 该折线是否已挂载的标记(调用方持有,避免重复 add)
   * @param path 顶点数组,调用方保证长度 ≥2
   */
  private drawLine(line: AmapOverlayInstance | null, added: boolean, path: Array<[number, number]>): boolean {
    if (!line) return added
    line.setPath?.(path)
    if (!added) this.map?.add(line)
    return true
  }

  /** 本地 ENU(sim 坐标)→ 输出坐标系经纬度 */
  private pointLonLat(x: number, y: number, z: number): LonLat {
    return localToLonLat(this.options.origin, x, y, z, this.frame)
  }

  private droneLonLat(): LonLat {
    const position = this.options.sim.position
    return this.pointLonLat(position.x, position.y, position.z)
  }

  /** 手动同步一帧(覆盖物 + 跟随 + 航迹)。autoTick 关闭时由宿主自己按节拍调用。 */
  sync(now = Date.now()): void {
    if (!this.ready || !this.map) return
    const sim = this.options.sim
    const current = this.droneLonLat()

    this.droneMarker?.setPosition?.([current.lon, current.lat])
    this.droneMarker?.setAngle?.(sim.heading)

    this.syncMission()
    this.syncTrail(current)
    this.syncAltitude(current)
    this.syncViewCone()
    this.syncFollow(current, now)

    const offset = gcj02OffsetMeters(current.lon, current.lat)
    this.state.drone = current
    this.state.heading = sim.heading
    this.state.trail = this.trail.length
    this.state.offsetMeters = this.frame === 'gcj' ? offset : null
  }

  private syncMission(): void {
    const waypoints = this.options.sim.mission
    // 航点集合变了才重建:setPath 每帧调用会让瓦片线程被 DOM 更新拖住
    const signature = waypoints.map((w) => `${w.x.toFixed(1)},${w.z.toFixed(1)},${w.altitude}`).join(';')
    this.state.waypoints = waypoints.length
    if (signature === this.missionSignature) return
    this.missionSignature = signature
    const path = waypoints.map((w) => {
      const point = this.pointLonLat(w.x, w.altitude, w.z)
      return [point.lon, point.lat] as [number, number]
    })
    // ⚠️ 少于 2 个点时不能 setPath:高德会直接抛 "error Polyline path"
    // (只有 1 个航点时画不出线,什么都不做才是对的)
    if (path.length >= 2) this.missionVisible = this.drawLine(this.missionLine, this.missionVisible, path)
  }

  private syncTrail(current: LonLat): void {
    const step = this.options.trailStepM ?? 1.5
    const limit = this.options.trailLimit ?? 600
    const previous = this.lastTrailPoint
    if (previous) {
      const metersLat = (current.lat - previous.lat) * 111_132.95
      const metersLon = (current.lon - previous.lon) * 111_132.95 * Math.cos((current.lat * Math.PI) / 180)
      if (Math.hypot(metersLat, metersLon) < step) return
    }
    this.lastTrailPoint = current
    this.trail.push([current.lon, current.lat])
    if (this.trail.length > limit) this.trail.splice(0, this.trail.length - limit)
    // 同上:1 个点的 polyline 高德会报 "error Polyline path",等第二个点出现再画
    if (this.trail.length >= 2) this.trailVisible = this.drawLine(this.trailLine, this.trailVisible, this.trail)
  }

  /**
   * 高度标签与云台回显。
   *
   * 地面时标签藏起来(和 14px 的返航点会叠在一起),离地 0.3m 以上才显示。
   * 文本按 0.1m 精度比较,只在变化时写 DOM —— 每帧写 textContent 会让 marker 反复重排。
   */
  private syncAltitude(current: LonLat): void {
    const altitude = this.options.sim.position.y
    this.state.altitude = altitude
    this.state.gimbalPitch = this.options.sim.gimbalPitch ?? 0

    const marker = this.altMarker
    const element = this.altitudeEl
    if (!marker || !element) return

    marker.setPosition?.([current.lon, current.lat])
    const text = `${altitude.toFixed(1)}m`
    if (text !== this.lastAltText) {
      this.lastAltText = text
      element.textContent = text
    }
    // 机载视角下高度标签悬在画面中央挡视线,隐藏(state 里的真值照常回显)
    const visible = altitude > 0.3 && !this.fpvMode
    if (visible === this.altVisible) return
    this.altVisible = visible
    if (visible) marker.show?.()
    else marker.hide?.()
  }

  /**
   * 云台取景锥:把云台的视场投影到地面,画成以机体为顶点的扇形。
   *
   * ⚠️ 这**不是**取景画面 —— 地图屏没有场景相机,画不出照片。它是 UI 示意,
   * 但由真值驱动、几何成立:
   *
   *     地面落点距离 = 高度 / tan(俯角)
   *
   * 俯角 -90° 时落点就在机体正下方(退化成最小半径),平视/上仰时落在视距外
   * (截断到 `VIEW_CONE_MAX_RADIUS`)。所以拖云台滑块时扇形长短是真变化,
   * 不是装饰动画 —— 这是地图屏上唯一能"看见"云台指哪儿的东西。
   */
  private syncViewCone(): void {
    const sim = this.options.sim
    const altitude = sim.position.y
    const radius = viewConeRadius(altitude, sim.gimbalPitch ?? 0)
    this.state.viewRadius = radius

    const cone = this.viewCone
    if (!cone) return

    // 机载视角下取景锥会挡在画面正中(落点就是屏幕中心),整个隐藏
    if (this.fpvMode) {
      if (this.viewConeAdded) cone.hide?.()
      this.viewConeSignature = ''
      return
    }

    if (radius <= 0) {
      if (this.viewConeAdded) cone.hide?.()
      this.viewConeSignature = ''
      return
    }

    // 半径 0.5m / 航向 1° 以内视为没变:setPath 会让高德重算路径几何,
    // 每帧调用会把瓦片线程拖住(和航迹折线同一个坑)。
    const signature = `${radius.toFixed(1)}|${sim.heading.toFixed(1)}`
    if (signature === this.viewConeSignature) {
      if (this.viewConeAdded) cone.show?.()
      return
    }
    this.viewConeSignature = signature

    const apex = this.pointLonLat(sim.position.x, 0, sim.position.z)
    const path: Array<[number, number]> = [[apex.lon, apex.lat]]
    const steps = 10
    for (let i = 0; i <= steps; i += 1) {
      const bearing = ((sim.heading - VIEW_CONE_HALF_FOV + (2 * VIEW_CONE_HALF_FOV * i) / steps) * Math.PI) / 180
      // 罗盘角 → 局部 ENU:东 = sin,北 = cos;sim 的 z 轴朝南,所以 north 要取负
      const point = this.pointLonLat(Math.sin(bearing) * radius, 0, -Math.cos(bearing) * radius)
      path.push([point.lon, point.lat])
    }
    if (path.length < 3) return
    this.viewConeAdded = this.drawLine(cone, this.viewConeAdded, path)
    cone.show?.()
  }

  /**
   * 机载视角:取景环 + 相机摆位 + 覆盖物隐藏。
   *
   * 高德的相机是地图相机,进不了机体内部 —— 但可以**逼近**云台:
   * 把「云台落点」摆到屏幕中心、倾角镜像云台俯仰,镜头就背向机体、看向云台方向,
   * 观感上等于坐进了云台。此时机体标记/取景锥/高度标签都会挡在画面正中,全部隐藏。
   */
  setFpvFrame(on: boolean): void {
    if (this.fpvFrame === on) return
    this.fpvFrame = on
    this.fpvMode = on
    this.droneEl?.classList.toggle('is-fpv', on)
    if (on) {
      this.droneMarker?.hide?.()
      this.viewCone?.hide?.()
      this.altMarker?.hide?.()
      this.viewConeSignature = ''
    } else {
      // 退出时让各 sync 自己按状态恢复;镜像倾角/缩放清零,下次进机载重算
      this.lastFpvPitch = null
      this.lastFpvZoom = null
      this.droneMarker?.show?.()
      this.viewConeSignature = ''
    }
  }

  /**
   * 机载模式下把地图相机摆到云台:落点居中 + 倾角镜像 + 缩放随高度,与 follow 共用 10Hz 节拍。
   *
   * 为什么缩放要跟高度走:云台俯角固定时,相机视野在地面的覆盖范围与高度成正比
   * (距离翻倍,同样的 FOV 覆盖翻倍)。只挪落点、不动缩放的话,按 W 爬升在地图上
   * 表现为「画面往前平移、比例尺不变」——完全没有"升高"的观感,而且落点距离超过
   * `VIEW_CONE_MAX_RADIUS` 后连平移都停了,画面彻底静止。所以每翻一倍高度 zoom −1。
   */
  private applyFpvCamera(): void {
    const sim = this.options.sim
    const altitude = sim.position.y
    // 倾角镜像云台:云台 -10° → 地图倾 80°(近地平线),-90° → 0°(正俯视)。
    // 镜像关系让"压云台"这个动作在机载画面里有直接的方向反馈。
    const gimbal = sim.gimbalPitch ?? 0
    const mapPitch = Math.max(0, Math.min(83, 90 - Math.abs(gimbal)))
    if (this.lastFpvPitch === null || Math.abs(mapPitch - this.lastFpvPitch) >= 0.5) {
      this.lastFpvPitch = mapPitch
      this.map?.setPitch?.(mapPitch)
    }
    // 缩放随高度:12m 基准 19 档,每翻一倍 −1 档,量化到 0.5 档避免瓦片层级反复重算
    const rawZoom = FPV_BASE_ZOOM - Math.log2(Math.max(altitude, 1) / FPV_REF_ALTITUDE)
    const zoom = Math.max(
      FPV_MIN_ZOOM,
      Math.min(FPV_MAX_ZOOM, Math.round(rawZoom / FPV_ZOOM_STEP) * FPV_ZOOM_STEP),
    )
    if (this.lastFpvZoom === null || Math.abs(zoom - this.lastFpvZoom) >= 0.01) {
      this.lastFpvZoom = zoom
      this.setZoom(zoom)
    }
    // 落点 = 云台视线与地面的交点(与取景锥同一几何),摆到屏幕中心
    const distance = viewConeRadius(altitude, gimbal)
    const rad = (sim.heading * Math.PI) / 180
    const aim = this.pointLonLat(Math.sin(rad) * distance, 0, -Math.cos(rad) * distance)
    this.map?.setCenter([aim.lon, aim.lat], true)
  }

  private syncFollow(current: LonLat, now: number): void {
    if (!this.state.follow) return
    // 10Hz 足够:每帧 setCenter 会打断地图的惯性动画,肉眼看反而更抖
    if (now - this.lastFollowAt < 100) return
    this.lastFollowAt = now
    if (this.fpvMode) {
      this.applyFpvCamera()
      return
    }
    this.map?.setCenter([current.lon, current.lat], true)
  }

  private startLoop(): void {
    const tick = (): void => {
      if (this.destroyed) return
      this.sync()
      this.frameHandle = window.requestAnimationFrame(tick)
    }
    this.frameHandle = window.requestAnimationFrame(tick)
  }

  /** 卫星影像层开关(不重建地图,只挂/摘图层) */
  setSatellite(on: boolean): void {
    this.state.satellite = on
    if (!this.map) return
    if (on && !this.satelliteLayer) this.satelliteLayer = this.createLayer('Satellite')
    if (on && this.satelliteLayer) this.map.add(this.satelliteLayer)
    if (!on && this.satelliteLayer) this.map.remove(this.satelliteLayer)
  }

  /** 路网注记层开关 */
  setRoadNet(on: boolean): void {
    if (!this.map) return
    if (on && !this.roadNetLayer) this.roadNetLayer = this.createLayer('RoadNet')
    if (on && this.roadNetLayer) this.map.add(this.roadNetLayer)
    if (!on && this.roadNetLayer) this.map.remove(this.roadNetLayer)
  }

  /** 跟随模式:开 = 机体始终居中;关 = 用户可自由拖动地图 */
  setFollow(on: boolean): void {
    this.state.follow = on
    if (on) this.lastFollowAt = 0
  }

  setZoom(zoom: number): void {
    this.state.zoom = zoom
    this.map?.setZoom(zoom)
  }

  /**
   * 设置倾角(0 = 正俯视,83 = 近乎贴地平线)。
   *
   * 只有 3D 模式生效;2D 模式下高德会静默忽略 —— 所以这里**先夹取再记账**,
   * 状态里永远是可预期的值,不会出现"调了 60 但画面没动、state 却说 60"的假象。
   */
  setPitch(pitch: number): void {
    if (!Number.isFinite(pitch)) return
    const clamped = Math.max(0, Math.min(83, pitch))
    this.state.pitch = clamped
    this.map?.setPitch?.(clamped)
  }

  /** 设置旋转角(度,正北 0,顺时针为正);归一到 (-180, 180] 便于面板显示 */
  setRotation(rotation: number): void {
    if (!Number.isFinite(rotation)) return
    const normalized = ((((rotation + 180) % 360) + 360) % 360) - 180
    this.state.rotation = normalized
    this.map?.setRotation?.(normalized)
  }

  /** 当前视角(倾角 / 旋转 / 缩放);用于面板显示与验证脚本 */
  getView(): { pitch: number; rotation: number; zoom: number } {
    const pitch = this.map?.getPitch?.()
    const rotation = this.map?.getRotation?.()
    const zoom = this.map?.getZoom?.()
    return {
      pitch: typeof pitch === 'number' ? pitch : this.state.pitch,
      rotation: typeof rotation === 'number' ? rotation : this.state.rotation,
      zoom: typeof zoom === 'number' ? zoom : this.state.zoom,
    }
  }

  /**
   * 底层 AMap.Map 实例(未建图时为 null)。
   *
   * 面向两类调用方:宿主想在同一张图上叠自己的覆盖物,以及验证脚本做对照实验
   * (比如"构造时带 path 的 Polygon 能不能画")。约定:封装自己管自己的覆盖物,
   * 拿到实例后新增的东西由调用方自己负责销毁。
   */
  getMapInstance(): AmapMapInstance | null {
    return this.map
  }

  /** 把当前航线/航迹一次性装进视野(切到"总览"时用) */
  fitView(): void {
    if (!this.map?.setFitView) return
    const overlays = [this.missionLine, this.trailLine].filter(Boolean)
    if (!overlays.length) return
    this.map.setFitView(overlays as unknown[], false, [60, 60, 60, 60])
  }

  getState(): AmapMapState {
    return { ...this.state }
  }

  destroy(): void {
    this.destroyed = true
    if (this.frameHandle) {
      window.cancelAnimationFrame(this.frameHandle)
      this.frameHandle = 0
    }
    try {
      this.map?.destroy()
    } catch {
      // AMap 在容器已被移除时 destroy 会抛;这里吞掉,销毁路径不该二次失败
    }
    this.map = null
    this.amap = null
    this.droneMarker = null
    this.droneEl = null
    this.viewCone = null
    this.viewConeAdded = false
    this.viewConeSignature = ''
    this.fpvFrame = false
    this.altMarker = null
    this.altitudeEl = null
    this.lastAltText = ''
    this.altVisible = false
    this.homeMarker = null
    this.missionLine = null
    this.trailLine = null
    this.missionVisible = false
    this.trailVisible = false
    this.trail = []
    this.ready = false
    this.state.ready = false
    if (this.options.injectStyles !== false) document.getElementById(STYLE_ID)?.remove()
  }
}
