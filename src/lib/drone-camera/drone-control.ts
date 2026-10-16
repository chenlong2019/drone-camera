/**
 * 渲染器无关的「飞行控制」抽象层。
 *
 * 库里所有 UI 模块(控制面板 / 航线面板 / 鹰眼图)都只依赖这一层接口,不依赖具体引擎实现,
 * 于是同一套面板既能挂在 three.js 的 DroneFly 上,也能挂在 Cesium 之类的其他渲染器上
 * (见 demo 的 Cesium 适配器)。
 *
 * 为什么必须显式抽出接口:DroneFly 含 private 成员,按 TypeScript 的类兼容规则,
 * 只要目标类型带 private/protected,就只有同一条继承链上的对象才能赋值给它 ——
 * 外部渲染器的控制器无论长得多像,都无法"伪装"成 DroneFly。
 * 因此把「面板真正用到的那部分能力」提成公开接口,由各渲染器各自实现。
 *
 * 约定:接口只描述能力,不描述实现 —— 实现方自行决定真值来自 three 场景还是地理坐标系。
 */
import type { CameraMode, PhotoShot } from './drone-fly'
import type { CaptureCameraState, CaptureViewOverride } from './drone-capture'
import type {
  ChecklistItem,
  DroneSim,
  DroneSnapshot,
  FlightMode,
  FlightPhase,
  MissionConfig,
  MissionExport,
  MissionExportFormat,
  MissionWaypoint,
  StickState,
} from './drone-sim'
import type { MissionEditState } from './mission-editor'

/**
 * 控制面板 / 航线面板 / 鹰眼图所需的最小飞行控制能力集。
 *
 * `DroneFly`(three.js 实现)与各渲染器适配器均实现本接口;面板只读真值、只调方法,
 * 不触碰任何引擎对象,所以换渲染器时面板一行都不用改。
 */
/**
 * 航点的地理坐标(经纬高,WGS84 椭球),由支持地理坐标系的后端(如 Cesium)提供。
 *
 * 与航点列表里的本地米坐标(x 东 / z 南 / altitude AGL,相对返航点)是同一位置的两种表示:
 * 经纬高是同一位置在地球上的绝对坐标(海拔 = 地形高度 + AGL),面板可切换显示哪种。
 */
export interface WaypointGeo {
  /** 经度(度) */
  lon: number
  /** 纬度(度) */
  lat: number
  /** 海拔(米,绝对高程 = 地形 + AGL) */
  height: number
}

export interface DronePanelHost {
  /** 飞行内核:面板直接读取 gimbalPitch / photoCount / recordSeconds / stick 等真值 */
  readonly sim: DroneSim
  /** 当前飞行阶段(自检 / 待机 / 起飞 / 悬停 / 返航 / 降落 ...) */
  readonly phase: FlightPhase
  /** 是否已离地 */
  readonly airborne: boolean
  /** 当前飞行挡位 */
  readonly flightMode: FlightMode
  /** 相对起飞点的高度(米,AGL) */
  readonly altitude: number
  /** 起飞前检查项(面板据此禁用起飞按钮并列出阻塞项) */
  readonly preflightChecks: ChecklistItem[]
  /** 机臂是否处于收拢状态 */
  readonly armsFolded: boolean
  /** 是否正在录像 */
  readonly isRecording: boolean
  /** 当前视角模式(orbit / follow / fpv) */
  readonly cameraMode: CameraMode

  /** 上电(走自检 → 预热 → 待机) */
  powerOn(): void
  /** 起飞 */
  takeOff(): boolean
  /** 降落 */
  land(): boolean
  /** 一键返航 */
  returnHome(reason?: string): boolean
  /** 写入摇杆连续量(面板摇杆与键盘都走这里) */
  setStick(stick: Partial<StickState>): void
  /** 切换飞行挡位 */
  setMode(mode: FlightMode): void
  /** 展开 / 收拢机臂 */
  setArmsFolded(folded: boolean): void
  /** 切换视角模式 */
  setCameraMode(mode: CameraMode): void
  /** 设置云台俯仰角(度) */
  setGimbalPitch(pitch: number): void
  /** 视角复位 */
  resetCamera(): void
  /** 直接把无人机移动到目标位置(本地坐标 / 绝对姿态) */
  flyTo(target: {
    x?: number
    y?: number
    z?: number
    heading?: number
    pitch?: number
    roll?: number
  }): void
  /** 设定镜头/云台变焦倍数(1~4x) */
  zoomTo(zoom: number): void
  /** 拍一张照片(取景位由实现方决定) */
  requestPhoto(): Promise<PhotoShot | null>
  /**
   * 取景相机(云台镜头)的位姿与内参快照 —— 与采集服务同源;未就绪返回 null。
   * 全景拍摄要用它把每张照片的取景方位写进元数据。
   */
  getCaptureCamera(): CaptureCameraState | null
  /**
   * 设置取景**俯仰**覆盖(全景分层用):俯仰替代云台俯仰;传 `null` 复位。
   * 只影响取景相机,不动机体与飞控。
   *
   * 没有水平偏航是有意的 —— 全景的水平覆盖靠 `spinBodyTo` 转机体(云台 Pan 行程不够)。
   */
  setCaptureView(override: CaptureViewOverride | null): void
  /** 让机体原地自转到绝对方位角(度,罗盘角);`null` 停止自转。全景水平网格靠它 */
  spinBodyTo(headingDeg: number | null): void
  /** 机体当前方位角(度,罗盘角) */
  getBodyHeading(): number
  /** 开始录像 */
  startRecording(): boolean
  /** 结束录像并返回产物 */
  stopRecording(): Promise<Blob | null>
}

