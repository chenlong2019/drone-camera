/**
 * 无人机控制面板(原生 DOM 实现):王者荣耀式 HUD —— 双虚拟摇杆 + 技能按钮 + 飞行控制面板。
 *
 * 布局(仿王者荣耀):
 * - 左右两根虚拟摇杆**脱离面板**,作为悬浮 HUD 挂在画面左下 / 右下角(控制罗盘左右各一个);
 * - 拍照 / 录像是「技能」按钮,悬浮在右轮盘上方(蓝圈 = 拍照,橙圈 = 录像),
 *   角标显示拍照张数 / 录制秒数(对应游戏里技能的buff计数);
 * - 面板本体只留飞行控制(上电/起飞/降落/返航/机臂/模式)+ 速度倍率(0~1000,数值即倍数)+
 *   视角切换 + 云台,停靠按 position 选项。
 *
 * 设计边界:
 * - 只用原生 DOM / CSS,不引入任何 UI 框架 —— 库整体保持与框架无关(Vue / React / 裸页面通用);
 * - 面板自身不持有状态:渲染时从 DroneFly / DroneSim 读,操作时调 DroneFly 方法,
 *   真值永远以引擎为准(见 sync)。宿主用别的方式改了视角或云台,面板下一轮同步就会跟上,不会脱节;
 * - 样式默认注入一份(类名统一 `dcp-` 前缀、配色走 CSS 变量),可用 injectStyles:false 关闭,由宿主自行配色。
 *
 * 非直觉约定:
 * - 面板以 200ms 轮询同步状态(可用 syncIntervalMs 调或关);拖动云台滑杆期间暂停回写,避免与用户输入打架;
 * - 键盘是屏上双摇杆的第二套输入:按键时对应那根杆会**同步推杆**(杆帽位移 + 高亮 + 读数),
 *   看起来就像有人在替你打杆;两套输入合成时"摇杆优先"(见 applyStick);
 * - 技能(拍照 / 录像)另有组合键 `Ctrl`(`Cmd`)+ `K` / `L`,按一次触发一次,与点技能钮同一路径;
 * - 摇杆按 DJI 遥控器(美国手 Mode 2)的杆位分工:左杆 = 上/下升降 + 左/右偏航,右杆 = 上/下前后 + 左/右横滚。
 *   两根杆都是**自回中**的:松手立刻归零并回到中心 —— 对应真机的"松杆即停",不会因为漏掉抬起事件一直飞;
 * - 摇杆用 Pointer Events + setPointerCapture 实现,鼠标 / 触摸 / 触控笔同一套代码,
 *   并且按 pointerId 分别跟踪,双指可以同时推两根杆(真机双手打杆);
 * - 悬浮层与面板是**两个兄弟节点**(都挂在 container 上):面板有 backdrop-filter,会把 fixed 后代的定位
 *   基准改成面板自身,所以摇杆不能塞进面板里;悬浮层 pointer-events:none、只留轮盘可点,不挡场景交互。
 */
import type { DronePanelHost } from './drone-control'
import { CAMERA_MODE_LIST } from './drone-fly'
import type { CameraMode, PhotoShot } from './drone-fly'
import {
  DEFAULT_SPEED_SCALE,
  FLIGHT_MODE_LIST,
  PHASE_LABELS,
  SPEED_SCALE_MAX,
  SPEED_SCALE_MIN,
} from './drone-sim'
import type { FlightMode } from './drone-sim'
import { PANORAMA_MODE_LIST, PANORAMA_PRESETS, PanoramaCapture } from './drone-panorama'
import type { PanoramaMode, PanoramaProgress } from './drone-panorama'
import type { CaptureService } from './drone-capture'

/** 拍摄模式:单张 / 广角 / 180° 全景 / 球形 360° */
type ShootMode = 'single' | PanoramaMode

/** 全景每张之间的默认间隔(毫秒):贴近真机节奏,也给渲染后端留出稳定时间 */
const DEFAULT_PANORAMA_INTERVAL_MS = 120

/** 面板停靠位置(相对挂载容器) */
export type DronePanelPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** DroneControlPanel 构造选项 */
export interface DroneControlPanelOptions {
  /** 挂载容器;缺省挂到 document.body(此时面板与悬浮层改用 fixed 定位) */
  container?: HTMLElement | null
  /** 面板停靠位置,默认 'top-right';左右轮盘固定悬浮在画面两下角,不受此项影响 */
  position?: DronePanelPosition
  /** 面板标题,默认「无人机」 */
  title?: string
  /** 是否注入自带样式,默认 true;关闭后仅保留 `dcp-*` 类名,由宿主自行配色 */
  injectStyles?: boolean
  /** 云台俯仰快捷档位(度),默认 [-90, -30, -10, 0] */
  pitchPresets?: number[]
  /** 初始是否可见,默认 true */
  visible?: boolean
  /** 拍照完成回调;未提供且 autoDownload 为 true 时自动下载 PNG */
  onPhoto?: (shot: PhotoShot) => void
  /**
   * 采集服务(可选)。提供后面板出现「拍摄模式」区,可切换广角 / 180° / 360°:
   * 全景按预设网格逐张取景拍摄,每张都带全景分组信息登记进这个服务的当前会话。
   *
   * 与采集面板共用同一个实例时,全景照片会直接出现在那边的影像集里(见 demo 的接法)。
   */
  captureService?: CaptureService
  /** 是否启用全景拍摄(默认 true);没有 `captureService` 时不显示该区 */
  panorama?: boolean
  /** 全景每张之间的间隔(毫秒),默认 120 */
  panoramaShotIntervalMs?: number
  /** 录像完成回调;未提供且 autoDownload 为 true 时自动下载 webm */
  onRecording?: (blob: Blob, seconds: number) => void
  /** 无自定义回调时是否自动下载产物,默认 true */
  autoDownload?: boolean
  /** 状态轮询间隔(毫秒),默认 200;传 0 关闭自动同步、完全由宿主调 sync() */
  syncIntervalMs?: number
  /** 摇杆死区(0~1),默认 0.06;小于该幅值视为 0,抵住手指轻微抖动。作用于垂直通道(升降 / 前后) */
  stickDeadzone?: number
  /**
   * 横滚 / 偏航死区(0~1),默认 0.14。比垂直通道大一档 —— 触屏推杆时手指很难保证绝对竖直,
   * 轻微的侧向分量会被放大成持续横移和机头偏转,几分钟就飞出弧线。加大这一路死区等于给
   * 直线飞行留出一条"安全走廊",垂直通道不受影响、起手依然跟手。
   */
  stickLateralDeadzone?: number
  /**
   * 摇杆指数曲线 expo(0~1),默认 0.55,真机遥控器的 expo 手感:
   * 输出 = expo·v³ + (1-expo)·v —— 中位附近行程放慢(便于精确微调),
   * 末端仍能打满舵量(1 处恒等于 1),推到底的极速与转向权限不受影响。
   * 传 0 退回线性响应。
   */
  stickExpo?: number
  /**
   * 偏航角速度缩放(0~1],默认 0.6。左杆左右 / ←→ 键的转向输出乘这个系数 ——
   * 飞控的挡位角速度是照真机标的(普通挡 100°/s,满杆 3.6 秒转一圈),
   * 在屏幕遥控器上偏快;这里只压遥控器侧的输出,飞控与挡位表不动。
   * 传 1 退回真机原始速率。
   */
  yawRateScale?: number
  /**
   * 是否启用键盘控制,默认 true。键位(与屏上双摇杆等效,左手 WASD 对左杆、右手方向键对右杆):
   * `W/S` 升降 · `A/D` 转向(左杆) · `↑/↓` 前后 · `←/→` 横滚(右杆);`Q/E` 是转向的备用键。
   * 另外两组技能快捷键:`Ctrl`(macOS 上 `Cmd`)+ `K` 拍照、`Ctrl` + `L` 录像(开关,再按一次停止),
   * 等同于点右轮盘上的拍照 / 录像钮,长按不连发。
   * 键盘是开关量,内部做了渐进行程(按下渐推、松开渐回),不会突然满舵。
   * 焦点在输入框内时不拦截按键。
   */
  keyboard?: boolean
  /** 键盘推杆渐推时间(秒),默认 0.45;越大越柔和 */
  keyboardRiseSeconds?: number
  /** 键盘松手渐回时间(秒),默认 0.18 */
  keyboardFallSeconds?: number
  /** 是否启用移动端自适应(横屏紧凑布局 / 触控尺寸),默认 true */
  adaptive?: boolean
}

const STYLE_ID = 'drone-control-panel-styles'
const DEFAULT_PITCH_PRESETS = [-90, -30, -10, 0]
/**
 * 速度倍率滑杆的步长。
 * 行程 0 ~ 1000(数值即倍数),步长取 0.5 而不是 1 —— 倍率越小差异越明显,
 * 0.5×(半速)是很常用的一档,整数步长到不了它;0.5 步长下整数与 .5 都能取到。
 */
const SPEED_SCALE_STEP = 0.5
/** 速度倍率快捷档位:半速 / 原速 / 2 倍 / 5 倍 / 10 倍(超过 10 倍靠滑杆或直接输入) */
const SPEED_SCALE_PRESETS: Array<{ value: number; label: string }> = [
  { value: 0.5, label: '0.5×' },
  { value: 1, label: '1×' },
  { value: 2, label: '2×' },
  { value: 5, label: '5×' },
  { value: 10, label: '10×' },
]
/** 云台俯仰可用范围,与 DRONE_SPEC 保持一致 */
const PITCH_MIN = -90
const PITCH_MAX = 60
/** 摇杆死区:与 DroneSim 内部 0.06 的"有效行程"阈值对齐,免得面板给了量而飞控不认 */
const DEFAULT_STICK_DEADZONE = 0.06
/** 横滚 / 偏航死区:比垂直通道大一档,给直线飞行留安全走廊 */
const DEFAULT_STICK_LATERAL_DEADZONE = 0.14
/** 指数曲线:中位附近放慢、末端打满,DJI 遥控器的默认 expo 手感 */
const DEFAULT_STICK_EXPO = 0.55
/** 偏航角速度缩放:真机挡位 100°/s 在屏幕遥控器上偏快,压到 60°/s 左右 */
const DEFAULT_YAW_RATE_SCALE = 0.6
/** 键盘推杆渐推 / 渐回时间(秒) */
const DEFAULT_KEYBOARD_RISE = 0.45
const DEFAULT_KEYBOARD_FALL = 0.18
/** 键盘渐进行程的刷新间隔(毫秒),~60Hz */
const KEYBOARD_TICK_MS = 16

