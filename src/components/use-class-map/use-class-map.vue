<template>
  <div class="cm-page">
    <!-- 左侧索引：按层分组，点条目同时定位到画布节点 -->
    <aside class="cm-side">
      <p class="cm-brand">
        <span class="cm-brand-dot"></span>
        类与方法
      </p>

      <label class="cm-search">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M11.2 11.2 15 15M10.2 6.8a3.4 3.4 0 1 1-6.8 0 3.4 3.4 0 0 1 6.8 0Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        <input ref="searchInput" v-model="query" type="search" placeholder="类 / 方法 / 文件…" />
        <kbd v-if="!query">/</kbd>
      </label>

      <div class="cm-side-scroll">
        <template v-for="group in groupedClasses" :key="group.id">
          <p class="cm-group">
            <span class="cm-group-dot" :style="{ background: group.color }"></span>
            {{ group.label }}
            <em>{{ group.items.length }}</em>
          </p>
          <button
            v-for="cls in group.items"
            :key="cls.id"
            type="button"
            class="cm-side-item"
            :class="{ 'is-active': selectedId === cls.id }"
            @click="selectFromList(cls.id)"
          >
            <span class="cm-side-name">{{ cls.name }}</span>
            <span class="cm-side-count">{{ cls.total }}</span>
          </button>
        </template>
        <p v-if="!groupedClasses.length" class="cm-side-empty">没有匹配的类</p>
      </div>

      <div class="cm-side-actions">
        <button type="button" @click="goApi">API 参考</button>
        <button type="button" @click="goDemo">演示</button>
      </div>
    </aside>

    <main class="cm-main">
      <header class="cm-top">
        <div class="cm-top-text">
          <p class="cm-eyebrow">drone-camera · 类图 · Vue Flow</p>
          <h1 class="cm-title">类与方法调用图</h1>
          <p class="cm-sub">
            {{ CLASSES.length }} 个类 / 接口 · {{ TOTAL_MEMBERS }} 项公开成员 · {{ CHAINS.length }} 条链路 ·
            滚轮缩放、拖动节点、点击查看方法
          </p>
        </div>

        <div class="cm-top-right">
          <div class="cm-legend">
            <span v-for="layer in LAYERS" :key="layer.id">
              <i :style="{ background: layer.color }"></i>{{ layer.label }}
            </span>
          </div>
          <div class="cm-top-actions">
            <button type="button" @click="resetView">重置视图</button>
            <button type="button" @click="goApi">API 参考</button>
            <button type="button" class="is-primary" @click="goDemo">进入演示</button>
          </div>
        </div>
      </header>

      <div class="cm-canvas">
        <VueFlow
          :nodes="nodes"
          :edges="edges"
          :min-zoom="0.25"
          :max-zoom="1.6"
          :default-viewport="{ x: 0, y: 0, zoom: 0.8 }"
          fit-view-on-init
          :fit-view-on-init-options="{ padding: 0.08 }"
          :nodes-connectable="false"
          :edges-updatable="false"
          :elevate-nodes-on-select="false"
          default-marker-color="rgba(255, 255, 255, 0.3)"
          @node-click="onNodeClick"
          @pane-click="close"
        >
          <template #node-class="{ data }">
            <class-node :data="data" />
          </template>
          <template #node-lane="{ data }">
            <lane-node :data="data" />
          </template>

          <Background :gap="22" :size="1" pattern-color="#232830" />
          <Controls position="bottom-right" :show-interactive="false" />
          <MiniMap
            position="bottom-left"
            :node-color="miniMapColor"
            :node-stroke-width="0"
            mask-color="rgba(8, 10, 13, 0.74)"
            :width="168"
            :height="112"
            pannable
            zoomable
          />
        </VueFlow>
      </div>
    </main>

    <!-- 详情：挂 body，Esc / 点遮罩关闭 -->
    <Teleport to="body">
      <div v-if="current" class="cm-scrim" @click.self="close">
        <aside class="cm-sheet" role="dialog" aria-modal="true" :aria-label="current.name">
          <header class="cm-sheet-head">
            <span
              class="cm-badge"
              :style="{
                color: layerMeta(current.layer).color,
                background: `${layerMeta(current.layer).color}22`,
              }"
            >
              {{ current.kind === 'factory' ? '工厂' : layerMeta(current.layer).label }}
            </span>
            <button type="button" class="cm-close" aria-label="关闭" @click="close">×</button>
          </header>

          <h2 class="cm-sheet-name">{{ current.name }}</h2>
          <p class="cm-sheet-file">{{ current.file }} · {{ current.total }} 项公开成员</p>
          <p class="cm-sheet-role">{{ current.role }}</p>

          <h3 class="cm-sheet-h3">关键方法</h3>
          <div class="cm-sheet-methods">
            <code v-for="method in current.keyMethods" :key="method">{{ method }}</code>
          </div>

          <h3 class="cm-sheet-h3">为什么这样分层</h3>
          <p class="cm-sheet-body">{{ current.detail }}</p>

          <h3 class="cm-sheet-h3">出现在链路</h3>
          <ul class="cm-sheet-chains">
            <li v-for="chain in chainsOf(current.id)" :key="chain.id">
              {{ chain.title }}
              <span>{{ chain.subtitle }}</span>
            </li>
            <li v-if="!chainsOf(current.id).length" class="is-empty">
              作为实现细节被调用，不在四条主链路上单独成节点。
            </li>
          </ul>
        </aside>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import {
  MarkerType,
  VueFlow,
  useVueFlow,
  type Edge,
  type Node,
  type NodeMouseEvent,
} from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

