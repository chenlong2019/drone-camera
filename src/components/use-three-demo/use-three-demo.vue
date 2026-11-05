<template>
  <div class="div-bg" ref="viewerRef">
    <!-- 顶部工具条:chip 排成一行,避免各自绝对定位后互相压。
           飞控源是**运行时切换**(内置模型 ⇄ PX4 / SITL),其余各自开各的功能 -->
    <div class="top-bar">
      <button
        class="ms-chip src-switch"
        :class="sourceTone"
        :disabled="sourceBusy"
        @click="onToggleSource"
      >
        <span class="ms-dot"></span>
        <span class="ms-name">{{ sourceName }}</span>
        <span class="ms-hint">{{ sourceHint }}</span>
      </button>
      <!-- 360° 全景:独立弹窗,可导入本地等距柱状全景图拖动环视 -->
      <button class="ms-chip pano-open" @click="onOpenPanorama">
        <span class="ms-dot pano-dot"></span>
        <span class="ms-name">360° 全景</span>
        <span class="ms-hint">查看 / 导入</span>
      </button>
      <!-- 3DGS:打开 splat 查看器(内置示例重建场景,可拖入 .ply / .splat) -->
      <button class="ms-chip splat-open" @click="onOpenSplat">
        <span class="ms-dot splat-dot"></span>
        <span class="ms-name">Splat 重建</span>
        <span class="ms-hint">查看 / 导入</span>
      </button>
      <!-- 重建采集:与全景相反的那一半 —— 光心必须移动,否则三角化退化。采完自动打开覆盖热力图 -->
      <button class="ms-chip recon-run" :disabled="reconBusy" @click="onReconCapture">
        <span class="ms-dot recon-dot"></span>
        <span class="ms-name">{{ reconBusy ? '重建采集中' : '重建采集' }}</span>
        <span class="ms-hint">{{ reconLabel || '环绕 2 圈' }}</span>
      </button>
      <!-- 导出 COLMAP:把采集会话的影像 + manifest + 三件套打成一个 zip。
           这是"浏览器采集"到"磁盘跑 COLMAP"之间唯一的一步:解压即可 feature_extractor -->
      <button class="ms-chip colmap-export" :disabled="colmapBusy" @click="onExportColmap">
        <span class="ms-dot colmap-dot"></span>
        <span class="ms-name">{{ colmapBusy ? '打包中' : '导出 COLMAP' }}</span>
        <span class="ms-hint">{{ colmapLabel || '影像 + 三件套' }}</span>
      </button>
      <!-- 时段切换:白天/黄昏/夜晚 —— 天空/海面/路灯/灯光一次切(uniform 改值,不掉帧不重编译) -->
      <button class="ms-chip phase-chip" :class="`phase-${dayPhase}`" @click="onCyclePhase">
        <span class="ms-dot"></span>
        <span class="ms-name">时段</span>
        <span class="ms-hint">{{ phaseName }}</span>
      </button>
      <!-- 图传同传:把机载画面推到局域网中转,手机开链接就能看(中转见 video-link/relay.mjs) -->
      <button class="ms-chip link-chip" :class="linkTone" @click="onToggleLink">
        <span class="ms-dot"></span>
        <span class="ms-name">图传</span>
        <span class="ms-hint">{{ linkHint }}</span>
      </button>
      <!-- 帧率角标:主渲染循环的实际帧率。图传模式对流畅度的影响(M-JPEG 抠图上屏 vs
           WebRTC 走合成器)在这里一眼可见,数字来自 rAF 间隔,与渲染循环同节奏 -->
      <div class="ms-chip fps-chip" :class="fpsTone">
        <span class="ms-dot"></span>
        <span class="ms-name">{{ fps }} fps</span>
      </div>
      <!-- 机体切换:机械哈士奇(库内置,零资产) ⇄ 真机 GLB。切换 = 销毁整个 DroneFly 后重建(见 switchBody) -->
      <button
        class="ms-chip model-switch"
        :class="{ 'is-husky': body === 'husky', 'is-busy': switching }"
        :disabled="switching"
        @click="onSwitchBody"
      >
        <span class="ms-dot"></span>
        <span class="ms-name">{{ body === 'husky' ? '哈士奇机体' : '真机模型' }}</span>
        <span class="ms-hint">{{ switching ? '切换中…' : '点击切换' }}</span>
      </button>
      <!-- 文档:站内使用文档页(操作说明 / 全景工作流 / 无头 MCP) -->
      <button class="ms-chip docs-open" @click="onOpenDocs">
        <span class="ms-dot docs-dot"></span>
        <span class="ms-name">文档</span>
        <span class="ms-hint">使用说明</span>
      </button>
    </div>
    <p v-if="error" class="ms-error">{{ error }}</p>
    <!-- 图传浮层:观看地址 + 实时统计。挂在顶栏下方居中,不挡右侧控制面板 -->
    <div v-if="linkOpen" class="vl-panel">
      <div class="vl-head">
        <span class="vl-title">图传同传</span>
        <span class="vl-state" :class="linkState.status">{{ linkStateText }}</span>
        <button class="vl-close" @click="linkOpen = false">关闭</button>
      </div>
      <div v-if="watchUrl" class="vl-url" @click="onCopyWatch">
        <span class="vl-url-text">{{ watchUrl }}</span>
        <span class="vl-copy">{{ copied ? '已复制' : '复制' }}</span>
      </div>
      <p v-else class="vl-tip">连上中转后这里会显示手机观看地址</p>
      <div class="vl-stats">
        <span><b>{{ linkState.viewers }}</b> 人在看</span>
        <span><b>{{ linkState.fps }}</b> fps</span>
        <span><b>{{ linkState.kbps }}</b> kbps</span>
        <span>已发 <b>{{ linkState.sentFrames }}</b> · 丢 <b>{{ linkState.droppedFrames }}</b></span>
      </div>
      <!-- 传输方式:M-JPEG 兼容一切;WebRTC 真编码省 3 倍带宽,失败观看端自动回 M-JPEG -->
      <div class="vl-src">
        <span class="vl-src-label">传输</span>
        <button :class="{ on: videoTransport === 'mjpeg' }" @click="onTransport('mjpeg')">
          M-JPEG
        </button>
        <button :class="{ on: videoTransport === 'webrtc' }" @click="onTransport('webrtc')">
          WebRTC
        </button>
      </div>
      <p class="vl-tip">
        {{
          videoTransport === 'webrtc'
            ? `P2P 编码推流,已连 ${linkState.webrtcViewers} 人。观看端不支持时自动回 M-JPEG;M-JPEG 降为 3 fps 保底。`
            : '每帧一张 JPEG,兼容性最好但费带宽。局域网追求低码率可切 WebRTC。'
        }}
      </p>
      <p v-if="videoTransport === 'webrtc' && linkState.webrtcStats.length" class="vl-rtc">
        <span v-for="stat in linkState.webrtcStats" :key="stat.id" class="vl-rtc-item">
          {{ stat.id }} · {{ stat.state }} · {{ stat.kbps }} kbps · {{ stat.fps }} fps
          <template v-if="stat.resolution"> · {{ stat.resolution }}</template>
          <template v-if="stat.rttMs !== null"> · {{ stat.rttMs }} ms</template>
          <template v-if="stat.packetsLost > 0"> · 丢 {{ stat.packetsLost }}</template>
          <template v-if="stat.limitation && stat.limitation !== 'none'"> · 受限:{{ stat.limitation }}</template>
        </span>
      </p>
      <!-- 画面来源:当前视角零开销;机载云台要多渲一帧,只在硬件 GPU 上才划算 -->
      <div class="vl-src">
        <span class="vl-src-label">画面来源</span>
        <button :class="{ on: videoSource === 'view' }" @click="onSource('view')">当前视角</button>
        <button :class="{ on: videoSource === 'gimbal' }" @click="onSource('gimbal')">
          机载云台
        </button>
      </div>
      <p class="vl-tip">
        {{
          videoSource === 'view'
            ? '传的就是这块屏幕；切到「机载视角」后即为云台画面，且零额外渲染开销。'
            : '每帧额外渲染一次云台取景，语义最接近真机图传，但会明显吃 GPU。'
        }}
      </p>
      <p class="vl-tip">
        手机与电脑连同一 WiFi 即可观看。没连上先启动中转：<code>npm run video:relay</code>
      </p>
      <p v-if="linkState.error" class="vl-error">{{ linkState.error }}</p>
    </div>
    <!-- 首帧加载覆盖层:机体 GLB(约14MB)下载完成前 canvas 没有画面,给一个明确的等待提示 -->
    <div v-if="loading" class="ms-boot">
      <span class="boot-ring"></span>
      <span class="boot-text">正在加载机体模型,首次访问约需 10~30 秒…</span>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { UseThreeDemo } from './use-three-demo'
