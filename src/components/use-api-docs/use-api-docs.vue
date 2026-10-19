<template>
  <div class="api-page">
    <!-- 左侧粘性目录:按分层分组 -->
    <aside class="api-nav">
      <div class="api-nav-inner">
        <p class="api-brand">
          <span class="api-brand-dot"></span>
          API 参考
        </p>
        <template v-for="group in API_GROUPS" :key="group">
          <p class="api-nav-group">{{ group }}</p>
          <a
            v-for="mod in modulesByGroup[group]"
            :key="mod.id"
            class="api-nav-item"
            :class="{ 'is-active': activeId === mod.id }"
            :href="`#mod-${mod.id}`"
            @click.prevent="scrollTo(mod.id)"
          >
            <span class="api-nav-name">{{ mod.title.split(' · ')[0] }}</span>
            <span class="api-nav-count">{{ mod.items.length }}</span>
          </a>
        </template>
        <div class="api-nav-actions">
          <button type="button" class="api-nav-btn" @click="goDocs">← 使用文档</button>
          <button type="button" class="api-nav-btn" @click="goClassMap">类与方法</button>
          <RouterLink class="api-nav-btn" to="/photogrammetry-validation">摄影测量验证</RouterLink>
          <button type="button" class="api-nav-btn" @click="goDemo">进入演示 →</button>
        </div>
      </div>
    </aside>

    <!-- 右侧正文 -->
    <main class="api-main">
      <!-- 顶部固定搜索栏:页面长(793 成员),滚到任何位置都能直接搜 -->
      <div class="api-searchbar">
        <svg class="api-searchbar-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M11.2 11.2 15 15M10.2 6.8a3.4 3.4 0 1 1-6.8 0 3.4 3.4 0 0 1 6.8 0Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        <input
          ref="searchInput"
          v-model="query"
          type="search"
          class="api-search-input"
          placeholder="搜索类 / 接口 / 方法 / 常量,如 takeoff、CameraMode、sim…"
          @keydown.esc="query = ''"
        />
        <kbd v-if="!query" class="api-searchbar-kbd">/</kbd>
        <span v-else class="api-search-hint">{{ hitCount }} 项命中</span>
      </div>

      <header class="api-hero">
        <h1 class="api-title">drone-camera API 参考</h1>
        <p class="api-sub">
          全量公开 API,按 <code>index.ts</code> 分层组织。签名与说明自动提取自构建产物
          <code>drone-camera/lib/*.d.ts</code>,与源码严格一致。
        </p>
        <div class="api-stats">
          <span class="api-stat"><b>{{ API_MODULES.length }}</b> 模块</span>
          <span class="api-stat"><b>{{ totalItems }}</b> 导出项</span>
          <span class="api-stat"><b>{{ totalMembers }}</b> 成员</span>
        </div>
      </header>

      <p v-if="query && hitCount === 0" class="api-empty">没有命中「{{ query }}」的 API,换个关键词试试。</p>

      <template v-for="group in API_GROUPS" :key="group">
        <section v-for="mod in visibleModules(group)" :key="mod.id" :id="`mod-${mod.id}`" class="api-mod">
          <div class="api-mod-head">
            <h2 class="api-h2">{{ mod.title }}</h2>
            <code class="api-mod-file">src/lib/drone-camera/{{ mod.file }}.ts</code>
          </div>
          <p v-if="mod.doc" class="api-mod-doc" :class="{ 'is-clamped': !expandedDocs.has(mod.id) }" @click="toggleDoc(mod.id)">
            {{ mod.doc }}
          </p>

          <div v-for="item in visibleItems(mod)" :key="item.name + item.kind" class="api-item">
            <div class="api-item-head">
              <span class="api-kind" :style="kindStyle(item.kind)">{{ kindLabel(item.kind) }}</span>
              <span class="api-item-name">{{ item.name }}</span>
              <span v-if="item.members.length" class="api-item-count">{{ item.members.length }} 成员</span>
            </div>
            <pre v-if="item.signature" class="api-sig"><code>{{ item.signature }}</code></pre>
            <p v-if="item.doc" class="api-doc">{{ item.doc }}</p>
            <template v-if="item.members.length">
              <table class="api-table">
                <tbody>
                  <tr v-for="mem in item.members" :key="mem.kind + mem.name">
                    <td class="api-mem-kind" :style="memberKindStyle(mem.kind)">{{ memberKindLabel(mem.kind) }}</td>
                    <td class="api-mem-name">{{ mem.name }}</td>
                    <td class="api-mem-sig"><code>{{ mem.signature }}</code></td>
                    <td v-if="mem.doc" class="api-mem-doc" :title="mem.doc">{{ mem.doc }}</td>
                  </tr>
                </tbody>
              </table>
              <p class="api-members-foot">共 {{ item.members.length }} 个成员</p>
            </template>
          </div>
        </section>
      </template>

      <footer class="api-foot">
        <span>drone-camera · API 参考(自动生成)</span>
        <span>重新生成:npm run build:lib &amp;&amp; node tmp-shots/gen-api-docs.mjs</span>
      </footer>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { API_GROUPS, API_MODULES, type ApiItem, type ApiModule } from './api-data'

const router = useRouter()
const searchInput = ref<HTMLInputElement | null>(null)

const totalItems = computed(() => API_MODULES.reduce((n, m) => n + m.items.length, 0))
const totalMembers = computed(() => API_MODULES.reduce((n, m) => n + m.items.reduce((k, it) => k + it.members.length, 0), 0))

const modulesByGroup = computed(() => {
  const map: Record<string, ApiModule[]> = {}
  for (const g of API_GROUPS) map[g] = API_MODULES.filter((m) => m.group === g)
  return map
})

/** 搜索:项目名/签名/doc 命中即保留;有成员的类,成员也参与过滤 */
const query = ref('')
const q = computed(() => query.value.trim().toLowerCase())

