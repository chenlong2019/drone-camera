<template>
  <div class="pano-demo-main">
    <panorama-demo-view></panorama-demo-view>
  </div>
</template>

<script setup lang="ts">
import PanoramaDemoView from '@/components/use-panorama-demo/use-panorama-demo.vue'
</script>

<style lang="scss" scoped>
.pano-demo-main {
  width: 100%;
  height: 100%;
  position: relative;
}
</style>
