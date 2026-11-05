<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  DigitalCampusDemo,
  type DigitalCampusSnapshot,
} from './use-digital-campus-demo'

const rootRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const panelHostRef = ref<HTMLElement | null>(null)
const snapshot = ref<DigitalCampusSnapshot>({
  stage: 'loading',
  stations: 0,
  total: 0,
  captured: 0,
  failed: 0,
  estimatedSeconds: 0,
  altitude: 35,
  tiltDeg: 38,
  warnings: [],
  message: '正在加载数字园区与飞控内核…',
  fps: 0,
  flightAltitude: 0,
  waypoint: 0,
  pointCloudPoints: 0,
})
const altitude = ref(35)
const tiltDeg = ref(38)
const loading = ref(true)
const loadError = ref('')
const missionOpen = ref(false)
const flightOpen = ref(true)
let demo: DigitalCampusDemo | null = null
let unsubscribe: (() => void) | null = null

const statusLabel = computed(() => ({
  loading: '加载中',
  ready: '已规划',
  preparing: '起飞自检',
  running: '执行中',
  paused: '已暂停',
  done: '已完成',
  cancelled: '已结束',
  failed: '执行失败',
})[snapshot.value.stage])
const progress = computed(() => {
  if (!snapshot.value.total) return 0
  return Math.round(((snapshot.value.captured + snapshot.value.failed) / snapshot.value.total) * 100)
})
const durationLabel = computed(() => {
  const seconds = snapshot.value.estimatedSeconds
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
})
const isRunning = computed(() => ['preparing', 'running', 'paused'].includes(snapshot.value.stage))

function buildPlan(): void {
  demo?.buildPlan(altitude.value, tiltDeg.value)
}

function start(): void {
  demo?.start()
}

function togglePause(): void {
  demo?.togglePause()
}

function cancel(): void {
  demo?.cancel()
}

function toggleMission(): void {
  missionOpen.value = !missionOpen.value
  demo?.showMissionPanel(missionOpen.value)
}

function toggleFlight(): void {
  flightOpen.value = !flightOpen.value
  demo?.showFlightPanel(flightOpen.value)
}

declare global {
  interface Window {
    __DIGITAL_CAMPUS_DEMO__?: { getDiagnostics: () => ReturnType<DigitalCampusDemo['getDiagnostics']> }
  }
}