/** 摇杆四通道,键盘与摇杆合成时按这个顺序遍历 */
const STICK_CHANNELS = ['throttle', 'yaw', 'pitch', 'roll'] as const
type StickChannel = (typeof STICK_CHANNELS)[number]

/**
 * 键盘键位 → 摇杆通道。
 * 左手 WASD 打左杆、右手方向键打右杆 —— 与屏上双摇杆的左右手分工对齐:
 * W/S 升降、A/D 转向(=左杆),↑/↓ 前后、←/→ 横滚(=右杆);Q/E 是转向的备用键。
 */
const KEY_BINDINGS: Record<string, { channel: StickChannel; sign: number }> = {
  KeyW: { channel: 'throttle', sign: 1 },
  KeyS: { channel: 'throttle', sign: -1 },
  KeyA: { channel: 'yaw', sign: -1 },
  KeyD: { channel: 'yaw', sign: 1 },
  ArrowUp: { channel: 'pitch', sign: 1 },
  ArrowDown: { channel: 'pitch', sign: -1 },
  ArrowLeft: { channel: 'roll', sign: -1 },
  ArrowRight: { channel: 'roll', sign: 1 },
  KeyQ: { channel: 'yaw', sign: -1 },
  KeyE: { channel: 'yaw', sign: 1 },
}

/**
 * 组合键快捷键:`Ctrl`(macOS 上 `Cmd`) + 键 → 面板动作。
 * 与上面的杆位键不是一回事 —— 杆位是"按住持续输出",快捷键是"按一次触发一次"(等同点技能钮),
 * 走的是同一个 takePhoto / toggleRecording,所以张数角标、录制计时、回调都跟点按钮完全一致。
 */
const KEY_SHORTCUTS: Record<string, PanelShortcut> = {
  KeyK: 'photo',
  KeyL: 'record',
}
/** 组合键能触发的动作;'record' 是开关(开始 / 停止在同一键上切换) */
type PanelShortcut = 'photo' | 'record'

/** 焦点是否在输入类元素上(输入框 / 文本域 / 下拉 / 可编辑区):这些地方的按键归宿主,面板不接管 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** 速度倍率写进输入框的文本:整数原样,小数去掉多余的 0(0.5 → "0.5",2.0 → "2") */
function formatScale(value: number): string {
  if (!Number.isFinite(value)) return String(DEFAULT_SPEED_SCALE)
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)))
}

/** 摇杆所在的一侧,决定行程写进哪两个通道 */
type StickSide = 'left' | 'right'

/** 摇杆内部句柄:几何缓存直接向 DOM 取,旋转 / 缩放后依然准 */
interface StickHandle {
  side: StickSide
  root: HTMLElement
  base: HTMLElement
  knob: HTMLElement
  read: HTMLElement
  /** 正在按住的指针 id(按 pointerId 跟踪,支持双指同时打两根杆) */
  pointerId: number | null
  /** 该杆当前行程(死区 + expo 之后的最终输出),与键盘合成时用 */
  vertical: number
  lateral: number
  /** 满行程对应的画布半径(px);测量缓存,键盘每帧刷杆帽时不必反复读布局 */
  radius: number
  /** 上次测量时的底盘边长(px),尺寸一变(换屏 / 旋转)就重测 radius */
  radiusSpan: number
}

