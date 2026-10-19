<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import { createOriginalImagesZip, triggerDownload } from '@/lib/drone-camera/drone-image-utils'
import {
  validateCaptureManifest,
  type CaptureValidationReport,
} from '@/lib/drone-camera/drone-capture-manifest'
import {
  cameraPoseToColmap,
  createEcefEnuFrame,
  createReconstructionTask,
  type TilesetValidationResult,
} from '@/lib/drone-camera/drone-photogrammetry'
import type { CapturedImage } from '@/lib/drone-camera/drone-capture'
import type { ReconstructionPreviewCompareMode } from '@/lib/drone-camera/drone-reconstruction-preview'
import { inspectCaptureImages, type InspectedImageQuality } from './image-validation'
import {
  createValidationScene,
  VALIDATION_ORIGIN,
  type ValidationScene,
  type FrameAudit,
} from './validation-scene'

const container = ref<HTMLElement>()
const viewport = ref<HTMLElement>()
const scene = shallowRef<ValidationScene>()
const busy = ref('')
const error = ref('')
const ready = ref(false)
const images = shallowRef<CapturedImage[]>([])
const audits = shallowRef<FrameAudit[]>([])
const selectedId = ref('')
const quality = shallowRef<Record<string, InspectedImageQuality>>({})
const validation = shallowRef<CaptureValidationReport>()
const tilesValidation = shallowRef<TilesetValidationResult>()
const tilesUrl = ref('')
const loadedTilesUrl = ref('')
const tilesAreSample = ref(false)
const tilesStatus = ref('尚未加载')
const tilesErrors = ref<string[]>([])
const lastTilesAttempt = ref<{
  url: string
  status: 'loading' | 'loaded' | 'failed'
  error: string | null
} | null>(null)
const compareMode = ref<ReconstructionPreviewCompareMode>('original')
const scale = ref(1)
const stopRequested = ref(false)
const controller = new AbortController()
let resizeObserver: ResizeObserver | undefined
let tileTimer: ReturnType<typeof setInterval> | undefined
const selected = computed(
  () => images.value.find((image) => image.id === selectedId.value) ?? images.value[0],
)
const selectedAudit = computed(() =>
  audits.value.find((audit) => audit.imageId === selected.value?.id),
)
const passedFrames = computed(() => audits.value.filter((audit) => audit.passed).length)
const capturePassed = computed(() =>
  Boolean(
    validation.value?.valid &&
    images.value.length &&
    audits.value.length === images.value.length &&
    passedFrames.value === images.value.length &&
    images.value.every((image) => quality.value[image.id]?.decodable === true),
  ),
)
const resultText = computed(() =>
  !validation.value ? '尚未校验' : capturePassed.value ? '采集检查通过' : '采集检查未通过',
)
const colmapPose = computed(() => {
  if (!selected.value?.cameraPose) return null
  try {
    return cameraPoseToColmap(selected.value.cameraPose, {
      enuFrame: createEcefEnuFrame(VALIDATION_ORIGIN),
    })
  } catch {
    return null
  }
})

async function run(label: string, action: () => Promise<void>) {
  if (busy.value) return
  busy.value = label
  error.value = ''
  try {
    await action()
  } catch (cause) {
    if (!controller.signal.aborted)
      error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (!controller.signal.aborted) busy.value = ''
  }
}

function initialize() {
  void run('初始化场景…', async () => {
    if (!container.value) return
    scene.value = await createValidationScene(container.value, controller.signal)
    controller.signal.throwIfAborted()
    ready.value = true
    tileTimer = setInterval(() => {
      if (!scene.value) return
      const state = scene.value.tileState()
      if (state.renderFailure) error.value = `场景渲染失败：${state.renderFailure}`
      if (!loadedTilesUrl.value) return
      tilesErrors.value = state.errors
      tilesStatus.value = state.errors.length
        ? '瓦片加载失败'
        : !state.visible
          ? 'Tiles 图层已隐藏'
          : state.ready
            ? '可见瓦片就绪'
            : '根节点已加载，等待当前视角内的瓦片'
    }, 300)
  })
}