import ClassNode from './class-node.vue'
import LaneNode from './lane-node.vue'
import {
  CHAINS,
  CLASSES,
  LAYERS,
  TOTAL_MEMBERS,
  type CanvasNodeData,
  type ChainDoc,
  type ClassDoc,
  type LayerId,
  type LayerMeta,
} from './class-map-data'

const router = useRouter()
const { fitView } = useVueFlow()

const query = ref('')
const selectedId = ref<string | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)

const LAYER_MAP = new Map<LayerId, LayerMeta>(LAYERS.map((layer) => [layer.id, layer]))
const FALLBACK_LAYER: LayerMeta = {
  id: 'panel',
  label: '交互层',
  color: '#8f7bff',
  desc: '原生 DOM / Canvas，框架无关',
}
const LANE_COLORS: Record<string, string> = {
  flight: '#8f7bff',
  mission: '#f0b429',
  capture: '#f472b6',
  engine: '#35c2d6',
}

function layerMeta(id: LayerId): LayerMeta {
  return LAYER_MAP.get(id) ?? FALLBACK_LAYER
}

/* ── 画布布局 ─────────────────────────────
   每条链路一条泳道，从左到右按调用顺序排列。
   坐标写死而不是自动布局：4 条链路是固定的叙事顺序，自动布局反而会打乱阅读方向。 */
const START_X = 172
const NODE_PITCH = 252
const LANE_HEIGHT = 206
const TOP_Y = 24

function nodeId(chain: ChainDoc, index: number): string {
  return `${chain.id}:${index}`
}

const nodes = shallowRef<Node<CanvasNodeData>[]>(buildNodes())
const edges = shallowRef<Edge[]>(buildEdges())

function buildNodes(): Node<CanvasNodeData>[] {
  const list: Node<CanvasNodeData>[] = []

  CHAINS.forEach((chain, laneIndex) => {
    const y = TOP_Y + laneIndex * LANE_HEIGHT
    list.push({
      id: `lane:${chain.id}`,
      type: 'lane',
      position: { x: 0, y },
      data: {
        kind: 'lane',
        title: chain.title,
        subtitle: chain.subtitle,
        note: chain.note,
        color: LANE_COLORS[chain.id] ?? '#8f7bff',
      },
      draggable: false,
      selectable: false,
      connectable: false,
    })

    chain.steps.forEach((step, index) => {
      const data: CanvasNodeData = {
        kind: 'class',
        doc: step.doc,
        methods: step.methods,
        ...(step.alt ? { alt: step.alt } : {}),
      }
      list.push({
        id: nodeId(chain, index),
        type: 'class',
        position: { x: START_X + index * NODE_PITCH, y },
        data,
        selectable: false,
      })
    })
  })

  return list
}

function buildEdges(): Edge[] {
  const list: Edge[] = []

  for (const chain of CHAINS) {
    for (let index = 0; index < chain.steps.length - 1; index += 1) {
      const from = chain.steps[index]
      const to = chain.steps[index + 1]
      if (!from || !to) continue

      list.push({
        id: `${chain.id}:e${index}`,
        source: nodeId(chain, index),
        target: nodeId(chain, index + 1),
        type: 'smoothstep',
        animated: true,
        markerEnd: MarkerType.ArrowClosed,
        style: { stroke: 'rgba(255, 255, 255, 0.22)', strokeWidth: 1.4 },
      })
    }
  }

  return list
}

/* ── 交互 ───────────────────────────────── */
function miniMapColor(node: { data?: CanvasNodeData }): string {
  const data = node.data
  return data?.kind === 'class' ? layerMeta(data.doc.layer).color : 'rgba(255, 255, 255, 0.12)'
}

