// 本文件由 tmp-shots/gen-api-docs.mjs 从 drone-camera/lib/*.d.ts 自动生成,请勿手改。
// 重新生成:先 npm run build:lib,再 node tmp-shots/gen-api-docs.mjs

export interface ApiMember {
  kind: 'method' | 'property' | 'getter' | 'setter'
  name: string
  signature: string
  doc: string
}

export interface ApiItem {
  name: string
  kind: 'class' | 'interface' | 'function' | 'const' | 'type' | 'enum'
  signature: string
  doc: string
  members: ApiMember[]
}

export interface ApiModule {
  id: string
  file: string
  title: string
  group: string
  doc: string
  items: ApiItem[]
}

export const API_GROUPS: string[] = [
  "纯逻辑层",
  "机械与感知层",
  "飞行总控层",
  "Cesium 后端",
  "引擎装配",
  "交互层",
  "航线层",
  "态势层",
  "影像采集层"
]

export const API_MODULES: ApiModule[] = [
 {
  "id": "drone-sim",
  "file": "drone-sim",
  "title": "DroneSim · 飞控内核",
  "group": "纯逻辑层",
  "doc": "DJI Mini 4 Pro 飞行仿真内核。",
  "items": [
   {
    "name": "DRONE_SPEC",
    "kind": "const",
    "signature": "const DRONE_SPEC: { readonly name: \"DJI Mini 4 Pro\"; readonly weightKg: 0.249; readonly batteryWh: 18.96; readonly batteryNominalVoltage: 7.32; readonly batteryFullVoltage: 8.4; readonly batteryEmptyVoltage: 6.9; readonly batteryInternalResistance: 0.09; readonly maxWindResistance: 10.7; readonly hoverPowerWatts: 33; readonly idlePowerWatts: 1.6; readonly climbWattsPerMps: 3.6; readonly levelSpeedPowerGain: 0.55; readonly maxFlightTimeMin: 34; readonly takeoffAltitude: 1.2; readonly rthAltitudeDefault: 20; readonly landingSlowAltitude: 2; readonly gimbalPitchMin: -90; readonly gimbalPitchMax: 60; readonly gimbalYawRange: 5; }",
    "doc": "机型公开规格(Mini 4 Pro)",
    "members": []
   },
   {
    "name": "FlightMode",
    "kind": "type",
    "signature": "type FlightMode = 'cine' | 'normal' | 'sport'",
    "doc": "飞行挡位:平稳 C / 普通 N / 运动 S",
    "members": []
   },
   {
    "name": "ModeSpec",
    "kind": "interface",
    "signature": "interface ModeSpec { … }",
    "doc": "单个挡位的性能参数:限速(水平/升降)、姿态倾角与加减速、偏航角速度",
    "members": [
     {
      "kind": "property",
      "name": "label",
      "signature": "label: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "horizontalSpeed",
      "signature": "horizontalSpeed: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "climbSpeed",
      "signature": "climbSpeed: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "descendSpeed",
      "signature": "descendSpeed: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "maxTiltDeg",
      "signature": "maxTiltDeg: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "accel",
      "signature": "accel: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "brakeAccel",
      "signature": "brakeAccel: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "yawRateDeg",
      "signature": "yawRateDeg: number",
      "doc": ""
     }
    ]
   },
   {
    "name": "FLIGHT_MODES",
    "kind": "const",
    "signature": "const FLIGHT_MODES: Record<FlightMode, ModeSpec>",
    "doc": "N / S / C 三档飞行模式(对齐 DJI 飞行挡位参数)",
    "members": []
   },
   {
    "name": "FLIGHT_MODE_LIST",
    "kind": "const",
    "signature": "const FLIGHT_MODE_LIST: Array<{ key: FlightMode; label: string; }>",
    "doc": "挡位列表(供下拉框渲染的稳定顺序)",
    "members": []
   },
   {
    "name": "SPEED_SCALE_MIN",
    "kind": "const",
    "signature": "const SPEED_SCALE_MIN = 0",
    "doc": "飞行速度倍率的取值区间(与面板滑杆一致):数值**本身**就是倍数,0 = 冻结、1 = 真机原速",
    "members": []
   },
   {
    "name": "SPEED_SCALE_MAX",
    "kind": "const",
    "signature": "const SPEED_SCALE_MAX = 1000",
    "doc": "",
    "members": []
   },
   {
    "name": "DEFAULT_SPEED_SCALE",
    "kind": "const",
    "signature": "const DEFAULT_SPEED_SCALE = 1",
    "doc": "速度倍率缺省值:1 = 真机原速",
    "members": []
   },
   {
    "name": "BODY_SPIN_RATE_DEG",
    "kind": "const",
    "signature": "const BODY_SPIN_RATE_DEG = 90",
    "doc": "机身**原地自转**的默认角速度(度/秒)。",
    "members": []
   },
   {
    "name": "BODY_SPIN_TOLERANCE_DEG",
    "kind": "const",
    "signature": "const BODY_SPIN_TOLERANCE_DEG = 0.5",
    "doc": "判定\"机身自转已对准目标航向\"的容差(度):1 帧的转角远大于它,但航向是连续量",
    "members": []
   },
   {
    "name": "FlightPhase",
    "kind": "type",
    "signature": "type FlightPhase = 'powerOff' | 'selfCheck' | 'warmingUp' | 'standby' | 'motorsOn' | 'takingOff' | 'flying' | 'waypoint' | 'rth' | 'landing' | 'emergency' | 'stopped'",
    "doc": "飞行阶段:上电自检 → 预热 → 待机 → 起飞 → 飞行/航线 → 返航/降落 → 停桨/失效",
    "members": []
   },
   {
    "name": "PHASE_LABELS",
    "kind": "const",
    "signature": "const PHASE_LABELS: Record<FlightPhase, string>",
    "doc": "阶段的中文标签(界面显示用)",
    "members": []
   },
   {
    "name": "PositionSource",
    "kind": "type",
    "signature": "type PositionSource = 'gps' | 'vision' | 'atti'",
    "doc": "定位来源:GNSS / 视觉 / 姿态模式(无定位)",
    "members": []
   },
   {
    "name": "POSITION_SOURCE_LABELS",
    "kind": "const",
    "signature": "const POSITION_SOURCE_LABELS: Record<PositionSource, string>",
    "doc": "定位来源的中文标签",
    "members": []
   },
   {
    "name": "StickState",
    "kind": "interface",
    "signature": "interface StickState { … }",
    "doc": "四通道摇杆量,每通道取值 -1~1(松杆为 0)",
    "members": [
     {
      "kind": "property",
      "name": "throttle",
      "signature": "throttle: number",
      "doc": "左杆上下:升降 -1~1(正 = 上升)"
     },
     {
      "kind": "property",
      "name": "yaw",
      "signature": "yaw: number",
      "doc": "左杆左右:偏航 -1~1(正 = 右转)"
     },
     {
      "kind": "property",
      "name": "pitch",
      "signature": "pitch: number",
      "doc": "右杆上下:俯仰 -1~1(正 = 前进)"
     },
     {
      "kind": "property",
      "name": "roll",
      "signature": "roll: number",
      "doc": "右杆左右:横滚 -1~1(正 = 右移)"
     }
    ]
   },
   {
    "name": "NEUTRAL_STICK",
    "kind": "const",
    "signature": "const NEUTRAL_STICK: StickState",
    "doc": "摇杆回中(全零)",
    "members": []
   },
   {
    "name": "MotorPosition",
    "kind": "type",
    "signature": "type MotorPosition = 'FrontLeft' | 'FrontRight' | 'RearLeft' | 'RearRight'",
    "doc": "四个电机对应的机臂位置(与 DroneRig 的 ArmPosition 一致,模型节点名同款后缀)",
    "members": []
   },
   {
    "name": "MOTOR_POSITIONS",
    "kind": "const",
    "signature": "const MOTOR_POSITIONS: MotorPosition[]",
    "doc": "四机臂的固定遍历顺序",
    "members": []
   },
   {
    "name": "FaultFlags",
    "kind": "interface",
    "signature": "interface FaultFlags { … }",
    "doc": "故障注入:测试沙盒里用来复现各种真机异常",
    "members": [
     {
      "kind": "property",
      "name": "gnssLost",
      "signature": "gnssLost: boolean",
      "doc": "GNSS 卫星丢失(强制进入视觉/姿态模式)"
     },
     {
      "kind": "property",
      "name": "compassError",
      "signature": "compassError: boolean",
      "doc": "指南针受扰(需要校准,否则姿态模式)"
     },
     {
      "kind": "property",
      "name": "imuError",
      "signature": "imuError: boolean",
      "doc": "IMU 异常(禁止起飞)"
     },
     {
      "kind": "property",
      "name": "motorFailure",
      "signature": "motorFailure: boolean",
      "doc": "电机异常:1 个电机动力衰减,导致偏航漂移"
     },
     {
      "kind": "property",
      "name": "rcLost",
      "signature": "rcLost: boolean",
      "doc": "遥控器失联(3 秒后触发失效返航)"
     },
     {
      "kind": "property",
      "name": "visionLost",
      "signature": "visionLost: boolean",
      "doc": "下视视觉失效(低空无法视觉定位)"
     },
     {
      "kind": "property",
      "name": "obstacleAvoidanceOff",
      "signature": "obstacleAvoidanceOff: boolean",
      "doc": "避障传感器关闭"
     }
    ]
   },
   {
    "name": "NO_FAULTS",
    "kind": "const",
    "signature": "const NO_FAULTS: FaultFlags",
    "doc": "全部故障关闭(正常飞行)",
    "members": []
   },
   {
    "name": "SimConfig",
    "kind": "interface",
    "signature": "interface SimConfig { … }",
    "doc": "沙盒可调参数(限高限距、风、电量阈值、失效动作、时间倍速)",
    "members": [
     {
      "kind": "property",
      "name": "maxAltitude",
      "signature": "maxAltitude: number",
      "doc": "限高(AGL,米)"
     },
     {
      "kind": "property",
      "name": "maxDistance",
      "signature": "maxDistance: number",
      "doc": "限距(米)"
     },
     {
      "kind": "property",
      "name": "rthAltitude",
      "signature": "rthAltitude: number",
      "doc": "返航高度(米)"
     },
     {
      "kind": "property",
      "name": "windSpeed",
      "signature": "windSpeed: number",
      "doc": "风速 m/s"
     },
     {
      "kind": "property",
      "name": "windDirection",
      "signature": "windDirection: number",
      "doc": "风\"吹向\"的罗盘方位角(0=北,90=东)"
     },
     {
      "kind": "property",
      "name": "lowBatteryPercent",
      "signature": "lowBatteryPercent: number",
      "doc": "低电量返航阈值 %"
     },
     {
      "kind": "property",
      "name": "criticalBatteryPercent",
      "signature": "criticalBatteryPercent: number",
      "doc": "严重低电量阈值 %"
     },
     {
      "kind": "property",
      "name": "rcFailsafe",
      "signature": "rcFailsafe: 'rth' | 'hover' | 'land'",
      "doc": "失效保护:遥控失联后的动作"
     },
     {
      "kind": "property",
      "name": "timeScale",
      "signature": "timeScale: number",
      "doc": "时间倍速(1 = 实时)"
     },
     {
      "kind": "property",
      "name": "speedScale",
      "signature": "speedScale: number",
      "doc": "飞行速度倍率(0 ~ 1000,数值本身就是倍数;1 = 真机原速)。"
     },
     {
      "kind": "property",
      "name": "selfCheckSeconds",
      "signature": "selfCheckSeconds: number",
      "doc": "上电自检时长(秒):默认 0.3,整个上电流程控制在 1 秒内"
     },
     {
      "kind": "property",
      "name": "warmupSeconds",
      "signature": "warmupSeconds: number",
      "doc": "传感器预热时长(秒):默认 0.28"
     },
     {
      "kind": "property",
      "name": "gnssAcquireRate",
      "signature": "gnssAcquireRate: number",
      "doc": "搜星速率(颗/秒):默认 30,上电后约 0.6 秒即达满星"
     }
    ]
   },
   {
    "name": "DEFAULT_CONFIG",
    "kind": "const",
    "signature": "const DEFAULT_CONFIG: SimConfig",
    "doc": "出厂默认参数:限高 120 m(合规上限)、限距 500 m、无风、实时",
    "members": []
   },
   {
    "name": "MissionWaypoint",
    "kind": "interface",
    "signature": "interface MissionWaypoint { … }",
    "doc": "单个航点(对齐真机航点任务的字段子集)。",
    "members": [
     {
      "kind": "property",
      "name": "x",
      "signature": "x: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "z",
      "signature": "z: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "altitude",
      "signature": "altitude: number",
      "doc": "目标高度(AGL,米)"
     },
     {
      "kind": "property",
      "name": "speed",
      "signature": "speed: number",
      "doc": "过点速度(m/s);0 = 使用任务巡航速度"
     },
     {
      "kind": "property",
      "name": "hoverSeconds",
      "signature": "hoverSeconds: number",
      "doc": "到点悬停时间(秒);0 = 不停留,直接飞下一个点"
     },
     {
      "kind": "property",
      "name": "gimbalPitch",
      "signature": "gimbalPitch: number | null",
      "doc": "到点后云台俯仰角(度);null = 不动云台"
     },
     {
      "kind": "property",
      "name": "action",
      "signature": "action: 'none' | 'photo'",
      "doc": "到点动作"
     }
    ]
   },
   {
    "name": "MissionHeadingMode",
    "kind": "type",
    "signature": "type MissionHeadingMode = 'auto' | 'fixed'",
    "doc": "机头朝向策略:auto = 始终机头指向下一航点;fixed = 保持任务开始时的航向",
    "members": []
   },
   {
    "name": "MissionPathMode",
    "kind": "type",
    "signature": "type MissionPathMode = 'straight' | 'curved'",
    "doc": "过点方式:straight = 到点减速后再走;curved = 圆滑过点(不减速)",
    "members": []
   },
   {
    "name": "MissionFinishAction",
    "kind": "type",
    "signature": "type MissionFinishAction = 'hover' | 'rth' | 'land'",
    "doc": "任务结束动作,对齐真机 WaypointMissionFinishedAction",
    "members": []
   },
   {
    "name": "MissionConfig",
    "kind": "interface",
    "signature": "interface MissionConfig { … }",
    "doc": "航线任务的全局设置",
    "members": [
     {
      "kind": "property",
      "name": "autoSpeed",
      "signature": "autoSpeed: number",
      "doc": "巡航速度(m/s):航点未单独指定速度时用它"
     },
     {
      "kind": "property",
      "name": "headingMode",
      "signature": "headingMode: MissionHeadingMode",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "pathMode",
      "signature": "pathMode: MissionPathMode",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "finishAction",
      "signature": "finishAction: MissionFinishAction",
      "doc": "全部航点完成后"
     },
     {
      "kind": "property",
      "name": "loop",
      "signature": "loop: boolean",
      "doc": "循环执行:完成后回到第一个航点继续"
     }
    ]
   },
   {
    "name": "MissionStatus",
    "kind": "type",
    "signature": "type MissionStatus = 'idle' | 'running' | 'paused'",
    "doc": "任务状态:未执行 / 执行中 / 已暂停",
    "members": []
   },
   {
    "name": "MISSION_STATUS_LABELS",
    "kind": "const",
    "signature": "const MISSION_STATUS_LABELS: Record<MissionStatus, string>",
    "doc": "任务状态的中文标签",
    "members": []
   },
   {
    "name": "MISSION_STAGE_LABELS",
    "kind": "const",
    "signature": "const MISSION_STAGE_LABELS: Record<MissionStage, string>",
    "doc": "任务阶段的中文标签",
    "members": []
   },
   {
    "name": "MissionStage",
    "kind": "type",
    "signature": "type MissionStage = 'idle' | 'depart-climb' | 'depart-cruise' | 'depart-settle' | 'depart-align' | 'goto' | 'hover'",
    "doc": "任务执行阶段。",
    "members": []
   },
   {
    "name": "isMissionDepartStage",
    "kind": "function",
    "signature": "function isMissionDepartStage(stage: MissionStage): boolean",
    "doc": "是否为「启航段」阶段(首航点的分段机动)",
    "members": []
   },
   {
    "name": "DEFAULT_MISSION_CONFIG",
    "kind": "const",
    "signature": "const DEFAULT_MISSION_CONFIG: MissionConfig",
    "doc": "出厂默认任务设置:巡航 6 m/s、机头自动指向下一航点、直线过点、完成后悬停",
    "members": []
   },
   {
    "name": "DEFAULT_MISSION",
    "kind": "const",
    "signature": "const DEFAULT_MISSION: MissionWaypoint[]",
    "doc": "出厂示例航线:环绕起飞点一圈(最高 40 m,悬在 13 m 的建筑之上,不会触发避障刹停)",
    "members": []
   },
   {
    "name": "normalizeMissionWaypoint",
    "kind": "function",
    "signature": "function normalizeMissionWaypoint(source: Partial<MissionWaypoint>): MissionWaypoint",
    "doc": "单个航点字段归一化(手输/外部传入都可能越界)",
    "members": []
   },
   {
    "name": "MissionExportFormat",
    "kind": "type",
    "signature": "type MissionExportFormat = 'json' | 'csv'",
    "doc": "航线导出格式",
    "members": []
   },
   {
    "name": "MissionExport",
    "kind": "interface",
    "signature": "interface MissionExport { … }",
    "doc": "航线导出数据(JSON 形态)。",
    "members": [
     {
      "kind": "property",
      "name": "format",
      "signature": "format: 'drone-camera/mission'",
      "doc": "文件标识,便于导入方识别"
     },
     {
      "kind": "property",
      "name": "version",
      "signature": "version: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "exportedAt",
      "signature": "exportedAt: string",
      "doc": "导出时刻(ISO 8601)"
     },
     {
      "kind": "property",
      "name": "frame",
      "signature": "frame: { origin: string; unit: string; x: string; z: string; altitude: string; }",
      "doc": "坐标约定说明(写进文件,换个工具打开也不至于误读)"
     },
     {
      "kind": "property",
      "name": "home",
      "signature": "home: { x: number; z: number; }",
      "doc": "返航点(局部坐标原点)"
     },
     {
      "kind": "property",
      "name": "config",
      "signature": "config: MissionConfig",
      "doc": "任务参数"
     },
     {
      "kind": "property",
      "name": "summary",
      "signature": "summary: { points: number; distance: number; duration: number; altitudeMin: number; altitudeMax: number; }",
      "doc": "概览统计:点数 / 航程 / 预计耗时 / 高度范围"
     },
     {
      "kind": "property",
      "name": "waypoints",
      "signature": "waypoints: MissionWaypoint[]",
      "doc": ""
     }
    ]
   },
   {
    "name": "buildMissionExport",
    "kind": "function",
    "signature": "function buildMissionExport(waypoints: MissionWaypoint[], config: MissionConfig, home: { x: number; z: number; }): MissionExport",
    "doc": "由「航点 + 任务参数 + 返航点」组出导出数据(纯函数,两套渲染后端共用)。",
    "members": []
   },
   {
    "name": "missionToCsv",
    "kind": "function",
    "signature": "function missionToCsv(waypoints: MissionWaypoint[]): string",
    "doc": "航点表 → CSV(不含 BOM;落盘时由调用方按需添加)",
    "members": []
   },
   {
    "name": "exportMissionText",
    "kind": "function",
    "signature": "function exportMissionText(data: MissionExport, format?: MissionExportFormat): string",
    "doc": "导出航线文本。`json` 是完整存档(含坐标约定、任务参数、概览统计,可再喂回 `setMission`), `csv` 只出航点表 —— 表头中文、CRLF 换行,Excel / WPS 双击即可打开。",
    "members": []
   },
   {
    "name": "findMissionInsertIndex",
    "kind": "function",
    "signature": "function findMissionInsertIndex(list: MissionWaypoint[], x: number, z: number, homeX: number, homeZ: number): number",
    "doc": "新航点插到哪个位置:取\"绕路最少\"的那一格(three / Cesium 两个场景内编辑器共用)。",
    "members": []
   },
   {
    "name": "MissionSnapshot",
    "kind": "interface",
    "signature": "interface MissionSnapshot { … }",
    "doc": "航线任务的实时进度(界面轮询用)",
    "members": [
     {
      "kind": "property",
      "name": "status",
      "signature": "status: MissionStatus",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "statusLabel",
      "signature": "statusLabel: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "stage",
      "signature": "stage: MissionStage",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "stageLabel",
      "signature": "stageLabel: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "index",
      "signature": "index: number",
      "doc": "当前目标航点索引(0 基);-1 = 无"
     },
     {
      "kind": "property",
      "name": "total",
      "signature": "total: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "passes",
      "signature": "passes: number",
      "doc": "已完成的整圈数"
     },
     {
      "kind": "property",
      "name": "elapsed",
      "signature": "elapsed: number",
      "doc": "任务已执行时长(秒)"
     },
     {
      "kind": "property",
      "name": "distanceLeft",
      "signature": "distanceLeft: number",
      "doc": "剩余航程(米,含高度差)"
     },
     {
      "kind": "property",
      "name": "progress",
      "signature": "progress: number",
      "doc": "按航程折算的完成度 0~1"
     },
     {
      "kind": "property",
      "name": "etaSeconds",
      "signature": "etaSeconds: number",
      "doc": "预计剩余时间(秒,含悬停)"
     },
     {
      "kind": "property",
      "name": "pauseReason",
      "signature": "pauseReason: string",
      "doc": "暂停原因"
     },
     {
      "kind": "property",
      "name": "active",
      "signature": "active: MissionWaypoint | null",
      "doc": "当前目标航点副本"
     },
     {
      "kind": "property",
      "name": "waypoints",
      "signature": "waypoints: MissionWaypoint[]",
      "doc": "航线航点列表副本(界面据此渲染)"
     },
     {
      "kind": "property",
      "name": "config",
      "signature": "config: MissionConfig",
      "doc": ""
     }
    ]
   },
   {
    "name": "EventLevel",
    "kind": "type",
    "signature": "type EventLevel = 'info' | 'warn' | 'error' | 'success'",
    "doc": "事件日志级别",
    "members": []
   },
   {
    "name": "SimEvent",
    "kind": "interface",
    "signature": "interface SimEvent { … }",
    "doc": "一条事件日志",
    "members": [
     {
      "kind": "property",
      "name": "id",
      "signature": "id: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "time",
      "signature": "time: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "level",
      "signature": "level: EventLevel",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "text",
      "signature": "text: string",
      "doc": ""
     }
    ]
   },
   {
    "name": "ObstacleBox",
    "kind": "interface",
    "signature": "interface ObstacleBox { … }",
    "doc": "轴对齐包围盒(AABB)障碍物,坐标与飞行位置同一套约定",
    "members": [
     {
      "kind": "property",
      "name": "name",
      "signature": "name: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "minX",
      "signature": "minX: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "maxX",
      "signature": "maxX: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "minY",
      "signature": "minY: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "maxY",
      "signature": "maxY: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "minZ",
      "signature": "minZ: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "maxZ",
      "signature": "maxZ: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "solid",
      "signature": "solid: boolean",
      "doc": "是否需要绕开(否则只是地面建筑,飞过去即可)"
     }
    ]
   },
   {
    "name": "ObstacleReport",
    "kind": "interface",
    "signature": "interface ObstacleReport { … }",
    "doc": "当前帧的避障探测结果(机身坐标系六向)",
    "members": [
     {
      "kind": "property",
      "name": "forward",
      "signature": "forward: number | null",
      "doc": "六个方向的最近距离(米),null 表示该方向无障碍"
     },
     {
      "kind": "property",
      "name": "backward",
      "signature": "backward: number | null",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "left",
      "signature": "left: number | null",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "right",
      "signature": "right: number | null",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "up",
      "signature": "up: number | null",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "down",
      "signature": "down: number | null",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "braking",
      "signature": "braking: boolean",
      "doc": "本帧是否因避障刹停"
     },
     {
      "kind": "property",
      "name": "brakingDirection",
      "signature": "brakingDirection: 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down' | null",
      "doc": "触发方向"
     }
    ]
   },
   {
    "name": "ChecklistItem",
    "kind": "interface",
    "signature": "interface ChecklistItem { … }",
    "doc": "起飞前检查项",
    "members": [
     {
      "kind": "property",
      "name": "id",
      "signature": "id: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "label",
      "signature": "label: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "ok",
      "signature": "ok: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "detail",
      "signature": "detail: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "blocking",
      "signature": "blocking: boolean",
      "doc": "不通过是否阻止起飞"
     }
    ]
   },
   {
    "name": "DroneSnapshot",
    "kind": "interface",
    "signature": "interface DroneSnapshot { … }",
    "doc": "单向快照:界面/回放读取的全部遥测字段(数组字段已复制,改它不影响仿真)",
    "members": [
     {
      "kind": "property",
      "name": "phase",
      "signature": "phase: FlightPhase",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "phaseLabel",
      "signature": "phaseLabel: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "mode",
      "signature": "mode: FlightMode",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "modeLabel",
      "signature": "modeLabel: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "speedScale",
      "signature": "speedScale: number",
      "doc": "当前生效的飞行速度倍率(0 ~ 1000,1 = 真机原速;见 SimConfig.speedScale)"
     },
     {
      "kind": "property",
      "name": "positionSource",
      "signature": "positionSource: PositionSource",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "positionSourceLabel",
      "signature": "positionSourceLabel: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "airborne",
      "signature": "airborne: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "motorsOn",
      "signature": "motorsOn: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "damaged",
      "signature": "damaged: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "batteryPercent",
      "signature": "batteryPercent: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "batteryVoltage",
      "signature": "batteryVoltage: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "batteryCurrent",
      "signature": "batteryCurrent: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "batteryTemp",
      "signature": "batteryTemp: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "batteryWhLeft",
      "signature": "batteryWhLeft: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "batteryModeText",
      "signature": "batteryModeText: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "altitude",
      "signature": "altitude: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "altitudeMax",
      "signature": "altitudeMax: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "positionX",
      "signature": "positionX: number",
      "doc": "相对起飞点的水平坐标:x 向东,z 向南(与模型坐标一致)"
     },
     {
      "kind": "property",
      "name": "positionZ",
      "signature": "positionZ: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "horizontalSpeed",
      "signature": "horizontalSpeed: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "verticalSpeed",
      "signature": "verticalSpeed: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "heading",
      "signature": "heading: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "tiltPitch",
      "signature": "tiltPitch: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "tiltRoll",
      "signature": "tiltRoll: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "distanceToHome",
      "signature": "distanceToHome: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "homeRecorded",
      "signature": "homeRecorded: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "altitudeLimitReached",
      "signature": "altitudeLimitReached: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "distanceLimitReached",
      "signature": "distanceLimitReached: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "satellites",
      "signature": "satellites: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "hdop",
      "signature": "hdop: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "gpsBars",
      "signature": "gpsBars: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "rcBars",
      "signature": "rcBars: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "visionAvailable",
      "signature": "visionAvailable: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "gimbalPitch",
      "signature": "gimbalPitch: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "gimbalRoll",
      "signature": "gimbalRoll: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "gimbalYaw",
      "signature": "gimbalYaw: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "motorLoad",
      "signature": "motorLoad: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "motorSpeeds",
      "signature": "motorSpeeds: Record<MotorPosition, number>",
      "doc": "四电机归一化转速(悬停 ≈ 1):混控差动的读数口,面板/调试可视化用"
     },
     {
      "kind": "property",
      "name": "armFold",
      "signature": "armFold: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "stick",
      "signature": "stick: StickState",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "windSpeed",
      "signature": "windSpeed: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "windDirection",
      "signature": "windDirection: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "windRelative",
      "signature": "windRelative: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "flightTime",
      "signature": "flightTime: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "totalTime",
      "signature": "totalTime: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "remainingMinutes",
      "signature": "remainingMinutes: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "lowBattery",
      "signature": "lowBattery: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "criticalBattery",
      "signature": "criticalBattery: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "lowBatteryCountdown",
      "signature": "lowBatteryCountdown: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "rthStage",
      "signature": "rthStage: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "landingStage",
      "signature": "landingStage: string",
      "doc": "自动降落的细分阶段:approach=降向低位悬停位 / hold=低位悬停确认 / settle=缓慢触地"
     },
     {
      "kind": "property",
      "name": "rthReason",
      "signature": "rthReason: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "warnings",
      "signature": "warnings: string[]",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "events",
      "signature": "events: SimEvent[]",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "checklist",
      "signature": "checklist: ChecklistItem[]",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "obstacle",
      "signature": "obstacle: ObstacleReport",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "recording",
      "signature": "recording: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "recordSeconds",
      "signature": "recordSeconds: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "photoCount",
      "signature": "photoCount: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "cameraZoom",
      "signature": "cameraZoom: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "mission",
      "signature": "mission: MissionSnapshot",
      "doc": "航线任务进度"
     }
    ]
   },
   {
    "name": "DroneSim",
    "kind": "class",
    "signature": "declare class DroneSim { … }",
    "doc": "飞控仿真内核(不依赖 three)。",
    "members": [
     {
      "kind": "property",
      "name": "config",
      "signature": "config: SimConfig",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "faults",
      "signature": "faults: FaultFlags",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "obstacles",
      "signature": "obstacles: ObstacleBox[]",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "phase",
      "signature": "phase: FlightPhase",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "mode",
      "signature": "mode: FlightMode",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "position",
      "signature": "position: { x: number; y: number; z: number; }",
      "doc": "位置:y 为相对起飞点的高度(AGL),x/z 为水平偏移"
     },
     {
      "kind": "property",
      "name": "velocity",
      "signature": "velocity: { x: number; y: number; z: number; }",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "heading",
      "signature": "heading: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "tiltPitch",
      "signature": "tiltPitch: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "tiltRoll",
      "signature": "tiltRoll: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "motorLoad",
      "signature": "motorLoad: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "motorSpeeds",
      "signature": "motorSpeeds: Record<MotorPosition, number>",
      "doc": "四电机归一化转速(悬停 ≈ 1.0,0 = 停转):由四旋翼混控得出 —— 总距(整体升力)+ 俯仰差动(前后)+ 横滚差动(左右)+ 偏航反扭矩差动(对角)。 真四旋翼正是靠这四路差动打破/恢复升力平衡来实现全姿态控制的,"
     },
     {
      "kind": "property",
      "name": "armFold",
      "signature": "armFold: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "damaged",
      "signature": "damaged: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "stick",
      "signature": "stick: StickState",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "externalChecks",
      "signature": "externalChecks: ChecklistItem[]",
      "doc": "外部(模型侧)提供的检查项,例如机臂是否展开"
     },
     {
      "kind": "property",
      "name": "recording",
      "signature": "recording: boolean",
      "doc": "相机状态"
     },
     {
      "kind": "property",
      "name": "recordSeconds",
      "signature": "recordSeconds: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "photoCount",
      "signature": "photoCount: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "cameraZoom",
      "signature": "cameraZoom: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "gimbalPitch",
      "signature": "gimbalPitch: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "gimbalRoll",
      "signature": "gimbalRoll: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "gimbalYaw",
      "signature": "gimbalYaw: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "mission",
      "signature": "mission: MissionWaypoint[]",
      "doc": "航线任务:航点列表(出厂带一条示例航线,方便一键演示)"
     },
     {
      "kind": "property",
      "name": "missionConfig",
      "signature": "missionConfig: MissionConfig",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "missionStatus",
      "signature": "missionStatus: MissionStatus",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "missionIndex",
      "signature": "missionIndex: number",
      "doc": "当前目标航点索引(0 基),-1 表示没有在执行的航点"
     },
     {
      "kind": "property",
      "name": "missionStage",
      "signature": "missionStage: MissionStage",
      "doc": "当前任务阶段(未执行任务时为 'idle')"
     },
     {
      "kind": "property",
      "name": "events",
      "signature": "events: SimEvent[]",
      "doc": ""
     },
     {
      "kind": "getter",
      "name": "airborne",
      "signature": "get airborne(): boolean",
      "doc": "是否已离地(起落架离地即算,含低空悬停)"
     },
     {
      "kind": "getter",
      "name": "motorsOn",
      "signature": "get motorsOn(): boolean",
      "doc": "电机是否已启动(空中为 true;停桨后回 false)"
     },
     {
      "kind": "getter",
      "name": "speedScale",
      "signature": "get speedScale(): number",
      "doc": "当前生效的飞行速度倍率(夹到 0 ~ 1000;非法值退回 1)"
     },
     {
      "kind": "method",
      "name": "setSpeedScale",
      "signature": "setSpeedScale(scale: number): void",
      "doc": "设置飞行速度倍率(0 ~ 1000,数值即倍数)。 非有限值一律按 1(真机原速)处理 —— 面板滑杆中途可能给出空串/NaN。"
     },
     {
      "kind": "getter",
      "name": "modeSpec",
      "signature": "get modeSpec(): ModeSpec",
      "doc": "当前挡位参数(已按速度倍率缩放):速度上限 / 加速度 / 偏航角速度都取自它"
     },
     {
      "kind": "getter",
      "name": "batteryPercent",
      "signature": "get batteryPercent(): number",
      "doc": "电量百分比 0~100(按真实容量积分,非线性掉电)"
     },
     {
      "kind": "getter",
      "name": "batteryCurrent",
      "signature": "get batteryCurrent(): number",
      "doc": "放电电流:按当前功率 / 近似电压估算"
     },
     {
      "kind": "getter",
      "name": "batteryVoltage",
      "signature": "get batteryVoltage(): number",
      "doc": "端电压 = 开路电压 − 内阻压降"
     },
     {
      "kind": "getter",
      "name": "positionSource",
      "signature": "get positionSource(): PositionSource",
      "doc": "当前定位来源:GNSS(≥6 星且指南针正常)→ 视觉 → 姿态模式"
     },
     {
      "kind": "getter",
      "name": "currentPowerWatts",
      "signature": "get currentPowerWatts(): number",
      "doc": "当前总功耗(W):怠速 + 悬停(含平飞增益)+ 爬升功耗,再乘风速系数"
     },
     {
      "kind": "getter",
      "name": "remainingMinutes",
      "signature": "get remainingMinutes(): number",
      "doc": "剩余可飞时间(分钟)"
     },
     {
      "kind": "method",
      "name": "powerOn",
      "signature": "powerOn(): void",
      "doc": "上电:重置飞行状态与电量并进入自检;受损时拒绝"
     },
     {
      "kind": "method",
      "name": "powerOff",
      "signature": "powerOff(): void",
      "doc": "关机:仅地面可用;顺带作废未起飞的航线任务"
     },
     {
      "kind": "method",
      "name": "setMode",
      "signature": "setMode(mode: FlightMode): void",
      "doc": "切飞行挡位:'cine' 平稳 / 'normal' 普通 / 'sport' 运动(影响限速与倾角)"
     },
     {
      "kind": "method",
      "name": "setStick",
      "signature": "setStick(stick: Partial<StickState>): void",
      "doc": "写摇杆连续量(Partial 合并;松杆由飞控刹停并定点悬停)"
     },
     {
      "kind": "method",
      "name": "startMotors",
      "signature": "startMotors(): boolean",
      "doc": "内八掰杆启动电机(地面待机时可用)"
     },
     {
      "kind": "method",
      "name": "stopMotors",
      "signature": "stopMotors(): boolean",
      "doc": "停止电机(仅地面已启动电机的状态可用);返回是否真的停下来了"
     },
     {
      "kind": "method",
      "name": "takeOff",
      "signature": "takeOff(): boolean",
      "doc": "起飞:记录返航点并自动爬升到 1.2 米(需已启动电机)"
     },
     {
      "kind": "method",
      "name": "autoTakeOff",
      "signature": "autoTakeOff(): boolean",
      "doc": "一键起飞(地面待机时自动完成电机启动 + 起飞)"
     },
     {
      "kind": "method",
      "name": "startLanding",
      "signature": "startLanding(): boolean",
      "doc": "触发自动降落(会先中止正在执行的航线任务)"
     },
     {
      "kind": "method",
      "name": "startRth",
      "signature": "startRth(reason: string): boolean",
      "doc": "触发智能返航(reason 用于日志与快照);返航优先级高于航线,会中止任务"
     },
     {
      "kind": "method",
      "name": "cancelRth",
      "signature": "cancelRth(reason?: string): void",
      "doc": "取消正在执行的智能返航,转入手动飞行"
     },
     {
      "kind": "method",
      "name": "emergencyStop",
      "signature": "emergencyStop(): boolean",
      "doc": "紧急停桨(停桨保护)。 ⚠️ **只在飞行器落地后允许**:空中停桨会直接导致坠机,本沙盒按用户要求禁止, 必须先把飞行器降落下来。空中调用会被拒绝(不改变任何飞行状态),只写一条警告日志。"
     },
     {
      "kind": "method",
      "name": "reset",
      "signature": "reset(): void",
      "doc": "重置到可再次起飞的状态(用于沙盒反复测试)"
     },
     {
      "kind": "method",
      "name": "step",
      "signature": "step(dtSeconds: number): void",
      "doc": "推进一个仿真时间片(dtSeconds 秒;负值不推进,过大的值会被夹到单步上限)"
     },
     {
      "kind": "method",
      "name": "setMission",
      "signature": "setMission(waypoints: Array<Partial<MissionWaypoint>>): boolean",
      "doc": "设置航点列表(执行中禁止修改,与真机\"上传后不可改\"一致)"
     },
     {
      "kind": "method",
      "name": "updateMissionWaypoint",
      "signature": "updateMissionWaypoint(index: number, patch: Partial<MissionWaypoint>): MissionWaypoint | null",
      "doc": "只改一个航点(列表编辑与场景内拖拽共用)。"
     },
     {
      "kind": "method",
      "name": "addMissionWaypoint",
      "signature": "addMissionWaypoint(waypoint: Partial<MissionWaypoint>, index?: number): number",
      "doc": "插入一个航点(场景内双击地面新增)。index 越界则追加到末尾,返回实际插入位置。 与真机一致:新航点的高度默认取相邻航点,避免插一个 0 米高、撞地的点。"
     },
     {
      "kind": "method",
      "name": "removeMissionWaypoint",
      "signature": "removeMissionWaypoint(index: number): boolean",
      "doc": "删除一个航点,返回是否删掉了"
     },
     {
      "kind": "method",
      "name": "setMissionConfig",
      "signature": "setMissionConfig(patch: Partial<MissionConfig>): void",
      "doc": "增量更新航线任务的全局设置(只覆盖传入的字段)"
     },
     {
      "kind": "method",
      "name": "resetMissionToDefault",
      "signature": "resetMissionToDefault(): void",
      "doc": "恢复出厂示例航线"
     },
     {
      "kind": "method",
      "name": "startMission",
      "signature": "startMission(): boolean",
      "doc": "启动航线任务。 - 地面待机时先自动起飞,到 1.2 米后自动接上航线(对应 Pilot 里的\"执行航线\"); - 已在空中则直接飞向第一个航点(正在返航会先中止返航);"
     },
     {
      "kind": "method",
      "name": "pauseMission",
      "signature": "pauseMission(reason?: string): boolean",
      "doc": "暂停任务:交回手动控制并原地悬停,航点进度保留"
     },
     {
      "kind": "method",
      "name": "resumeMission",
      "signature": "resumeMission(): boolean",
      "doc": "继续任务:回到当前目标航点(首航点还没走完启航段的话接着走)"
     },
     {
      "kind": "method",
      "name": "stopMission",
      "signature": "stopMission(reason?: string): boolean",
      "doc": "停止任务:飞机原地悬停,航线归零(真机\"停止任务\"不返航)"
     },
     {
      "kind": "getter",
      "name": "missionPendingStart",
      "signature": "get missionPendingStart(): boolean",
      "doc": "航线是否处于\"已下发、等待起飞到位\"状态。 地面点「执行航线」时 missionStatus 仍是 idle,真正的执行要等自动起飞到 1.2 米 —— 这段时间里航点列表同样不许改(改了下发的还是旧航线),所以外部需要这个判据。"
     },
     {
      "kind": "getter",
      "name": "missionDistanceLeft",
      "signature": "get missionDistanceLeft(): number",
      "doc": "剩余航程(米):沿剩余航点折线累计,含高度差"
     },
     {
      "kind": "getter",
      "name": "missionProgress",
      "signature": "get missionProgress(): number",
      "doc": "航点完成度 0~1(按航程折算,暂停期间保持不变)"
     },
     {
      "kind": "getter",
      "name": "missionEtaSeconds",
      "signature": "get missionEtaSeconds(): number",
      "doc": "预计剩余时间(秒):剩余航程 / 巡航速度 + 剩余悬停时间"
     },
     {
      "kind": "getter",
      "name": "hdop",
      "signature": "get hdop(): number",
      "doc": "水平精度因子(越小越好);无星时返回 99 表示不可用"
     },
     {
      "kind": "getter",
      "name": "gpsBars",
      "signature": "get gpsBars(): number",
      "doc": "GPS 信号格数 0~5(按卫星数与 hdop 折算,面板显示用)"
     },
     {
      "kind": "getter",
      "name": "rcBars",
      "signature": "get rcBars(): number",
      "doc": "遥控信号格数 0~5(按链路质量折算,面板显示用)"
     },
     {
      "kind": "getter",
      "name": "distanceToHome",
      "signature": "get distanceToHome(): number",
      "doc": "距返航点水平距离(米)"
     },
     {
      "kind": "getter",
      "name": "homePosition",
      "signature": "get homePosition(): { x: number; z: number; }",
      "doc": "返航点(起飞点)水平坐标"
     },
     {
      "kind": "getter",
      "name": "homeReady",
      "signature": "get homeReady(): boolean",
      "doc": "是否已记录返航点(起飞那一刻记下)。界面据此决定画不画 H 标记与距离读数"
     },
     {
      "kind": "method",
      "name": "forceBatteryLevel",
      "signature": "forceBatteryLevel(percent: number): void",
      "doc": "面板调试用:直接把电量设成某个百分比"
     },
     {
      "kind": "getter",
      "name": "lowBattery",
      "signature": "get lowBattery(): boolean",
      "doc": "是否触发低电量(将进入智能返航)"
     },
     {
      "kind": "getter",
      "name": "criticalBattery",
      "signature": "get criticalBattery(): boolean",
      "doc": "是否触发严重低电量(将强制降落)"
     },
     {
      "kind": "method",
      "name": "spinTo",
      "signature": "spinTo(headingDeg: number | null, rateDeg?: number): void",
      "doc": "让机身**原地自转**到绝对方位角 `headingDeg`(度,罗盘角);传 `null` 停止自转。"
     },
     {
      "kind": "getter",
      "name": "spinTarget",
      "signature": "get spinTarget(): number | null",
      "doc": "自转目标方位角(度,罗盘角);没有在自转时返回 null"
     },
     {
      "kind": "getter",
      "name": "spinning",
      "signature": "get spinning(): boolean",
      "doc": "是否正在自转(目标未清除即为是,到位后目标仍在,直到调用方 `spinTo(null)`)"
     },
     {
      "kind": "getter",
      "name": "spinAligned",
      "signature": "get spinAligned(): boolean",
      "doc": "自转是否已对准目标(容差 0.5°;没有自转时恒为 true)"
     },
     {
      "kind": "method",
      "name": "nudgeGimbal",
      "signature": "nudgeGimbal(deltaPitch: number, deltaYaw?: number): void",
      "doc": "手动云台俯仰增量(度),正 = 抬头"
     },
     {
      "kind": "method",
      "name": "setGimbalPitch",
      "signature": "setGimbalPitch(pitch: number): void",
      "doc": "设置云台俯仰角(度,正 = 抬头),自动夹到机型行程内"
     },
     {
      "kind": "method",
      "name": "toggleRecording",
      "signature": "toggleRecording(): void",
      "doc": "切换录像开关;返回切换后是否在录"
     },
     {
      "kind": "method",
      "name": "setRecordingState",
      "signature": "setRecordingState(active: boolean): void",
      "doc": "录像状态的唯一写入口(UI/引擎都走这里): 只负责状态、计时与事件日志;真正的录制(MediaRecorder)在 drone-fly 层, 由它按本状态启动/收尾,避免两处状态打架。"
     },
     {
      "kind": "method",
      "name": "stopRecording",
      "signature": "stopRecording(): void",
      "doc": "停止录像并收尾成片(已在录才有效)"
     },
     {
      "kind": "method",
      "name": "takePhoto",
      "signature": "takePhoto(): void",
      "doc": "拍照:计数 +1 并记一条事件(实际成像由引擎层负责)"
     },
     {
      "kind": "method",
      "name": "setZoom",
      "signature": "setZoom(zoom: number): void",
      "doc": "设置变焦倍数,夹在 1~4 倍之间"
     },
     {
      "kind": "getter",
      "name": "checklist",
      "signature": "get checklist(): ChecklistItem[]",
      "doc": "起飞前检查项列表(外部注入项 + 内置项),每次读取即时构造"
     },
     {
      "kind": "getter",
      "name": "canTakeOff",
      "signature": "get canTakeOff(): boolean",
      "doc": "是否满足起飞条件:阶段为待机/电机已启动,且所有阻塞项都通过"
     },
     {
      "kind": "getter",
      "name": "warnings",
      "signature": "get warnings(): string[]",
      "doc": "当前生效的警告文案列表(界面红条用)"
     },
     {
      "kind": "method",
      "name": "pushEvent",
      "signature": "pushEvent(level: EventLevel, text: string): void",
      "doc": "追加一条事件(面板事件流;level 决定颜色)"
     },
     {
      "kind": "getter",
      "name": "windRelative",
      "signature": "get windRelative(): string",
      "doc": "风向相对机头的描述,例如\"正逆风\""
     },
     {
      "kind": "method",
      "name": "snapshot",
      "signature": "snapshot(): DroneSnapshot",
      "doc": "生成完整遥测快照(数组字段已复制,见 DroneSnapshot)"
     },
     {
      "kind": "getter",
      "name": "elapsed",
      "signature": "get elapsed(): number",
      "doc": "仿真累计时长(秒):含地面上电时间,与飞行时长 flightTime 不同"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-control",
  "file": "drone-control",
  "title": "drone-control · 宿主接口",
  "group": "机械与感知层",
  "doc": "渲染器无关的「飞行控制」抽象层。",
  "items": [
   {
    "name": "WaypointGeo",
    "kind": "interface",
    "signature": "interface WaypointGeo { … }",
    "doc": "航点的地理坐标(经纬高,WGS84 椭球),由支持地理坐标系的后端(如 Cesium)提供。",
    "members": [
     {
      "kind": "property",
      "name": "lon",
      "signature": "lon: number",
      "doc": "经度(度)"
     },
     {
      "kind": "property",
      "name": "lat",
      "signature": "lat: number",
      "doc": "纬度(度)"
     },
     {
      "kind": "property",
      "name": "height",
      "signature": "height: number",
      "doc": "海拔(米,绝对高程 = 地形 + AGL)"
     }
    ]
   },
   {
    "name": "DronePanelHost",
    "kind": "interface",
    "signature": "interface DronePanelHost { … }",
    "doc": "控制面板 / 航线面板 / 鹰眼图所需的最小飞行控制能力集。",
    "members": [
     {
      "kind": "property",
      "name": "sim",
      "signature": "readonly sim: DroneSim",
      "doc": "飞行内核:面板直接读取 gimbalPitch / photoCount / recordSeconds / stick 等真值"
     },
     {
      "kind": "property",
      "name": "phase",
      "signature": "readonly phase: FlightPhase",
      "doc": "当前飞行阶段(自检 / 待机 / 起飞 / 悬停 / 返航 / 降落 ...)"
     },
     {
      "kind": "property",
      "name": "airborne",
      "signature": "readonly airborne: boolean",
      "doc": "是否已离地"
     },
     {
      "kind": "property",
      "name": "flightMode",
      "signature": "readonly flightMode: FlightMode",
      "doc": "当前飞行挡位"
     },
     {
      "kind": "property",
      "name": "altitude",
      "signature": "readonly altitude: number",
      "doc": "相对起飞点的高度(米,AGL)"
     },
     {
      "kind": "property",
      "name": "preflightChecks",
      "signature": "readonly preflightChecks: ChecklistItem[]",
      "doc": "起飞前检查项(面板据此禁用起飞按钮并列出阻塞项)"
     },
     {
      "kind": "property",
      "name": "armsFolded",
      "signature": "readonly armsFolded: boolean",
      "doc": "机臂是否处于收拢状态"
     },
     {
      "kind": "property",
      "name": "isRecording",
      "signature": "readonly isRecording: boolean",
      "doc": "是否正在录像"
     },
     {
      "kind": "property",
      "name": "cameraMode",
      "signature": "readonly cameraMode: CameraMode",
      "doc": "当前视角模式(orbit / follow / fpv)"
     },
     {
      "kind": "method",
      "name": "powerOn",
      "signature": "powerOn(): void",
      "doc": "上电(走自检 → 预热 → 待机)"
     },
     {
      "kind": "method",
      "name": "takeOff",
      "signature": "takeOff(): boolean",
      "doc": "起飞"
     },
     {
      "kind": "method",
      "name": "land",
      "signature": "land(): boolean",
      "doc": "降落"
     },
     {
      "kind": "method",
      "name": "returnHome",
      "signature": "returnHome(reason?: string): boolean",
      "doc": "一键返航"
     },
     {
      "kind": "method",
      "name": "setStick",
      "signature": "setStick(stick: Partial<StickState>): void",
      "doc": "写入摇杆连续量(面板摇杆与键盘都走这里)"
     },
     {
      "kind": "method",
      "name": "setMode",
      "signature": "setMode(mode: FlightMode): void",
      "doc": "切换飞行挡位"
     },
     {
      "kind": "method",
      "name": "setArmsFolded",
      "signature": "setArmsFolded(folded: boolean): void",
      "doc": "展开 / 收拢机臂"
     },
     {
      "kind": "method",
      "name": "setCameraMode",
      "signature": "setCameraMode(mode: CameraMode): void",
      "doc": "切换视角模式"
     },
     {
      "kind": "method",
      "name": "setGimbalPitch",
      "signature": "setGimbalPitch(pitch: number): void",
      "doc": "设置云台俯仰角(度)"
     },
     {
      "kind": "method",
      "name": "resetCamera",
      "signature": "resetCamera(): void",
      "doc": "视角复位"
     },
     {
      "kind": "method",
      "name": "flyTo",
      "signature": "flyTo(target: { x?: number; y?: number; z?: number; heading?: number; pitch?: number; roll?: number; }): void",
      "doc": "直接把无人机移动到目标位置(本地坐标 / 绝对姿态)"
     },
     {
      "kind": "method",
      "name": "zoomTo",
      "signature": "zoomTo(zoom: number): void",
      "doc": "设定镜头/云台变焦倍数(1~4x)"
     },
     {
      "kind": "method",
      "name": "requestPhoto",
      "signature": "requestPhoto(): Promise<PhotoShot | null>",
      "doc": "拍一张照片(取景位由实现方决定)"
     },
     {
      "kind": "method",
      "name": "getCaptureCamera",
      "signature": "getCaptureCamera(): CaptureCameraState | null",
      "doc": "取景相机(云台镜头)的位姿与内参快照 —— 与采集服务同源;未就绪返回 null。 全景拍摄要用它把每张照片的取景方位写进元数据。"
     },
     {
      "kind": "method",
      "name": "setCaptureView",
      "signature": "setCaptureView(override: CaptureViewOverride | null): void",
      "doc": "设置取景**俯仰**覆盖(全景分层用):俯仰替代云台俯仰;传 `null` 复位。 只影响取景相机,不动机体与飞控。"
     },
     {
      "kind": "method",
      "name": "spinBodyTo",
      "signature": "spinBodyTo(headingDeg: number | null): void",
      "doc": "让机体原地自转到绝对方位角(度,罗盘角);`null` 停止自转。全景水平网格靠它"
     },
     {
      "kind": "method",
      "name": "getBodyHeading",
      "signature": "getBodyHeading(): number",
      "doc": "机体当前方位角(度,罗盘角)"
     },
     {
      "kind": "method",
      "name": "startRecording",
      "signature": "startRecording(): boolean",
      "doc": "开始录像"
     },
     {
      "kind": "method",
      "name": "stopRecording",
      "signature": "stopRecording(): Promise<Blob | null>",
      "doc": "结束录像并返回产物"
     }
    ]
   },
   {
    "name": "MissionPanelHost",
    "kind": "interface",
    "signature": "interface MissionPanelHost { … }",
    "doc": "航线规划面板(MissionPanel)所需的最小飞行控制能力集。",
    "members": [
     {
      "kind": "property",
      "name": "sim",
      "signature": "readonly sim: DroneSim",
      "doc": "飞行内核:面板直接读取 mission / missionConfig / homePosition 等真值"
     },
     {
      "kind": "property",
      "name": "isOrbitView",
      "signature": "readonly isOrbitView: boolean",
      "doc": "是否处于观察者(自由)视角 —— 场景内编辑的前置条件"
     },
     {
      "kind": "method",
      "name": "getSnapshot",
      "signature": "getSnapshot(): DroneSnapshot",
      "doc": "全量真值快照(位置/姿态/电池/云台/任务…,面板据此渲染)"
     },
     {
      "kind": "method",
      "name": "startMission",
      "signature": "startMission(): boolean",
      "doc": "启动航线任务(地面时先自动起飞,到 1.2 米后自动接上航线)"
     },
     {
      "kind": "method",
      "name": "pauseMission",
      "signature": "pauseMission(reason?: string): boolean",
      "doc": "暂停执行中的航线(原地悬停,可再续飞)"
     },
     {
      "kind": "method",
      "name": "resumeMission",
      "signature": "resumeMission(): boolean",
      "doc": "续飞被暂停的航线"
     },
     {
      "kind": "method",
      "name": "stopMission",
      "signature": "stopMission(reason?: string): boolean",
      "doc": "中止航线并留在原地悬停"
     },
     {
      "kind": "method",
      "name": "setMission",
      "signature": "setMission(waypoints: Array<Partial<MissionWaypoint>>): boolean",
      "doc": "下发航点列表(执行中会被拒绝,与真机\"上传后不可改\"一致)"
     },
     {
      "kind": "method",
      "name": "setMissionConfig",
      "signature": "setMissionConfig(patch: Partial<MissionConfig>): void",
      "doc": "改航线参数(速度/航向模式/过点方式/完成动作/循环)"
     },
     {
      "kind": "method",
      "name": "resetMissionToDefault",
      "signature": "resetMissionToDefault(): void",
      "doc": "航线参数与航点恢复出厂默认"
     },
     {
      "kind": "method",
      "name": "updateMissionWaypoint",
      "signature": "updateMissionWaypoint(index: number, patch: Partial<MissionWaypoint>): MissionWaypoint | null",
      "doc": "原位更新一个航点(场景拖拽每帧调用);返回夹紧后的航点,越界时 null"
     },
     {
      "kind": "method",
      "name": "deleteMissionWaypoint",
      "signature": "deleteMissionWaypoint(index: number): boolean",
      "doc": "场景编辑:按索引删除一个航点"
     },
     {
      "kind": "method",
      "name": "addMissionWaypointAtDrone",
      "signature": "addMissionWaypointAtDrone(): number",
      "doc": "场景编辑:以飞机当前位置新增一个航点(高度取飞机当前高度)"
     },
     {
      "kind": "method",
      "name": "getMissionExport",
      "signature": "getMissionExport(): MissionExport",
      "doc": "把当前航线整理成可序列化的导出数据"
     },
     {
      "kind": "method",
      "name": "exportMission",
      "signature": "exportMission(format?: MissionExportFormat): string",
      "doc": "导出航线文本(`json` 完整存档 / `csv` 纯航点表)"
     },
     {
      "kind": "method",
      "name": "getMissionEditState",
      "signature": "getMissionEditState(): MissionEditState",
      "doc": "场景内编辑状态(开关/是否激活/选中/悬停/拖拽中)"
     },
     {
      "kind": "method",
      "name": "setMissionEditEnabled",
      "signature": "setMissionEditEnabled(enabled: boolean): void",
      "doc": "场景内编辑开关(开启仍需\"当前确实可编辑\"才生效)"
     },
     {
      "kind": "method",
      "name": "isMissionEditEnabled",
      "signature": "isMissionEditEnabled(): boolean",
      "doc": "场景内编辑开关当前是否开着"
     },
     {
      "kind": "method",
      "name": "getMissionSelected",
      "signature": "getMissionSelected(): number",
      "doc": "当前选中的航点索引(无选中 -1)"
     },
     {
      "kind": "method",
      "name": "setMissionSelected",
      "signature": "setMissionSelected(index: number): void",
      "doc": "同步选中航点(列表与场景双向联动)"
     },
     {
      "kind": "method",
      "name": "setMissionWaypointsVisible",
      "signature": "setMissionWaypointsVisible(visible: boolean): void",
      "doc": "航点标记显隐(不影响任务执行)"
     },
     {
      "kind": "method",
      "name": "isMissionWaypointsVisible",
      "signature": "isMissionWaypointsVisible(): boolean",
      "doc": ""
     },
     {
      "kind": "method",
      "name": "setMissionPathVisible",
      "signature": "setMissionPathVisible(visible: boolean): void",
      "doc": "航线折线显隐"
     },
     {
      "kind": "method",
      "name": "isMissionPathVisible",
      "signature": "isMissionPathVisible(): boolean",
      "doc": ""
     },
     {
      "kind": "method",
      "name": "frameMission",
      "signature": "frameMission(): boolean",
      "doc": "把视角拉到\"一眼看全整条航线\"的位置;成功返回 true"
     },
     {
      "kind": "method",
      "name": "supportsGeoCoordinates",
      "signature": "supportsGeoCoordinates(): boolean",
      "doc": "后端是否支持地理坐标(经纬高)。Cesium 等地理渲染器返回 true,three 等本地米坐标系返回 false。 面板据此决定是否显示\"经纬度 / XYZ\"坐标切换开关。"
     },
     {
      "kind": "method",
      "name": "getWaypointGeo",
      "signature": "getWaypointGeo(index: number): WaypointGeo | null",
      "doc": "取某航点的地理坐标(经纬高);不支持或越界返回 null"
     },
     {
      "kind": "method",
      "name": "setWaypointGeo",
      "signature": "setWaypointGeo(index: number, geo: WaypointGeo): boolean",
      "doc": "用地理坐标原地改写一个航点(经纬高 → 本地米坐标的逆向换算由实现方完成)。 Cesium 后端可写;three 等本地米坐标系无地理锚点,返回 false(面板仅在 geo 模式且 supportsGeoCoordinates() 为 true 时才调用,故 three 不会走到这里)。"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-world",
  "file": "drone-world",
  "title": "DroneWorld · 地面世界",
  "group": "机械与感知层",
  "doc": "飞行沙盒的场景辅助:地面网格、返航点标记、障碍物、航迹尾迹。",
  "items": [
   {
    "name": "ObstacleSpec",
    "kind": "interface",
    "signature": "interface ObstacleSpec { … }",
    "doc": "一个障碍物(AABB 盒)规格:x/z 为中心平面坐标,width/depth/height 单位为米,color 为 0xRRGGBB",
    "members": [
     {
      "kind": "property",
      "name": "name",
      "signature": "name: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "label",
      "signature": "label: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "x",
      "signature": "x: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "z",
      "signature": "z: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "width",
      "signature": "width: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "depth",
      "signature": "depth: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "height",
      "signature": "height: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "color",
      "signature": "color: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "baseY",
      "signature": "baseY?: number",
      "doc": "底面离地高度(米)。默认 0 = 落地障碍物;>0 = 悬空障碍物(天桥等),机体上方测距用"
     }
    ]
   },
   {
    "name": "DEFAULT_OBSTACLES",
    "kind": "const",
    "signature": "const DEFAULT_OBSTACLES: ObstacleSpec[]",
    "doc": "默认障碍物:两组建筑 + 一根正前方灯杆 + 三棵树 + 一道悬空天桥,都在起飞点 30 米内",
    "members": []
   },
   {
    "name": "MissionMarker",
    "kind": "interface",
    "signature": "interface MissionMarker { … }",
    "doc": "航线航点(可视化用):x/z 为水平坐标,altitude 为相对起飞点高度",
    "members": [
     {
      "kind": "property",
      "name": "x",
      "signature": "x: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "z",
      "signature": "z: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "altitude",
      "signature": "altitude: number",
      "doc": ""
     }
    ]
   },
   {
    "name": "DroneWorld",
    "kind": "class",
    "signature": "declare class DroneWorld { … }",
    "doc": "场景辅助的创建与更新(见文件头):地面网格 / 返航点标记 / 障碍物 / 航迹,以及航线任务可视化。 障碍物同时以 AABB 形式写入 collisionBoxes 供仿真避障使用,可视化与物理共用同一份数据。",
    "members": [
     {
      "kind": "property",
      "name": "collisionBoxes",
      "signature": "readonly collisionBoxes: ObstacleBox[]",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "specs",
      "signature": "readonly specs: ObstacleSpec[]",
      "doc": ""
     },
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(scene: THREE.Scene, specs?: ObstacleSpec[])",
      "doc": "构造地面世界:底板/网格/返航点标记内部建,障碍物与任务组可见性外部可切"
     },
     {
      "kind": "method",
      "name": "pushTrail",
      "signature": "pushTrail(x: number, y: number, z: number): void",
      "doc": "记录航迹:每移动 0.25 米落一个点,避免长航线把缓冲撑爆"
     },
     {
      "kind": "method",
      "name": "clearTrail",
      "signature": "clearTrail(): void",
      "doc": "清空航迹线(场景里的飞行尾迹与鹰眼图一起清)"
     },
     {
      "kind": "method",
      "name": "getTrail",
      "signature": "getTrail(): { positions: Float32Array; count: number; }",
      "doc": "航迹尾迹快照(只读):`positions` 是 x/y/z 连续排布的缓冲,前 `count * 3` 个分量有效。 鹰眼图(DroneMiniMap)靠它把已飞路径投到俯视图上;直接返回内部缓冲,调用方只读不改。"
     },
     {
      "kind": "method",
      "name": "setObstaclesVisible",
      "signature": "setObstaclesVisible(visible: boolean): void",
      "doc": "显示/隐藏全部障碍物(碰撞盒保留,只影响渲染)"
     },
     {
      "kind": "method",
      "name": "setCaptureHelpersVisible",
      "signature": "setCaptureHelpersVisible(visible: boolean): void",
      "doc": "采集辅助显隐 —— 拍照 / 录像取景时应临时隐藏的**场景标记**。"
     },
     {
      "kind": "method",
      "name": "coneCast",
      "signature": "coneCast(origin: THREE.Vector3, axis: THREE.Vector3, u1: THREE.Vector3, u2: THREE.Vector3, tanU1: number, tanU2: number, maxDistance: number): { distance: number; label: string; } | null",
      "doc": "锥形视场检测(雷达/视觉传感器用):传感器是一台有视场的相机,不是一条无粗细的射线。"
     },
     {
      "kind": "method",
      "name": "setMissionWaypoints",
      "signature": "setMissionWaypoints(waypoints: MissionMarker[], origin: { x: number; z: number; }): void",
      "doc": "重建航点标记与航线折线(只在航线内容变化时调用,内部先清掉旧对象)。"
     },
     {
      "kind": "method",
      "name": "updateMissionWaypoint",
      "signature": "updateMissionWaypoint(index: number, waypoint: MissionMarker): void",
      "doc": "原位更新一个航点(场景里拖拽时每帧调用)。"
     },
     {
      "kind": "method",
      "name": "setMissionActive",
      "signature": "setMissionActive(index: number, waypoint: MissionMarker | null): void",
      "doc": "高亮当前执行目标航点(传 null 取消高亮;waypoint 省略时按索引取当前数据)"
     },
     {
      "kind": "method",
      "name": "setMissionSelection",
      "signature": "setMissionSelection(index: number, waypoint?: MissionMarker | null): void",
      "doc": "场景编辑:选中高亮"
     },
     {
      "kind": "method",
      "name": "setMissionHover",
      "signature": "setMissionHover(index: number, waypoint?: MissionMarker | null): void",
      "doc": "场景编辑:悬停高亮"
     },
     {
      "kind": "method",
      "name": "pickMissionWaypoint",
      "signature": "pickMissionWaypoint(raycaster: THREE.Raycaster): number",
      "doc": "拾取航点:返回命中的航点索引,没命中返回 -1(看不见的图层不参与拾取)"
     },
     {
      "kind": "method",
      "name": "pickMissionGround",
      "signature": "pickMissionGround(raycaster: THREE.Raycaster): { x: number; z: number; } | null",
      "doc": "拾取地面(水平面 y=0):场景里双击地面新增航点用。 射线几乎平行于地面时会打到很远的地方,由调用方按限距夹紧。"
     },
     {
      "kind": "method",
      "name": "setMissionVisible",
      "signature": "setMissionVisible(visible: boolean): void",
      "doc": "图层总开关(航点 + 航线 + 三套高亮)"
     },
     {
      "kind": "method",
      "name": "isMissionVisible",
      "signature": "isMissionVisible(): boolean",
      "doc": "航线是否可见(只读真值,面板 200ms 轮询同步)"
     },
     {
      "kind": "method",
      "name": "setMissionWaypointsVisible",
      "signature": "setMissionWaypointsVisible(visible: boolean): void",
      "doc": "只开关航点标记(不影响航线折线)"
     },
     {
      "kind": "method",
      "name": "isMissionWaypointsVisible",
      "signature": "isMissionWaypointsVisible(): boolean",
      "doc": "航线航点标记是否可见"
     },
     {
      "kind": "method",
      "name": "setMissionPathVisible",
      "signature": "setMissionPathVisible(visible: boolean): void",
      "doc": "只开关航线折线(不影响航点标记)"
     },
     {
      "kind": "method",
      "name": "isMissionPathVisible",
      "signature": "isMissionPathVisible(): boolean",
      "doc": "航线路径线是否可见"
     },
     {
      "kind": "method",
      "name": "setHome",
      "signature": "setHome(x: number, z: number): void",
      "doc": "把\"起飞点\"标记挪到指定位置(重新起飞时会更新返航点)"
     },
     {
      "kind": "method",
      "name": "destroy",
      "signature": "destroy(): void",
      "doc": "解散并释放场景图与几何/材质"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-rig",
  "file": "drone-rig",
  "title": "DroneRig · 机体装配",
  "group": "机械与感知层",
  "doc": "无人机模型的机械驱动。",
  "items": [
   {
    "name": "ArmPosition",
    "kind": "type",
    "signature": "type ArmPosition = 'FrontLeft' | 'FrontRight' | 'RearLeft' | 'RearRight'",
    "doc": "机臂位置标签(前/后 × 左/右),同时用作 PROP_SPIN_SIGN / ARM_LABELS 等表的键。",
    "members": []
   },
   {
    "name": "ARM_POSITIONS",
    "kind": "const",
    "signature": "const ARM_POSITIONS: ArmPosition[]",
    "doc": "四个机臂的固定遍历顺序(前左→前右→后左→后右):各处初始化、自检、建场都按它展开。",
    "members": []
   },
   {
    "name": "PROP_SPIN_SIGN",
    "kind": "const",
    "signature": "const PROP_SPIN_SIGN: Record<ArmPosition, number>",
    "doc": "对角反转:前左/后右 一组,前右/后左 一组,旋转方向相反。 符号不是猜的:实测出厂桨叶法线与自转轴的桨距角 φ(前左/后右 ≈ +15°, 前右/后左 ≈ −15°)。要产生向上拉力,φ>0 的桨必须俯视顺时针转(自转角递减),",
    "members": []
   },
   {
    "name": "GIMBAL_LIMITS",
    "kind": "const",
    "signature": "const GIMBAL_LIMITS: { readonly pitchMin: -90; readonly pitchMax: 60; readonly rollLimit: 45; readonly yawLimit: 5; }",
    "doc": "云台机械行程。 rollLimit 取 45°:挡位倾角上限最高 35°(运动挡),留 10° 余量 —— 否则满舵侧倾 就把横滚轴顶到机械限位,补偿被截断,回正瞬间画面会\"抖一下\"。",
    "members": []
   },
   {
    "name": "RigPartReport",
    "kind": "interface",
    "signature": "interface RigPartReport { … }",
    "doc": "模型自检结果(测试沙盒里逐项显示)",
    "members": [
     {
      "kind": "property",
      "name": "id",
      "signature": "id: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "label",
      "signature": "label: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "found",
      "signature": "found: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "drivable",
      "signature": "drivable: boolean",
      "doc": "该部件是否可被驱动"
     }
    ]
   },
   {
    "name": "DroneBodyPose",
    "kind": "interface",
    "signature": "interface DroneBodyPose { … }",
    "doc": "整机刚体位姿:位置为世界系(米),角度为度",
    "members": [
     {
      "kind": "property",
      "name": "x",
      "signature": "x: number",
      "doc": "世界系 X(东为正)"
     },
     {
      "kind": "property",
      "name": "y",
      "signature": "y: number",
      "doc": "世界系 Y(离地高度,米)"
     },
     {
      "kind": "property",
      "name": "z",
      "signature": "z: number",
      "doc": "世界系 Z(南为正)"
     },
     {
      "kind": "property",
      "name": "headingDeg",
      "signature": "headingDeg: number",
      "doc": "航向角:正北 0°,顺时针增加"
     },
     {
      "kind": "property",
      "name": "pitchDeg",
      "signature": "pitchDeg: number",
      "doc": "俯仰:正 = 抬头"
     },
     {
      "kind": "property",
      "name": "rollDeg",
      "signature": "rollDeg: number",
      "doc": "横滚:正 = 右压坡"
     }
    ]
   },
   {
    "name": "DroneRig",
    "kind": "class",
    "signature": "declare class DroneRig { … }",
    "doc": "无人机模型的机械驱动层:载入后按语义节点名解析出机臂/转子/桨叶/云台, 并对外提供折叠、自转、云台增稳、整机位姿四类写入接口及自检报告。",
    "members": [
     {
      "kind": "property",
      "name": "model",
      "signature": "readonly model: THREE.Group",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "parts",
      "signature": "readonly parts: RigPartReport[]",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "gimbalResponse",
      "signature": "gimbalResponse: number",
      "doc": "云台关节一阶跟随时间常数(秒)。>0 时关节不瞬时到位(模拟无刷电机响应), 0 = 立即到位。默认 20 ms。"
     },
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(model: THREE.Group)",
      "doc": "绑定机体模型根节点,建立机臂/桨叶/云台/起落架的机械控制"
     },
     {
      "kind": "getter",
      "name": "armFold",
      "signature": "get armFold(): number",
      "doc": "机臂当前折叠度(0 = 展开,1 = 完全收纳)"
     },
     {
      "kind": "getter",
      "name": "bladeOpen",
      "signature": "get bladeOpen(): number",
      "doc": "桨叶张开度(0 = 叠拢,1 = 张开):起飞自检要求完全张开"
     },
     {
      "kind": "getter",
      "name": "motorsSpinning",
      "signature": "get motorsSpinning(): boolean",
      "doc": "桨叶是否已开始旋转"
     },
     {
      "kind": "method",
      "name": "setArmFold",
      "signature": "setArmFold(fold: number): void",
      "doc": "设置机臂折叠度(0 = 展开,1 = 完全收纳);变化量 <1e-4 直接返回,避免每帧重复写节点。"
     },
     {
      "kind": "getter",
      "name": "legDeploy",
      "signature": "get legDeploy(): number",
      "doc": "起落架腿当前收放度(1 = 放下,0 = 完全收起);无腿节点的机体恒为 1"
     },
     {
      "kind": "method",
      "name": "setLegDeploy",
      "signature": "setLegDeploy(deploy: number): void",
      "doc": "设置起落架腿收放度(1 = 放下,0 = 完全收起)。 与机臂折叠同一条纪律:旋转四元数整体前乘在出厂姿态上 —— 哈士奇腿关节出厂 四元数是单位阵(等价于直接写 rotation.x),但保持同构写法,未来带烘焙姿态的"
     },
     {
      "kind": "method",
      "name": "updateBlades",
      "signature": "updateBlades(deltaSeconds: number): void",
      "doc": "桨叶姿态的唯一写入口(每帧调用): - 叠拢/张开:bladeOpen 以自己的节奏缓动。机臂完全展开(fold < 0.02) 且电机未转时目标为张开,以慢速率\"缓缓转回原位\";收纳时以快速率先叠拢。"
     },
     {
      "kind": "method",
      "name": "updateProps",
      "signature": "updateProps(load: number | Partial<Record<ArmPosition, number>>, deltaSeconds: number): void",
      "doc": "驱动桨叶:load 为电机负荷 0~1;也可传入按机臂位置索引的四电机转速表 (悬停 ≈ 1,来自 DroneSim 的四旋翼混控)—— 前飞时后桨快、前桨慢, 转向时一组对角桨快、另一组慢,与真机的升力差/反扭矩机制一致。"
     },
     {
      "kind": "method",
      "name": "applyBodyPose",
      "signature": "applyBodyPose(pose: DroneBodyPose): void",
      "doc": "整机刚体位姿的唯一写入入口:世界位置 + 航向施加在模型根节点, 俯仰/横滚施加在 CTRL_DJI_Root(模型内部重心)。机臂、转子、云台 全部挂在这条变换链下游,自动跟随整机运动,无需单独处理。"
     },
     {
      "kind": "method",
      "name": "setGimbalAttitude",
      "signature": "setGimbalAttitude(pitchDeg: number, rollDeg: number, yawDeg: number, bodyPitch?: number, bodyRoll?: number, deltaSeconds?: number): void",
      "doc": "云台增稳(三轴解耦):传入相对水平面的期望角度,机体倾斜由云端解算一次性反掉。"
     },
     {
      "kind": "method",
      "name": "getGimbalCameraTransform",
      "signature": "getGimbalCameraTransform(target: THREE.Object3D): boolean",
      "doc": "云台相机的世界位置与朝向(机载视角用)"
     },
     {
      "kind": "method",
      "name": "getGimbalCameraMount",
      "signature": "getGimbalCameraMount(target: THREE.Vector3, forwardOffset: number, pitchDeg?: number): boolean",
      "doc": "机载相机的**位置解耦**挂点(世界坐标):机体只贡献\"平移 + 航向\",不含倾斜。"
     },
     {
      "kind": "method",
      "name": "getGimbalCameraOrientation",
      "signature": "getGimbalCameraOrientation(target: THREE.Quaternion, pitchDeg: number, rollDeg: number, yawDeg: number): boolean",
      "doc": "机载相机的**姿态解耦**朝向(世界四元数):直接由飞控真值解算,不读骨骼链。"
     },
     {
      "kind": "method",
      "name": "destroy",
      "signature": "destroy(): void",
      "doc": "释放本类记录的可释放资源(几何/材质);模型本体归调用方所有,不在此销毁。"
     },
     {
      "kind": "method",
      "name": "getGimbalCameraClearance",
      "signature": "getGimbalCameraClearance(): number | null",
      "doc": "云台载荷沿光轴(-Z)的前端距离(**米**)。 取景相机沿光轴前移量必须大于该值(外加小余量),外壳才不会挡住视线。 同时取\"挂点前方的机体外形前伸量\"的较大者:否则机体自己的外观"
     },
     {
      "kind": "method",
      "name": "getArmFoldNode",
      "signature": "getArmFoldNode(position: ArmPosition): THREE.Object3D | null",
      "doc": "机臂折叠枢轴节点(状态灯等机臂附件挂到它下面即可跟随折叠/展开)"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-lights",
  "file": "drone-lights",
  "title": "DroneLights · 灯光",
  "group": "机械与感知层",
  "doc": "DJI Mini 4 Pro 灯光模拟。",
  "items": [
   {
    "name": "StatusLightKey",
    "kind": "type",
    "signature": "type StatusLightKey = 'selfCheck' | 'sensorWarmup' | 'gnssNormal' | 'gnssWeak' | 'attiMode' | 'rcLost' | 'lowBattery' | 'criticalBattery' | 'tilted' | 'fcError' | 'compassError' | 'motorRunning' | 'off'",
    "doc": "尾部状态灯语的键;每键对应 STATUS_PATTERNS 里的一套闪灯时序,由 statusPatternFor 按飞行状态映射",
    "members": []
   },
   {
    "name": "BatteryLightMode",
    "kind": "type",
    "signature": "type BatteryLightMode = 'level' | 'charging' | 'full' | 'fault' | 'off'",
    "doc": "电池电量灯模式:level=按电量分级点亮,其余为充电/满电/故障/关闭",
    "members": []
   },
   {
    "name": "AuxLightMode",
    "kind": "type",
    "signature": "type AuxLightMode = 'auto' | 'on' | 'off'",
    "doc": "底部辅助灯模式:auto=夜间低空自动,on=强制开,off=关",
    "members": []
   },
   {
    "name": "LightStep",
    "kind": "interface",
    "signature": "interface LightStep { … }",
    "doc": "灯语的一个时间片段:colors 依次对应 [左灯, 右灯](只给一个颜色时左右同色)",
    "members": [
     {
      "kind": "property",
      "name": "colors",
      "signature": "colors: number[]",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "onMs",
      "signature": "onMs: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "offMs",
      "signature": "offMs: number",
      "doc": ""
     }
    ]
   },
   {
    "name": "StatusPatternMeta",
    "kind": "interface",
    "signature": "interface StatusPatternMeta { … }",
    "doc": "一种灯语的元数据 + 时序(供面板展示,并由 applyStatusPattern 按时间轴驱动)",
    "members": [
     {
      "kind": "property",
      "name": "key",
      "signature": "key: StatusLightKey",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "label",
      "signature": "label: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "meaning",
      "signature": "meaning: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "uiColor",
      "signature": "uiColor: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "steps",
      "signature": "steps: LightStep[]",
      "doc": ""
     }
    ]
   },
   {
    "name": "STATUS_PATTERNS",
    "kind": "const",
    "signature": "const STATUS_PATTERNS: Record<StatusLightKey, Omit<StatusPatternMeta, 'key'>>",
    "doc": "尾部状态灯语库(与手册第 1 节一一对应)",
    "members": []
   },
   {
    "name": "STATUS_PATTERN_LIST",
    "kind": "const",
    "signature": "const STATUS_PATTERN_LIST: StatusPatternMeta[]",
    "doc": "供面板渲染的模式列表(保持手册顺序)",
    "members": []
   },
   {
    "name": "batteryLedPlan",
    "kind": "function",
    "signature": "function batteryLedPlan(levelPercent: number): { lit: number; blinkIndex: number | null; }",
    "doc": "手册第 2 节:电量 -> [常亮数, 闪烁的那一颗索引(从 0 计, null 无)]",
    "members": []
   },
   {
    "name": "describeBatteryLevel",
    "kind": "function",
    "signature": "function describeBatteryLevel(levelPercent: number): string",
    "doc": "生成电量对应的文字说明,例如 \"3 常亮 + 1 闪烁\"",
    "members": []
   },
   {
    "name": "statusPatternFor",
    "kind": "function",
    "signature": "function statusPatternFor(sim: DroneSim): StatusLightKey",
    "doc": "灯语与飞行状态的对应关系(与《Mini 4 Pro 灯光说明》一致)。",
    "members": []
   },
   {
    "name": "BatteryLedSnapshot",
    "kind": "interface",
    "signature": "interface BatteryLedSnapshot { … }",
    "doc": "单颗电量灯的对外快照(给面板做 CSS 动画镜像)",
    "members": [
     {
      "kind": "property",
      "name": "on",
      "signature": "on: boolean",
      "doc": "当前帧是否点亮"
     },
     {
      "kind": "property",
      "name": "blinking",
      "signature": "blinking: boolean",
      "doc": "该灯是否属于\"闪烁\"角色(供面板用 CSS 动画镜像)"
     }
    ]
   },
   {
    "name": "DroneLightsSnapshot",
    "kind": "interface",
    "signature": "interface DroneLightsSnapshot { … }",
    "doc": "灯光系统的整体快照(面板 100ms 轮询取用)",
    "members": [
     {
      "kind": "property",
      "name": "statusKey",
      "signature": "statusKey: StatusLightKey",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "statusLabel",
      "signature": "statusLabel: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "statusMeaning",
      "signature": "statusMeaning: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "batteryMode",
      "signature": "batteryMode: BatteryLightMode",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "batteryLevel",
      "signature": "batteryLevel: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "batteryLeds",
      "signature": "batteryLeds: BatteryLedSnapshot[]",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "auxMode",
      "signature": "auxMode: AuxLightMode",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "auxOn",
      "signature": "auxOn: boolean",
      "doc": "辅助灯当前是否真的点亮(受起飞状态门控)"
     },
     {
      "kind": "property",
      "name": "auxLocked",
      "signature": "auxLocked: boolean",
      "doc": "是否处于\"地面锁定\"(未起飞,辅助灯不可点亮)"
     }
    ]
   },
   {
    "name": "DroneLights",
    "kind": "class",
    "signature": "declare class DroneLights { … }",
    "doc": "灯光系统(见文件头):尾部状态灯 / 电池电量灯 / 底部辅助灯,以及模型自带的 LIGHT_* 点光源。",
    "members": [
     {
      "kind": "method",
      "name": "attach",
      "signature": "attach(model: THREE.Group, scene: THREE.Scene): void",
      "doc": "在模型局部坐标系中构建灯组并挂载到模型节点下"
     },
     {
      "kind": "method",
      "name": "update",
      "signature": "update(deltaSeconds: number): void",
      "doc": "每帧驱动:deltaSeconds"
     },
     {
      "kind": "method",
      "name": "setStatusPattern",
      "signature": "setStatusPattern(key: StatusLightKey): void",
      "doc": "设置状态灯语(仅登记意图,下一帧 update 生效);未知键忽略"
     },
     {
      "kind": "method",
      "name": "setBatteryMode",
      "signature": "setBatteryMode(mode: BatteryLightMode): void",
      "doc": "设置电池灯模式(仅登记意图,下一帧 update 生效)"
     },
     {
      "kind": "method",
      "name": "setBatteryLevel",
      "signature": "setBatteryLevel(levelPercent: number): void",
      "doc": "设置电量百分比(0~100,越界自动夹紧);到灯珠的映射见 batteryLedPlan"
     },
     {
      "kind": "method",
      "name": "setAuxLightMode",
      "signature": "setAuxLightMode(mode: AuxLightMode): void",
      "doc": "设置底部辅助灯模式(仅登记意图;实际点亮还受\"已起飞\"门控,见 applyAux)"
     },
     {
      "kind": "method",
      "name": "setBeamVisible",
      "signature": "setBeamVisible(visible: boolean): void",
      "doc": "底部辅助灯的锥形光束显隐(不影响辅助灯本身的照明)。 立即重算一次,不必等下一帧。"
     },
     {
      "kind": "method",
      "name": "isBeamVisible",
      "signature": "isBeamVisible(): boolean",
      "doc": "当前是否绘制锥形光束(探针用)"
     },
     {
      "kind": "method",
      "name": "setFlying",
      "signature": "setFlying(flying: boolean): void",
      "doc": "由飞行控制器每帧同步:是否已离地起飞"
     },
     {
      "kind": "method",
      "name": "attachStatusToArms",
      "signature": "attachStatusToArms(leftFold: THREE.Object3D | null, rightFold: THREE.Object3D | null): void",
      "doc": "把尾部状态灯(模型自带灯珠网格 + 点光源)挂到后机臂折叠节点下,跟随折叠/展开运动。"
     },
     {
      "kind": "method",
      "name": "syncStatusToArms",
      "signature": "syncStatusToArms(): void",
      "doc": "每帧把状态灯珠按\"骨骼绑定位姿\"强制同步(骨骼动画式跟随)。 灯珠像焊死在机臂末端一样随折叠/展开运动;任何外力(热更新、调试脚本 挪动、意外重挂)造成的偏移都会在下一帧自动归位。"
     },
     {
      "kind": "method",
      "name": "getSnapshot",
      "signature": "getSnapshot(): DroneLightsSnapshot",
      "doc": "灯光系统快照(面板轮询用)"
     },
     {
      "kind": "method",
      "name": "destroy",
      "signature": "destroy(): void",
      "doc": "拆除灯组:灯珠/点光源放回出厂父节点、还原共享材质、释放自建资源(漏掉会让热更新重建时找不到灯珠)"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-radar",
  "file": "drone-radar",
  "title": "DroneRadar · 雷达",
  "group": "机械与感知层",
  "doc": "测距雷达(简化版 DJI 全向视觉避障感知):",
  "items": [
   {
    "name": "RadarHit",
    "kind": "interface",
    "signature": "interface RadarHit { … }",
    "doc": "测距雷达(简化版 DJI 全向视觉避障感知):",
    "members": [
     {
      "kind": "property",
      "name": "distance",
      "signature": "distance: number",
      "doc": "传感器到命中物的距离(米,沿瞄准轴量到障碍物近端)"
     },
     {
      "kind": "property",
      "name": "label",
      "signature": "label: string",
      "doc": "命中物标签(建筑 A / 灯杆 / 天桥…)"
     }
    ]
   },
   {
    "name": "RadarAim",
    "kind": "type",
    "signature": "type RadarAim = 'forward' | 'sensor'",
    "doc": "瞄准模式:forward = 镜头转去看正前方/正上方;sensor = 沿玻璃面法线(镜头本体朝向)",
    "members": []
   },
   {
    "name": "RadarSnapshot",
    "kind": "interface",
    "signature": "interface RadarSnapshot { … }",
    "doc": "",
    "members": [
     {
      "kind": "property",
      "name": "detecting",
      "signature": "detecting: boolean",
      "doc": "雷达是否在工作(上电后可用)"
     },
     {
      "kind": "property",
      "name": "left",
      "signature": "left: RadarHit | null",
      "doc": "前视·左传感器命中,null = 视场内无障碍物"
     },
     {
      "kind": "property",
      "name": "right",
      "signature": "right: RadarHit | null",
      "doc": "前视·右传感器命中"
     },
     {
      "kind": "property",
      "name": "range",
      "signature": "range: number",
      "doc": "前视量程(米),按官方 0.5~18 m"
     },
     {
      "kind": "property",
      "name": "upLeft",
      "signature": "upLeft: RadarHit | null",
      "doc": "上视·左传感器命中(机背左孔)"
     },
     {
      "kind": "property",
      "name": "upRight",
      "signature": "upRight: RadarHit | null",
      "doc": "上视·右传感器命中(机背右孔)"
     },
     {
      "kind": "property",
      "name": "upRange",
      "signature": "upRange: number",
      "doc": "上视量程(米),按官方 0.5~15 m"
     },
     {
      "kind": "property",
      "name": "aim",
      "signature": "aim: RadarAim",
      "doc": "当前瞄准模式"
     }
    ]
   },
   {
    "name": "DroneRadar",
    "kind": "class",
    "signature": "declare class DroneRadar { … }",
    "doc": "测距雷达(见文件头):四台视觉传感器(前视双摄 + 上视双孔),每帧做锥形视场检测并更新可视化。 只做\"传感器测量 + 可视化\";刹停保护由 drone-sim 的 AABB 避障负责,两层互不干扰。",
    "members": [
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(scene: THREE.Scene)",
      "doc": "绑定雷达扫描可视化(光束挂机体下方,随障碍物真值偏转)"
     },
     {
      "kind": "getter",
      "name": "range",
      "signature": "get range(): number",
      "doc": "前视量程(米),按官方 0.5~18 m"
     },
     {
      "kind": "getter",
      "name": "upRange",
      "signature": "get upRange(): number",
      "doc": "上视量程(米),按官方 0.5~15 m"
     },
     {
      "kind": "method",
      "name": "getSnapshot",
      "signature": "getSnapshot(): RadarSnapshot",
      "doc": "当前读数(每帧刷新;Vue 100ms 轮询取用)"
     },
     {
      "kind": "method",
      "name": "setAim",
      "signature": "setAim(aim: RadarAim): void",
      "doc": "瞄准模式:forward = 镜头转去看正前方(上视 = 正上方);sensor = 沿玻璃面法线。 切换后镜头会平滑转过去(不是瞬移)。"
     },
     {
      "kind": "method",
      "name": "getAim",
      "signature": "getAim(): RadarAim",
      "doc": "当前瞄准模式(forward / sensor)"
     },
     {
      "kind": "method",
      "name": "bindSensors",
      "signature": "bindSensors(model: THREE.Object3D): void",
      "doc": "从模型里读出两组视觉玻璃网格(前视双摄 + 机背上视双孔), 记录其几何中心与镜面法线。开机时调用一次即可。"
     },
     {
      "kind": "method",
      "name": "isBoundToSensors",
      "signature": "isBoundToSensors(): boolean",
      "doc": "是否两组都成功绑定到模型(探针用)"
     },
     {
      "kind": "method",
      "name": "debugInfo",
      "signature": "debugInfo(): Array<{ group: string; position: string; nodeName: string; bound: boolean; aimDeg: number[]; }>",
      "doc": "每个传感器的绑定情况(探针用)"
     },
     {
      "kind": "method",
      "name": "update",
      "signature": "update(model: THREE.Object3D, world: DroneWorld, delta: number, detecting: boolean): void",
      "doc": "每帧更新:先让镜头朝目标方向平滑转动,再做锥形视场检测。 起点逐帧取自视觉玻璃网格的世界矩阵(与画面里的镜头/孔完全重合)。"
     },
     {
      "kind": "method",
      "name": "setVisible",
      "signature": "setVisible(visible: boolean): void",
      "doc": "页面调试开关:隐藏/显示射线可视化(读数照常)。 只记录状态并立即生效;随后每帧的 update() 会沿用这个状态,不会被覆盖。"
     },
     {
      "kind": "method",
      "name": "isBeamsVisible",
      "signature": "isBeamsVisible(): boolean",
      "doc": "当前射线可视化是否显示(探针用)"
     },
     {
      "kind": "method",
      "name": "destroy",
      "signature": "destroy(): void",
      "doc": "释放几何/材质并复位读数"
     }
    ]
   }
  ]
 },
 {
  "id": "mission-editor",
  "file": "mission-editor",
  "title": "MissionEditor · 航线编辑",
  "group": "机械与感知层",
  "doc": "场景内航点编辑器:在三维场景里直接抓航点。",
  "items": [
   {
    "name": "MissionDragMode",
    "kind": "type",
    "signature": "type MissionDragMode = 'move' | 'altitude'",
    "doc": "拖拽模式:move=在当前高度的水平面内平移,altitude=改高度(Shift 拖拽)",
    "members": []
   },
   {
    "name": "MissionEditLimits",
    "kind": "interface",
    "signature": "interface MissionEditLimits { … }",
    "doc": "编辑界限:home 位置用于限距判定,高度/距离上限由仿真内核下发(单位:米)",
    "members": [
     {
      "kind": "property",
      "name": "maxAltitude",
      "signature": "maxAltitude: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "maxDistance",
      "signature": "maxDistance: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "homeX",
      "signature": "homeX: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "homeZ",
      "signature": "homeZ: number",
      "doc": ""
     }
    ]
   },
   {
    "name": "MissionEditState",
    "kind": "interface",
    "signature": "interface MissionEditState { … }",
    "doc": "编辑器对外状态快照:enabled 是面板开关,active 还需「当前确实可编辑」(观察者视角 + 任务未执行)",
    "members": [
     {
      "kind": "property",
      "name": "enabled",
      "signature": "enabled: boolean",
      "doc": "面板开关"
     },
     {
      "kind": "property",
      "name": "active",
      "signature": "active: boolean",
      "doc": "开关开着且当前确实可编辑(观察者视角 + 任务未执行)"
     },
     {
      "kind": "property",
      "name": "selectedIndex",
      "signature": "selectedIndex: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "hoverIndex",
      "signature": "hoverIndex: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "dragging",
      "signature": "dragging: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "mode",
      "signature": "mode: MissionDragMode | null",
      "doc": ""
     }
    ]
   },
   {
    "name": "MissionEditorHost",
    "kind": "interface",
    "signature": "interface MissionEditorHost { … }",
    "doc": "编辑器依赖的宿主接口:航点数据以仿真内核为权威源,编辑器只通过它读写, 因此这里不含任何三维标记的实现细节(标记由 world 负责重建)。",
    "members": [
     {
      "kind": "property",
      "name": "canvas",
      "signature": "canvas: HTMLCanvasElement",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "camera",
      "signature": "camera: THREE.PerspectiveCamera",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "world",
      "signature": "world: DroneWorld",
      "doc": ""
     },
     {
      "kind": "method",
      "name": "canEdit",
      "signature": "canEdit(): boolean",
      "doc": "当前是否可编辑:观察者视角 + 航线未在执行"
     },
     {
      "kind": "method",
      "name": "getWaypoints",
      "signature": "getWaypoints(): MissionWaypoint[]",
      "doc": "航点列表(权威源 = 仿真内核)"
     },
     {
      "kind": "method",
      "name": "getSelected",
      "signature": "getSelected(): number",
      "doc": "宿主查询当前选中航点索引(无选中返回 -1)"
     },
     {
      "kind": "method",
      "name": "setSelected",
      "signature": "setSelected(index: number): void",
      "doc": "宿主同步选中航点(编辑器点击/面板列表双向联动)"
     },
     {
      "kind": "method",
      "name": "commitWaypoints",
      "signature": "commitWaypoints(waypoints: Array<Partial<MissionWaypoint>>, selected: number): void",
      "doc": "整表提交(新增 / 删除):会重建三维标记"
     },
     {
      "kind": "method",
      "name": "moveWaypoint",
      "signature": "moveWaypoint(index: number, patch: Partial<MissionWaypoint>): MissionWaypoint | null",
      "doc": "拖动中的单点实时更新,返回夹紧后的航点(限高限距已生效)"
     },
     {
      "kind": "method",
      "name": "setOrbitEnabled",
      "signature": "setOrbitEnabled(enabled: boolean): void",
      "doc": "拖动期间暂停/恢复轨道控制"
     },
     {
      "kind": "method",
      "name": "getLimits",
      "signature": "getLimits(): MissionEditLimits",
      "doc": "取编辑限制(最多航点数/最低高度等,供面板校验)"
     },
     {
      "kind": "method",
      "name": "newWaypointTemplate",
      "signature": "newWaypointTemplate(index: number): Partial<MissionWaypoint>",
      "doc": "新航点的默认参数(继承相邻航点的高度与速度)"
     },
     {
      "kind": "method",
      "name": "log",
      "signature": "log(level: 'info' | 'warn', text: string): void",
      "doc": "编辑器日志出口(宿主可接到面板或控制台)"
     }
    ]
   },
   {
    "name": "MissionEditor",
    "kind": "class",
    "signature": "declare class MissionEditor { … }",
    "doc": "场景内航点编辑器:接管画布的指针/键盘事件,把拖拽、双击新增、删除等操作翻译成 对宿主航点数据的修改。使用:构造传入宿主 → 每帧 update() → 面板开关 setEnabled() → 卸载时 destroy()。具体操作约定见本文件顶部模块说明。",
    "members": [
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(host: MissionEditorHost)",
      "doc": "构造航线编辑器:维护航点列表与 Home 点,产出可执行任务"
     },
     {
      "kind": "getter",
      "name": "isEnabled",
      "signature": "get isEnabled(): boolean",
      "doc": "编辑模式是否开启(开启时点场景可加/拖航点)"
     },
     {
      "kind": "method",
      "name": "setEnabled",
      "signature": "setEnabled(enabled: boolean): void",
      "doc": "开关编辑模式"
     },
     {
      "kind": "method",
      "name": "update",
      "signature": "update(): void",
      "doc": "每帧校验:不可编辑时自动收摊(切成机载视角 / 任务开始执行都会走到这里)"
     },
     {
      "kind": "method",
      "name": "getState",
      "signature": "getState(): MissionEditState",
      "doc": "取航线只读快照(航点/Home/可视性,供面板与鹰眼图渲染)"
     },
     {
      "kind": "method",
      "name": "destroy",
      "signature": "destroy(): void",
      "doc": "解散编辑器与场景里的航线辅助物"
     },
     {
      "kind": "method",
      "name": "deleteWaypoint",
      "signature": "deleteWaypoint(index: number): boolean",
      "doc": "删除一个航点(面板按钮与 Delete 键共用)"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-fly",
  "file": "drone-fly",
  "title": "DroneFly · three 后端",
  "group": "飞行总控层",
  "doc": "飞行沙盒的\"装配层 + 主循环\":把仿真内核(drone-sim)、模型机械(drone-rig)、场景辅助(drone-world)、 灯光(drone-lights)、雷达(drone-radar)接成一个可交互的三维飞行场景。",
  "items": [
   {
    "name": "DRONE_MODEL_URL",
    "kind": "const",
    "signature": "const DRONE_MODEL_URL = \"/models/djiair_renamed.glb\"",
    "doc": "默认真机机体模型路径(DJI Mini 4 Pro 重命名版)。 资产不随库打包,需使用方自行提供 —— 所以它**不再是 initialize() 的缺省值**: 不传 modelUrl 时用的是零依赖的内置积木机体,想要真机模型就把这个常量传进去。",
    "members": []
   },
   {
    "name": "DRONE_MAX_SPEED_METERS_PER_SECOND",
    "kind": "const",
    "signature": "const DRONE_MAX_SPEED_METERS_PER_SECOND: number",
    "doc": "机型最快档位速度,用于界面提示",
    "members": []
   },
   {
    "name": "DroneDirection",
    "kind": "type",
    "signature": "type DroneDirection = 'up' | 'down' | 'left' | 'right'",
    "doc": "旧版方向键 API(仅保留给外部复用)",
    "members": []
   },
   {
    "name": "DroneVerticalDirection",
    "kind": "type",
    "signature": "type DroneVerticalDirection = 'up' | 'down'",
    "doc": "纯升降方向",
    "members": []
   },
   {
    "name": "DroneRotationDirection",
    "kind": "type",
    "signature": "type DroneRotationDirection = 'left' | 'right'",
    "doc": "纯偏航(左右转向)方向",
    "members": []
   },
   {
    "name": "CameraMode",
    "kind": "type",
    "signature": "type CameraMode = 'orbit' | 'follow' | 'fpv'",
    "doc": "相机视角模式:orbit=观察者(轨道控制器),follow=跟随,fpv=机载(云台视角)",
    "members": []
   },
   {
    "name": "CAMERA_MODE_LIST",
    "kind": "const",
    "signature": "const CAMERA_MODE_LIST: Array<{ key: CameraMode; label: string; }>",
    "doc": "面板用的相机模式列表(含中文标签)",
    "members": []
   },
   {
    "name": "GimbalStabilization",
    "kind": "type",
    "signature": "type GimbalStabilization = 'full' | 'physical'",
    "doc": "云台增稳档位 —— **模型不参与稳像,全部在相机侧反向抵消**: - `full`(默认):姿态 + 位置双解耦。取景相机的位置与朝向都由飞控真值直接解出 (`机体平移 + R_y(航向)·挂点` / `R_y(航向+云台偏航)·R_x(云台俯仰)⊗安装偏置`),",
    "members": []
   },
   {
    "name": "GimbalStabilizationOptions",
    "kind": "interface",
    "signature": "interface GimbalStabilizationOptions { … }",
    "doc": "云台增稳可调项(见 DroneFly.configureGimbal)",
    "members": [
     {
      "kind": "property",
      "name": "stabilization",
      "signature": "stabilization?: GimbalStabilization",
      "doc": "增稳档位,默认 'full'"
     },
     {
      "kind": "property",
      "name": "response",
      "signature": "response?: number",
      "doc": "云台关节一阶跟随时间常数(秒):0 = 立即到位,默认 0.02(20 ms)。 只作用于**模型外观**(云台看起来像无刷电机一样有响应时间); `full` 档下相机不采样关节,所以不会因为滞后而晃。"
     },
     {
      "kind": "property",
      "name": "smoothing",
      "signature": "smoothing?: number",
      "doc": "电子增稳强度 0~1:0 = 关闭,默认 0(解耦后目标姿态已无噪声,低通只会加滞后)"
     }
    ]
   },
   {
    "name": "PhotoShot",
    "kind": "interface",
    "signature": "interface PhotoShot { … }",
    "doc": "单张照片(云台相机取景)",
    "members": [
     {
      "kind": "property",
      "name": "dataUrl",
      "signature": "dataUrl: string",
      "doc": "PNG data URL,可直接用于 <img> 或下载"
     },
     {
      "kind": "property",
      "name": "width",
      "signature": "width: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "height",
      "signature": "height: number",
      "doc": ""
     }
    ]
   },
   {
    "name": "DroneFlyInitializeOptions",
    "kind": "interface",
    "signature": "interface DroneFlyInitializeOptions { … }",
    "doc": "DroneFly.initialize() 的可选配置",
    "members": [
     {
      "kind": "property",
      "name": "modelUrl",
      "signature": "modelUrl?: string",
      "doc": "机体模型 GLB 地址(URL 或相对路径)。 **不传 = 用内置的「积木无人机」**(程序化几何体拼出来的四轴,零资产依赖, 见 `createHuskyDroneModel`);需要真机模型时再传,例如 `DRONE_MODEL_URL`。"
     },
     {
      "kind": "property",
      "name": "obstacles",
      "signature": "obstacles?: ObstacleSpec[]",
      "doc": "场景里的障碍物(建筑 / 灯杆 / 天桥 / 树…… 都是 AABB 盒),同一份数据既生成可视网格, 又喂给飞控做避障判定 —— 换了坐标,画面和碰撞会一起变。 缺省用内置的 `DEFAULT_OBSTACLES`(起飞点 30 米内的 7 个参考物);"
     }
    ]
   },
   {
    "name": "DroneFly",
    "kind": "class",
    "signature": "declare class DroneFly implements DronePanelHost { … }",
    "doc": "飞行沙盒的装配层:把飞行仿真内核、模型机械、场景辅助与灯光接到一起。",
    "members": [
     {
      "kind": "property",
      "name": "camera",
      "signature": "camera: THREE.PerspectiveCamera | null",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "scene",
      "signature": "scene: THREE.Scene<THREE.Object3DEventMap> | null",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "renderer",
      "signature": "renderer: WebGPURenderer | null",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "controls",
      "signature": "controls: OrbitControls<THREE.Camera> | null",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "model",
      "signature": "model: THREE.Group | null",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "lights",
      "signature": "lights: DroneLights | null",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "rig",
      "signature": "rig: DroneRig | null",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "world",
      "signature": "world: DroneWorld | null",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "radar",
      "signature": "radar: DroneRadar | null",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "sim",
      "signature": "readonly sim: DroneSim",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "engine",
      "signature": "readonly engine: \"three\"",
      "doc": "引擎标识。DroneFly 是 three.js 实现,与 CesiumDroneAdapter 的 `engine = 'cesium'` 构成判别字段 —— 宿主用同一份 `createDroneControl({ engine })` 装配,拿到实例后 还能靠它 `if (drone.engine === 'three')` 访问引擎特有成员。"
     },
     {
      "kind": "property",
      "name": "cameraMode",
      "signature": "cameraMode: CameraMode",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "gimbalStabilization",
      "signature": "gimbalStabilization: GimbalStabilization",
      "doc": "云台增稳档位(见 GimbalStabilization);默认位置 + 姿态双解耦"
     },
     {
      "kind": "property",
      "name": "gimbalResponse",
      "signature": "gimbalResponse: number",
      "doc": "云台关节一阶跟随时间常数(秒),0 = 立即到位;仅影响模型外观,初值同步给 rig"
     },
     {
      "kind": "property",
      "name": "fpvSmoothing",
      "signature": "fpvSmoothing: number",
      "doc": "电子增稳强度 0~1,0 = 关闭(默认)"
     },
     {
      "kind": "property",
      "name": "missionEditor",
      "signature": "missionEditor: MissionEditor | null",
      "doc": "场景内航点编辑器(需要画布,headless / 无渲染器时为 null)"
     },
     {
      "kind": "property",
      "name": "onRecordingReady",
      "signature": "onRecordingReady: ((blob: Blob, seconds: number) => void) | null",
      "doc": "录像收尾回调:UI 用它落盘(引擎不直接触发下载)"
     },
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(scene: THREE.Scene<THREE.Object3DEventMap> | null, camera: THREE.PerspectiveCamera | null, renderer: WebGPURenderer | null, controls: OrbitControls<THREE.Camera> | null)",
      "doc": "飞行总控:接管场景/相机/渲染器/控制器,装配仿真内核与机体机械"
     },
     {
      "kind": "method",
      "name": "initialize",
      "signature": "initialize(options?: DroneFlyInitializeOptions): Promise<void>",
      "doc": "初始化无人机:装配机体模型,并挂入机械 / 灯光 / 场景 / 雷达 / 编辑器各子系统, 最后做一次初始同步。可重复调用前需先 dispose(本方法不自动清理旧模型)。"
     },
     {
      "kind": "method",
      "name": "animate",
      "signature": "animate(deltaSeconds?: number): void",
      "doc": "每帧推进:固定步长跑仿真,与渲染帧率解耦。 低帧率机器(或无头环境)不会让仿真变慢 —— 用累加器补帧;挂起后的超长帧直接丢弃积压。"
     },
     {
      "kind": "method",
      "name": "getRadarSnapshot",
      "signature": "getRadarSnapshot(): RadarSnapshot",
      "doc": "测距雷达最新读数:前视双镜头 + 上视双孔(Vue 面板 100ms 轮询)"
     },
     {
      "kind": "method",
      "name": "setRadarAim",
      "signature": "setRadarAim(aim: RadarAim): void",
      "doc": "切换镜头瞄准:forward = 转向正前方/正上方;sensor = 沿镜头(玻璃面)朝向"
     },
     {
      "kind": "method",
      "name": "setRadarBeamsVisible",
      "signature": "setRadarBeamsVisible(visible: boolean): void",
      "doc": "切换雷达射线可视化(前视 + 上视,读数不受影响)"
     },
     {
      "kind": "method",
      "name": "isRadarBeamsVisible",
      "signature": "isRadarBeamsVisible(): boolean",
      "doc": "当前雷达射线可视化是否显示(探针用)"
     },
     {
      "kind": "method",
      "name": "setAuxBeamVisible",
      "signature": "setAuxBeamVisible(visible: boolean): void",
      "doc": "切换底部辅助灯的锥形光束显隐(不影响辅助灯照明)"
     },
     {
      "kind": "method",
      "name": "isAuxBeamVisible",
      "signature": "isAuxBeamVisible(): boolean",
      "doc": "当前辅助灯锥形光束是否绘制(探针用)"
     },
     {
      "kind": "method",
      "name": "setCameraMode",
      "signature": "setCameraMode(mode: CameraMode): void",
      "doc": "切换相机视角;进出机载视角时保存/归还轨道视角的缩放(变焦只在机载下生效)"
     },
     {
      "kind": "getter",
      "name": "isOrbitView",
      "signature": "get isOrbitView(): boolean",
      "doc": "当前是否为观察者(轨道控制)视角;非轨道模式下渲染循环不得调用 controls.update(),否则其每帧 lookAt(target) 会覆盖机载/跟随朝向"
     },
     {
      "kind": "method",
      "name": "flyTo",
      "signature": "flyTo(target: { x?: number; y?: number; z?: number; heading?: number; pitch?: number; roll?: number; }): void",
      "doc": "直接把无人机移动到目标位置并同步观察点/朝向"
     },
     {
      "kind": "method",
      "name": "zoomTo",
      "signature": "zoomTo(zoom: number): void",
      "doc": "直接调整镜头/云台变焦倍数(1~4x),并同步当前机载视角"
     },
     {
      "kind": "method",
      "name": "configureGimbal",
      "signature": "configureGimbal(options?: GimbalStabilizationOptions): void",
      "doc": "调云台增稳参数(机载视角稳定性调优入口)。"
     },
     {
      "kind": "method",
      "name": "setCaptureView",
      "signature": "setCaptureView(override: CaptureViewOverride | null): void",
      "doc": "设置取景**俯仰**覆盖 —— 全景扫描(180° / 360°)按俯仰层逐张取景的入口;传 `null` 复位。"
     },
     {
      "kind": "method",
      "name": "spinBodyTo",
      "signature": "spinBodyTo(headingDeg: number | null): void",
      "doc": "让**机体原地自转**到绝对方位角 `headingDeg`(度,罗盘角);`null` 停止自转。"
     },
     {
      "kind": "method",
      "name": "getBodyHeading",
      "signature": "getBodyHeading(): number",
      "doc": "机体当前方位角(度,罗盘角)—— 全景扫描用它判断\"转到位了没\""
     },
     {
      "kind": "method",
      "name": "captureRecordingFrame",
      "signature": "captureRecordingFrame(): void",
      "doc": "录制帧 —— 交给录制器的画面恒为云台取景,与用户此刻在哪个视角无关。"
     },
     {
      "kind": "method",
      "name": "requestPhoto",
      "signature": "requestPhoto(): Promise<PhotoShot | null>",
      "doc": "拍照:用云台相机取景拍一张 PNG。"
     },
     {
      "kind": "method",
      "name": "getCaptureCamera",
      "signature": "getCaptureCamera(): CaptureCameraState | null",
      "doc": "取景相机(云台镜头)的位姿与内参快照 —— 虚拟影像采集用(见 drone-capture 的 `VirtualCaptureProvider`)。与 CesiumDroneAdapter.getCaptureCamera 同义。"
     },
     {
      "kind": "method",
      "name": "onBeforeRender",
      "signature": "onBeforeRender(): void",
      "doc": "渲染前钩子(渲染循环在 controls.update 之后、render 之前调用):本帧按云台相机取景"
     },
     {
      "kind": "method",
      "name": "onAfterRender",
      "signature": "onAfterRender(): void",
      "doc": "渲染后钩子:与渲染同一任务内拷屏,然后把相机位姿还原"
     },
     {
      "kind": "getter",
      "name": "isRecording",
      "signature": "get isRecording(): boolean",
      "doc": "当前是否正在屏录(以 MediaRecorder 实例是否存在为准)"
     },
     {
      "kind": "method",
      "name": "startRecording",
      "signature": "startRecording(): boolean",
      "doc": "开始屏录(录云台取景,与用户当前视角无关)。返回 false = 当前环境不支持"
     },
     {
      "kind": "method",
      "name": "stopRecording",
      "signature": "stopRecording(): Promise<Blob | null>",
      "doc": "结束屏录:收尾成 Blob 并交给 onRecordingReady(未录制时直接返回 null)"
     },
     {
      "kind": "method",
      "name": "resetCamera",
      "signature": "resetCamera(): void",
      "doc": "复位相机:回到观察者视角、还原缩放,并把机位重置到飞机斜后上方"
     },
     {
      "kind": "method",
      "name": "frameMission",
      "signature": "frameMission(): boolean",
      "doc": "把观察者相机拉到\"一眼看全整条航线\"的位置(编辑航线前先框住航线)。"
     },
     {
      "kind": "getter",
      "name": "phase",
      "signature": "get phase(): FlightPhase",
      "doc": "当前飞行阶段(真值取 sim.phase):未上电 / 自检 / 待机 / 电机已启动 / 飞行中 / 返航 / 降落…"
     },
     {
      "kind": "getter",
      "name": "airborne",
      "signature": "get airborne(): boolean",
      "doc": "是否已离地(离地 5cm 以上且已上电)"
     },
     {
      "kind": "getter",
      "name": "flightMode",
      "signature": "get flightMode(): FlightMode",
      "doc": "当前飞行模式:Cine / Normal / Sport"
     },
     {
      "kind": "getter",
      "name": "altitude",
      "signature": "get altitude(): number",
      "doc": "当前高度(米,相对起飞点)"
     },
     {
      "kind": "getter",
      "name": "preflightChecks",
      "signature": "get preflightChecks(): ChecklistItem[]",
      "doc": "起飞前检查清单(含宿主注入的外部项);面板据此提示\"还差什么才能起飞\""
     },
     {
      "kind": "method",
      "name": "powerOn",
      "signature": "powerOn(): void",
      "doc": "上电:自检 → 预热 → 待机(仅未上电 / 已停桨时受理)"
     },
     {
      "kind": "method",
      "name": "takeOff",
      "signature": "takeOff(): boolean",
      "doc": "一键起飞:地面待机时自动启动电机,再爬升到 1.2 米;返回是否受理"
     },
     {
      "kind": "method",
      "name": "land",
      "signature": "land(): boolean",
      "doc": "自动降落(会先中止正在执行的航线);返回是否受理"
     },
     {
      "kind": "method",
      "name": "returnHome",
      "signature": "returnHome(reason?: string): boolean",
      "doc": "智能返航(需在空中,会先中止航线);返回是否受理"
     },
     {
      "kind": "method",
      "name": "setStick",
      "signature": "setStick(stick: Partial<StickState>): void",
      "doc": "写摇杆连续量(摇杆优先于键盘;松杆由飞控刹停悬停)"
     },
     {
      "kind": "method",
      "name": "resetStick",
      "signature": "resetStick(): void",
      "doc": "摇杆立刻回中(等同松开遥控器杆)"
     },
     {
      "kind": "method",
      "name": "setMoveDirection",
      "signature": "setMoveDirection(direction: DroneDirection | null): void",
      "doc": "键盘 / 方向键输入直接映射成摇杆行程(美国手 Mode 2)"
     },
     {
      "kind": "method",
      "name": "setVerticalDirection",
      "signature": "setVerticalDirection(direction: DroneVerticalDirection | null): void",
      "doc": "设垂直方向指令 -1(降)~0(保持)~1(升),面板/键盘写入"
     },
     {
      "kind": "method",
      "name": "setRotationDirection",
      "signature": "setRotationDirection(direction: DroneRotationDirection | null): void",
      "doc": "设偏航指令 -1(左转)~0~1(右转)"
     },
     {
      "kind": "method",
      "name": "setMode",
      "signature": "setMode(mode: FlightMode): void",
      "doc": "切飞行挡位:平稳 C / 普通 N / 运动 S"
     },
     {
      "kind": "method",
      "name": "setConfig",
      "signature": "setConfig(patch: Partial<SimConfig>): void",
      "doc": "改仿真配置(限速/风/电量阈值等,立即生效)"
     },
     {
      "kind": "method",
      "name": "setFaults",
      "signature": "setFaults(patch: Partial<FaultFlags>): void",
      "doc": "注入/清除故障标志(测失效保护用)"
     },
     {
      "kind": "method",
      "name": "setArmFoldTarget",
      "signature": "setArmFoldTarget(fold: number): void",
      "doc": "设机臂折叠目标 0(展开)~1(收纳),桨叶同步收拢"
     },
     {
      "kind": "getter",
      "name": "armFoldTargetValue",
      "signature": "get armFoldTargetValue(): number",
      "doc": "当前机臂折叠量 0~1(插值中的实时值)"
     },
     {
      "kind": "method",
      "name": "setArmsFolded",
      "signature": "setArmsFolded(folded: boolean): void",
      "doc": "展开 / 收拢机臂。"
     },
     {
      "kind": "getter",
      "name": "armsFolded",
      "signature": "get armsFolded(): boolean",
      "doc": "机臂当前是否处于\"已收拢\"的目标状态(展开 = false)"
     },
     {
      "kind": "getter",
      "name": "legsDeployed",
      "signature": "get legsDeployed(): boolean",
      "doc": "起落架腿当前是否放下(收起 = false)。 收放由飞行高度自动驱动(高于 LEG_RETRACT_ALTITUDE 收、低于放), 只有带 LEG_* 节点的机体(哈士奇)有腿,真机 GLB 恒为 true。"
     },
     {
      "kind": "method",
      "name": "setGimbalPitch",
      "signature": "setGimbalPitch(pitch: number): void",
      "doc": "设云台俯仰角(度,范围见 DRONE_SPEC)"
     },
     {
      "kind": "method",
      "name": "nudgeGimbal",
      "signature": "nudgeGimbal(deltaPitch: number, deltaYaw?: number): void",
      "doc": "云台增量微调(度;俯仰/偏航分别给)"
     },
     {
      "kind": "method",
      "name": "clearTrail",
      "signature": "clearTrail(): void",
      "doc": "清空飞行航迹"
     },
     {
      "kind": "method",
      "name": "startMission",
      "signature": "startMission(): boolean",
      "doc": "启动航线任务(地面时先自动起飞,到 1.2 米后自动接上航线)"
     },
     {
      "kind": "method",
      "name": "pauseMission",
      "signature": "pauseMission(reason?: string): boolean",
      "doc": "暂停执行中的航线(原地悬停,可再续飞)"
     },
     {
      "kind": "method",
      "name": "resumeMission",
      "signature": "resumeMission(): boolean",
      "doc": "续飞被暂停的航线"
     },
     {
      "kind": "method",
      "name": "stopMission",
      "signature": "stopMission(reason?: string): boolean",
      "doc": "中止航线并留在原地悬停"
     },
     {
      "kind": "method",
      "name": "setMission",
      "signature": "setMission(waypoints: Array<Partial<MissionWaypoint>>): boolean",
      "doc": "下发航点列表(执行中会被拒绝,与真机\"上传后不可改\"一致)"
     },
     {
      "kind": "method",
      "name": "setMissionConfig",
      "signature": "setMissionConfig(patch: Partial<MissionConfig>): void",
      "doc": "改航线参数(高度/速度/航向模式等,下一次起飞生效)"
     },
     {
      "kind": "method",
      "name": "resetMissionToDefault",
      "signature": "resetMissionToDefault(): void",
      "doc": "航线参数恢复默认"
     },
     {
      "kind": "method",
      "name": "getMissionSnapshot",
      "signature": "getMissionSnapshot(): MissionSnapshot",
      "doc": "取航线只读快照(航点/Home/进度)"
     },
     {
      "kind": "method",
      "name": "getMissionExport",
      "signature": "getMissionExport(): MissionExport",
      "doc": "把当前航线整理成可序列化的导出数据(只读,随时可调,执行中也行)。"
     },
     {
      "kind": "method",
      "name": "exportMission",
      "signature": "exportMission(format?: MissionExportFormat): string",
      "doc": "导出航线文本。`json` 是完整存档(含坐标约定、任务参数、概览统计,可再喂回 `setMission`), `csv` 只出航点表 —— 表头中文、CRLF 换行,Excel / WPS 双击即可打开。"
     },
     {
      "kind": "method",
      "name": "setMissionVisible",
      "signature": "setMissionVisible(visible: boolean): void",
      "doc": "航点标记 / 航线折线的总显隐(不影响任务执行)"
     },
     {
      "kind": "method",
      "name": "isMissionVisible",
      "signature": "isMissionVisible(): boolean",
      "doc": "航线是否可见"
     },
     {
      "kind": "method",
      "name": "setMissionWaypointsVisible",
      "signature": "setMissionWaypointsVisible(visible: boolean): void",
      "doc": "只开关航点标记"
     },
     {
      "kind": "method",
      "name": "isMissionWaypointsVisible",
      "signature": "isMissionWaypointsVisible(): boolean",
      "doc": "航线航点标记是否可见"
     },
     {
      "kind": "method",
      "name": "setMissionPathVisible",
      "signature": "setMissionPathVisible(visible: boolean): void",
      "doc": "只开关航线折线"
     },
     {
      "kind": "method",
      "name": "isMissionPathVisible",
      "signature": "isMissionPathVisible(): boolean",
      "doc": "航线路径线是否可见"
     },
     {
      "kind": "method",
      "name": "supportsGeoCoordinates",
      "signature": "supportsGeoCoordinates(): boolean",
      "doc": "three 后端是本地米坐标系,没有地理坐标;经纬度切换开关因此不显示"
     },
     {
      "kind": "method",
      "name": "getWaypointGeo",
      "signature": "getWaypointGeo(_index: number): { lon: number; lat: number; height: number; } | null",
      "doc": "three 后端无经纬高:返回 null(面板始终走 XYZ 显示)"
     },
     {
      "kind": "method",
      "name": "setWaypointGeo",
      "signature": "setWaypointGeo(_index: number, _geo: { lon: number; lat: number; height: number; }): boolean",
      "doc": "three 后端是本地米坐标系,无地理锚点,经纬度编辑不可用;接口占位返回 false"
     },
     {
      "kind": "method",
      "name": "setMissionEditEnabled",
      "signature": "setMissionEditEnabled(enabled: boolean): void",
      "doc": "开关「场景内编辑航点」"
     },
     {
      "kind": "method",
      "name": "isMissionEditEnabled",
      "signature": "isMissionEditEnabled(): boolean",
      "doc": "航线编辑模式是否开启"
     },
     {
      "kind": "method",
      "name": "setMissionSelected",
      "signature": "setMissionSelected(index: number): void",
      "doc": "场景编辑:选中某个航点(-1 取消选中)"
     },
     {
      "kind": "method",
      "name": "getMissionSelected",
      "signature": "getMissionSelected(): number",
      "doc": "当前选中的航点索引(无选中返回 null)"
     },
     {
      "kind": "method",
      "name": "getMissionEditState",
      "signature": "getMissionEditState(): MissionEditState",
      "doc": "场景编辑的实时状态(界面 100ms 轮询)"
     },
     {
      "kind": "method",
      "name": "updateMissionWaypoint",
      "signature": "updateMissionWaypoint(index: number, patch: Partial<MissionWaypoint>): MissionWaypoint | null",
      "doc": "原位更新一个航点(场景拖拽每帧调用):改内核 + 只挪这一根三维标记。"
     },
     {
      "kind": "method",
      "name": "deleteMissionWaypoint",
      "signature": "deleteMissionWaypoint(index: number): boolean",
      "doc": "场景编辑:按索引删除一个航点"
     },
     {
      "kind": "method",
      "name": "addMissionWaypointAtDrone",
      "signature": "addMissionWaypointAtDrone(): number",
      "doc": "场景编辑:以飞机当前位置新增一个航点(高度取飞机当前高度)"
     },
     {
      "kind": "method",
      "name": "getRigReport",
      "signature": "getRigReport(): RigPartReport[]",
      "doc": "取机体机械位姿报告(机臂折叠/桨叶角/云台角/起落架,调试用)"
     },
     {
      "kind": "method",
      "name": "getSnapshot",
      "signature": "getSnapshot(): DroneSnapshot",
      "doc": "取全量真值快照(位置/姿态/电池/云台/任务…,面板与 MCP 都用它)"
     },
     {
      "kind": "method",
      "name": "getLightsSnapshot",
      "signature": "getLightsSnapshot(): import(\"./drone-lights\").DroneLightsSnapshot | null",
      "doc": "取灯光真值快照(各灯模式/亮度/当前色)"
     },
     {
      "kind": "method",
      "name": "getTelemetry",
      "signature": "getTelemetry(): { speedMetersPerSecond: number; altitudeMeters: number; isFlying: boolean; }",
      "doc": "兼容旧接口:直接返回仿真遥测"
     },
     {
      "kind": "method",
      "name": "setStatusLightPattern",
      "signature": "setStatusLightPattern(key: StatusLightKey): void",
      "doc": "设状态灯灯语(覆盖默认模式,如 breathing / blink)"
     },
     {
      "kind": "method",
      "name": "clearStatusLightOverride",
      "signature": "clearStatusLightOverride(): void",
      "doc": "清除状态灯覆盖,回到按状态自动的灯语"
     },
     {
      "kind": "getter",
      "name": "statusLightOverride",
      "signature": "get statusLightOverride(): StatusLightKey | null",
      "doc": "当前状态灯覆盖(无覆盖返回 null)"
     },
     {
      "kind": "method",
      "name": "setBatteryLightMode",
      "signature": "setBatteryLightMode(mode: BatteryLightMode): void",
      "doc": "设电池灯模式(off / level / blink)"
     },
     {
      "kind": "method",
      "name": "setBatteryLightLevel",
      "signature": "setBatteryLightLevel(levelPercent: number): void",
      "doc": "设电池灯亮度 0~1"
     },
     {
      "kind": "method",
      "name": "setAuxLightMode",
      "signature": "setAuxLightMode(mode: AuxLightMode): void",
      "doc": "设补光灯模式(off / on / auto)"
     },
     {
      "kind": "method",
      "name": "destroy",
      "signature": "destroy(): void",
      "doc": "销毁飞行沙盒:停渲染循环、拆面板、释放场景与渲染器"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-cesium-rig",
  "file": "drone-cesium-rig",
  "title": "drone-cesium-rig · Cesium 机体表现",
  "group": "Cesium 后端",
  "doc": "",
  "items": [
   {
    "name": "CesiumDroneRig",
    "kind": "class",
    "signature": "declare class CesiumDroneRig { … }",
    "doc": "",
    "members": [
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(sim: DroneSim, cesium?: CesiumNS)",
      "doc": "Cesium 机体表现层:把 DroneSim 真值映射到 Model 关节(桨叶自转/起落架/灯光)"
     },
     {
      "kind": "method",
      "name": "attach",
      "signature": "attach(model: CesiumNS): void",
      "doc": "绑定新机体:重绑自转关节、挂灯珠发光 shader。旧机体的关节矩阵先复位。"
     },
     {
      "kind": "method",
      "name": "detach",
      "signature": "detach(): void",
      "doc": "拆卸:复位关节矩阵(含钟罩补偿)、摘掉发光 shader 与光晕集合"
     },
     {
      "kind": "method",
      "name": "dispose",
      "signature": "dispose(): void",
      "doc": "停止每帧同步并解除与 primitive 的绑定"
     },
     {
      "kind": "method",
      "name": "update",
      "signature": "update(deltaSeconds: number): void",
      "doc": "每帧驱动。调用时机:adapter 已推进 sim 并写完 model.modelMatrix —— 桨叶关节矩阵直接改模型内部节点,光晕位置复用同一份世界矩阵。"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-cesium",
  "file": "drone-cesium",
  "title": "CesiumDroneAdapter · Cesium 后端",
  "group": "Cesium 后端",
  "doc": "Cesium 版飞行适配器 —— 用 Cesium 自己的实体系统渲染机体,飞行逻辑仍走库里的 DroneSim。",
  "items": [
   {
    "name": "DroneModelSpec",
    "kind": "interface",
    "signature": "interface DroneModelSpec { … }",
    "doc": "可选机体规格。scale 把模型最大边归一到 2.4 m(与 three 版沙盒同尺寸),lift 让模型底面对齐放置点",
    "members": [
     {
      "kind": "property",
      "name": "key",
      "signature": "key: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "label",
      "signature": "label: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "url",
      "signature": "url: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "scale",
      "signature": "scale: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "yawOffsetDeg",
      "signature": "yawOffsetDeg: number",
      "doc": "模型自身前向与 ENU 北向的夹角修正(度),由实测定,见文件尾注释"
     },
     {
      "kind": "property",
      "name": "lift",
      "signature": "lift: number",
      "doc": "模型原点到底面的距离(米),用于让机腹贴地而不是原点贴地"
     },
     {
      "kind": "property",
      "name": "gimbalOffsetM",
      "signature": "gimbalOffsetM: number",
      "doc": "云台相机沿光轴前移的距离(米,自机体原点起算)。 离线按 GLB 顶点实测「光轴走廊内壳体(含云台壳)最前点 + 2cm 余量」得出: 相机必须探出壳体,否则 GLB 材质多为双面,在壳内会把机身内壁拍进画面。"
     },
     {
      "kind": "property",
      "name": "gimbalLiftM",
      "signature": "gimbalLiftM: number",
      "doc": "云台相机相对机体原点的高度(米):镜头玻璃的实测中线高度"
     }
    ]
   },
   {
    "name": "DRONE_MODELS",
    "kind": "const",
    "signature": "const DRONE_MODELS: DroneModelSpec[]",
    "doc": "机体目录。scale / lift / gimbal* 由 GLB 包围盒与顶点实测得出(见下方注释里的原始数据): - DJI Mini 4 Pro :31.758 × 9.959 × 25.236,min y = -5.034;云台镜头玻璃在机体系 z -0.590 m、y -0.03 m,壳体最前 -0.62 m - CesiumDrone    : 3.964 × 1.120 ×  4.668,min y = -0.171;镜头在 z +1.127 m、y +0.19 m",
    "members": []
   },
   {
    "name": "CesiumDroneOptions",
    "kind": "interface",
    "signature": "interface CesiumDroneOptions { … }",
    "doc": "",
    "members": [
     {
      "kind": "property",
      "name": "viewer",
      "signature": "viewer: CesiumNS",
      "doc": "Cesium.Viewer 实例"
     },
     {
      "kind": "property",
      "name": "cesium",
      "signature": "cesium?: CesiumNS",
      "doc": "Cesium 命名空间。缺省取 `window.Cesium`(配合 `loadCesiumScript()` 或页面里自引脚本); 传进来可让同一页面挂多个互不干扰的 Cesium 版本 / 便于测试注入。"
     },
     {
      "kind": "property",
      "name": "lon",
      "signature": "lon?: number",
      "doc": "沙盒原点经纬度(度);高度缺省时自动采样地形"
     },
     {
      "kind": "property",
      "name": "lat",
      "signature": "lat?: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "height",
      "signature": "height?: number",
      "doc": "锚点海拔(米);不传则用 sampleTerrainMostDetailed 采样"
     },
     {
      "kind": "property",
      "name": "modelIndex",
      "signature": "modelIndex?: number",
      "doc": "初始机体下标(见 DRONE_MODELS),默认 0"
     },
     {
      "kind": "property",
      "name": "groundClearance",
      "signature": "groundClearance?: number",
      "doc": "起降点离地额外抬升(米),避免机腹与地形 z-fighting,默认 0.05"
     },
     {
      "kind": "property",
      "name": "followRange",
      "signature": "followRange?: number",
      "doc": "视角跟随距离(米),follow 模式用(相机在无人机正后方),默认 7.5(与 three 版一致)"
     },
     {
      "kind": "property",
      "name": "stripRequiredExtensions",
      "signature": "stripRequiredExtensions?: readonly string[]",
      "doc": "加载期从 GLB 的 `extensionsRequired` 里摘掉的扩展清单 (见 DEFAULT_UNSUPPORTED_REQUIRED_EXTENSIONS,默认 ['KHR_lights_punctual']); 传 `[]` 关闭净化,直接按原 URL 加载。"
     }
    ]
   },
   {
    "name": "DEFAULT_UNSUPPORTED_REQUIRED_EXTENSIONS",
    "kind": "const",
    "signature": "const DEFAULT_UNSUPPORTED_REQUIRED_EXTENSIONS: string[]",
    "doc": "Cesium 不支持、但在真机 GLB 里被声明为 **required** 的 glTF 扩展。 出现在 extensionsRequired 里会被 `Model.fromGltfAsync` 直接拒载 (\"Unsupported glTF Extension: ...\"),需要加载期摘掉。",
    "members": []
   },
   {
    "name": "stripRequiredExtensions",
    "kind": "function",
    "signature": "function stripRequiredExtensions(buffer: ArrayBuffer, strip?: readonly string[]): ArrayBuffer | null",
    "doc": "在内存里摘掉 JSON chunk 中 `extensionsRequired` 里的指定扩展,返回新的 GLB ArrayBuffer。",
    "members": []
   },
   {
    "name": "loadCesiumScript",
    "kind": "function",
    "signature": "function loadCesiumScript(src?: string): Promise<void>",
    "doc": "按需注入 Cesium 全局脚本(默认 `/Cesium/Cesium.js`),幂等且并发安全。",
    "members": []
   },
   {
    "name": "CesiumDroneAdapter",
    "kind": "class",
    "signature": "declare class CesiumDroneAdapter implements DronePanelHost, MissionPanelHost, CesiumMissionHost { … }",
    "doc": "",
    "members": [
     {
      "kind": "property",
      "name": "sim",
      "signature": "readonly sim: DroneSim",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "engine",
      "signature": "readonly engine: \"cesium\"",
      "doc": "引擎判别字段:与 DroneFly 的 `engine = 'three'` 成对(见 drone-engine.ts)"
     },
     {
      "kind": "property",
      "name": "cameraMode",
      "signature": "cameraMode: CameraMode",
      "doc": "当前视角模式;orbit = 交给 Cesium 自由漫游,follow / fpv 由本适配器每帧驱动相机"
     },
     {
      "kind": "property",
      "name": "onRecordingReady",
      "signature": "onRecordingReady: ((blob: Blob, seconds: number) => void) | null",
      "doc": "录像收尾回调:UI 用它落盘(引擎不直接触发下载);与 three 版同名同参"
     },
     {
      "kind": "property",
      "name": "onModelChange",
      "signature": "onModelChange: ((spec: DroneModelSpec) => void) | null",
      "doc": "宿主回调:模型切换完成后通知 UI 刷新按钮文案"
     },
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(options: CesiumDroneOptions)",
      "doc": "Cesium 后端适配器:实现 DronePanelHost,面板/航线/鹰眼/键盘可直接用"
     },
     {
      "kind": "method",
      "name": "start",
      "signature": "start(): Promise<void>",
      "doc": "启动:采样锚点地形高度、加载机体、起循环。 地形采样失败不阻断(退回给定的 height);不挂地形(椭球)时采样高度恒为 0,同样无碍。"
     },
     {
      "kind": "method",
      "name": "destroy",
      "signature": "destroy(): void",
      "doc": "销毁 viewer 与适配器,停止每帧同步"
     },
     {
      "kind": "getter",
      "name": "modelSpec",
      "signature": "get modelSpec(): DroneModelSpec",
      "doc": "当前机体模型规格(名称/缩放/机头偏移等)"
     },
     {
      "kind": "getter",
      "name": "modelLoaded",
      "signature": "get modelLoaded(): boolean",
      "doc": "机体模型是否已挂载完成(加载是异步的,期间无人机不可见)"
     },
     {
      "kind": "method",
      "name": "setModel",
      "signature": "setModel(keyOrIndex: string | number): DroneModelSpec",
      "doc": "切换机体(按下标轮换或直接指定 key);返回切换后的规格"
     },
     {
      "kind": "method",
      "name": "cycleModel",
      "signature": "cycleModel(): DroneModelSpec",
      "doc": "在目录里轮换到下一个机体"
     },
     {
      "kind": "method",
      "name": "getGeo",
      "signature": "getGeo(): { lon: number; lat: number; height: number; }",
      "doc": "当前经纬高(渲染坐标系下的真实地理位置),供 HUD / 验证脚本读取"
     },
     {
      "kind": "method",
      "name": "setCameraMode",
      "signature": "setCameraMode(mode: CameraMode): void",
      "doc": "切相机模式:orbit 环绕 / follow 跟随 / fpv 机载"
     },
     {
      "kind": "method",
      "name": "getCaptureCamera",
      "signature": "getCaptureCamera(): CaptureCameraState | null",
      "doc": "取景相机位姿与内参快照 —— 虚拟影像采集用(见 drone-capture 的 `VirtualCaptureProvider`)。"
     },
     {
      "kind": "method",
      "name": "resetCamera",
      "signature": "resetCamera(): void",
      "doc": "视角复位:回到自由漫游,并把机位拉到无人机斜后上方"
     },
     {
      "kind": "getter",
      "name": "phase",
      "signature": "get phase(): import(\"./drone-sim\").FlightPhase",
      "doc": "当前飞行相位(与 three 后端同一枚举)"
     },
     {
      "kind": "getter",
      "name": "airborne",
      "signature": "get airborne(): boolean",
      "doc": "是否已离地"
     },
     {
      "kind": "getter",
      "name": "flightMode",
      "signature": "get flightMode(): FlightMode",
      "doc": "当前飞行挡位"
     },
     {
      "kind": "getter",
      "name": "altitude",
      "signature": "get altitude(): number",
      "doc": "相对起飞点高度(米)"
     },
     {
      "kind": "getter",
      "name": "preflightChecks",
      "signature": "get preflightChecks(): ChecklistItem[]",
      "doc": "起飞前检查项列表(供面板展示)"
     },
     {
      "kind": "getter",
      "name": "armsFolded",
      "signature": "get armsFolded(): boolean",
      "doc": "机臂是否处于收纳态"
     },
     {
      "kind": "getter",
      "name": "isRecording",
      "signature": "get isRecording(): boolean",
      "doc": "是否正在录像"
     },
     {
      "kind": "method",
      "name": "powerOn",
      "signature": "powerOn(): void",
      "doc": "上电自检(通过后才能起飞)"
     },
     {
      "kind": "method",
      "name": "takeOff",
      "signature": "takeOff(): boolean",
      "doc": "自动起飞到默认高度(地面待机相位才受理)"
     },
     {
      "kind": "method",
      "name": "land",
      "signature": "land(): boolean",
      "doc": "自动降落(中止进行中的航线)"
     },
     {
      "kind": "method",
      "name": "returnHome",
      "signature": "returnHome(reason?: string): boolean",
      "doc": "智能返航(需在空中;先中止航线)"
     },
     {
      "kind": "method",
      "name": "setStick",
      "signature": "setStick(stick: Partial<StickState>): void",
      "doc": "写摇杆连续量(与 three 后端同语义)"
     },
     {
      "kind": "method",
      "name": "setMode",
      "signature": "setMode(mode: FlightMode): void",
      "doc": "切飞行挡位"
     },
     {
      "kind": "method",
      "name": "setGimbalPitch",
      "signature": "setGimbalPitch(pitch: number): void",
      "doc": "设云台俯仰角(度)"
     },
     {
      "kind": "method",
      "name": "flyTo",
      "signature": "flyTo(target: { x?: number; y?: number; z?: number; heading?: number; pitch?: number; roll?: number; }): void",
      "doc": "直接把无人机移动到目标本地坐标位置,并保持离地高度不低于地形"
     },
     {
      "kind": "method",
      "name": "zoomTo",
      "signature": "zoomTo(zoom: number): void",
      "doc": "设定相机变焦倍数(1~4x),保持和 three 后端一致"
     },
     {
      "kind": "method",
      "name": "setCaptureView",
      "signature": "setCaptureView(override: CaptureViewOverride | null): void",
      "doc": "设置取景**俯仰**覆盖 —— 全景扫描(180° / 360°)按俯仰层逐张取景的入口;传 `null` 复位。 与 three 版 `DroneFly.setCaptureView` 同语义:俯仰替代云台俯仰;只影响取景相机 (`gimbalCameraView` 一处生效),拍照 / 录像 / 采集快照三条路径自动同源。"
     },
     {
      "kind": "method",
      "name": "spinBodyTo",
      "signature": "spinBodyTo(headingDeg: number | null): void",
      "doc": "让**机体原地自转**到绝对方位角 `headingDeg`(度,罗盘角);`null` 停止自转。 与 three 版同语义,同样交给飞控内核(`sim.spinTo`)—— 两个后端的自转行为因此完全一致。"
     },
     {
      "kind": "method",
      "name": "getBodyHeading",
      "signature": "getBodyHeading(): number",
      "doc": "机体当前方位角(度,罗盘角)—— 全景扫描用它判断\"转到位了没\""
     },
     {
      "kind": "method",
      "name": "setArmsFolded",
      "signature": "setArmsFolded(folded: boolean): void",
      "doc": "展开 / 收拢机臂。 Cesium 的 Model 没有 three 版的机械骨骼,这里只维护\"目标状态\"—— 它的唯一作用是驱动起飞前检查项,与真机\"不展臂不许起飞\"一致。"
     },
     {
      "kind": "getter",
      "name": "isOrbitView",
      "signature": "get isOrbitView(): boolean",
      "doc": "当前是否处于观察者(自由漫游)视角 —— 场景内编辑的前置条件"
     },
     {
      "kind": "method",
      "name": "startMission",
      "signature": "startMission(): boolean",
      "doc": "启动航线任务(地面时先自动起飞,到 1.2 米后自动接上航线)"
     },
     {
      "kind": "method",
      "name": "pauseMission",
      "signature": "pauseMission(reason?: string): boolean",
      "doc": "暂停执行中的航线(原地悬停,可再续飞)"
     },
     {
      "kind": "method",
      "name": "resumeMission",
      "signature": "resumeMission(): boolean",
      "doc": "续飞被暂停的航线"
     },
     {
      "kind": "method",
      "name": "stopMission",
      "signature": "stopMission(reason?: string): boolean",
      "doc": "中止航线并留在原地悬停"
     },
     {
      "kind": "method",
      "name": "setMission",
      "signature": "setMission(waypoints: Array<Partial<MissionWaypoint>>): boolean",
      "doc": "下发航点列表(执行中会被内核拒绝,与真机\"上传后不可改\"一致)"
     },
     {
      "kind": "method",
      "name": "setMissionConfig",
      "signature": "setMissionConfig(patch: Partial<MissionConfig>): void",
      "doc": "改航线参数(巡航速度/机头朝向/过点方式/完成后动作/循环)"
     },
     {
      "kind": "method",
      "name": "resetMissionToDefault",
      "signature": "resetMissionToDefault(): void",
      "doc": "航线参数与航点恢复出厂默认"
     },
     {
      "kind": "method",
      "name": "getMissionSnapshot",
      "signature": "getMissionSnapshot(): MissionSnapshot",
      "doc": "航线只读快照(航点/Home/进度)"
     },
     {
      "kind": "method",
      "name": "getSnapshot",
      "signature": "getSnapshot(): DroneSnapshot",
      "doc": "全量真值快照(面板据此渲染任务状态与阻塞原因)"
     },
     {
      "kind": "method",
      "name": "getMissionExport",
      "signature": "getMissionExport(): MissionExport",
      "doc": "把当前航线整理成可序列化的导出数据(实现下沉在 drone-sim,与 three 后端共用)"
     },
     {
      "kind": "method",
      "name": "exportMission",
      "signature": "exportMission(format?: MissionExportFormat): string",
      "doc": "导出航线文本(`json` 完整存档 / `csv` 纯航点表)"
     },
     {
      "kind": "method",
      "name": "getMissionEditState",
      "signature": "getMissionEditState(): MissionEditState",
      "doc": "场景内编辑状态(开关/是否激活/选中/悬停/拖拽中)"
     },
     {
      "kind": "method",
      "name": "setMissionEditEnabled",
      "signature": "setMissionEditEnabled(enabled: boolean): void",
      "doc": "场景内编辑开关(开启仍需\"当前确实可编辑\"才生效)"
     },
     {
      "kind": "method",
      "name": "isMissionEditEnabled",
      "signature": "isMissionEditEnabled(): boolean",
      "doc": "场景内编辑开关当前是否开着"
     },
     {
      "kind": "method",
      "name": "getMissionSelected",
      "signature": "getMissionSelected(): number",
      "doc": "当前选中的航点索引(无选中 -1)"
     },
     {
      "kind": "method",
      "name": "setMissionSelected",
      "signature": "setMissionSelected(index: number): void",
      "doc": "同步选中航点(列表点击与场景拾取双向联动)"
     },
     {
      "kind": "method",
      "name": "updateMissionWaypoint",
      "signature": "updateMissionWaypoint(index: number, patch: Partial<MissionWaypoint>): MissionWaypoint | null",
      "doc": "原位更新一个航点(场景拖拽每帧调用);内核会做限高 / 限距夹紧"
     },
     {
      "kind": "method",
      "name": "deleteMissionWaypoint",
      "signature": "deleteMissionWaypoint(index: number): boolean",
      "doc": "场景编辑:按索引删除一个航点"
     },
     {
      "kind": "method",
      "name": "addMissionWaypointAtDrone",
      "signature": "addMissionWaypointAtDrone(): number",
      "doc": "场景编辑:以飞机当前位置新增一个航点(高度取飞机当前高度)"
     },
     {
      "kind": "method",
      "name": "newWaypointTemplate",
      "signature": "newWaypointTemplate(index: number): Partial<MissionWaypoint>",
      "doc": "新航点的默认参数:高度与速度继承相邻航点,避免插出一个贴地点"
     },
     {
      "kind": "method",
      "name": "setMissionVisible",
      "signature": "setMissionVisible(visible: boolean): void",
      "doc": "航点标记 / 航线折线 / 返航点的总显隐(不影响任务执行)"
     },
     {
      "kind": "method",
      "name": "isMissionVisible",
      "signature": "isMissionVisible(): boolean",
      "doc": ""
     },
     {
      "kind": "method",
      "name": "setMissionWaypointsVisible",
      "signature": "setMissionWaypointsVisible(visible: boolean): void",
      "doc": "航点标记显隐"
     },
     {
      "kind": "method",
      "name": "isMissionWaypointsVisible",
      "signature": "isMissionWaypointsVisible(): boolean",
      "doc": ""
     },
     {
      "kind": "method",
      "name": "setMissionPathVisible",
      "signature": "setMissionPathVisible(visible: boolean): void",
      "doc": "航线折线显隐"
     },
     {
      "kind": "method",
      "name": "isMissionPathVisible",
      "signature": "isMissionPathVisible(): boolean",
      "doc": ""
     },
     {
      "kind": "method",
      "name": "supportsGeoCoordinates",
      "signature": "supportsGeoCoordinates(): boolean",
      "doc": "地理坐标(经纬高)在 Cesium 后端始终可用"
     },
     {
      "kind": "method",
      "name": "getWaypointGeo",
      "signature": "getWaypointGeo(index: number): { lon: number; lat: number; height: number; } | null",
      "doc": "取某航点的地理坐标(经纬高,WGS84)。"
     },
     {
      "kind": "method",
      "name": "setWaypointGeo",
      "signature": "setWaypointGeo(index: number, geo: { lon: number; lat: number; height: number; }): boolean",
      "doc": "用地理坐标原地改写一个航点:经纬高 → 本地米坐标的逆向换算。 `Cartesian3.fromDegrees` 投到 ECEF,再用 `worldToLocalXZ` 取回本地水平坐标(x 东 / z 南); 海拔绝对高程减去锚点海拔即 AGL,交给 `updateMissionWaypoint` 夹紧到合法范围。"
     },
     {
      "kind": "method",
      "name": "frameMission",
      "signature": "frameMission(): boolean",
      "doc": "把相机拉到\"一眼看全整条航线\"的位置(编辑航线前先框住航线)。"
     },
     {
      "kind": "method",
      "name": "canEdit",
      "signature": "canEdit(): boolean",
      "doc": ""
     },
     {
      "kind": "method",
      "name": "getWaypoints",
      "signature": "getWaypoints(): MissionWaypoint[]",
      "doc": ""
     },
     {
      "kind": "method",
      "name": "getSelected",
      "signature": "getSelected(): number",
      "doc": ""
     },
     {
      "kind": "method",
      "name": "setSelected",
      "signature": "setSelected(index: number): void",
      "doc": ""
     },
     {
      "kind": "method",
      "name": "commitWaypoints",
      "signature": "commitWaypoints(waypoints: Array<Partial<MissionWaypoint>>, selected: number): void",
      "doc": "整表提交(双击插入 / 删除):内核会逐点归一化并重建实体"
     },
     {
      "kind": "method",
      "name": "moveWaypoint",
      "signature": "moveWaypoint(index: number, patch: Partial<MissionWaypoint>): MissionWaypoint | null",
      "doc": ""
     },
     {
      "kind": "method",
      "name": "getLimits",
      "signature": "getLimits(): MissionEditLimits",
      "doc": ""
     },
     {
      "kind": "method",
      "name": "localToWorld",
      "signature": "localToWorld(x: number, y: number, z: number): CesiumNS",
      "doc": "sim 本地米坐标 → ECEF 世界坐标(航点实体定位用)。"
     },
     {
      "kind": "method",
      "name": "worldToLocalXZ",
      "signature": "worldToLocalXZ(world: CesiumNS): { x: number; z: number; } | null",
      "doc": "ECEF 世界坐标 → sim 本地水平坐标(双击插入航点用)"
     },
     {
      "kind": "method",
      "name": "setCameraInputEnabled",
      "signature": "setCameraInputEnabled(enabled: boolean): void",
      "doc": "拖拽期间收起 Cesium 的相机漫游输入,否则相机会跟着指针一起动"
     },
     {
      "kind": "method",
      "name": "log",
      "signature": "log(level: 'info' | 'warn', text: string): void",
      "doc": "编辑日志出口:接仿真内核的事件流(面板/控制台都看得到)"
     },
     {
      "kind": "method",
      "name": "requestPhoto",
      "signature": "requestPhoto(): Promise<PhotoShot | null>",
      "doc": "拍照:用云台相机取景拍一张 PNG(与用户当前视角无关,与 three 版同义)。"
     },
     {
      "kind": "method",
      "name": "startRecording",
      "signature": "startRecording(): boolean",
      "doc": "开始屏录(录云台取景,与用户当前视角无关)。返回 false = 当前环境不支持"
     },
     {
      "kind": "method",
      "name": "stopRecording",
      "signature": "stopRecording(): Promise<Blob | null>",
      "doc": "结束屏录:收尾成 Blob 并交给 onRecordingReady(未录制时直接返回 null)"
     },
     {
      "kind": "method",
      "name": "resetAll",
      "signature": "resetAll(): void",
      "doc": "回到\"上电前的干净状态\":停桨、归零位姿、复位飞控"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-cesium-mission",
  "file": "drone-cesium-mission",
  "title": "drone-cesium-mission · Cesium 航线编辑",
  "group": "Cesium 后端",
  "doc": "Cesium 由 /Cesium/Cesium.js 以全局脚本注入,这里只做一层薄封装取引用",
  "items": [
   {
    "name": "CesiumMissionHost",
    "kind": "interface",
    "signature": "interface CesiumMissionHost { … }",
    "doc": "编辑器依赖的宿主接口(由 CesiumDroneAdapter 实现): 航点数据以仿真内核为权威源,编辑器只通过它读写,不含任何渲染细节。",
    "members": [
     {
      "kind": "property",
      "name": "sim",
      "signature": "readonly sim: DroneSim",
      "doc": "飞行内核:读 missionIndex(执行目标)等真值"
     },
     {
      "kind": "method",
      "name": "canEdit",
      "signature": "canEdit(): boolean",
      "doc": "当前是否可编辑:观察者视角 + 航线未在执行"
     },
     {
      "kind": "method",
      "name": "getWaypoints",
      "signature": "getWaypoints(): MissionWaypoint[]",
      "doc": "航点列表(权威源 = 仿真内核)"
     },
     {
      "kind": "method",
      "name": "getSelected",
      "signature": "getSelected(): number",
      "doc": "宿主查询当前选中航点索引(无选中返回 -1)"
     },
     {
      "kind": "method",
      "name": "setSelected",
      "signature": "setSelected(index: number): void",
      "doc": "宿主同步选中航点(编辑器点击/面板列表双向联动)"
     },
     {
      "kind": "method",
      "name": "commitWaypoints",
      "signature": "commitWaypoints(waypoints: Array<Partial<MissionWaypoint>>, selected: number): void",
      "doc": "整表提交(新增 / 删除)"
     },
     {
      "kind": "method",
      "name": "moveWaypoint",
      "signature": "moveWaypoint(index: number, patch: Partial<MissionWaypoint>): MissionWaypoint | null",
      "doc": "拖动中的单点实时更新,返回夹紧后的航点(限高限距由宿主/内核生效)"
     },
     {
      "kind": "method",
      "name": "newWaypointTemplate",
      "signature": "newWaypointTemplate(index: number): Partial<MissionWaypoint>",
      "doc": "新航点的默认参数(高度与速度继承相邻航点)"
     },
     {
      "kind": "method",
      "name": "getLimits",
      "signature": "getLimits(): MissionEditLimits",
      "doc": "取编辑限制(限高/限距/返航点,供夹紧与插入位计算)"
     },
     {
      "kind": "method",
      "name": "localToWorld",
      "signature": "localToWorld(x: number, y: number, z: number): CesiumNS",
      "doc": "sim 本地米坐标(x 东 / z 南 / y 为 AGL)→ ECEF 世界坐标"
     },
     {
      "kind": "method",
      "name": "worldToLocalXZ",
      "signature": "worldToLocalXZ(world: CesiumNS): { x: number; z: number; } | null",
      "doc": "ECEF 世界坐标 → sim 本地水平坐标(双击拾取用);打不中返回 null"
     },
     {
      "kind": "method",
      "name": "setCameraInputEnabled",
      "signature": "setCameraInputEnabled(enabled: boolean): void",
      "doc": "拖拽期间收起 / 恢复 Cesium 相机漫游输入"
     },
     {
      "kind": "method",
      "name": "log",
      "signature": "log(level: 'info' | 'warn', text: string): void",
      "doc": "编辑日志出口(宿主接到 sim.pushEvent)"
     }
    ]
   },
   {
    "name": "CesiumMissionEditor",
    "kind": "class",
    "signature": "declare class CesiumMissionEditor { … }",
    "doc": "Cesium 航线编辑器:航点/航线实体渲染 + 场景内拖拽编辑。",
    "members": [
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(host: CesiumMissionHost, C: CesiumNS, viewer: CesiumNS)",
      "doc": ""
     },
     {
      "kind": "getter",
      "name": "isEnabled",
      "signature": "get isEnabled(): boolean",
      "doc": "编辑模式是否开启(开启时点场景可加/拖航点)"
     },
     {
      "kind": "method",
      "name": "setEnabled",
      "signature": "setEnabled(enabled: boolean): void",
      "doc": "开关编辑模式;关闭时取消拖动、归还相机输入、清悬停"
     },
     {
      "kind": "method",
      "name": "getEditState",
      "signature": "getEditState(): MissionEditState",
      "doc": "编辑器对外状态快照(面板\"场景内编辑\"区块据此渲染)"
     },
     {
      "kind": "method",
      "name": "update",
      "signature": "update(): void",
      "doc": "每帧调用:签名变了才重建实体位置,选中/执行目标变化才改配色"
     },
     {
      "kind": "method",
      "name": "setVisible",
      "signature": "setVisible(visible: boolean): void",
      "doc": "航点标记 + 航线折线总显隐(由宿主的 setMissionVisible 转发)"
     },
     {
      "kind": "method",
      "name": "setWaypointsVisible",
      "signature": "setWaypointsVisible(visible: boolean): void",
      "doc": "航点标记显隐(不影响任务执行)"
     },
     {
      "kind": "method",
      "name": "setPathVisible",
      "signature": "setPathVisible(visible: boolean): void",
      "doc": "航线折线显隐"
     },
     {
      "kind": "method",
      "name": "deleteWaypoint",
      "signature": "deleteWaypoint(index: number): boolean",
      "doc": "删除一个航点(面板按钮与 Delete 键共用)"
     },
     {
      "kind": "method",
      "name": "destroy",
      "signature": "destroy(): void",
      "doc": ""
     }
    ]
   }
  ]
 },
 {
  "id": "drone-engine",
  "file": "drone-engine",
  "title": "createDroneControl · 引擎装配",
  "group": "引擎装配",
  "doc": "引擎装配层 —— 用 `engine` 字段选择渲染后端,一处配置换整套渲染实现。",
  "items": [
   {
    "name": "DroneEngine",
    "kind": "type",
    "signature": "type DroneEngine = 'three' | 'cesium'",
    "doc": "渲染后端标识",
    "members": []
   },
   {
    "name": "ThreeDroneEngineOptions",
    "kind": "interface",
    "signature": "interface ThreeDroneEngineOptions extends DroneFlyInitializeOptions { … }",
    "doc": "three 后端参数:场景四件套 + `DroneFly.initialize()` 的全部选项 (modelUrl / obstacles)。",
    "members": [
     {
      "kind": "property",
      "name": "engine",
      "signature": "engine?: 'three'",
      "doc": "后端标识;缺省 'three'"
     },
     {
      "kind": "property",
      "name": "scene",
      "signature": "scene: THREE.Scene<THREE.Object3DEventMap>",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "camera",
      "signature": "camera: THREE.PerspectiveCamera",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "renderer",
      "signature": "renderer: WebGPURenderer",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "controls",
      "signature": "controls?: OrbitControls<THREE.Camera> | null",
      "doc": ""
     }
    ]
   },
   {
    "name": "CesiumDroneEngineOptions",
    "kind": "interface",
    "signature": "interface CesiumDroneEngineOptions extends CesiumDroneOptions { … }",
    "doc": "Cesium 后端参数:本质就是 CesiumDroneOptions,只多一个必需的 engine 判别字段",
    "members": [
     {
      "kind": "property",
      "name": "engine",
      "signature": "engine: 'cesium'",
      "doc": ""
     }
    ]
   },
   {
    "name": "DroneControlOptions",
    "kind": "type",
    "signature": "type DroneControlOptions = ThreeDroneEngineOptions | CesiumDroneEngineOptions",
    "doc": "`createDroneControl()` 的参数(判别联合)",
    "members": []
   },
   {
    "name": "DroneEngineHost",
    "kind": "interface",
    "signature": "interface DroneEngineHost extends DronePanelHost { … }",
    "doc": "引擎无关的控制器句柄 —— 两套实现都满足。",
    "members": [
     {
      "kind": "property",
      "name": "engine",
      "signature": "readonly engine: DroneEngine",
      "doc": ""
     }
    ]
   },
   {
    "name": "createDroneControl",
    "kind": "function",
    "signature": "function createDroneControl(options: ThreeDroneEngineOptions): Promise<DroneFly>\nfunction createDroneControl(options: CesiumDroneEngineOptions): Promise<CesiumDroneAdapter>\nfunction createDroneControl(options: DroneControlOptions): Promise<DroneEngineHost>",
    "doc": "按 `engine` 装配并初始化:three 走 DroneFly.initialize,Cesium 走 CesiumDroneAdapter.start",
    "members": []
   }
  ]
 },
 {
  "id": "drone-panel",
  "file": "drone-panel",
  "title": "DroneControlPanel · 控制面板",
  "group": "交互层",
  "doc": "无人机控制面板(原生 DOM 实现):王者荣耀式 HUD —— 双虚拟摇杆 + 技能按钮 + 飞行控制面板。",
  "items": [
   {
    "name": "DronePanelPosition",
    "kind": "type",
    "signature": "type DronePanelPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'",
    "doc": "面板停靠位置(相对挂载容器)",
    "members": []
   },
   {
    "name": "DroneControlPanelOptions",
    "kind": "interface",
    "signature": "interface DroneControlPanelOptions { … }",
    "doc": "DroneControlPanel 构造选项",
    "members": [
     {
      "kind": "property",
      "name": "container",
      "signature": "container?: HTMLElement | null",
      "doc": "挂载容器;缺省挂到 document.body(此时面板与悬浮层改用 fixed 定位)"
     },
     {
      "kind": "property",
      "name": "position",
      "signature": "position?: DronePanelPosition",
      "doc": "面板停靠位置,默认 'top-right';左右轮盘固定悬浮在画面两下角,不受此项影响"
     },
     {
      "kind": "property",
      "name": "title",
      "signature": "title?: string",
      "doc": "面板标题,默认「无人机」"
     },
     {
      "kind": "property",
      "name": "injectStyles",
      "signature": "injectStyles?: boolean",
      "doc": "是否注入自带样式,默认 true;关闭后仅保留 `dcp-*` 类名,由宿主自行配色"
     },
     {
      "kind": "property",
      "name": "pitchPresets",
      "signature": "pitchPresets?: number[]",
      "doc": "云台俯仰快捷档位(度),默认 [-90, -30, -10, 0]"
     },
     {
      "kind": "property",
      "name": "visible",
      "signature": "visible?: boolean",
      "doc": "初始是否可见,默认 true"
     },
     {
      "kind": "property",
      "name": "onPhoto",
      "signature": "onPhoto?: (shot: PhotoShot) => void",
      "doc": "拍照完成回调;未提供且 autoDownload 为 true 时自动下载 PNG"
     },
     {
      "kind": "property",
      "name": "captureService",
      "signature": "captureService?: CaptureService",
      "doc": "采集服务(可选)。提供后面板出现「拍摄模式」区,可切换广角 / 180° / 360°: 全景按预设网格逐张取景拍摄,每张都带全景分组信息登记进这个服务的当前会话。"
     },
     {
      "kind": "property",
      "name": "panorama",
      "signature": "panorama?: boolean",
      "doc": "是否启用全景拍摄(默认 true);没有 `captureService` 时不显示该区"
     },
     {
      "kind": "property",
      "name": "panoramaShotIntervalMs",
      "signature": "panoramaShotIntervalMs?: number",
      "doc": "全景每张之间的间隔(毫秒),默认 120"
     },
     {
      "kind": "property",
      "name": "onRecording",
      "signature": "onRecording?: (blob: Blob, seconds: number) => void",
      "doc": "录像完成回调;未提供且 autoDownload 为 true 时自动下载 webm"
     },
     {
      "kind": "property",
      "name": "autoDownload",
      "signature": "autoDownload?: boolean",
      "doc": "无自定义回调时是否自动下载产物,默认 true"
     },
     {
      "kind": "property",
      "name": "syncIntervalMs",
      "signature": "syncIntervalMs?: number",
      "doc": "状态轮询间隔(毫秒),默认 200;传 0 关闭自动同步、完全由宿主调 sync()"
     },
     {
      "kind": "property",
      "name": "stickDeadzone",
      "signature": "stickDeadzone?: number",
      "doc": "摇杆死区(0~1),默认 0.06;小于该幅值视为 0,抵住手指轻微抖动。作用于垂直通道(升降 / 前后)"
     },
     {
      "kind": "property",
      "name": "stickLateralDeadzone",
      "signature": "stickLateralDeadzone?: number",
      "doc": "横滚 / 偏航死区(0~1),默认 0.14。比垂直通道大一档 —— 触屏推杆时手指很难保证绝对竖直, 轻微的侧向分量会被放大成持续横移和机头偏转,几分钟就飞出弧线。加大这一路死区等于给 直线飞行留出一条\"安全走廊\",垂直通道不受影响、起手依然跟手。"
     },
     {
      "kind": "property",
      "name": "stickExpo",
      "signature": "stickExpo?: number",
      "doc": "摇杆指数曲线 expo(0~1),默认 0.55,真机遥控器的 expo 手感: 输出 = expo·v³ + (1-expo)·v —— 中位附近行程放慢(便于精确微调), 末端仍能打满舵量(1 处恒等于 1),推到底的极速与转向权限不受影响。"
     },
     {
      "kind": "property",
      "name": "yawRateScale",
      "signature": "yawRateScale?: number",
      "doc": "偏航角速度缩放(0~1],默认 0.6。左杆左右 / ←→ 键的转向输出乘这个系数 —— 飞控的挡位角速度是照真机标的(普通挡 100°/s,满杆 3.6 秒转一圈), 在屏幕遥控器上偏快;这里只压遥控器侧的输出,飞控与挡位表不动。"
     },
     {
      "kind": "property",
      "name": "keyboard",
      "signature": "keyboard?: boolean",
      "doc": "是否启用键盘控制,默认 true。键位(与屏上双摇杆等效,左手 WASD 对左杆、右手方向键对右杆): `W/S` 升降 · `A/D` 转向(左杆) · `↑/↓` 前后 · `←/→` 横滚(右杆);`Q/E` 是转向的备用键。 另外两组技能快捷键:`Ctrl`(macOS 上 `Cmd`)+ `K` 拍照、`Ctrl` + `L` 录像(开关,再按一次停止),"
     },
     {
      "kind": "property",
      "name": "keyboardRiseSeconds",
      "signature": "keyboardRiseSeconds?: number",
      "doc": "键盘推杆渐推时间(秒),默认 0.45;越大越柔和"
     },
     {
      "kind": "property",
      "name": "keyboardFallSeconds",
      "signature": "keyboardFallSeconds?: number",
      "doc": "键盘松手渐回时间(秒),默认 0.18"
     },
     {
      "kind": "property",
      "name": "adaptive",
      "signature": "adaptive?: boolean",
      "doc": "是否启用移动端自适应(横屏紧凑布局 / 触控尺寸),默认 true"
     }
    ]
   },
   {
    "name": "DroneControlPanel",
    "kind": "class",
    "signature": "declare class DroneControlPanel { … }",
    "doc": "无人机控制面板:王者荣耀式 HUD(左右悬浮轮盘 + 右轮盘技能) + 飞行控制面板。",
    "members": [
     {
      "kind": "property",
      "name": "root",
      "signature": "readonly root: HTMLDivElement",
      "doc": "面板根元素(宿主可追加类名做二次定制)"
     },
     {
      "kind": "property",
      "name": "hudLayer",
      "signature": "readonly hudLayer: HTMLDivElement",
      "doc": "悬浮摇杆/技能层(面板的兄弟节点,铺满容器;宿主可追加类名做二次定制)"
     },
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(fly: DronePanelHost, options?: DroneControlPanelOptions)",
      "doc": "构造控制面板并插入容器(可传 options 停靠位置/手感/键盘开关)"
     },
     {
      "kind": "method",
      "name": "mount",
      "signature": "mount(): this",
      "doc": "插入容器(构造时已自动调用一次;面板与悬浮层一起挂)"
     },
     {
      "kind": "method",
      "name": "unmount",
      "signature": "unmount(): this",
      "doc": "从容器移除但保留实例,可再次 mount"
     },
     {
      "kind": "method",
      "name": "setVisible",
      "signature": "setVisible(visible: boolean): this",
      "doc": "显示 / 隐藏(面板与悬浮轮盘一起切换)"
     },
     {
      "kind": "method",
      "name": "isVisible",
      "signature": "isVisible(): boolean",
      "doc": "当前是否可见"
     },
     {
      "kind": "method",
      "name": "setCollapsed",
      "signature": "setCollapsed(collapsed: boolean): this",
      "doc": "折叠 / 展开(只收面板,左右轮盘与技能保持可用 —— 游戏里也不收操作区)"
     },
     {
      "kind": "method",
      "name": "destroy",
      "signature": "destroy(): void",
      "doc": "彻底销毁:解绑事件、停轮询、移除 DOM"
     },
     {
      "kind": "method",
      "name": "removeInjectedStyles",
      "signature": "static removeInjectedStyles(): void",
      "doc": "移除已注入的共享样式。 多个面板共存时请等最后一个销毁后再调用,否则其余面板会掉样式。"
     },
     {
      "kind": "method",
      "name": "sync",
      "signature": "sync(): void",
      "doc": "把引擎当前状态刷到 HUD 上(飞行阶段/按钮可用性 / 视角高亮 / 云台角度 / 技能角标 / 摇杆读数)"
     }
    ]
   }
  ]
 },
 {
  "id": "mission-panel",
  "file": "mission-panel",
  "title": "MissionPanel · 航线面板",
  "group": "航线层",
  "doc": "面板停靠位置(相对挂载容器)",
  "items": [
   {
    "name": "MissionPanelPosition",
    "kind": "type",
    "signature": "type MissionPanelPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'",
    "doc": "面板停靠位置(相对挂载容器)",
    "members": []
   },
   {
    "name": "MissionExportPayload",
    "kind": "interface",
    "signature": "interface MissionExportPayload { … }",
    "doc": "「导出航线」产出的载荷:宿主传了 `onExport` 就由宿主决定怎么保存(上传 / 入库 / 换文件名)",
    "members": [
     {
      "kind": "property",
      "name": "format",
      "signature": "format: MissionExportFormat",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "text",
      "signature": "text: string",
      "doc": "序列化好的完整文本(JSON 已带缩进,CSV 为中文表头 + CRLF)"
     },
     {
      "kind": "property",
      "name": "filename",
      "signature": "filename: string",
      "doc": "建议文件名(含扩展名)"
     },
     {
      "kind": "property",
      "name": "mime",
      "signature": "mime: string",
      "doc": "MIME 类型"
     }
    ]
   },
   {
    "name": "MissionPanelOptions",
    "kind": "interface",
    "signature": "interface MissionPanelOptions { … }",
    "doc": "MissionPanel 构造选项",
    "members": [
     {
      "kind": "property",
      "name": "container",
      "signature": "container?: HTMLElement | null",
      "doc": "挂载容器;缺省挂到 document.body(此时面板改用 fixed 定位)"
     },
     {
      "kind": "property",
      "name": "position",
      "signature": "position?: MissionPanelPosition",
      "doc": "面板停靠位置,默认 'top-left'(通常与右上角的飞行控制面板对开)"
     },
     {
      "kind": "property",
      "name": "title",
      "signature": "title?: string",
      "doc": "面板标题,默认「航线规划」"
     },
     {
      "kind": "property",
      "name": "injectStyles",
      "signature": "injectStyles?: boolean",
      "doc": "是否注入自带样式,默认 true;关闭后仅保留 `dmp-*` 类名,由宿主自行配色"
     },
     {
      "kind": "property",
      "name": "visible",
      "signature": "visible?: boolean",
      "doc": "初始是否可见,默认 true"
     },
     {
      "kind": "property",
      "name": "syncIntervalMs",
      "signature": "syncIntervalMs?: number",
      "doc": "状态轮询间隔(毫秒),默认 100;传 0 关闭自动同步、完全由宿主调 sync()"
     },
     {
      "kind": "property",
      "name": "sceneEdit",
      "signature": "sceneEdit?: boolean",
      "doc": "是否渲染「场景内编辑」区块(需要画布与观察者视角),默认 true;传 false 退化成三块纯列表编辑"
     },
     {
      "kind": "property",
      "name": "adaptive",
      "signature": "adaptive?: boolean",
      "doc": "是否启用移动端自适应(窄屏紧凑布局),默认 true"
     },
     {
      "kind": "property",
      "name": "offset",
      "signature": "offset?: { x?: number; y?: number; }",
      "doc": "停靠微调(像素),与 DroneCapturePanel 同语义:y 对 top 方位= marginTop(下移)、 对 bottom 方位= marginBottom(上移);x 对 right 方位= marginRight(左移)、其余= marginLeft。 用来避开宿主自己的边角 UI(如 Cesium 的工具条 / 其他面板)。"
     },
     {
      "kind": "property",
      "name": "onExport",
      "signature": "onExport?: (payload: MissionExportPayload) => void",
      "doc": "「导出航线」的回调。**给了就由宿主接管保存**(上传服务器 / 写数据库 / 自定义文件名), 面板不再触发浏览器下载;不给则默认下载到本地(JSON / CSV,文件名带时间戳)。"
     }
    ]
   },
   {
    "name": "MissionPanel",
    "kind": "class",
    "signature": "declare class MissionPanel { … }",
    "doc": "航线规划面板:航点任务的规划 / 执行 / 场景内编辑。",
    "members": [
     {
      "kind": "property",
      "name": "root",
      "signature": "readonly root: HTMLDivElement",
      "doc": "面板根元素(宿主可追加类名做二次定制)"
     },
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(fly: MissionPanelHost, options?: MissionPanelOptions)",
      "doc": "构造航线编辑面板(航点列表/参数/执行控制,200ms 同步真值)"
     },
     {
      "kind": "method",
      "name": "mount",
      "signature": "mount(): this",
      "doc": "插入容器(构造时已自动调用一次)"
     },
     {
      "kind": "method",
      "name": "unmount",
      "signature": "unmount(): this",
      "doc": "从容器移除但保留实例,可再次 mount"
     },
     {
      "kind": "method",
      "name": "setVisible",
      "signature": "setVisible(visible: boolean): this",
      "doc": "显示 / 隐藏"
     },
     {
      "kind": "method",
      "name": "isVisible",
      "signature": "isVisible(): boolean",
      "doc": "当前是否可见"
     },
     {
      "kind": "method",
      "name": "destroy",
      "signature": "destroy(): void",
      "doc": "彻底销毁:解绑事件、停轮询、移除 DOM"
     },
     {
      "kind": "method",
      "name": "removeInjectedStyles",
      "signature": "static removeInjectedStyles(): void",
      "doc": "移除已注入的共享样式。 多个面板共存时请等最后一个销毁后再调用,否则其余面板会掉样式。"
     },
     {
      "kind": "method",
      "name": "sync",
      "signature": "sync(): void",
      "doc": "把引擎当前状态刷到面板上(任务状态/按钮可用性/参数回显/航点列表/场景编辑)"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-minimap",
  "file": "drone-minimap",
  "title": "DroneMiniMap · 鹰眼图",
  "group": "态势层",
  "doc": "鹰眼图(俯视小地图)—— 原生 DOM + Canvas 2D,与 drone-panel / mission-panel 同一套范式: 框架无关、`dcm-*` 类名、配色走 CSS 变量、构造即可挂载、destroy 彻底回收。",
  "items": [
   {
    "name": "MiniMapPosition",
    "kind": "type",
    "signature": "type MiniMapPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'bottom-center'",
    "doc": "小地图吸附的容器角;bottom-center = 底边水平居中(两侧摇杆之间的空档)",
    "members": []
   },
   {
    "name": "MiniMapOptions",
    "kind": "interface",
    "signature": "interface MiniMapOptions { … }",
    "doc": "",
    "members": [
     {
      "kind": "property",
      "name": "container",
      "signature": "container?: HTMLElement",
      "doc": "挂载容器;缺省挂到 document.body(贴视口),给了容器就贴容器(必要时自动补 relative)"
     },
     {
      "kind": "property",
      "name": "position",
      "signature": "position?: MiniMapPosition",
      "doc": "吸附角,默认右下角(与控制面板右上、航线面板左上错开)"
     },
     {
      "kind": "property",
      "name": "offset",
      "signature": "offset?: { x?: number; y?: number; }",
      "doc": "角内偏移(像素):在默认 14px 边距之上再让出的距离。 右下角常被 HUD 摇杆 + 技能钮占着,demo 里就是用它把小地图抬到轮盘上方。"
     },
     {
      "kind": "property",
      "name": "size",
      "signature": "size?: number",
      "doc": "画布边长(CSS 像素),默认 186"
     },
     {
      "kind": "property",
      "name": "range",
      "signature": "range?: number | null",
      "doc": "固定半量程(米);传了就关闭自动量程。缺省 null = 自动跟随"
     },
     {
      "kind": "property",
      "name": "minRange",
      "signature": "minRange?: number",
      "doc": "自动量程下限(米),默认 40"
     },
     {
      "kind": "property",
      "name": "maxRange",
      "signature": "maxRange?: number",
      "doc": "自动量程上限(米),默认 300"
     },
     {
      "kind": "property",
      "name": "visible",
      "signature": "visible?: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "injectStyles",
      "signature": "injectStyles?: boolean",
      "doc": "注入内置样式,默认 true;宿主自备样式可关掉"
     },
     {
      "kind": "property",
      "name": "className",
      "signature": "className?: string",
      "doc": "额外类名,追加在 `dcm` 之后"
     },
     {
      "kind": "property",
      "name": "showObstacles",
      "signature": "showObstacles?: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "showMission",
      "signature": "showMission?: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "showTrail",
      "signature": "showTrail?: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "showFov",
      "signature": "showFov?: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "showGrid",
      "signature": "showGrid?: boolean",
      "doc": ""
     }
    ]
   },
   {
    "name": "MiniMapStats",
    "kind": "interface",
    "signature": "interface MiniMapStats { … }",
    "doc": "探针/调试读数",
    "members": [
     {
      "kind": "property",
      "name": "range",
      "signature": "range: number",
      "doc": "当前实际半量程(米)"
     },
     {
      "kind": "property",
      "name": "scale",
      "signature": "scale: number",
      "doc": "当前比例尺(像素 / 米)"
     },
     {
      "kind": "property",
      "name": "obstacleCount",
      "signature": "obstacleCount: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "waypointCount",
      "signature": "waypointCount: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "trailPoints",
      "signature": "trailPoints: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "fovDeg",
      "signature": "fovDeg: number | null",
      "doc": "机载水平视场角(度);非机载视角返回 null"
     },
     {
      "kind": "property",
      "name": "centerX",
      "signature": "centerX: number",
      "doc": "地图中心的世界坐标(= 机体位置)"
     },
     {
      "kind": "property",
      "name": "centerZ",
      "signature": "centerZ: number",
      "doc": ""
     }
    ]
   },
   {
    "name": "DroneMiniMap",
    "kind": "class",
    "signature": "declare class DroneMiniMap { … }",
    "doc": "",
    "members": [
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(fly: DroneFly, options?: MiniMapOptions)",
      "doc": "构造鹰眼图:Canvas 2D 俯视 HUD,只读 sim 真值,不碰三维渲染"
     },
     {
      "kind": "method",
      "name": "render",
      "signature": "render(): void",
      "doc": "立即重绘一帧(宿主想自控节拍时可关掉内置 rAF —— 见 stop())"
     },
     {
      "kind": "method",
      "name": "setVisible",
      "signature": "setVisible(visible: boolean): void",
      "doc": "显示/隐藏鹰眼图"
     },
     {
      "kind": "method",
      "name": "isVisible",
      "signature": "isVisible(): boolean",
      "doc": "鹰眼图当前是否可见"
     },
     {
      "kind": "method",
      "name": "setRange",
      "signature": "setRange(range: number | null): void",
      "doc": "量程:传数字 = 固定该半量程(米);传 null = 回到自动跟随"
     },
     {
      "kind": "method",
      "name": "getRange",
      "signature": "getRange(): number",
      "doc": "当前实际半量程(米)"
     },
     {
      "kind": "method",
      "name": "refreshTheme",
      "signature": "refreshTheme(): void",
      "doc": "切主题(读一遍 CSS 变量)后调用;平时不必每帧读"
     },
     {
      "kind": "method",
      "name": "getStats",
      "signature": "getStats(): MiniMapStats",
      "doc": "探针读数"
     },
     {
      "kind": "method",
      "name": "hasDrawn",
      "signature": "hasDrawn(): boolean",
      "doc": "本帧是否已绘制过(探针用:确认 rAF 真的在跑)"
     },
     {
      "kind": "method",
      "name": "stop",
      "signature": "stop(): void",
      "doc": "停止内置刷新(之后需自行调用 render())"
     },
     {
      "kind": "method",
      "name": "destroy",
      "signature": "destroy(): void",
      "doc": "停止重绘循环并移除画布"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-exif",
  "file": "drone-exif",
  "title": "drone-exif · EXIF 解析",
  "group": "影像采集层",
  "doc": "零依赖 JPEG EXIF / GPS 解析器。",
  "items": [
   {
    "name": "ExifGps",
    "kind": "interface",
    "signature": "interface ExifGps { … }",
    "doc": "EXIF GPS 信息(已转成十进制度)",
    "members": [
     {
      "kind": "property",
      "name": "latitude",
      "signature": "latitude?: number",
      "doc": "十进制度,北纬为正"
     },
     {
      "kind": "property",
      "name": "longitude",
      "signature": "longitude?: number",
      "doc": "十进制度,东经为正"
     },
     {
      "kind": "property",
      "name": "altitude",
      "signature": "altitude?: number",
      "doc": "海拔(米);altitudeRef = 1 表示海平面以下,此处已取负"
     },
     {
      "kind": "property",
      "name": "altitudeRef",
      "signature": "altitudeRef?: number",
      "doc": "原始海拔标志:0 = 海平面以上,1 = 海平面以下"
     }
    ]
   },
   {
    "name": "ExifData",
    "kind": "interface",
    "signature": "interface ExifData { … }",
    "doc": "EXIF 解析结果(字段全部可选 —— 缺失就是缺失,不填默认值)",
    "members": [
     {
      "kind": "property",
      "name": "make",
      "signature": "make?: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "model",
      "signature": "model?: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "lensModel",
      "signature": "lensModel?: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "dateTimeOriginal",
      "signature": "dateTimeOriginal?: string",
      "doc": "原始拍摄时间(相机本地时间,无时区),格式 `YYYY-MM-DDTHH:MM:SS`"
     },
     {
      "kind": "property",
      "name": "dateTime",
      "signature": "dateTime?: string",
      "doc": "文件修改时间(EXIF DateTime)"
     },
     {
      "kind": "property",
      "name": "orientation",
      "signature": "orientation?: number",
      "doc": "拍照方向(1~8,见 EXIF 规范;1 = 正常)"
     },
     {
      "kind": "property",
      "name": "focalLengthMm",
      "signature": "focalLengthMm?: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "focalLength35mm",
      "signature": "focalLength35mm?: number",
      "doc": "35mm 等效焦距 —— 换算内参的关键字段"
     },
     {
      "kind": "property",
      "name": "exposureTimeSeconds",
      "signature": "exposureTimeSeconds?: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "fNumber",
      "signature": "fNumber?: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "isoSpeed",
      "signature": "isoSpeed?: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "pixelXDimension",
      "signature": "pixelXDimension?: number",
      "doc": "图像宽高(EXIF 里记录的原始像素尺寸)"
     },
     {
      "kind": "property",
      "name": "pixelYDimension",
      "signature": "pixelYDimension?: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "gps",
      "signature": "gps?: ExifGps",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "warnings",
      "signature": "warnings: string[]",
      "doc": "解析过程中的异常/缺失说明(诊断用)"
     }
    ]
   },
   {
    "name": "parseJpegExif",
    "kind": "function",
    "signature": "function parseJpegExif(bytes: Uint8Array): ExifData | null",
    "doc": "解析 JPEG 的 EXIF 段。",
    "members": []
   },
   {
    "name": "readJpegExif",
    "kind": "function",
    "signature": "function readJpegExif(file: Blob, maxBytes?: number): Promise<ExifData | null>",
    "doc": "从 Blob / File 读前若干字节解析 EXIF(只取头部,不必读整张图)",
    "members": []
   }
  ]
 },
 {
  "id": "drone-capture",
  "file": "drone-capture",
  "title": "CaptureService · 采集服务",
  "group": "影像采集层",
  "doc": "影像来源:场景渲染图 / 真实相机照片",
  "items": [
   {
    "name": "ImageSource",
    "kind": "type",
    "signature": "type ImageSource = 'virtual-camera' | 'real-camera'",
    "doc": "影像来源:场景渲染图 / 真实相机照片",
    "members": []
   },
   {
    "name": "CoordinateFrame",
    "kind": "type",
    "signature": "type CoordinateFrame = 'ecef' | 'local-enu' | 'project-local'",
    "doc": "相机位姿所在的坐标框架",
    "members": []
   },
   {
    "name": "CameraIntrinsics",
    "kind": "interface",
    "signature": "interface CameraIntrinsics { … }",
    "doc": "相机内参。",
    "members": [
     {
      "kind": "property",
      "name": "width",
      "signature": "width: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "height",
      "signature": "height: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "fx",
      "signature": "fx?: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "fy",
      "signature": "fy?: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "cx",
      "signature": "cx?: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "cy",
      "signature": "cy?: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "horizontalFovDeg",
      "signature": "horizontalFovDeg?: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "verticalFovDeg",
      "signature": "verticalFovDeg?: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "distortion",
      "signature": "distortion?: number[]",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "calibrationSource",
      "signature": "calibrationSource: 'known' | 'exif' | 'estimated' | 'unknown'",
      "doc": ""
     }
    ]
   },
   {
    "name": "CameraPose",
    "kind": "interface",
    "signature": "interface CameraPose { … }",
    "doc": "相机位姿。",
    "members": [
     {
      "kind": "property",
      "name": "position",
      "signature": "position: [number, number, number]",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "rotation",
      "signature": "rotation: [number, number, number, number]",
      "doc": "四元数 [x, y, z, w]"
     },
     {
      "kind": "property",
      "name": "coordinateFrame",
      "signature": "coordinateFrame: CoordinateFrame",
      "doc": ""
     }
    ]
   },
   {
    "name": "ImageValidation",
    "kind": "interface",
    "signature": "interface ImageValidation { … }",
    "doc": "影像校验结论",
    "members": [
     {
      "kind": "property",
      "name": "status",
      "signature": "status: 'pending' | 'valid' | 'warning' | 'invalid'",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "messages",
      "signature": "messages: string[]",
      "doc": ""
     }
    ]
   },
   {
    "name": "CaptureViewOverride",
    "kind": "interface",
    "signature": "interface CaptureViewOverride { … }",
    "doc": "取景**俯仰**覆盖 —— 让取景相机临时偏离\"云台当前俯仰\"的常态。",
    "members": [
     {
      "kind": "property",
      "name": "pitch",
      "signature": "pitch?: number",
      "doc": "俯仰(度):**替代**云台俯仰 —— 即该张照片相对水平面的绝对俯仰角。 不给则沿用云台当前俯仰。全景网格给的是绝对值,否则用户把云台压到 -90° 后全景会全朝地面。"
     }
    ]
   },
   {
    "name": "PanoramaShotRef",
    "kind": "interface",
    "signature": "interface PanoramaShotRef { … }",
    "doc": "影像在一次全景扫描里的定位(写进 `metadata.panorama`)",
    "members": [
     {
      "kind": "property",
      "name": "group",
      "signature": "group: string",
      "doc": "全景组 id:同一次扫描共用一个,拼接时按它聚合"
     },
     {
      "kind": "property",
      "name": "mode",
      "signature": "mode: string",
      "doc": "全景模式标识(`pano-wide` / `pano-180` / `pano-360`);这里用 string 以免形成循环依赖"
     },
     {
      "kind": "property",
      "name": "index",
      "signature": "index: number",
      "doc": "组内序号(1 起)"
     },
     {
      "kind": "property",
      "name": "total",
      "signature": "total: number",
      "doc": "组内总张数"
     },
     {
      "kind": "property",
      "name": "row",
      "signature": "row: number",
      "doc": "网格行列(0 起):row = 俯仰层, col = 机身水平方位"
     },
     {
      "kind": "property",
      "name": "col",
      "signature": "col: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "bodyYaw",
      "signature": "bodyYaw: number",
      "doc": "该张的**机身航向偏移**(度,相对本组起始航向;正值 = 向右/顺时针)"
     },
     {
      "kind": "property",
      "name": "pitch",
      "signature": "pitch: number",
      "doc": "该张的取景俯仰(度,绝对)"
     }
    ]
   },
   {
    "name": "VirtualCaptureOptions",
    "kind": "interface",
    "signature": "interface VirtualCaptureOptions { … }",
    "doc": "虚拟采集的附加参数",
    "members": [
     {
      "kind": "property",
      "name": "view",
      "signature": "view?: CaptureViewOverride | null",
      "doc": "本次取景的俯仰覆盖(用完自动复位;见 CaptureViewOverride)"
     },
     {
      "kind": "property",
      "name": "panorama",
      "signature": "panorama?: PanoramaShotRef",
      "doc": "本次取景属于哪个全景组"
     }
    ]
   },
   {
    "name": "CapturedImage",
    "kind": "interface",
    "signature": "interface CapturedImage { … }",
    "doc": "统一影像条目(虚拟采集与真实导入共用)",
    "members": [
     {
      "kind": "property",
      "name": "id",
      "signature": "id: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "source",
      "signature": "source: ImageSource",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "fileName",
      "signature": "fileName: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "mimeType",
      "signature": "mimeType: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "sizeBytes",
      "signature": "sizeBytes: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "capturedAt",
      "signature": "capturedAt: string",
      "doc": "ISO 8601;虚拟采集是快门时刻,真实照片优先取 EXIF 拍摄时间"
     },
     {
      "kind": "property",
      "name": "imageUrl",
      "signature": "imageUrl?: string",
      "doc": "预览地址:虚拟 = PNG data URL,真实 = Blob URL(仅浏览器内有效)"
     },
     {
      "kind": "property",
      "name": "localBlob",
      "signature": "localBlob?: Blob",
      "doc": "只用于浏览器内短期数据流,**不得写入服务端数据库**(见模块头)"
     },
     {
      "kind": "property",
      "name": "cameraIntrinsics",
      "signature": "cameraIntrinsics?: CameraIntrinsics",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "cameraPose",
      "signature": "cameraPose?: CameraPose",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "metadata",
      "signature": "metadata: { latitude?: number; longitude?: number; altitude?: number; cameraModel?: string; sceneId?: string; sceneVersion?: string; dronePoseId?: string; gimbalRotation?: [number, number, number, number]; gpsAccuracyMeters?: number; rtkFixed?: boolean; /** 虚拟影像的产出后端(three / cesium),便于区分同页两套后端的采集结果 */ engine?: string; /** 全景扫描定位(属于某次 180°/360° 拍摄时才有) */ panorama?: PanoramaShotRef; /** 真实照片的原始 EXIF(保留原始字段,避免二次解析丢信息) */ exif?: ExifData; }",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "validation",
      "signature": "validation: ImageValidation",
      "doc": ""
     }
    ]
   },
   {
    "name": "CaptureSessionOptions",
    "kind": "interface",
    "signature": "interface CaptureSessionOptions { … }",
    "doc": "采集会话参数",
    "members": [
     {
      "kind": "property",
      "name": "source",
      "signature": "source: ImageSource",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "name",
      "signature": "name: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "captureIntervalMs",
      "signature": "captureIntervalMs?: number",
      "doc": "自动采集的时间间隔(毫秒);0 / 缺省 = 不按时间触发"
     },
     {
      "kind": "property",
      "name": "distanceIntervalMeters",
      "signature": "distanceIntervalMeters?: number",
      "doc": "自动采集的距离间隔(米);0 / 缺省 = 不按距离触发"
     },
     {
      "kind": "property",
      "name": "includeCameraMetadata",
      "signature": "includeCameraMetadata?: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "sceneId",
      "signature": "sceneId?: string",
      "doc": "虚拟场景标识(便于回溯「这批影像出自哪个版本的场景」)"
     },
     {
      "kind": "property",
      "name": "sceneVersion",
      "signature": "sceneVersion?: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "georeference",
      "signature": "georeference?: GeoreferenceOrigin",
      "doc": "地理参考原点:给了它,局部 ENU 坐标同时能换算成经纬度"
     }
    ]
   },
   {
    "name": "GeoreferenceOrigin",
    "kind": "interface",
    "signature": "interface GeoreferenceOrigin { … }",
    "doc": "局部坐标 → 经纬高的原点(局部 ENU 的 (0,0,0) 落在这里)",
    "members": [
     {
      "kind": "property",
      "name": "longitude",
      "signature": "longitude: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "latitude",
      "signature": "latitude: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "altitude",
      "signature": "altitude?: number",
      "doc": ""
     }
    ]
   },
   {
    "name": "CaptureSessionStatus",
    "kind": "type",
    "signature": "type CaptureSessionStatus = 'created' | 'capturing' | 'paused' | 'finished' | 'failed'",
    "doc": "采集会话状态",
    "members": []
   },
   {
    "name": "CaptureSession",
    "kind": "interface",
    "signature": "interface CaptureSession { … }",
    "doc": "采集会话",
    "members": [
     {
      "kind": "property",
      "name": "id",
      "signature": "id: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "options",
      "signature": "options: CaptureSessionOptions",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "status",
      "signature": "status: CaptureSessionStatus",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "images",
      "signature": "images: CapturedImage[]",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "createdAt",
      "signature": "createdAt: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "updatedAt",
      "signature": "updatedAt: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "engine",
      "signature": "engine?: string",
      "doc": "产出后端(虚拟采集时由 provider 提供)"
     },
     {
      "kind": "property",
      "name": "autoCapturing",
      "signature": "autoCapturing: boolean",
      "doc": "自动采集是否进行中"
     }
    ]
   },
   {
    "name": "VirtualShot",
    "kind": "interface",
    "signature": "interface VirtualShot { … }",
    "doc": "取景成片的结构契约。",
    "members": [
     {
      "kind": "property",
      "name": "dataUrl",
      "signature": "dataUrl: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "width",
      "signature": "width: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "height",
      "signature": "height: number",
      "doc": ""
     }
    ]
   },
   {
    "name": "CaptureCameraState",
    "kind": "interface",
    "signature": "interface CaptureCameraState { … }",
    "doc": "虚拟取景相机状态 —— 由渲染后端提供(见 `VirtualCaptureProvider`)。 注意这必须是**取景相机**(云台镜头)而不是机身:两者朝向可能完全不同。",
    "members": [
     {
      "kind": "property",
      "name": "pose",
      "signature": "pose: CameraPose",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "intrinsics",
      "signature": "intrinsics: CameraIntrinsics",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "frame",
      "signature": "frame: { width: number; height: number; }",
      "doc": "成片画幅(像素)"
     },
     {
      "kind": "property",
      "name": "scene",
      "signature": "scene?: { id?: string; version?: string; }",
      "doc": "场景标识"
     },
     {
      "kind": "property",
      "name": "drone",
      "signature": "drone?: { position: [number, number, number]; heading: number; tiltPitch: number; tiltRoll: number; gimbalPitch: number; gimbalYaw: number; }",
      "doc": "机体真值(诊断 / 复现用)"
     },
     {
      "kind": "property",
      "name": "geo",
      "signature": "geo?: { longitude: number; latitude: number; altitude: number; }",
      "doc": "相机的地理位置(地理坐标系后端提供;纯局部场景没有这个值)"
     }
    ]
   },
   {
    "name": "VirtualCaptureProvider",
    "kind": "interface",
    "signature": "interface VirtualCaptureProvider { … }",
    "doc": "宿主渲染后端向采集服务暴露的能力。",
    "members": [
     {
      "kind": "property",
      "name": "engine",
      "signature": "readonly engine?: string",
      "doc": "后端标识,写进影像元数据"
     },
     {
      "kind": "method",
      "name": "requestPhoto",
      "signature": "requestPhoto(): Promise<VirtualShot | null>",
      "doc": "取当前云台取景的一帧(与拍照完全同一条路径)"
     },
     {
      "kind": "method",
      "name": "getCaptureCamera",
      "signature": "getCaptureCamera(): CaptureCameraState | null",
      "doc": "取景相机的位姿与内参快照;模型 / 云台未就绪时返回 null"
     },
     {
      "kind": "method",
      "name": "setCaptureView",
      "signature": "setCaptureView?(override: CaptureViewOverride | null): void",
      "doc": "设置取景**俯仰**覆盖(全景分层用);传 `null` 复位。"
     },
     {
      "kind": "method",
      "name": "spinBodyTo",
      "signature": "spinBodyTo?(headingDeg: number | null): void",
      "doc": "让**机体原地自转**到绝对方位角 `headingDeg`(度,罗盘角);`null` 停止自转。"
     },
     {
      "kind": "method",
      "name": "getBodyHeading",
      "signature": "getBodyHeading?(): number",
      "doc": "机体当前方位角(度,罗盘角);没实现的后端返回 undefined"
     }
    ]
   },
   {
    "name": "CaptureSessionSummary",
    "kind": "interface",
    "signature": "interface CaptureSessionSummary { … }",
    "doc": "会话汇总(面板与导出共用)",
    "members": [
     {
      "kind": "property",
      "name": "total",
      "signature": "total: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "valid",
      "signature": "valid: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "warning",
      "signature": "warning: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "invalid",
      "signature": "invalid: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "pending",
      "signature": "pending: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "withGps",
      "signature": "withGps: number",
      "doc": "真实照片里带 GPS 的张数"
     },
     {
      "kind": "property",
      "name": "withPose",
      "signature": "withPose: number",
      "doc": "虚拟影像里带完整相机位姿的张数"
     }
    ]
   },
   {
    "name": "CaptureExportFormat",
    "kind": "type",
    "signature": "type CaptureExportFormat = 'json' | 'csv'",
    "doc": "导出格式",
    "members": []
   },
   {
    "name": "CAPTURE_EXPORT_FORMAT",
    "kind": "const",
    "signature": "const CAPTURE_EXPORT_FORMAT = \"drone-camera/capture-session\"",
    "doc": "会话导出文件标识",
    "members": []
   },
   {
    "name": "CAPTURE_EXPORT_VERSION",
    "kind": "const",
    "signature": "const CAPTURE_EXPORT_VERSION = 1",
    "doc": "导出结构版本",
    "members": []
   },
   {
    "name": "validateCapturedImage",
    "kind": "function",
    "signature": "function validateCapturedImage(image: CapturedImage): ImageValidation",
    "doc": "逐张影像的校验规则",
    "members": []
   },
   {
    "name": "summarizeSession",
    "kind": "function",
    "signature": "function summarizeSession(session: CaptureSession): CaptureSessionSummary",
    "doc": "会话汇总",
    "members": []
   },
   {
    "name": "intrinsicsFromExif",
    "kind": "function",
    "signature": "function intrinsicsFromExif(exif: ExifData | null | undefined, width: number, height: number): CameraIntrinsics",
    "doc": "由 EXIF 推相机内参。",
    "members": []
   },
   {
    "name": "CaptureServiceOptions",
    "kind": "interface",
    "signature": "interface CaptureServiceOptions { … }",
    "doc": "`CaptureService` 构造选项",
    "members": [
     {
      "kind": "property",
      "name": "provider",
      "signature": "provider?: VirtualCaptureProvider | null",
      "doc": "虚拟取景帧来源(渲染后端)"
     },
     {
      "kind": "property",
      "name": "now",
      "signature": "now?: () => Date",
      "doc": "时间源,便于测试注入"
     },
     {
      "kind": "property",
      "name": "createId",
      "signature": "createId?: () => string",
      "doc": "id 生成器,便于测试注入"
     }
    ]
   },
   {
    "name": "CaptureService",
    "kind": "class",
    "signature": "declare class CaptureService { … }",
    "doc": "影像采集服务:管理采集会话、把两类影像归一成 `CapturedImage`、并支持导出。",
    "members": [
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(options?: CaptureServiceOptions)",
      "doc": "构造采集服务:管理拍摄会话与自动采集(每会话独立相册)"
     },
     {
      "kind": "method",
      "name": "setProvider",
      "signature": "setProvider(provider: VirtualCaptureProvider | null): void",
      "doc": "换绑定后端(机体切换 / 引擎重建后重新挂)"
     },
     {
      "kind": "method",
      "name": "getCaptureIntrinsics",
      "signature": "getCaptureIntrinsics(): CameraIntrinsics | null",
      "doc": "读取当前取景相机内参(未就绪或后端未提供时返回 null)。"
     },
     {
      "kind": "method",
      "name": "createSession",
      "signature": "createSession(options: CaptureSessionOptions): CaptureSession",
      "doc": "新建拍摄会话(指定覆盖俯仰/张数等,返回会话)"
     },
     {
      "kind": "method",
      "name": "getSession",
      "signature": "getSession(id: string): CaptureSession | null",
      "doc": "按 id 取会话(不存在返回 null)"
     },
     {
      "kind": "method",
      "name": "listSessions",
      "signature": "listSessions(): CaptureSession[]",
      "doc": "列全部会话(按创建时间)"
     },
     {
      "kind": "getter",
      "name": "activeSession",
      "signature": "get activeSession(): CaptureSession | null",
      "doc": "当前会话(最近创建 / 最近操作的那个);面板默认展示它"
     },
     {
      "kind": "method",
      "name": "pauseSession",
      "signature": "pauseSession(id: string): void",
      "doc": "暂停会话的自动采集"
     },
     {
      "kind": "method",
      "name": "resumeSession",
      "signature": "resumeSession(id: string): void",
      "doc": "续跑被暂停的会话"
     },
     {
      "kind": "method",
      "name": "finishSession",
      "signature": "finishSession(id: string): CaptureSession | null",
      "doc": "结束会话(停止采集,照片保留;返回被结束的会话)"
     },
     {
      "kind": "method",
      "name": "removeSession",
      "signature": "removeSession(id: string): void",
      "doc": "删除会话及其全部照片"
     },
     {
      "kind": "method",
      "name": "removeImage",
      "signature": "removeImage(sessionId: string, imageId: string): boolean",
      "doc": "移除单张影像(无效照片的常规处置)"
     },
     {
      "kind": "method",
      "name": "clearImages",
      "signature": "clearImages(sessionId: string): void",
      "doc": "清空会话内全部照片(会话保留)"
     },
     {
      "kind": "method",
      "name": "subscribe",
      "signature": "subscribe(listener: (session: CaptureSession) => void): () => void",
      "doc": "订阅会话变更(面板用);返回退订函数"
     },
     {
      "kind": "method",
      "name": "captureVirtualImage",
      "signature": "captureVirtualImage(sessionId: string, options?: VirtualCaptureOptions): Promise<CapturedImage | null>",
      "doc": "采集一张虚拟影像。"
     },
     {
      "kind": "getter",
      "name": "canSpinBody",
      "signature": "get canSpinBody(): boolean",
      "doc": "后端是否支持\"机体原地自转\" —— 全景的水平覆盖只有它做得出来"
     },
     {
      "kind": "method",
      "name": "getBodyHeading",
      "signature": "getBodyHeading(): number | null",
      "doc": "机体当前方位角(度,罗盘角);后端不支持时返回 null"
     },
     {
      "kind": "method",
      "name": "spinBodyTo",
      "signature": "spinBodyTo(headingDeg: number | null): void",
      "doc": "让机体原地自转到绝对方位角 `headingDeg`;`null` 停止自转(后端不支持则什么都不做)"
     },
     {
      "kind": "method",
      "name": "startAutoCapture",
      "signature": "startAutoCapture(sessionId: string, options?: { intervalMs?: number; distanceMeters?: number; }): boolean",
      "doc": "开始自动采集:在一条 200ms 的心跳上同时评估**时间**与**距离**两个触发条件, 谁先满足就先拍一张,并同时刷新两个基准 —— 避免时间与距离各自计时导致的重复连拍。"
     },
     {
      "kind": "method",
      "name": "stopAutoCapture",
      "signature": "stopAutoCapture(sessionId: string): void",
      "doc": "停止会话的自动采集(会话与照片都保留)"
     },
     {
      "kind": "method",
      "name": "isAutoCapturing",
      "signature": "isAutoCapturing(sessionId: string): boolean",
      "doc": "会话是否正在自动采集(定时按间隔拍照)"
     },
     {
      "kind": "method",
      "name": "importRealImages",
      "signature": "importRealImages(sessionId: string, files: File[] | FileList): Promise<CapturedImage[]>",
      "doc": "导入真实照片。**尽力保留原始信息**:EXIF 全读,读不到就明确标记缺失, 但绝不因此拒绝文件 —— 「有没有元数据」本身是需要展示的信息(见 validateCapturedImage)。"
     },
     {
      "kind": "method",
      "name": "exportSession",
      "signature": "exportSession(sessionId: string, format?: CaptureExportFormat): string",
      "doc": "导出会话清单为 JSON(完整存档)或 CSV(表格式,可直接进 Excel)"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-capture-panel",
  "file": "drone-capture-panel",
  "title": "DroneCapturePanel · 采集面板",
  "group": "影像采集层",
  "doc": "影像采集面板(原生 DOM):采集会话 / 虚拟采集 / 真实照片导入 / 导出 —— 只放**动作**。",
  "items": [
   {
    "name": "DroneCapturePanelPosition",
    "kind": "type",
    "signature": "type DroneCapturePanelPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'",
    "doc": "面板停靠位置(与 DroneControlPanel 同一组取值)",
    "members": []
   },
   {
    "name": "DroneCapturePanelOptions",
    "kind": "interface",
    "signature": "interface DroneCapturePanelOptions { … }",
    "doc": "DroneCapturePanel 构造选项",
    "members": [
     {
      "kind": "property",
      "name": "container",
      "signature": "container?: HTMLElement | null",
      "doc": "挂载容器;缺省挂到 document.body(此时用 fixed 定位)"
     },
     {
      "kind": "property",
      "name": "position",
      "signature": "position?: DroneCapturePanelPosition",
      "doc": "停靠位置,默认 'bottom-left'(three 页左上/右上/底部中央已被别的面板占用)"
     },
     {
      "kind": "property",
      "name": "offset",
      "signature": "offset?: { x?: number; y?: number; }",
      "doc": "停靠微调(像素)。用 margin 实现,不覆盖 position 的定位规则 —— 演示页里底部左右角已经被 HUD 摇杆占住,面板整体上抬一段就能错开。"
     },
     {
      "kind": "property",
      "name": "title",
      "signature": "title?: string",
      "doc": "面板标题,默认「影像采集」"
     },
     {
      "kind": "property",
      "name": "injectStyles",
      "signature": "injectStyles?: boolean",
      "doc": "是否注入自带样式,默认 true"
     },
     {
      "kind": "property",
      "name": "visible",
      "signature": "visible?: boolean",
      "doc": "初始是否可见,默认 true"
     },
     {
      "kind": "property",
      "name": "service",
      "signature": "service?: CaptureService",
      "doc": "已有采集服务(多面板共享一个会话列表时传入);缺省按 host 新建一个"
     },
     {
      "kind": "property",
      "name": "autoCreateSession",
      "signature": "autoCreateSession?: boolean",
      "doc": "挂载时若一个会话都没有,是否自动建一个虚拟采集会话,默认 true"
     },
     {
      "kind": "property",
      "name": "sessionDefaults",
      "signature": "sessionDefaults?: Partial<CaptureSessionOptions>",
      "doc": "新建会话时套用的默认参数(场景标识 / 地理参考原点 / 自动采集间隔)。 宿主知道自己跑在哪个场景里,把这些填上,采到的影像才带得上场景版本与经纬度。"
     },
     {
      "kind": "property",
      "name": "downloadOnExport",
      "signature": "downloadOnExport?: boolean",
      "doc": "导出时是否顺手触发浏览器下载,默认 true"
     },
     {
      "kind": "property",
      "name": "viewer",
      "signature": "viewer?: boolean",
      "doc": "是否启用大图查看器(影像集弹窗点缩略图时打开),默认 true。 弹窗挂在 `document.body` 上(不是面板内部,原因见 drone-image-viewer 模块头), 层级 / 下载按钮 / 翻页回调等细项走 `viewerOptions`。"
     },
     {
      "kind": "property",
      "name": "viewerOptions",
      "signature": "viewerOptions?: DroneImageViewerOptions",
      "doc": "弹窗查看器的细项(层级 / 是否提供下载 / 关闭与翻页回调)"
     },
     {
      "kind": "property",
      "name": "gallery",
      "signature": "gallery?: boolean",
      "doc": "是否启用影像集弹窗(面板上的「打开影像集」按钮),默认 true。 影像的浏览 / 分组 / 一键合成都在它里面(见 drone-gallery);`false` 则面板不提供该入口。"
     },
     {
      "kind": "property",
      "name": "galleryOptions",
      "signature": "galleryOptions?: DroneGalleryOptions",
      "doc": "影像集弹窗的细项(层级 / 合成器 / 关闭与合成回调)"
     }
    ]
   },
   {
    "name": "DroneCapturePanel",
    "kind": "class",
    "signature": "declare class DroneCapturePanel { … }",
    "doc": "影像采集面板。",
    "members": [
     {
      "kind": "property",
      "name": "service",
      "signature": "readonly service: CaptureService",
      "doc": "采集服务(面板的视图数据源;宿主可直接用它编程式采集 / 导出)"
     },
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(host: VirtualCaptureProvider, options?: DroneCapturePanelOptions)",
      "doc": "构造采集面板:模式/张数/开始按钮 + 会话相册入口"
     },
     {
      "kind": "getter",
      "name": "session",
      "signature": "get session(): CaptureSession | null",
      "doc": "当前展示的会话"
     },
     {
      "kind": "method",
      "name": "setVisible",
      "signature": "setVisible(visible: boolean): void",
      "doc": "显示 / 隐藏"
     },
     {
      "kind": "method",
      "name": "openViewer",
      "signature": "openViewer(imageId?: string): void",
      "doc": "打开大图查看器。`imageId` 缺省用当前选中的那张(再缺省 = 最后一张)。 宿主若想在自己的界面上挂个「查看」按钮,调这里即可 —— 与点缩略图是同一条路径。"
     },
     {
      "kind": "method",
      "name": "closeViewer",
      "signature": "closeViewer(): void",
      "doc": "关闭大图查看器(没打开时是空操作)"
     },
     {
      "kind": "method",
      "name": "openGallery",
      "signature": "openGallery(sessionId?: string): void",
      "doc": "打开影像集弹窗(浏览 / 分组 / 一键合成);`gallery: false` 时是空操作"
     },
     {
      "kind": "method",
      "name": "closeGallery",
      "signature": "closeGallery(): void",
      "doc": "关闭影像集弹窗(连同它里面的大图查看器)"
     },
     {
      "kind": "method",
      "name": "sync",
      "signature": "sync(): void",
      "doc": "手动同步一次(宿主改了服务状态后可主动调用)"
     },
     {
      "kind": "method",
      "name": "setNote",
      "signature": "setNote(text: string, warn?: boolean): void",
      "doc": "面板底部的一行提示(参数不合法、导入进行中……)。 影像集搬进弹窗后,面板没有详情区了,这些\"一次性反馈\"需要个落脚处; 给个几秒后自动消失,免得过时的话一直挂在那儿。"
     },
     {
      "kind": "method",
      "name": "exportSession",
      "signature": "exportSession(session: CaptureSession, format: CaptureExportFormat): string",
      "doc": "导出当前会话清单(JSON 完整存档 / CSV 表格)"
     },
     {
      "kind": "method",
      "name": "destroy",
      "signature": "destroy(): void",
      "doc": "拆除面板 DOM 与轮询"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-gallery",
  "file": "drone-gallery",
  "title": "DroneGallery · 影像集",
  "group": "影像采集层",
  "doc": "影像集弹窗(原生 DOM):把整个影像集从采集面板里**搬出来单独看** —— 按「组合」分组、 每组一键合成、点缩略图看大图。",
  "items": [
   {
    "name": "DroneGalleryOptions",
    "kind": "interface",
    "signature": "interface DroneGalleryOptions { … }",
    "doc": "影像集弹窗构造选项",
    "members": [
     {
      "kind": "property",
      "name": "injectStyles",
      "signature": "injectStyles?: boolean",
      "doc": "是否注入自带样式,默认 true"
     },
     {
      "kind": "property",
      "name": "zIndex",
      "signature": "zIndex?: number",
      "doc": "弹窗层级,默认 900(大图查看器会自动排在它之上)"
     },
     {
      "kind": "property",
      "name": "title",
      "signature": "title?: string",
      "doc": "标题,默认「影像集」"
     },
     {
      "kind": "property",
      "name": "viewer",
      "signature": "viewer?: DroneImageViewer | null",
      "doc": "大图查看器:点缩略图时打开。不传则本弹窗自己建一个(并在销毁时一并卸载); `viewerEnabled: false` 可整块关掉\"点缩略图看大图\"。"
     },
     {
      "kind": "property",
      "name": "viewerEnabled",
      "signature": "viewerEnabled?: boolean",
      "doc": "是否启用\"点缩略图看大图\",默认 true(显式传了 `viewer` 时以传入的为准)"
     },
     {
      "kind": "property",
      "name": "viewerOptions",
      "signature": "viewerOptions?: DroneImageViewerOptions",
      "doc": "建自带查看器时透传的细项"
     },
     {
      "kind": "property",
      "name": "panoramaViewer",
      "signature": "panoramaViewer?: DronePanoramaViewer | null",
      "doc": "全景查看器:点合成结果时打开,**把等距柱状图贴回球面拖动环视**(真机相册的体验)。 不传则本弹窗自己建一个(并在销毁时一并卸载);`panoramaViewerEnabled: false` 关掉它 (那时合成结果仍可下载,只是不再有球面浏览)。"
     },
     {
      "kind": "property",
      "name": "panoramaViewerEnabled",
      "signature": "panoramaViewerEnabled?: boolean",
      "doc": "是否启用球面全景查看,默认 true(显式传了 `panoramaViewer` 时以传入的为准)"
     },
     {
      "kind": "property",
      "name": "panoramaViewerOptions",
      "signature": "panoramaViewerOptions?: DronePanoramaViewerOptions",
      "doc": "建自带全景查看器时透传的细项"
     },
     {
      "kind": "property",
      "name": "stitcher",
      "signature": "stitcher?: PanoramaStitcher | null",
      "doc": "合成器。「一键合成」用它把一组全景照片拼成一张图; 不传 = 库内自带的等距柱状拼接(见 drone-stitch);传 `null` = 关掉合成按钮。"
     },
     {
      "kind": "property",
      "name": "onClose",
      "signature": "onClose?: () => void",
      "doc": "关闭回调(点 × / 点遮罩 / Esc)"
     },
     {
      "kind": "property",
      "name": "onStitched",
      "signature": "onStitched?: (group: ImageGroup, result: PanoramaStitchResult | null) => void",
      "doc": "某组合成结束的回调(失败时 result 为 null)"
     }
    ]
   },
   {
    "name": "DroneGallery",
    "kind": "class",
    "signature": "declare class DroneGallery { … }",
    "doc": "影像集弹窗:按组合分组的影像浏览 + 每组一键合成。",
    "members": [
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(service: CaptureService, options?: DroneGalleryOptions)",
      "doc": "构造影像集弹窗:网格相册 + 大图 + 360° 环视入口"
     },
     {
      "kind": "getter",
      "name": "isOpen",
      "signature": "get isOpen(): boolean",
      "doc": "弹窗当前是否打开"
     },
     {
      "kind": "method",
      "name": "open",
      "signature": "open(sessionId?: string): void",
      "doc": "打开弹窗;`sessionId` 缺省用采集服务里当前活跃的会话"
     },
     {
      "kind": "method",
      "name": "close",
      "signature": "close(): void",
      "doc": "关闭弹窗(并把整棵 DOM / 键盘监听 / 两个子弹窗一并收走)"
     },
     {
      "kind": "method",
      "name": "refresh",
      "signature": "refresh(): void",
      "doc": "重新渲染当前会话的分组视图(宿主改了服务状态后可主动调用)"
     },
     {
      "kind": "method",
      "name": "closePanorama",
      "signature": "closePanorama(): void",
      "doc": "关闭球面全景查看器(没开时是空操作)"
     },
     {
      "kind": "method",
      "name": "stitch",
      "signature": "stitch(groupKey: string): Promise<PanoramaStitchResult | null>",
      "doc": "程序化合成某一组(与点「一键合成」同一条路径);已在合成中则忽略"
     },
     {
      "kind": "method",
      "name": "stitchAll",
      "signature": "stitchAll(): Promise<void>",
      "doc": "依次合成当前会话里所有的全景组"
     },
     {
      "kind": "method",
      "name": "destroy",
      "signature": "destroy(): void",
      "doc": "关闭并移除弹窗(含嵌套的大图/全景查看器)"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-image-utils",
  "file": "drone-image-utils",
  "title": "drone-image-utils · 影像工具",
  "group": "影像采集层",
  "doc": "影像展示工具(采集面板与弹窗查看器共用)。",
  "items": [
   {
    "name": "escapeHtml",
    "kind": "function",
    "signature": "function escapeHtml(text: string): string",
    "doc": "极简 HTML 转义。",
    "members": []
   },
   {
    "name": "formatBytes",
    "kind": "function",
    "signature": "function formatBytes(bytes: number): string",
    "doc": "人类可读的字节数",
    "members": []
   },
   {
    "name": "triggerDownload",
    "kind": "function",
    "signature": "function triggerDownload(url: string, filename: string): void",
    "doc": "触发浏览器下载(真实照片的 Blob URL 与导出的 data URL 共用)",
    "members": []
   },
   {
    "name": "createOriginalImagesZip",
    "kind": "function",
    "signature": "function createOriginalImagesZip(images: CapturedImage[]): Promise<Blob>",
    "doc": "将会话里的原始照片打包为不压缩 ZIP,避免重复压缩 JPEG/PNG 并控制额外内存占用。",
    "members": []
   },
   {
    "name": "VALIDATION_LABELS",
    "kind": "const",
    "signature": "const VALIDATION_LABELS: Record<CapturedImage['validation']['status'], string>",
    "doc": "校验状态对应的中文标签",
    "members": []
   },
   {
    "name": "VALIDATION_BADGES",
    "kind": "const",
    "signature": "const VALIDATION_BADGES: Record<CapturedImage['validation']['status'], string>",
    "doc": "缩略图角标字符",
    "members": []
   },
   {
    "name": "panoramaModeLabel",
    "kind": "function",
    "signature": "function panoramaModeLabel(mode: string): string",
    "doc": "全景模式的中文名(不引 drone-panorama,免得文案模块反向依赖拍摄模块)",
    "members": []
   },
   {
    "name": "ImageGroup",
    "kind": "interface",
    "signature": "interface ImageGroup { … }",
    "doc": "一组同源影像(同一次全景扫描,或\"未分组的单张\")。",
    "members": [
     {
      "kind": "property",
      "name": "key",
      "signature": "key: string",
      "doc": "分组键:全景组用 `metadata.panorama.group`,单张桶用固定值"
     },
     {
      "kind": "property",
      "name": "kind",
      "signature": "kind: 'panorama' | 'single'",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "label",
      "signature": "label: string",
      "doc": "展示名,如「180° 全景」/「单张影像」"
     },
     {
      "kind": "property",
      "name": "mode",
      "signature": "mode?: string",
      "doc": "全景模式标识(`pano-wide` / `pano-180` / `pano-360`);单张组为 undefined"
     },
     {
      "kind": "property",
      "name": "images",
      "signature": "images: CapturedImage[]",
      "doc": "组内影像(已按组内序号排序)"
     },
     {
      "kind": "property",
      "name": "indexes",
      "signature": "indexes: number[]",
      "doc": "组内影像在会话里的原始序号(1 起,与 `images` 一一对应)"
     },
     {
      "kind": "property",
      "name": "complete",
      "signature": "complete: boolean",
      "doc": "该组是否已拍满(张数达到预设总张数);单张组恒为 false"
     },
     {
      "kind": "property",
      "name": "total",
      "signature": "total?: number",
      "doc": "预设总张数(全景组才有)"
     }
    ]
   },
   {
    "name": "UNGROUPED_KEY",
    "kind": "const",
    "signature": "const UNGROUPED_KEY = \"__ungrouped__\"",
    "doc": "未分组影像的桶键",
    "members": []
   },
   {
    "name": "groupSessionImages",
    "kind": "function",
    "signature": "function groupSessionImages(images: CapturedImage[]): ImageGroup[]",
    "doc": "把会话里的影像按「组合」切开 —— 全景组按 `metadata.panorama.group` 聚合(保持首次出现顺序), 其余归入一个「单张影像」桶并排在最后。",
    "members": []
   },
   {
    "name": "imageTileLabel",
    "kind": "function",
    "signature": "function imageTileLabel(image: CapturedImage, sequence: number): string",
    "doc": "缩略图右上角的定位标签(全景影像显示\"第几方位 / 第几层\",其余显示序号)",
    "members": []
   },
   {
    "name": "describeImage",
    "kind": "function",
    "signature": "function describeImage(image: CapturedImage, index: number): string",
    "doc": "单张影像的元数据详情文本(面板详情区 / 弹窗查看器共用;含 `<b>` 等受控标签)",
    "members": []
   }
  ]
 },
 {
  "id": "drone-image-viewer",
  "file": "drone-image-viewer",
  "title": "DroneImageViewer · 大图弹窗",
  "group": "影像采集层",
  "doc": "影像弹窗查看器(原生 DOM):点缩略图后铺开看大图 —— 大图 / 元数据 / 上一张下一张 / 下载。",
  "items": [
   {
    "name": "DroneImageViewerOptions",
    "kind": "interface",
    "signature": "interface DroneImageViewerOptions { … }",
    "doc": "弹窗查看器构造选项",
    "members": [
     {
      "kind": "property",
      "name": "injectStyles",
      "signature": "injectStyles?: boolean",
      "doc": "是否注入自带样式,默认 true"
     },
     {
      "kind": "property",
      "name": "zIndex",
      "signature": "zIndex?: number",
      "doc": "弹窗层级,默认 1000(库内面板最高 21,留足余量)"
     },
     {
      "kind": "property",
      "name": "downloadable",
      "signature": "downloadable?: boolean",
      "doc": "是否提供「下载原图」按钮,默认 true"
     },
     {
      "kind": "property",
      "name": "onClose",
      "signature": "onClose?: () => void",
      "doc": "关闭回调(点 × / 点空白 / Esc 都会触发)"
     },
     {
      "kind": "property",
      "name": "onNavigate",
      "signature": "onNavigate?: (image: CapturedImage, index: number) => void",
      "doc": "翻页回调 —— 便于宿主把外部状态(如面板选中态)跟着同步"
     }
    ]
   },
   {
    "name": "DroneImageViewer",
    "kind": "class",
    "signature": "declare class DroneImageViewer { … }",
    "doc": "影像弹窗查看器。",
    "members": [
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(service: CaptureService, options?: DroneImageViewerOptions)",
      "doc": "构造大图查看弹窗(双击/点遮罩/Esc 关闭)"
     },
     {
      "kind": "getter",
      "name": "isOpen",
      "signature": "get isOpen(): boolean",
      "doc": "弹窗当前是否打开"
     },
     {
      "kind": "getter",
      "name": "current",
      "signature": "get current(): CapturedImage | null",
      "doc": "当前显示的那张影像(未打开 / 已失效时返回 null)"
     },
     {
      "kind": "method",
      "name": "open",
      "signature": "open(imageId: string, sessionId?: string): void",
      "doc": "打开弹窗;`sessionId` 缺省用采集服务里当前活跃的会话"
     },
     {
      "kind": "method",
      "name": "close",
      "signature": "close(): void",
      "doc": "关闭弹窗(并整个卸载 DOM / 摘掉键盘监听)"
     },
     {
      "kind": "method",
      "name": "step",
      "signature": "step(delta: number): void",
      "doc": "翻页:正值向后(下一张),负值向前;越界循环"
     },
     {
      "kind": "method",
      "name": "jump",
      "signature": "jump(index: number): void",
      "doc": "跳到指定下标(负值 = 最后一张)"
     },
     {
      "kind": "method",
      "name": "download",
      "signature": "download(): void",
      "doc": "下载当前显示的原图"
     },
     {
      "kind": "method",
      "name": "destroy",
      "signature": "destroy(): void",
      "doc": "关闭并移除弹窗"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-panorama-viewer",
  "file": "drone-panorama-viewer",
  "title": "DronePanoramaViewer · 球面查看器",
  "group": "影像采集层",
  "doc": "全景查看器(原生 DOM + 手写 WebGL):把等距柱状全景图**贴回球面**拖动环视 —— 一张平面的长条图,在这里变成能看四面八方的\"球形照片\"(真机相册里点开全景图的那种体验)。",
  "items": [
   {
    "name": "DronePanoramaViewerOptions",
    "kind": "interface",
    "signature": "interface DronePanoramaViewerOptions { … }",
    "doc": "全景查看器构造选项",
    "members": [
     {
      "kind": "property",
      "name": "injectStyles",
      "signature": "injectStyles?: boolean",
      "doc": "是否注入自带样式,默认 true"
     },
     {
      "kind": "property",
      "name": "zIndex",
      "signature": "zIndex?: number",
      "doc": "弹窗层级,默认 1100(排在影像集弹窗之上)"
     },
     {
      "kind": "property",
      "name": "initialYawDeg",
      "signature": "initialYawDeg?: number",
      "doc": "初始朝向(方位角,度),默认 0 = 输出图正中(即该组的起始航向)"
     },
     {
      "kind": "property",
      "name": "initialPitchDeg",
      "signature": "initialPitchDeg?: number",
      "doc": "初始仰角(度),默认 0 = 平视"
     },
     {
      "kind": "property",
      "name": "initialFovDeg",
      "signature": "initialFovDeg?: number",
      "doc": "初始垂直视野角(度),默认 75"
     },
     {
      "kind": "property",
      "name": "minFovDeg",
      "signature": "minFovDeg?: number",
      "doc": "垂直视野角上下限,默认 25 ~ 110"
     },
     {
      "kind": "property",
      "name": "maxFovDeg",
      "signature": "maxFovDeg?: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "downloadable",
      "signature": "downloadable?: boolean",
      "doc": "是否提供「下载原图」按钮,默认 true"
     },
     {
      "kind": "property",
      "name": "importable",
      "signature": "importable?: boolean",
      "doc": "是否提供「导入图片」按钮(从本地选一张等距柱状全景图看球面),默认 false。 影像集弹窗里已有自己的入口,那里不需要;独立打开的查看器(比如 demo 页的按钮)开着才方便。"
     },
     {
      "kind": "property",
      "name": "onClose",
      "signature": "onClose?: () => void",
      "doc": "关闭回调(点 × / 点遮罩 / Esc)"
     }
    ]
   },
   {
    "name": "DronePanoramaViewer",
    "kind": "class",
    "signature": "declare class DronePanoramaViewer { … }",
    "doc": "全景查看器:一张带有球面投影范围的等距柱状图 + 可拖动环视的球面局部或整球。",
    "members": [
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(options?: DronePanoramaViewerOptions)",
      "doc": "构造球面全景查看器(手写 WebGL 零依赖;可传初始角与导入开关)"
     },
     {
      "kind": "getter",
      "name": "isOpen",
      "signature": "get isOpen(): boolean",
      "doc": "弹窗当前是否打开"
     },
     {
      "kind": "getter",
      "name": "view",
      "signature": "get view(): { yaw: number; pitch: number; fov: number; }",
      "doc": "当前朝向(度),便于宿主做联动"
     },
     {
      "kind": "method",
      "name": "open",
      "signature": "open(source?: string | PanoramaStitchResult, title?: string): void",
      "doc": "打开弹窗;`source` 是等距柱状全景图的地址(data URL / blob / http 均可)。 不传 = 只开一个\"导入\"入口(配 `importable` 用),选了图再进来。"
     },
     {
      "kind": "method",
      "name": "close",
      "signature": "close(): void",
      "doc": "关闭弹窗(整个卸载 DOM 并释放 GL 资源)"
     },
     {
      "kind": "method",
      "name": "reset",
      "signature": "reset(): void",
      "doc": "视角复位到初始状态"
     },
     {
      "kind": "method",
      "name": "download",
      "signature": "download(): void",
      "doc": "下载当前这张全景原图"
     },
     {
      "kind": "method",
      "name": "destroy",
      "signature": "destroy(): void",
      "doc": "关闭弹窗并释放 GL 资源与 blob 地址"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-panorama",
  "file": "drone-panorama",
  "title": "PanoramaCapture · 全景拍摄",
  "group": "影像采集层",
  "doc": "全景拍摄(180° / 360°)—— 大疆式网格扫描。",
  "items": [
   {
    "name": "PanoramaMode",
    "kind": "type",
    "signature": "type PanoramaMode = 'pano-wide' | 'pano-180' | 'pano-360'",
    "doc": "全景模式",
    "members": []
   },
   {
    "name": "PanoramaShotSpec",
    "kind": "interface",
    "signature": "interface PanoramaShotSpec { … }",
    "doc": "网格里的一个拍摄点",
    "members": [
     {
      "kind": "property",
      "name": "index",
      "signature": "index: number",
      "doc": "组内序号(1 起,按扫描顺序:先扫完一个机身方位,再转下一个)"
     },
     {
      "kind": "property",
      "name": "row",
      "signature": "row: number",
      "doc": "网格行列(0 起;row = 俯仰层, col = 机身水平方位)"
     },
     {
      "kind": "property",
      "name": "col",
      "signature": "col: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "bodyYaw",
      "signature": "bodyYaw: number",
      "doc": "该张的**机身航向偏移**(度,相对本组起始航向;正值 = 向右/顺时针)"
     },
     {
      "kind": "property",
      "name": "pitch",
      "signature": "pitch: number",
      "doc": "该张的取景俯仰(度,相对水平面的绝对值)"
     }
    ]
   },
   {
    "name": "PanoramaPreset",
    "kind": "interface",
    "signature": "interface PanoramaPreset { … }",
    "doc": "全景预设",
    "members": [
     {
      "kind": "property",
      "name": "mode",
      "signature": "mode: PanoramaMode",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "label",
      "signature": "label: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "rows",
      "signature": "rows: number",
      "doc": "纵向拍摄层数(含球形模式单独补拍的天顶/天底)"
     },
     {
      "kind": "property",
      "name": "cols",
      "signature": "cols: number",
      "doc": "机身水平方位数(每一列要原地自转一次)"
     },
     {
      "kind": "property",
      "name": "rowPitches",
      "signature": "rowPitches: number[]",
      "doc": "环拍网格每层的取景俯仰(度);按从上到下排列"
     },
     {
      "kind": "property",
      "name": "bodyYawStart",
      "signature": "bodyYawStart: number",
      "doc": "第一列的机身偏航(度,相对起始航向)"
     },
     {
      "kind": "property",
      "name": "bodyYawStep",
      "signature": "bodyYawStep: number",
      "doc": "每列之间的机身偏航步进(度)"
     },
     {
      "kind": "property",
      "name": "finalBodyYaw",
      "signature": "finalBodyYaw: number",
      "doc": "扫描结束时机身应停在的偏航(度,相对起始航向)。 180° 网格停在 +90°(就是最后一列);球形 360° 补完天底后回到起始航向。"
     },
     {
      "kind": "property",
      "name": "shots",
      "signature": "shots: PanoramaShotSpec[]",
      "doc": "全部拍摄点(按扫描顺序:列优先)"
     },
     {
      "kind": "property",
      "name": "total",
      "signature": "total: number",
      "doc": ""
     }
    ]
   },
   {
    "name": "PANORAMA_PRESETS",
    "kind": "const",
    "signature": "const PANORAMA_PRESETS: Record<PanoramaMode, PanoramaPreset>",
    "doc": "广角采用 3×3 网格(9 张);180° 采用 7×3 网格(21 张); 球形 360° 采用 8 个方位;俯仰层数按相机实际垂直视场自动计算,并补天顶/天底。",
    "members": []
   },
   {
    "name": "PANORAMA_MODE_LIST",
    "kind": "const",
    "signature": "const PANORAMA_MODE_LIST: PanoramaMode[]",
    "doc": "供 UI 渲染的稳定顺序",
    "members": []
   },
   {
    "name": "PanoramaState",
    "kind": "type",
    "signature": "type PanoramaState = 'idle' | 'running' | 'done' | 'cancelled' | 'failed'",
    "doc": "全景扫描状态",
    "members": []
   },
   {
    "name": "PanoramaProgress",
    "kind": "interface",
    "signature": "interface PanoramaProgress { … }",
    "doc": "扫描进度(面板订阅它做展示)",
    "members": [
     {
      "kind": "property",
      "name": "state",
      "signature": "state: PanoramaState",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "mode",
      "signature": "mode: PanoramaMode",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "index",
      "signature": "index: number",
      "doc": "已完成张数"
     },
     {
      "kind": "property",
      "name": "total",
      "signature": "total: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "row",
      "signature": "row: number",
      "doc": "当前(或刚完成)的网格位置"
     },
     {
      "kind": "property",
      "name": "col",
      "signature": "col: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "bodyYaw",
      "signature": "bodyYaw: number",
      "doc": "当前列的机身航向偏移(度,相对起始航向)"
     },
     {
      "kind": "property",
      "name": "pitch",
      "signature": "pitch: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "group",
      "signature": "group: string | null",
      "doc": "组 id(开始拍摄后才有)"
     },
     {
      "kind": "property",
      "name": "message",
      "signature": "message?: string",
      "doc": ""
     }
    ]
   },
   {
    "name": "PanoramaGroup",
    "kind": "interface",
    "signature": "interface PanoramaGroup { … }",
    "doc": "一组全景照片(交给拼接器)",
    "members": [
     {
      "kind": "property",
      "name": "id",
      "signature": "id: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "mode",
      "signature": "mode: PanoramaMode",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "sessionId",
      "signature": "sessionId: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "images",
      "signature": "images: CapturedImage[]",
      "doc": "按组内序号排序"
     }
    ]
   },
   {
    "name": "PanoramaStitchResult",
    "kind": "interface",
    "signature": "interface PanoramaStitchResult { … }",
    "doc": "拼接产物(库里只搬运,不解释)",
    "members": [
     {
      "kind": "property",
      "name": "url",
      "signature": "url?: string",
      "doc": "可直接显示的地址(blob: / http: / data:);以字符串打开时按标准整球解释"
     },
     {
      "kind": "property",
      "name": "diagnosticUrl",
      "signature": "diagnosticUrl?: string",
      "doc": "可选的覆盖热力图:红=无照片覆盖,黄=单张覆盖,绿=多张重叠"
     },
     {
      "kind": "property",
      "name": "diagnosticCoverage",
      "signature": "diagnosticCoverage?: { uncovered: number; single: number; overlap: number; }",
      "doc": "覆盖热力图像素占比;未覆盖区域必须由拼接器补边,存在视差风险区域通常只被一张照片覆盖"
     },
     {
      "kind": "property",
      "name": "blob",
      "signature": "blob?: Blob",
      "doc": "也可以直接给二进制,由宿主决定怎么用"
     },
     {
      "kind": "property",
      "name": "width",
      "signature": "width?: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "height",
      "signature": "height?: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "name",
      "signature": "name?: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "coverage",
      "signature": "coverage?: number",
      "doc": "有效覆盖比例(0~1) —— 拼接后画面里\"真的有像素\"的部分占比。 库内自带拼接器(见 drone-stitch)会填;宿主自己的拼接器可以不填。 拿它判断\"这组是不是拍漏了\"(比如中途没转到位,角落空一块)。"
     },
     {
      "kind": "property",
      "name": "equirectangular",
      "signature": "equirectangular?: { thetaStart: number; spanTheta: number; phiTop: number; spanPhi: number; wrapsTheta: boolean; }",
      "doc": "局部全景带的球面范围;缺省表示标准 360°×180° 整球。"
     }
    ]
   },
   {
    "name": "PanoramaStitcher",
    "kind": "interface",
    "signature": "interface PanoramaStitcher { … }",
    "doc": "拼接器接口 —— **库内不提供实现**,由宿主注入(后端服务、WASM 拼接库、离线工具都行)。 整组拍完(未取消)后自动调用一次;返回 null 表示\"这次不拼\"。",
    "members": [
     {
      "kind": "method",
      "name": "stitch",
      "signature": "stitch(group: PanoramaGroup): Promise<PanoramaStitchResult | null>",
      "doc": "把一组已拍照片拼成等距柱状全景(按位姿反投影;覆盖不足返回 null)"
     }
    ]
   },
   {
    "name": "PanoramaResult",
    "kind": "interface",
    "signature": "interface PanoramaResult { … }",
    "doc": "一次扫描的最终结果",
    "members": [
     {
      "kind": "property",
      "name": "group",
      "signature": "group: string",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "mode",
      "signature": "mode: PanoramaMode",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "total",
      "signature": "total: number",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "captured",
      "signature": "captured: number",
      "doc": "实际入库张数(成片失败会少于 total)"
     },
     {
      "kind": "property",
      "name": "cancelled",
      "signature": "cancelled: boolean",
      "doc": ""
     },
     {
      "kind": "property",
      "name": "error",
      "signature": "error?: string",
      "doc": "没能完成的原因(机体没起飞 / 后端不支持自转 / 机身转不到位),成功时为 undefined"
     },
     {
      "kind": "property",
      "name": "stitched",
      "signature": "stitched?: PanoramaStitchResult | null",
      "doc": "拼接产物(注入过拼接器且未取消时才有)"
     }
    ]
   },
   {
    "name": "PanoramaCaptureOptions",
    "kind": "interface",
    "signature": "interface PanoramaCaptureOptions { … }",
    "doc": "`PanoramaCapture` 构造选项",
    "members": [
     {
      "kind": "property",
      "name": "shotIntervalMs",
      "signature": "shotIntervalMs?: number",
      "doc": "每张之间的间隔(毫秒),默认 0(拍完立即转下一个方位)。 想更贴近真机节奏、或给渲染后端留稳定时间时调大(真机每张约 0.5~1s)。"
     },
     {
      "kind": "property",
      "name": "spinTimeoutMs",
      "signature": "spinTimeoutMs?: number",
      "doc": "等待机身转到位的最长时间(毫秒),默认 8000。 超时即判定\"转不过去\"(没起飞、正在返航、速度倍率为 0),以失败收尾而不是硬拍。"
     },
     {
      "kind": "property",
      "name": "stitcher",
      "signature": "stitcher?: PanoramaStitcher | null",
      "doc": "拼接器(可选)"
     },
     {
      "kind": "property",
      "name": "onStitched",
      "signature": "onStitched?: (result: PanoramaStitchResult | null, group: PanoramaGroup) => void",
      "doc": "整组拍完并完成拼接后的回调(宿主落盘 / 提示用)"
     }
    ]
   },
   {
    "name": "sphericalPitchGrid",
    "kind": "function",
    "signature": "function sphericalPitchGrid(verticalFovDeg: number): number[]",
    "doc": "根据相机垂直 FOV 生成覆盖两极的俯仰层,相邻层中心距不超过 FOV 的 60%。",
    "members": []
   },
   {
    "name": "PanoramaCapture",
    "kind": "class",
    "signature": "declare class PanoramaCapture { … }",
    "doc": "全景扫描器:先转机身到方位、再按俯仰层逐张取景拍摄,把每张登记进 `CaptureService` 的会话。",
    "members": [
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(capture: CaptureService, options?: PanoramaCaptureOptions)",
      "doc": "构造全景扫描器:按俯仰分层 × 机体自转覆盖 360°"
     },
     {
      "kind": "getter",
      "name": "running",
      "signature": "get running(): boolean",
      "doc": "是否正在扫描"
     },
     {
      "kind": "getter",
      "name": "progress",
      "signature": "get progress(): PanoramaProgress | null",
      "doc": "当前进度快照(未拍摄过返回 null)"
     },
     {
      "kind": "method",
      "name": "subscribe",
      "signature": "subscribe(listener: (progress: PanoramaProgress) => void): () => void",
      "doc": "订阅进度变化;返回退订函数"
     },
     {
      "kind": "method",
      "name": "setStitcher",
      "signature": "setStitcher(stitcher: PanoramaStitcher | null): void",
      "doc": "设置 / 替换拼接器(传 null 关闭)"
     },
     {
      "kind": "method",
      "name": "preset",
      "signature": "static preset(mode: PanoramaMode, verticalFovDeg?: number): PanoramaPreset",
      "doc": "取预设(UI 展示行列数 / 张数用)"
     },
     {
      "kind": "method",
      "name": "start",
      "signature": "start(sessionId: string, mode: PanoramaMode): Promise<PanoramaResult | null>",
      "doc": "开始一次扫描。已在扫描中、或会话不存在时返回 null(不排队,避免误触连发)。"
     },
     {
      "kind": "method",
      "name": "cancel",
      "signature": "cancel(): void",
      "doc": "请求停止当前扫描(当前那一张会拍完再退出)"
     },
     {
      "kind": "method",
      "name": "buildGroup",
      "signature": "buildGroup(sessionId: string, group: string, mode: PanoramaMode): PanoramaGroup | null",
      "doc": "按组 id 从会话里聚合已拍的照片(按序号排序)—— 拼接器与导出都用它"
     }
    ]
   }
  ]
 },
 {
  "id": "drone-stitch",
  "file": "drone-stitch",
  "title": "drone-stitch · 全景拼接",
  "group": "影像采集层",
  "doc": "输出投影方式",
  "items": [
   {
    "name": "EquirectProjection",
    "kind": "type",
    "signature": "type EquirectProjection = 'sphere' | 'band'",
    "doc": "输出投影方式",
    "members": []
   },
   {
    "name": "EquirectFill",
    "kind": "type",
    "signature": "type EquirectFill = 'edge' | 'none'",
    "doc": "球面输出时未覆盖区域的填充方式",
    "members": []
   },
   {
    "name": "EquirectStitcherOptions",
    "kind": "interface",
    "signature": "interface EquirectStitcherOptions { … }",
    "doc": "`EquirectStitcher` 构造选项",
    "members": [
     {
      "kind": "property",
      "name": "pixelsPerDegree",
      "signature": "pixelsPerDegree?: number",
      "doc": "输出分辨率(每度像素数),默认 10。整球输出即 3600×1800。 越大越清晰、越慢(耗时与输出像素数 × 影像数成正比)。"
     },
     {
      "kind": "property",
      "name": "maxWidth",
      "signature": "maxWidth?: number",
      "doc": "输出宽度上限(像素),默认 4096;超出按比例整体缩小"
     },
     {
      "kind": "property",
      "name": "maxHeight",
      "signature": "maxHeight?: number",
      "doc": "输出高度上限(像素),默认 2048"
     },
     {
      "kind": "property",
      "name": "projection",
      "signature": "projection?: EquirectProjection",
      "doc": "输出投影,默认按全景模式自动选择(`pano-360` 用 sphere,广角/180° 用 band): - `'sphere'`:整颗球的标准等距柱状图(360°×180°、2:1 长条,与 DJI 全景同规格), 没拍到的天顶 / 天底 / 方位缺口按 `fill` 补上,输出是规整矩形;"
     },
     {
      "kind": "property",
      "name": "fill",
      "signature": "fill?: EquirectFill",
      "doc": "球面输出时未覆盖区域的填充方式,默认 `'edge'`: - `'edge'`:**先横向后纵向**补 —— 每行先横向接续(两侧月牙被同行最近的天空/地面 内容接上),再向天顶 / 天底铺该列的边缘颜色,与真机球面全景的观感一致;"
     },
     {
      "kind": "property",
      "name": "feather",
      "signature": "feather?: number",
      "doc": "羽化带宽(占半幅比例,0~0.9),默认 0.22"
     },
     {
      "kind": "property",
      "name": "background",
      "signature": "background?: string | null",
      "doc": "未覆盖区域的底色;不给 = 保持透明(需要 PNG)"
     },
     {
      "kind": "property",
      "name": "mimeType",
      "signature": "mimeType?: string",
      "doc": "输出 MIME,默认 `image/png`(透明角落需要 PNG);用 `image/jpeg` 时请同时给 `background`"
     },
     {
      "kind": "property",
      "name": "quality",
      "signature": "quality?: number",
      "doc": "JPEG 质量(0~1),默认 0.9"
     }
    ]
   },
   {
    "name": "EquirectStitcher",
    "kind": "class",
    "signature": "declare class EquirectStitcher implements PanoramaStitcher { … }",
    "doc": "库内默认的全景拼接器:按已知取景位姿把一组照片反投影成**一张等距柱状全景图**。",
    "members": [
     {
      "kind": "property",
      "name": "onProgress",
      "signature": "onProgress: ((done: number, total: number) => void) | null",
      "doc": "逐张回调(已完成张数 / 总张数),供 UI 播进度;不设则不回调"
     },
     {
      "kind": "method",
      "name": "constructor",
      "signature": "constructor(options?: EquirectStitcherOptions)",
      "doc": "构造拼接器:定输出尺寸/投影(fill/band)/补边策略,可复用"
     },
     {
      "kind": "method",
      "name": "stitch",
      "signature": "stitch(group: PanoramaGroup): Promise<PanoramaStitchResult | null>",
      "doc": "把一组全景照片拼成一张等距柱状全景图。"
     }
    ]
   },
   {
    "name": "createEquirectStitcher",
    "kind": "function",
    "signature": "function createEquirectStitcher(options?: EquirectStitcherOptions): EquirectStitcher",
    "doc": "建一个默认参数的等距柱状拼接器(库内默认注入给影像集弹窗的\"一键合成\")",
    "members": []
   },
   {
    "name": "angularExtent",
    "kind": "function",
    "signature": "function angularExtent(centerTheta: number, centerPhi: number, right: [number, number, number], up: [number, number, number], forward: [number, number, number], tanH: number, tanV: number): { halfTheta: number; halfPhi: number; }",
    "doc": "实测该张在方位 / 仰角上的覆盖半宽。",
    "members": []
   }
  ]
 }
]