import type { FlightSourceInfo } from './use-three-demo'
import type { VideoLinkState } from '@/lib'
import type { BayTimeOfDay } from './bay/bay-scenery'

const router = useRouter()

const viewerRef = ref<HTMLDivElement | null>(null)
let libDemo: UseThreeDemo | null = null

const body = ref<'husky' | 'glb'>('glb')
const switching = ref(false)
const error = ref('')
const loading = ref(true)

/**
 * 飞控源快照。默认内置模型;点顶部「内置飞控」按钮可运行时切到 PX4 / SITL,
 * 切换不重建机体、不刷新页面 —— 面板与鹰眼图只是换了个数据来源。
 */
const source = ref<FlightSourceInfo>({ kind: 'internal', url: null, status: null, error: null })
const sourceBusy = ref(false)

/**
 * 图传(视频同传)。默认关闭:推流会额外渲染一帧云台画面并编码 JPEG,
 * 不需要的人不该为此付出帧率。连上后中转会下发局域网观看地址。
 */
const idleLinkState: VideoLinkState = {
  status: 'idle',
  url: null,
  viewers: 0,
  fps: 0,
  kbps: 0,
  sentFrames: 0,
  droppedFrames: 0,
  watchUrls: [],
  error: null,
  webrtcEnabled: false,
  webrtcViewers: 0,
  webrtcStats: [],
}
const linkState = ref<VideoLinkState>({ ...idleLinkState })
const linkOpen = ref(false)
const linkBusy = ref(false)
const copied = ref(false)
const videoSource = ref<'view' | 'gimbal'>('view')
const videoTransport = ref<'mjpeg' | 'webrtc'>('mjpeg')

