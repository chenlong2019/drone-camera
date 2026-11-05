<template>
  <div class="amap-host">
    <div ref="mapEl" class="amap-canvas" aria-label="高德地图场景" />

    <!-- 左上:真值与坐标系诊断。坐标系那几行是这张图最该看的东西 —— 偏 500m 时数字会先变 -->
    <section class="amap-panel">
      <header class="amap-panel-head">
        <span class="dot" :class="{ 'is-live': snapshot.ready, 'is-error': snapshot.error }" />
        <strong>高德地图 · JS API 2.0</strong>
      </header>

      <p v-if="snapshot.error" class="amap-error">{{ snapshot.error }}</p>

      <dl v-else class="amap-grid">
        <div><dt>阶段</dt><dd>{{ snapshot.phase }}</dd></div>
        <div><dt>高度</dt><dd>{{ snapshot.altitude.toFixed(1) }} m</dd></div>
        <div><dt>航向</dt><dd>{{ snapshot.heading.toFixed(0) }}°</dd></div>
        <div><dt>航点</dt><dd>{{ snapshot.map?.waypoints ?? 0 }}</dd></div>
        <div><dt>航迹点</dt><dd>{{ snapshot.map?.trail ?? 0 }}</dd></div>
        <div><dt>坐标系</dt><dd>{{ snapshot.map?.frame ?? '-' }}</dd></div>
        <div class="span-2">
          <dt>GCJ 偏移(原点)</dt>
          <dd>
            东 {{ snapshot.originOffset.east.toFixed(0) }} m · 北
            {{ snapshot.originOffset.north.toFixed(0) }} m
          </dd>
        </div>
        <div><dt>倾角</dt><dd>{{ view.pitch.toFixed(0) }}°</dd></div>
        <div><dt>旋转</dt><dd>{{ view.rotation.toFixed(0) }}°</dd></div>
        <div class="span-2">
          <dt>云台俯仰</dt>
          <dd>
            {{ (snapshot.map?.gimbalPitch ?? 0).toFixed(0) }}° · 地面落点
            {{ (snapshot.map?.viewRadius ?? 0).toFixed(0) }} m
          </dd>
        </div>
        <div class="span-2">
          <dt>视角模式</dt>
          <dd>{{ CAMERA_MODE_LABELS[snapshot.cameraMode] }}</dd>
        </div>
        <div class="span-2">
          <dt>机体经纬度</dt>
          <dd class="mono">
            {{ snapshot.map?.drone ? `${snapshot.map.drone.lon.toFixed(6)}, ${snapshot.map.drone.lat.toFixed(6)}` : '-' }}
          </dd>
        </div>
      </dl>
    </section>

    <!-- 左下:3D 视角。高德 2.0 的 viewMode 是建图参数、运行期不能切,
         所以这里用「倾角 + 旋转」表达 3D —— 倾角 0 即为 2D 俯视 -->
    <section class="amap-view">
      <label>
        <span>倾角</span>
        <input
          v-model.number="pitch"
          type="range"
          min="0"
          max="83"
          step="1"
          :disabled="!snapshot.ready"
          @input="onPitch"
        />
        <em>{{ pitch }}°</em>
      </label>
      <label>
        <span>旋转</span>
        <input
          v-model.number="rotation"
          type="range"
          min="-180"
          max="180"
          step="1"
          :disabled="!snapshot.ready"
          @input="onRotation"
        />
        <em>{{ rotation }}°</em>
      </label>
      <div class="amap-view-presets">
        <button type="button" :disabled="!snapshot.ready" @click="preset(0, 0)">俯视</button>
        <button type="button" :disabled="!snapshot.ready" @click="preset(45, 0)">斜视</button>
        <button type="button" :disabled="!snapshot.ready" @click="preset(62, -35)">环绕</button>
      </div>
      <p class="amap-hint">
        视角模式(观察者 / 跟随 / 机载)在右上控制面板里切 —— 那三档直接改地图相机。<br />
        <span class="amap-legend"><i />蓝色扇形 = 云台视场的地面落点(半径 = 高度 / tan 俯角),拖云台滑块会变长变短</span><br />
        未起飞时直接拖摇杆(或按 W)会自动起飞;W/S 升降 · A/D 转向 · ↑/↓ 前后 · ←/→ 横滚
      </p>
    </section>

    <!-- 右下:控制条 -->
    <div class="amap-actions">
      <button type="button" :disabled="!snapshot.ready" @click="onMission">执行航线</button>
      <button type="button" :disabled="!snapshot.ready" @click="onRth">返航</button>
      <button type="button" :disabled="!snapshot.ready" @click="onLand">降落</button>
      <button type="button" :disabled="!snapshot.ready" @click="toggleSatellite">
        {{ satellite ? '关影像' : '开影像' }}
      </button>
      <button type="button" :disabled="!snapshot.ready" @click="onFit">总览</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useAmapDemo, type AmapDemoApi, type AmapDemoSnapshot } from './use-amap-demo'
