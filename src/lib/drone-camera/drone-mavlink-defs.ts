/**
 * MAVLink 消息定义表(零依赖,可单独被 Node 脚本 / 浏览器引用)。
 *
 * 设计取舍:**用一张表驱动编解码**,而不是给每个消息手写偏移量。
 * 理由很实在 —— MAVLink 的 payload 字段顺序**不是** XML 里写的顺序,而是按
 * 「类型宽度降序」重排(同宽度保持声明顺序),扩展字段则原样追加在末尾。
 * 手写偏移迟早会因为一条消息的宽度变化整体错位,而表驱动只错一处、且能被
 * `mavlink/verify-crc-extra.mjs` 逐条校验。
 *
 * 字段顺序的两种视角:
 * - `fields` 数组 = XML 声明顺序 → **只**用于算 CRC_EXTRA;
 * - `wireOrder()` = payload 里的真实字节顺序 → 用于编解码。
 *
 * 扩展字段(`ext: true`)不参与 CRC_EXTRA,只影响 payload 长度。因为 MAVLink 2
 * 会把末尾的 0 截断,而解码端按「有多少读多少」处理,所以扩展字段多写少写
 * 不会破坏兼容性 —— 只要 **base 字段绝对正确**。
 */

/** MAVLink 基础类型名(与 XML 里的写法一致,用于算 CRC_EXTRA) */
export type MavFieldType =
  | 'uint8_t'
  | 'int8_t'
  | 'char'
  | 'uint16_t'
  | 'int16_t'
  | 'uint32_t'
  | 'int32_t'
  | 'uint64_t'
  | 'int64_t'
  | 'float'
  | 'double'

/** 单个字段:数组用 `len` 表达(`char[50]` → `{ type: 'char', len: 50 }`) */
export interface MavFieldDef {
  name: string
  type: MavFieldType
  /** 数组长度;缺省为标量 */
  len?: number
  /** 扩展字段:不计入 CRC_EXTRA,永远排在 payload 末尾 */
  ext?: boolean
}

/** 一条消息的定义 */
export interface MavMessageDef {
  /** 中文用途说明(仅文档价值) */
  note: string
  fields: MavFieldDef[]
}

/** 类型宽度(字节)—— wire 排序与偏移计算都靠它 */
export const MAV_TYPE_SIZE: Record<MavFieldType, number> = {
  char: 1,
  uint8_t: 1,
  int8_t: 1,
  uint16_t: 2,
  int16_t: 2,
  uint32_t: 4,
  int32_t: 4,
  float: 4,
  uint64_t: 8,
  int64_t: 8,
  double: 8,
}

/** 常用消息 ID(只列本库用到的;全表见 MAVLink common.xml) */
export const MAVLINK_MSG_ID = {
  HEARTBEAT: 0,
  SYS_STATUS: 1,
  SYSTEM_TIME: 2,
  PING: 4,
  GPS_RAW_INT: 24,
  ATTITUDE: 30,
  LOCAL_POSITION_NED: 32,
  GLOBAL_POSITION_INT: 33,
  MISSION_CURRENT: 42,
  MISSION_ITEM: 39,
  MISSION_COUNT: 44,
  MISSION_ACK: 47,
  MISSION_REQUEST: 40,
  MISSION_REQUEST_INT: 51,
  RC_CHANNELS: 65,
  MANUAL_CONTROL: 69,
  MISSION_ITEM_INT: 73,
  VFR_HUD: 74,
  COMMAND_LONG: 76,
  COMMAND_ACK: 77,
  SET_POSITION_TARGET_LOCAL_NED: 84,
  BATTERY_STATUS: 147,
  HOME_POSITION: 242,
  MOUNT_ORIENTATION: 265,
  GIMBAL_DEVICE_ATTITUDE_STATUS: 285,
  STATUSTEXT: 253,
} as const

export type MavMessageName = keyof typeof MAVLINK_MSG_ID

