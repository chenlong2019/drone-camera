import {
  CaptureService,
  CesiumDroneAdapter,
  DRONE_MODELS,
  DroneCapturePanel,
  DroneControlPanel,
  FlightSourceManager,
  MissionPanel,
  loadCesiumScript,
} from '@/lib'
import type { DroneModelSpec, FlightSourceKind, FlightSourceState } from '@/lib'
import { assetUrl, ensureStylesheet } from '@/utils/asset-url'

/** Optional Cesium ion token supplied at build time through VITE_CESIUM_ION_TOKEN. */
const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN?.trim() ?? ''
const HAS_ION_TOKEN = Boolean(ION_TOKEN && ION_TOKEN !== '******')

declare global {
  interface Window {
    Cesium?: Record<string, any>
    CESIUM_BASE_URL?: string
  }
}

const CESIUM_DIR = assetUrl('Cesium')

const ORIGIN = { lon: 116.391, lat: 39.906 }

export interface CesiumDemoApi {
  init(): Promise<void>
  destroy(): void
  getStats(): Record<string, unknown>
  cycleModel(): DroneModelSpec | null
  /** 飞控源热切换(内置模型 ⇄ PX4 / SITL);失败会自动回退内置并抛错 */
  setFlightSource(kind: FlightSourceKind, url?: string): Promise<FlightSourceState>
  /** 当前飞控源状态快照 */
  getFlightSource(): FlightSourceState
}

