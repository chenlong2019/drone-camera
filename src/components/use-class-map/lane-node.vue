<template>
  <div class="ln" :style="{ '--lane': data.color }">
    <div class="ln-head">
      <span class="ln-dot"></span>
      <span class="ln-title">{{ data.title }}</span>
    </div>
    <p class="ln-sub">{{ data.subtitle }}</p>
    <p class="ln-note">{{ data.note }}</p>
  </div>
</template>

<script setup lang="ts">
import type { LaneNodeData } from './class-map-data'

defineProps<{ data: LaneNodeData }>()
</script>

<style scoped lang="scss">
.ln {
  width: 168px;
  padding: 2px 10px 2px 10px;
  border-left: 1px dashed var(--lane);
  color: #e8ecf1;
  font:
    400 12px/1.6 system-ui,
    -apple-system,
    'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
}

.ln-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ln-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--lane);
}

.ln-title {
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.ln-sub {
  margin: 2px 0 0;
  color: rgba(232, 236, 241, 0.42);
  font-size: 11px;
}

.ln-note {
  margin: 8px 0 0;
  color: rgba(232, 236, 241, 0.3);
  font-size: 10.5px;
  line-height: 1.55;
}
</style>
