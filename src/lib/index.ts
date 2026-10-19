/**
 * 无人机控制系统（Drone Control System）—— 独立 npm 库 / ES6 模块统一入口。
 *
 * 迁移自 first-app 的 src/lib/three-engine，仅取「飞控」相关模块，
 * 不含模型查看器、模型体检、批处理、赛道等其它模块。
 *
 * 设计约定：
 * - 本入口只做「再导出」，不含任何业务装配逻辑，也不引用 Vue —— 整个 src/lib 与框架无关；
 * - `three` 系列模块在 ESM 库构建里全部 external（作为 peerDependency，由使用方提供实例），
 *   避免同一页面出现两份 three 实例（WebGPURenderer 与 TSL 节点会因此彻底失效）；
 * - 真正零依赖的只有 `./drone-camera/drone-sim`，可单独在 Node / Web Worker 中运行。
 *
 * 渲染后端（两套实现同一个 DronePanelHost 接口，由 `createDroneControl({ engine })` 装配）：
 * - `engine: 'three'`  —— DroneFly：three.js + WebGPURenderer 飞行沙盒（缺省）
 * - `engine: 'cesium'` —— CesiumDroneAdapter：地球坐标系（ENU/ECEF）下的飞行
 * 飞行内核都是同一个 DroneSim；控制面板 / 航线面板 / 鹰眼图 / 键盘控制完全不区分后端。
 *
 * 运行期资产（非构建依赖，由使用方自行提供）：
 * - `drone-fly.initialize()` 不传 `modelUrl` 时用**内置积木机体**（程序化几何体拼的四轴，
 *   零资产依赖，节点命名与真机 ID 表一致，机臂/桨叶/云台/灯光/雷达全部可用）；
 * - 要真机模型就显式传路径：`.initialize({ modelUrl: DRONE_MODEL_URL })`（默认指向
 *   `/models/djiair_renamed.glb`）或任意自己的 `.glb`。
 */

// ──────────────────────────────────────────────────────────────────────────
// 1. 纯逻辑层：零运行时依赖（不引 three、不碰 DOM），Node / Worker / 浏览器通吃
//    飞控状态机、电池模型、失效保护、摇杆归一化、避障 AABB 判定、事件日志、航线数据
// ──────────────────────────────────────────────────────────────────────────
export * from './drone-camera/drone-sim'

// ──────────────────────────────────────────────────────────────────────────
// 2. 无人机机械与感知层：地面/障碍物世界、机体装配、灯光、测距雷达、航线编辑
// ──────────────────────────────────────────────────────────────────────────
export * from './drone-camera/drone-control'
export * from './drone-camera/drone-world'
export * from './drone-camera/drone-rig'
export * from './drone-camera/drone-lights'
export * from './drone-camera/drone-radar'
export * from './drone-camera/mission-editor'

// ──────────────────────────────────────────────────────────────────────────
// 3. 飞行装配总控层：把上面几层拼成一台可飞行的无人机（需要 DOM / three 环境）
//    DroneFly 是 three.js + WebGPURenderer 的后端实现
// ──────────────────────────────────────────────────────────────────────────
export * from './drone-camera/drone-fly'

// ──────────────────────────────────────────────────────────────────────────
// 3b. Cesium 后端：同一个 DronePanelHost 接口的第二套实现（地球 ENU/ECEF 坐标系）
//     飞行内核仍是同一个 DroneSim，区别只在「真值怎么变成画面」——
//     · drone-cesium     —— 适配器：坐标换轴、每帧写 modelMatrix、相机接管、拍照/录像、
//                           航线任务 API（MissionPanelHost 的第二套实现）
//     · drone-cesium-rig —— 机体表现层：桨叶自转（写 Spin_Bone 关节矩阵）+ 钟罩反向
//                            补偿 + 机体灯光（LIGHT_* 锚点挂 Billboard 光晕）
//     · drone-cesium-mission —— 航线表现层：航点标记 / 航线折线实体 + 场景内拖拽编辑
//                           （交互约定与 three 版 MissionEditor 一致：拖拽移动、Shift 改高、
//                            Alt 细调、双击插入、Delete 删除、Esc 取消选中）
//     三者都按语义节点命名工作，非对应机体自动 no-op。Cesium 本身不随库打包：
//     使用方把静态资源放自有目录，用 loadCesiumScript() 注入或自行引 script。
// ──────────────────────────────────────────────────────────────────────────
export * from './drone-camera/drone-cesium-rig'
export * from './drone-camera/drone-cesium-mission'
export * from './drone-camera/drone-cesium'