/**
 * 航线规划面板(MissionPanel)所需的最小飞行控制能力集。
 *
 * 与 `DronePanelHost` 同一设计:`DroneFly`(three 实现)与 `CesiumDroneAdapter`
 * (Cesium 实现)都满足本接口,面板只读真值、只调方法,换渲染器时一行都不用改。
 *
 * 覆盖四类能力:
 * - 执行控制:开始 / 暂停 / 继续 / 停止(语义全部由 DroneSim 内核定义,与后端无关);
 * - 航点与参数:整表下发、单点更新、增删、参数修改、恢复默认;
 * - 序列化:导出数据与 JSON / CSV 文本(实现下沉在 drone-sim,两后端共用);
 * - 场景内编辑:编辑开关、选中、显隐、框住航线 —— 面板只展示结果,
 *   「当前是否可编辑」由实现方判定(three 版=观察者视角且任务未执行)。
 */
export interface MissionPanelHost {
  /** 飞行内核:面板直接读取 mission / missionConfig / homePosition 等真值 */
  readonly sim: DroneSim
  /** 是否处于观察者(自由)视角 —— 场景内编辑的前置条件 */
  readonly isOrbitView: boolean
  /** 全量真值快照(位置/姿态/电池/云台/任务…,面板据此渲染) */
  getSnapshot(): DroneSnapshot

  /** 启动航线任务(地面时先自动起飞,到 1.2 米后自动接上航线) */
  startMission(): boolean
  /** 暂停执行中的航线(原地悬停,可再续飞) */
  pauseMission(reason?: string): boolean
  /** 续飞被暂停的航线 */
  resumeMission(): boolean
  /** 中止航线并留在原地悬停 */
  stopMission(reason?: string): boolean

  /** 下发航点列表(执行中会被拒绝,与真机"上传后不可改"一致) */
  setMission(waypoints: Array<Partial<MissionWaypoint>>): boolean
  /** 改航线参数(速度/航向模式/过点方式/完成动作/循环) */
  setMissionConfig(patch: Partial<MissionConfig>): void
  /** 航线参数与航点恢复出厂默认 */
  resetMissionToDefault(): void
  /** 原位更新一个航点(场景拖拽每帧调用);返回夹紧后的航点,越界时 null */
  updateMissionWaypoint(index: number, patch: Partial<MissionWaypoint>): MissionWaypoint | null
  /** 场景编辑:按索引删除一个航点 */
  deleteMissionWaypoint(index: number): boolean
  /** 场景编辑:以飞机当前位置新增一个航点(高度取飞机当前高度) */
  addMissionWaypointAtDrone(): number

  /** 把当前航线整理成可序列化的导出数据 */
  getMissionExport(): MissionExport
  /** 导出航线文本(`json` 完整存档 / `csv` 纯航点表) */
  exportMission(format?: MissionExportFormat): string

  /** 场景内编辑状态(开关/是否激活/选中/悬停/拖拽中) */
  getMissionEditState(): MissionEditState
  /** 场景内编辑开关(开启仍需"当前确实可编辑"才生效) */
  setMissionEditEnabled(enabled: boolean): void
  /** 场景内编辑开关当前是否开着 */
  isMissionEditEnabled(): boolean
  /** 当前选中的航点索引(无选中 -1) */
  getMissionSelected(): number
  /** 同步选中航点(列表与场景双向联动) */
  setMissionSelected(index: number): void
  /** 航点标记显隐(不影响任务执行) */
  setMissionWaypointsVisible(visible: boolean): void
  isMissionWaypointsVisible(): boolean
  /** 航线折线显隐 */
  setMissionPathVisible(visible: boolean): void
  isMissionPathVisible(): boolean
  /** 把视角拉到"一眼看全整条航线"的位置;成功返回 true */
  frameMission(): boolean

  /**
   * 后端是否支持地理坐标(经纬高)。Cesium 等地理渲染器返回 true,three 等本地米坐标系返回 false。
   * 面板据此决定是否显示"经纬度 / XYZ"坐标切换开关。
   */
  supportsGeoCoordinates(): boolean
  /** 取某航点的地理坐标(经纬高);不支持或越界返回 null */
  getWaypointGeo(index: number): WaypointGeo | null
  /**
   * 用地理坐标原地改写一个航点(经纬高 → 本地米坐标的逆向换算由实现方完成)。
   * Cesium 后端可写;three 等本地米坐标系无地理锚点,返回 false(面板仅在 geo 模式且
   * supportsGeoCoordinates() 为 true 时才调用,故 three 不会走到这里)。
   */
  setWaypointGeo(index: number, geo: WaypointGeo): boolean
}
