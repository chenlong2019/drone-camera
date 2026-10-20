/* eslint-disable @typescript-eslint/no-explicit-any -- Cesium is supplied by the local global script. */
import { CesiumDroneAdapter, loadCesiumScript } from '@/lib/drone-camera/drone-cesium'
import {
  CaptureService,
  type CaptureCameraState,
  type CapturedImage,
} from '@/lib/drone-camera/drone-capture'
import { ReconstructionPreview } from '@/lib/drone-camera/drone-reconstruction-preview'
import {
  cameraPoseToColmap,
  createEcefEnuFrame,
  ecefToEnu,
  enuToEcef,
  validateTileset,
  type TilesetValidationResult,
} from '@/lib/drone-camera/drone-photogrammetry'
import { assetUrl, ensureStylesheet } from '@/utils/asset-url'

const CESIUM_DIR = assetUrl('Cesium')

export const VALIDATION_ORIGIN = { longitude: 116.391, latitude: 39.906, altitude: 0 }
export const CAPTURE_WIDTH = 960
export const CAPTURE_HEIGHT = 540
export interface FrameAudit {
  imageId: string
  pixelsMatch: boolean
  positionErrorMeters: number | null
  rotationErrorDegrees: number | null
  intrinsicsErrorPixels: number | null
  observerRestored: boolean
  enuRoundTripErrorMeters: number | null
  targetPixel: [number, number] | null
  targetProjectionErrorPixels: number | null
  passed: boolean
}

type CesiumObject = Record<string, any>
type RenderedFrame = {
  png: string
  camera: CaptureCameraState
  targetPixel: [number, number] | null
}

