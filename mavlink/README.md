# MAVLink / SITL 接入

把 PX4 / ArduPilot(真机或 SITL)的遥测灌进 drone-camera 的场景,并用面板操控真飞控。

```
PX4 / ArduPilot (SITL 或真机)
   │  MAVLink 2 over UDP
   ▼
mavlink/bridge.mjs          ← 零依赖网桥:UDP ⇄ WebSocket(浏览器开不了 UDP)
   │  原样透传,不解析
   ▼
MavlinkSource (浏览器)       ← 帧解析 / CRC / 坐标换算 / 指令翻译
   │  applyExternalState()   ← 唯一状态写入口
   ▼
DroneSim                    ← 面板 / 鹰眼图 / 采集服务读这里(零改动)
   │
   ├── three 后端(WebGPU 沙盒)
   └── cesium 后端(真实地球)
```

## 快速开始

```bash
# 1. 起网桥(UDP 14550 ⇄ ws://127.0.0.1:8118)
node mavlink/bridge.mjs

# 2. 起 SITL(二选一)
make px4_sitl gz_x500                    # PX4 SITL
sim_vehicle.py -v ArduCopter --console   # ArduPilot SITL
# 或者没有飞栈时用假 SITL(说真实 MAVLink 2,并按 PX4 契约拒绝非法请求)
node mavlink/fake-sitl.mjs

# 3. 打开 demo
# http://127.0.0.1:5173/?mavlink=ws://127.0.0.1:8118
```

页面加载后,面板上的电量 / 卫星数 / 模式名(POSCTL / AUTO.MISSION …)全部来自飞控;
起飞 / 降落 / 返航 / 挡位 / 航线上传按钮都会翻译成对应 MAVLink 指令发回飞控。

## 代码接入(两种后端通用)

```ts
import { MavlinkSource } from 'drone-camera'

const source = new MavlinkSource({
  url: 'ws://127.0.0.1:8118',
  // home: { longitude: 116.391, latitude: 39.906, altitude: 50 },  // 可选锚点
  onEvent: (level, text) => console.log(level, text),
  onStatus: (status) => console.log(status.mode, status.armed),
})
source.attach(drone.sim)   // 接管:此后 sim 的真值全部来自飞控
await source.connect()

// 用完释放(断开 WebSocket + 解除接管)
await source.close()
```

`attach()` 之后 `drone.sim` 的所有读数(位置 / 姿态 / 电量 / 卫星 / 模式)都来自飞控;
`drone.sim.external !== null` 可用来判断当前是否处于接管态。
`detachExternalSource()` 可随时切回内置飞控模型(位置保持当前值,不跳回原点)。

## 双源热切换(内置模型 ⇄ 真飞控)

多数宿主不想自己管会话生命周期,直接用 `FlightSourceManager`:

```ts
import { FlightSourceManager } from 'drone-camera'

const sources = new FlightSourceManager({ sim: drone.sim, onChange: renderChip })

await sources.useMavlink('ws://127.0.0.1:8118')  // 飞控接管(热切换,不重建场景)
await sources.useInternal()                       // 交还内置模型;空中交接保持悬停
await sources.toggle()                            // 一键互换
sources.destroy()                                 // 宿主销毁时调用
```

它保证三件事:

1. **切换失败必回退** —— 连不上就交还内置模型。否则面板上所有按钮会被派发给一条不存在的链路,
   界面"看着能点但飞机不动",这是最难排查的一类故障;
2. **空中交接不跳变** —— 交还时按当前高度恢复内置状态机:空中 → `flying`(继续悬停,可降落/返航),
   地面 → `standby`;姿态清零、航点进度作废、桨不停转;
3. **状态可订阅** —— `state`(`kind` / `url` / `status` / `error`)在切换与每次心跳上报时都会触发 `onChange`。

内置模型的交接语义由 `DroneSim.detachExternalSource()` 实现,与渲染后端无关
(three 与 Cesium 的 demo 页顶部都有现成的切换按钮,可参考其接法)。

## 双源热切换(内置模型 ⇄ 真飞控)

多数宿主不想自己管会话生命周期,直接用 `FlightSourceManager`:

```ts
import { FlightSourceManager } from 'drone-camera'

const sources = new FlightSourceManager({ sim: drone.sim, onChange: renderChip })

await sources.useMavlink('ws://127.0.0.1:8118')  // 飞控接管(热切换,不重建场景)
await sources.useInternal()                       // 交还内置模型;空中交接保持悬停
await sources.toggle()                            // 一键互换
sources.destroy()                                 // 宿主销毁时调用
```

