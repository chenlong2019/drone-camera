/**
 * 图传发布端(视频同传)—— 把机载画面推到局域网中转,别的设备打开网页就能看。
 *
 * 设计边界很清楚:这里**不做编码、不做渲染**。帧从 `DroneFly.requestVideoFrame()` 来
 * (已经是 640×360 的 JPEG 字节),本类只负责"连上中转 / 按背压推帧 / 报状态"。
 *
 * 三个约束决定了现在的写法:
 * 1. **背压丢帧,不排队**。`ws.bufferedAmount` 是有尽头的:链路只有 2 Mbps 而画面要 3 Mbps 时,
 *    排队的后果不是"卡",而是"延迟越滚越大"——看着像画面在放慢动作。超过 `maxBacklogBytes`
 *    直接丢这一帧并计数,延迟才能钉住。
 * 2. **OSD 走文本通道**。飞行数据每秒变几次,没必要塞进每帧 JPEG 里(也不能塞),
 *    中转会把文本原样扇出,观看页叠在画面上就是真机那种 OSD。
 * 3. **断线要能自愈**。手机切换 Wi-Fi、电脑休眠都会断;重连由本类负责,
 *    调用方只需要在 `onState` 里刷新按钮文案。
 *
 * ```ts
 * const link = new VideoDownlink()               // 默认 ws://<当前 host>:8130/ws
 * await link.connect()
 * const shot = await drone.requestVideoFrame()
 * if (shot) link.pushFrame(shot.data)            // ArrayBuffer → WebSocket 二进制帧
 * link.sendOsd({ alt: 12.3, speed: 4.1, ... })
 * ```
 */

/** 中转默认端口:与 `video-link/relay.mjs` 的缺省端口一致 */
export const VIDEO_LINK_DEFAULT_PORT = 8130

/** 单个观看端的 WebRTC 统计(发布端侧采样) */
export interface WebRtcViewerStat {
  /** 观看端 id(中转分配,信令路由用) */
  id: string
  /** 实际发送码率(kbps,两次采样差分) */
  kbps: number
  /** 编码帧率 */
  fps: number
  /** 发送分辨率(宽×高) */
  resolution: string
  /** 累计丢包(RTCP 反馈) */
  packetsLost: number
  /** 往返时延(ms);拿不到时为 null */
  rttMs: number | null
  /** 编码器受限原因:none / bandwidth / cpu / other */
  limitation: string
  /** 连接状态:connected / connecting / failed … */
  state: string
}

/** 图传链路状态(宿主用来刷新按钮 / 浮层) */
export interface VideoLinkState {
  status: 'idle' | 'connecting' | 'live' | 'error'
  /** 当前(或将要)连接的中转地址 */
  url: string | null
  /** 正在看的人数(中转广播) */
  viewers: number
  /** 中转测得的实际上行帧率 */
  fps: number
  /** 中转测得的实际上行码率(kbps) */
  kbps: number
  /** 本地已推帧数 */
  sentFrames: number
  /** 本地因背压丢掉的帧数 */
  droppedFrames: number
  /** 局域网观看地址(由中转下发,发布端页面要显示"手机打开这个") */
  watchUrls: string[]
  /** 最近一次错误(连不上 / 被顶掉) */
  error: string | null
  /** WebRTC 通道是否已开启(开关 ≠ 有人连上,人数看 webrtcViewers) */
  webrtcEnabled: boolean
  /** WebRTC 已连通的观看端数 */
  webrtcViewers: number
  /** 每个 WebRTC 观看端的实时统计 */
  webrtcStats: WebRtcViewerStat[]
}

/** 叠加在画面上的飞行数据(观看页的 OSD) */
export interface VideoLinkOsd {
  /** 相对起飞点高度(米) */
  alt: number
  /** 地速(米/秒) */
  speed: number
  /** 航向(度,0 = 正北) */
  heading: number
  /** 电量百分比 */
  battery: number
  /** 飞行模式 / 挡位文案 */
  mode: string
  /** 卫星数 */
  satellites: number
  /** 云台俯仰(度),可选 */
  gimbalPitch?: number
  /** 是否在录像 */
  recording?: boolean
  /** 时间戳(毫秒),观看端可据此判断 OSD 是否过期 */
  ts?: number
}

