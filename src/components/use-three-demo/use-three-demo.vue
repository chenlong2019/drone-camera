<template>
  <div class="div-bg" ref="viewerRef">
    <!-- 机体切换:机械哈士奇(库内置,零资产) ⇄ 真机 GLB。切换 = 销毁整个 DroneFly 后重建(见 switchBody) -->
    <button
      class="model-switch"
      :class="{ 'is-husky': body === 'husky', 'is-busy': switching }"
      :disabled="switching"
      @click="onSwitchBody"
    >
      <span class="ms-dot"></span>
      <span class="ms-name">{{ body === 'husky' ? '哈士奇机体' : '真机模型' }}</span>
      <span class="ms-hint">{{ switching ? '切换中…' : '点击切换' }}</span>
    </button>
    <!-- 360° 全景:独立弹窗,可导入本地等距柱状全景图拖动环视 -->
    <button class="pano-open" @click="onOpenPanorama">
      <span class="ms-dot pano-dot"></span>
      <span class="ms-name">360° 全景</span>
      <span class="ms-hint">查看 / 导入</span>
    </button>
    <!-- 文档:站内使用文档页(操作说明 / 全景工作流 / 无头 MCP) -->
    <button class="docs-open" @click="onOpenDocs">
      <span class="ms-dot docs-dot"></span>
      <span class="ms-name">文档</span>
      <span class="ms-hint">使用说明</span>
    </button>
    <p v-if="error" class="ms-error">{{ error }}</p>
    <!-- 首帧加载覆盖层:机体 GLB(约14MB)下载完成前 canvas 没有画面,给一个明确的等待提示 -->
    <div v-if="loading" class="ms-boot">
      <span class="boot-ring"></span>
      <span class="boot-text">正在加载机体模型,首次访问约需 10~30 秒…</span>
    </div>
  </div>
</template>
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { UseThreeDemo } from './use-three-demo'

const router = useRouter()

const viewerRef = ref<HTMLDivElement | null>(null)
let libDemo: UseThreeDemo | null = null

const body = ref<'husky' | 'glb'>('glb')
const switching = ref(false)
const error = ref('')
const loading = ref(true)

onMounted(async () => {
  if (!viewerRef.value) return
  libDemo = new UseThreeDemo(viewerRef.value)
  libDemo.onBodyChange = (kind) => {
    body.value = kind
  }
  try {
    await libDemo.init()
  } finally {
    loading.value = false
  }
  // init 里会按 ?model=husky 决定初始机体,同步到按钮文案
  body.value = libDemo.currentBody
  // 文档页「打开 360° 全景」带 ?pano=1 跳过来:自动展开全景弹窗,免得用户再点一次
  if (new URLSearchParams(window.location.search).get('pano') === '1') {
    libDemo.openPanorama()
  }
})

async function onSwitchBody(): Promise<void> {
  if (!libDemo || switching.value) return
  switching.value = true
  error.value = ''
  try {
    await libDemo.switchBody()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '机体切换失败'
    setTimeout(() => (error.value = ''), 4000)
  } finally {
    switching.value = false
  }
}

function onOpenPanorama(): void {
  libDemo?.openPanorama()
}

function onOpenDocs(): void {
  void router.push('/docs')
}

onUnmounted(() => {
  libDemo?.destroy()
})
</script>
<style lang="scss" scoped>
.div-bg {
  width: 100%;
  height: 100%;
  position: relative;
}

.model-switch {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 13px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  background: rgba(18, 20, 24, 0.66);
  backdrop-filter: blur(10px);
  color: #e8ecf1;
  font:
    500 13px/1 system-ui,
    -apple-system,
    'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition:
    background 0.18s,
    border-color 0.18s;

  &:hover:not(:disabled) {
    background: rgba(30, 34, 40, 0.8);
    border-color: rgba(255, 255, 255, 0.32);
  }

  &:disabled {
    cursor: progress;
    opacity: 0.75;
  }

  // 哈士奇机体:指示灯换暖橙,一眼分辨当前是哪种机体
  &.is-husky .ms-dot {
    background: #ffb020;
    box-shadow: 0 0 8px #ffb020;
  }

  &.is-busy .ms-hint {
    color: #ffd666;
  }
}

.ms-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #35c0ff;
  box-shadow: 0 0 8px #35c0ff;
}

// 360° 全景按钮:与机体切换按钮同一套外观,摆在它左侧错开
.pano-open {
  position: absolute;
  top: 12px;
  right: calc(50% + 112px);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 13px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  background: rgba(18, 20, 24, 0.66);
  backdrop-filter: blur(10px);
  color: #e8ecf1;
  font:
    500 13px/1 system-ui,
    -apple-system,
    'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition:
    background 0.18s,
    border-color 0.18s;

  &:hover {
    background: rgba(30, 34, 40, 0.8);
    border-color: rgba(255, 255, 255, 0.32);
  }
}

.pano-dot {
  background: #8f7bff;
  box-shadow: 0 0 8px #8f7bff;
}

// 文档按钮:与机体切换按钮同一套外观,摆在它右侧错开
.docs-open {
  position: absolute;
  top: 12px;
  left: calc(50% + 112px);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 13px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  background: rgba(18, 20, 24, 0.66);
  backdrop-filter: blur(10px);
  color: #e8ecf1;
  font:
    500 13px/1 system-ui,
    -apple-system,
    'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition:
    background 0.18s,
    border-color 0.18s;

  &:hover {
    background: rgba(30, 34, 40, 0.8);
    border-color: rgba(255, 255, 255, 0.32);
  }
}

.docs-dot {
  background: #3ddc97;
  box-shadow: 0 0 8px #3ddc97;
}

.ms-name {
  font-weight: 600;
}

.ms-hint {
  color: rgba(232, 236, 241, 0.6);
  font-size: 12px;
}

.ms-error {
  position: absolute;
  top: 46px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  margin: 0;
  padding: 6px 12px;
  border-radius: 8px;
  background: rgba(120, 24, 24, 0.86);
  color: #ffe3e3;
  font:
    500 12px/1.4 system-ui,
    -apple-system,
    'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
}

.ms-boot {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: radial-gradient(ellipse at 50% 42%, #1b2030 0%, #0d1018 70%);
  color: #cfd8e3;
  font:
    500 13px/1.6 system-ui,
    -apple-system,
    'Segoe UI',
    'Microsoft YaHei',
    sans-serif;

  .boot-ring {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 3px solid rgba(53, 192, 255, 0.22);
    border-top-color: #35c0ff;
    animation: boot-spin 0.9s linear infinite;
  }

  .boot-text {
    opacity: 0.82;
    letter-spacing: 0.02em;
  }
}

@keyframes boot-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