function onNodeClick({ node }: NodeMouseEvent): void {
  const data = node.data as CanvasNodeData | undefined
  if (data?.kind === 'class') openClass(data.doc.id)
}

function openClass(classId: string): void {
  selectedId.value = classId
}

function close(): void {
  selectedId.value = null
}

function selectFromList(classId: string): void {
  openClass(classId)
  const matched = nodes.value.filter((node) => {
    const data: CanvasNodeData | undefined = node.data
    return data?.kind === 'class' && data.doc.id === classId
  })
  if (!matched.length) return
  void fitView({ nodes: matched.map((node) => node.id), padding: 1.4, duration: 350, maxZoom: 1 })
}

function resetView(): void {
  void fitView({ padding: 0.08, duration: 300 })
}

const current = computed<ClassDoc | null>(
  () => CLASSES.find((cls) => cls.id === selectedId.value) ?? null,
)

function matches(cls: ClassDoc): boolean {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return true
  return (
    cls.name.toLowerCase().includes(keyword) ||
    cls.file.toLowerCase().includes(keyword) ||
    cls.role.toLowerCase().includes(keyword) ||
    cls.keyMethods.some((method) => method.toLowerCase().includes(keyword))
  )
}

const groupedClasses = computed(() =>
  LAYERS.map((layer) => ({
    ...layer,
    items: CLASSES.filter((cls) => cls.layer === layer.id && matches(cls)),
  })).filter((group) => group.items.length > 0),
)

function chainsOf(classId: string) {
  return CHAINS.filter((chain) => chain.steps.some((step) => step.doc.id === classId))
}

function goApi(): void {
  void router.push('/api-docs')
}

function goDemo(): void {
  void router.push('/three-demo')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && selectedId.value) {
    event.preventDefault()
    close()
    return
  }
  if (event.key === '/' && !selectedId.value) {
    const el = searchInput.value
    if (el && document.activeElement !== el) {
      event.preventDefault()
      el.focus()
    }
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<style scoped lang="scss">
.cm-page {
  display: grid;
  grid-template-columns: 236px minmax(0, 1fr);
  width: 100%;
  height: 100vh;
  background: #0f1216;
  color: #e8ecf1;
  font:
    400 14px/1.7 system-ui,
    -apple-system,
    'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
}

/* ── 左栏 ───────────────────────────────── */
.cm-side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(18, 20, 24, 0.72);
}

.cm-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 20px 16px 12px;
  color: #fff;
  font-weight: 600;
  font-size: 15px;
}

.cm-brand-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #8f7bff;
}

.cm-search {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 12px 10px;
  padding: 6px 9px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: rgba(232, 236, 241, 0.45);

  svg {
    flex: 0 0 14px;
    width: 14px;
    height: 14px;
  }

  input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: #e8ecf1;
    font: inherit;
    font-size: 12.5px;
  }

  kbd {
    padding: 0 5px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    color: rgba(232, 236, 241, 0.4);
    font: 11px/16px ui-monospace, monospace;
  }
}

.cm-side-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 16px;
}

.cm-group {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 14px 0 4px;
  padding-left: 8px;
  color: rgba(232, 236, 241, 0.4);
  font-size: 11px;
  letter-spacing: 0.04em;

  em {
    margin-left: auto;
    padding-right: 6px;
    font-style: normal;
    font-variant-numeric: tabular-nums;
  }
}

.cm-group-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.cm-side-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: rgba(232, 236, 241, 0.66);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: rgba(255, 255, 255, 0.05);
    color: #e8ecf1;
  }

  &.is-active {
    background: rgba(143, 123, 255, 0.14);
    color: #cfc7ff;
  }
}

.cm-side-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cm-side-count {
  color: rgba(232, 236, 241, 0.3);
  font: 11px/1 ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
}

.cm-side-empty {
  padding: 12px;
  color: rgba(232, 236, 241, 0.35);
  font-size: 12.5px;
}

.cm-side-actions {
  display: flex;
  gap: 6px;
  padding: 10px 12px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);

  button {
    flex: 1;
    padding: 6px 0;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(232, 236, 241, 0.72);
    font: inherit;
    font-size: 12px;
    cursor: pointer;

    &:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
    }
  }
}

