# 下载数据后的离线重建

验证页只负责采集、检查和导出数据，不会在浏览器里运行 COLMAP、SfM 或 MVS。下载完成后，需要在安装了 COLMAP 的 Windows 机器上执行离线流程。

## 1. 整理下载文件

验证页的三个下载项分别是：

- `images.zip`：原始 PNG/JPEG 影像；
- `manifest.json`：相机内参、姿态和 ENU 坐标原点；
- `validation-report.json`：采集质量和验证结果。

把它们整理成下面的目录。`manifest.json` 中的 `images/<file>` 路径必须能从该目录解析到实际文件。

```text
capture-directory/
  manifest.json
  validation-report.json
  images/
    capture-000.png
    capture-001.png
    ...
```

PowerShell 示例：

```powershell
$capture = 'D:\photogrammetry\capture-20261019'
New-Item -ItemType Directory -Force "$capture\images" | Out-Null
Expand-Archive '.\images.zip' "$capture\images" -Force
Copy-Item '.\manifest.json' "$capture\manifest.json"
Copy-Item '.\validation-report.json' "$capture\validation-report.json"
```

如果 ZIP 解压后多了一层 `images\images`，把内层文件移到 `capture-directory\images`。不要改文件名或手动修改 manifest。

上面的命令是 Windows PowerShell。如果使用 `cmd.exe`，可以这样执行：

```bat
set "CAPTURE=D:\photogrammetry\capture-20261019"
mkdir "%CAPTURE%\images"
powershell.exe -NoProfile -Command "Expand-Archive -LiteralPath '.\images.zip' -DestinationPath '%CAPTURE%\images' -Force"
copy /Y manifest.json "%CAPTURE%\manifest.json"
copy /Y validation-report.json "%CAPTURE%\validation-report.json"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\run-colmap-reconstruction.ps1" -CaptureDir "%CAPTURE%" -OutputDir "%CAPTURE%\reconstruction"
```

如果 `colmap.exe` 没有加入 PATH，在最后一条命令追加：

```bat
-ColmapExe "C:\Program Files\COLMAP\bin\colmap.exe"
```

如果不想处理 PowerShell 文件关联，也可以直接双击 `scripts\run-colmap-reconstruction.bat`。它默认使用当前 Windows 用户的 `Downloads` 目录；也可以在 `cmd.exe` 中指定目录：

```bat
scripts\run-colmap-reconstruction.bat "C:\Users\11746\Downloads"
```

已安装兼容显卡的 GPU 版 COLMAP 时，可追加 `-UseGpu` 加速 SIFT 特征提取和匹配：

```bat
scripts\run-colmap-reconstruction.bat "C:\Users\11746\Downloads" -UseGpu
```

## 2. 运行 COLMAP

安装 COLMAP，并确认命令行可用：

```powershell
colmap -h
```

完整流程中的 `patch_match_stereo` 需要启用 CUDA/HIP 的 COLMAP 构建及兼容显卡。若帮助横幅显示 `without GPU support`，该安装可以执行 CPU 稀疏重建，但不能执行这里的稠密重建。`-UseGpu` 只控制 SIFT，不会让 CPU 构建获得稠密重建能力；即使不加这个参数，稠密阶段仍需要 GPU。

例如，GTX 1080 Ti 属于 Pascal 架构，需选择包含 Pascal 支持的 CUDA 12 版 COLMAP 构建，并使用兼容驱动；仅安装 CUDA Toolkit 不会改变现有 COLMAP 可执行文件的编译能力，也不能直接换成不支持 Pascal 的 CUDA 13 构建。

