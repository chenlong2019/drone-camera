<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useCesiumDemo, type CesiumDemoApi } from './use-cesium-demo'

const container = ref<HTMLElement | null>(null)
const modelLabel = ref('加载中…')
const geoText = ref('')
const phaseText = ref('')
let demo: CesiumDemoApi | undefined
let timer: number | null = null

function refresh(): void {
  if (!demo) return
  const s = demo.getStats() as {
    ready?: boolean
    modelLabel?: string
    geo?: { lon: number; lat: number; height: number }
    phase?: string
    altitude?: number
  }
  if (!s.ready || !s.geo) return
  modelLabel.value = s.modelLabel ?? ''
  geoText.value = `${s.geo.lat.toFixed(5)}, ${s.geo.lon.toFixed(5)} · ${s.geo.height.toFixed(1)} m`
  phaseText.value = `${s.phase ?? ''} · 相对起飞点 ${(s.altitude ?? 0).toFixed(1)} m`
}

onMounted(async () => {
  if (!container.value) return
  demo = useCesiumDemo(container.value)
  await demo.init()
  refresh()
  timer = window.setInterval(refresh, 400)
})

onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer)
  demo?.destroy()
  demo = undefined
})

function switchModel(): void {
  demo?.cycleModel()
  refresh()
}
</script>

<template>
  <main class="cesium-page">
    <div ref="container" class="cesium-container" aria-label="Cesium 地球场景" />
    <div class="scene-title">
      <span class="status-dot" />
      <div class="scene-title-text">
        <strong>Cesium 无人机沙盒</strong>
        <small>{{ modelLabel }}</small>
        <small class="mono">{{ geoText }}</small>
        <small class="mono">{{ phaseText }}</small>
      </div>
      <button class="model-switch" type="button" @click="switchModel">切换机体</button>
      <RouterLink class="validation-link" to="/photogrammetry-validation">验证采集</RouterLink>
    </div>
  </main>
</template>

<style>
/* Cesium 的 widgets.css 由 use-cesium-demo 在运行时按 BASE_URL 注入（子路径部署下 @import 的绝对路径会 404） */

.cesium-page,
.cesium-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
}

/* 状态卡片贴在顶部中央:两端分别留给 Cesium 自带工具栏(右上)与飞行控制面板(左上) */
.scene-title {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 14px;
  color: #ecf6ff;
  background: rgb(8 25 43 / 82%);
  border: 1px solid rgb(111 190 255 / 35%);
  border-radius: 8px;
  font-family: system-ui, sans-serif;
  z-index: 10;
}

.scene-title strong,
.scene-title small {
  display: block;
}

.scene-title small {
  color: #9db7cc;
  font-size: 12px;
  margin-top: 3px;
  white-space: nowrap;
}

.scene-title .mono {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  letter-spacing: 0.02em;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #51e3a4;
  box-shadow: 0 0 10px #51e3a4;
  flex: none;
}

.model-switch {
  flex: none;
  margin-left: 6px;
  padding: 6px 12px;
  color: #d6ecff;
  background: rgb(31 74 107 / 78%);
  border: 1px solid rgb(111 190 255 / 45%);
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}

.model-switch:hover {
  background: rgb(43 98 140 / 88%);
}

.validation-link {
  color: #a6e8db;
  font-size: 12px;
  white-space: nowrap;
  text-decoration: none;
}
</style>
