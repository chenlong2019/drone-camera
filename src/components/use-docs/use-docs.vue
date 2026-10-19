<template>
  <div class="docs-page">
    <!-- 左侧粘性目录 -->
    <aside class="docs-nav">
      <div class="docs-nav-inner">
        <p class="docs-brand">
          <span class="docs-brand-dot"></span>
          drone-camera
        </p>
        <a
          v-for="item in sections"
          :key="item.id"
          class="docs-nav-item"
          :class="{ 'is-active': activeId === item.id }"
          :href="`#${item.id}`"
          @click.prevent="scrollTo(item.id)"
        >
          {{ item.label }}
        </a>
        <a class="docs-nav-item docs-nav-api" @click="goApiDocs">API 参考</a>
        <a class="docs-nav-item docs-nav-api" @click="goClassMap">类与方法</a>
        <button type="button" class="docs-back" @click="onBack">
          <span class="docs-back-arrow">←</span>
          返回演示
        </button>
      </div>
    </aside>

    <!-- 右侧正文 -->
    <main class="docs-main">
      <header class="docs-hero">
        <h1 class="docs-title">无人机控制系统 · 使用文档</h1>
        <p class="docs-sub">
          <code>drone-camera</code> 是一个框架无关的无人机控制与航拍库:三维仿真飞行、双渲染后端
          (three / Cesium)、360° 全景拍摄合成与球面查看,并提供无头 CLI 与 MCP 服务供 AI 调用。
        </p>
        <div class="docs-hero-actions">
          <button type="button" class="docs-btn is-primary" @click="goDemo">进入演示</button>
          <button type="button" class="docs-btn" @click="goPanorama">打开 360° 全景</button>
          <button type="button" class="docs-btn" @click="goApiDocs">API 参考</button>
        </div>
      </header>

      <!-- ① 简介 -->
      <section id="intro" class="docs-section">
        <h2 class="docs-h2">简介</h2>
        <div class="docs-grid docs-grid-2">
          <div class="docs-card">
            <h3 class="docs-h3">库定位</h3>
            <ul class="docs-list">
              <li>源码扁平在 <code>src/lib/drone-camera/*.ts</code>,入口 <code>src/lib/index.ts</code>,不依赖 Vue</li>
              <li><code>three</code> 为 peerDependency,消费方自装,避免同页两份 three 实例</li>
              <li>控制面板 / 航线编辑 / 鹰眼图全部原生 DOM + Canvas 2D,任意框架可用</li>
            </ul>
          </div>
          <div class="docs-card">
            <h3 class="docs-h3">双渲染后端</h3>
            <ul class="docs-list">
              <li><code>createDroneControl({ engine: 'three' })</code> —— 默认,本地三维场景</li>
              <li><code>createDroneControl({ engine: 'cesium' })</code> —— 地球级场景(CesiumJS)</li>
              <li>两者实现同一 <code>DronePanelHost</code> / <code>MissionPanelHost</code> 接口,面板 / 航线 / 键盘零改动切换</li>
            </ul>
          </div>
        </div>
      </section>

      <!-- ② 快速开始 -->
      <section id="quickstart" class="docs-section">
        <h2 class="docs-h2">快速开始</h2>
        <p class="docs-p">安装后三行接入:创建后端、挂控制面板、按需开航线与鹰眼图。</p>
        <pre class="docs-code"><code>import { createDroneControl, DroneControlPanel, DroneMiniMap } from 'drone-camera'

// 1. 创建渲染后端(engine: 'three' | 'cesium')
const host = createDroneControl({
  engine: 'three',
  container: document.getElementById('viewer')!,
  modelUrl: '', // 空 = 库内置机械哈士奇机体;传 GLB 地址则加载真机模型
})

// 2. 控制面板(框架无关,挂到任意容器)
const panel = new DroneControlPanel(host, { adaptive: true, keyboard: true })

// 3. 鹰眼图(可选:只读真值 + Canvas 2D,与三维渲染解耦)
const minimap = new DroneMiniMap(host, { position: 'bottom-center' })</code></pre>
        <p class="docs-p docs-p-dim">
          销毁时按创建逆序调用各对象 <code>destroy()</code> 即可;面板弹出层挂
          <code>document.body</code>,不受宿主容器裁剪影响。
        </p>
      </section>

      <!-- ③ 功能特性 -->
      <section id="features" class="docs-section">
        <h2 class="docs-h2">功能特性</h2>
        <div class="docs-grid docs-grid-3">
          <div v-for="f in features" :key="f.name" class="docs-card docs-card-feature">
            <span class="docs-feature-dot" :style="{ background: f.color, boxShadow: `0 0 8px ${f.color}` }"></span>
            <h3 class="docs-h3">{{ f.name }}</h3>
            <p class="docs-card-p">{{ f.desc }}</p>
          </div>
        </div>
      </section>

      <!-- ④ 操作说明 -->
      <section id="controls" class="docs-section">
        <h2 class="docs-h2">操作说明</h2>
        <div class="docs-grid docs-grid-2">
          <div class="docs-card">
            <h3 class="docs-h3">遥控器(屏幕摇杆)</h3>
            <p class="docs-card-p">
              王者荣耀式 HUD:左右轮盘悬浮在画面下方,不占用取景区域。DJI 美国手 Mode 2:
            </p>
            <ul class="docs-list">
              <li><b>左杆</b>:上下 = 油门(升降),左右 = 偏航(机头转向)</li>
              <li><b>右杆</b>:上下 = 俯仰(前后),左右 = 横滚(左右平移)</li>
              <li><b>技能钮</b>:悬浮右轮盘上方,拍照 / 录像,角标显示张数与秒数</li>
            </ul>
            <p class="docs-card-p docs-p-dim">
              手感三旋钮:死区(垂直 6% / 横滚偏航 14%)→ Expo(0.55),中位变钝、满舵仍满行程;偏航角速度默认
              0.6 倍输出,屏幕观感更稳。
            </p>
          </div>
          <div class="docs-card">
            <h3 class="docs-h3">键盘</h3>
            <table class="docs-table">
              <thead>
                <tr><th>按键</th><th>功能</th></tr>
              </thead>
              <tbody>
                <tr v-for="k in keys" :key="k.key"><td><kbd>{{ k.key }}</kbd></td><td>{{ k.desc }}</td></tr>
              </tbody>
            </table>
            <p class="docs-card-p docs-p-dim">
              键盘与摇杆同时操作时<b>摇杆优先</b>;60Hz 渐推渐回,窗口失焦自动松杆。
            </p>
          </div>
        </div>
        <div class="docs-card docs-card-wide">
          <h3 class="docs-h3">相机模式</h3>
          <div class="docs-grid docs-grid-3">
            <div class="docs-mini">
              <b>orbit</b>
              <span>轨道环绕:控制点跟随机体,拖动旋转 / 滚轮缩放</span>
            </div>
            <div class="docs-mini">
              <b>follow</b>
              <span>跟随:机位相对机体固定,看飞机机动姿态</span>
            </div>
            <div class="docs-mini">
              <b>fpv</b>
              <span>机载视角:相机绑定云台光轴,所见即所拍</span>
            </div>
          </div>
        </div>
      </section>

      <!-- ⑤ 全景工作流 -->
      <section id="panorama" class="docs-section">
        <h2 class="docs-h2">360° 全景工作流</h2>
        <ol class="docs-steps">
          <li v-for="(s, i) in panoSteps" :key="i" class="docs-step">
            <span class="docs-step-no">{{ i + 1 }}</span>
            <div>
              <b>{{ s.title }}</b>
              <p class="docs-card-p">{{ s.desc }}</p>
            </div>
          </li>
        </ol>
        <div class="docs-card docs-card-wide">
          <h3 class="docs-h3">球面查看器</h3>
          <ul class="docs-list">
            <li>球形 360° 合成结果为 <b>3600 × 1800(2:1)</b> 等距柱状图;广角与 180° 按局部覆盖范围输出</li>
            <li>滚轮 / 双指捏合缩放视野,方向键微调 ±5°(Shift 加速),双击或 <kbd>0</kbd> 复位</li>
            <li>支持<b>导入本地全景图</b>:任意 2:1 长条(如大疆实拍图)即可环视;关闭后重开不丢图</li>
            <li>纯手写 WebGL,零依赖;不支持 WebGL 时自动回退为平面图</li>
          </ul>
        </div>
      </section>

      <!-- ⑥ 无头模式与 MCP -->
      <section id="headless" class="docs-section">
        <h2 class="docs-h2">无头模式与 MCP</h2>
        <p class="docs-p">
          渲染管线藏进无头驱动(按需拉起 vite + Chromium,命令串行,空闲 10 分钟自动回收),外面包了
          Blender 式 CLI 与 MCP 服务,AI 可以直接驱动整条拍摄链路。
        </p>
        <div class="docs-grid docs-grid-2">
          <div class="docs-card">
            <h3 class="docs-h3">CLI(Blender 式)</h3>
            <pre class="docs-code"><code># 单命令:单行 JSON 走 stdout,日志走 stderr
node mcp/drone-cli.mjs state
node mcp/drone-cli.mjs takeoff
node mcp/drone-cli.mjs panorama --mode pano-360

# 批处理:steps 顺序执行,失败中止
node mcp/drone-cli.mjs run task.json</code></pre>
          </div>
          <div class="docs-card">
            <h3 class="docs-h3">MCP(供 AI 调用)</h3>
            <ul class="docs-list">
              <li>stdio JSON-RPC 服务:<code>mcp/drone-mcp-server.mjs</code></li>
              <li>14 个 <code>drone_*</code> 工具:state / takeoff / land / return_home / spin_to / capture_photo / panorama / screenshot / viewer_shot …</li>
              <li>截图类工具<b>直接以图片返回</b>,AI 能"看见"渲染结果</li>
              <li>已注册到 <code>~/.workbuddy/mcp.json</code>,首次使用需在连接器页点「信任」</li>
            </ul>
          </div>
        </div>
        <pre class="docs-code"><code>// task.json 示例:AI 可生成这样的任务序列
{
  "steps": [
    { "cmd": "takeoff" },
    { "cmd": "panorama", "mode": "pano-360" },
    { "cmd": "viewer_shot", "file": "&lt;上一步产物&gt;", "yaw": 120, "pitch": -10, "fov": 90 },
    { "cmd": "land" }
  ]
}</code></pre>
      </section>

      <!-- ⑦ FAQ -->
      <section id="faq" class="docs-section">
        <h2 class="docs-h2">常见问题</h2>
        <div class="docs-card docs-card-wide">
          <div v-for="(q, i) in faqs" :key="i" class="docs-faq">
            <p class="docs-faq-q">Q:{{ q.q }}</p>
            <p class="docs-faq-a">A:{{ q.a }}</p>
          </div>
        </div>
      </section>

      <footer class="docs-foot">
        <span>drone-camera · demo 文档页</span>
        <span>快捷键 <kbd>0</kbd> 可在演示页复位视角</span>
      </footer>
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

interface SectionItem {
  id: string
  label: string
}

const sections: SectionItem[] = [
  { id: 'intro', label: '简介' },
  { id: 'quickstart', label: '快速开始' },
  { id: 'features', label: '功能特性' },
  { id: 'controls', label: '操作说明' },
  { id: 'panorama', label: '全景工作流' },
  { id: 'headless', label: '无头模式与 MCP' },
  { id: 'faq', label: '常见问题' },
]

const activeId = ref<string>(sections[0]?.id ?? '')

/** 滚动监听:离视口顶部最近的一节高亮 */
function onScroll(): void {
  let current = sections[0]?.id ?? ''
  for (const item of sections) {
    const el = document.getElementById(item.id)
    if (el && el.getBoundingClientRect().top <= 120) current = item.id
  }
  activeId.value = current
}

