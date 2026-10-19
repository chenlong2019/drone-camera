<template>
  <div class="cn" :class="`is-${data.doc.layer}`">
    <Handle type="target" :position="Position.Left" />
    <Handle type="source" :position="Position.Right" />

    <div class="cn-top">
      <span class="cn-badge">{{ badge }}</span>
      <span class="cn-total">{{ data.doc.total }} 项</span>
    </div>
    <div class="cn-name">{{ data.doc.name }}</div>
    <div class="cn-file">{{ data.doc.file }}</div>
    <div class="cn-methods">
      <code v-for="method in data.methods" :key="method">{{ method }}</code>
    </div>
    <div v-if="data.alt" class="cn-alt">或 {{ data.alt }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import type { ClassNodeData } from './class-map-data'

const props = defineProps<{ data: ClassNodeData }>()

const LAYER_LABEL: Record<string, string> = {
  panel: '交互层',
  contract: '契约层',
  backend: '渲染后端',
  core: '飞行内核',
  image: '影像链路',
}

const badge = computed(() => (props.data.doc.kind === 'factory' ? '工厂' : LAYER_LABEL[props.data.doc.layer]))
</script>

<style scoped lang="scss">
.cn {
  --layer: #8f7bff;
  --layer-soft: rgba(143, 123, 255, 0.16);

  width: 208px;
  padding: 10px 12px 11px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-left: 3px solid var(--layer);
  border-radius: 9px;
  background: #161a20;
  color: #e8ecf1;
  font:
    400 12px/1.5 system-ui,
    -apple-system,
    'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.35);

  &.is-panel {
    --layer: #8f7bff;
    --layer-soft: rgba(143, 123, 255, 0.16);
  }

  &.is-contract {
    --layer: #f0b429;
    --layer-soft: rgba(240, 180, 41, 0.14);
  }

  &.is-backend {
    --layer: #35c2d6;
    --layer-soft: rgba(53, 194, 214, 0.14);
  }

  &.is-core {
    --layer: #4ade80;
    --layer-soft: rgba(74, 222, 128, 0.14);
  }

  &.is-image {
    --layer: #f472b6;
    --layer-soft: rgba(244, 114, 182, 0.14);
  }
}

.cn-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.cn-badge {
  padding: 0 6px;
  border-radius: 4px;
  background: var(--layer-soft);
  color: var(--layer);
  font-size: 10.5px;
  font-weight: 500;
}

.cn-total {
  color: rgba(232, 236, 241, 0.3);
  font: 10.5px/1 ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
}

.cn-name {
  margin-top: 5px;
  color: #fff;
  font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.35;
  word-break: break-all;
}

.cn-file {
  color: rgba(232, 236, 241, 0.32);
  font: 10.5px/1.4 ui-monospace, monospace;
}

.cn-methods {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 7px;

  code {
    padding: 0 5px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.06);
    color: rgba(232, 236, 241, 0.78);
    font: 10.5px/17px ui-monospace, 'SFMono-Regular', Consolas, monospace;
  }
}

.cn-alt {
  margin-top: 6px;
  padding-top: 5px;
  border-top: 1px dashed rgba(255, 255, 255, 0.1);
  color: rgba(232, 236, 241, 0.4);
  font: 10.5px/1.4 ui-monospace, monospace;
}

:deep(.vue-flow__handle) {
  width: 7px;
  height: 7px;
  border: 1px solid #0f1216;
  background: var(--layer);
}
</style>