// ————— 时段切换:白天 → 黄昏 → 夜晚 循环 —————
// 场景侧全是 uniform 改值(天空/海面/路灯),灯光侧改直射光与环境漫射,均不触发管线重编译。
const PHASES: readonly BayTimeOfDay[] = ['day', 'dusk', 'night']
const dayPhase = ref<BayTimeOfDay>('day')
const phaseName = computed(
  () => ({ day: '白天', dusk: '黄昏', night: '夜晚' })[dayPhase.value],
)
function onCyclePhase(): void {
  const index = PHASES.indexOf(dayPhase.value)
  const next = PHASES[(index + 1) % PHASES.length] ?? 'day'
  dayPhase.value = libDemo?.setDayPhase(next) ?? next
}

// ————— 帧率角标:rAF 计数,1 s 滑动窗口 —————
// 场景每一帧都由宿主渲染循环在 rAF 里推进,所以 rAF 的节奏就是页面的真实帧率;
// M-JPEG 模式下每秒 15 次 JPEG 解码 + drawImage 会挤占同一帧,这里直接量化出来。
const fps = ref(0)
const fpsTone = computed(() => ({
  'fps-good': fps.value >= 50,
  'fps-mid': fps.value >= 30 && fps.value < 50,
  'fps-bad': fps.value > 0 && fps.value < 30,
}))
let fpsFrames = 0
let fpsWindowStart = 0
let fpsRaf = 0

function fpsLoop(now: number): void {
  if (fpsWindowStart === 0) fpsWindowStart = now
  fpsFrames += 1
  const elapsed = now - fpsWindowStart
  if (elapsed >= 1000) {
    fps.value = Math.round((fpsFrames * 1000) / elapsed)
    fpsFrames = 0
    fpsWindowStart = now
  }
  fpsRaf = requestAnimationFrame(fpsLoop)
}

function onSource(source: 'view' | 'gimbal'): void {
  videoSource.value = source
  libDemo?.setVideoSource(source)
}

function onTransport(mode: 'mjpeg' | 'webrtc'): void {
  const state = libDemo?.setVideoTransport(mode)
  if (state) {
    videoTransport.value = libDemo?.videoTransport ?? mode
    linkState.value = state
  }
}