export function useCesiumDemo(container: HTMLElement): CesiumDemoApi {
  let viewer: Record<string, any> | null = null
  let adapter: CesiumDroneAdapter | null = null
  let panel: DroneControlPanel | null = null
  let missionPanel: MissionPanel | null = null
  let capturePanel: DroneCapturePanel | null = null
  let captureService: CaptureService | null = null
  /**
   * 飞控源切换器:内置模型 ⇄ 外部 MAVLink。
   *
   * 和 three 页共用同一个实现(库里的 `FlightSourceManager`),差别只在 Cesium 是真实地理坐标,
   * 所以这里显式把飞控的 home 锚点钉在场景原点 —— 否则 PX4 报的 HOME_POSITION 与 Cesium
   * 的 ENU 原点差几百公里,机体会被画到地球另一边。
   */
  let sources: FlightSourceManager | null = null
  let flightSource: FlightSourceState = { kind: 'internal', url: null, status: null, error: null }

  async function init(): Promise<void> {
    // Cesium 内部按 CESIUM_BASE_URL 拼 Workers / Assets 路径，必须显式给，否则子路径部署下全是 404
    window.CESIUM_BASE_URL = `${CESIUM_DIR}/`
    ensureStylesheet(`${CESIUM_DIR}/Widgets/widgets.css`)
    await loadCesiumScript(`${CESIUM_DIR}/Cesium.js`)
    const Cesium = window.Cesium!
    if (HAS_ION_TOKEN) {
      Cesium.Ion.defaultAccessToken = ION_TOKEN
    }

    const fallbackImagery = new Cesium.OpenStreetMapImageryProvider({
      url: 'https://a.tile.openstreetmap.org/',
    })
    let imageryProvider = fallbackImagery
    let hasIonImagery = false
    if (HAS_ION_TOKEN && typeof Cesium.createWorldImageryAsync === 'function') {
      try {
        imageryProvider = await Cesium.createWorldImageryAsync({
          style: Cesium.IonWorldImageryStyle?.AERIAL_WITH_LABELS,
        })
        hasIonImagery = true
      } catch (error) {
        console.warn('[drone-camera] Cesium World Imagery unavailable; using OpenStreetMap.', error)
      }
    }
    let terrainProvider = new Cesium.EllipsoidTerrainProvider()
    let hasIonTerrain = false
    if (HAS_ION_TOKEN && typeof Cesium.createWorldTerrainAsync === 'function') {
      try {
        terrainProvider = await Cesium.createWorldTerrainAsync()
        hasIonTerrain = true
      } catch (error) {
        console.warn('[drone-camera] Cesium World Terrain unavailable; using ellipsoid terrain.', error)
      }
    }
    const v = new Cesium.Viewer(container, {
      animation: false,
      timeline: false,
      // Ion terrain/imagery entries are only exposed when a token is configured.
      baseLayerPicker: hasIonTerrain || hasIonImagery,
      geocoder: false,
      homeButton: true,
      navigationHelpButton: false,
      sceneModePicker: true,
      fullscreenButton: true,
      infoBox: false,
      selectionIndicator: false,
      imageryProvider,
      terrainProvider,
      contextOptions: { webgl: { preserveDrawingBuffer: true } },
    })
    v.scene.globe.show = true
    v.scene.globe.depthTestAgainstTerrain = false
    v.scene.background = new Cesium.Color(0.02, 0.05, 0.08, 1.0)
    viewer = v

    v.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(ORIGIN.lon - 0.0016, ORIGIN.lat - 0.0016, 200),
      orientation: {
        heading: Cesium.Math.toRadians(20),
        pitch: Cesium.Math.toRadians(-28),
        roll: 0,
      },
      duration: 0,
    })

    adapter = new CesiumDroneAdapter({
      viewer: v,
      lon: ORIGIN.lon,
      lat: ORIGIN.lat,
      // 子路径部署(GitHub Pages 的 /drone-camera/)时,DRONE_MODELS 里的站内绝对路径要加前缀
      assetBase: import.meta.env.BASE_URL.replace(/\/$/, ''),
    })
    // 与 three 页同款演示开关:`?unlimited=1` 取消限高 / 限距
    if (new URLSearchParams(window.location.search).get('unlimited') === '1') {
      adapter.sim.setConfig({ unlimitedFlight: true })
    }
    void adapter.start()
    adapter.powerOn()
    adapter.setArmsFolded(false)

    // 飞控源:`?mavlink=ws://…` 时启动即接外部飞控;接管点是 adapter.sim,
    // 所以两个面板、采集服务、Cesium 相机跟随全部照旧工作
    const params = new URLSearchParams(window.location.search)
    const mavlinkUrl = params.get('mavlink')
    sources = new FlightSourceManager({
      sim: adapter.sim,
      mavlinkUrl: mavlinkUrl ?? undefined,
      mavlink: {
        // 场景原点作为 ENU 锚点:飞控的 local 坐标直接落在 Cesium 这片街区上
        home: { longitude: ORIGIN.lon, latitude: ORIGIN.lat, altitude: 0 },
      },
      onChange: (state) => {
        flightSource = state
      },
    })
    if (mavlinkUrl) {
      // 不 await:连不上要等 5 s,不该卡住 Cesium 首屏;失败会回退内置模型
      void sources.useMavlink(mavlinkUrl).catch((error: unknown) => {
        console.warn('[cesium-demo] MAVLink 接入失败,继续使用内置飞控:', error)
      })
    }

    captureService = new CaptureService({ provider: adapter })

    panel = new DroneControlPanel(adapter, {
      container,
      position: 'top-left',
      captureService,
    })

    missionPanel = new MissionPanel(adapter, {
      container,
      position: 'top-right',
      offset: { x: 340 },
    })

    capturePanel = new DroneCapturePanel(adapter, {
      container,
      position: 'bottom-right',
      offset: { y: 224 },
      service: captureService,
      sessionDefaults: {
        sceneId: 'cesium-demo',
        georeference: { longitude: ORIGIN.lon, latitude: ORIGIN.lat, altitude: 0 },
      },
    })

    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__cesiumDemo = {
        viewer: v,
        adapter,
        panel,
        missionPanel,
        capturePanel,
        captureService,
        api: { init, destroy, getStats, cycleModel, setFlightSource, getFlightSource },
      }
    }
  }

  function cycleModel(): DroneModelSpec | null {
    if (!adapter) return null
    return adapter.cycleModel()
  }

  function getStats(): Record<string, unknown> {
    if (!adapter || !viewer) return { ready: false }
    const sim = adapter.sim
    const geo = adapter.getGeo()
    return {
      ready: true,
      engine: adapter.engine,
      model: adapter.modelSpec.key,
      modelLabel: adapter.modelSpec.label,
      modelUrl: adapter.modelSpec.url,
      phase: sim.phase,
      airborne: sim.airborne,
      armed: !adapter.armsFolded,
      altitude: sim.position.y,
      local: { x: sim.position.x, y: sim.position.y, z: sim.position.z },
      heading: sim.heading,
      tiltPitch: sim.tiltPitch,
      tiltRoll: sim.tiltRoll,
      geo,
      cameraMode: adapter.cameraMode,
      photoCount: sim.photoCount,
      recording: sim.recording,
      modelLoaded: adapter.modelLoaded,
      models: DRONE_MODELS.map((m) => m.key),
      flightSource: flightSource.kind,
      mavlink: flightSource.status,
    }
  }

  async function setFlightSource(kind: FlightSourceKind, url?: string): Promise<FlightSourceState> {
    if (!sources) return flightSource
    if (kind === 'internal') await sources.useInternal()
    else await sources.useMavlink(url)
    return sources.state
  }

  function getFlightSource(): FlightSourceState {
    return flightSource
  }

  function destroy(): void {
    // 外部会话先于 adapter 销毁:它每帧往 sim 里写状态,并持有 WebSocket
    sources?.destroy()
    sources = null
    flightSource = { kind: 'internal', url: null, status: null, error: null }

    capturePanel?.destroy()
    capturePanel = null
    missionPanel?.destroy()
    missionPanel = null
    panel?.destroy()
    panel = null
    captureService = null
    adapter?.destroy()
    adapter = null
    viewer?.destroy()
    viewer = null
  }

  return { init, destroy, getStats, cycleModel, setFlightSource, getFlightSource }
}