/**
 * CRC_EXTRA 表 —— MAVLink 的「定义指纹」。
 *
 * 每帧的 X25 校验和会先用 `[msgid]` 和本表的值做种子,因此同名消息只要字段定义
 * 不同,收到的帧就会被判为坏帧。**这张表写错 = 静默丢帧**,是本模块最大的风险点,
 * 所以配了 `mavlink/verify-crc-extra.mjs` 从字段定义反算一遍做交叉验证。
 *
 * 解析器另有 `crc: 'lenient'` 模式:校验不过仍然解析,只累计 `crcErrors` ——
 * 这样即便某条消息的 CRC_EXTRA 抄错,也能从计数上看出来,而不是数据凭空消失。
 */
export const CRC_EXTRA: Record<MavMessageName, number> = {
  HEARTBEAT: 50,
  SYS_STATUS: 124,
  SYSTEM_TIME: 137,
  PING: 237,
  GPS_RAW_INT: 24,
  ATTITUDE: 39,
  LOCAL_POSITION_NED: 185,
  GLOBAL_POSITION_INT: 104,
  MISSION_CURRENT: 28,
  MISSION_ITEM: 254,
  MISSION_COUNT: 221,
  MISSION_ACK: 153,
  MISSION_REQUEST: 230,
  MISSION_REQUEST_INT: 196,
  RC_CHANNELS: 118,
  MANUAL_CONTROL: 243,
  MISSION_ITEM_INT: 38,
  VFR_HUD: 20,
  COMMAND_LONG: 152,
  COMMAND_ACK: 143,
  SET_POSITION_TARGET_LOCAL_NED: 143,
  BATTERY_STATUS: 154,
  HOME_POSITION: 104,
  MOUNT_ORIENTATION: 26,
  GIMBAL_DEVICE_ATTITUDE_STATUS: 201,
  STATUSTEXT: 83,
}

/**
 * 消息定义表。字段按 XML **声明顺序**书写,不要手动按宽度重排 ——
 * `wireOrder()` 会替你做重排。
 */