const linkStateText = computed(() => {
  switch (linkState.value.status) {
    case 'live':
      return '推流中'
    case 'connecting':
      return '连接中转…'
    case 'error':
      return '连接失败'
    default:
      return '未开启'
  }
})

const linkHint = computed(() => {
  const state = linkState.value
  if (linkBusy.value) return '启动中…'
  if (state.status === 'live') return state.viewers > 0 ? `${state.viewers} 人在看` : '等待观看'
  if (state.status === 'connecting') return '连接中转…'
  if (state.status === 'error') return '中转未启动'
  return '手机同屏'
})

const linkTone = computed(() => ({
  'is-linked': linkState.value.status === 'live',
  'is-offline': linkState.value.status === 'error',
}))

/** 观看地址优先取与当前页面同主机的那个(中转会下发所有网卡地址) */
const watchUrl = computed(() => {
  const urls = linkState.value.watchUrls
  if (urls.length === 0) return ''
  const host = window.location.hostname
  return urls.find((url) => url.includes(`//${host}:`)) ?? urls[0]
})

async function onToggleLink(): Promise<void> {
  const demo = libDemo
  if (!demo || linkBusy.value) return
  // 已经开着 → 关掉;关掉后浮层也收起来,避免留一个空的地址框
  if (demo.videoLinkActive || linkState.value.status === 'error') {
    demo.stopVideoLink()
    linkOpen.value = false
    return
  }
  linkBusy.value = true
  linkOpen.value = true
  try {
    await demo.startVideoLink()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '图传连接失败'
    setTimeout(() => (error.value = ''), 6000)
  } finally {
    linkBusy.value = false
  }
}

async function onCopyWatch(): Promise<void> {
  if (!watchUrl.value) return
  try {
    await navigator.clipboard.writeText(watchUrl.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1600)
  } catch {
    // 非安全上下文(局域网 http)可能没有 clipboard 权限:退回选中文本,用户自己复制
    copied.value = false
  }
}

/** 外部链路是否真的在跳:connect 成功 ≠ 有心跳,得看最近一次心跳的年龄 */
function sourceLive(info: FlightSourceInfo): boolean {
  const status = info.status
  return info.kind === 'mavlink' && status?.connected === true && status.heartbeatAgeMs <= 3000
}

const sourceName = computed(() => {
  if (source.value.kind === 'internal') return '内置飞控'
  // 飞控自己报的自驾仪名(PX4 / ArduPilot / PX4 Autopilot …)
  return source.value.status?.autopilot || 'PX4 飞控'
})

const sourceHint = computed(() => {
  if (sourceBusy.value) return '连接中…'
  const info = source.value
  if (info.kind === 'internal') return '点击接入 PX4'
  const status = info.status
  if (!status) return '等待遥测…'
  if (!sourceLive(info)) return '链路断开'
  // 模式名与解锁状态都来自飞控,不是本地的挡位
  return status.armed ? `${status.mode} · 已解锁` : status.mode
})

const sourceTone = computed(() => ({
  'is-linked': sourceLive(source.value),
  'is-offline': source.value.kind === 'mavlink' && !sourceLive(source.value),
}))