function scrollTo(id: string): void {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  activeId.value = id
}

function goDemo(): void {
  void router.push('/three-demo')
}

function goPanorama(): void {
  void router.push('/three-demo?pano=1')
}

function goApiDocs(): void {
  void router.push('/api-docs')
}

function goClassMap(): void {
  void router.push('/class-map')
}

function onBack(): void {
  void router.push('/three-demo')
}

onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()
})

onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
})

const features = [
  {
    name: '飞行控制',
    desc: '飞控仿真:起降 / 返航 / 姿态解算 / 触地配平,摇杆与键盘两套输入,手感带死区与 Expo 曲线。',
    color: '#35c0ff',
  },
  {
    name: '双渲染后端',
    desc: 'three 与 Cesium 实现同一宿主接口,面板 / 航线 / 鹰眼图 / 键盘不挑后端,一行 engine 切换。',
    color: '#8f7bff',
  },
  {
    name: '云台稳像',
    desc: 'full 档相机姿态零骨骼链依赖,FPV 画面稳如电子增稳;physical 档保留机械滞后与画弧真实感。',
    color: '#3ddc97',
  },
  {
    name: '拍照 / 录像',
    desc: '拍照走云台取景帧合成,自动隐藏场景标记;录像为独立离屏画布抓帧,不录到用户视角。',
    color: '#ffb020',
  },
  {
    name: '广角拍摄',
    desc: '3×3 网格拍摄 9 张并按实际覆盖范围拼接为局部等距柱状图,可拖动查看广角画面。',
    color: '#ffcf5a',
  },
  {
    name: '360° 全景',
    desc: '按相机垂直视场自动计算俯仰环拍层数,8 方位逐层拍摄并补天顶/天底;张数随相机视场变化,按位姿拼接为 3600×1800 等距柱状图。',
    color: '#ff6b8b',
  },
  {
    name: '球面查看器',
    desc: '手写 WebGL 反投影渲染,拖动环视 / 缩放 / 复位,支持导入本地全景图,零依赖。',
    color: '#4dd0e1',
  },
  {
    name: '鹰眼图',
    desc: 'Canvas 2D 俯视 HUD:机体 / 航迹 / 障碍物 / 返航点 / 视锥扇形,自驱重绘不抢鼠标。',
    color: '#b0bec5',
  },
  {
    name: '避障仿真',
    desc: '障碍物 AABB 登记进飞控,靠近触发刹停;鹰眼图同步画出轮廓,碰撞盒可运行时增删。',
    color: '#ff8a65',
  },
  {
    name: '任务航线',
    desc: '航线面板编辑航点与参数,一键执行;场景内编辑双后端可用:three 里拖三维航点,Cesium 里拖地球上的实体航点(双击插入 / Shift 改高 / 框住航线)。',
    color: '#9ccc65',
  },
]