/* ── 主体 ───────────────────────────────── */
.cm-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.cm-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px 24px;
  padding: 18px 26px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.cm-eyebrow {
  margin: 0 0 4px;
  color: rgba(143, 123, 255, 0.85);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.cm-title {
  margin: 0;
  color: #fff;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.cm-sub {
  margin: 5px 0 0;
  color: rgba(232, 236, 241, 0.45);
  font-size: 12px;
}

.cm-top-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.cm-legend {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px 12px;

  span {
    color: rgba(232, 236, 241, 0.5);
    font-size: 11.5px;
    white-space: nowrap;
  }

  i {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 4px;
    border-radius: 50%;
    vertical-align: 1px;
  }
}

.cm-top-actions {
  display: flex;
  gap: 6px;

  button {
    padding: 4px 12px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 7px;
    background: transparent;
    color: rgba(232, 236, 241, 0.7);
    font: inherit;
    font-size: 12px;
    cursor: pointer;

    &:hover {
      border-color: rgba(255, 255, 255, 0.26);
      color: #fff;
    }

    &.is-primary {
      border-color: rgba(143, 123, 255, 0.5);
      background: rgba(143, 123, 255, 0.16);
      color: #d8d2ff;
    }
  }
}

.cm-canvas {
  position: relative;
  flex: 1;
  min-height: 0;
  background: #0f1216;
}

/* Vue Flow 主题覆盖：默认是浅色主题，这里整体改深色 */
.cm-canvas :deep(.vue-flow) {
  background: transparent;
}

.cm-canvas :deep(.vue-flow__edge-path) {
  stroke: rgba(255, 255, 255, 0.22);
}

.cm-canvas :deep(.vue-flow__edge.animated path) {
  stroke-dasharray: 5 4;
  animation: cm-dash 0.9s linear infinite;
}

@keyframes cm-dash {
  to {
    stroke-dashoffset: -18;
  }
}

.cm-canvas :deep(.vue-flow__edge-text) {
  fill: rgba(232, 236, 241, 0.55);
}

.cm-canvas :deep(.vue-flow__edge-textbg) {
  fill: #12151a;
}

.cm-canvas :deep(.vue-flow__controls) {
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  box-shadow: none;
}

.cm-canvas :deep(.vue-flow__controls-button) {
  width: 24px;
  height: 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  background: #171b21;

  svg {
    fill: rgba(232, 236, 241, 0.62);
  }

  &:hover {
    background: #20252d;
  }
}

.cm-canvas :deep(.vue-flow__minimap) {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(16, 19, 24, 0.9);
}

.cm-canvas :deep(.vue-flow__attribution) {
  display: none;
}

/* ── 详情弹层 ───────────────────────────── */
.cm-scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  justify-content: flex-end;
  background: rgba(0, 0, 0, 0.5);
}

.cm-sheet {
  width: min(430px, 92vw);
  height: 100%;
  overflow-y: auto;
  padding: 18px 22px 40px;
  border-left: 1px solid rgba(255, 255, 255, 0.1);
  background: #14171c;
  color: #e8ecf1;
  animation: cm-slide 0.18s ease-out;
}

@keyframes cm-slide {
  from {
    transform: translateX(24px);
    opacity: 0.4;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.cm-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.cm-badge {
  display: inline-block;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.02em;
}

.cm-close {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(232, 236, 241, 0.6);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;

  &:hover {
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
  }
}

.cm-sheet-name {
  margin: 12px 0 2px;
  color: #fff;
  font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace;
  font-size: 19px;
  font-weight: 600;
  line-height: 1.3;
  word-break: break-all;
}

.cm-sheet-file {
  margin: 0;
  color: rgba(232, 236, 241, 0.35);
  font: 11.5px/1.6 ui-monospace, monospace;
}

.cm-sheet-role {
  margin: 14px 0 0;
  color: rgba(232, 236, 241, 0.75);
  font-size: 13px;
}

.cm-sheet-h3 {
  margin: 22px 0 8px;
  color: rgba(232, 236, 241, 0.4);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
}

.cm-sheet-methods {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;

  code {
    padding: 2px 7px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.05);
    color: #cfd6de;
    font: 11.5px/1.6 ui-monospace, Consolas, monospace;
  }
}

.cm-sheet-body {
  margin: 0;
  color: rgba(232, 236, 241, 0.6);
  font-size: 12.5px;
}

.cm-sheet-chains {
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    padding: 8px 10px;
    margin-bottom: 6px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.03);
    font-size: 12.5px;
  }

  span {
    display: block;
    color: rgba(232, 236, 241, 0.35);
    font-size: 11.5px;
  }

  .is-empty {
    color: rgba(232, 236, 241, 0.35);
  }
}

@media (max-width: 1280px) {
  .cm-page {
    grid-template-columns: 1fr;
  }

  .cm-side {
    display: none;
  }

  .cm-top {
    padding: 16px 18px 12px;
  }
}
</style>
