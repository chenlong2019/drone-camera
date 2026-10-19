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

有 NVIDIA GPU 时追加 `-UseGpu`：

```bat
scripts\run-colmap-reconstruction.bat "C:\Users\11746\Downloads" -UseGpu
```

## 2. 运行 COLMAP

安装 COLMAP，并确认命令行可用：

```powershell
colmap -h
```

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
  sparse/0/                 # 相机、图像和稀疏点
  dense/                    # 去畸变和深度图
  dense/fused.ply           # 稠密点云
  mesh/poisson.ply         # Poisson 网格
  reconstruction-report.json
```

脚本默认关闭 CUDA SIFT，便于在没有 NVIDIA GPU 的机器上运行；有 GPU 时可以传 `-UseGpu`。影像少于三张、注册图像数过低或 COLMAP 阶段失败时，脚本会停止并保留日志。

## 3. 检查重建结果

先用 CloudCompare 或 MeshLab 打开 `dense/fused.ply` 和 `mesh/poisson.ply`，检查注册图像数、点云空洞、网格破面和比例。`validation-report.json` 的 `captureStatus: passed` 只说明采集数据通过检查，不等于 SfM/MVS 已成功。

COLMAP 的 `images.txt` 使用世界到相机的 `qvec [w,x,y,z]` 和 `tvec`。验证页 manifest 使用相机到世界的 `[x,y,z,w]`，并以 ECEF 保存位置；不要把 manifest 的位置直接写成 COLMAP 的 `tvec`。若需要把外部 GNSS/ENU 位姿作为先验使用，应在独立脚本中完成 ECEF→ENU 和坐标对齐，再导入 COLMAP。

## 4. 发布为 3D Tiles

COLMAP 输出的 PLY 网格不是 3D Tiles。需要使用项目选定的转换器（例如 `py3dtiles`，或 Cesium ion/企业内部 tiler）生成 `tileset.json` 及其内容文件，并通过 HTTP(S) 提供。将最终 `tileset.json` 的 URL 填回验证页的“Tiles 图层”输入框进行回载和人工验收。

页面内置的 `/validation/tileset.json` 是合成加载样例，不是上述照片的重建结果。
