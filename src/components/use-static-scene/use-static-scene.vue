<template>
  <div ref="hostRef" class="static-root">
    <!-- 电影感暗角：只压四角，不挡画面中心 -->
    <div class="static-vignette"></div>

    <header class="static-title" :class="{ 'is-ready': ready }">
      <p class="st-kicker">STATIC SCENE · 01</p>
      <h1>边境营地</h1>
      <p class="st-sub">程序化生成 · 清晨低角度光 · 无任务 / 无交互</p>
    </header>

    <aside class="static-stats" :class="{ 'is-ready': ready }">
      <div class="ss-item">
        <b>{{ content.buildings }}</b>
        <span>建筑</span>
      </div>
      <div class="ss-item">
        <b>{{ content.trees }}</b>
        <span>树</span>
      </div>
      <div class="ss-item">
        <b>{{ content.props }}</b>
        <span>道具</span>
      </div>
      <div class="ss-item">
        <b>{{ render.calls || content.drawCalls }}</b>
        <span>绘制 / 帧</span>
      </div>
      <div class="ss-item">
        <b>{{ fps }}</b>
        <span>FPS</span>
      </div>
    </aside>

    <p class="static-hint" :class="{ 'is-ready': ready }">拖拽环视 · 滚轮缩放</p>

    <div v-if="!ready" class="static-loading">
      <span class="sl-ring"></span>
      <p>正在生成场景…</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { UseStaticScene } from './use-static-scene'
import type { RenderInfo } from './use-static-scene'
import type { StaticSceneStats } from './static-scene'

const hostRef = ref<HTMLDivElement | null>(null)
const ready = ref(false)
const render = reactive<RenderInfo>({ fps: 0, calls: 0, triangles: 0 })
const content = reactive<StaticSceneStats>({
  buildings: 0,
  props: 0,
  trees: 0,
  bushes: 0,
  grass: 0,
  rocks: 0,
  drawCalls: 0,
  triangles: 0,
})

const fps = computed(() => (render.fps > 0 ? render.fps : '—'))

let viewer: UseStaticScene | null = null

onMounted(async () => {
  if (!hostRef.value) return
  viewer = new UseStaticScene(hostRef.value)
  viewer.onReady = () => {
    ready.value = true
  }
  viewer.onStats = (info) => {
    Object.assign(render, info)
  }
  await viewer.init()
  const stats = viewer.contentStats
  if (stats) Object.assign(content, stats)
})

onUnmounted(() => {
  viewer?.dispose()
  viewer = null
})
</script>

<style lang="scss" scoped>
.static-root {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #0b0f14;

  // 三维画布铺满
  :deep(canvas) {
    display: block;
    width: 100% !important;
    height: 100% !important;
  }
}

.static-vignette {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  background:
    radial-gradient(ellipse 78% 68% at 50% 46%, transparent 42%, rgba(6, 8, 10, 0.42) 100%),
    linear-gradient(to bottom, rgba(6, 8, 10, 0.28), transparent 18%, transparent 78%, rgba(6, 8, 10, 0.34));
}

.static-title {
  position: absolute;
  left: 30px;
  bottom: 30px;
  z-index: 10;
  color: #f2ece2;
  opacity: 0;
  transform: translateY(10px);
  transition:
    opacity 0.9s ease 0.25s,
    transform 0.9s ease 0.25s;

  &.is-ready {
    opacity: 1;
    transform: translateY(0);
  }

  .st-kicker {
    margin: 0 0 8px;
    color: rgba(242, 236, 226, 0.62);
    font:
      600 10px/1 ui-monospace,
      'SF Mono',
      Consolas,
      monospace;
    letter-spacing: 0.22em;
  }

  h1 {
    margin: 0;
    font:
      600 34px/1.1 'Songti SC',
      'Noto Serif SC',
      Georgia,
      serif;
    letter-spacing: 0.06em;
    text-shadow: 0 2px 18px rgba(0, 0, 0, 0.55);
  }

  .st-sub {
    margin: 10px 0 0;
    color: rgba(242, 236, 226, 0.66);
    font:
      400 12px/1.5 system-ui,
      -apple-system,
      'PingFang SC',
      'Microsoft YaHei',
      sans-serif;
    letter-spacing: 0.04em;
  }
}

.static-stats {
  position: absolute;
  top: 22px;
  right: 24px;
  z-index: 10;
  display: flex;
  gap: 1px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  background: rgba(16, 19, 23, 0.55);
  backdrop-filter: blur(14px);
  opacity: 0;
  transition: opacity 0.9s ease 0.4s;

  &.is-ready {
    opacity: 1;
  }
}

.ss-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 60px;
  padding: 10px 12px;
  text-align: center;
  border-left: 1px solid rgba(255, 255, 255, 0.07);

  &:first-child {
    border-left: 0;
  }

  b {
    color: #f4eee3;
    font:
      600 15px/1 ui-monospace,
      'SF Mono',
      Consolas,
      monospace;
    font-variant-numeric: tabular-nums;
  }

  span {
    color: rgba(244, 238, 227, 0.5);
    font:
      400 10px/1 system-ui,
      -apple-system,
      'PingFang SC',
      'Microsoft YaHei',
      sans-serif;
    letter-spacing: 0.08em;
  }
}

.static-hint {
  position: absolute;
  right: 26px;
  bottom: 28px;
  z-index: 10;
  margin: 0;
  color: rgba(242, 236, 226, 0.5);
  font:
    400 11px/1 system-ui,
    -apple-system,
    'PingFang SC',
    'Microsoft YaHei',
    sans-serif;
  letter-spacing: 0.12em;
  opacity: 0;
  transition: opacity 0.9s ease 0.65s;

  &.is-ready {
    opacity: 1;
  }
}

.static-loading {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at 50% 45%, #1a2028, #0b0f14 70%);
  color: rgba(240, 236, 226, 0.72);
  font:
    400 12px/1 system-ui,
    -apple-system,
    'PingFang SC',
    'Microsoft YaHei',
    sans-serif;
  letter-spacing: 0.16em;
  transition: opacity 0.6s ease;

  p {
    margin: 0;
  }
}

.sl-ring {
  width: 26px;
  height: 26px;
  border: 2px solid rgba(255, 255, 255, 0.16);
  border-top-color: rgba(255, 214, 160, 0.9);
  border-radius: 50%;
  animation: sl-spin 0.9s linear infinite;
}

@keyframes sl-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 720px) {
  .static-title {
    left: 18px;
    bottom: 20px;

    h1 {
      font-size: 26px;
    }
  }

  .static-stats {
    top: 14px;
    right: 14px;

    .ss-item {
      min-width: 46px;
      padding: 8px;
    }
  }

  .static-hint {
    display: none;
  }
}
</style>