function itemMatches(item: ApiItem): boolean {
  if (!q.value) return true
  if (item.name.toLowerCase().includes(q.value)) return true
  if (item.signature.toLowerCase().includes(q.value)) return true
  if (item.doc.toLowerCase().includes(q.value)) return true
  return item.members.some((m) => m.name.toLowerCase().includes(q.value) || m.signature.toLowerCase().includes(q.value))
}

function visibleItems(mod: ApiModule): ApiItem[] {
  const items = mod.items.filter(itemMatches)
  // 有搜索词时,成员表只留命中项
  if (!q.value) return items
  return items.map((it) => {
    if (!it.members.length) return it
    const members = it.members.filter((m) => m.name.toLowerCase().includes(q.value) || m.signature.toLowerCase().includes(q.value))
    return members.length ? { ...it, members } : { ...it, members: [] }
  })
}

function visibleModules(group: string): ApiModule[] {
  const mods = modulesByGroup.value[group] ?? []
  if (!q.value) return mods
  return mods.filter((m) => visibleItems(m).length > 0 || m.title.toLowerCase().includes(q.value))
}

const hitCount = computed(() => API_MODULES.reduce((n, m) => n + visibleItems(m).length, 0))

const KIND_COLORS: Record<string, string> = {
  class: '#35c0ff',
  interface: '#8f7bff',
  function: '#3ddc97',
  const: '#ffb020',
  type: '#ff6b8b',
  enum: '#4dd0e1',
}
const KIND_LABELS: Record<string, string> = {
  class: '类',
  interface: '接口',
  function: '函数',
  const: '常量',
  type: '类型',
  enum: '枚举',
}
function kindStyle(kind: string) {
  return { background: `${KIND_COLORS[kind] ?? '#9aa4b0'}22`, color: KIND_COLORS[kind] ?? '#9aa4b0' }
}
function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

const MEMBER_COLORS: Record<string, string> = {
  method: '#3ddc97',
  property: '#9fd8ff',
  getter: '#ffb020',
  setter: '#ff8a65',
}
const MEMBER_LABELS: Record<string, string> = {
  method: '方法',
  property: '属性',
  getter: 'get',
  setter: 'set',
}
function memberKindStyle(kind: string) {
  return { color: MEMBER_COLORS[kind] ?? '#9aa4b0' }
}
function memberKindLabel(kind: string): string {
  return MEMBER_LABELS[kind] ?? kind
}