import type { CameraMode } from '@/lib'

/**
 * 视角模式的中文名。
 *
 * 切换入口在右上角的控制面板(`dcp-seg` 三段:观察者 / 跟随 / 机载)——
 * 这里只做只读展示,避免同一页面上出现两组同名按钮。
 */
const CAMERA_MODE_LABELS: Record<CameraMode, string> = {
  orbit: '观察者(不跟随)',
  follow: '跟随(正北朝上)',
  fpv: '机载(机头朝上 + 78°)',
}

const mapEl = ref<HTMLElement | null>(null)
const satellite = ref(true)
const pitch = ref(45)
const rotation = ref(0)
const snapshot = ref<AmapDemoSnapshot>({
  ready: false,
  error: null,
  local: { x: 0, y: 0, z: 0 },
  altitude: 0,
  heading: 0,
  gimbalPitch: 0,
  phase: 'powerOff',
  airborne: false,
  map: null,
  originOffset: { east: 0, north: 0 },
  hasKey: false,
  cameraMode: 'follow',
})

/** 视角相关的实时读数(倾角/旋转/缩放),与 snapshot 同步刷新 */
const view = ref({ pitch: 45, rotation: 0, zoom: 17 })

const demo = shallowRef<AmapDemoApi | null>(null)
let poll = 0

function refresh(): void {
  const api = demo.value
  if (!api) return
  snapshot.value = api.getSnapshot()
  const map = snapshot.value.map
  if (map) view.value = { pitch: map.pitch, rotation: map.rotation, zoom: map.zoom }
  // 面板/机载模式会改倾角与旋转,滑块要跟上(否则读数与画面脱节)
  pitch.value = Math.round(view.value.pitch)
  rotation.value = Math.round(view.value.rotation)
}

onMounted(async () => {
  if (!mapEl.value) return
  const api = useAmapDemo(mapEl.value)
  demo.value = api
  await api.init()
  refresh()
  // 开发态暴露给验证脚本(与 three / Cesium 两页同一套约定)
  if (import.meta.env.DEV) {
    ;(window as unknown as Record<string, unknown>).__amapDemo = {
      api,
      snapshot: () => api.getSnapshot(),
    }
  }
  // 面板读数 5Hz 足够:地图本身由 sim 循环按帧推进,这里只读快照
  poll = window.setInterval(refresh, 200)
})

onBeforeUnmount(() => {
  window.clearInterval(poll)
  demo.value?.destroy()
  demo.value = null
})

function onMission(): void {
  demo.value?.runMission()
  // 执行航线时切回跟随:否则飞出去就看不见了
  demo.value?.setCameraMode('follow')
  refresh()
}

function onRth(): void {
  demo.value?.returnHome()
  refresh()
}

function onLand(): void {
  demo.value?.land()
  refresh()
}

function onFit(): void {
  demo.value?.setCameraMode('orbit')
  demo.value?.fitView()
  refresh()
}