function syncImages() {
  if (!scene.value) return
  images.value = [...scene.value.session.images]
  audits.value = [...scene.value.audits]
  selectedId.value = images.value.at(-1)?.id ?? ''
  validation.value = undefined
  quality.value = {}
}

function capture(batch: boolean) {
  void run('采集中…', async () => {
    const current = scene.value!
    if (batch) current.clear()
    syncImages()
    stopRequested.value = false
    compareMode.value = 'original'
    const count = batch ? 8 : 1
    const firstIndex = current.session.images.length % 8
    for (let index = 0; index < count && !stopRequested.value; index++) {
      busy.value = `采集 ${index + 1} / ${count}`
      await current.capture((firstIndex + index) % 8)
      controller.signal.throwIfAborted()
      syncImages()
    }
  })
}

function manifestWithQuality() {
  const manifest = scene.value!.service.buildManifest(scene.value!.session.id)!
  for (const image of manifest.images)
    if (quality.value[image.id]) image.quality = quality.value[image.id]
  return manifest
}

function validate() {
  void run('解码影像并校验…', async () => {
    quality.value = await inspectCaptureImages(images.value, controller.signal)
    controller.signal.throwIfAborted()
    const report = validateCaptureManifest(manifestWithQuality(), { imageQuality: quality.value })
    for (const image of images.value) {
      const inspection = quality.value[image.id]
      const intrinsics = image.cameraIntrinsics
      if (
        !inspection ||
        (inspection.decodable &&
          (inspection.width !== intrinsics?.width ||
            inspection.height !== intrinsics?.height ||
            (inspection.validPixelRatio ?? 0) < 0.95))
      ) {
        report.errors.push({
          severity: 'error',
          code: 'decoded-image',
          imageId: image.id,
          message: '解码尺寸与内参不一致，或有效像素不足 95%。',
        })
      }
    }
    report.issues = [...report.errors, ...report.warnings]
    report.valid = report.passed = report.errors.length === 0
    report.status = report.errors.length ? 'invalid' : report.warnings.length ? 'warning' : 'valid'
    validation.value = report
  })
}

function loadTiles(sample = false) {
  void run('加载 Tiles…', async () => {
    const url = sample ? '/validation/tileset.json' : tilesUrl.value.trim()
    if (!url) throw new Error('请输入 tileset.json 地址。')
    lastTilesAttempt.value = { url, status: 'loading', error: null }
    try {
      const result = await scene.value!.loadTiles(url)
      controller.signal.throwIfAborted()
      tilesValidation.value = result
      loadedTilesUrl.value = url
      tilesAreSample.value = sample
      compareMode.value = 'both'
      tilesStatus.value = '根节点已加载，等待当前视角内的瓦片'
      lastTilesAttempt.value = { url, status: 'loaded', error: null }
    } catch (cause) {
      lastTilesAttempt.value = {
        url,
        status: 'failed',
        error: cause instanceof Error ? cause.message : String(cause),
      }
      throw cause
    }
  })
}