可考虑官方 [COLMAP 4.0.4 Windows CUDA 安装包](https://github.com/colmap/colmap/releases/download/4.0.4/colmap-x64-windows-cuda.zip)。其官方构建 workflow 使用 CUDA 12.9.1 和 `all-major` 架构设置，覆盖 Pascal；该候选尚未在本机实测。官方 4.1.1/4.2.x 的 CUDA 包使用 CUDA 13.2，不适合 GTX 1080 Ti。下载解压后应确认运行的是新包中的 `colmap.exe`，并再次检查 `colmap -h` 的构建横幅。

仓库提供了一个只负责调用 COLMAP 的最小脚本。它会读取 manifest 的 PINHOLE 内参，执行特征提取、匹配、稀疏 SfM、去畸变、稠密深度和 Poisson 网格。脚本不会修改原始影像或 manifest，也不会伪造 3D Tiles。

```powershell
.\scripts\run-colmap-reconstruction.ps1 `
  -CaptureDir $capture `
  -OutputDir "$capture\reconstruction"
```

如未把 `colmap.exe` 放进 `PATH`，传入完整路径：

```powershell
.\scripts\run-colmap-reconstruction.ps1 `
  -CaptureDir $capture `
  -OutputDir "$capture\reconstruction" `
  -ColmapExe 'C:\Program Files\COLMAP\bin\colmap.exe'
```

输出目录大致如下：

```text
reconstruction/
  database.db
  sparse/<model-id>/        # 相机、图像和稀疏点，可能有多个模型
  dense/                   # 去畸变和深度图
  dense/fused.ply           # 稠密点云
  mesh/poisson.ply          # Poisson 网格
  reconstruction-report.json
  reconstruction.log
```

脚本先检查 COLMAP 构建能力，再探测各版本的 SIFT GPU 参数。若检测到不支持 GPU，会在 `environment` 阶段停止并保留已有数据库、稀疏模型、稠密模型和网格。通过这些检查后，脚本会清理本次输出目录中的旧 `database.db`、`sparse/`、`dense/` 和 `mesh/`，再重新计算。日志和报告记录本次运行；需要保留旧运行时，应先备份或换一个输出目录。

对于这个低纹理、以平面立面为主的验证场景，脚本会放宽 mapper 的初始化阈值。从多个稀疏模型中选择时，脚本读取 `points3D.bin` 和 `images.bin` 开头 8 字节的小端无符号整数，得到实际点数和注册图像数，优先选择点数最多的模型，点数相同时选注册图像较多的模型。文件大小受观测和轨迹记录影响，不能代替实际计数。

进入 MVS 前，脚本默认要求至少 6 张注册图像和 100 个稀疏点。这是本项目用于筛出过小模型的经验门槛，不是 COLMAP 的硬性要求，也不保证达到门槛后就能重建成功。可用 PowerShell 参数 `-MinRegisteredImages` 和 `-MinSparsePoints` 调整；诊断时可加 `-AllowSmallSparseModel` 跳过此质量检查，但它不能绕过 GPU 能力检查。质量检查未通过时，会保留本次生成的 `sparse/`。

`reconstruction.log` 保存各次 COLMAP 调用、标准输出、标准错误和退出码；`reconstruction-report.json` 记录失败阶段、版本、GPU 构建标记及选中模型的计数。启动器报 `Reconstruction failed` 时，应先查看这两个文件。

### 本次失败的两个独立问题

此前 COLMAP 4.2.1 的横幅明确显示 `without GPU support`，这是本次 dense 失败首先需要修复的能力问题。Windows 退出码 `-1073740791`（`0xC0000409`）表示原生进程快速失败；单凭这个数字不能断言崩溃是稀疏点太少导致的。更换模型目录、降低质量门槛或追加 `-UseGpu` 都不能修复缺失的 GPU 后端。

另外，当前 8 张验证影像形成了两个互不连通的小模型，较大模型约有 4 张注册图像、33 个点。它们可以验证截图和相机参数链路，但不足以证明能完成可靠重建。修复 COLMAP 安装后，仍需增加有连续共同视野的照片和非重复纹理；可从 24～40 个连续机位开始，保持相邻视角高重叠，并包含不同高度和非共面的表面。照片数量本身不是成功保证。

## 3. 检查重建结果

先用 CloudCompare 或 MeshLab 打开 `dense/fused.ply` 和 `mesh/poisson.ply`，检查注册图像数、点云空洞、网格破面和比例。`validation-report.json` 的 `captureStatus: passed` 只说明采集数据通过检查，不等于 SfM/MVS 已成功。

COLMAP 的 `images.txt` 使用世界到相机的 `qvec [w,x,y,z]` 和 `tvec`。验证页 manifest 使用相机到世界的 `[x,y,z,w]`，并以 ECEF 保存位置；不要把 manifest 的位置直接写成 COLMAP 的 `tvec`。若需要把外部 GNSS/ENU 位姿作为先验使用，应在独立脚本中完成 ECEF→ENU 和坐标对齐，再导入 COLMAP。

## 4. 发布为 3D Tiles

COLMAP 输出的 PLY 网格不是 3D Tiles。需要使用项目选定的转换器（例如 `py3dtiles`，或 Cesium ion/企业内部 tiler）生成 `tileset.json` 及其内容文件，并通过 HTTP(S) 提供。将最终 `tileset.json` 的 URL 填回验证页的“Tiles 图层”输入框进行回载和人工验收。

页面内置的 `/validation/tileset.json` 是合成加载样例，不是上述照片的重建结果。