export const MESSAGE_DEFS: Record<MavMessageName, MavMessageDef> = {
  HEARTBEAT: {
    note: '心跳:机型、飞控类型、自定义模式、解锁状态',
    fields: [
      { name: 'type', type: 'uint8_t' },
      { name: 'autopilot', type: 'uint8_t' },
      { name: 'base_mode', type: 'uint8_t' },
      { name: 'custom_mode', type: 'uint32_t' },
      { name: 'system_status', type: 'uint8_t' },
      { name: 'mavlink_version', type: 'uint8_t' },
    ],
  },
  SYS_STATUS: {
    note: '系统状态:电池电压/电流/余量、传感器健康位',
    fields: [
      { name: 'onboard_control_sensors_present', type: 'uint32_t' },
      { name: 'onboard_control_sensors_enabled', type: 'uint32_t' },
      { name: 'onboard_control_sensors_health', type: 'uint32_t' },
      { name: 'load', type: 'uint16_t' },
      { name: 'voltage_battery', type: 'uint16_t' },
      { name: 'current_battery', type: 'int16_t' },
      { name: 'battery_remaining', type: 'int8_t' },
      { name: 'drop_rate_comm', type: 'uint16_t' },
      { name: 'errors_comm', type: 'uint16_t' },
      { name: 'errors_count1', type: 'uint16_t' },
      { name: 'errors_count2', type: 'uint16_t' },
      { name: 'errors_count3', type: 'uint16_t' },
      { name: 'errors_count4', type: 'uint16_t' },
    ],
  },
  SYSTEM_TIME: {
    note: '系统时间(Unix 微秒),用于把遥测时间轴对齐到真实时钟',
    fields: [
      { name: 'time_unix_usec', type: 'uint64_t' },
      { name: 'time_boot_ms', type: 'uint32_t' },
    ],
  },
  PING: {
    note: '链路往返时延探测',
    fields: [
      { name: 'time_usec', type: 'uint64_t' },
      { name: 'seq', type: 'uint32_t' },
      { name: 'target_system', type: 'uint8_t' },
      { name: 'target_component', type: 'uint8_t' },
    ],
  },
  GPS_RAW_INT: {
    note: '原始 GNSS:定位类型、经纬高、精度因子、可见卫星数',
    fields: [
      { name: 'time_usec', type: 'uint64_t' },
      { name: 'fix_type', type: 'uint8_t' },
      { name: 'lat', type: 'int32_t' },
      { name: 'lon', type: 'int32_t' },
      { name: 'alt', type: 'int32_t' },
      { name: 'eph', type: 'uint16_t' },
      { name: 'epv', type: 'uint16_t' },
      { name: 'vel', type: 'uint16_t' },
      { name: 'cog', type: 'uint16_t' },
      { name: 'satellites_visible', type: 'uint8_t' },
      { name: 'alt_ellipsoid', type: 'int32_t', ext: true },
      { name: 'h_acc', type: 'uint32_t', ext: true },
      { name: 'v_acc', type: 'uint32_t', ext: true },
      { name: 'vel_acc', type: 'uint32_t', ext: true },
      { name: 'hdg_acc', type: 'uint32_t', ext: true },
      { name: 'yaw', type: 'uint16_t', ext: true },
    ],
  },
  ATTITUDE: {
    note: '姿态:横滚/俯仰/偏航(弧度,NED)与三轴角速度',
    fields: [
      { name: 'time_boot_ms', type: 'uint32_t' },
      { name: 'roll', type: 'float' },
      { name: 'pitch', type: 'float' },
      { name: 'yaw', type: 'float' },
      { name: 'rollspeed', type: 'float' },
      { name: 'pitchspeed', type: 'float' },
      { name: 'yawspeed', type: 'float' },
    ],
  },
  LOCAL_POSITION_NED: {
    note: '本地 NED 位置/速度(米),相对 EKF 原点 —— 与 three 后端坐标最贴的一路',
    fields: [
      { name: 'time_boot_ms', type: 'uint32_t' },
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
      { name: 'vx', type: 'float' },
      { name: 'vy', type: 'float' },
      { name: 'vz', type: 'float' },
    ],
  },
  GLOBAL_POSITION_INT: {
    note: '全局位置:经纬度(1e-7 度)与海拔/相对高度(毫米),含三轴速度与航向',
    fields: [
      { name: 'time_boot_ms', type: 'uint32_t' },
      { name: 'lat', type: 'int32_t' },
      { name: 'lon', type: 'int32_t' },
      { name: 'alt', type: 'int32_t' },
      { name: 'relative_alt', type: 'int32_t' },
      { name: 'vx', type: 'int16_t' },
      { name: 'vy', type: 'int16_t' },
      { name: 'vz', type: 'int16_t' },
      { name: 'hdg', type: 'uint16_t' },
    ],
  },
  MISSION_CURRENT: {
    note: '当前执行的航点序号',
    fields: [
      { name: 'seq', type: 'uint16_t' },
      { name: 'total', type: 'uint16_t', ext: true },
      { name: 'mission_state', type: 'uint8_t', ext: true },
      { name: 'mission_mode', type: 'uint8_t', ext: true },
    ],
  },
  MISSION_COUNT: {
    note: '航线上传握手:我方主动告知将要发送多少个航点',
    fields: [
      { name: 'target_system', type: 'uint8_t' },
      { name: 'target_component', type: 'uint8_t' },
      { name: 'count', type: 'uint16_t' },
      { name: 'mission_type', type: 'uint8_t', ext: true },
    ],
  },
  MISSION_ACK: {
    note: '航线上传握手:飞控确认收到整条航线',
    fields: [
      { name: 'target_system', type: 'uint8_t' },
      { name: 'target_component', type: 'uint8_t' },
      { name: 'type', type: 'uint8_t' },
      { name: 'mission_type', type: 'uint8_t', ext: true },
    ],
  },
  MISSION_REQUEST: {
    note: '航线上传握手的老式版本:没有 INT 后缀,要求应答 MISSION_ITEM(浮点经纬度)。老固件与未协商协议的链路会用它',
    fields: [
      { name: 'target_system', type: 'uint8_t' },
      { name: 'target_component', type: 'uint8_t' },
      { name: 'seq', type: 'uint16_t' },
      { name: 'mission_type', type: 'uint8_t', ext: true },
    ],
  },
  MISSION_ITEM: {
    note: '单个航点(浮点经纬度版本),与 MISSION_REQUEST 配对',
    fields: [
      { name: 'target_system', type: 'uint8_t' },
      { name: 'target_component', type: 'uint8_t' },
      { name: 'seq', type: 'uint16_t' },
      { name: 'frame', type: 'uint8_t' },
      { name: 'command', type: 'uint16_t' },
      { name: 'current', type: 'uint8_t' },
      { name: 'autocontinue', type: 'uint8_t' },
      { name: 'param1', type: 'float' },
      { name: 'param2', type: 'float' },
      { name: 'param3', type: 'float' },
      { name: 'param4', type: 'float' },
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
      { name: 'mission_type', type: 'uint8_t', ext: true },
    ],
  },
  MISSION_REQUEST_INT: {
    note: '航线上传握手:飞控逐个索要航点(MISSION_ITEM_INT 版本)',
    fields: [
      { name: 'target_system', type: 'uint8_t' },
      { name: 'target_component', type: 'uint8_t' },
      { name: 'seq', type: 'uint16_t' },
      { name: 'mission_type', type: 'uint8_t', ext: true },
    ],
  },
  RC_CHANNELS: {
    note: '遥控通道原始值:用于判断遥控链路是否在动杆(失效保护的前置条件)',
    fields: [
      { name: 'time_boot_ms', type: 'uint32_t' },
      { name: 'chancount', type: 'uint8_t' },
      { name: 'chan1_raw', type: 'uint16_t' },
      { name: 'chan2_raw', type: 'uint16_t' },
      { name: 'chan3_raw', type: 'uint16_t' },
      { name: 'chan4_raw', type: 'uint16_t' },
      { name: 'chan5_raw', type: 'uint16_t' },
      { name: 'chan6_raw', type: 'uint16_t' },
      { name: 'chan7_raw', type: 'uint16_t' },
      { name: 'chan8_raw', type: 'uint16_t' },
      { name: 'chan9_raw', type: 'uint16_t' },
      { name: 'chan10_raw', type: 'uint16_t' },
      { name: 'chan11_raw', type: 'uint16_t' },
      { name: 'chan12_raw', type: 'uint16_t' },
      { name: 'chan13_raw', type: 'uint16_t' },
      { name: 'chan14_raw', type: 'uint16_t' },
      { name: 'chan15_raw', type: 'uint16_t' },
      { name: 'chan16_raw', type: 'uint16_t' },
      { name: 'chan17_raw', type: 'uint16_t' },
      { name: 'chan18_raw', type: 'uint16_t' },
      { name: 'rssi', type: 'uint8_t' },
    ],
  },
  MANUAL_CONTROL: {
    note: '地面站摇杆直通:x=俯仰 / y=横滚 / z=油门 / r=偏航,全部归一化到 ±1000(0 = 中位)。PX4 只在手动挡(POSCTL/ALTCTL/STABILIZED)吃这条消息',
    fields: [
      // ⚠️ 首字段名是 `target` 不是 `target_system`(其它消息多写成 target_system),
      // 名字进 CRC_EXTRA 的哈希,抄错一个字整条消息会被飞控静默丢弃
      { name: 'target', type: 'uint8_t' },
      { name: 'x', type: 'int16_t' },
      { name: 'y', type: 'int16_t' },
      { name: 'z', type: 'int16_t' },
      { name: 'r', type: 'int16_t' },
      { name: 'buttons', type: 'uint16_t' },
      { name: 'buttons2', type: 'uint16_t', ext: true },
      { name: 'enabled_extensions', type: 'uint8_t', ext: true },
      { name: 's', type: 'int16_t', ext: true },
      { name: 't', type: 'int16_t', ext: true },
      { name: 'aux1', type: 'int16_t', ext: true },
      { name: 'aux2', type: 'int16_t', ext: true },
      { name: 'aux3', type: 'int16_t', ext: true },
      { name: 'aux4', type: 'int16_t', ext: true },
      { name: 'aux5', type: 'int16_t', ext: true },
      { name: 'aux6', type: 'int16_t', ext: true },
    ],
  },
  MISSION_ITEM_INT: {
    note: '单个航点(整数经纬度版本)',
    fields: [
      { name: 'target_system', type: 'uint8_t' },
      { name: 'target_component', type: 'uint8_t' },
      { name: 'seq', type: 'uint16_t' },
      { name: 'frame', type: 'uint8_t' },
      { name: 'command', type: 'uint16_t' },
      { name: 'current', type: 'uint8_t' },
      { name: 'autocontinue', type: 'uint8_t' },
      { name: 'param1', type: 'float' },
      { name: 'param2', type: 'float' },
      { name: 'param3', type: 'float' },
      { name: 'param4', type: 'float' },
      { name: 'x', type: 'int32_t' },
      { name: 'y', type: 'int32_t' },
      { name: 'z', type: 'float' },
      { name: 'mission_type', type: 'uint8_t', ext: true },
    ],
  },
  VFR_HUD: {
    note: '座舱仪表:空速/地速/航向/油门/海拔/升降率 —— 面板仪表的现成来源',
    fields: [
      { name: 'airspeed', type: 'float' },
      { name: 'groundspeed', type: 'float' },
      { name: 'heading', type: 'int16_t' },
      { name: 'throttle', type: 'uint16_t' },
      { name: 'alt', type: 'float' },
      { name: 'climb', type: 'float' },
    ],
  },
  COMMAND_LONG: {
    note: '长命令:解锁 / 起飞 / 降落 / 返航 / 切模式,一条消息全包',
    fields: [
      { name: 'target_system', type: 'uint8_t' },
      { name: 'target_component', type: 'uint8_t' },
      { name: 'command', type: 'uint16_t' },
      { name: 'confirmation', type: 'uint8_t' },
      { name: 'param1', type: 'float' },
      { name: 'param2', type: 'float' },
      { name: 'param3', type: 'float' },
      { name: 'param4', type: 'float' },
      { name: 'param5', type: 'float' },
      { name: 'param6', type: 'float' },
      { name: 'param7', type: 'float' },
    ],
  },
  COMMAND_ACK: {
    note: '命令回执:面板据此判断"到底执不执行"',
    fields: [
      { name: 'command', type: 'uint16_t' },
      { name: 'result', type: 'uint8_t' },
      { name: 'progress', type: 'uint8_t', ext: true },
      { name: 'result_param2', type: 'int32_t', ext: true },
      { name: 'target_system', type: 'uint8_t', ext: true },
      { name: 'target_component', type: 'uint8_t', ext: true },
    ],
  },
  SET_POSITION_TARGET_LOCAL_NED: {
    note: '本地位置/速度指令(面板"改高度/去某点"走这条,而不是瞬移模型)',
    fields: [
      { name: 'time_boot_ms', type: 'uint32_t' },
      { name: 'target_system', type: 'uint8_t' },
      { name: 'target_component', type: 'uint8_t' },
      { name: 'coordinate_frame', type: 'uint8_t' },
      { name: 'type_mask', type: 'uint16_t' },
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
      { name: 'vx', type: 'float' },
      { name: 'vy', type: 'float' },
      { name: 'vz', type: 'float' },
      { name: 'afx', type: 'float' },
      { name: 'afy', type: 'float' },
      { name: 'afz', type: 'float' },
      { name: 'yaw', type: 'float' },
      { name: 'yaw_rate', type: 'float' },
    ],
  },
  BATTERY_STATUS: {
    note: '电池详情:剩余百分比、电压、电流、温度',
    fields: [
      { name: 'id', type: 'uint8_t' },
      { name: 'battery_function', type: 'uint8_t' },
      { name: 'type', type: 'uint8_t' },
      { name: 'temperature', type: 'int16_t' },
      { name: 'voltages', type: 'uint16_t', len: 10 },
      { name: 'current_battery', type: 'int16_t' },
      { name: 'current_consumed', type: 'int32_t' },
      { name: 'energy_consumed', type: 'int32_t' },
      { name: 'battery_remaining', type: 'int8_t' },
      { name: 'time_remaining', type: 'int32_t', ext: true },
      { name: 'charge_state', type: 'uint8_t', ext: true },
      { name: 'voltages_ext', type: 'uint16_t', len: 4, ext: true },
      { name: 'mode', type: 'uint8_t', ext: true },
      { name: 'fault_bitmask', type: 'uint32_t', ext: true },
    ],
  },
  HOME_POSITION: {
    note: '返航点(经纬高)。有了它就能把 GLOBAL_POSITION_INT 换成相对本地米 —— 这是接 SITL 的关键一步',
    fields: [
      { name: 'latitude', type: 'int32_t' },
      { name: 'longitude', type: 'int32_t' },
      { name: 'altitude', type: 'int32_t' },
      { name: 'x', type: 'float' },
      { name: 'y', type: 'float' },
      { name: 'z', type: 'float' },
      { name: 'q', type: 'float', len: 4 },
      { name: 'approach_x', type: 'float' },
      { name: 'approach_y', type: 'float' },
      { name: 'approach_z', type: 'float' },
      { name: 'time_usec', type: 'uint64_t', ext: true },
    ],
  },
  MOUNT_ORIENTATION: {
    note: '云台朝向(度)。老版本消息,部分机型仍在用',
    fields: [
      { name: 'time_boot_ms', type: 'uint32_t' },
      { name: 'roll', type: 'float' },
      { name: 'pitch', type: 'float' },
      { name: 'yaw', type: 'float' },
      { name: 'yaw_absolute', type: 'float', ext: true },
    ],
  },
  GIMBAL_DEVICE_ATTITUDE_STATUS: {
    note: '云台姿态四元数(新一代)。与 MOUNT_ORIENTATION 二选一即可',
    fields: [
      { name: 'target_system', type: 'uint8_t' },
      { name: 'target_component', type: 'uint8_t' },
      { name: 'flags', type: 'uint16_t' },
      { name: 'q', type: 'float', len: 4 },
      { name: 'angular_velocity_x', type: 'float' },
      { name: 'angular_velocity_y', type: 'float' },
      { name: 'angular_velocity_z', type: 'float' },
      { name: 'failure_flags', type: 'uint32_t' },
      { name: 'delta_yaw', type: 'float', ext: true },
      { name: 'delta_yaw_velocity', type: 'float', ext: true },
      { name: 'gimbal_device_id', type: 'uint8_t', ext: true },
    ],
  },
  STATUSTEXT: {
    note: '飞控文字消息:面板可以直接把它们转成事件日志',
    fields: [
      { name: 'severity', type: 'uint8_t' },
      { name: 'text', type: 'char', len: 50 },
      { name: 'id', type: 'uint16_t', ext: true },
      { name: 'chunk_seq', type: 'uint8_t', ext: true },
    ],
  },
}