export interface VideoLinkOptions {
  /** 中转地址(ws://host:port/ws);缺省按当前页面 host 推导 */
  url?: string
  /** 断线自动重连间隔(毫秒);0 表示不自动重连 */
  reconnectDelayMs?: number
  /** 上行积压上限(字节):超过就丢帧,默认 384 KB */
  maxBacklogBytes?: number
  /**
   * WebRTC 的 ICE 服务器。局域网直连留空(默认)即可——host candidate 直接可达;
   * 跨网段/公网才需要 STUN(如 `{ urls: 'stun:stun.l.google.com:19302' }`)。
   */
  iceServers?: RTCIceServer[]
  /** WebRTC 视频轨最大码率(bit/s),默认 2.5 Mbps */
  webrtcMaxBitrate?: number
  /** 状态变化回调(连接、统计、错误都会触发) */
  onState?: (state: VideoLinkState) => void
}

/** 默认中转地址:`ws://<当前页面 hostname>:8130/ws` —— 换机器访问页面时不用改配置 */
export function defaultVideoLinkUrl(port = VIDEO_LINK_DEFAULT_PORT): string {
  const host =
    typeof window !== 'undefined' && window.location?.hostname ? window.location.hostname : '127.0.0.1'
  return `ws://${host}:${port}/ws`
}

const CONNECT_TIMEOUT_MS = 4000