const keys = [
  { key: 'W / S', desc: '俯仰:前 / 后' },
  { key: 'A / D', desc: '横滚:左移 / 右移' },
  { key: '↑ / ↓', desc: '油门:上升 / 下降' },
  { key: '← / →', desc: '偏航:左转 / 右转(同 Q / E)' },
  { key: '0', desc: '视角复位(查看器内同样有效)' },
  { key: 'Esc', desc: '关闭最上层弹窗' },
]

const panoSteps = [
  { title: '起飞悬停', desc: '在演示页点击起飞,等 phase 变为 flying 且高度稳定,保证拼接假设成立。' },
  { title: '选择广角或 180°', desc: '广角拍摄 3×3 共 9 张;180° 使用 7 方位 × 3 俯仰共 21 张,结果按局部投影显示,不会伪装成整球。' },
  { title: '发起球形拍摄', desc: '面板「360° 全景」按 8 个方位拍摄五层环拍,俯仰每隔 30° 一张,再补拍天顶与天底,降低层间空带。' },
  { title: '自动拼接', desc: '按每张的机体航向与俯仰真值反投影,重叠区羽化融合;球形 360° 输出 3600×1800,其他模式按覆盖范围输出。' },
  { title: '全景查看', desc: '结果落入影像集,点「360° 环视」拖动查看;球形图环绕首尾,广角/180° 保持局部视场。也可导入本地 2:1 球面全景图。' },
]