它保证三件事:

1. **切换失败必回退** —— 连不上就交还内置模型。否则面板上所有按钮会被派发给一条不存在的链路,
   界面"看着能点但飞机不动",这是最难排查的一类故障;
2. **空中交接不跳变** —— 交还时按当前高度恢复内置状态机:空中 → `flying`(继续悬停,可降落/返航),
   地面 → `standby`;姿态清零、航点进度作废、桨不停转;
3. **状态可订阅** —— `state`(`kind` / `url` / `status` / `error`)在切换与每次心跳上报时都会触发 `onChange`。

内置模型的交接语义由 `DroneSim.detachExternalSource()` 实现,与渲染后端无关
(three 与 Cesium 的 demo 页顶部都有现成的切换按钮,可参考其接法)。

## 指令映射

| 面板动作 | MAVLink |
|---|---|
| 起飞 | `MAV_CMD_COMPONENT_ARM_DISARM(400)` + `MAV_CMD_NAV_TAKEOFF(22)` |
| 降落 | `MAV_CMD_NAV_LAND(21)` |
| 返航 | `MAV_CMD_NAV_RETURN_TO_LAUNCH(20)` |
| 挡位切换 | `MAV_CMD_DO_SET_MODE(176)`;PX4 一律 POSCTL(三挡是遥控器拨杆,MAVLink 只能切主模式),ArduPilot 走 cine→LOITER / normal→POSHOLD / sport→SPORT |
| flyTo(改位置) | 先起 10 Hz `SET_POSITION_TARGET_LOCAL_NED(84)` 流,再切 OFFBOARD(PX4)/ GUIDED(ArduPilot) |
| 航线「执行」 | `MISSION_COUNT(44)` → `MISSION_ITEM_INT(73)…` 握手上传,成功后切 `AUTO.MISSION` |
| 航线「暂停 / 继续」 | `MAV_CMD_DO_PAUSE_CONTINUE(193)` |
| 航线「停止」 | 切 LOITER(留在原地,与内置语义一致) |

订阅的遥测:`HEARTBEAT` / `SYS_STATUS` / `GPS_RAW_INT` / `ATTITUDE` /
`LOCAL_POSITION_NED` / `GLOBAL_POSITION_INT` / `HOME_POSITION` / `VFR_HUD` /
`BATTERY_STATUS` / `MOUNT_ORIENTATION` / `GIMBAL_DEVICE_ATTITUDE_STATUS` /
`MISSION_CURRENT` / `COMMAND_ACK` / `STATUSTEXT`。

## 坐标换算

`GLOBAL_POSITION_INT` 是全球经纬高,`DroneSim` 要「相对返航点的本地米」(x 东 / y 上 / z 南)。
锚点优先级:`HOME_POSITION`(飞控自己记的返航点)→ 构造参数 `home` → 第一帧定位。
换算走 WGS84 → ECEF → ENU,复用 `drone-photogrammetry` 里已验证的纯函数。

## PX4 的行为契约(为什么测试不再是"绿得没意义")

第一版端到端测试 13/13 全绿,但那是**假飞控太客气**换来的:它什么都答应。
接真 PX4 会立刻翻车,而且是四个必现缺陷:

| 症状 | 真机行为 | 上一版的写法 |
|---|---|---|
| 起飞按钮失效 | 解锁要跑 preflight check,`COMMAND_ACK` 是延迟回来的;抢先发的 `NAV_TAKEOFF` 被 `COMMAND_DENIED(2)` | arm 与 takeoff 两帧连发 |
| 飞出去 0.5 秒就停住 | OFFBOARD 要求持续 setpoint,`COM_OF_LOSS_T` 默认 1.0 s 断流即判 offboard lost | `SET_POSITION_TARGET_LOCAL_NED` 只发一次 |
| 切换"运动挡"后失控 | `MANUAL` 是摇杆直通,无 RC 输入直接 failsafe | sport → `MANUAL`(1<<16) |
| 老链路航线上传卡死 | 老固件/未协商协议时问的是 `MISSION_REQUEST`(要浮点 `MISSION_ITEM`) | 只处理 `MISSION_REQUEST_INT` |

所以 `fake-sitl.mjs` 现在默认**按 PX4 契约拒绝**(`--lenient` 可关掉):

