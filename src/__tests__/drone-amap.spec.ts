import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  AMAP_SCRIPT_VERSION,
  AmapDroneMap,
  AmapLoadError,
  buildAmapScriptUrl,
  gcj02OffsetMeters,
  gcj02ToWgs84,
  isOutsideChina,
  loadAmapJs,
  localToGeodetic,
  localToLonLat,
  projectLonLat,
  resetAmapLoaderForTests,
  viewConeRadius,
  wgs84ToGcj02,
  type AmapNamespace,
} from '@/lib'
import type { DroneSim } from '@/lib'

const ORIGIN = { longitude: 116.391, latitude: 39.906, altitude: 0 }
/** 米/度(纬度);经度要乘 cos(lat) */
const M_PER_DEG_LAT = 111_132.95

// ───────────────────────────── 坐标系:可证伪的性质 ─────────────────────────────

describe('GCJ-02 坐标转换', () => {
  it('北京点偏移落在公开量级区间(东向为正、约 300~700m)', () => {
    const offset = gcj02OffsetMeters(116.391, 39.906)
    expect(offset.east).toBeGreaterThan(300)
    expect(offset.east).toBeLessThan(700)
    expect(Math.abs(offset.north)).toBeGreaterThan(50)
    expect(Math.abs(offset.north)).toBeLessThan(400)
  })

  it('偏移随纬度单调变化(不是常量平移)', () => {
    const beijing = gcj02OffsetMeters(116.391, 39.906)
    const guangzhou = gcj02OffsetMeters(113.264, 23.129)
    // 两地的偏移向量必须不同(常量平移的实现在这里会露馅);量级差是几十米
    const totalShift = Math.abs(beijing.east - guangzhou.east) + Math.abs(beijing.north - guangzhou.north)
    expect(totalShift).toBeGreaterThan(20)
    expect(Math.abs(beijing.east - guangzhou.east)).toBeGreaterThan(1)
  })

  it('境外不做加密(东京/伦敦原样返回)', () => {
    // 元组解构出来的分量在 noUncheckedIndexedAccess 下是 number | undefined,
    // 所以这里显式标注类型,而不是靠 for...of 的推断
    const samples: Array<[number, number]> = [
      [139.6917, 35.6895],
      [-0.1276, 51.5072],
    ]
    for (const [lon, lat] of samples) {
      expect(wgs84ToGcj02(lon, lat)).toEqual({ lon, lat })
      expect(gcj02ToWgs84(lon, lat)).toEqual({ lon, lat })
    }
    expect(isOutsideChina(139.6917, 35.6895)).toBe(true)
    expect(isOutsideChina(116.391, 39.906)).toBe(false)
  })

  it('WGS84 → GCJ → WGS84 往返误差 < 0.1mm(1e-9 度)', () => {
    const samples: Array<[number, number]> = [
      [116.391, 39.906],
      [121.4737, 31.2304],
      [113.264, 23.129],
      [87.6177, 43.7928], // 乌鲁木齐,境内西北角
      [126.6425, 45.7569], // 哈尔滨
    ]
    for (const [lon, lat] of samples) {
      const gcj = wgs84ToGcj02(lon, lat)
      const back = gcj02ToWgs84(gcj.lon, gcj.lat)
      expect(Math.abs(back.lon - lon)).toBeLessThan(1e-9)
      expect(Math.abs(back.lat - lat)).toBeLessThan(1e-9)
    }
  })

  it('GCJ → WGS84 → GCJ 往返同样收敛(反解是迭代出来的,方向反过来也要对)', () => {
    const gcj = { lon: 116.3975, lat: 39.9087 }
    const wgs = gcj02ToWgs84(gcj.lon, gcj.lat)
    const back = wgs84ToGcj02(wgs.lon, wgs.lat)
    expect(Math.abs(back.lon - gcj.lon)).toBeLessThan(1e-9)
    expect(Math.abs(back.lat - gcj.lat)).toBeLessThan(1e-9)
  })

  it('加密是单调的:经纬度各加 0.01° 后结果仍更大(排除符号写反)', () => {
    const base = wgs84ToGcj02(116.391, 39.906)
    const east = wgs84ToGcj02(116.401, 39.906)
    const north = wgs84ToGcj02(116.391, 39.916)
    expect(east.lon).toBeGreaterThan(base.lon)
    expect(north.lat).toBeGreaterThan(base.lat)
  })

  it('非法输入直接抛错,不返回 NaN 坐标(否则会静默把机体画到非洲)', () => {
    expect(() => wgs84ToGcj02(Number.NaN, 39.9)).toThrow(RangeError)
    expect(() => gcj02ToWgs84(116.3, Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('本地 ENU → 经纬度', () => {
  it('原点处等于锚点本身(GCJ 帧下等于锚点的加密值)', () => {
    const atOrigin = localToLonLat(ORIGIN, 0, 0, 0)
    const expected = wgs84ToGcj02(ORIGIN.longitude, ORIGIN.latitude)
    expect(atOrigin.lon).toBeCloseTo(expected.lon, 12)
    expect(atOrigin.lat).toBeCloseTo(expected.lat, 12)
  })

  it('frame: wgs84 时不做加密补偿(与 ENU 反算一致)', () => {
    const geodetic = localToGeodetic(ORIGIN, 0, 0, 0)
    const raw = localToLonLat(ORIGIN, 0, 0, 0, 'wgs84')
    expect(raw.lon).toBeCloseTo(geodetic.longitude, 12)
    expect(raw.lat).toBeCloseTo(geodetic.latitude, 12)
    // 两种帧之间必须差出那 ~500m,否则说明 frame 参数根本没生效
    const gcj = localToLonLat(ORIGIN, 0, 0, 0, 'gcj')
    expect(Math.abs(gcj.lon - raw.lon)).toBeGreaterThan(1e-4)
  })

  it('东向 100m 只改经度、北向 100m 只改纬度,且量级对得上', () => {
    const east = localToLonLat(ORIGIN, 100, 0, 0, 'wgs84')
    const base = localToLonLat(ORIGIN, 0, 0, 0, 'wgs84')
    const metersEast = (east.lon - base.lon) * M_PER_DEG_LAT * Math.cos((ORIGIN.latitude * Math.PI) / 180)
    // 容差 1%:ENU 直线弦长与"度→米"的椭球近似本来就有千分之几的差,这里只验证轴与量级
    expect(metersEast).toBeGreaterThan(99)
    expect(metersEast).toBeLessThan(101)
    // 东移的纬度串扰是**弦长 vs 弧长**的几何效应(~0.0006m),不是轴写错;
    // 轴真写错的话量级是 0.001 度(约 100m),差 5 个数量级
    expect(Math.abs(east.lat - base.lat)).toBeLessThan(1e-7)

    const north = localToLonLat(ORIGIN, 0, 0, -100, 'wgs84')
    const metersNorth = (north.lat - base.lat) * M_PER_DEG_LAT
    expect(metersNorth).toBeGreaterThan(99)
    expect(metersNorth).toBeLessThan(101)
    expect(Math.abs(north.lon - base.lon)).toBeLessThan(1e-7)
  })

  it('sim 的 z 轴指向南:z 增大 = 往南走(纬度变小)', () => {
    const base = localToLonLat(ORIGIN, 0, 0, 0, 'wgs84')
    const south = localToLonLat(ORIGIN, 0, 0, 50, 'wgs84')
    expect(south.lat).toBeLessThan(base.lat)
  })

  it('高度只影响海拔,不改变经纬度(1e-7 度以内)', () => {
    const ground = localToGeodetic(ORIGIN, 0, 0, 0)
    const flying = localToGeodetic(ORIGIN, 0, 120, 0)
    expect(Math.abs((flying.longitude ?? 0) - (ground.longitude ?? 0))).toBeLessThan(1e-7)
    expect(Math.abs((flying.latitude ?? 0) - (ground.latitude ?? 0))).toBeLessThan(1e-7)
    expect((flying.altitude ?? 0) - (ground.altitude ?? 0)).toBeCloseTo(120, 0)
  })

  it('projectLonLat 与 frame 语义一致', () => {
    expect(projectLonLat(116.391, 39.906, 'wgs84')).toEqual({ lon: 116.391, lat: 39.906 })
    const gcj = projectLonLat(116.391, 39.906, 'gcj')
    expect(gcj.lon).toBeCloseTo(wgs84ToGcj02(116.391, 39.906).lon, 12)
  })
})

// ───────────────────────────── 脚本加载 ─────────────────────────────

describe('buildAmapScriptUrl', () => {
  it('带版本号与 key', () => {
    const url = buildAmapScriptUrl({ key: 'abc123' })
    expect(url.startsWith('https://webapi.amap.com/maps?')).toBe(true)
    expect(url).toContain(`v=${AMAP_SCRIPT_VERSION}`)
    expect(url).toContain('key=abc123')
    expect(url).not.toContain('plugin=')
  })

  it('插件用逗号拼接(高德要求单个 plugin 参数)', () => {
    const url = buildAmapScriptUrl({ key: 'k', plugins: ['AMap.Geocoder', 'AMap.PlaceSearch'] })
    expect(url).toContain('plugin=AMap.Geocoder%2CAMap.PlaceSearch')
    expect(url.split('plugin=').length).toBe(2)
  })
})

describe('loadAmapJs', () => {
  beforeEach(() => {
    resetAmapLoaderForTests()
    document.head.innerHTML = ''
    delete (window as unknown as Record<string, unknown>).AMap
    delete (window as unknown as Record<string, unknown>)._AMapSecurityConfig
  })

  afterEach(() => {
    vi.useRealTimers()
    document.head.innerHTML = ''
    delete (window as unknown as Record<string, unknown>).AMap
  })

  it('空 key 直接拒绝,不注入脚本', async () => {
    await expect(loadAmapJs({ key: '  ' })).rejects.toMatchObject({ code: 'NO_KEY' })
    expect(document.querySelectorAll('script[data-amap-key]').length).toBe(0)
  })

  it('安全密钥在脚本注入之前就写进全局(顺序反了会报 INVALID_USER_SCODE)', async () => {
    const seen: Array<string | undefined> = []
    loadAmapJs({ key: 'k1', securityCode: 'sec-1' }).catch(() => {})
    // 脚本已在 head 里:此刻全局配置必须已经就位
    seen.push((window as unknown as { _AMapSecurityConfig?: { securityJsCode?: string } })._AMapSecurityConfig?.securityJsCode)
    expect(seen[0]).toBe('sec-1')
    const script = document.querySelector<HTMLScriptElement>('script[data-amap-key="k1"]')
    expect(script?.src).toContain('key=k1')
  })

  it('同一 key 重复调用只注入一次脚本,并且拿到的是同一个 Promise', async () => {
    const first = loadAmapJs({ key: 'k2' })
    const second = loadAmapJs({ key: 'k2' })
    expect(first).toBe(second)
    expect(document.querySelectorAll('script[data-amap-key="k2"]').length).toBe(1)

    // 手动让脚本"加载成功",确认两边一起 resolve(同一实例,不是各建一份)
    ;(window as unknown as Record<string, unknown>).AMap = { Map: class {} }
    document.querySelector<HTMLScriptElement>('script[data-amap-key="k2"]')!.onload?.(new Event('load'))
    await expect(first).resolves.toBe((window as unknown as { AMap: unknown }).AMap)
  })

  it('脚本 onload 但没有 window.AMap → NO_NAMESPACE(通常是 key 无效)', async () => {
    const pending = loadAmapJs({ key: 'k3' })
    const script = document.querySelector<HTMLScriptElement>('script[data-amap-key="k3"]')!
    script.onload?.(new Event('load'))
    await expect(pending).rejects.toMatchObject({ code: 'NO_NAMESPACE' })
  })

  it('网络失败 → SCRIPT_ERROR,且清掉缓存允许重试', async () => {
    const pending = loadAmapJs({ key: 'k4' })
    document.querySelector<HTMLScriptElement>('script[data-amap-key="k4"]')!.onerror?.(new Event('error'))
    await expect(pending).rejects.toBeInstanceOf(AmapLoadError)
    // 再调一次:必须重新注入一个 script(缓存已清)
    loadAmapJs({ key: 'k4' }).catch(() => {})
    expect(document.querySelectorAll('script[data-amap-key="k4"]').length).toBe(2)
  })

  it('已经存在 window.AMap 时不再注入脚本', async () => {
    ;(window as unknown as Record<string, unknown>).AMap = { Map: class {} }
    const amap = await loadAmapJs({ key: 'k5' })
    expect(typeof amap.Map).toBe('function')
    expect(document.querySelectorAll('script[data-amap-key="k5"]').length).toBe(0)
  })
})

// ───────────────────────────── 地图宿主 ─────────────────────────────

interface FakeCalls {
  mapOptions: Array<Record<string, unknown>>
  added: unknown[]
  removed: unknown[]
  centers: Array<[number, number]>
  zooms: number[]
  fitViews: number
  destroyed: number
  markers: Array<{ options: Record<string, unknown>; position?: [number, number]; angle?: number; visible: boolean }>
  polylines: Array<{ options: Record<string, unknown>; path: Array<[number, number]> }>
  /** 多边形单独记账:取景锥的描边色和航迹线同为 #35a7ff,混在一起会找错对象 */
  polygons: Array<{ options: Record<string, unknown>; path: Array<[number, number]>; visible: boolean }>
  layers: unknown[]
}

function makeFakeAmap(completeOnRegister = true): { amap: AmapNamespace; calls: FakeCalls } {
  const calls: FakeCalls = {
    mapOptions: [],
    added: [],
    removed: [],
    centers: [],
    zooms: [],
    fitViews: 0,
    destroyed: 0,
    markers: [],
    polylines: [],
    polygons: [],
    layers: [],
  }

  class FakeMarker {
    options: Record<string, unknown>
    position?: [number, number]
    angle?: number
    visible = true
    constructor(options: Record<string, unknown> = {}) {
      this.options = options
      this.position = options.position as [number, number] | undefined
      this.angle = options.angle as number | undefined
      calls.markers.push(this)
    }
    setPosition(position: [number, number]): void {
      this.position = position
    }
    setAngle(angle: number): void {
      this.angle = angle
    }
    show(): void {
      this.visible = true
    }
    hide(): void {
      this.visible = false
    }
  }

  class FakePolyline {
    options: Record<string, unknown>
    path: Array<[number, number]> = []
    constructor(options: Record<string, unknown> = {}) {
      this.options = options
      this.path = (options.path as Array<[number, number]>) ?? []
      calls.polylines.push(this)
    }
    setPath(path: Array<[number, number]>): void {
      this.path = path
    }
  }

  class FakeLayer {
    constructor(readonly kind: string) {
      calls.layers.push(this)
    }
  }

  /** 取景锥用的多边形:和 Polyline 一样带 path,但多一个显隐状态 */
  class FakePolygon {
    options: Record<string, unknown>
    path: Array<[number, number]> = []
    visible = true
    constructor(options: Record<string, unknown> = {}) {
      this.options = options
      calls.polygons.push(this)
    }
    setPath(path: Array<[number, number]>): void {
      this.path = path
    }
    show(): void {
      this.visible = true
    }
    hide(): void {
      this.visible = false
    }
  }

  function withView(map: FakeMap): void {
    // 高德会夹取 pitch 到 0~83;这里模拟同样的行为,才能验出"记账 = 画面"
    const initialPitch = (calls.mapOptions[0]?.pitch as number | undefined) ?? 0
    const initialRotation = (calls.mapOptions[0]?.rotation as number | undefined) ?? 0
    let pitch = initialPitch
    let rotation = initialRotation
    Object.assign(map, {
      setPitch: (value: number) => {
        pitch = Math.max(0, Math.min(83, value))
      },
      setRotation: (value: number) => {
        rotation = value
      },
      getPitch: () => pitch,
      getRotation: () => rotation,
      getZoom: () => 17,
    })
  }

  class FakeMap {
    constructor(_container: HTMLElement, options: Record<string, unknown> = {}) {
      calls.mapOptions.push(options)
      withView(this)
    }
    add(overlay: unknown | unknown[]): void {
      calls.added.push(overlay)
    }
    remove(overlay: unknown | unknown[]): void {
      calls.removed.push(overlay)
    }
    setCenter(position: [number, number]): void {
      calls.centers.push(position)
    }
    setZoom(zoom: number): void {
      calls.zooms.push(zoom)
    }
    setFitView(): void {
      calls.fitViews += 1
    }
    on(event: string, handler: () => void): void {
      if (event === 'complete' && completeOnRegister) handler()
    }
    setPitch(_pitch: number): void {}
    setRotation(_rotation: number): void {}
    getPitch(): number {
      return 0
    }
    getRotation(): number {
      return 0
    }
    getZoom(): number {
      return 17
    }
    destroy(): void {
      calls.destroyed += 1
    }
  }

  const amap = {
    Map: FakeMap,
    Marker: FakeMarker,
    Polyline: FakePolyline,
    Polygon: FakePolygon,
    Circle: FakeMarker,
    Pixel: class {},
    TileLayer: {
      Satellite: class extends FakeLayer {
        constructor() {
          super('satellite')
        }
      },
      RoadNet: class extends FakeLayer {
        constructor() {
          super('roadnet')
        }
      },
    },
    Buildings: class extends FakeLayer {
      constructor() {
        super('buildings')
      }
    },
  } as unknown as AmapNamespace
  return { amap, calls }
}

function makeSim(overrides: Partial<{ x: number; y: number; z: number; heading: number; mission: unknown[] }> = {}) {
  const sim = {
    position: { x: overrides.x ?? 0, y: overrides.y ?? 0, z: overrides.z ?? 0 },
    heading: overrides.heading ?? 0,
    mission: overrides.mission ?? [],
    homePosition: { x: 0, z: 0 },
    gimbalPitch: 0,
  }
  return sim as unknown as DroneSim
}

describe('AmapDroneMap', () => {
  it('open() 建图:中心落在机体位置,卫星 + 路网 + 3D 建筑三层都挂上', async () => {
    const { amap, calls } = makeFakeAmap()
    const map = new AmapDroneMap({
      container: document.createElement('div'),
      sim: makeSim({ x: 30, y: 20, z: -40 }),
      origin: ORIGIN,
      amap,
      autoTick: false,
    })
    await map.open()
    const options = calls.mapOptions[0]!
    expect(options.zoom).toBe(17)
    expect((options.layers as unknown[]).length).toBe(3) // 卫星 + 路网 + 3D 建筑
    const expected = localToLonLat(ORIGIN, 30, 20, -40, 'gcj')
    const center = options.center as [number, number]
    expect(center[0]).toBeCloseTo(expected.lon, 9)
    expect(center[1]).toBeCloseTo(expected.lat, 9)
    expect(map.getState().ready).toBe(true)
    map.destroy()
  })

  it('sync() 把位置与航向写到机体 marker(航向是罗盘角,直接当 angle)', async () => {
    const { amap, calls } = makeFakeAmap()
    const sim = makeSim({ x: 10, z: 0, heading: 135 })
    const map = new AmapDroneMap({ container: document.createElement('div'), sim, origin: ORIGIN, amap, autoTick: false })
    await map.open()
    map.sync(1_000)

    const drone = calls.markers[0]!
    const expected = localToLonLat(ORIGIN, 10, 0, 0, 'gcj')
    expect(drone.position?.[0]).toBeCloseTo(expected.lon, 9)
    expect(drone.position?.[1]).toBeCloseTo(expected.lat, 9)
    expect(drone.angle).toBe(135)

    sim.position.x = -25
    sim.heading = 270
    map.sync(1_100)
    const moved = localToLonLat(ORIGIN, -25, 0, 0, 'gcj')
    expect(drone.position?.[0]).toBeCloseTo(moved.lon, 9)
    expect(drone.angle).toBe(270)
    map.destroy()
  })

  it('航线只在航点变化时重建 setPath(每帧重建会拖垮地图)', async () => {
    const { amap, calls } = makeFakeAmap()
    const sim = makeSim()
    const map = new AmapDroneMap({ container: document.createElement('div'), sim, origin: ORIGIN, amap, autoTick: false })
    await map.open()
    const missionLine = calls.polylines.find((line) => line.options.strokeColor === '#fbbf24')!

    sim.mission = [
      { x: 0, z: 0, altitude: 30, speed: 0, hoverSeconds: 0, gimbalPitch: null, action: 'none' },
      { x: 40, z: -20, altitude: 40, speed: 0, hoverSeconds: 0, gimbalPitch: null, action: 'none' },
    ]
    map.sync(1_000)
    expect(missionLine.path.length).toBe(2)
    expect(map.getState().waypoints).toBe(2)
    const snapshot = missionLine.path
    map.sync(1_100)
    expect(missionLine.path).toBe(snapshot) // 同一个数组引用 = 没有重新 setPath

    sim.mission = [...sim.mission, { x: 80, z: 0, altitude: 50, speed: 0, hoverSeconds: 0, gimbalPitch: null, action: 'none' }]
    map.sync(1_200)
    expect(missionLine.path.length).toBe(3)
    map.destroy()
  })

  it('航迹按最小间隔取样,并受上限裁剪', async () => {
    const { amap, calls } = makeFakeAmap()
    const sim = makeSim()
    const map = new AmapDroneMap({
      container: document.createElement('div'),
      sim,
      origin: ORIGIN,
      amap,
      autoTick: false,
      trailStepM: 5,
      trailLimit: 3,
    })
    await map.open()
    const trailLine = calls.polylines.find((line) => line.options.strokeColor === '#35a7ff')!

    map.sync(1_000) // 第一个点无条件入列
    // ⚠️ 但只有 1 个点时**不能** setPath:高德对单点折线报 "error Polyline path",
    // 真机上表现为控制台刷错误、线还不显示。要等第二个点才画。
    expect(map.getState().trail).toBe(1)
    expect(trailLine.path.length).toBe(0)

    sim.position.x = 1 // 1m < 5m 阈值
    map.sync(1_100)
    expect(trailLine.path.length).toBe(0)

    for (const x of [10, 20, 30, 40]) {
      sim.position.x = x
      map.sync(1_200 + x)
    }
    expect(map.getState().trail).toBe(3) // 上限 3
    expect(trailLine.path.length).toBe(3)
    map.destroy()
  })

  it('航迹从不在只有 1 个点时 setPath(高德会报 error Polyline path)', async () => {
    const { amap, calls } = makeFakeAmap()
    const sim = makeSim()
    const map = new AmapDroneMap({
      container: document.createElement('div'),
      sim,
      origin: ORIGIN,
      amap,
      autoTick: false,
      trailStepM: 1,
    })
    await map.open()
    // calls.polylines 只保留了 options/path 两个字段的类型,FakePolyline 的 setPath 不在里面 ——
    // 这里按结构断言补上,才能在测试里包一层计数器
    type PathLine = {
      options: Record<string, unknown>
      path: Array<[number, number]>
      setPath(path: Array<[number, number]>): void
    }
    const trailLine = calls.polylines.find((line) => line.options.strokeColor === '#35a7ff')! as unknown as PathLine
    let singlePointPaths = 0
    const original = trailLine.setPath.bind(trailLine)
    trailLine.setPath = (path: Array<[number, number]>): void => {
      if (path.length < 2) singlePointPaths += 1
      original(path)
    }

    for (let i = 0; i < 6; i += 1) {
      sim.position.x = i * 3
      map.sync(2_000 + i * 200)
    }
    expect(singlePointPaths).toBe(0)
    expect(trailLine.path.length).toBeGreaterThanOrEqual(2)
    map.destroy()
  })

  it('高度标签:离地显示、按 0.1m 更新、落地隐藏(俯视地图上唯一的爬升反馈)', async () => {
    const { amap, calls } = makeFakeAmap()
    const sim = makeSim()
    const map = new AmapDroneMap({ container: document.createElement('div'), sim, origin: ORIGIN, amap, autoTick: false })
    await map.open()
    const altMarker = calls.markers.find((marker) => marker.options.zIndex === 130)!
    const element = altMarker.options.content as HTMLElement
    expect(element.className).toBe('dam-alt')

    // 地面:标签藏起来,免得和返航点叠在一起
    sim.position.y = 0
    map.sync(1_000)
    expect(altMarker.visible).toBe(false)
    expect(map.getState().altitude).toBe(0)

    // 离地:显示并写出高度
    sim.position.y = 12.34
    map.sync(1_100)
    expect(altMarker.visible).toBe(true)
    expect(element.textContent).toBe('12.3m')
    expect(map.getState().altitude).toBeCloseTo(12.34, 2)

    // 高度变化会刷新文本;位置跟着机体走
    sim.position.y = 24
    map.sync(1_200)
    expect(element.textContent).toBe('24.0m')
    expect(altMarker.position).toEqual([
      expect.any(Number),
      expect.any(Number),
    ])

    // 回落到 0.3m 以下重新隐藏
    sim.position.y = 0.1
    map.sync(1_300)
    expect(altMarker.visible).toBe(false)
    map.destroy()
  })

  it('云台俯仰在地图状态里可读(地图屏没有取景画面,只回显飞控真值)', async () => {
    const { amap } = makeFakeAmap()
    const sim = makeSim()
    const map = new AmapDroneMap({ container: document.createElement('div'), sim, origin: ORIGIN, amap, autoTick: false })
    await map.open()
    // makeSim 是结构 stub:云台字段直接写,模拟面板拖云台滑块
    ;(sim as unknown as { gimbalPitch: number }).gimbalPitch = -45
    map.sync(1_000)
    expect(map.getState().gimbalPitch).toBeCloseTo(-45, 1)
    map.destroy()
  })

  it('跟随模式 10Hz 节流:100ms 内的连续 sync 只 setCenter 一次', async () => {
    const { amap, calls } = makeFakeAmap()
    const map = new AmapDroneMap({ container: document.createElement('div'), sim: makeSim(), origin: ORIGIN, amap, autoTick: false })
    await map.open()
    map.setFollow(true) // 复位节流时间戳(open 内部已经 sync 过一帧)
    calls.centers.length = 0
    map.sync(10_000)
    map.sync(10_050)
    map.sync(10_099)
    expect(calls.centers.length).toBe(1)
    map.sync(10_120)
    expect(calls.centers.length).toBe(2)
    map.destroy()
  })

  it('setFollow(false) 后不再抢镜头(setCenter 停止)', async () => {
    const { amap, calls } = makeFakeAmap()
    const map = new AmapDroneMap({ container: document.createElement('div'), sim: makeSim(), origin: ORIGIN, amap, autoTick: false })
    await map.open()
    map.setFollow(false)
    calls.centers.length = 0
    map.sync(20_000)
    expect(calls.centers.length).toBe(0)
    expect(map.getState().follow).toBe(false)
    map.destroy()
  })

  it('卫星层可以摘掉再挂回,不会重复创建图层', async () => {
    const { amap, calls } = makeFakeAmap()
    const map = new AmapDroneMap({ container: document.createElement('div'), sim: makeSim(), origin: ORIGIN, amap, autoTick: false })
    await map.open()
    const layerCount = calls.layers.length

    map.setSatellite(false)
    expect(calls.removed.length).toBe(1)
    map.setSatellite(true)
    expect(calls.layers.length).toBe(layerCount) // 复用已有图层,没有新建
    expect(calls.added.length).toBeGreaterThan(0)
    map.destroy()
  })

  it('destroy() 回收:地图销毁、循环停掉、样式移除', async () => {
    const { amap, calls } = makeFakeAmap()
    const map = new AmapDroneMap({ container: document.createElement('div'), sim: makeSim(), origin: ORIGIN, amap, autoTick: false })
    await map.open()
    expect(document.getElementById('drone-amap-styles')).not.toBeNull()
    map.destroy()
    expect(calls.destroyed).toBe(1)
    expect(document.getElementById('drone-amap-styles')).toBeNull()
    expect(map.getState().ready).toBe(false)
    // 销毁后再 sync 必须是空操作(不能抛,也不能碰已销毁的 map)
    expect(() => map.sync(30_000)).not.toThrow()
  })

  it('默认按 3D 建图:viewMode/pitch/rotation 都传给高德,并允许旋转倾斜', async () => {
    const { amap, calls } = makeFakeAmap()
    const map = new AmapDroneMap({ container: document.createElement('div'), sim: makeSim(), origin: ORIGIN, amap, autoTick: false })
    await map.open()
    const options = calls.mapOptions[0]!
    expect(options.viewMode).toBe('3D')
    expect(options.pitch).toBe(45)
    expect(options.rotation).toBe(0)
    expect(options.rotateEnable).toBe(true)
    expect(options.pitchEnable).toBe(true)
    expect(map.getState().viewMode).toBe('3D')
    map.destroy()
  })

  it('viewMode 2D 时不传倾角/旋转,且禁用旋转倾斜(2D 下这两项会被静默忽略)', async () => {
    const { amap, calls } = makeFakeAmap()
    const map = new AmapDroneMap({
      container: document.createElement('div'),
      sim: makeSim(),
      origin: ORIGIN,
      amap,
      viewMode: '2D',
      pitch: 60,
      autoTick: false,
    })
    await map.open()
    const options = calls.mapOptions[0]!
    expect(options.viewMode).toBe('2D')
    expect(options.pitch).toBeUndefined()
    expect(options.rotateEnable).toBe(false)
    map.destroy()
  })

  it('setPitch 夹取到 0~83,setRotation 归一到 (-180,180]', async () => {
    const { amap } = makeFakeAmap()
    const map = new AmapDroneMap({ container: document.createElement('div'), sim: makeSim(), origin: ORIGIN, amap, autoTick: false })
    await map.open()

    map.setPitch(95)
    expect(map.getView().pitch).toBe(83)
    map.setPitch(-20)
    expect(map.getView().pitch).toBe(0)
    map.setPitch(Number.NaN) // 非法值直接忽略,不能把视角写成 NaN
    expect(map.getView().pitch).toBe(0)

    map.setRotation(190)
    expect(map.getView().rotation).toBeCloseTo(-170, 6)
    map.setRotation(-190)
    expect(map.getView().rotation).toBeCloseTo(170, 6)
    map.destroy()
  })

  it('close 前把真实视角回读进 state(用户可能建图时就拖动过地图)', async () => {
    const { amap } = makeFakeAmap()
    const map = new AmapDroneMap({
      container: document.createElement('div'),
      sim: makeSim(),
      origin: ORIGIN,
      amap,
      pitch: 30,
      rotation: 20,
      autoTick: false,
    })
    await map.open()
    expect(map.getState().pitch).toBe(30)
    expect(map.getState().rotation).toBe(20)
    map.setPitch(12)
    expect(map.getState().pitch).toBe(12)
    map.destroy()
  })

  it('buildings: false 时不挂 3D 建筑层(省一次瓦片请求)', async () => {
    const { amap, calls } = makeFakeAmap()
    const map = new AmapDroneMap({
      container: document.createElement('div'),
      sim: makeSim(),
      origin: ORIGIN,
      amap,
      buildings: false,
      autoTick: false,
    })
    await map.open()
    const layers = calls.mapOptions[0]!.layers as unknown[]
    expect(layers.length).toBe(2)
    expect(calls.layers.some((layer) => (layer as { kind?: string }).kind === 'buildings')).toBe(false)
    map.destroy()
  })

  it('frame: wgs84 时不加密,且 state 里不再报告偏移', async () => {
    const { amap, calls } = makeFakeAmap()
    const map = new AmapDroneMap({
      container: document.createElement('div'),
      sim: makeSim(),
      origin: ORIGIN,
      amap,
      frame: 'wgs84',
      autoTick: false,
    })
    await map.open()
    map.sync(1_000)
    const drone = calls.markers[0]!
    expect(drone.position?.[0]).toBeCloseTo(ORIGIN.longitude, 9)
    expect(drone.position?.[1]).toBeCloseTo(ORIGIN.latitude, 9)
    expect(map.getState().offsetMeters).toBeNull()
    map.destroy()
  })
})

// ─────────────────────────── 云台取景锥 + 机载取景环(UI 示意) ───────────────────────────

describe('云台取景锥:地图屏上唯一能"看见"云台指哪儿的东西', () => {
  it('半径 = 高度 / tan(俯角):地面为 0、垂直下视落到脚下、平视截断', () => {
    // 地面不画(贴地时没有视场可言)
    expect(viewConeRadius(0, -45)).toBe(0)
    expect(viewConeRadius(0.4, -45)).toBe(0)

    // 45° 俯角时落点距离恰好等于高度 —— 几何自检
    expect(viewConeRadius(30, -45)).toBeCloseTo(30, 5)
    expect(viewConeRadius(30, -80)).toBeCloseTo(30 / Math.tan((80 * Math.PI) / 180), 4)

    // 垂直下视:落在机体正下方,夹到最小半径(否则扇形退化成一个点看不见)
    expect(viewConeRadius(30, -90)).toBe(2)

    // 平视 / 上仰:落点在视距外,截断
    expect(viewConeRadius(30, 0)).toBe(120)
    expect(viewConeRadius(30, 25)).toBe(120)

    // 越平越长:这条不等关系就是"拖云台滑块扇形会变长短"的数学保证
    expect(viewConeRadius(30, -20)).toBeGreaterThan(viewConeRadius(30, -60))
  })

  it('地面隐藏、起飞后画出以机体为顶点的扇形,朝向随机头、长短随俯角', async () => {
    const { amap, calls } = makeFakeAmap()
    const sim = makeSim({ x: 0, y: 0, z: 0, heading: 0 })
    const map = new AmapDroneMap({ container: document.createElement('div'), sim, origin: ORIGIN, amap, autoTick: false })
    await map.open()
    const cone = calls.polygons[0]!
    expect(cone.visible).toBe(false)

    // 地面上不挂地图
    map.sync(1_000)
    expect(calls.added).not.toContain(cone)
    expect(map.getState().viewRadius).toBe(0)

    // 30m 高、云台 -45° → 半径 30m,扇形 12 个顶点(机体 1 + 弧上 11)
    sim.position.y = 30
    sim.gimbalPitch = -45
    map.sync(1_100)
    expect(cone.visible).toBe(true)
    expect(calls.added).toContain(cone)
    expect(cone.path.length).toBe(12)
    expect(map.getState().viewRadius).toBeCloseTo(30, 4)

    // 顶点在机体正上方,中轴弧点在正北 r 处(sim 的 z 朝南,所以 north = -z)
    const expectedCenter = localToLonLat(ORIGIN, 0, 0, -30, 'gcj')
    expect(cone.path[6]![0]).toBeCloseTo(expectedCenter.lon, 8)
    expect(cone.path[6]![1]).toBeCloseTo(expectedCenter.lat, 8)

    // 机头转东 → 中轴弧点跟到东侧
    sim.heading = 90
    map.sync(1_200)
    const expectedEast = localToLonLat(ORIGIN, 30, 0, 0, 'gcj')
    expect(cone.path[6]![0]).toBeCloseTo(expectedEast.lon, 8)
    expect(cone.path[6]![1]).toBeCloseTo(expectedEast.lat, 8)

    // 云台压到 -80° → 扇形缩短(高度 30 / tan80 ≈ 5.3m)
    sim.gimbalPitch = -80
    map.sync(1_300)
    expect(map.getState().viewRadius).toBeLessThan(6)
    expect(cone.path.length).toBe(12)

    // 落地重新隐藏
    sim.position.y = 0
    map.sync(1_400)
    expect(cone.visible).toBe(false)
    map.destroy()
  })

  it('机载取景环:setFpvFrame 在机体 marker 上切 is-fpv(地图相机进不了机体,这是示意)', async () => {
    const { amap, calls } = makeFakeAmap()
    const map = new AmapDroneMap({
      container: document.createElement('div'),
      sim: makeSim(),
      origin: ORIGIN,
      amap,
      autoTick: false,
    })
    await map.open()
    const droneEl = calls.markers[0]!.options.content as HTMLElement
    expect(droneEl.className).toBe('dam-drone')
    expect(droneEl.querySelector('.dam-fpv')).not.toBeNull()

    map.setFpvFrame(true)
    expect(droneEl.classList.contains('is-fpv')).toBe(true)
    map.setFpvFrame(false)
    expect(droneEl.classList.contains('is-fpv')).toBe(false)
    map.destroy()
  })

  it('机载视角 = 相机坐进云台:落点居中 + 倾角镜像 + 指示标全部隐藏,退出恢复', async () => {
    const { amap, calls } = makeFakeAmap()
    const sim = makeSim({ x: 0, y: 0, z: 0, heading: 0 })
    const map = new AmapDroneMap({ container: document.createElement('div'), sim, origin: ORIGIN, amap, autoTick: false })
    await map.open()
    const drone = calls.markers[0]!
    const cone = calls.polygons[0]!
    const altMarker = calls.markers.find((marker) => marker.options.zIndex === 130)!

    // 起飞:三个覆盖物都在画面上
    sim.position.y = 30
    sim.gimbalPitch = -45
    map.setFollow(true)
    map.sync(1_000)
    expect(drone.visible).toBe(true)
    expect(cone.visible).toBe(true)
    expect(altMarker.visible).toBe(true)

    // 进机载:指示标全隐(它们都会挡在画面正中)
    map.setFpvFrame(true)
    expect(drone.visible).toBe(false)
    map.sync(1_100)
    expect(cone.visible).toBe(false)
    expect(altMarker.visible).toBe(false)

    // 相机摆位:屏幕中心 = 云台落点(30m 高、-45° → 正北 30m),倾角镜像 = 45°
    calls.centers.length = 0
    map.sync(10_000)
    const aim = localToLonLat(ORIGIN, 0, 0, -30, 'gcj')
    const last = calls.centers.at(-1)!
    expect(last[0]).toBeCloseTo(aim.lon, 8)
    expect(last[1]).toBeCloseTo(aim.lat, 8)
    expect(map.getView().pitch).toBe(45)

    // 缩放随高度:12m 基准 19 档,高度翻倍 −1 档(这是"按 W 爬升"唯一的视觉反馈)
    // 30m → 19 − log2(2.5) ≈ 17.7 → 量化成 17.5;60m ≈ 16.7 → 16.5;120m 触底 16
    sim.position.y = 30
    map.sync(10_150)
    expect(calls.zooms.at(-1)).toBeCloseTo(17.5, 5)
    sim.position.y = 60
    map.sync(10_300)
    expect(calls.zooms.at(-1)).toBeCloseTo(16.5, 5)
    sim.position.y = 120
    map.sync(10_450)
    expect(calls.zooms.at(-1)).toBeCloseTo(16, 5)
    sim.position.y = 30

    // 云台压到 -80°:倾角镜像跟到 10°(相机更俯视),落点缩短到脚下
    sim.gimbalPitch = -80
    map.sync(10_600)
    expect(map.getView().pitch).toBe(10)
    const aimSteep = localToLonLat(ORIGIN, 0, 0, -30 / Math.tan((80 * Math.PI) / 180), 'gcj')
    const lastSteep = calls.centers.at(-1)!
    expect(lastSteep[1]).toBeCloseTo(aimSteep.lat, 6)

    // 退出机载:指示标恢复,倾角记账清零
    map.setFpvFrame(false)
    expect(drone.visible).toBe(true)
    map.sync(11_000)
    expect(cone.visible).toBe(true)
    expect(altMarker.visible).toBe(true)
    map.destroy()
  })
})