// ──────────────────────────────────────────────────────────────────────────
// 3c. 引擎装配：`createDroneControl({ engine: 'three' | 'cesium' })` 一处选后端，
//     返回 DroneEngineHost（DronePanelHost + engine 判别字段）。上面两套实现共用
//     同一批面板 / 航线面板 / 鹰眼图，换后端时调用方代码不必改。
// ──────────────────────────────────────────────────────────────────────────
export * from './drone-camera/drone-engine'

// ──────────────────────────────────────────────────────────────────────────
// 4. 交互层:原生 DOM 控制面板(飞行控制 / 机载视角切换 / 云台 / 拍照 / 录像)
//    同样与框架无关 —— 只用 DOM 与 CSS,Vue / React / 裸页面都能直接挂载
// ──────────────────────────────────────────────────────────────────────────
export * from './drone-camera/drone-panel'

// ──────────────────────────────────────────────────────────────────────────
// 5. 航线规划层:原生 DOM 航线面板(执行 / 参数 / 航点列表 / 场景内编辑)
//    与 drone-panel 同一套范式,同样与框架无关
// ──────────────────────────────────────────────────────────────────────────
export * from './drone-camera/mission-panel'

// ──────────────────────────────────────────────────────────────────────────
// 6. 态势显示层:原生 DOM + Canvas 2D 鹰眼图(俯视小地图)
//    只读 fly.sim 真值自行投影,不碰 renderer / 场景 / 相机,故不会混进拍照与录像的成片;
//    自带 requestAnimationFrame 刷新(与面板的 200ms 轮询是两套节奏)
// ──────────────────────────────────────────────────────────────────────────
export * from './drone-camera/drone-minimap'

// ──────────────────────────────────────────────────────────────────────────
// 7. 影像采集层(方案 V1「阶段 1」):影像数据契约 + 采集会话 + 影像集
//     · drone-exif     —— 零依赖 JPEG EXIF / GPS 解析(真实照片导入用)
//     · drone-capture  —— CapturedImage / CameraPose / CameraIntrinsics / CaptureService
//                         虚拟采集(手动 + 定时/定距自动)与真实照片导入共用一套数据结构
//     · drone-capture-panel —— 原生 DOM 采集面板(会话 / 采集 / 导入 / 导出;影像浏览与合成在
//                             影像集弹窗里,面板只留入口按钮)
//     · drone-gallery      —— 影像集弹窗(住 body 上):按「组合」分组浏览,全景组可一键合成,
//                             点缩略图开大图、点合成结果开球面环视;键盘走捕获阶段,
//                             弹窗开着时不会顺带把无人机飞出去
//     · drone-panorama-viewer —— 球面全景查看器(手写 WebGL,零依赖):把合成出的等距柱状图
//                             **贴回球面**拖动环视 —— 2:1 长条仍是存储格式,这里才是观看方式
//     · drone-image-viewer —— 影像大图弹窗(翻页 / 下载 / 元数据;被影像集弹窗复用)
//     · drone-image-utils  —— 影像文案 / 分组 / DOM 小工具(面板与两个弹窗共用,免得文案漂移)
//     · drone-panorama —— 全景拍摄(广角 = 9 张 / 180° = 21 张 / 球形 360° 张数按垂直视场动态计算):**机体原地自转**补水平视野、
//                         云台做俯仰分层并补天顶/天底(云台 Pan 仅 ±30°),逐张带全景元数据入库;
//                         拼接由宿主注入 PanoramaStitcher(库内自带等距柱状实现,见 drone-stitch)
//     · drone-stitch   —— 库内默认全景拼接器:**按已知取景位姿反投影**成一张等距柱状全景图,
//                         不需要特征匹配 / SfM / OpenCV(位姿是这条采集链路的免费红利)
//    虚拟影像的取景帧与相机状态由渲染后端提供(DroneFly / CesiumDroneAdapter 都实现了
//    VirtualCaptureProvider),采集服务自己不建第二个 Viewer。
// ──────────────────────────────────────────────────────────────────────────
export * from './drone-camera/drone-exif'
export * from './drone-camera/drone-capture'
export * from './drone-camera/drone-capture-manifest'
export * from './drone-camera/drone-capture-panel'
export * from './drone-camera/drone-gallery'
export * from './drone-camera/drone-image-utils'
export * from './drone-camera/drone-image-viewer'
export * from './drone-camera/drone-panorama-viewer'
export * from './drone-camera/drone-panorama'
export * from './drone-camera/drone-stitch'
export * from './drone-camera/drone-photogrammetry'
export * from './drone-camera/drone-reconstruction-preview'