- 解锁异步生效(preflight check 300 ms),期间起飞被拒
- 进入 OFFBOARD 后开始计 `COM_OF_LOSS_T`(1 s),断流 → `STATUSTEXT: OFFBOARD LOST` → 退回 POSCTL
- 无 RC 输入切 `MANUAL` → 200 ms 内 failsafe 回 POSCTL
- 只接受 OFFBOARD 模式下的 setpoint(其他模式静默丢弃,和真机一样)
- 航点索要 3 次无应答 → `MISSION_ACK(REJECTED)`
- 心跳 1 Hz(与真机 GCS 链路一致),不是 2 Hz

源码侧对应的四道修:

1. 起飞排队等 `COMPONENT_ARM_DISARM` 的 ACK 再发 `NAV_TAKEOFF`(6 s 超时兜底)
2. `goto` 起一条 10 Hz 的 setpoint 流,到达 0.8 m 内才切回位置模式;而且**先把流铺好再切模式**
   —— 反过来的话,从切模式成功到第一帧 setpoint 到达之间有个空窗,1 s 超时很容易被吃掉
3. PX4 的挡位一律给 POSCTL:三挡是遥控器拨杆,MAVLink 只能切主模式,不假装能改
4. `MISSION_REQUEST` 与 `MISSION_REQUEST_INT` 分别回浮点 / 定点两种 `MISSION_ITEM`

## 验证(不需要 PX4)

```bash
npm run mavlink:verify               # 以下四项串起来跑
node mavlink/verify-crc-extra.mjs    # CRC_EXTRA 表与字段定义交叉校验(25/25)
node mavlink/verify-codec.mjs        # 编解码单元验证:往返 / 分片 / 粘包 / 重同步 / 篡改(14/14)
node mavlink/verify-px4-contract.mjs # PX4 契约:拒绝行为本身是否正确(16/16)
node mavlink/verify-loop.mjs         # 端到端:假SITL → 网桥 → MavlinkSource → DroneSim(13/13)
node mavlink/verify-loop.mjs --legacy # 同上,但走老式航线上传握手(13/13)
```

`verify-px4-contract` 不经过 `MavlinkSource`,它自己就是一个地面站:故意发非法请求,
断言飞控会拒绝、会超时、会 failsafe。这一层挡的是"假飞控又变客气了"。

`verify-loop` 会真的起飞、下位置指令、上传航线、降落,并断言 `DroneSim` 的状态随之变化。
它在严格契约下跑 —— 也就是说它验证的不只是"我们的代码能跑",而是"在真机时序下也成立"。

## 真 PX4 到手后的验证清单

本文的所有验证都在"按 PX4 规格拒绝"的模拟器上完成,真实的 PX4 SITL 还有几处只能实测:

1. `make px4_sitl gz_x500` 起固件,确认 `bridge.mjs` 能收到 14550 上的遥测(默认就是 GCS 端口)
2. PX4 的 `MAV_CMD_COMPONENT_ARM_DISARM` 在 SITL 里会检查 EKF 收敛,解锁可能比 300 ms 更慢
   —— 6 s 的超时窗口是否够用
3. 航线上传:现代 PX4 发 `MISSION_REQUEST_INT`,但若先做过 `MAV_PROTOCOL_CAPABILITY` 协商
   也可能走 `MISSION_REQUEST`,两条路径都要试
4. `GIMBAL_DEVICE_ATTITUDE_STATUS` 在 PX4 v1.14 之前的机型上不一定会发,云台可能只有
   `MOUNT_ORIENTATION`
5. `COM_OF_LOSS_T` / `COM_OBL_RC_ACT` 若被改过,断流行为会与本文件的默认值不同

## 已知边界

- MAVLink 1 只做基本支持(UDP/TCP 上不转义 0xFE;串口链路需要先过一层转义)。
- 签名帧(`MAVLINK_IFLAG_SIGNED`)会跳过 13 字节签名,但不校验签名本身。
- 逐桨转速需要 `SERVO_OUTPUT_RAW`,当前四桨按电机负载同速旋转。
- 云台优先吃 `MOUNT_ORIENTATION`(度),没有再解 `GIMBAL_DEVICE_ATTITUDE_STATUS` 四元数。
- `crc` 默认 `'lenient'`:校验失败仍解析但计入 `parserStats().crcErrors` —— CRC_EXTRA
  抄错的表现是「数据无声消失」,宽容模式让这种错误可见而不是致命。