function downloadText(text: string, fileName: string, type: string): void {
  if (!text) return
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function downloadPointCloud(): Promise<void> {
  downloadText(await demo?.exportPointCloud() ?? '', 'digital-campus-center-roads.ply', 'application/octet-stream')
}

function downloadManifest(): void {
  downloadText(demo?.exportManifest() ?? '', 'digital-campus-survey-manifest.json', 'application/json;charset=utf-8')
}

onMounted(async () => {
  if (!rootRef.value || !canvasRef.value || !panelHostRef.value) return
  demo = new DigitalCampusDemo(rootRef.value, canvasRef.value, panelHostRef.value, {
    altitude: altitude.value,
    tiltDeg: tiltDeg.value,
  })
  unsubscribe = demo.subscribe((next) => {
    snapshot.value = next
  })
  const mountedDemo = demo
  try {
    await mountedDemo.mount()
    if (demo !== mountedDemo) return
    flightOpen.value = window.innerWidth > 900
    mountedDemo.showFlightPanel(flightOpen.value)
    if (import.meta.env.DEV) {
      window.__DIGITAL_CAMPUS_DEMO__ = { getDiagnostics: () => mountedDemo.getDiagnostics() }
    }
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '场景初始化失败'
    mountedDemo.destroy()
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  unsubscribe?.()
  demo?.destroy()
  demo = null
  if (import.meta.env.DEV) delete window.__DIGITAL_CAMPUS_DEMO__
})
</script>

<template>
  <main ref="rootRef" class="campus-demo">
    <canvas ref="canvasRef" class="campus-canvas" aria-label="数字园区无人机测绘场景"></canvas>
    <div ref="panelHostRef" class="library-panels" aria-label="无人机库控制面板"></div>

    <header class="campus-header">
      <div class="campus-brand">
        <span class="brand-mark">航</span>
        <span><strong>数字园区</strong><small>中心区域路面点云采集</small></span>
      </div>
      <nav class="view-actions" aria-label="场景控制">
        <RouterLink to="/three-demo">返回示例</RouterLink>
        <button @click="demo?.resetView()">园区总览</button>
        <button @click="demo?.frameMission()">查看航线</button>
        <button :aria-pressed="missionOpen" @click="toggleMission">{{ missionOpen ? '测绘任务' : '航点列表' }}</button>
        <button :aria-pressed="flightOpen" @click="toggleFlight">飞控面板</button>
      </nav>
    </header>

    <aside v-show="!missionOpen" class="survey-card">
      <div class="card-kicker">MISSION BUILDER</div>
      <div class="card-title"><h2>中心路面点云</h2><span :class="['status-chip', `is-${snapshot.stage}`]">{{ statusLabel }}</span></div>
      <p class="card-copy">中央草坪与相邻内环路 · 地面正射与四向倾斜覆盖。拖动场景旋转，右键平移，滚轮缩放。</p>

      <div class="field-grid">
        <label><span>表面上方高度</span><output>{{ altitude }} m</output><input v-model.number="altitude" :disabled="isRunning" type="range" min="25" max="90" step="1" /></label>
        <label><span>倾斜角度</span><output>{{ tiltDeg }}°</output><input v-model.number="tiltDeg" :disabled="isRunning" type="range" min="0" max="60" step="1" /></label>
      </div>

      <div class="stats">
        <div><small>测绘站</small><strong>{{ snapshot.stations }}</strong></div>
        <div><small>影像数</small><strong>{{ snapshot.total }}</strong></div>
        <div><small>估算时长</small><strong>{{ durationLabel }}</strong></div>
        <div><small>点云</small><strong>{{ snapshot.pointCloudPoints }}</strong></div>
      </div>

      <div class="actions">
        <button class="primary" :disabled="isRunning" @click="buildPlan">生成航线</button>
        <button :disabled="isRunning || snapshot.stage === 'loading'" @click="start">开始自主采集</button>
        <button :disabled="!['running', 'paused'].includes(snapshot.stage)" @click="togglePause">{{ snapshot.stage === 'paused' ? '继续' : '暂停' }}</button>
        <button :disabled="!isRunning" @click="cancel">结束任务</button>
      </div>

      <div class="progress-block">
        <div><span>影像采集</span><strong>{{ snapshot.captured + snapshot.failed }} / {{ snapshot.total }}</strong></div>
        <div class="progress-track"><i :style="{ width: `${progress}%` }"></i></div>
        <p>{{ snapshot.message }}</p>
      </div>

      <div class="card-footer">
        <button class="text-button" :disabled="snapshot.pointCloudPoints === 0" @click="downloadPointCloud">导出 point-cloud.ply</button>
        <button class="text-button" :disabled="snapshot.captured === 0" @click="downloadManifest">导出 manifest.json</button>
        <span v-if="snapshot.warnings.length">有规划提示</span>
        <span v-else>覆盖参数正常</span>
      </div>
    </aside>

    <div class="campus-legend">
      <span><i class="path-dot"></i>高度 {{ snapshot.flightAltitude.toFixed(1) }} m</span>
      <span><i class="active-dot"></i>航点 {{ snapshot.waypoint }} / {{ snapshot.total }}</span>
      <span>{{ snapshot.fps }} fps</span>
    </div>

    <div v-if="loading" class="loading-mask">正在加载数字园区与飞控内核…</div>
    <div v-else-if="loadError" class="loading-mask" role="alert">场景加载失败：{{ loadError }}</div>
  </main>
</template>

<style scoped lang="scss">
.campus-demo { position: relative; width: 100%; height: 100%; overflow: hidden; color: #edf7f4; background: #07151b; font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif; }
.campus-demo, .campus-demo * { box-sizing: border-box; }
.campus-demo button { cursor: pointer; font: inherit; }
.campus-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.library-panels { position: absolute; inset: 0; z-index: 10; pointer-events: none; }
/* 库创建的 DOM 没有 Vue scope 属性；只让实际面板命中鼠标。
   全屏摇杆容器保持穿透，其按钮和摇杆由库自己开启 pointer-events。 */
.library-panels :deep(.dcp), .library-panels :deep(.dmp) { pointer-events: auto; }
.library-panels :deep(.dcp-sticks-float) { pointer-events: none; }
.library-panels :deep(.dcp), .library-panels :deep(.dmp) { top: 92px; max-height: calc(100% - 270px); }
.library-panels :deep(.dmp) { left: 20px; width: 300px; }
.campus-header, .campus-intro, .survey-card, .campus-legend, .loading-mask { position: absolute; z-index: 20; }
.campus-header { top: 0; left: 0; right: 0; height: 76px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; border-bottom: 1px solid rgba(184, 229, 218, .14); background: rgba(4, 20, 26, .85); pointer-events: none; }
.view-actions { display: flex; gap: 8px; pointer-events: auto; }
.view-actions button, .view-actions a { padding: 7px 10px; border: 1px solid #5b96894d; border-radius: 5px; color: #c6e2dc; background: #14373eb3; text-decoration: none; font-size: 11px; }
.view-actions [aria-pressed='true'] { border-color: #72d6bc; }
.campus-brand { display: flex; align-items: center; gap: 11px; }
.brand-mark { display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid #7fd8c4; border-radius: 50%; color: #9bf1dc; font-family: 'STKaiti', 'KaiTi', serif; font-size: 18px; }
.campus-brand strong, .campus-brand small { display: block; }
.campus-brand strong { font-size: 15px; letter-spacing: 2px; }
.campus-brand small { margin-top: 3px; color: #99bdb9; font-size: 9px; letter-spacing: 1px; }
.header-meta { color: #91b4b2; font-size: 9px; letter-spacing: 1.5px; }
.header-meta i { display: inline-block; width: 6px; height: 6px; margin-right: 7px; border-radius: 50%; background: #74e0c1; box-shadow: 0 0 0 4px rgba(116, 224, 193, .12); }
.campus-intro { top: 112px; left: 34px; text-shadow: 0 2px 20px #041018; pointer-events: none; }
.campus-intro small { color: #82d0bd; font-size: 9px; letter-spacing: 2.5px; }
.campus-intro h1 { margin: 14px 0 12px; font-family: 'STSong', 'SimSun', serif; font-size: 38px; line-height: 1.2; font-weight: 500; letter-spacing: 3px; }
.campus-intro p { margin: 0; color: #adccc9; font-size: 10px; }
.survey-card { top: 92px; left: 20px; width: 300px; max-height: calc(100% - 270px); overflow: auto; padding: 18px; border: 1px solid rgba(170, 225, 215, .2); border-radius: 12px; background: rgba(9, 29, 35, .94); box-shadow: 0 12px 32px rgba(0, 0, 0, .2); }
.card-kicker { color: #6bb5a7; font-size: 8px; letter-spacing: 2px; }
.card-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 7px; }
.card-title h2 { margin: 0; font-size: 15px; letter-spacing: 1px; }
.status-chip { border: 1px solid rgba(142, 222, 202, .28); border-radius: 20px; padding: 4px 8px; color: #94ddc8; font-size: 8px; white-space: nowrap; }
.status-chip.is-running, .status-chip.is-preparing { color: #ffe2a1; border-color: rgba(255, 216, 135, .38); }
.status-chip.is-done { color: #8ce4c8; border-color: rgba(140, 228, 200, .45); }
.status-chip.is-failed { color: #ffaaa0; border-color: rgba(255, 137, 125, .45); }
.card-copy { margin: 10px 0 15px; color: #8eafad; font-size: 10px; line-height: 1.65; }
.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.field-grid label { color: #a7c8c2; font-size: 9px; }
.field-grid label > span { display: inline-block; }
.field-grid output { float: right; color: #d8f4ea; }
.field-grid input { width: 100%; margin-top: 10px; accent-color: #72d6bc; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin: 17px 0 14px; }
.stats div { padding: 8px 7px; border: 1px solid rgba(157, 213, 204, .12); border-radius: 6px; background: rgba(6, 20, 25, .4); }
.stats small, .stats strong { display: block; }
.stats small { color: #759996; font-size: 8px; }
.stats strong { margin-top: 4px; color: #e0f4ed; font-size: 13px; font-weight: 500; }
.actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.actions button { min-height: 31px; border: 1px solid rgba(167, 222, 211, .24); border-radius: 5px; color: #c6e2dc; background: rgba(20, 55, 62, .7); font-size: 9px; }
.actions button:hover:not(:disabled) { border-color: #73d6bd; background: rgba(31, 86, 89, .8); }
.actions .primary { border-color: rgba(119, 222, 192, .64); color: #071b1c; background: #86e0c1; }
.actions button:disabled { cursor: default; opacity: .42; }
.progress-block { margin-top: 15px; padding-top: 13px; border-top: 1px solid rgba(167, 222, 211, .12); }
.progress-block > div:first-child { display: flex; justify-content: space-between; color: #8eafad; font-size: 9px; }
.progress-block strong { color: #d9f1e9; font-weight: 500; }
.progress-track { height: 4px; margin-top: 9px; overflow: hidden; border-radius: 4px; background: #17383d; }
.progress-track i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #60cfae, #d3f39c); transition: width .25s ease; }
.progress-block p { min-height: 28px; margin: 8px 0 0; color: #7f9f9c; font-size: 9px; line-height: 1.6; }
.card-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; color: #d7b978; font-size: 8px; }
.text-button { padding: 0; border: 0; color: #82cdbb; background: transparent; font-size: 9px; text-decoration: underline; text-underline-offset: 3px; }
.text-button:disabled { opacity: .4; }
.campus-legend { left: 50%; transform: translateX(-50%); bottom: 28px; padding: 8px 14px; border-radius: 20px; background: #0a202ce6; display: flex; gap: 16px; color: #c4e1db; font-size: 11px; white-space: nowrap; pointer-events: none; }
.campus-legend span { display: flex; align-items: center; gap: 8px; }
.campus-legend i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; }
.path-dot { background: #8ce5ce; box-shadow: 0 0 10px #8ce5ce; }
.active-dot { background: #ffd77c; box-shadow: 0 0 10px #ffd77c; }
.loading-mask { inset: 0; display: grid; place-items: center; color: #a9ded0; background: #07151b; font-size: 13px; letter-spacing: 1px; }
@media (max-width: 900px) { .campus-header { height: 100px; padding: 10px 16px; flex-wrap: wrap; gap: 8px; } .view-actions { gap: 4px; flex-wrap: wrap; } .view-actions button, .view-actions a { padding: 5px 7px; } .survey-card { top: auto; left: 12px; bottom: 12px; max-height: 42vh; width: min(300px, calc(100% - 24px)); } .library-panels :deep(.dmp), .library-panels :deep(.dcp) { top: 112px; max-height: calc(100% - 288px); } .campus-legend { bottom: auto; top: 112px; right: 12px; left: auto; transform: none; font-size: 9px; gap: 8px; } }
</style>
