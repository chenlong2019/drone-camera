# drone-camera 无头模式 / MCP

把无人机控制系统(飞行 + 采集 + 全景 + 球面查看)变成 **AI 可直接调用** 的能力。
与 Blender 同构:`blender --background --python script.py` 在这里是
`node mcp/drone-cli.mjs run task.json`;AI 客户端则通过 MCP 协议调用同名工具。

```
┌──────────────────────────── 调用方 ────────────────────────────┐
│  AI 客户端(WorkBuddy / Claude Desktop ...)   shell / 脚本      │
│       │  MCP over stdio (JSON-RPC)              │ argv        │
│       ▼                                         ▼            │
│  mcp/drone-mcp-server.mjs              mcp/drone-cli.mjs      │
│       └──────────────┬───────────────────────┘                │
│                      ▼                                        │
│           mcp/headless-driver.mjs  (命令串行 + 空闲回收)        │
│                      │ page.evaluate(调库 API)                 │
│                      ▼                                        │
│      vite dev server + chromium(无头渲染器,软件 GL)            │
│                      │                                         │
│                      ▼                                         │
│   three-demo demo 页 = window.__droneDemo(DroneFly/采集/查看器) │
└────────────────────────────────────────────────────────────────┘
```

**为什么用 Chromium 当"无头渲染器"而不是 headless-gl**:three + WebGL + GLTF +
canvas 2D 整条渲染栈跑在浏览器里最保真,且 `tmp-shots/verify-*.mjs` 已验证这条路稳定。
驱动按需拉起 vite + chromium,**空闲 10 分钟自动回收**,对调用方表现得像一个本地服务。
渲染监听 `127.0.0.1` 随机端口,不对外暴露。

## 1. 给 AI 用(MCP)

前置:克隆本仓库并装好依赖(驱动会按需拉起 vite + chromium,首次需下载浏览器)。

```bash
git clone https://github.com/chenlong2019/drone-camera && cd drone-camera
npm install
npx playwright install chromium
```

然后在 MCP 客户端配置里加一段(路径换成你本机的仓库绝对路径):

```json
{
  "mcpServers": {
    "drone-camera": {
      "command": "node",
      "args": ["/absolute/path/to/drone-camera/mcp/drone-mcp-server.mjs"]
    }
  }
}
```

配好后 AI 侧会出现 14 个 `drone_*` 工具,典型流程:

```
drone_takeoff → drone_panorama(mode=pano-360) → drone_viewer_shot(file, yaw, pitch, fov) 自查 → drone_land
```

`drone_screenshot` / `drone_viewer_shot` 会以 **image content** 直接把画面回给 AI,
AI 能"看到"渲染结果并据此决策(这就是给 AI 的验收环)。

## 2. 给脚本用(CLI)

```bash
node mcp/drone-cli.mjs state                          # 当前真值(单行 JSON 到 stdout)
node mcp/drone-cli.mjs takeoff                        # 自动开机展臂起飞
node mcp/drone-cli.mjs spin_to --heading 90           # 机身转到 90°
node mcp/drone-cli.mjs capture_photo --pitch -20      # 单拍
node mcp/drone-cli.mjs panorama --mode pano-360       # 拍全景 + 拼接,落盘 PNG
node mcp/drone-cli.mjs screenshot --mode fpv          # 当前画面截图
node mcp/drone-cli.mjs viewer_shot --file xx.png --yaw 120 --pitch -10 --fov 90
node mcp/drone-cli.mjs sessions                       # 采集会话列表
node mcp/drone-cli.mjs session_export --id <会话id> --format json
node mcp/drone-cli.mjs shutdown                       # 手动关掉后台渲染进程
```

批处理(Blender 式 task.json):

```json
{
  "steps": [
    { "cmd": "takeoff" },
    { "cmd": "panorama", "mode": "pano-360" },
    { "cmd": "viewer_shot", "file": "<上一步返回的 file>", "yaw": 90, "pitch": -10, "name": "check-east" },
    { "cmd": "land" }
  ]
}
```

```bash
node mcp/drone-cli.mjs run task.json
```

每步结果与 `report-<时间戳>.json` 一起落在 `tmp-shots/mcp-out/`(已被 .gitignore)。
任何一步失败即中止后续步骤。所有命令都是单行 JSON 输出,日志走 stderr。

## 3. 命令表(CLI 与 MCP 同名,CLI 用下划线形式)

| 命令 / 工具 | 作用 |
|---|---|
| `state` | 飞行阶段/位置/航向/云台/电量/张数/视角/障碍数/会话数 |
| `takeoff` | 自动开机 + 展臂 + 起飞悬停(已飞则直接返回状态) |
| `land` / `return_home` | 降落 / 返航 |
| `spin_to {heading}` | 机身原地转到指定航向(全景水平覆盖靠它) |
| `camera_mode {mode}` | orbit / follow / fpv |
| `capture_photo {pitch?}` | 单拍一张,落盘 + 位姿元数据 |
| `panorama {mode,shotIntervalMs}` | 全景拍摄 + 等距柱状拼接(3600×1800,2:1) |
| `screenshot {mode?,name?}` | 三维画面截图(MCP 下直接回图) |
| `viewer_shot {file,yaw,pitch,fov}` | 球面查看器指定角度取景截图(MCP 下直接回图) |
| `sessions` / `session_export` / `session_photos` | 会话列表 / 元数据导出 / 照片批量落盘 |
| `shutdown` | 关闭后台渲染进程 |

## 4. 设计约定

- **串行**:所有命令排队执行(渲染后端是单页单例,并发会互相踩)。
- **按需启动**:第一条命令才拉 vite + chromium;空闲 10 分钟自动回收;`shutdown` 手动关。
- **零新依赖**:只用项目已有的 `@playwright/test`;Chromium 自动在
  `ms-playwright` 里找最新构建(playwright 升级后自愈),也可用环境变量
  `DRONE_MCP_CHROME` 指定可执行文件。
- **库零改动**:驱动只通过 demo 页的公开 API(`window.__droneDemo`)与库交互。
- **无头边界**:目前驱动的是 demo 沙盒(哈士奇机体 + 布景),不含真机链路;
  真实照片导入请走采集面板 UI(或后续加命令)。

## 5. 文件

| 文件 | 职责 |
|---|---|
| `mcp/headless-driver.mjs` | 无头驱动:进程管理 + 命令表 + 产物落盘 |
| `mcp/drone-cli.mjs` | Blender 式 CLI(单命令 + `run task.json` 批处理) |
| `mcp/drone-mcp-server.mjs` | MCP stdio 服务(手写 JSON-RPC,无 SDK 依赖) |
| `tmp-shots/probe-mcp-server.mjs` | MCP 握手 + 工具调用端到端测试 |
