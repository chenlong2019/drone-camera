/**
 * 飞控源切换器 —— 让同一个场景在内置模型与外部飞控之间来回切。
 *
 * 为什么需要它:本库有两套完全不同的飞控来源
 *   1. 内置 `DroneSim`:自己积分姿态/电量/失效保护,零依赖,开箱即用;
 *   2. 外部 MAVLink(PX4 / ArduPilot,真机或 SITL):真固件算出位姿,本库只负责显示与下发。
 *
 * 两者的接管界面都是 `DroneSim` 实例本身(见 `attachExternalSource`),所以**面板、鹰眼图、
 * 采集服务、两个渲染后端都不需要知道当前是谁在飞**。这个类只做三件事:
 *   - 建/拆 `MavlinkSource` 会话;
 *   - 切换失败时保证回到内置模型(否则面板按钮会被派发给一条不存在的链路,界面"看着能点但不动");
 *   - 把「当前是哪个源、链路通不通」统一成一份可订阅的状态。
 *
 * 典型用法:
 * ```ts
 * const sources = new FlightSourceManager({ sim: drone.sim, onChange: renderChip })
 * await sources.useMavlink('ws://127.0.0.1:8118')  // 接 PX4 / SITL
 * await sources.useInternal()                        // 交还内置模型(空中会继续悬停)
 * ```
 */

import { MavlinkSource, type MavlinkLinkStatus, type MavlinkSourceOptions } from './drone-mavlink-source'
import type { DroneSim } from './drone-sim'

/** 飞控来源:内置模型 / 外部 MAVLink(PX4、ArduPilot、SITL) */
export type FlightSourceKind = 'internal' | 'mavlink'

/** 可订阅的源状态快照(宿主用来刷新按钮文案与指示灯) */
export interface FlightSourceState {
  kind: FlightSourceKind
  /** 外部源地址;内置模型时为 null */
  url: string | null
  /** 链路状态(仅 kind === 'mavlink' 时有值) */
  status: MavlinkLinkStatus | null
  /** 最近一次切换失败的原因;成功则为 null */
  error: Error | null
}

export interface FlightSourceManagerOptions {
  /** 被接管的仿真内核。两个渲染后端与全部面板读的都是它,所以只需这一个接入点 */
  sim: DroneSim
  /**
   * 外部源默认地址。缺省 `ws://127.0.0.1:8118`(与 `mavlink/bridge.mjs` 的缺省端口一致)。
   * 首次 `useMavlink()` 不传参数时用它。
   */
  mavlinkUrl?: string
  /** 建连参数(超时、起飞高度、CRC 模式等);`url` 由本类接管 */
  mavlink?: Omit<MavlinkSourceOptions, 'url' | 'onStatus'>
  /** 状态变化回调:切换、连接成功、心跳上报都会触发 */
  onChange?: (state: FlightSourceState) => void
}

const DEFAULT_MAVLINK_URL = 'ws://127.0.0.1:8118'

export class FlightSourceManager {
  private readonly sim: DroneSim
  private readonly options: FlightSourceManagerOptions
  private readonly defaultUrl: string

  private source: MavlinkSource | null = null
  private current: FlightSourceKind = 'internal'
  private url: string | null = null
  private status: MavlinkLinkStatus | null = null
  private error: Error | null = null

  constructor(options: FlightSourceManagerOptions) {
    this.sim = options.sim
    this.options = options
    this.defaultUrl = options.mavlinkUrl ?? DEFAULT_MAVLINK_URL
    this.url = options.mavlinkUrl ?? null
  }

  /** 当前源 */
  get kind(): FlightSourceKind {
    return this.current
  }

  /** 上次使用(或将要使用)的外部地址;切回外部时复用 */
  get mavlinkUrl(): string | null {
    return this.url
  }

  /** 最近一次上报的链路状态 */
  get linkStatus(): MavlinkLinkStatus | null {
    return this.status
  }

  /** 最近一次失败原因(成功后清空) */
  get lastError(): Error | null {
    return this.error
  }

  /** 是否正接管着外部源(不代表链路健康) */
  get attached(): boolean {
    return this.source !== null
  }

  get state(): FlightSourceState {
    return {
      kind: this.current,
      url: this.current === 'mavlink' ? this.url : null,
      status: this.status,
      error: this.error,
    }
  }

  /**
   * 切到外部飞控。已连着同一个地址时是幂等的。
   *
   * 失败会**自动回退内置模型**并抛出错误 —— 这条比"连上了"更重要:
   * 一条连不上的链路如果还挂着接管,面板上所有按钮都会被派发给它,飞机会一动不动。
   */
  async useMavlink(url?: string): Promise<void> {
    const target = url ?? this.url ?? this.defaultUrl
    if (this.source && this.current === 'mavlink' && target === this.url) return

    await this.closeSource()
    this.error = null

    const source = new MavlinkSource({
      ...this.options.mavlink,
      url: target,
      onStatus: (status) => {
        this.status = status
        this.emit()
      },
    })
    // 接管点在内核:面板与两个渲染后端一行都不用改
    source.attach(this.sim)
    this.source = source
    this.url = target
    this.current = 'mavlink'
    this.emit()

    try {
      await source.connect()
    } catch (error: unknown) {
      this.error = error instanceof Error ? error : new Error('MAVLink 连接失败')
      // 回退:交还内置模型,让界面立刻恢复可操作
      await this.closeSource()
      this.emit()
      throw this.error
    }
  }

  /** 切回内置模型。空中交接会保持悬停(见 `DroneSim.detachExternalSource`) */
  async useInternal(): Promise<void> {
    if (!this.source && this.current === 'internal') return
    await this.closeSource()
    this.error = null
    this.emit()
  }

  /** 一键互换,返回切换后的源 */
  async toggle(): Promise<FlightSourceKind> {
    if (this.current === 'mavlink') await this.useInternal()
    else await this.useMavlink()
    return this.current
  }

  /** 释放会话(宿主销毁时调用;可重复调用) */
  destroy(): void {
    void this.closeSource()
  }

  private async closeSource(): Promise<void> {
    const source = this.source
    this.source = null
    this.status = null
    this.current = 'internal'
    // close() 内部会 detach,顺序反了会有一段"源已断但仍接管"的窗口,面板指令会打到空链路
    if (source) await source.close()
  }

  private emit(): void {
    this.options.onChange?.(this.state)
  }
}