/** 模块长描述默认 3 行截断,点击展开 */
const expandedDocs = ref<Set<string>>(new Set())
function toggleDoc(id: string): void {
  const next = new Set(expandedDocs.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedDocs.value = next
}

/** 目录滚动高亮(固定搜索栏高 ~56px,阈值避开它) */
const activeId = ref<string>(API_MODULES[0]?.id ?? '')
function onScroll(): void {
  let current = API_MODULES[0]?.id ?? ''
  for (const mod of API_MODULES) {
    const el = document.getElementById(`mod-${mod.id}`)
    if (el && el.getBoundingClientRect().top <= 100) current = mod.id
  }
  activeId.value = current
}
function scrollTo(id: string): void {
  const el = document.getElementById(`mod-${id}`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  activeId.value = id
}

/** 按 / 快捷聚焦搜索框(输入框已聚焦时不劫持) */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
  const el = document.activeElement
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
  event.preventDefault()
  searchInput.value?.focus()
}

function goDocs(): void {
  void router.push('/docs')
}
function goDemo(): void {
  void router.push('/three-demo')
}

function goClassMap(): void {
  void router.push('/class-map')
}

onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('keydown', onKeydown)
  onScroll()
})
onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped lang="scss">
.api-page {
  display: flex;
  width: 100%;
  min-height: 100vh;
  background: #0f1216;
  color: #e8ecf1;
  font:
    400 14px/1.7 system-ui,
    -apple-system,
    'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
}

/* ── 左侧目录 ───────────────────────── */
.api-nav {
  position: sticky;
  top: 0;
  flex: 0 0 216px;
  height: 100vh;
  overflow-y: auto;
  border-right: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(18, 20, 24, 0.6);
}

.api-nav-inner {
  display: flex;
  flex-direction: column;
  padding: 20px 12px;
}

.api-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  padding-left: 6px;
  color: #fff;
  font-weight: 700;
  font-size: 15px;
}

.api-brand-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #8f7bff;
  box-shadow: 0 0 8px #8f7bff;
}

.api-nav-group {
  margin: 12px 0 4px;
  padding-left: 8px;
  color: rgba(232, 236, 241, 0.38);
  font-size: 11px;
  letter-spacing: 0.05em;
}

.api-nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 7px;
  border-left: 2px solid transparent;
  color: rgba(232, 236, 241, 0.62);
  font-size: 12.5px;
  text-decoration: none;
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s;

  &:hover {
    color: #e8ecf1;
    background: rgba(255, 255, 255, 0.05);
  }

  &.is-active {
    color: #b9a7ff;
    border-left-color: #8f7bff;
    background: rgba(143, 123, 255, 0.1);
  }
}

.api-nav-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.api-nav-count {
  flex: none;
  padding: 0 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(232, 236, 241, 0.5);
  font-size: 10.5px;
}

.api-nav-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 18px;
}

.api-nav-btn {
  padding: 7px 12px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  color: #e8ecf1;
  font:
    500 12.5px/1 system-ui,
    -apple-system,
    'Microsoft YaHei',
    sans-serif;
  cursor: pointer;

  &:hover {
    border-color: rgba(255, 255, 255, 0.32);
    background: rgba(255, 255, 255, 0.09);
  }
}

/* ── 右侧正文 ───────────────────────── */
.api-main {
  flex: 1;
  min-width: 0;
  max-width: 1020px;
  margin: 0 auto;
  padding: 40px 40px 60px;
}

.api-hero {
  padding: 26px 30px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  background:
    radial-gradient(1200px 300px at 20% -80px, rgba(143, 123, 255, 0.16), transparent 60%),
    rgba(255, 255, 255, 0.03);
}

.api-title {
  margin: 0 0 8px;
  font-size: 24px;
}

.api-sub {
  margin: 0;
  max-width: 760px;
  color: rgba(232, 236, 241, 0.72);
  font-size: 13.5px;
}

.api-stats {
  display: flex;
  gap: 18px;
  margin-top: 14px;
}

.api-stat {
  color: rgba(232, 236, 241, 0.55);
  font-size: 12.5px;

  b {
    margin-right: 3px;
    color: #fff;
    font-size: 16px;
  }
}

/* ── 顶部 sticky 搜索栏:与正文同宽同对齐,滚到任何位置都吸在顶部 ───────────────────────── */
.api-searchbar {
  position: sticky;
  top: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 56px;
  margin: 0 -40px 18px;
  padding: 0 40px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(15, 18, 22, 0.88);
  backdrop-filter: blur(12px);
}