function changeCompare() {
  scene.value?.preview.setCompareMode(compareMode.value)
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  triggerDownload(url, name)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function jsonDownload(value: unknown, name: string) {
  download(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), name)
}
function exportImages() {
  void run('打包原图…', async () => {
    const zip = await createOriginalImagesZip(images.value)
    controller.signal.throwIfAborted()
    download(zip, 'images.zip')
  })
}
function exportReport() {
  jsonDownload(
    {
      captureId: scene.value!.session.id,
      generatedAt: new Date().toISOString(),
      captureStatus: !validation.value ? 'not-run' : capturePassed.value ? 'passed' : 'failed',
      reconstructionStatus: 'not-run',
      note: '本页验证采集与回载。SfM、网格、纹理和地理配准须使用真实重建成果单独验收。',
      captureValidation: validation.value ?? null,
      imageQuality: quality.value,
      frameAudits: audits.value,
      task: createReconstructionTask('data', scene.value!.session.id),
      tiles: {
        url: loadedTilesUrl.value || null,
        sample: tilesAreSample.value,
        status: tilesStatus.value,
        validation: tilesValidation.value ?? null,
        errors: tilesErrors.value,
        lastLoadAttempt: lastTilesAttempt.value,
        visibleTiles: scene.value!.tileState().visibleTiles,
        visualAcceptance: 'not-reviewed',
      },
    },
    'validation-report.json',
  )
}
function fmt(value: number | null | undefined, digits = 3) {
  return value != null && Number.isFinite(value) ? value.toFixed(digits) : '—'
}
function tuple(values: readonly number[] | undefined) {
  return values?.map((v) => fmt(v, 4)).join(', ') ?? '—'
}

onMounted(() => {
  if (!viewport.value) return
  resizeObserver = new ResizeObserver(([entry]) => {
    if (entry) scale.value = entry.contentRect.width / 960
  })
  resizeObserver.observe(viewport.value)
})
onBeforeUnmount(() => {
  controller.abort()
  scene.value?.destroy()
  resizeObserver?.disconnect()
  if (tileTimer) clearInterval(tileTimer)
})
</script>

