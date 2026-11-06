# 工具与能力盘点

基线：远程 main 的 `74b6465`，在其上新增采集 Agent。这里区分已经注册的工具与仅存在于库里的能力，避免把源码导出当成可直接调用的服务。

| 能力 | 当前入口 | 接入情况 |
|---|---|---|
| 状态读取 | `drone_state` / CLI `state` | 已有 MCP；读取内置仿真状态 |
| 起降、返航 | `drone_takeoff`、`drone_land`、`drone_return_home` | 已有 MCP；返航工具只下发命令，不表示已返航完成 |
| 机体转向 | `drone_spin_to` | 已有 MCP；等待航向到位 |
| 观察视角 | `drone_camera_mode` | 已有 MCP；orbit/follow/fpv |
| 单拍、全景 | `drone_capture_photo`、`drone_panorama` | 已有 MCP；Agent 的数据集路径另用同帧内外参版本 |
| 截图、全景查看 | `drone_screenshot`、`drone_viewer_shot` | 已有 MCP，返回图片 |
| 采集会话导出 | `drone_sessions`、`drone_session_export`、`drone_session_photos` | 已有 MCP；浏览器内存会话本身不跨进程保存 |
| 关闭手动会话 | `drone_shutdown` | 已有 MCP |
| 可恢复任务 | `agent_prepare/run/status/pause/validate` | 本次新增 MCP + CLI；磁盘检查点与逐张回执 |
| 平台任务执行 | `npm run agent:worker -- --url http://127.0.0.1:8090` | HTTP 主动领取、心跳、逐张登记和断点续传；独立 CLI，未额外注册 MCP 名称 |
| 航点执行 | `DroneFly.setMission/startMission/getMissionSnapshot` | 已有库 API；Agent 内部调用并检查到位 |
| 网格/环绕规划 | `planObliqueSurvey`、`planReconCapture` | 已有库 API；V1 Agent 接收显式拍点，尚未自动调用规划器 |
| 数据清单校验 | `buildCaptureManifest`、`validateCaptureManifest` | 已有库 API；Agent 直接复用 |
| COLMAP 采集包 | `buildCaptureBundle`、`exportColmapDataset` | 已有库 API/脚本；Agent 完成时复用 |
| WebRTC 图传 | `VideoDownlink.enableWebRtc`、`DroneFly.createVideoStream` | 已有演示 UI/库 API；未注册为 Agent 工具 |
| 信令和兼容视频链路 | `node video-link/relay.mjs`，观看页 `video-link/watch.html` | WebSocket 信令，WebRTC 点对点媒体；JPEG over WebSocket 可并行兜底 |
| MAVLink | `FlightSourceManager`、`mavlink/bridge.mjs` | 已有库/服务；采集 Agent V1 拒绝外部飞控 |
| Splat | `drone-splat.ts`、`drone-splat-viewer.ts`、重建源适配器 | 已有编码/查看等代码；此 Agent 不将其宣称为已部署 GPU 训练服务 |

CLI 单条 `drone-cli` 命令结束会关闭自己的浏览器；连续手动操作应放入原有 `run task.json` 批处理或使用 MCP 长进程。新的 Agent 恢复以磁盘图片回执为准，因此可跨 CLI 进程继续。

代码边界：`task.mjs` 校验结构化任务；`simulation-tools.mjs` 负责浏览器与现有业务 API；`runtime.mjs` 管理持久化、重试、质量门槛和导出；`tools.mjs` 注册 MCP；`cli.mjs` 提供终端入口。大模型将来只负责产生受约束计划和选择工具，不接管逐帧飞控。