const PANEL_CSS = `
.dcp, .dcp-sticks-float {
  --dcp-bg: rgba(15, 19, 27, 0.84);
  --dcp-border: rgba(255, 255, 255, 0.12);
  --dcp-text: #e9eff9;
  --dcp-muted: rgba(233, 239, 249, 0.58);
  --dcp-accent: #35a7ff;
  --dcp-on-accent: #04121f;
  --dcp-danger: #ff5f5f;
  --dcp-radius: 10px;
  /* 摇杆底盘直径与杆帽直径(杆帽按底盘等比缩放,横屏/小屏会整体调) */
  --dcp-stick: 92px;
  --dcp-knob: calc(var(--dcp-stick) * 0.42);
  /* 技能钮(拍照/录像)直径:跟着底盘等比缩放,但夹在可点范围内 */
  --dcp-skill: clamp(30px, calc(var(--dcp-stick) * 0.38), 38px);
  font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  overscroll-behavior: contain;
}
.dcp {
  z-index: 20;
  /* 264px ≈ 任务面板(dmp 262px)同宽:230px 时预设行(0.5x/1x/2x/5x/10x 五连)、
     四联分段控件挤到文字贴边;加宽只动行内空间,高度与块间距不变 */
  width: 264px;
  /* 高度封顶:面板加了拍摄模式区后内容超过 HUD 安全线(右下技能钮顶边距底 215px、
     768 高的窗口里摇杆顶边距底 169px),必须让面板在矮视口里内部滚动,而不是压住摇杆 */
  max-height: min(66vh, 640px);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  padding: 10px 12px 12px;
  border: 1px solid var(--dcp-border);
  border-radius: var(--dcp-radius);
  background: var(--dcp-bg);
  color: var(--dcp-text);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}
/* 悬浮摇杆层:铺满容器但自身不接指针,只留轮盘/技能可点,不挡场景拖拽 */
.dcp-sticks-float { inset: 0; z-index: 21; pointer-events: none; }
.dcp[data-position="top-left"] { top: 12px; left: 12px; }
.dcp[data-position="top-right"] { top: 12px; right: 12px; }
.dcp[data-position="bottom-left"] { bottom: 12px; left: 12px; }
.dcp[data-position="bottom-right"] { bottom: 12px; right: 12px; }
.dcp button, .dcp input, .dcp-sticks-float button { touch-action: manipulation; }
.dcp-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.dcp-title { flex: 1; font-weight: 600; letter-spacing: 0.02em; }
.dcp-icon {
  width: 20px; height: 20px; padding: 0; line-height: 18px;
  border: 1px solid var(--dcp-border); border-radius: 6px;
  background: transparent; color: var(--dcp-text); cursor: pointer; font-size: 12px;
}
.dcp-icon:hover { border-color: var(--dcp-accent); color: var(--dcp-accent); }
.dcp-label { display: flex; justify-content: space-between; align-items: baseline; color: var(--dcp-muted); margin-bottom: 6px; }
.dcp-label em { font-style: normal; color: var(--dcp-text); font-variant-numeric: tabular-nums; }
/* 速度倍率:读数位放一个可直接输入的数字框(0~1000 的行程光靠拖滑杆到不了精确值) */
.dcp-speed-val { display: inline-flex; align-items: center; gap: 2px; color: var(--dcp-text); }
.dcp-speed-val i { font-style: normal; }
.dcp-num {
  width: 56px; padding: 1px 4px; border-radius: 5px; text-align: right;
  border: 1px solid var(--dcp-border); background: rgba(255, 255, 255, 0.06);
  color: var(--dcp-text); font: inherit; font-variant-numeric: tabular-nums;
  /* 微调按钮在窄面板里太挤,且方向键已能微调,隐掉它 */
  -moz-appearance: textfield; appearance: textfield;
}
.dcp-num:focus { outline: none; border-color: var(--dcp-accent); }
.dcp-num::-webkit-outer-spin-button,
.dcp-num::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.dcp-segmented { display: flex; gap: 4px; }
.dcp-seg {
  flex: 1; min-width: 0; padding: 6px 0; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--dcp-border); background: rgba(255, 255, 255, 0.04);
  color: var(--dcp-muted); font-size: 12px;
}
.dcp-seg:hover { color: var(--dcp-text); }
.dcp-seg.is-active { background: var(--dcp-accent); border-color: var(--dcp-accent); color: var(--dcp-on-accent); font-weight: 600; }
.dcp-wide {
  width: 100%; margin-top: 6px; padding: 6px 0; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--dcp-border); background: rgba(255, 255, 255, 0.04); color: var(--dcp-text); font-size: 12px;
}
.dcp-wide:hover { border-color: var(--dcp-accent); color: var(--dcp-accent); }
.dcp-range { width: 100%; margin: 2px 0 6px; accent-color: var(--dcp-accent); cursor: pointer; }
.dcp-presets { display: flex; gap: 4px; }
.dcp-preset {
  flex: 1; padding: 4px 0; border-radius: 6px; cursor: pointer; font-variant-numeric: tabular-nums;
  border: 1px solid var(--dcp-border); background: rgba(255, 255, 255, 0.04); color: var(--dcp-muted); font-size: 11px;
}
.dcp-preset:hover { color: var(--dcp-text); border-color: var(--dcp-accent); }
.dcp-actions { display: flex; gap: 6px; }
.dcp-flight-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.dcp-flight {
  padding: 7px 0; border-radius: 7px; cursor: pointer; font-size: 12px;
  border: 1px solid var(--dcp-border); background: rgba(255, 255, 255, 0.06); color: var(--dcp-text);
}
.dcp-flight:hover:not(:disabled) { border-color: var(--dcp-accent); color: var(--dcp-accent); }
.dcp-flight:disabled { opacity: 0.32; cursor: not-allowed; }
.dcp-takeoff { border-color: rgba(53, 167, 255, 0.55); }
.dcp-rth { border-color: rgba(255, 159, 67, 0.5); }
.dcp-hint { margin: 6px 0 0; color: var(--dcp-muted); font-size: 11px; line-height: 1.4; }
.dcp-hint:empty { display: none; }
.dcp-note { min-height: 16px; margin: 8px 0 0; color: var(--dcp-muted); font-size: 11px; order: 7; }
/* 键盘键位提示(手机横屏没键盘,媒体查询里会藏掉) */
.dcp-keys { margin: 4px 0 0; color: var(--dcp-muted); font-size: 10px; line-height: 1.4; opacity: 0.72; order: 8; }
.dcp-keys:empty { display: none; }
.dcp-btn {
  flex: 1; padding: 7px 0; border-radius: 7px; cursor: pointer; font-size: 12px;
  border: 1px solid var(--dcp-border); background: rgba(255, 255, 255, 0.06); color: var(--dcp-text);
}

/* ── 主体:竖屏纵向流式;横屏(见媒体查询)改成两列网格 ── */
.dcp-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}
/* display:contents 让各个控制块直接成为 .dcp-body 的 flex item */
.dcp-mid { display: contents; }
.dcp-blk { display: block; }
.dcp-blk + .dcp-blk { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--dcp-border); }

/* ── 悬浮双轮盘(仿王者荣耀:左下移动轮盘 + 右下技能轮盘) ── */
.dcp-stick {
  position: absolute; pointer-events: auto;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
}
.dcp-stick[data-stick="left"] { left: 30px; bottom: 40px; }
.dcp-stick[data-stick="right"] { right: 30px; bottom: 40px; }
.dcp-stick-base {
  position: relative;
  width: var(--dcp-stick); height: var(--dcp-stick);
  border-radius: 50%;
  border: 1px solid var(--dcp-border);
  background: radial-gradient(circle at 50% 32%, rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0.02) 62%, rgba(0, 0, 0, 0.22));
  box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.42), 0 6px 18px rgba(0, 0, 0, 0.3);
  cursor: grab;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
/* 十字刻度:让"中心 / 行程极限"一眼可见 */
.dcp-stick-base::before,
.dcp-stick-base::after { content: ''; position: absolute; left: 50%; top: 50%; background: var(--dcp-border); pointer-events: none; }
.dcp-stick-base::before { width: calc(100% - 20px); height: 1px; transform: translate(-50%, -50%); }
.dcp-stick-base::after { width: 1px; height: calc(100% - 20px); transform: translate(-50%, -50%); }
.dcp-stick-base.is-active { cursor: grabbing; border-color: var(--dcp-accent); box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.42), inset 0 0 0 1px var(--dcp-accent), 0 6px 18px rgba(0, 0, 0, 0.3); }
.dcp-stick-arrow { position: absolute; color: var(--dcp-muted); font-size: 9px; line-height: 1; pointer-events: none; }
.dcp-stick-arrow[data-dir="up"] { top: 3px; left: 50%; transform: translateX(-50%); }
.dcp-stick-arrow[data-dir="down"] { bottom: 3px; left: 50%; transform: translateX(-50%); }
.dcp-stick-arrow[data-dir="left"] { left: 3px; top: 50%; transform: translateY(-50%); }
.dcp-stick-arrow[data-dir="right"] { right: 3px; top: 50%; transform: translateY(-50%); }
.dcp-stick-knob {
  position: absolute; left: 50%; top: 50%;
  width: var(--dcp-knob); height: var(--dcp-knob);
  margin: calc(var(--dcp-knob) / -2) 0 0 calc(var(--dcp-knob) / -2);
  border-radius: 50%;
  background: linear-gradient(180deg, #7b8798, #414b59);
  border: 1px solid rgba(255, 255, 255, 0.24);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
  transition: transform 0.14s ease-out;
  will-change: transform;
}
/* 按住时去掉回中动画,否则跟手会有一帧迟滞 */
.dcp-stick-base.is-active .dcp-stick-knob { transition: none; }
/* 键盘驱动:行程每 ~16ms 刷一次,过渡会拖在键位后面,同样去掉 */
.dcp-stick.is-keyboard .dcp-stick-knob { transition: none; }
.dcp-stick-cap { color: var(--dcp-muted); font-size: 10px; line-height: 1.25; text-align: center; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6); }
.dcp-stick-read { color: var(--dcp-muted); font-size: 10px; font-variant-numeric: tabular-nums; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6); }
.dcp-stick.is-active .dcp-stick-cap { color: var(--dcp-text); }
.dcp-stick.is-active .dcp-stick-read { color: var(--dcp-accent); }

/* ── 技能按钮(拍照/录像):坐在右轮盘正上方的技能位,不压盘面 ── */
/* 技能容器:贴着底盘上沿(底边 = 底盘顶边 + 7px 间距),整体居中,两枚按钮左右排开。
   用 bottom:100% 而不是负 top 偏移 —— 无论底盘放大到 100px 还是缩到 56px,
   按钮永远在轮盘外,不会再盖住盘面;容器自身不接指针,点击只落在按钮上 */
.dcp-skills {
  position: absolute; left: 50%; bottom: 100%;
  transform: translateX(-50%);
  margin-bottom: 7px;
  display: flex; align-items: flex-end; gap: 7px;
  pointer-events: none;
}
.dcp-skill {
  position: relative; z-index: 2;
  width: var(--dcp-skill); height: var(--dcp-skill); padding: 0;
  border-radius: 50%; cursor: pointer; pointer-events: auto;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0;
  border: 1.5px solid rgba(53, 167, 255, 0.6);
  background: radial-gradient(circle at 50% 30%, rgba(53, 167, 255, 0.32), rgba(8, 18, 30, 0.92) 72%);
  color: var(--dcp-text);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.42);
  transition: transform 0.1s ease, border-color 0.15s ease;
}
.dcp-skill:hover { border-color: var(--dcp-accent); }
.dcp-skill:active { transform: scale(0.92); }
/* 错开一格高度,斜向弧形排布(拍照左下 / 录像右上),不靠 transform 免得和按下态打架 */
.dcp-skill-rec {
  margin-bottom: 5px;
  border-color: rgba(255, 159, 67, 0.6); background: radial-gradient(circle at 50% 30%, rgba(255, 159, 67, 0.3), rgba(26, 16, 6, 0.92) 72%);
}
.dcp-skill-rec:hover { border-color: #ffb267; }
.dcp-skill-ico { font-size: 13px; line-height: 1; }
.dcp-skill-lbl { font-size: 8px; line-height: 1.1; letter-spacing: 0.02em; }
.dcp-skill-badge {
  position: absolute; right: -5px; top: -5px;
  min-width: 15px; padding: 0 3px; border-radius: 8px;
  background: var(--dcp-accent); color: var(--dcp-on-accent);
  font-size: 8px; line-height: 13px; font-weight: 700; font-variant-numeric: tabular-nums;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  display: none;
}
.dcp-skill-badge:not(:empty) { display: block; }
.dcp-skill-rec .dcp-skill-badge { background: #ff9f43; color: #241300; }
.dcp-ico-rec { width: 10px; height: 10px; border-radius: 50%; background: #ff5f5f; box-shadow: 0 0 0 2px rgba(255, 95, 95, 0.28); }
.dcp-skill-rec.is-recording { border-color: var(--dcp-danger); }
.dcp-skill-rec.is-recording .dcp-ico-rec { animation: dcp-rec-pulse 1s ease-in-out infinite; }
@keyframes dcp-rec-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.8); }
}

/* ── 手机横屏:面板贴底居中、嵌在左右轮盘之间(上方画面全留给取景),紧凑两列卡片 ── */
@media (orientation: landscape) and (max-height: 620px) {
  /* 面板与悬浮轮盘共用同一杆径基准:面板左右偏移按它算,才能刚好让开轮盘和技能 */
  .dcp[data-adaptive="true"],
  .dcp-sticks-float[data-adaptive="true"] { --dcp-stick: clamp(64px, 22vh, 100px); }
  .dcp[data-adaptive="true"][data-position] {
    top: auto; bottom: 8px;
    left: calc(var(--dcp-stick) + 62px);
    right: calc(var(--dcp-stick) + 62px);
    width: auto; max-width: none;
    padding: 5px 9px 6px;
    font-size: 11px;
  }
  .dcp[data-adaptive="true"] .dcp-head { margin-bottom: 3px; }
  .dcp[data-adaptive="true"] .dcp-title { font-size: 11px; }
  .dcp[data-adaptive="true"] .dcp-body {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px 10px;
    align-content: start;
    max-height: 52vh;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  /* 横屏藏提示条(技能角标已承载拍照/录像反馈),把高度让给场景 */
  .dcp[data-adaptive="true"] .dcp-note,
  .dcp[data-adaptive="true"] .dcp-keys { display: none; }
  .dcp[data-adaptive="true"] .dcp-blk {
    margin-top: 0; padding: 4px 6px; border-top: none;
    background: rgba(255, 255, 255, 0.03); border-radius: 8px;
  }
  /* 触控热区在横屏适度收窄:34px 会顶满屏高,28px 仍大于手指容差 */
  .dcp[data-adaptive="true"] .dcp-seg,
  .dcp[data-adaptive="true"] .dcp-wide,
  .dcp[data-adaptive="true"] .dcp-flight,
  .dcp[data-adaptive="true"] .dcp-btn,
  .dcp[data-adaptive="true"] .dcp-preset { min-height: 28px; padding: 4px 0; font-size: 11px; }
  .dcp[data-adaptive="true"] .dcp-label { margin-bottom: 3px; white-space: nowrap; }
  .dcp[data-adaptive="true"] .dcp-label em { min-width: 0; overflow: hidden; }
  .dcp[data-adaptive="true"] .dcp-seg,
  .dcp[data-adaptive="true"] .dcp-wide { white-space: nowrap; overflow: hidden; }
  .dcp[data-adaptive="true"] .dcp-flight-grid { grid-template-columns: repeat(3, 1fr); gap: 4px; }
  .dcp[data-adaptive="true"] .dcp-segmented { gap: 3px; }
  .dcp[data-adaptive="true"] .dcp-presets { gap: 3px; }
  .dcp[data-adaptive="true"] .dcp-hint { margin: 3px 0 0; font-size: 10px; }
  .dcp[data-adaptive="true"] .dcp-range { margin: 0 0 4px; }

  .dcp-sticks-float[data-adaptive="true"] .dcp-stick[data-stick="left"] { left: 20px; bottom: 26px; }
  .dcp-sticks-float[data-adaptive="true"] .dcp-stick[data-stick="right"] { right: 20px; bottom: 26px; }
}

/* ── 小屏横屏(如 iPhone SE):列宽吃紧,再降一档字号与杆径 ── */
@media (orientation: landscape) and (max-height: 620px) and (max-width: 700px) {
  .dcp[data-adaptive="true"],
  .dcp-sticks-float[data-adaptive="true"] { --dcp-stick: clamp(56px, 20vh, 84px); }
  .dcp[data-adaptive="true"] .dcp-seg,
  .dcp[data-adaptive="true"] .dcp-wide,
  .dcp[data-adaptive="true"] .dcp-flight,
  .dcp[data-adaptive="true"] .dcp-btn,
  .dcp[data-adaptive="true"] .dcp-preset { font-size: 10px; }
  .dcp[data-adaptive="true"] .dcp-label { font-size: 10px; }
}

/* ── 手机竖屏:面板收一点宽度,轮盘略缩 ── */
@media (max-width: 560px) and (orientation: portrait) {
  .dcp[data-adaptive="true"] { width: min(86vw, 246px); }
  .dcp-sticks-float[data-adaptive="true"] { --dcp-stick: 84px; }
}

/* ── 触控设备:把点击热区抬到 34px 以上,避免误触(技能钮只放到上限,不再撑大) ── */
@media (pointer: coarse) {
  .dcp-seg, .dcp-wide, .dcp-flight, .dcp-btn, .dcp-preset { min-height: 34px; }
  .dcp, .dcp-sticks-float { --dcp-skill: clamp(34px, calc(var(--dcp-stick) * 0.4), 40px); }
}

/* 折叠 / 展开放最后:横屏那条 .dcp-body{display:grid} 与它同权重,靠源码顺序压过去 */
.dcp[data-collapsed="true"] .dcp-body { display: none; }
`

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }
  return text.replace(/[&<>"']/g, (ch) => map[ch] ?? ch)
}

function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/** 生成文件名用的时间戳(本地时间,精确到秒) */
function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/**
 * 死区外重新归一:否则行程刚跨过死区时会从 0 直接跳到 deadzone,飞机起手就有一下顿挫。
 * 归一后仍是单调的 -1~1,只是把死区那一小段"摊平"了。
 */
function applyDeadzone(value: number, deadzone: number): number {
  if (deadzone <= 0) return value
  if (Math.abs(value) <= deadzone) return 0
  return (value - Math.sign(value) * deadzone) / (1 - deadzone)
}

/**
 * 指数曲线(expo):真机遥控器用来"软化中位"的标准做法。
 *
 *   out = sign(v) · (expo·|v|³ + (1-expo)·|v|)
 *
 * 指数项让中位附近的行程变慢(推 30% 只给约 17% 舵量),便于微调;
 * 一次项保证末端仍然线性推到满舵(v=1 恒等于 1),极速与转向权限不缩水。
 */
function applyExpo(value: number, expo: number): number {
  if (expo <= 0) return value
  const e = Math.min(0.95, Math.max(0, expo))
  const magnitude = Math.abs(value)
  return Math.sign(value) * (e * magnitude ** 3 + (1 - e) * magnitude)
}

/** 行程夹到 ±1(摇杆圆轨与键盘叠加后都要落在合法行程内) */
function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value))
}