<template>
  <main class="pv-page">
    <header class="pv-header">
      <div>
        <p class="pv-eyebrow">DRONE CAMERA / VALIDATION</p>
        <h1>摄影测量验证</h1>
        <p>检查真实截图、相机参数与坐标转换，再回载 Tiles 对照原场景。</p>
      </div>
      <nav aria-label="页面导航">
        <RouterLink to="/cesium-demo">Cesium 沙盒</RouterLink
        ><RouterLink to="/docs">使用文档 ↗</RouterLink>
      </nav>
    </header>
    <div class="pv-summary">
      <div>
        <span>01 / 场景</span
        ><strong data-testid="scene-status">{{ ready ? '场景就绪' : '等待初始化' }}</strong>
      </div>
      <div>
        <span>02 / 采集影像</span
        ><strong
          ><b data-testid="image-count">{{ images.length }}</b> 张 <small>960 × 540</small></strong
        >
      </div>
      <div>
        <span>03 / 采集检查</span
        ><strong data-testid="capture-result" :class="{ good: capturePassed }">{{
          resultText
        }}</strong>
      </div>
      <div><span>04 / 离线重建</span><strong>尚未验证</strong></div>
    </div>
    <p v-if="error" class="pv-error" role="alert">{{ error }}</p>
    <p class="pv-live" role="status" aria-live="polite">
      {{ busy || '就绪。按左侧步骤操作，可下载检查结果。' }}
    </p>
    <div class="pv-layout">
      <aside class="pv-controls">
        <section>
          <h2><em>1</em>采集测试建筑</h2>
          <p>
            本地建筑与椭球地形，无需配置 Ion。固定 8 个机位、两档高度，调用 Cesium 适配器实际拍照。
          </p>
          <button
            data-testid="init-scene"
            class="primary"
            :disabled="ready || !!busy"
            @click="initialize"
          >
            {{ ready ? '场景已初始化' : '初始化验证场景' }}
          </button>
          <div class="button-row">
            <button :disabled="!ready || !!busy" @click="capture(false)">采集下一机位</button>
            <button data-testid="capture-batch" :disabled="!ready || !!busy" @click="capture(true)">
              采集 8 个机位
            </button>
          </div>
          <p class="hint">
            批量采集会替换当前会话的照片。固定机位用于采集验证，航线飞行请进入沙盒。
          </p>
          <button v-if="busy.startsWith('采集')" @click="stopRequested = true">
            完成当前帧后停止
          </button>
        </section>
        <section>
          <h2><em>2</em>校验与导出</h2>
          <p>
            解码原图，检查黑白帧、均匀图、重复内容、尺寸、内参和位姿。采集时独立记录渲染帧进行逐张核对。
          </p>
          <button
            data-testid="validate-capture"
            class="primary"
            :disabled="!images.length || !!busy"
            @click="validate"
          >
            校验采集
          </button>
          <div class="button-row">
            <button
              data-testid="download-manifest"
              :disabled="!images.length || !!busy"
              @click="jsonDownload(manifestWithQuality(), 'manifest.json')"
            >
              Manifest
            </button>
            <button :disabled="!images.length || !!busy" @click="exportImages">原图 ZIP</button>
          </div>
          <button data-testid="download-report" :disabled="!ready || !!busy" @click="exportReport">
            下载验证报告
          </button>
          <p class="hint">
            将 ZIP 解压到 images/，与 manifest.json 放在同一目录。报告保留失败项与未验证阶段。
          </p>
        </section>
        <section>
          <h2><em>3</em>回载与对比</h2>
          <label for="pv-tiles-url">tileset.json 地址</label>
          <input
            id="pv-tiles-url"
            v-model="tilesUrl"
            :disabled="!!busy"
            placeholder="/outputs/building/tileset.json"
          />
          <div class="button-row">
            <button :disabled="!ready || !!busy || !tilesUrl.trim()" @click="loadTiles(false)">
              加载成果
            </button>
            <button
              data-testid="load-sample-tiles"
              :disabled="!ready || !!busy"
              @click="loadTiles(true)"
            >
              加载回载样例
            </button>
          </div>
          <label for="pv-mode">显示图层</label>
          <select
            id="pv-mode"
            v-model="compareMode"
            data-testid="compare-mode"
            :disabled="!loadedTilesUrl || !!busy"
            @change="changeCompare"
          >
            <option value="original">原始建筑</option>
            <option value="reconstructed">Tiles 图层</option>
            <option value="both">两者叠加</option>
          </select>
          <p data-testid="tiles-status" class="pv-tile-status">{{ tilesStatus }}</p>
          <p v-if="tilesAreSample" class="hint">
            当前为合成回载样例，用于测试加载与坐标。它不是照片重建成果。
          </p>
          <ul v-if="tilesErrors.length" class="pv-issues">
            <li v-for="(issue, i) in tilesErrors" :key="i">{{ issue }}</li>
          </ul>
          <ul v-if="tilesValidation?.warnings.length" class="pv-issues">
            <li v-for="issue in tilesValidation.warnings" :key="issue">{{ issue }}</li>
          </ul>
        </section>
      </aside>
      <div class="pv-workspace">
        <section class="pv-scene-card">
          <div class="pv-section-bar">
            <h2>场景预览</h2>
            <span>北京 · ENU 原点 116.391°, 39.906°</span>
            <button :disabled="!ready || !!busy" @click="scene?.observe()">复位视角</button>
          </div>
          <div ref="viewport" class="pv-viewport">
            <div
              ref="container"
              class="pv-canvas"
              :style="{ transform: `scale(${scale})` }"
              aria-label="摄影测量验证 Cesium 场景"
            />
            <div v-if="!ready" class="pv-placeholder">
              <span>◇</span><strong>一个建筑，一组可核对的影像</strong>
              <p>初始化后显示本地测试场景</p>
            </div>
          </div>
        </section>
        <section class="pv-results">
          <div class="pv-section-bar">
            <h2>同帧与坐标检查</h2>
            <span data-testid="frame-audit-result">{{ passedFrames }} / {{ images.length }}</span>
          </div>
          <p>
            截图 PNG 与 postRender 独立拷屏匹配；核对位姿、内参、观察视角恢复、ECEF ↔ ENU
            往返及目标投影。
          </p>
          <p v-if="!audits.length" class="hint">
            采集后显示逐张结果。采集检查不代表 SfM、网格或纹理重建已通过。
          </p>
          <div v-else class="pv-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>影像</th>
                  <th>同帧图像</th>
                  <th>位置误差 / m</th>
                  <th>旋转误差 / °</th>
                  <th>视角恢复</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(audit, i) in audits" :key="audit.imageId">
                  <td>#{{ i + 1 }}</td>
                  <td>{{ audit.pixelsMatch ? '匹配' : '不匹配' }}</td>
                  <td>{{ fmt(audit.positionErrorMeters, 6) }}</td>
                  <td>{{ fmt(audit.rotationErrorDegrees, 6) }}</td>
                  <td>{{ audit.observerRestored ? '通过' : '失败' }}</td>
                  <td :class="audit.passed ? 'good' : 'bad'">
                    {{ audit.passed ? '通过' : '失败' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="validation" class="pv-validation">
            <strong>{{ resultText }}</strong>
            <p>
              {{ validation.errors.length }} 项元数据 / 图像错误 ·
              {{ validation.warnings.length }} 项提示
            </p>
            <ul v-if="validation.issues.length" class="pv-issues">
              <li v-for="(issue, i) in validation.issues" :key="i">
                {{ issue.imageId ? `${issue.imageId} · ` : '' }}{{ issue.message }}
              </li>
            </ul>
          </div>
        </section>
        <section class="pv-gallery">
          <div class="pv-section-bar">
            <h2>影像与相机参数</h2>
            <span>点击缩略图检查每张原图</span>
          </div>
          <p v-if="!images.length" class="hint">尚未采集影像。</p>
          <div class="pv-thumbnails">
            <button
              v-for="(image, i) in images"
              :key="image.id"
              :class="{ selected: selected?.id === image.id }"
              @click="selectedId = image.id"
            >
              <img :src="image.imageUrl" :alt="`机位 ${i + 1} 截图`" /><span>#{{ i + 1 }}</span>
            </button>
          </div>
          <div v-if="selected" class="pv-inspector">
            <img class="pv-photo" :src="selected.imageUrl" alt="选中的采集原图" />
            <dl>
              <dt>文件</dt>
              <dd>{{ selected.fileName }}</dd>
              <dt>拍摄时间</dt>
              <dd>{{ selected.capturedAt }}</dd>
              <dt>内参 fx / fy / cx / cy</dt>
              <dd>
                {{
                  tuple([
                    selected.cameraIntrinsics?.fx ?? NaN,
                    selected.cameraIntrinsics?.fy ?? NaN,
                    selected.cameraIntrinsics?.cx ?? NaN,
                    selected.cameraIntrinsics?.cy ?? NaN,
                  ])
                }}
              </dd>
              <dt>ECEF 位置 / m</dt>
              <dd>{{ tuple(selected.cameraPose?.position) }}</dd>
              <dt>相机 → 世界四元数 [x,y,z,w]</dt>
              <dd>{{ tuple(selected.cameraPose?.rotation) }}</dd>
              <dt>COLMAP qvec [w,x,y,z] / tvec</dt>
              <dd>{{ tuple(colmapPose?.qvec) }}<br />{{ tuple(colmapPose?.tvec) }}</dd>
              <dt>ENU 往返误差 / m</dt>
              <dd>{{ fmt(selectedAudit?.enuRoundTripErrorMeters, 9) }}</dd>
              <dt>目标中心投影 / px</dt>
              <dd>
                {{
                  selectedAudit?.targetPixel ? tuple(selectedAudit.targetPixel) : '未投影到相机前方'
                }}
              </dd>
              <dt>与 Cesium 独立投影误差 / px</dt>
              <dd>{{ fmt(selectedAudit?.targetProjectionErrorPixels, 9) }}</dd>
              <dt>亮度均值 / 方差（采样）</dt>
              <dd>
                {{ fmt(quality[selected.id]?.meanLuma) }} /
                {{ fmt(quality[selected.id]?.variance) }}
              </dd>
            </dl>
          </div>
        </section>
        <footer class="pv-note">
          <strong>完整 PoC 仍需离线验收</strong>
          <p>
            导出数据后运行 COLMAP / MVS，记录注册率、网格和纹理质量，再将真实 Tiles
            回载。位置、朝向、尺度和纹理需人工对照确认。
          </p>
        </footer>
      </div>
    </div>
  </main>
</template>

<style scoped>
.pv-page {
  min-height: 100%;
  box-sizing: border-box;
  padding: 28px 32px 48px;
  background: #edf2f5;
  color: #1c3445;
  font:
    14px/1.6 system-ui,
    sans-serif;
}
.pv-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
  margin-bottom: 24px;
}
.pv-eyebrow {
  color: #517781;
  font-size: 11px;
  letter-spacing: 2px;
  font-weight: 700;
  margin: 0;
}
h1 {
  font-size: 29px;
  margin: 3px 0;
  letter-spacing: -1px;
}
p {
  margin: 7px 0;
}
nav {
  display: flex;
  gap: 20px;
}
a {
  color: #146c73;
  text-decoration: none;
}
.pv-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border: 1px solid #d5e0e6;
  background: white;
  border-radius: 12px;
  margin-bottom: 12px;
}
.pv-summary > div {
  padding: 16px 22px;
  border-right: 1px solid #e0e8ec;
}
.pv-summary > div:last-child {
  border: 0;
}
.pv-summary span,
.pv-summary strong {
  display: block;
}
.pv-summary span {
  color: #617785;
  font-size: 12px;
}
.pv-summary strong {
  font-size: 18px;
  margin-top: 4px;
}
.pv-summary small {
  font-size: 11px;
  color: #687d89;
  font-weight: 400;
  margin-left: 10px;
}
.pv-live {
  color: #58717f;
  font-size: 12px;
  margin-bottom: 14px;
  min-height: 20px;
}
.pv-error {
  background: #fff0ed;
  color: #9a3329;
  padding: 12px 16px;
  border: 1px solid #ecc3bc;
  border-radius: 8px;
  overflow-wrap: anywhere;
}
.pv-layout {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 22px;
  align-items: start;
}
.pv-controls {
  border: 1px solid #d5e0e6;
  border-radius: 12px;
  background: white;
  overflow: hidden;
}
.pv-controls section {
  padding: 20px;
  border-bottom: 1px solid #e3eaed;
}
h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
h2 em {
  display: inline-grid;
  place-items: center;
  width: 23px;
  height: 23px;
  font-style: normal;
  font-size: 12px;
  color: #fff;
  background: #2a7379;
  border-radius: 6px;
  margin-right: 9px;
}
.pv-controls p {
  color: #607684;
  font-size: 12px;
  margin: 12px 0;
}
button,
input,
select {
  font: inherit;
  box-sizing: border-box;
  border: 1px solid #c7d6de;
  border-radius: 6px;
}
button {
  background: white;
  color: #244856;
  cursor: pointer;
  padding: 8px 10px;
}
button:hover:not(:disabled) {
  background: #e8f3f1;
  border-color: #4d9595;
}
button:disabled {
  cursor: default;
  opacity: 0.45;
}
button:focus-visible,
a:focus-visible {
  outline: 2px solid #208e95;
  outline-offset: 3px;
}
.pv-controls button {
  width: 100%;
  margin-bottom: 8px;
  font-size: 12px;
}
.pv-controls .primary {
  background: #1d7177;
  color: white;
  border-color: #1d7177;
}
.button-row {
  display: flex;
  gap: 8px;
}
.pv-controls .hint,
.hint {
  color: #81919b;
  font-size: 12px;
}
label {
  display: block;
  font-size: 12px;
  margin: 14px 0 6px;
}
input,
select {
  background: #f9fbfc;
  width: 100%;
  padding: 9px;
  color: #284853;
  font-size: 12px;
  margin-bottom: 9px;
}
.pv-tile-status {
  color: #21777e !important;
}
.pv-workspace {
  display: grid;
  gap: 18px;
  min-width: 0;
}
.pv-scene-card,
.pv-results,
.pv-gallery {
  border: 1px solid #d5e0e6;
  border-radius: 10px;
  overflow: hidden;
  background: white;
}
.pv-section-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  border-bottom: 1px solid #e1e9ed;
}
.pv-section-bar span {
  color: #748894;
  font-size: 11px;
  margin-left: auto;
}
.pv-section-bar button {
  padding: 4px 10px;
  font-size: 11px;
}
.pv-viewport {
  background: #142e3b;
  position: relative;
  overflow: hidden;
  width: 100%;
  aspect-ratio: 16 / 9;
}
.pv-canvas {
  width: 960px;
  height: 540px;
  transform-origin: top left;
  position: absolute;
  top: 0;
  left: 0;
}
.pv-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: #b0cbd6;
  pointer-events: none;
}
.pv-placeholder span {
  font-size: 60px;
  font-weight: 200;
  color: #6da4a5;
}
.pv-placeholder p {
  font-size: 12px;
  color: #7398a8;
}
.pv-results > p,
.pv-gallery > p {
  margin: 14px 18px;
  font-size: 12px;
  color: #6d818b;
}
.pv-table-scroll {
  overflow: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  white-space: nowrap;
}
th,
td {
  text-align: left;
  padding: 9px 16px;
  border-bottom: 1px solid #eaf0f3;
}
th {
  background: #f5f8fa;
  color: #607785;
  font-weight: 500;
}
.good {
  color: #187b64;
}
.bad {
  color: #af443c;
}
.pv-validation {
  background: #f5f8f9;
  padding: 14px 18px;
  font-size: 12px;
}
.pv-issues {
  margin: 8px 0;
  padding-left: 18px;
  font-size: 12px;
  color: #8d5445;
  overflow-wrap: anywhere;
  max-height: 180px;
  overflow: auto;
}
.pv-thumbnails {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 16px;
}
.pv-thumbnails button {
  padding: 3px;
  position: relative;
  width: 88px;
  line-height: 0;
}
.pv-thumbnails button.selected {
  outline: 2px solid #248e86;
}
.pv-thumbnails img {
  width: 100%;
  border-radius: 3px;
}
.pv-thumbnails span {
  position: absolute;
  bottom: 5px;
  left: 5px;
  line-height: 1;
  color: white;
  font-size: 10px;
  background: #152e40bd;
  padding: 3px;
}
.pv-inspector {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  padding: 6px 18px 18px;
  align-items: start;
}
.pv-photo {
  width: 100%;
  border-radius: 6px;
}
dl {
  margin: 0;
  min-width: 0;
  font-size: 11px;
}
dt {
  color: #81939d;
}
dd {
  margin: 0 0 9px;
  overflow-wrap: anywhere;
  font-family: ui-monospace, monospace;
}
.pv-note {
  color: #66808d;
  font-size: 12px;
  padding: 4px 4px 14px;
}
.pv-note strong {
  color: #476575;
}
@media (min-width: 1500px) {
  .pv-page {
    max-width: 1500px;
    margin: auto;
  }
}
@media (max-width: 900px) {
  .pv-page {
    padding: 20px 14px;
  }
  .pv-layout {
    grid-template-columns: 230px minmax(0, 1fr);
    gap: 12px;
  }
  .pv-controls section {
    padding: 14px;
  }
  .pv-inspector {
    grid-template-columns: 1fr;
  }
  .pv-section-bar span {
    display: none;
  }
  .pv-summary > div {
    padding: 12px;
  }
  .pv-header {
    align-items: flex-start;
  }
}
@media (max-width: 650px) {
  .pv-layout {
    grid-template-columns: 1fr;
  }
  .pv-summary {
    grid-template-columns: 1fr 1fr;
  }
  .pv-header {
    display: block;
  }
  .pv-header nav {
    margin-top: 14px;
  }
  .pv-controls {
    display: grid;
    grid-template-columns: 1fr;
  }
  .pv-placeholder strong {
    font-size: 13px;
  }
}
</style>
