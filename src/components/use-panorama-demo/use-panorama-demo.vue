<template>
  <div class="upd-root">
    <!-- 查看器以内嵌模式填满这一格(容器必须是定位上下文) -->
    <div ref="stageRef" class="upd-stage"></div>
    <header class="upd-head">
      <h1>360° 环视</h1>
      <p>虚拟采集原始照片 → 球面合成(3600×1800 等距柱状) · 拖动环视 / 滚轮缩放</p>
    </header>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { DronePanoramaViewer } from '@/lib'

/** demo 资产:合成好的球面全景(由 6.1MB 原图转 623KB JPEG,尺寸不变) */
const PANO_URL = '/panorama/pano-360-demo.jpg'

const stageRef = ref<HTMLDivElement | null>(null)
let viewer: DronePanoramaViewer | null = null

onMounted(() => {
  const stage = stageRef.value
  if (!stage) return
  viewer = new DronePanoramaViewer({
    // 内嵌模式:不弹全屏弹窗,直接填满 stage;开场缓慢自转,用户一上手就停
    inline: stage,
    autoRotateDegPerSec: 1.2,
  })
  viewer.open(PANO_URL, '海湾大桥 360° 环视')
})

onUnmounted(() => {
  viewer?.destroy()
  viewer = null
})
</script>

<style lang="scss" scoped>
.upd-root {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #04060a;
}
.upd-stage {
  position: absolute;
  inset: 0;
}
.upd-head {
  position: absolute;
  left: 14px;
  top: 12px;
  z-index: 2;
  pointer-events: none;
  color: #e9eff9;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
  h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  p {
    margin: 2px 0 0;
    font-size: 12px;
    color: rgba(233, 239, 249, 0.6);
  }
}
</style>