/** 摇杆读数:垂直 / 水平两路合成一行短文本,居中时给个明确提示 */
function formatStickText(vertical: number, lateral: number): string {
  if (Math.abs(vertical) < 0.005 && Math.abs(lateral) < 0.005) return '居中'
  const mark = (value: number, positive: string, negative: string): string => {
    if (Math.abs(value) < 0.005) return '·0.00'
    return `${value > 0 ? positive : negative}${Math.abs(value).toFixed(2)}`
  }
  return `${mark(vertical, '↑', '↓')} ${mark(lateral, '→', '←')}`
}

/**
 * 无人机控制面板:王者荣耀式 HUD(左右悬浮轮盘 + 右轮盘技能) + 飞行控制面板。
 *
 * ```ts
 * const fly = new DroneFly(scene, camera, renderer, controls)
 * await fly.initialize({ modelUrl: '/models/dji_mini4_pro.glb' })
 * const panel = new DroneControlPanel(fly, { container: viewportEl, position: 'top-right' })
 * // 卸载:panel.destroy()
 * ```
 *
 * 按钮可用性由飞行阶段推导(见 sync):未上电时只有「上电」可点,待机/电机已启动才能「起飞」,
 * 离地后才能「降落」「返航」—— 与真机的操作次序一致,不会点出无效请求。
 * 方向由两根自回中虚拟摇杆给出(DJI 美国手 Mode 2),输出的是连续行程而不是开关量。
 *
 * 手感对齐真机遥控器:垂直通道死区 0.06、横滚/偏航死区 0.14(留出直线飞行走廊)、
 * 全通道叠加 expo 指数曲线(默认 0.55,中位变钝、末端仍打满),可用
 * `stickDeadzone` / `stickLateralDeadzone` / `stickExpo` 覆盖(传 0 即关闭)。
 */
export class DroneControlPanel {
  /** 面板根元素(宿主可追加类名做二次定制) */
  readonly root: HTMLDivElement
  /** 悬浮摇杆/技能层(面板的兄弟节点,铺满容器;宿主可追加类名做二次定制) */
  readonly hudLayer: HTMLDivElement

  private readonly fly: DronePanelHost
  private readonly opts: DroneControlPanelOptions
  private readonly presets: number[]
  private readonly container: HTMLElement
  private readonly abort = new AbortController()
  private readonly deadzone: number
  private readonly lateralDeadzone: number
  private readonly expo: number
  private readonly yawRateScale: number
  private readonly keyboardEnabled: boolean
  private readonly keyboardRise: number
  private readonly keyboardFall: number
  /** 当前按下的键盘键(存 event.code,不受输入法/大写锁定影响) */
  private readonly pressedKeys = new Set<string>()
  /** 键盘合成行程(带渐推渐回);与摇杆合成时"摇杆优先" */
  private readonly keyboardStick: Record<StickChannel, number> = {
    throttle: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
  }
  private keyboardTimer: number | null = null
  private lastKeyboardTick = 0
  private sticks: StickHandle[] = []
  private readonly refs: {
    modeLabel: HTMLElement
    flightState: HTMLElement
    powerButton: HTMLButtonElement
    takeoffButton: HTMLButtonElement
    landButton: HTMLButtonElement
    rthButton: HTMLButtonElement
    armDeployButton: HTMLButtonElement
    armFoldButton: HTMLButtonElement
    flightModeLabel: HTMLElement
    speedSlider: HTMLInputElement
    speedInput: HTMLInputElement
    preflight: HTMLElement
    pitchSlider: HTMLInputElement
    pitchValue: HTMLElement
    photoCount: HTMLElement
    recordButton: HTMLButtonElement
    recTime: HTMLElement
    note: HTMLElement
    /** 「拍摄模式」区的读数位(未启用全景时为 null) */
    shootLabel: HTMLElement | null
  }

  private timer: number | null = null
  private pitchDragging = false
  /** 正在拖速度倍率滑杆:期间不回写,免得和用户的手打架 */
  private speedDragging = false
  private photoBusy = false
  private visible: boolean
  private collapsed = false
  private destroyed = false
  /** 停止录像前抓的时长,用于回调与提示(stopRecording 后 sim.recordSeconds 会归零) */
  private lastRecordSeconds = 0
  /** 全景扫描器(未接采集服务时为 null) */
  private panorama: PanoramaCapture | null = null
  private panoramaUnsub: (() => void) | null = null
  /** 当前拍摄模式:单张 / 180° / 360° */
  private shootMode: ShootMode = 'single'
  /** 最近一次全景进度(面板只做展示) */
  private panoProgress: PanoramaProgress | null = null

  /** 构造控制面板并插入容器(可传 options 停靠位置/手感/键盘开关) */
  constructor(fly: DronePanelHost, options: DroneControlPanelOptions = {}) {
    if (typeof document === 'undefined') {
      throw new Error('[drone-camera] DroneControlPanel 需要浏览器环境(document),Node 侧请勿实例化')
    }
    this.fly = fly
    this.opts = options
    this.presets = options.pitchPresets ?? DEFAULT_PITCH_PRESETS
    this.deadzone = options.stickDeadzone ?? DEFAULT_STICK_DEADZONE
    this.lateralDeadzone = options.stickLateralDeadzone ?? DEFAULT_STICK_LATERAL_DEADZONE
    this.expo = options.stickExpo ?? DEFAULT_STICK_EXPO
    this.yawRateScale = Math.max(0, Math.min(1, options.yawRateScale ?? DEFAULT_YAW_RATE_SCALE))
    this.keyboardEnabled = options.keyboard !== false
    this.keyboardRise = Math.max(0.02, options.keyboardRiseSeconds ?? DEFAULT_KEYBOARD_RISE)
    this.keyboardFall = Math.max(0.02, options.keyboardFallSeconds ?? DEFAULT_KEYBOARD_FALL)
    this.container = options.container ?? document.body
    this.visible = options.visible ?? true

    if (options.injectStyles !== false) ensureStyles()

    // 全景扫描器要在**模板生成之前**就绪 —— 模板按 this.panorama 的有无决定渲不渲染
    // 「拍摄模式」区。它只依赖采集服务(取景方位由服务在每张内部施加并复位),不碰渲染后端。
    if (options.captureService && options.panorama !== false) {
      this.panorama = new PanoramaCapture(options.captureService, {
        shotIntervalMs: options.panoramaShotIntervalMs ?? DEFAULT_PANORAMA_INTERVAL_MS,
      })
    }

    // 面板用 absolute 定位到容器;容器若没有定位上下文则补一个 relative,否则会跑到页面左上角
    const host = options.container ?? null
    if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative'
    // 容器缺省时用 fixed 贴视口,否则 absolute 贴容器
    const layerPosition = host ? 'absolute' : 'fixed'

    this.root = document.createElement('div')
    this.root.className = 'dcp'
    this.root.dataset.position = options.position ?? 'top-right'
    // 自适应开关交给 CSS:媒体查询只对 data-adaptive="true" 生效,宿主想自己排版可关掉
    this.root.dataset.adaptive = String(options.adaptive !== false)
    this.root.style.position = layerPosition
    this.root.innerHTML = this.template()
    if (!this.visible) this.root.style.display = 'none'

    // 悬浮层与面板是兄弟节点:面板的 backdrop-filter 会改变 fixed 后代的定位基准,摇杆不能塞进面板
    this.hudLayer = document.createElement('div')
    this.hudLayer.className = 'dcp-sticks-float'
    this.hudLayer.dataset.adaptive = this.root.dataset.adaptive
    this.hudLayer.style.position = layerPosition
    this.hudLayer.innerHTML = this.hudTemplate()
    if (!this.visible) this.hudLayer.style.display = 'none'

    this.refs = {
      modeLabel: this.query('[data-role="mode-label"]'),
      flightState: this.query('[data-role="flight-state"]'),
      powerButton: this.query<HTMLButtonElement>('[data-role="power"]'),
      takeoffButton: this.query<HTMLButtonElement>('[data-role="takeoff"]'),
      landButton: this.query<HTMLButtonElement>('[data-role="land"]'),
      rthButton: this.query<HTMLButtonElement>('[data-role="rth"]'),
      armDeployButton: this.query<HTMLButtonElement>('[data-role="arm-deploy"]'),
      armFoldButton: this.query<HTMLButtonElement>('[data-role="arm-fold"]'),
      flightModeLabel: this.query('[data-role="flight-mode-label"]'),
      speedSlider: this.query<HTMLInputElement>('[data-role="speed-scale"]'),
      speedInput: this.query<HTMLInputElement>('[data-role="speed-scale-input"]'),
      preflight: this.query('[data-role="preflight"]'),
      pitchSlider: this.query<HTMLInputElement>('[data-role="pitch"]'),
      pitchValue: this.query('[data-role="pitch-value"]'),
      photoCount: this.queryIn(this.hudLayer, '[data-role="photo-count"]'),
      recordButton: this.queryIn<HTMLButtonElement>(this.hudLayer, '[data-role="toggle-record"]'),
      recTime: this.queryIn(this.hudLayer, '[data-role="rec-time"]'),
      note: this.query('[data-role="note"]'),
      // 全景区是条件渲染的(没接采集服务就没有),所以用可空查询
      shootLabel: this.root.querySelector<HTMLElement>('[data-role="shoot-label"]'),
    }
    this.sticks = this.collectSticks()

    // 订阅进度(全景实例已在上面按需创建;回调只碰 DOM 与进度字段,构造期不会触发)
    if (this.panorama) {
      this.panoramaUnsub = this.panorama.subscribe((progress) => {
        this.panoProgress = progress
        this.syncShootMode()
        this.syncHudBadge()
      })
    }

    this.bind()
    this.sync()
    this.mount()
  }