/**
 * 把 XML 声明顺序重排成 payload 真实字节顺序:
 * 1. 基础字段按类型宽度降序(同宽度保持声明顺序,SORT 必须是稳定的);
 * 2. 扩展字段按声明顺序原样追加,不参与排序。
 */
export function wireOrder(def: MavMessageDef): MavFieldDef[] {
  const base = def.fields.filter((field) => !field.ext)
  const ext = def.fields.filter((field) => field.ext)
  // Array.prototype.sort 在现代引擎里是稳定排序,同宽度字段的相对次序因此得以保留
  const sorted = [...base].sort((a, b) => MAV_TYPE_SIZE[b.type] - MAV_TYPE_SIZE[a.type])
  return [...sorted, ...ext]
}

/** payload 的完整字节长度(含扩展字段) */
export function payloadLength(def: MavMessageDef): number {
  return wireOrder(def).reduce(
    (sum, field) => sum + MAV_TYPE_SIZE[field.type] * (field.len ?? 1),
    0,
  )
}

/** 常用 MAV_CMD 编号(只列本库会下发的) */
export const MAV_CMD = {
  NAV_WAYPOINT: 16,
  NAV_LOITER_UNLIM: 17,
  NAV_RETURN_TO_LAUNCH: 20,
  NAV_LAND: 21,
  NAV_TAKEOFF: 22,
  DO_SET_MODE: 176,
  COMPONENT_ARM_DISARM: 400,
} as const

/** MAV_RESULT:COMMAND_ACK.result */
export const MAV_RESULT: Record<number, string> = {
  0: 'ACCEPTED',
  1: 'TEMPORARILY_REJECTED',
  2: 'DENIED',
  3: 'UNSUPPORTED',
  4: 'FAILED',
  5: 'IN_PROGRESS',
  6: 'CANCELLED',
}

/** MAV_FRAME:航点坐标系 */
export const MAV_FRAME = {
  GLOBAL: 0,
  GLOBAL_RELATIVE_ALT: 3,
  GLOBAL_INT: 5,
  GLOBAL_RELATIVE_ALT_INT: 6,
} as const