export class VideoDownlink {
  private readonly options: VideoLinkOptions
  private socket: WebSocket | null = null
  private url: string | null = null
  private manualClose = false
  private reconnectTimer: number | null = null
  private state: VideoLinkState = {
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

  // ————— WebRTC(信令走同一条中转连接,媒体走 P2P SRTP/UDP) —————

  /** 每个观看端一条 PeerConnection,键是中转分配的观看端 id */
  private peers = new Map<string, RTCPeerConnection>()
  /** 注入的视频轨道(来自 DroneFly.createVideoStream) */
  private videoStream: MediaStream | null = null
  private webrtcOn = false
  private webrtcMaxBitrate: number
  private readonly iceServers: RTCIceServer[]
  /** 统计轮询(2 Hz;码率要做差分,轮询间隔就是分母) */
  private statsTimer: number | null = null
  private lastBytes = new Map<string, number>()
  private lastStatsAt = 0
  /** 最近一次采样结果:touchStats() 用它做即时快照,避免闪零 */
  private statsCache: WebRtcViewerStat[] = []

  constructor(options: VideoLinkOptions = {}) {
    this.options = options
    this.url = options.url ?? defaultVideoLinkUrl()
    this.state.url = this.url
    this.iceServers = options.iceServers ?? []
    this.webrtcMaxBitrate = options.webrtcMaxBitrate ?? 2_500_000
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  /** 已推帧 / 已丢帧,宿主可用来判断是链路问题还是渲染问题 */
  get counters(): { sent: number; dropped: number } {
    return { sent: this.state.sentFrames, dropped: this.state.droppedFrames }
  }

  /** 当前状态快照(只读副本) */
  get snapshot(): VideoLinkState {
    return { ...this.state, watchUrls: [...this.state.watchUrls] }
  }

  /**
   * 连接中转(发布端角色)。已连上时幂等。
   *
   * 失败会抛错并把 status 置成 `error`:面板据此提示"中转没启动",
   * 而不是让用户对着一个永远不动的画面猜。
   */
  async connect(url?: string): Promise<void> {
    const target = url ?? this.url ?? defaultVideoLinkUrl()
    if (this.socket && this.url === target && this.connected) return
    this.close(false)
    this.manualClose = false
    this.url = target
    this.setState({ status: 'connecting', url: target, error: null })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let socket: WebSocket
      try {
        socket = new WebSocket(`${target}${target.includes('?') ? '&' : '?'}role=pub`)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '无法创建 WebSocket'
        this.setState({ status: 'error', error: message })
        reject(new Error(message))
        return
      }
      socket.binaryType = 'arraybuffer'
      const timer = window.setTimeout(() => {
        if (settled) return
        settled = true
        socket.close()
        const message = `连接超时:${target}(图传中转没启动?)`
        this.setState({ status: 'error', error: message })
        reject(new Error(message))
      }, CONNECT_TIMEOUT_MS)

      socket.onopen = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        this.socket = socket
        this.setState({ status: 'live', url: target, error: null })
        // 重连场景:开关还开着,重新告诉观看端"WebRTC 可用",并恢复统计轮询
        if (this.webrtcOn) {
          this.sendSignal({ t: 'rtc-available' })
          this.startStatsPolling()
        }
        resolve()
      }
      socket.onerror = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        const message = `连不上图传中转:${target}`
        this.setState({ status: 'error', error: message })
        reject(new Error(message))
      }
      socket.onmessage = (event) => this.onMessage(event)
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null
        // 中转断了:PeerConnection 不受影响(媒体是 P2P),但信令没了,留着也无法协商新观看端
        this.teardownPeers()
        if (this.manualClose) {
          this.setState({ status: 'idle', fps: 0, kbps: 0, viewers: 0 })
          return
        }
        this.setState({ status: 'error', fps: 0, kbps: 0, viewers: 0, error: '图传链路断开' })
        this.scheduleReconnect()
      }
    })
  }

  /**
   * 推一帧。返回 false 表示这一帧没发出去(未连接 / 背压丢弃)。
   *
   * 背压的判定放在**发送前**:`bufferedAmount` 已经积压就意味着链路比画面慢,
   * 这时唯一正确的动作是丢帧 —— 排进队列只会让观看端看到越来越旧的画面。
   */
  pushFrame(data: ArrayBuffer): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    const limit = this.options.maxBacklogBytes ?? 384 * 1024
    if (socket.bufferedAmount > limit) {
      this.setState({ droppedFrames: this.state.droppedFrames + 1 })
      return false
    }
    socket.send(data)
    this.setState({ sentFrames: this.state.sentFrames + 1 })
    return true
  }

  /** 发一份 OSD(文本通道);飞行数据变化频率低,调用方按 2~5 Hz 调即可 */
  sendOsd(osd: VideoLinkOsd): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    // bufferedAmount 里混着画面帧,OSD 很小,积压时也不该被丢弃(它决定 OSD 新不新)
    socket.send(JSON.stringify({ t: 'osd', ...osd, ts: osd.ts ?? Date.now() }))
  }

  /** 主动断开(不触发重连) */
  close(notify = true): void {
    this.manualClose = true
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.teardownPeers()
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onclose = null
      socket.onerror = null
      socket.onmessage = null
      try {
        socket.close()
      } catch {
        /* 已经关了 */
      }
    }
    if (notify) this.setState({ status: 'idle', fps: 0, kbps: 0, viewers: 0 })
  }

  /**
   * 开启 WebRTC 通道(信令走中转,媒体走 P2P SRTP/UDP)。
   *
   * 与 M-JPEG 的关系是**并行而非替代**:中转的 JPEG 广播继续跑,
   * 观看端先拿 M-JPEG 兜底画面,WebRTC 连通后切过去 —— 任何一环失败都不黑屏。
   * `video` 来自 `DroneFly.createVideoStream()`;先开通道后给流也行(见 `setVideoStream`)。
   */
  enableWebRtc(video?: MediaStream | null): void {
    this.webrtcOn = true
    if (video !== undefined) this.videoStream = video
    this.setState({ webrtcEnabled: true })
    // 通知已在等待的观看端:现在可以发起协商了(观看端收到 rtc-available 才发 rtc-hello)
    this.sendSignal({ t: 'rtc-available' })
    this.startStatsPolling()
  }

  /** 关闭 WebRTC 通道并断开所有观看端的 PeerConnection(M-JPEG 不受影响) */
  disableWebRtc(): void {
    this.webrtcOn = false
    this.sendSignal({ t: 'rtc-unavailable' })
    this.teardownPeers()
    this.setState({ webrtcEnabled: false })
  }

  get webRtcEnabled(): boolean {
    return this.webrtcOn
  }

  /** 热替换视频轨道:已建立的连接用 replaceTrack,不用重新协商 */
  setVideoStream(stream: MediaStream | null): void {
    this.videoStream = stream
    const track = stream?.getVideoTracks()[0] ?? null
    for (const pc of this.peers.values()) {
      const sender = pc.getSenders().find((item) => item.track?.kind === 'video') ?? pc.getSenders()[0]
      void sender?.replaceTrack(track).catch(() => {
        /* 轨道已死等噪音,连接失败会走 connectionState 兜底 */
      })
    }
  }

  // ————— WebRTC 内部 —————

  private sendSignal(value: Record<string, unknown>): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(value))
  }

  /** 观看端请求协商:建 PeerConnection → 挂轨道 → 出 offer */
  private async handleHello(from: string): Promise<void> {
    const stream = this.videoStream
    const track = stream?.getVideoTracks()[0]
    if (!this.webrtcOn || !stream || !track || track.readyState !== 'live') {
      this.sendSignal({ t: 'rtc-unavailable', to: from })
      return
    }
    this.dropPeer(from)
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    this.peers.set(from, pc)
    pc.onicecandidate = (event) => {
      if (event.candidate) this.sendSignal({ t: 'rtc-ice', to: from, candidate: event.candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      // failed 就清掉:观看端会回退 M-JPEG,重试由观看端在下一次 rtc-hello 发起
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.dropPeer(from)
      else this.touchStats()
    }
    const sender = pc.addTrack(track, stream)
    // 探针实测:不设上限时带宽估计会在开局压低码率并把分辨率砍半;
    // 显式钉住 maxBitrate + 禁止降采样,画质交给 maxBitrate 一个旋钮控制
    const params = sender.getParameters()
    const encodings = params.encodings?.length ? params.encodings : [{}]
    const encoding = encodings[0]
    if (encoding) {
      encoding.maxBitrate = this.webrtcMaxBitrate
      encoding.scaleResolutionDownBy = 1
    }
    params.encodings = encodings
    try {
      await sender.setParameters(params)
    } catch {
      /* 个别实现拒绝自定义 encodings,忽略:还有拥塞控制兜底 */
    }
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.sendSignal({ t: 'rtc-offer', to: from, sdp: pc.localDescription?.sdp })
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : 'offer 失败'
      this.dropPeer(from)
      this.setState({ error: `WebRTC 协商失败:${detail}` })
    }
    this.touchStats()
  }

  private async handleAnswer(from: string, sdp: unknown): Promise<void> {
    const pc = this.peers.get(from)
    if (!pc || typeof sdp !== 'string' || pc.signalingState === 'stable') return
    await pc.setRemoteDescription({ type: 'answer', sdp }).catch(() => this.dropPeer(from))
  }

  private async handleIce(from: string, candidate: unknown): Promise<void> {
    const pc = this.peers.get(from)
    if (!pc) return
    // candidate 为 null/undefined 是 end-of-candidates 信号,addIceCandidate(null) 合法
    await pc.addIceCandidate((candidate ?? null) as RTCIceCandidateInit | null).catch(() => {
      /* candidate 晚到等噪音,忽略 */
    })
  }

  private dropPeer(id: string): void {
    const pc = this.peers.get(id)
    if (!pc) return
    this.peers.delete(id)
    this.lastBytes.delete(id)
    try {
      pc.close()
    } catch {
      /* 已经关了 */
    }
    this.touchStats()
  }

  /** 只清连接,不动开关与视频流(WS 断线重连后能直接恢复) */
  private teardownPeers(): void {
    for (const pc of this.peers.values()) {
      try {
        pc.close()
      } catch {
        /* 已经关了 */
      }
    }
    this.peers.clear()
    this.lastBytes.clear()
    this.statsCache = []
    this.stopStatsPolling()
    this.setState({ webrtcViewers: 0, webrtcStats: [] })
  }

  /** 连接状态变化的即时反馈:从缓存抄一份数值,只刷新 state 字段 */
  private touchStats(): void {
    const cache = new Map(this.statsCache.map((item) => [item.id, item]))
    const list: WebRtcViewerStat[] = [...this.peers.keys()].map((id) => {
      const pc = this.peers.get(id)
      return (
        cache.get(id) ?? {
          id,
          kbps: 0,
          fps: 0,
          resolution: '',
          packetsLost: 0,
          rttMs: null,
          limitation: '',
          state: pc?.connectionState ?? 'closed',
        }
      )
    })
    this.statsCache = list
    this.setState({ webrtcStats: [...list], webrtcViewers: this.countConnected() })
  }

  private countConnected(): number {
    let count = 0
    for (const pc of this.peers.values()) if (pc.connectionState === 'connected') count += 1
    return count
  }

  private startStatsPolling(): void {
    if (this.statsTimer !== null) return
    this.lastStatsAt = performance.now()
    this.statsTimer = window.setInterval(() => void this.pollStats(), 2000)
  }

  private stopStatsPolling(): void {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer)
      this.statsTimer = null
    }
  }

  /** 每 2s 采样一次:码率做差分,其余字段直接读 */
  private async pollStats(): Promise<void> {
    const now = performance.now()
    const dt = (now - this.lastStatsAt) / 1000
    this.lastStatsAt = now
    const cache = new Map(this.statsCache.map((item) => [item.id, item]))
    const list: WebRtcViewerStat[] = []
    for (const [id, pc] of this.peers) {
      const prev = cache.get(id)
      const entry: WebRtcViewerStat = {
        id,
        kbps: prev?.kbps ?? 0,
        fps: prev?.fps ?? 0,
        resolution: prev?.resolution ?? '',
        packetsLost: prev?.packetsLost ?? 0,
        rttMs: prev?.rttMs ?? null,
        limitation: prev?.limitation ?? '',
        state: pc.connectionState,
      }
      try {
        const report = await pc.getStats()
        report.forEach((item) => {
          if (item.type === 'outbound-rtp' && item.kind === 'video') {
            const bytes = item.bytesSent ?? 0
            const last = this.lastBytes.get(id)
            if (last !== undefined && dt > 0) {
              entry.kbps = Math.max(0, Math.round(((bytes - last) * 8) / 1000 / dt))
            }
            this.lastBytes.set(id, bytes)
            entry.fps = Math.round(item.framesPerSecond ?? 0)
            if (item.frameWidth) entry.resolution = `${item.frameWidth}×${item.frameHeight}`
            entry.limitation = item.qualityLimitationReason ?? ''
          }
          if (item.type === 'remote-inbound-rtp') {
            entry.packetsLost = Math.max(0, item.packetsLost ?? 0)
          }
          if (
            item.type === 'candidate-pair' &&
            item.state === 'succeeded' &&
            typeof item.currentRoundTripTime === 'number'
          ) {
            entry.rttMs = Math.round(item.currentRoundTripTime * 1000)
          }
        })
      } catch {
        /* pc 正在关 */
      }
      list.push(entry)
    }
    this.statsCache = list
    this.setState({ webrtcStats: [...list], webrtcViewers: this.countConnected() })
  }

  /** 中转下发的文本消息:hello(观看地址)/ stats(帧率码率人数)/ rtc-* 信令 */
  private onMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') return
    let value: unknown = null
    try {
      value = JSON.parse(event.data)
    } catch {
      return
    }
    if (!value || typeof value !== 'object') return
    const message = value as Record<string, unknown>
    if (message.t === 'hello' || message.t === 'stats') {
      const watch = Array.isArray(message.watch) ? message.watch.filter((v) => typeof v === 'string') : null
      this.setState({
        viewers: typeof message.viewers === 'number' ? message.viewers : this.state.viewers,
        fps: typeof message.fps === 'number' ? message.fps : this.state.fps,
        kbps: typeof message.kbps === 'number' ? message.kbps : this.state.kbps,
        ...(watch ? { watchUrls: watch as string[] } : {}),
      })
      return
    }
    if (!this.webrtcOn || typeof message.from !== 'string') return
    if (message.t === 'rtc-hello') void this.handleHello(message.from)
    else if (message.t === 'rtc-answer') void this.handleAnswer(message.from, message.sdp)
    else if (message.t === 'rtc-ice') void this.handleIce(message.from, message.candidate)
    else if (message.t === 'rtc-bye') this.dropPeer(message.from)
  }

  private scheduleReconnect(): void {
    const delay = this.options.reconnectDelayMs ?? 2000
    if (delay <= 0 || this.reconnectTimer !== null) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.connect().catch(() => {
        // connect 内部已置 error 并再次排重连,这里只是别让 rejection 冒到 window
      })
    }, delay)
  }

  private setState(patch: Partial<VideoLinkState>): void {
    this.state = { ...this.state, ...patch }
    this.options.onState?.(this.snapshot)
  }
}