function toggleSatellite(): void {
  satellite.value = !satellite.value
  demo.value?.setSatellite(satellite.value)
}

function onPitch(): void {
  demo.value?.setPitch(pitch.value)
  refresh()
}

function onRotation(): void {
  demo.value?.setRotation(rotation.value)
  refresh()
}

function preset(nextPitch: number, nextRotation: number): void {
  pitch.value = nextPitch
  rotation.value = nextRotation
  demo.value?.setPitch(nextPitch)
  demo.value?.setRotation(nextRotation)
  refresh()
}
</script>

<style scoped>
.amap-host {
  position: relative;
  width: 100%;
  height: 100%;
}

.amap-canvas {
  width: 100%;
  height: 100%;
}

.amap-panel {
  position: absolute;
  top: 16px;
  left: 16px;
  width: 268px;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(15, 19, 27, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #e9eff9;
  font-size: 12px;
  backdrop-filter: blur(8px);
  z-index: 20;
}

.amap-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 13px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(233, 239, 249, 0.35);
}

.dot.is-live {
  background: #2dd4bf;
  box-shadow: 0 0 8px #2dd4bf;
}

.dot.is-error {
  background: #ff5f5f;
  box-shadow: 0 0 8px #ff5f5f;
}

.amap-error {
  margin: 0;
  color: #ffb4b4;
  line-height: 1.5;
}

.amap-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 10px;
  margin: 0;
}

.amap-grid dt {
  color: rgba(233, 239, 249, 0.55);
  font-size: 11px;
}

.amap-grid dd {
  margin: 2px 0 0;
  font-variant-numeric: tabular-nums;
}

.span-2 {
  grid-column: span 2;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

.amap-view {
  position: absolute;
  left: 16px;
  /* 避开左摇杆(sticks-float 里杆位 left:30 bottom:40、底盘 92px,顶到 ~150):
     视角条抬到 176,不与摇杆重叠 */
  bottom: 176px;
  width: 268px;
  padding: 10px 14px 12px;
  border-radius: 12px;
  background: rgba(15, 19, 27, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #e9eff9;
  font-size: 12px;
  backdrop-filter: blur(8px);
  z-index: 20;
}

.amap-view label {
  display: grid;
  grid-template-columns: 34px 1fr 44px;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.amap-view label:first-child {
  margin-top: 0;
}

.amap-view input[type='range'] {
  width: 100%;
  accent-color: #35a7ff;
}

.amap-view em {
  font-style: normal;
  color: rgba(233, 239, 249, 0.7);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.amap-hint {
  margin: 10px 0 0;
  color: rgba(233, 239, 249, 0.5);
  font-size: 11px;
  line-height: 1.5;
}
/* 图例:用小扇形(半个三角)对上地图上的锥,比一句"蓝色区域"直观 */
.amap-legend {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.amap-legend i {
  width: 0; height: 0;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  border-bottom: 11px solid rgba(53, 167, 255, 0.55);
  flex: none;
}

.amap-view-presets {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.amap-view-presets button {
  flex: 1;
  padding: 5px 0;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: transparent;
  color: #e9eff9;
  font-size: 11px;
  cursor: pointer;
}

.amap-view-presets button:hover:not(:disabled) {
  border-color: #35a7ff;
  color: #35a7ff;
}

.amap-actions {
  position: absolute;
  /* 底部居中:左右两角被双摇杆占据(杆位 30/40、底盘 92px),贴边必压杆 */
  left: 50%;
  transform: translateX(-50%);
  bottom: 16px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  z-index: 20;
}

.amap-actions button {
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(15, 19, 27, 0.86);
  color: #e9eff9;
  font-size: 12px;
  cursor: pointer;
  backdrop-filter: blur(8px);
}

.amap-actions button:hover:not(:disabled) {
  border-color: #35a7ff;
  color: #35a7ff;
}

.amap-actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.amap-actions button.is-on {
  border-color: #2dd4bf;
  color: #2dd4bf;
}
</style>
