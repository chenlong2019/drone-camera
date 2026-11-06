# 可恢复的采集 Agent（V1）

输入一份结构化拍摄任务，自动执行 **检查计划 → 起飞 → 航点飞行 → 转向/云台对准 → 拍照 → 质量检查 → 文件落盘 → 汇总校验 → COLMAP 打包**。每张有效影像保存独立回执；重新启动 Node 或 Chromium 后可以继续未完成的拍点。

本版是确定性工具执行 Agent，不需要大模型或 API Key。自然语言规划可以在后续通过 MCP 接入；已有飞行、相机、校验和导出逻辑继续来自 drone-camera。当前仅支持内置仿真 city 场景，使用程序化 husky 机体和 WebGL，不连接 MAVLink/真机、不依赖远程 HDRI。

## 运行

要求 Node 22.22.2+（22 系列）或 24.15+，按仓库锁文件安装依赖：

```powershell
cd D:\project\drone-camera
npm ci
npx playwright install chromium

# 保存计划，不启动浏览器。同 ID 已存在会拒绝覆盖。
npm run agent -- prepare agent/examples/city-capture.json

# 演示中断：采一张后保存检查点，关闭浏览器和开发服务器。
npm run agent -- run city-capture-demo --max-shots 1
npm run agent -- status city-capture-demo

# 新进程、新浏览器继续剩余拍点。
npm run agent -- resume city-capture-demo
npm run agent -- validate city-capture-demo
```

直接使用 `node agent/cli.mjs ...` 时，stdout 最后一行是机器可读 JSON，进度写 stderr，失败退出码为 1。

无需分批时使用 `run <taskId>`。另一个终端运行 `pause <taskId>` 请求暂停；Ctrl+C 同样请求暂停，在当前拍点完成后生效。单个飞行步骤有超时，失败不会无限等待。`resume` 与 `run` 等价，均从磁盘回执恢复。任务已经完成时不会重新飞行，会核对文件并重新生成汇总产物。

## 输入约定

示例任务见 `examples/city-capture.json`。`shots` 是拍摄计划，不是任意命令或任意脚本：

- `schemaVersion: 1`，`sceneId: three-demo-city-webgl-husky-v1`。
- `taskId` 与每个拍点 `id` 使用字母、数字、下划线、连字符，长度 1–80。
- `positionEnu` 是**机体位置** `[东, 北, 上]`，单位米，相对于固定演示场景；相机光心由渲染器实际测量。
- 水平范围 ±100 米，高度 1–100 米；航向 0–360°，0° 朝北；俯仰 −90–60°。
- `maxAttempts` 为每次运行、每个未完成拍点的最多尝试次数，1–3，默认 2。历次尝试次数写入检查点。
- 两个至 200 个拍点；本示例三张图用于验证恢复流程，不代表满足大场景重建覆盖率。

航点通过 `setMission/startMission` 飞过去，观察到到位与悬停后才拍照。不会用计划坐标冒充相机位姿。

## 数据与恢复语义

```text
agent-runs/<taskId>/
  checkpoint.json          固定计划、场景指纹、状态、累计尝试和完成项
  events.jsonl             每步事件、失败原因和重试
  receipts/<shotId>.json   成功回执：相机内外参、图像 SHA-256、观测状态
  images/<shotId>.png      原始 PNG，图像提交先于回执
  manifest.json            原图目录对应的完整清单
  validation.json          全量数据校验结果
  capture-colmap.zip       复用现有 buildCaptureBundle 生成的自包含数据包
```

状态：`prepared → running → paused / failed / completed`。`paused`、`failed` 或崩溃遗留的 `running` 都可恢复。

图片和回执使用临时文件、文件同步和重命名保存。已提交回执是恢复依据：即使主检查点落后，仍可发现那张有效图片；缺失或 SHA-256 不匹配的图片会重新采集。它保证已提交文件可复用，不保证断电发生在快门与落盘之间时不会再拍一次。旧进程存活时任务锁拒绝第二个执行者；崩溃后会回收死亡进程的锁。

恢复时比较固定场景和相机源码指纹，源码变化会拒绝混采，需创建新 ID。图片尺寸、内参、相机姿态来自新版 `PhotoShot.camera` 的同帧快照。`receipts` 里的仿真累计时长是本次浏览器会话的观察值，跨重启会归零，不当作连续全局时间。

质量检查包含 PNG 解码、实际尺寸、亮度方差、空白图、文件哈希、重复内容/位姿、内参一致性、拍点实际到位和全量完成数。质量失败会有限重试，耗尽后保留数据并标记 failed，不会伪造完成。V1 不做语义缺陷识别、模糊图评分或自动规划新视角补洞。

ZIP 内的图片由现有打包器统一重命名，内部 manifest 与 images.txt 使用相同路径。`points3D.txt` 暂为空：这是带已知相机位姿的采集包，后续需要特征匹配、三角化才能提供 3DGS 初始化点云。

任务产物不提交 Git。原始回执能追溯计划拍点与相机数据；任务报告保留失败原因。共享 PG/对象存储和 neural-render-service 接入是独立的后续适配器，本版先验证本地恢复闭环。

## MCP

已有 `mcp/drone-mcp-server.mjs` 增加以下工具；手动无人机工具仍可用：

| 工具 | 入参 | 结果 |
|---|---|---|
| `agent_prepare` | 完整任务 JSON | 保存计划并返回 taskId |
| `agent_run` | taskId、maxShots（默认 1，上限 20） | 执行/恢复一批，返回 paused/completed 与进度 |
| `agent_status` | taskId | 磁盘检查点和产物地址 |
| `agent_pause` | taskId | 请求在当前拍点后暂停 |
| `agent_validate` | taskId | 全量文件和元数据校验 |

推荐调用：prepare → run → status → 重复 run 直到 completed → validate。run 出错后先读 status，确认失败原因后再 resume；同一 MCP 进程一次执行一个采集任务。Agent 使用独立浏览器，与手动 `drone_*` 命令的飞行状态隔离。MCP 客户端的工具调用超时应设为至少 180 秒，较慢的软件渲染环境建议 300 秒。

完整能力盘点见 [TOOLS.md](TOOLS.md)。

## 验证

```powershell
npm run agent:test    # 文件损坏、重试耗尽、暂停、恢复、场景变化、并发锁
npm run agent:verify  # 真实 Chromium，两次独立进程运行：1 张暂停 → 2 张恢复
npm run type-check
npm run build
```

`agent:verify` 使用新的任务 ID，产物与 restart-verification.json 写入 agent-runs。测试真实照片解码与位姿，不用 PNG 文件头冒充完整图片。