/** Fixed-position integration harness: real adapter capture without a flight mission. */
export async function createValidationScene(container: HTMLElement, signal: AbortSignal) {
  ;(window as unknown as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = `${CESIUM_DIR}/`
  ensureStylesheet(`${CESIUM_DIR}/Widgets/widgets.css`)
  await loadCesiumScript(`${CESIUM_DIR}/Cesium.js`)
  signal.throwIfAborted()
  const C = window.Cesium!
  const viewer = new C.Viewer(container, {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    baseLayer: false,
    geocoder: false,
    homeButton: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    terrainProvider: new C.EllipsoidTerrainProvider(),
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
  })
  viewer.resolutionScale = 1
  viewer.scene.globe.baseColor = C.Color.fromCssColorString('#64786b')
  viewer.scene.globe.enableLighting = false
  viewer.scene.skyAtmosphere.show = false
  viewer.scene.fog.enabled = false
  viewer.scene.postProcessStages.fxaa.enabled = false
  viewer.clock.currentTime = C.JulianDate.fromIso8601('2026-06-01T04:00:00Z')
  viewer.clock.shouldAnimate = false
  const origin = C.Cartesian3.fromDegrees(
    VALIDATION_ORIGIN.longitude,
    VALIDATION_ORIGIN.latitude,
    0,
  )
  const transform = C.Transforms.eastNorthUpToFixedFrame(origin)
  const frame = createEcefEnuFrame(VALIDATION_ORIGIN)
  const original = new C.CustomDataSource('本地验证建筑')
  void viewer.dataSources.add(original)
  function box(
    x: number,
    y: number,
    z: number,
    width: number,
    depth: number,
    height: number,
    color: string,
  ) {
    const position = C.Matrix4.multiplyByPoint(
      transform,
      new C.Cartesian3(x, y, z),
      new C.Cartesian3(),
    )
    original.entities.add({
      position,
      orientation: C.Transforms.headingPitchRollQuaternion(position, new C.HeadingPitchRoll()),
      box: {
        dimensions: new C.Cartesian3(width, depth, height),
        material: C.Color.fromCssColorString(color),
      },
    })
  }
  box(0, 0, 8, 18, 12, 16, '#dbbc90')
  box(0, 0, 16.3, 19, 13, 0.6, '#355971')
  box(-4, 1, 18, 4, 4, 3, '#b65741')
  // Distinct window patterns make blank frames and viewpoint changes visible.
  for (let floor = 0; floor < 4; floor++) {
    for (let column = 0; column < 5; column++) {
      for (const side of [-1, 1]) {
        box(
          -7 + column * 3.5,
          side * 6.04,
          2 + floor * 3.5,
          1.8,
          0.12,
          2,
          (column + floor + side) % 3 === 0 ? '#e8d678' : '#264a61',
        )
      }
    }
    for (let column = 0; column < 3; column++) {
      for (const side of [-1, 1])
        box(side * 9.04, -4 + column * 4, 2 + floor * 3.5, 0.12, 2, 2, '#365b74')
    }
  }
  const adapter = new CesiumDroneAdapter({
    viewer,
    lon: VALIDATION_ORIGIN.longitude,
    lat: VALIDATION_ORIGIN.latitude,
    height: 0,
    // 子路径部署时,DRONE_MODELS 里的站内绝对路径要加前缀
    assetBase: import.meta.env.BASE_URL.replace(/\/$/, ''),
  })
  adapter.setMissionEditEnabled(false)
  const preview = new ReconstructionPreview<CesiumObject, CesiumObject>({
    viewer,
    loader: (url) => C.Cesium3DTileset.fromUrl(url),
    original,
    compareMode: 'both',
  })
  let destroyed = false
  const audits: FrameAudit[] = []
  let latestAudit: Omit<FrameAudit, 'imageId'> | null = null
  const tileErrors: string[] = []
  let removeTileListener: (() => void) | undefined
  let removeTileVisibleListener: (() => void) | undefined
  let visibleTiles = 0
  const removeBeforeUpdate = viewer.scene.preUpdate.addEventListener(() => {
    visibleTiles = 0
  })
  let removeRenderError: (() => void) | undefined
  let renderFailure: string | null = null
  const service = new CaptureService({
    provider: {
      engine: 'cesium',
      getCaptureCamera: () => adapter.getCaptureCamera(),
      requestPhoto: auditedPhoto,
    },
  })
  const session = service.createSession({
    source: 'virtual-camera',
    name: '本地建筑验证',
    sceneId: 'validation-building-v1',
    georeference: VALIDATION_ORIGIN,
  })

  function readRenderedCamera(): CaptureCameraState {
    const camera = viewer.camera
    // Cesium's inverse view matrix is independent of the lib basis helper.
    const matrix = C.Matrix4.getMatrix3(camera.inverseViewMatrix, new C.Matrix3())
    const q = C.Quaternion.fromRotationMatrix(matrix)
    const p = camera.positionWC
    const width = viewer.canvas.width
    const height = viewer.canvas.height
    const projection = camera.frustum.projectionMatrix
    return {
      pose: { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w], coordinateFrame: 'ecef' },
      intrinsics: {
        width,
        height,
        fx: (projection[0] * width) / 2,
        fy: (projection[5] * height) / 2,
        cx: (width * (1 - projection[8])) / 2,
        cy: (height * (1 + projection[9])) / 2,
        calibrationSource: 'known',
      },
      frame: { width, height },
    }
  }

  function observe(): void {
    adapter.setCameraMode('orbit')
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
    viewer.camera.lookAt(
      C.Matrix4.multiplyByPoint(transform, new C.Cartesian3(0, 0, 8), new C.Cartesian3()),
      new C.HeadingPitchRange(C.Math.toRadians(25), C.Math.toRadians(-30), 90),
    )
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY)
  }

  async function auditedPhoto() {
    const before = readRenderedCamera()
    const frames: RenderedFrame[] = []
    const canvas = document.createElement('canvas')
    canvas.width = viewer.canvas.width
    canvas.height = viewer.canvas.height
    const context = canvas.getContext('2d')!
    const remove = viewer.scene.postRender.addEventListener(() => {
      context.drawImage(viewer.canvas, 0, 0)
      // Independently project the known ECEF target through Cesium's matrices.
      const world = C.Matrix4.multiplyByPoint(
        transform,
        new C.Cartesian3(0, 0, 8),
        new C.Cartesian3(),
      )
      const view = C.Matrix4.multiplyByVector(
        viewer.camera.viewMatrix,
        new C.Cartesian4(world.x, world.y, world.z, 1),
        new C.Cartesian4(),
      )
      const clip = C.Matrix4.multiplyByVector(
        viewer.camera.frustum.projectionMatrix,
        view,
        new C.Cartesian4(),
      )
      frames.push({
        png: canvas.toDataURL('image/png'),
        camera: readRenderedCamera(),
        targetPixel:
          clip.w > 0
            ? [
                ((1 + clip.x / clip.w) * canvas.width) / 2,
                ((1 - clip.y / clip.w) * canvas.height) / 2,
              ]
            : null,
      })
      if (frames.length > 6) frames.shift()
    })
    try {
      const shot = await adapter.requestPhoto()
      signal.throwIfAborted()
      if (!shot) throw new Error('未取得截图，请确认模型已加载。')
      const matched = frames.find((item) => item.png === shot.dataUrl)
      const captured = shot.camera
      const positionError =
        captured && matched ? distance(captured.pose.position, matched.camera.pose.position) : null
      const rotationError =
        captured && matched
          ? rotationDifference(captured.pose.rotation, matched.camera.pose.rotation)
          : null
      const intrinsicsError =
        captured && matched
          ? Math.max(
              ...(['fx', 'fy', 'cx', 'cy', 'width', 'height'] as const).map((key) =>
                Math.abs(
                  (captured.intrinsics[key] ?? NaN) - (matched.camera.intrinsics[key] ?? NaN),
                ),
              ),
            )
          : null
      const after = readRenderedCamera()
      const observerRestored =
        distance(before.pose.position, after.pose.position) < 1e-6 &&
        rotationDifference(before.pose.rotation, after.pose.rotation) < 1e-4
      let roundTrip: number | null = null
      let targetPixel: [number, number] | null = null
      if (captured && captured.pose.rotation.every(Number.isFinite)) {
        const local = ecefToEnu(captured.pose.position, frame)
        roundTrip = distance(enuToEcef(local, frame), captured.pose.position)
        const colmap = cameraPoseToColmap(captured.pose, { enuFrame: frame })
        const q = colmap.qvec
        const rotation = C.Matrix3.fromQuaternion(new C.Quaternion(q[1], q[2], q[3], q[0]))
        const target = C.Matrix3.multiplyByVector(
          rotation,
          new C.Cartesian3(0, 0, 8),
          new C.Cartesian3(),
        )
        target.x += colmap.tvec[0]
        target.y += colmap.tvec[1]
        target.z += colmap.tvec[2]
        const k = captured.intrinsics
        if (target.z > 0)
          targetPixel = [
            (k.fx! * target.x) / target.z + k.cx!,
            (k.fy! * target.y) / target.z + k.cy!,
          ]
      }
      const projectionError =
        matched?.targetPixel && targetPixel ? distance(matched.targetPixel, targetPixel) : null
      latestAudit = {
        pixelsMatch: Boolean(matched),
        positionErrorMeters: finiteOrNull(positionError),
        rotationErrorDegrees: finiteOrNull(rotationError),
        intrinsicsErrorPixels: finiteOrNull(intrinsicsError),
        observerRestored,
        enuRoundTripErrorMeters: finiteOrNull(roundTrip),
        targetPixel,
        targetProjectionErrorPixels: finiteOrNull(projectionError),
        passed: Boolean(
          matched &&
          positionError !== null &&
          positionError < 1e-6 &&
          rotationError !== null &&
          rotationError < 1e-4 &&
          intrinsicsError !== null &&
          intrinsicsError < 1e-6 &&
          observerRestored &&
          roundTrip !== null &&
          roundTrip < 1e-6 &&
          projectionError !== null &&
          projectionError < 1e-4 &&
          targetPixel &&
          targetPixel[0] >= 0 &&
          targetPixel[0] <= shot.width &&
          targetPixel[1] >= 0 &&
          targetPixel[1] <= shot.height,
        ),
      }
      return shot
    } finally {
      remove()
    }
  }

  async function capture(index: number): Promise<CapturedImage> {
    signal.throwIfAborted()
    if (renderFailure) throw new Error(renderFailure)
    // These public simulation values are deliberately held with power off:
    // this harness exercises capture at known poses, not the flight state machine.
    const angle = (index * Math.PI) / 4
    const height = index % 2 ? 34 : 24
    adapter.sim.position = { x: 40 * Math.sin(angle), y: height, z: -40 * Math.cos(angle) }
    adapter.sim.heading = (index * 45 + 180) % 360
    adapter.sim.gimbalPitch =
      (Math.atan2(8 - height - adapter.modelSpec.lift - 0.05 - adapter.modelSpec.gimbalLiftM, 40) *
        180) /
      Math.PI
    adapter.sim.gimbalYaw = 0
    preview.setCompareMode('original')
    observe()
    viewer.scene.screenSpaceCameraController.enableInputs = false
    try {
      const image = await service.captureVirtualImage(session.id)
      signal.throwIfAborted()
      if (!image || !latestAudit) throw new Error('采集未完成。')
      audits.push({ ...latestAudit, imageId: image.id })
      return image
    } finally {
      if (!destroyed) viewer.scene.screenSpaceCameraController.enableInputs = true
    }
  }

  async function loadTiles(url: string): Promise<TilesetValidationResult> {
    const resolved = new URL(url, window.location.href)
    if (!['http:', 'https:'].includes(resolved.protocol))
      throw new Error('请输入 HTTP(S) 或同站点 Tiles 地址。')
    const response = await fetch(resolved, { signal })
    if (!response.ok) throw new Error(`读取 tileset.json 失败：HTTP ${response.status}`)
    const validation = validateTileset(await response.json())
    if (!validation.valid) throw new Error(validation.errors.join('；'))
    const tileset = await preview.load(resolved.href)
    signal.throwIfAborted()
    removeTileListener?.()
    removeTileVisibleListener?.()
    tileErrors.splice(0)
    visibleTiles = 0
    removeTileListener = tileset.tileFailed.addEventListener((error: { message: string }) =>
      tileErrors.push(error.message),
    )
    removeTileVisibleListener = tileset.tileVisible.addEventListener(() => {
      visibleTiles += 1
    })
    preview.setCompareMode('both')
    observe()
    return validation
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    removeTileListener?.()
    removeTileVisibleListener?.()
    removeBeforeUpdate()
    removeRenderError?.()
    preview.destroy()
    service.clearImages(session.id)
    service.removeSession(session.id)
    adapter.destroy()
    viewer.destroy()
  }
  signal.addEventListener('abort', destroy, { once: true })
  try {
    removeRenderError = viewer.scene.renderError.addEventListener(
      (_scene: unknown, error: Error) => {
        renderFailure = error.message
      },
    )
    await adapter.start()
    adapter.setMissionVisible(false)
    adapter.setMissionWaypointsVisible(false)
    adapter.setMissionPathVisible(false)
    observe()
    viewer.resize()
    const start = performance.now()
    while (!adapter.modelLoaded) {
      signal.throwIfAborted()
      if (renderFailure) throw new Error(renderFailure)
      if (performance.now() - start > 60000)
        throw new Error('机体模型加载超时，请检查本地 /models 资源。')
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100))
    }
    signal.throwIfAborted()
  } catch (error) {
    destroy()
    throw error
  }
  return {
    service,
    session,
    audits,
    capture,
    loadTiles,
    preview,
    observe,
    destroy,
    tileState: () => ({
      // tilesLoaded is also true when no tile intersects the current view.
      // Require Cesium to select content for rendering before declaring readiness.
      ready: Boolean(preview.tileset?.tilesLoaded && visibleTiles > 0),
      visible: Boolean(preview.tileset?.show),
      visibleTiles,
      errors: [...tileErrors],
      renderFailure,
    }),
    clear: () => {
      service.clearImages(session.id)
      audits.splice(0)
    },
  }
}

function distance(a: readonly number[], b: readonly number[]) {
  return Math.hypot(...a.map((n, i) => n - b[i]!))
}
function finiteOrNull(value: number | null) {
  return value !== null && Number.isFinite(value) ? value : null
}
function rotationDifference(a: readonly number[], b: readonly number[]) {
  const dot =
    a.reduce((sum, n, index) => sum + n * b[index]!, 0) / (Math.hypot(...a) * Math.hypot(...b))
  return (2 * Math.acos(Math.min(1, Math.abs(dot))) * 180) / Math.PI
}

export type ValidationScene = Awaited<ReturnType<typeof createValidationScene>>
