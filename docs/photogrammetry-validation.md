# 摄影测量验证页

验证页位于 `/photogrammetry-validation`，用于检查 lib 的真实 Cesium 截图、同帧相机参数、坐标转换、Manifest 导出和 3D Tiles 回载。页面没有运行 COLMAP、SfM 或 MVS；采集检查通过、样例 Tiles 加载成功，都不能证明端到端摄影测量重建已经完成。

## 启动与采集

在项目根目录运行：

```powershell
npm install
npm run dev
```

打开终端给出的本地地址并进入 `/photogrammetry-validation`，然后依次操作：

1. 点击“初始化验证场景”，等待“场景就绪”。
2. 点击“采集 8 个机位”，等待影像数量达到 8。也可用“采集下一机位”逐张检查。
3. 点击“校验采集”，检查“采集检查通过”和逐张同帧检查结果。
4. 选择缩略图，核对照片、位姿、内参、COLMAP 参数及目标投影。
5. 下载 Manifest、原图 ZIP 和验证报告。

场景使用项目内的 `/Cesium/Cesium.js`、本地机体模型、椭球地形和程序生成的建筑，无需 Cesium Ion Token 或在线底图。固定 ENU 原点为经度 `116.391°`、纬度 `39.906°`、高程 `0 m`。

采集通过 `CesiumDroneAdapter.requestPhoto()` 和 `CaptureService` 完成，输出真实 PNG。8 个机位绕建筑分布，半径约 `40 m`，方位间隔 `45°`，模拟高度在 `24 m` 与 `34 m` 间交替。相机朝向建筑中心附近。页面使用 `960 × 540` 采集画布；缩小页面显示区域不会改变导出的采集分辨率。

固定机位验证不执行航线飞行。批量采集会清空当前会话的影像和检查结果；“完成当前帧后停止”会保留已经完成的照片。继续逐张采集超过 8 张会再次使用先前机位，重复检查可能因此失败。

## 同帧与坐标检查

验证代码在 Cesium `postRender` 回调中独立拷贝画布并编码 PNG，将结果与适配器返回的 PNG data URL 完整匹配。相机参考值从同一渲染帧读取：位置使用 `positionWC`，四元数从 `inverseViewMatrix` 提取，内参从投影矩阵与实际画布尺寸计算。参考四元数不调用 lib 的相机基向量转换函数。

每张照片的 `frameAudits` 必须满足以下条件，才会标记 `passed: true`：

| 项目 | 通过条件 |
| --- | --- |
| `pixelsMatch` | 返回 PNG 与独立拷屏 PNG 完全一致 |
| `positionErrorMeters` | 位置欧氏距离误差 `< 1e-6 m` |
| `rotationErrorDegrees` | 旋转角误差 `< 1e-4°`，等价的正负四元数视为同一姿态 |
| `intrinsicsErrorPixels` | `fx/fy/cx/cy/width/height` 最大绝对差 `< 1e-6` |
| `observerRestored` | 拍照前后观察视角的位置误差 `< 1e-6 m`、旋转误差 `< 1e-4°` |
| `enuRoundTripErrorMeters` | ECEF→ENU→ECEF 往返误差 `< 1e-6 m` |
| `targetPixel` | 已知目标 ENU `[0, 0, 8]` 在相机前方，投影位于影像范围内 |
| `targetProjectionErrorPixels` | COLMAP 投影与 Cesium view/projection 矩阵独立投影的距离 `< 1e-4 px` |

Manifest 保存的姿态是相机到世界的四元数，顺序为 `[x,y,z,w]`，相机轴为右 `+X`、上 `+Y`、前 `-Z`。页面显示的 COLMAP `qvec` 则为世界到相机旋转，顺序为 `[w,x,y,z]`；`tvec = -Rcw * C`。不要把 Manifest 的相机中心直接作为 COLMAP 平移。

Manifest 的 ECEF→ENU 变换同时提供平移、旋转、缩放和行主序矩阵；两种表达表示同一个变换：`target = rotation * (scale * source) + translation`。

这些检查覆盖固定机位下的截图与参数一致性，以及已知目标的投影方向。它们不评估特征匹配率、影像重叠是否充足、重建精度或多视图三角化结果。

## 图像质量检查

“校验采集”会实际读取并解码每张 PNG，读取真实宽高，再使用 Canvas 进行像素采样。采样图最长边不超过 `256` 像素，采用最近邻采样；亮度统计只使用 alpha 大于等于 `250` 的像素。

检查包括：

- 文件非空、能够解码，实际宽高与相机内参一致。
- 有效像素占比至少 `95%`；报告同时保留透明像素占比。
- 亮度方差不大于 `1` 视为均匀图；均匀图平均亮度不大于 `1` 或不小于 `254` 时，标记为近似纯黑或纯白。
- Manifest 的时间、MIME、位姿、内参、尺寸、重复文件、重复内容标识和重复位姿检查。