const faqs = [
  {
    q: '页面控制台报 does not provide an export named … ?',
    a: '浏览器标签页打开早于改动,HMR 模块图不一致。硬刷新(Ctrl+Shift+R)即可,不必重启 dev server。',
  },
  {
    q: '合成图边缘是弧形 / 不全?',
    a: '等距柱状投影的固有形状;未覆盖区域按实拍占比填充边缘(coverage 字段),天顶天底用最近邻列补齐。',
  },
  {
    q: '无头模式会残留进程吗?',
    a: '驱动空闲 10 分钟自动回收 vite + Chromium,也可用 shutdown 命令 / SIGINT 立即收掉;截图产物在 tmp-shots/mcp-out/。',
  },
]
</script>

<style scoped lang="scss">
.docs-page {
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
.docs-nav {
  position: sticky;
  top: 0;
  flex: 0 0 208px;
  height: 100vh;
  border-right: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(18, 20, 24, 0.6);
}

.docs-nav-inner {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 20px 14px;
}

.docs-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 14px;
  padding-left: 6px;
  color: #fff;
  font-weight: 700;
  font-size: 15px;
}

.docs-brand-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #35c0ff;
  box-shadow: 0 0 8px #35c0ff;
}

.docs-nav-item {
  padding: 7px 10px;
  border-radius: 8px;
  border-left: 2px solid transparent;
  color: rgba(232, 236, 241, 0.62);
  font-size: 13px;
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
    color: #35c0ff;
    border-left-color: #35c0ff;
    background: rgba(53, 192, 255, 0.08);
  }
}