  // ───────────────────────────── 生命周期 ─────────────────────────────

  /** 插入容器(构造时已自动调用一次;面板与悬浮层一起挂) */
  mount(): this {
    if (!this.destroyed && !this.root.isConnected) this.container.appendChild(this.root)
    if (!this.destroyed && !this.hudLayer.isConnected) this.container.appendChild(this.hudLayer)
    return this
  }

  /** 从容器移除但保留实例,可再次 mount */
  unmount(): this {
    this.root.remove()
    this.hudLayer.remove()
    return this
  }

  /** 显示 / 隐藏(面板与悬浮轮盘一起切换) */
  setVisible(visible: boolean): this {
    this.visible = visible
    this.root.style.display = visible ? '' : 'none'
    this.hudLayer.style.display = visible ? '' : 'none'
    return this
  }

  /** 当前是否可见 */
  isVisible(): boolean {
    return this.visible
  }

  /** 折叠 / 展开(只收面板,左右轮盘与技能保持可用 —— 游戏里也不收操作区) */
  setCollapsed(collapsed: boolean): this {
    this.collapsed = collapsed
    this.root.dataset.collapsed = String(collapsed)
    return this
  }

  /** 彻底销毁:解绑事件、停轮询、移除 DOM */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    // 先松开摇杆与键盘:销毁时若还按着,行程会留在引擎里让飞机一直飞
    this.stopKeyboard()
    this.releaseKeyboard()
    this.releaseSticks()
    this.abort.abort()
    this.stopTimer()
    // 全景扫描:先停扫描(它还在逐张 await),再退订 —— 否则回调会打到已移除的 DOM 上
    this.panorama?.cancel()
    this.panoramaUnsub?.()
    this.panoramaUnsub = null
    this.root.remove()
    this.hudLayer.remove()
  }

  /**
   * 移除已注入的共享样式。
   * 多个面板共存时请等最后一个销毁后再调用,否则其余面板会掉样式。
   */
  static removeInjectedStyles(): void {
    if (typeof document === 'undefined') return
    document.getElementById(STYLE_ID)?.remove()
  }

  // ───────────────────────────── 状态同步 ─────────────────────────────

  /** 把引擎当前状态刷到 HUD 上(飞行阶段/按钮可用性 / 视角高亮 / 云台角度 / 技能角标 / 摇杆读数) */
  sync(): void {
    if (this.destroyed) return
    const fly = this.fly

    // 飞行:阶段 + 高度。按钮可用性直接由阶段推导,避免用户点出无效请求
    const phase = fly.phase
    this.refs.flightState.textContent = `${PHASE_LABELS[phase] ?? phase} · ${fly.altitude.toFixed(1)} m`
    const canPower = phase === 'powerOff' || phase === 'stopped'
    this.refs.powerButton.disabled = !canPower
    this.refs.takeoffButton.disabled = !(phase === 'standby' || phase === 'motorsOn')
    this.refs.landButton.disabled = !(fly.airborne || phase === 'takingOff')
    this.refs.rthButton.disabled = !(fly.airborne && phase !== 'rth')
    // 机臂:已处于目标状态就置灰;飞行中不得收拢(与真机一致)
    const folded = fly.armsFolded
    this.refs.armDeployButton.disabled = !folded
    this.refs.armFoldButton.disabled = folded || fly.airborne

    // 起飞前检查未过时说明卡在哪一项(如 GNSS 搜星),否则用户只会觉得"点了没反应"
    const blocked = fly.preflightChecks.filter((item) => item.blocking && !item.ok)
    this.refs.preflight.textContent = blocked.length
      ? `待通过:${blocked.map((item) => item.label).join('、')}`
      : ''
    this.refs.preflight.title = blocked.map((item) => `${item.label}:${item.detail}`).join('\n')

    // 飞行模式:真值取 fly.flightMode
    const flightMode = fly.flightMode
    this.refs.flightModeLabel.textContent =
      FLIGHT_MODE_LIST.find((item) => item.key === flightMode)?.label ?? flightMode
    this.root.querySelectorAll<HTMLElement>('[data-action="set-flight-mode"]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.mode === flightMode)
    })

    // 速度倍率:真值取 sim.speedScale(可能与界面控件不一致 —— 宿主/脚本改过就以下一轮同步为准)
    this.renderSpeedScale(fly.sim.speedScale)

    // 视角:真值取 fly.cameraMode
    const mode = fly.cameraMode
    this.refs.modeLabel.textContent =
      CAMERA_MODE_LIST.find((item) => item.key === mode)?.label ?? mode
    this.root.querySelectorAll<HTMLElement>('[data-action="set-mode"]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.mode === mode)
    })

    // 云台:拖动滑杆期间不回写,否则会和用户的手打架
    if (!this.pitchDragging) {
      const pitch = Math.round(fly.sim.gimbalPitch)
      this.refs.pitchSlider.value = String(pitch)
      this.renderPitch(pitch)
    }

    // 摇杆读数:正被手指按住的那根以面板为准(回写会打架),其余跟随引擎真值
    this.syncStickReadout()

    this.syncShootMode()
    this.syncHudBadge()
  }

  /** 技能角标(游戏里的 buff 计数位):全景扫描中优先显示扫描进度,否则显示拍照张数 */
  private syncHudBadge(): void {
    const fly = this.fly
    const progress = this.panoProgress
    this.refs.photoCount.textContent =
      progress?.state === 'running'
        ? `${progress.index}/${progress.total}`
        : fly.sim.photoCount > 0
          ? String(fly.sim.photoCount)
          : ''
    const recording = fly.isRecording
    this.refs.recordButton.classList.toggle('is-recording', recording)
    this.refs.recTime.textContent = recording ? `${fly.sim.recordSeconds.toFixed(0)}s` : ''
  }

  /** 拍摄模式区:模式高亮 + 读数(空闲显示张数,扫描中/完成显示进度) */
  private syncShootMode(): void {
    if (!this.panorama) return
    const running = this.panorama.running
    this.root
      .querySelectorAll<HTMLButtonElement>('[data-action="set-shoot-mode"]')
      .forEach((button) => {
        const isActive = button.dataset.mode === this.shootMode
        button.classList.toggle('is-active', isActive)
        // 扫描中锁模式:半途换模式会让"这一组"变成两种参数混拍
        button.toggleAttribute('disabled', running && !isActive)
      })
    const label = this.refs.shootLabel
    if (!label) return
    const progress = this.panoProgress
    const preset =
      this.shootMode === 'single'
        ? null
        : PanoramaCapture.preset(
            this.shootMode,
            this.opts.captureService?.getCaptureIntrinsics()?.verticalFovDeg,
          )
    if (progress && progress.mode === this.shootMode && progress.state !== 'idle') {
      const prefix =
        progress.state === 'running'
          ? '扫描中'
          : progress.state === 'done'
            ? '完成'
            : progress.state === 'failed'
              ? '未完成'
              : '已停止'
      label.textContent = `${prefix} ${progress.index}/${progress.total}`
      return
    }
    label.textContent = preset ? `${preset.total} 张` : '单张'
  }

  // ───────────────────────────── 内部实现 ─────────────────────────────

  private query<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.queryIn(this.root, selector)
  }

  private queryIn<T extends HTMLElement = HTMLElement>(scope: ParentNode, selector: string): T {
    const el = scope.querySelector<T>(selector)
    if (!el) throw new Error(`[drone-camera] 面板结构缺失:${selector}`)
    return el
  }

  /** 面板本体:飞行控制 + 模式/视角/云台(方向轮盘与拍照录像已拆到悬浮层) */
  private template(): string {
    const modes = CAMERA_MODE_LIST.map(
      (item) =>
        `<button type="button" class="dcp-seg" data-action="set-mode" data-mode="${item.key}">${item.label}</button>`,
    ).join('')
    const presets = this.presets
      .map(
        (value) =>
          `<button type="button" class="dcp-preset" data-action="preset-pitch" data-pitch="${value}">${value}°</button>`,
      )
      .join('')
    const flightModes = FLIGHT_MODE_LIST.map(
      (item) =>
        `<button type="button" class="dcp-seg" data-action="set-flight-mode" data-mode="${item.key}">${item.label}</button>`,
    ).join('')
    const speedPresets = SPEED_SCALE_PRESETS.map(
      (item) =>
        `<button type="button" class="dcp-preset" data-action="preset-speed" data-scale="${item.value}">${item.label}</button>`,
    ).join('')
    // 全景区只在接入采集服务时出现 —— 照片要有地方归档、能被导出,这个功能才成立
    const shootSection = this.panorama
      ? `<section class="dcp-blk" data-blk="shoot">
            <div class="dcp-label">拍摄模式<em data-role="shoot-label">单张</em></div>
            <div class="dcp-segmented">
              <button type="button" class="dcp-seg is-active" data-action="set-shoot-mode" data-mode="single">单张</button>
              ${PANORAMA_MODE_LIST.map(
                (mode) =>
                  `<button type="button" class="dcp-seg" data-action="set-shoot-mode" data-mode="${mode}">${PANORAMA_PRESETS[mode].label}</button>`,
              ).join('')}
            </div>
            <p class="dcp-hint">悬停中拍摄:广角 3×3、180° 分层扫描、球形 360° 另补天顶/天底。</p>
          </section>`
      : ''

    return `
      <div class="dcp-head">
        <span class="dcp-title">${escapeHtml(this.opts.title ?? '无人机')}</span>
        <button type="button" class="dcp-icon" data-action="toggle-collapse" title="收起 / 展开" aria-label="收起或展开">–</button>
      </div>
      <div class="dcp-body">
        <div class="dcp-mid">
          <section class="dcp-blk" data-blk="flight">
            <div class="dcp-label">飞行状态<em data-role="flight-state">--</em></div>
            <div class="dcp-flight-grid">
              <button type="button" class="dcp-flight" data-action="power-on" data-role="power">上电</button>
              <button type="button" class="dcp-flight dcp-takeoff" data-action="takeoff" data-role="takeoff">起飞</button>
              <button type="button" class="dcp-flight" data-action="land" data-role="land">降落</button>
              <button type="button" class="dcp-flight dcp-rth" data-action="rth" data-role="rth">返航</button>
              <button type="button" class="dcp-flight" data-action="arm-deploy" data-role="arm-deploy">展开机臂</button>
              <button type="button" class="dcp-flight" data-action="arm-fold" data-role="arm-fold">收拢机臂</button>
            </div>
            <p class="dcp-hint" data-role="preflight"></p>
          </section>

          <section class="dcp-blk" data-blk="mode">
            <div class="dcp-label">飞行模式<em data-role="flight-mode-label">--</em></div>
            <div class="dcp-segmented">${flightModes}</div>
          </section>

          <section class="dcp-blk" data-blk="speed">
            <div class="dcp-label">
              速度倍率
              <span class="dcp-speed-val">
                <input class="dcp-num" type="number" data-role="speed-scale-input"
                  min="${SPEED_SCALE_MIN}" max="${SPEED_SCALE_MAX}" step="${SPEED_SCALE_STEP}"
                  value="${formatScale(DEFAULT_SPEED_SCALE)}" title="0 ~ ${SPEED_SCALE_MAX},数值即倍数(1 = 真机原速)" />
                <i>×</i>
              </span>
            </div>
            <input class="dcp-range" type="range" data-role="speed-scale"
              min="${SPEED_SCALE_MIN}" max="${SPEED_SCALE_MAX}" step="${SPEED_SCALE_STEP}"
              value="${formatScale(DEFAULT_SPEED_SCALE)}" title="左右拖动;0 = 机体不动,1 = 真机原速" />
            <div class="dcp-presets">${speedPresets}</div>
          </section>

          <section class="dcp-blk" data-blk="camera">
            <div class="dcp-label">相机视角<em data-role="mode-label">--</em></div>
            <div class="dcp-segmented">${modes}</div>
            <button type="button" class="dcp-wide" data-action="reset-camera">复位观察视角</button>
          </section>

          <section class="dcp-blk" data-blk="gimbal">
            <div class="dcp-label">云台俯仰<em data-role="pitch-value">--</em></div>
            <input class="dcp-range" type="range" data-role="pitch" min="${PITCH_MIN}" max="${PITCH_MAX}" step="1" value="-10" />
            <div class="dcp-presets">${presets}</div>
          </section>

          ${shootSection}
        </div>
        <p class="dcp-note" data-role="note"></p>
        <p class="dcp-keys">${this.keyboardEnabled ? '键盘  W/S 升降 · A/D 转向 · ↑/↓ 前后 · ←/→ 横滚 · Ctrl+K 拍照 · Ctrl+L 录像' : ''}</p>
      </div>
    `
  }

  /** 悬浮层:左右两根轮盘 + 右轮盘上的拍照/录像技能(位置关系由 CSS 钉死,旋转/缩放不散架) */
  private hudTemplate(): string {
    return `
      ${this.stickTemplate('left', '左杆 · 升降/偏航', [
        ['up', '升'],
        ['down', '降'],
        ['left', '左转'],
        ['right', '右转'],
      ])}
      <div class="dcp-stick" data-stick="right" title="右杆:上下前后、左右横滚(美国手 Mode 2),松杆自动回中">
        <div class="dcp-stick-base">
          <span class="dcp-stick-arrow" data-dir="up">前</span>
          <span class="dcp-stick-arrow" data-dir="down">后</span>
          <span class="dcp-stick-arrow" data-dir="left">左移</span>
          <span class="dcp-stick-arrow" data-dir="right">右移</span>
          <div class="dcp-stick-knob"></div>
          <div class="dcp-skills">
            <button type="button" class="dcp-skill dcp-skill-photo" data-action="photo" title="拍照">
              <span class="dcp-skill-ico">📷</span>
              <span class="dcp-skill-lbl">拍照</span>
              <span class="dcp-skill-badge" data-role="photo-count"></span>
            </button>
            <button type="button" class="dcp-skill dcp-skill-rec" data-action="toggle-record" data-role="toggle-record" title="开始 / 停止录像">
              <span class="dcp-skill-ico dcp-ico-rec"></span>
              <span class="dcp-skill-lbl">录像</span>
              <span class="dcp-skill-badge" data-role="rec-time"></span>
            </button>
          </div>
        </div>
        <span class="dcp-stick-cap">右杆 · 前后/横滚</span>
        <span class="dcp-stick-read" data-role="stick-read">居中</span>
      </div>
    `
  }

  /** 单根虚拟摇杆:底盘 + 十字刻度 + 四向提示 + 可按压的杆帽 + 实时读数 */
  private stickTemplate(
    side: StickSide,
    caption: string,
    marks: ReadonlyArray<readonly [string, string]>,
  ): string {
    const arrows = marks
      .map(([dir, label]) => `<span class="dcp-stick-arrow" data-dir="${dir}">${label}</span>`)
      .join('')
    const hint =
      side === 'left'
        ? '左杆:上下升降、左右偏航(美国手 Mode 2),松杆自动回中'
        : '右杆:上下前后、左右横滚(美国手 Mode 2),松杆自动回中'
    return `
      <div class="dcp-stick" data-stick="${side}" title="${hint}">
        <div class="dcp-stick-base">
          ${arrows}
          <div class="dcp-stick-knob"></div>
        </div>
        <span class="dcp-stick-cap">${caption}</span>
        <span class="dcp-stick-read" data-role="stick-read">居中</span>
      </div>
    `
  }

  private collectSticks(): StickHandle[] {
    return Array.from(this.hudLayer.querySelectorAll<HTMLElement>('.dcp-stick')).map((root) => {
      const base = root.querySelector<HTMLElement>('.dcp-stick-base')
      const knob = root.querySelector<HTMLElement>('.dcp-stick-knob')
      const read = root.querySelector<HTMLElement>('[data-role="stick-read"]')
      if (!base || !knob || !read) throw new Error('[drone-camera] 面板摇杆结构缺失')
      return {
        side: root.dataset.stick as StickSide,
        root,
        base,
        knob,
        read,
        pointerId: null,
        vertical: 0,
        lateral: 0,
        radius: 0,
        radiusSpan: 0,
      }
    })
  }

  /** 事件委托挂在指定子树上(面板与悬浮层各一份,共用 handleAction) */
  private bindActionDelegate(scope: HTMLElement): void {
    scope.addEventListener(
      'click',
      (event) => {
        const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]')
        if (target) this.handleAction(target.dataset.action ?? '', target)
      },
      { signal: this.abort.signal },
    )
  }

  private bind(): void {
    const { signal } = this.abort

    // 事件委托:面板与悬浮层各一份,减少句柄也便于整体解绑
    this.bindActionDelegate(this.root)
    this.bindActionDelegate(this.hudLayer)

    const slider = this.refs.pitchSlider
    slider.addEventListener(
      'input',
      () => {
        const value = Number(slider.value)
        this.fly.setGimbalPitch(value)
        this.renderPitch(value)
      },
      { signal },
    )
    slider.addEventListener('pointerdown', () => (this.pitchDragging = true), { signal })
    // 指针可能在面板外抬起,所以监听挂在 window 上(随 signal 一起解绑)
    window.addEventListener('pointerup', () => (this.pitchDragging = false), { signal })

    // 速度倍率:滑杆拖动即时生效(0 ~ 1000,数值即倍数);数字框可直接输入精确值
    const speedSlider = this.refs.speedSlider
    speedSlider.addEventListener('input', () => this.applySpeedScale(speedSlider.value), { signal })
    speedSlider.addEventListener('pointerdown', () => (this.speedDragging = true), { signal })
    window.addEventListener('pointerup', () => (this.speedDragging = false), { signal })

    const speedInput = this.refs.speedInput
    speedInput.addEventListener(
      'input',
      () => {
        // 用户正在删改(空串)或输入非法字符时保持原值不动,别把半截输入当成倍率下发
        if (speedInput.value.trim() === '') return
        this.applySpeedScale(speedInput.value)
      },
      { signal },
    )
    // 提交 / 失焦:把输入框归一(清掉 "3%"、"9999" 这类越界或非数字的残留)
    speedInput.addEventListener(
      'change',
      () => {
        speedInput.value = formatScale(this.fly.sim.speedScale)
        this.sync()
      },
      { signal },
    )

    // 虚拟摇杆:pointerdown 落在底盘上就锁定这个指针,之后拖到哪儿都继续跟手;
    // move/up 挂在 window 上,是因为指针移出摇杆(甚至移出画面)时事件不再冒泡到悬浮层
    this.hudLayer.addEventListener('pointerdown', (event) => this.startStick(event), { signal })
    window.addEventListener('pointermove', (event) => this.moveStick(event), { signal })
    window.addEventListener('pointerup', (event) => this.endStick(event), { signal })
    window.addEventListener('pointercancel', (event) => this.endStick(event), { signal })

    this.bindKeyboard()

    if (this.opts.syncIntervalMs !== 0) {
      this.timer = window.setInterval(() => this.sync(), this.opts.syncIntervalMs ?? 200)
    }
  }

  // ── 摇杆:按下 / 拖动 / 抬起 ──

  private startStick(event: PointerEvent): void {
    // 技能钮(拍照/录像)现在是底盘的子节点,按它们不能把杆推出去,先把这条挡掉
    const hit = event.target as HTMLElement | null
    if (hit?.closest('.dcp-skill')) return
    const base = hit?.closest<HTMLElement>('.dcp-stick-base')
    if (!base) return
    const handle = this.sticks.find((item) => item.base === base)
    if (!handle) return
    // 阻止指针默认行为,避免按住时触发文本选择 / 拖拽 / 页面滚动
    event.preventDefault()
    handle.pointerId = event.pointerId
    handle.root.classList.add('is-active')
    try {
      // 捕获后即使手指滑出底盘也继续收到事件(触摸本身有隐式捕获,鼠标则靠这句)
      handle.base.setPointerCapture(event.pointerId)
    } catch {
      // 指针已失效(如合成事件):退化为普通拖动,不影响功能
    }
    this.updateStick(handle, event.clientX, event.clientY)
  }

  private moveStick(event: PointerEvent): void {
    const handle = this.sticks.find((item) => item.pointerId === event.pointerId)
    if (!handle) return
    event.preventDefault()
    this.updateStick(handle, event.clientX, event.clientY)
  }

  private endStick(event: PointerEvent): void {
    const handle = this.sticks.find((item) => item.pointerId === event.pointerId)
    if (!handle) return
    this.resetStick(handle)
  }

  /** 把指针位置换算成摇杆行程:超出圆行程就按半径夹到边界(圆轨,和真机的物理限位一致) */
  private updateStick(handle: StickHandle, clientX: number, clientY: number): void {
    const rect = handle.base.getBoundingClientRect()
    const radius = Math.max(1, (rect.width - handle.knob.offsetWidth) / 2)
    let dx = clientX - (rect.left + rect.width / 2)
    let dy = clientY - (rect.top + rect.height / 2)
    const distance = Math.hypot(dx, dy)
    if (distance > radius) {
      const ratio = radius / distance
      dx *= ratio
      dy *= ratio
    }
    handle.knob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`

    // 屏幕 y 轴向下为正,而"推杆向前 / 上升"要求正行程,所以垂直方向取反。
    // 顺序是 死区 → 归一 → expo:先滤掉中位抖动,再压平中段行程(见 applyExpo 注释)。
    // 横滚 / 偏航用更大的死区,手指侧滑带出的微小分量直接归零,飞机才走得直。
    const vertical = applyExpo(applyDeadzone(-dy / radius, this.deadzone), this.expo)
    const lateral = applyExpo(applyDeadzone(dx / radius, this.lateralDeadzone), this.expo)

    handle.vertical = vertical
    handle.lateral = lateral
    this.applyStick()
    handle.read.textContent = formatStickText(vertical, lateral)
  }

  /** 松杆 / 销毁:行程归零 + 杆帽回中。必须成对调用,否则摇杆会"卡住"让飞机一直飞 */
  private resetStick(handle: StickHandle): void {
    handle.pointerId = null
    handle.root.classList.remove('is-active', 'is-keyboard')
    handle.knob.style.transform = ''
    handle.vertical = 0
    handle.lateral = 0
    this.applyStick()
    handle.read.textContent = formatStickText(0, 0)
    // 键盘可能还按着(甚至按的就是这根杆):把杆帽交还给键盘状态,别停在居中的画面上
    this.syncKeyboardVisuals()
  }

  /**
   * 键盘 → 屏上摇杆:把渐进行程画到杆帽上(位移 + 高亮 + 读数),按键时看起来就像有人在替你打杆。
   * 手指正按着的杆跳过 —— 那根杆的视觉由 updateStick 跟手绘制,键盘不该来抢。
   */
  private syncKeyboardVisuals(): void {
    if (this.destroyed) return
    const kb = this.keyboardStick
    for (const handle of this.sticks) {
      if (handle.pointerId !== null) continue
      const vertical = handle.side === 'left' ? kb.throttle : kb.pitch
      const lateral = handle.side === 'left' ? kb.yaw : kb.roll
      const active = Math.abs(vertical) > 0.005 || Math.abs(lateral) > 0.005
      this.paintStick(handle, vertical, lateral, active)
    }
  }

  /**
   * 画一根杆的杆帽位置:行程 ±1 直接映射到圆轨半径(上 / 右为正),与 formatStickText 的方向约定一致。
   * 半径按底盘边长缓存 —— 键盘每 ~16ms 刷一次,不能每次都去读布局(会引发布局抖动);
   * 换屏 / 旋转导致杆径变化时,边长对不上会自动重测。
   */
  private paintStick(
    handle: StickHandle,
    vertical: number,
    lateral: number,
    active: boolean,
  ): void {
    const span = handle.base.offsetWidth
    if (span !== handle.radiusSpan) {
      handle.radiusSpan = span
      handle.radius = Math.max(1, (span - handle.knob.offsetWidth) / 2)
    }
    const dx = clampUnit(lateral) * handle.radius
    // 屏幕 y 轴向下为正,而"推杆向前 / 上升"要求向上,所以垂直方向取反(与 updateStick 同一套约定)
    const dy = -clampUnit(vertical) * handle.radius
    handle.knob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`
    handle.root.classList.toggle('is-keyboard', active)
    handle.root.classList.toggle('is-active', active)
    handle.read.textContent = formatStickText(vertical, lateral)
  }

  /**
   * 把「摇杆 + 键盘」合成后写进飞控 —— 唯一的 setStick 出口。
   *
   * 合成规则是**摇杆优先**:某根杆正被按住时,该杆的两个通道只听摇杆;
   * 没被按住的杆才交给键盘。于是双指打杆时键盘不会来抢,松开手指后键盘又能接手。
   * 偏航通道在这里统一乘 yawRateScale(真机挡位角速度在屏幕上偏快,见选项注释)。
   */
  private applyStick(): void {
    if (this.destroyed) return
    const left = this.sticks.find((item) => item.side === 'left')
    const right = this.sticks.find((item) => item.side === 'right')
    const holding = (handle: StickHandle | undefined) => handle != null && handle.pointerId !== null
    const kb = this.keyboardStick
    const throttle = holding(left) ? left!.vertical : kb.throttle
    const yaw = holding(left) ? left!.lateral : kb.yaw
    const pitch = holding(right) ? right!.vertical : kb.pitch
    const roll = holding(right) ? right!.lateral : kb.roll
    this.fly.setStick({
      throttle: clampUnit(throttle),
      pitch: clampUnit(pitch),
      roll: clampUnit(roll),
      yaw: clampUnit(yaw) * this.yawRateScale,
    })
  }

  // ── 键盘:与屏上双摇杆等价的第二套输入 ──

  private bindKeyboard(): void {
    if (!this.keyboardEnabled) return
    const { signal } = this.abort
    window.addEventListener('keydown', (event) => this.onKey(event, true), { signal })
    window.addEventListener('keyup', (event) => this.onKey(event, false), { signal })
    // 切走窗口 / 失焦时把所有键松开,否则回来时飞机会朝一个方向一直飞
    window.addEventListener('blur', () => this.releaseKeyboard(), { signal })
    this.lastKeyboardTick = performance.now()
    this.keyboardTimer = window.setInterval(() => this.tickKeyboard(), KEYBOARD_TICK_MS)
  }

  private onKey(event: KeyboardEvent, down: boolean): void {
    // 输入框 / 可编辑区里的按键归宿主(敲字不该顺带让飞机动作)
    if (isTypingTarget(event.target)) return

    // Ctrl / Cmd + K L:拍照 / 录像。只在按下那一次触发(长按连发的 keydown 与 keyup 都吃掉),
    // 这样按住 Ctrl+K 不会连拍。preventDefault 是为了让宿主页面的同名快捷键让位。
    if (event.ctrlKey || event.metaKey) {
      const shortcut = KEY_SHORTCUTS[event.code]
      if (!shortcut) return
      event.preventDefault()
      if (!down || event.repeat || event.altKey) return
      this.runShortcut(shortcut)
      return
    }

    if (!KEY_BINDINGS[event.code]) return
    // 其余组合键留给浏览器 / 宿主快捷键
    if (event.altKey) return
    if (down) this.pressedKeys.add(event.code)
    else this.pressedKeys.delete(event.code)
    // 方向键默认会滚动页面,按住时尤其明显
    event.preventDefault()
  }

  /** 跑一个组合键动作:与点技能钮同一条路径,保证角标 / 计时 / 回调行为一致 */
  private runShortcut(shortcut: PanelShortcut): void {
    if (this.destroyed) return
    if (shortcut === 'photo') {
      void this.takePhoto()
      return
    }
    void this.toggleRecording()
  }

  /** 把按键状态渐推/渐回成行程;有变化才写飞控,静止时零开销 */
  private tickKeyboard(): void {
    if (this.destroyed) return
    const now = performance.now()
    const delta = Math.min(0.1, Math.max(0, (now - this.lastKeyboardTick) / 1000))
    this.lastKeyboardTick = now
    if (delta <= 0) return

    // 同一帧可能同时按着同通道的两个键(如 ← 与 Q),按符号叠加后夹回 ±1
    const goal: Record<StickChannel, number> = { throttle: 0, yaw: 0, pitch: 0, roll: 0 }
    for (const code of this.pressedKeys) {
      const bind = KEY_BINDINGS[code]
      if (!bind) continue
      goal[bind.channel] = clampUnit(goal[bind.channel] + bind.sign)
    }

    let changed = false
    for (const channel of STICK_CHANNELS) {
      const current = this.keyboardStick[channel]
      const target = goal[channel]
      if (current === target) continue
      const step = delta / (target === 0 ? this.keyboardFall : this.keyboardRise)
      const next =
        Math.abs(target - current) <= step ? target : current + Math.sign(target - current) * step
      this.keyboardStick[channel] = next
      changed = true
    }
    if (!changed) return
    this.applyStick()
    // 杆帽同步跟着键位走:不然只有飞机在动、HUD 上两根杆一动不动,看着像没生效
    this.syncKeyboardVisuals()
  }

  /** 松开全部键盘行程(失焦 / 销毁) */
  private releaseKeyboard(): void {
    this.pressedKeys.clear()
    let changed = false
    for (const channel of STICK_CHANNELS) {
      if (this.keyboardStick[channel] !== 0) {
        this.keyboardStick[channel] = 0
        changed = true
      }
    }
    if (!changed) return
    this.applyStick()
    this.syncKeyboardVisuals()
  }

  private stopKeyboard(): void {
    if (this.keyboardTimer !== null) {
      window.clearInterval(this.keyboardTimer)
      this.keyboardTimer = null
    }
  }

  /** 两杆全部归零(销毁 / 外部打断时用) */
  private releaseSticks(): void {
    this.sticks.forEach((handle) => this.resetStick(handle))
  }

  /**
   * 摇杆读数对齐引擎真值。正被按住的杆跳过 —— 它在跟手,回写会与用户输入打架。
   */
  private syncStickReadout(): void {
    const stick = this.fly.sim.stick
    for (const handle of this.sticks) {
      if (handle.pointerId !== null) continue
      const vertical = handle.side === 'left' ? stick.throttle : stick.pitch
      // 读数是"杆位"语义:飞控里的偏航是缩放后的值,显示前还原回杆位
      const lateral = handle.side === 'left' ? stick.yaw / (this.yawRateScale || 1) : stick.roll
      handle.read.textContent = formatStickText(vertical, lateral)
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }

  private renderPitch(value: number): void {
    this.refs.pitchValue.textContent = `${Math.round(value)}°`
  }

  /**
   * 下发速度倍率并同步两个控件。
   *
   * 真值以飞控为准(`sim.setSpeedScale` 内部夹到 0 ~ 1000),回写用夹紧后的值。
   * ⚠️ 数字框**聚焦期间不回写**:归一化会抹掉用户刚敲的小数点("2." → "2"),
   * 之后再敲 "5" 就成了 25;归一交给 change(失焦 / 回车)。
   */
  private applySpeedScale(raw: string | number): void {
    const value = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(value)) return
    this.fly.sim.setSpeedScale(value)
    const applied = this.fly.sim.speedScale
    if (!this.speedDragging) this.refs.speedSlider.value = String(applied)
    if (document.activeElement !== this.refs.speedInput) {
      this.refs.speedInput.value = formatScale(applied)
    }
    this.setNote(
      applied === 0
        ? '速度倍率 0×:机体不会移动(含自动起飞 / 降落)'
        : `速度倍率 ${formatScale(applied)}×`,
    )
  }

  /** 把倍率刷到滑杆与数字框上(轮询同步用;拖动滑杆 / 正在输入时跳过,免得和用户的手打架) */
  private renderSpeedScale(value: number): void {
    if (!this.speedDragging) this.refs.speedSlider.value = String(value)
    if (document.activeElement !== this.refs.speedInput) {
      this.refs.speedInput.value = formatScale(value)
    }
  }

  private setNote(text: string): void {
    this.refs.note.textContent = text
  }

  private handleAction(action: string, el: HTMLElement): void {
    if (this.destroyed) return

    switch (action) {
      case 'power-on':
        this.fly.powerOn()
        this.setNote('已上电:自检 + 预热完成后(待机)即可起飞')
        this.sync()
        break
      case 'takeoff':
        if (this.fly.takeOff()) this.setNote('起飞:自动上升至 1.2 米')
        else this.setNote('起飞未受理:需等自检/预热到「地面待机」,且起飞前检查通过')
        this.sync()
        break
      case 'land':
        if (this.fly.land()) this.setNote('开始自动降落')
        else this.setNote('降落未受理:需在空中或起飞爬升中')
        this.sync()
        break
      case 'rth':
        if (this.fly.returnHome('面板按钮')) this.setNote('已触发智能返航')
        else this.setNote('返航未受理:需在空中(已在返航中也会被忽略)')
        this.sync()
        break
      case 'arm-deploy':
        this.fly.setArmsFolded(false)
        this.setNote('机臂展开中,桨叶随后张开')
        this.sync()
        break
      case 'arm-fold':
        this.fly.setArmsFolded(true)
        this.setNote('机臂收拢中')
        this.sync()
        break
      case 'set-flight-mode': {
        const mode = el.dataset.mode as FlightMode | undefined
        if (!mode) return
        this.fly.setMode(mode)
        this.sync()
        break
      }
      case 'set-mode': {
        const mode = el.dataset.mode as CameraMode | undefined
        if (!mode) return
        this.fly.setCameraMode(mode)
        this.sync()
        break
      }
      case 'reset-camera':
        this.fly.resetCamera()
        this.sync()
        break
      case 'preset-pitch': {
        const pitch = Number(el.dataset.pitch)
        if (!Number.isFinite(pitch)) return
        this.fly.setGimbalPitch(pitch)
        this.sync()
        break
      }
      case 'preset-speed': {
        const scale = Number(el.dataset.scale)
        if (!Number.isFinite(scale)) return
        this.applySpeedScale(scale)
        this.sync()
        break
      }
      case 'photo':
        void this.takePhoto()
        break
      case 'set-shoot-mode': {
        if (this.panorama?.running) break
        const mode = el.dataset.mode as ShootMode | undefined
        if (!mode) break
        this.shootMode = mode
        this.syncShootMode()
        break
      }
      case 'toggle-record':
        void this.toggleRecording()
        break
      case 'toggle-collapse':
        this.setCollapsed(!this.collapsed)
        break
      default:
        break
    }
  }

  private async takePhoto(): Promise<void> {
    if (this.photoBusy || this.destroyed) return
    // 全景模式:拍照钮变成"开始 / 停止整组扫描"的开关(与大疆的拍摄模式语义一致)
    if (this.shootMode !== 'single') {
      await this.runPanorama()
      return
    }
    this.photoBusy = true
    this.setNote('拍照中…')
    try {
      const shot = await this.fly.requestPhoto()
      if (!shot) {
        this.setNote('拍照失败:相机未就绪')
        return
      }
      if (this.opts.onPhoto) this.opts.onPhoto(shot)
      else if (this.opts.autoDownload !== false)
        triggerDownload(shot.dataUrl, `drone-photo-${stamp()}.png`)
      this.setNote(`已拍摄 ${shot.width}×${shot.height}`)
    } catch (error) {
      this.setNote(`拍照异常:${(error as Error).message}`)
    } finally {
      this.photoBusy = false
    }
  }

  /**
   * 全景拍摄:点一次开始整组网格扫描,再点一次请求停止(见 `PanoramaCapture`)。
   * 面板只负责挑会话与播报 —— 网格、逐张取景、方位复位都在库里,这里不碰渲染后端。
   */
  private async runPanorama(): Promise<void> {
    const pano = this.panorama
    const service = this.opts.captureService
    if (!pano || !service) return
    if (pano.running) {
      pano.cancel()
      this.setNote('正在停止全景拍摄…')
      return
    }
    const mode = this.shootMode as PanoramaMode
    const preset = PanoramaCapture.preset(mode, service.getCaptureIntrinsics()?.verticalFovDeg)
    // 全景靠**机体原地自转**补水平视野(云台 Pan 只有 ±30°),所以必须悬停中拍:
    // 在地面或航线中自转不成立,真机也是这个前提。提前挡住,免得出 21 张同一方位的废片。
    if (this.fly.phase !== 'flying') {
      this.setNote('全景需要定点悬停中拍摄(请先起飞并停止航线)')
      return
    }
    // 没有会话就现建一个:全景是"拍一组照片",总得有地方归档
    const session =
      service.activeSession ??
      service.createSession({ source: 'virtual-camera', name: `全景-${stamp()}` })
    this.photoBusy = true
    this.setNote(`${preset.label} 扫描中 0/${preset.total}…`)
    try {
      const result = await pano.start(session.id, mode)
      if (!result) this.setNote('全景启动失败(可能已有扫描在进行)')
      else if (result.error) this.setNote(`全景未完成:${result.error}`)
      else if (result.cancelled) this.setNote(`全景已停止(${result.captured}/${result.total})`)
      else
        this.setNote(
          `${preset.label} 完成 ${result.captured}/${result.total}${result.stitched ? ' · 已拼接' : ''}`,
        )
    } catch (error) {
      this.setNote(`全景异常:${(error as Error).message}`)
    } finally {
      this.photoBusy = false
      this.sync()
    }
  }

  private async toggleRecording(): Promise<void> {
    if (this.destroyed) return

    if (this.fly.isRecording) {
      this.setNote('正在收尾…')
      this.lastRecordSeconds = this.fly.sim.recordSeconds
      const blob = await this.fly.stopRecording()
      if (!blob) {
        this.setNote('录像为空,未保存')
      } else {
        if (this.opts.onRecording) this.opts.onRecording(blob, this.lastRecordSeconds)
        else if (this.opts.autoDownload !== false)
          triggerDownload(URL.createObjectURL(blob), `drone-video-${stamp()}.webm`)
        this.setNote(`已保存 ${this.lastRecordSeconds.toFixed(1)}s`)
      }
      this.sync()
      return
    }

    if (!this.fly.startRecording()) {
      this.setNote('当前环境不支持录像(需要 MediaRecorder)')
      return
    }
    this.setNote('录制中(云台取景),停止后自动保存')
    this.sync()
  }
}