采样检查适合发现空白图、均匀图、解码失败等问题，不替代逐像素检查或摄影测量影像质量评估。每次新增照片后，先前的质量检查会失效，需要重新点击“校验采集”。

## 导出文件与报告

建议校验后再导出，以便 Manifest 包含本次解码质量结果。`images.zip` 内存放原始文件名的照片，将 ZIP 内容解压到 `images/`；把 `manifest.json` 放在该目录的同级：

```text
capture-directory/
  manifest.json
  validation-report.json
  images/
    <原始照片文件名>.png
    ...
```

Manifest 中每个 `images[].file` 都应能从 `capture-directory/` 解析到实际文件，例如 `images/<原始照片文件名>.png`。不要再额外套一层 `images/images/`，也不要手动改名后继续使用旧 Manifest。

`validation-report.json` 主要字段如下：

| 字段 | 含义 |
| --- | --- |
| `captureId`、`generatedAt` | 采集会话标识与报告生成时间 |
| `captureStatus` | 未执行校验为 `not-run`；采集、图像和同帧检查全部通过为 `passed`，否则为 `failed` |
| `reconstructionStatus` | 当前始终为 `not-run`，表示页面没有执行离线重建 |
| `captureValidation` | Manifest 校验结果、错误和警告；未校验时为 `null` |
| `imageQuality` | 逐张图像解码、尺寸、采样与亮度统计 |
| `frameAudits` | 逐张同帧检查、误差、目标投影与是否通过 |
| `task` | `createReconstructionTask` 生成的建议路径和初始任务信息；不会创建目录或启动重建程序 |
| `tiles` | 已加载地址、是否为样例、结构检查、可见瓦片状态和加载错误 |
| `tiles.lastLoadAttempt` | 最近一次加载请求的 URL、状态及错误；替换失败时仍保留该失败记录，与现有已加载图层区分 |
| `tiles.visualAcceptance` | 当前为 `not-reviewed`，表示位置、尺度、几何和纹理还需要人工验收 |

`not-run` 和 `not-reviewed` 是未执行状态，不表示通过。即使 `captureValidation.valid` 为 `true`，还应检查整体 `captureStatus` 和每个 `frameAudits[].passed`。

下载后的离线重建请参阅[下载数据后的离线重建](./photogrammetry-reconstruction.md)。页面本身不会运行 COLMAP、SfM 或 MVS。

## 使用 COLMAP 离线重建

