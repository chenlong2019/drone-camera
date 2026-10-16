import {
  CaptureService,
  CesiumDroneAdapter,
  DRONE_MODELS,
  DroneCapturePanel,
  DroneControlPanel,
  MissionPanel,
  loadCesiumScript,
} from '@/lib'
import type { DroneModelSpec } from '@/lib'

/** Optional Cesium ion token supplied at build time through VITE_CESIUM_ION_TOKEN. */
const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN?.trim() ?? ''
const HAS_ION_TOKEN = Boolean(ION_TOKEN && ION_TOKEN !== '******')

declare global {
  interface Window {
    Cesium?: Record<string, any>
  }
}

const ORIGIN = { lon: 116.391, lat: 39.906 }

export interface CesiumDemoApi {
  init(): Promise<void>
  destroy(): void
  getStats(): Record<string, unknown>
  cycleModel(): DroneModelSpec | null
}

export function useCesiumDemo(container: HTMLElement): CesiumDemoApi {
  let viewer: Record<string, any> | null = null
  let adapter: CesiumDroneAdapter | null = null
  let panel: DroneControlPanel | null = null
  let missionPanel: MissionPanel | null = null
  let capturePanel: DroneCapturePanel | null = null
  let captureService: CaptureService | null = null

  async function init(): Promise<void> {
    await loadCesiumScript('/Cesium/Cesium.js')
    const Cesium = window.Cesium!
    if (HAS_ION_TOKEN) {
      Cesium.Ion.defaultAccessToken = ION_TOKEN
    }

    const fallbackImagery = new Cesium.OpenStreetMapImageryProvider({
      url: 'https://a.tile.openstreetmap.org/',
    })
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
      baseLayerPicker: hasIonTerrain,
      geocoder: false,
      homeButton: true,
      navigationHelpButton: false,
      sceneModePicker: true,
      fullscreenButton: true,
      infoBox: false,
      selectionIndicator: false,
      imageryProvider: fallbackImagery,
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
    })
    void adapter.start()
    adapter.powerOn()
    adapter.setArmsFolded(false)

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
        api: { init, destroy, getStats, cycleModel },
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
    }
  }

  function destroy(): void {
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

  return { init, destroy, getStats, cycleModel }
}