// API 参考外链:紫色区分站内锚点
.docs-nav-api {
  margin-top: 6px;
  color: #b9a7ff;

  &:hover {
    color: #d3c9ff;
    background: rgba(143, 123, 255, 0.1);
  }
}

.docs-back {
  margin-top: 18px;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  color: #e8ecf1;
  font:
    500 13px/1 system-ui,
    -apple-system,
    'Microsoft YaHei',
    sans-serif;
  cursor: pointer;

  &:hover {
    border-color: rgba(255, 255, 255, 0.32);
    background: rgba(255, 255, 255, 0.09);
  }
}

.docs-back-arrow {
  margin-right: 4px;
}

/* ── 右侧正文 ───────────────────────── */
.docs-main {
  flex: 1;
  min-width: 0;
  max-width: 980px;
  margin: 0 auto;
  padding: 40px 40px 60px;
}

.docs-hero {
  padding: 28px 30px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  background:
    radial-gradient(1200px 300px at 20% -80px, rgba(53, 192, 255, 0.16), transparent 60%),
    rgba(255, 255, 255, 0.03);
}

.docs-title {
  margin: 0 0 10px;
  font-size: 26px;
  line-height: 1.3;
}

.docs-sub {
  margin: 0;
  max-width: 720px;
  color: rgba(232, 236, 241, 0.72);
  font-size: 14px;
}

.docs-hero-actions {
  display: flex;
  gap: 10px;
  margin-top: 18px;
}