验证页只负责采集和导出，不会在浏览器中运行 COLMAP。下面是一套在 Windows PowerShell 中执行的最小流程。先安装与显卡驱动匹配的 [COLMAP](https://colmap.github.io/) 并确认 `colmap` 已在 `PATH` 中，然后将两个下载文件整理为上一节的目录结构。

先从 Manifest 读取相机内参，再提取特征、匹配并进行稀疏重建：

```powershell
$Capture = (Resolve-Path .\capture-directory).Path
$Images = Join-Path $Capture 'images'
$Work = Join-Path $Capture 'reconstruction'
$Database = Join-Path $Work 'database.db'
$Sparse = Join-Path $Work 'sparse'
$Manifest = Get-Content (Join-Path $Capture 'manifest.json') -Raw | ConvertFrom-Json
$Camera = $Manifest.camera

New-Item -ItemType Directory -Force $Work, $Sparse | Out-Null
$CameraParams = @($Camera.fx, $Camera.fy, $Camera.cx, $Camera.cy) | ForEach-Object {
  $_.ToString([Globalization.CultureInfo]::InvariantCulture)
}
$CameraParams = $CameraParams -join ','

colmap feature_extractor `
  --database_path $Database `
  --image_path $Images `
  --ImageReader.camera_model $Camera.model `
  --ImageReader.camera_params $CameraParams `
  --ImageReader.single_camera 1

colmap exhaustive_matcher --database_path $Database

colmap mapper `
  --database_path $Database `
  --image_path $Images `
  --output_path $Sparse
```

当前验证页默认导出 `PINHOLE`，其参数顺序是 `fx,fy,cx,cy`。如果实际 Manifest 的 `camera.model` 是 `OPENCV` 等模型，必须按该模型要求提供畸变参数，不能继续使用上面的四参数字符串。检查 `$Sparse` 下生成的模型目录，并选注册照片数最多的目录（只有一个模型时通常是 `0`）：

```powershell
# mapper 默认写入 cameras.bin、images.bin、points3D.bin；多个模型时用
# `colmap gui --import_path <model>` 或 `colmap model_converter` 检查注册数。
Get-ChildItem $Sparse -Directory | Select-Object Name, FullName
$SparseModel = Join-Path $Sparse '0'
```

如果需要稠密点云和网格，继续执行：

```powershell
$Dense = Join-Path $Work 'dense'
New-Item -ItemType Directory -Force $Dense | Out-Null

colmap image_undistorter `
  --image_path $Images `
  --input_path $SparseModel `
  --output_path $Dense `
  --output_type COLMAP

colmap patch_match_stereo `
  --workspace_path $Dense `
  --workspace_format COLMAP `
  --PatchMatchStereo.geom_consistency true

colmap stereo_fusion `
  --workspace_path $Dense `
  --workspace_format COLMAP `
  --input_type geometric `
  --output_path (Join-Path $Dense 'fused.ply')

colmap poisson_mesher `
  --input_path (Join-Path $Dense 'fused.ply') `
  --output_path (Join-Path $Dense 'meshed-poisson.ply')
```

`fused.ply` 是稠密点云，`meshed-poisson.ply` 是网格；它们还不是 Cesium 3D Tiles。发布到验证页前，需要用项目选定的 Tiles 转换器（或 Cesium ion）生成 `tileset.json`，并通过 HTTP(S) 提供它引用的全部 `.b3dm`、`.glb`、纹理和子 tileset 文件。

### 位姿、坐标和地理配准

上面的 `mapper` 会从图像特征重新估计相机位姿，默认坐标系是任意的 COLMAP 局部坐标系。Manifest 中的 `position` 是 Cesium ECEF 米制坐标，`rotation` 是相机到世界的 `[x,y,z,w]` 四元数；它们不会被 `mapper` 自动读取。需要把重建结果放回地图时，应使用 Manifest 的 ENU 原点和 `coordinateFrame.transform` 将 ECEF 转为本地 ENU，并用控制点或已知相机中心做相似变换（尺度、旋转、平移）后再生成 Tiles。不要把 ECEF 相机中心直接写成 COLMAP `tvec`；COLMAP `images.txt` 使用世界到相机的 `qvec=[w,x,y,z]` 和 `tvec=-R*C`。页面显示的 COLMAP 参数和 `cameraPoseToColmap` helper 可用于核对这个转换，但不会替代对齐工具。

如果只想先得到模型，不要求地理坐标，直接使用 `sparse/0`、`dense` 和网格结果即可。真实重建还应记录注册照片数、匹配质量、点云/网格完整性和纹理质量，并把生成的 Tiles URL 填回验证页人工检查。

## Tiles 回载与人工验收

“加载回载样例”使用 `/validation/tileset.json`。它是程序生成的合成 Tiles，用来检查加载、地理位置及图层显隐，不是从当前照片重建出的成果。

真实成果应通过 HTTP(S) 提供 `tileset.json` 和它引用的所有瓦片、模型、纹理文件。把 URL 填入输入框后点击“加载成果”。同站点路径也可使用，例如 `/outputs/building/tileset.json`。跨域资源的服务器需要允许页面来源访问，且 CORS 必须覆盖 JSON、二进制瓦片、模型和纹理；直接使用 `file://` 地址不受支持。

页面先进行 Tiles JSON 结构检查，再调用 Cesium 加载。只有当前视角实际选中了瓦片内容，且请求的瓦片已加载，才显示“可见瓦片就绪”；空视角不会因为没有待加载请求而被误报为就绪。隐藏 Tiles 时单独显示隐藏状态，瓦片加载失败时展示错误。“可见瓦片就绪”不代表整个数据集的每个瓦片都经过验证，也不代替对实际画面、几何和纹理的验收。

用“原始建筑”“Tiles 图层”“两者叠加”切换显示，至少完成以下人工验收：

1. 检查地理位置、朝向和高度是否正确，建筑是否与原场景对齐。
2. 对照已知建筑尺寸检查尺度，排除轴顺序、单位和地理变换问题。
3. 从多个角度查看屋顶、墙面与边缘，检查缺面、漂浮几何和明显形变。
4. 检查纹理是否出现、是否清晰，有无错贴、接缝或黑块；确认网络面板中引用资源均能成功加载。

真实 Tiles 应已包含正确的地理配准。验证页不会自动对重建模型做尺度拟合、配准或纹理修复；视角默认仍定位到本地测试建筑。

## 自动化验证

安装依赖后先安装 Playwright Chromium，再运行专用浏览器用例：

```powershell
npx playwright install chromium
npx playwright test -c e2e/photogrammetry.config.ts
```

也可指定已有 Chromium/Chrome 可执行文件，省去下载浏览器：

```powershell
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npx playwright test -c e2e/photogrammetry.config.ts
```

配置会启动或复用 `http://127.0.0.1:56801` 的本地 Vite 服务，使用无头 Chromium 和 SwiftShader 运行真实 Cesium。用例检查 8 帧采集、同帧校验、解码质量、Manifest 和报告下载、样例 Tiles 可见瓦片加载、图层切换，以及离开页面后再次进入时的初始化。测试产物写入 `test-results/photogrammetry/`，失败时保留截图和 trace。

浏览器用例通过表示上述页面流程通过。该用例不运行 COLMAP/MVS，不生成真实重建模型，也不对真实重建的配准、几何与纹理质量给出通过结论。