onMounted(async () => {
  if (!viewerRef.value) return
  // 帧率计数尽早启动:加载阶段的帧率也有参考价值
  fpsRaf = requestAnimationFrame(fpsLoop)
  libDemo = new UseThreeDemo(viewerRef.value)
  const demo = libDemo
  demo.onBodyChange = (kind) => {
    body.value = kind
  }
  // 挂回调必须早于 init:init 里会按 ?mavlink= 决定初始飞控源并立即回报
  demo.onFlightSourceChange = (info) => {
    source.value = info
  }
  // 图传状态:连接 / 统计 / 报错都经这里回到界面
  demo.onVideoLinkChange = (state) => {
    linkState.value = state
    // ?rtc=1 或降级把传输方式改掉时,按钮高亮要跟着走
    videoTransport.value = demo.videoTransport
  }
  try {
    await demo.init()
  } finally {
    loading.value = false
  }
  // init 里会按 ?model=husky 决定初始机体,同步到按钮文案
  body.value = libDemo.currentBody
  // 文档页「打开 360° 全景」带 ?pano=1 跳过来:自动展开全景弹窗,免得用户再点一次
  if (new URLSearchParams(window.location.search).get('pano') === '1') {
    libDemo.openPanorama()
  }
  // ?link=1:打开页面即开始推流(验证脚本与"常驻图传"场景用,省掉一次点击)
  if (new URLSearchParams(window.location.search).get('link') === '1') {
    void onToggleLink()
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

/**
 * 切换飞控源。内置 → 外部时用桥接默认地址;外部 → 内置会把控制权交还 DroneSim
 * (空中交接会保持悬停,见库里的 detachExternalSource)。
 */
async function onToggleSource(): Promise<void> {
  if (!libDemo || sourceBusy.value) return
  sourceBusy.value = true
  error.value = ''
  try {
    if (source.value.kind === 'mavlink') await libDemo.setFlightSource('internal')
    else await libDemo.setFlightSource('mavlink')
  } catch (err) {
    // 库内部已回退到内置模型并回报错误,这里只把原因显示出来
    error.value = err instanceof Error ? `接入 PX4 失败：${err.message}` : '接入 PX4 失败'
    setTimeout(() => (error.value = ''), 6000)
  } finally {
    sourceBusy.value = false
  }
}

function onOpenPanorama(): void {
  libDemo?.openPanorama()
}

const reconBusy = ref(false)
const reconLabel = ref('')

function onReconCapture(): void {
  const demo = libDemo
  if (!demo || reconBusy.value) return
  reconBusy.value = true
  reconLabel.value = '规划中'
  demo.onReconProgress = (label) => {
    reconLabel.value = label
    reconBusy.value = demo.reconBusy
  }
  void demo.startReconCapture().finally(() => {
    reconBusy.value = false
  })
}

function onOpenSplat(): void {
  libDemo?.openSplat()
}

const colmapBusy = ref(false)
const colmapLabel = ref('')

/** 导出采集包:影像 + manifest + COLMAP 三件套 → 一个 zip(解压即可跑 feature_extractor) */
function onExportColmap(): void {
  const demo = libDemo
  if (!demo || colmapBusy.value) return
  colmapBusy.value = true
  colmapLabel.value = '打包中…'
  void demo
    .exportColmap()
    .then(() => {
      colmapLabel.value = demo.colmapLabel
    })
    .finally(() => {
      colmapBusy.value = false
    })
}

function onOpenDocs(): void {
  void router.push('/docs')
}

onUnmounted(() => {
  cancelAnimationFrame(fpsRaf)
  libDemo?.destroy()
})
</script>
<style lang="scss" scoped>
.div-bg {
  width: 100%;
  height: 100%;
  position: relative;
}

.top-bar {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 10px;
  // 窄屏时不换行挤压画面,改横向滚动(chip 总宽约 720px)
  max-width: calc(100% - 24px);
  overflow-x: auto;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

// 顶部 chip 的公共外观:四个按钮同一套骨架,靠指示灯颜色区分用途
.ms-chip {
  display: flex;
  flex: 0 0 auto;
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
}

// 帧率角标:不是按钮,关掉 hover 反馈免得让人想点;指示灯按流畅度分三档
.fps-chip {
  cursor: default;

  &:hover {
    background: rgba(18, 20, 24, 0.66);
    border-color: rgba(255, 255, 255, 0.18);
  }

  .ms-dot {
    background: #7d8894;
  }

  &.fps-good .ms-dot {
    background: #35d0a5;
  }

  &.fps-mid .ms-dot {
    background: #f2b33d;
  }

  &.fps-bad .ms-dot {
    background: #ef5b5b;
  }
}

// 飞控源:内置模型是蓝灯,外部链路通了转绿,断链转橙 —— 一眼看出画面是谁在驱动
.src-switch {
  &.is-linked .ms-dot {
    background: #3ddc97;
    box-shadow: 0 0 8px #3ddc97;
  }

  &.is-offline .ms-dot {
    background: #ff7a45;
    box-shadow: 0 0 8px #ff7a45;
  }
}

// 哈士奇机体:指示灯换暖橙,一眼分辨当前是哪种机体
.model-switch.is-husky .ms-dot {
  background: #ffb020;
  box-shadow: 0 0 8px #ffb020;
}

.model-switch.is-busy .ms-hint {
  color: #ffd666;
}

.ms-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #35c0ff;
  box-shadow: 0 0 8px #35c0ff;
}

.pano-dot {
  background: #8f7bff;
  box-shadow: 0 0 8px #8f7bff;
}

.docs-dot {
  background: #3ddc97;
  box-shadow: 0 0 8px #3ddc97;
}

.splat-dot {
  background: #ffb454;
  box-shadow: 0 0 8px #ffb454;
}

.recon-dot {
  background: #c084fc;
  box-shadow: 0 0 8px #c084fc;
}

// 青绿:与"文档"(绿)、"Splat"(橙)都区分开 —— 这条链是"落地成文件"
.colmap-dot {
  background: #2dd4bf;
  box-shadow: 0 0 8px #2dd4bf;
}

.recon-run:disabled {
  cursor: progress;
  opacity: 0.7;
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

// 图传 chip:推流中绿灯,连不上橙灯(与飞控源同一套灯语,不另造规则)
.link-chip {
  &.is-linked .ms-dot {
    background: #3ddc97;
    box-shadow: 0 0 8px #3ddc97;
  }

  &.is-offline .ms-dot {
    background: #ff7a45;
    box-shadow: 0 0 8px #ff7a45;
  }
}

// 时段 chip:白天金 / 黄昏橙 / 夜晚蓝紫(夜灯带一点辉光)
.phase-chip {
  &.phase-day .ms-dot {
    background: #ffd35c;
  }

  &.phase-dusk .ms-dot {
    background: #ff8c4a;
    box-shadow: 0 0 8px #ff8c4a;
  }

  &.phase-night .ms-dot {
    background: #7d8fe0;
    box-shadow: 0 0 8px #7d8fe0;
  }
}

// 图传浮层:顶栏下方居中,宽 360,窄屏自动收成 calc(100% - 24px)
.vl-panel {
  position: absolute;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 31;
  width: min(360px, calc(100% - 24px));
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 12px;
  background: rgba(16, 19, 24, 0.9);
  backdrop-filter: blur(12px);
  color: #e8ecf1;
  font:
    400 12px/1.6 system-ui,
    -apple-system,
    'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.42);
}

.vl-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;

  .vl-title {
    font-weight: 500;
    font-size: 13px;
  }

  .vl-state {
    flex: 1;
    color: #8f9aa6;

    &.live {
      color: #3ddc97;
    }

    &.error {
      color: #ff7a45;
    }
  }

  .vl-close {
    padding: 3px 8px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 7px;
    background: transparent;
    color: #c8d2dc;
    font-size: 11px;
    cursor: pointer;
  }
}

.vl-url {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid rgba(53, 192, 255, 0.32);
  background: rgba(53, 192, 255, 0.08);
  cursor: pointer;

  .vl-url-text {
    flex: 1;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 12px;
    color: #9fdcff;
    word-break: break-all;
  }

  .vl-copy {
    flex: 0 0 auto;
    font-size: 11px;
    color: #8f9aa6;
  }
}

.vl-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 9px 0 4px;
  color: #8f9aa6;

  b {
    color: #e8ecf1;
    font-weight: 500;
  }
}

.vl-tip {
  margin: 6px 0 0;
  color: #7d8894;
  font-size: 11px;
  line-height: 1.5;

  code {
    padding: 1px 4px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.08);
    font-size: 11px;
  }
}

// 传输切换与画面来源共用同一组按钮样式(vl-src),这里只加每端统计行
.vl-rtc {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 6px 0 0;
  color: #9fdcff;
  font-size: 11px;
  line-height: 1.5;

  .vl-rtc-item {
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    word-break: break-all;
  }
}

// 画面来源切换:两个按钮一组,选中态用青色描边走与主 chip 同一套语言
.vl-src {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  color: #8f9aa6;

  .vl-src-label {
    margin-right: 2px;
  }

  button {
    padding: 4px 9px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 7px;
    background: transparent;
    color: #b9c4cf;
    font-size: 11px;
    cursor: pointer;

    &.on {
      border-color: rgba(53, 192, 255, 0.6);
      background: rgba(53, 192, 255, 0.14);
      color: #9fdcff;
    }
  }
}

.vl-error {
  margin: 6px 0 0;
  color: #ff8a5c;
  font-size: 11px;
}
</style>