.docs-btn {
  padding: 8px 16px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: #e8ecf1;
  font:
    500 13px/1 system-ui,
    -apple-system,
    'Microsoft YaHei',
    sans-serif;
  cursor: pointer;
  transition:
    background 0.18s,
    border-color 0.18s;

  &:hover {
    border-color: rgba(255, 255, 255, 0.32);
    background: rgba(255, 255, 255, 0.1);
  }

  &.is-primary {
    border-color: rgba(53, 192, 255, 0.5);
    background: rgba(53, 192, 255, 0.16);
    color: #bfe9ff;

    &:hover {
      background: rgba(53, 192, 255, 0.26);
    }
  }
}

.docs-section {
  margin-top: 44px;
  scroll-margin-top: 20px;
}

.docs-h2 {
  margin: 0 0 14px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 19px;
}

.docs-h3 {
  margin: 0 0 8px;
  font-size: 14px;
  color: #fff;
}

.docs-p {
  margin: 0 0 12px;
  color: rgba(232, 236, 241, 0.78);
}

.docs-p-dim {
  color: rgba(232, 236, 241, 0.5);
  font-size: 13px;
}

.docs-grid {
  display: grid;
  gap: 12px;
}

.docs-grid-2 {
  grid-template-columns: repeat(2, 1fr);
}

.docs-grid-3 {
  grid-template-columns: repeat(3, 1fr);
}

.docs-card {
  padding: 16px 18px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
}

.docs-card-wide {
  margin-top: 12px;
}

.docs-card-feature {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.docs-feature-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.docs-card-p {
  margin: 0;
  color: rgba(232, 236, 241, 0.72);
  font-size: 13px;
}

.docs-list {
  margin: 0;
  padding-left: 18px;
  color: rgba(232, 236, 241, 0.78);
  font-size: 13px;

  li {
    margin: 4px 0;
  }

  b {
    color: #fff;
  }
}

.docs-mini {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);

  b {
    color: #35c0ff;
    font-size: 13px;
  }

  span {
    color: rgba(232, 236, 241, 0.62);
    font-size: 12px;
  }
}

.docs-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;

  th,
  td {
    padding: 6px 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    text-align: left;
    color: rgba(232, 236, 241, 0.82);
  }

  th {
    color: rgba(232, 236, 241, 0.5);
    font-weight: 500;
  }

  tr:last-child td {
    border-bottom: none;
  }
}

kbd {
  padding: 1px 6px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-bottom-width: 2px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.07);
  font:
    500 12px/1.5 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
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

.docs-code {
  margin: 0;
  padding: 14px 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.35);
  color: #c9e6ff;
  font:
    400 12.5px/1.7 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  overflow-x: auto;

  code {
    padding: 0;
    background: none;
    color: inherit;
    font-size: inherit;
  }
}

.docs-steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.docs-step {
  display: flex;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);

  b {
    color: #fff;
    font-size: 13.5px;
  }
}

.docs-step-no {
  flex: 0 0 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(53, 192, 255, 0.16);
  color: #35c0ff;
  font:
    700 12px/24px system-ui,
    sans-serif;
  text-align: center;
}

.docs-faq {
  padding: 10px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);

  &:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }
}

.docs-faq-q {
  margin: 0 0 4px;
  color: #fff;
  font-size: 13.5px;
  font-weight: 600;
}

.docs-faq-a {
  margin: 0;
  color: rgba(232, 236, 241, 0.68);
  font-size: 13px;
}

.docs-foot {
  display: flex;
  justify-content: space-between;
  margin-top: 48px;
  padding-top: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  color: rgba(232, 236, 241, 0.4);
  font-size: 12px;
}

@media (max-width: 860px) {
  .docs-page {
    flex-direction: column;
  }

  .docs-nav {
    position: static;
    flex: none;
    height: auto;
    border-right: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  }

  .docs-nav-inner {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
  }

  .docs-back {
    margin-top: 0;
    margin-left: auto;
  }

  .docs-main {
    padding: 24px 18px 40px;
  }

  .docs-grid-2,
  .docs-grid-3 {
    grid-template-columns: 1fr;
  }
}
</style>