.api-searchbar-icon {
  flex: none;
  width: 15px;
  height: 15px;
  color: rgba(232, 236, 241, 0.5);
}

.api-search-input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  padding: 9px 14px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.07);
  color: #e8ecf1;
  font:
    400 13.5px/1.4 system-ui,
    -apple-system,
    'Microsoft YaHei',
    sans-serif;
  outline: none;

  &::placeholder {
    color: rgba(232, 236, 241, 0.4);
  }

  &:focus {
    border-color: rgba(143, 123, 255, 0.65);
    background: rgba(0, 0, 0, 0.35);
    box-shadow: 0 0 0 3px rgba(143, 123, 255, 0.14);
  }

  // 去掉浏览器 search 输入框自带的清除按钮(我们有 esc 清空 + 命中计数)
  &::-webkit-search-cancel-button {
    display: none;
  }
}

.api-searchbar-kbd {
  flex: none;
}

.api-search-hint {
  flex: none;
  color: rgba(232, 236, 241, 0.45);
  font-size: 12px;
  white-space: nowrap;
}

.api-empty {
  margin: 40px 0;
  color: rgba(232, 236, 241, 0.5);
  text-align: center;
}

/* ── 模块节 ───────────────────────── */
.api-mod {
  margin-top: 40px;
  scroll-margin-top: 96px;
}

.api-mod-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.api-h2 {
  margin: 0;
  font-size: 18px;
}

.api-mod-file {
  color: rgba(232, 236, 241, 0.35);
  font-size: 11.5px;
}

.api-mod-doc {
  margin: 10px 0 0;
  color: rgba(232, 236, 241, 0.6);
  font-size: 13px;
  cursor: pointer;

  &.is-clamped {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;

    &:hover {
      color: rgba(232, 236, 241, 0.8);
    }
  }
}

/* ── 导出项卡片 ───────────────────────── */
.api-item {
  margin-top: 14px;
  padding: 14px 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
}

.api-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.api-kind {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}

.api-item-name {
  color: #fff;
  font:
    600 14.5px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}

.api-item-count {
  margin-left: auto;
  color: rgba(232, 236, 241, 0.4);
  font-size: 11.5px;
}

.api-sig {
  margin: 8px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.32);
  color: #c9e6ff;
  font:
    400 12px/1.7 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  white-space: pre-wrap;
  word-break: break-all;

  code {
    background: none;
    color: inherit;
    padding: 0;
  }
}

.api-doc {
  margin: 8px 0 0;
  color: rgba(232, 236, 241, 0.66);
  font-size: 12.5px;
}

/* ── 成员表 ───────────────────────── */
.api-table {
  width: 100%;
  margin-top: 10px;
  border-collapse: collapse;
  font-size: 12px;

  td {
    padding: 4px 8px 4px 0;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    vertical-align: top;
  }

  tr:first-child td {
    border-top: none;
  }
}

.api-mem-kind {
  white-space: nowrap;
  font-weight: 600;
  font-size: 11px;
}

.api-mem-name {
  white-space: nowrap;
  color: #fff;
  font:
    500 12px/1.5 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}

.api-mem-sig {
  code {
    color: #9fd8ff;
    font:
      400 11.5px/1.5 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
    word-break: break-all;
  }
}

.api-mem-doc {
  max-width: 220px;
  overflow: hidden;
  color: rgba(232, 236, 241, 0.45);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.api-members-foot {
  margin: 6px 0 0;
  color: rgba(232, 236, 241, 0.3);
  font-size: 11px;
}

.api-foot {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 48px;
  padding-top: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  color: rgba(232, 236, 241, 0.4);
  font-size: 12px;
}

code {
  padding: 1px 5px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.07);
  color: #9fd8ff;
  font:
    400 12.5px/1.5 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}

@media (max-width: 860px) {
  .api-page {
    flex-direction: column;
  }

  .api-nav {
    position: static;
    flex: none;
    height: auto;
    max-height: 40vh;
    border-right: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  }

  .api-nav-actions {
    flex-direction: row;
  }

  .api-main {
    padding: 24px 18px 40px;
  }

  .api-searchbar {
    margin: 0 -18px 16px;
    padding: 0 18px;
  }
}
</style>
