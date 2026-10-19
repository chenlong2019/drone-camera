# 合成 3D Tiles 回载样例

本目录仅用于验证 Cesium3DTileset 加载、坐标放置、显隐及对比显示。建筑由脚本直接生成，**不是摄影测量重建成果**，不能用于证明重建质量或精度。

开发服务启动后，样例入口为 `/validation/tileset.json`；其唯一内容 `building.gltf` 使用内嵌 base64 buffer，不请求外部模型、贴图或云服务。

- 地理原点：WGS84 经度 `116.391°`、纬度 `39.906°`、椭球高 `0 m`。
- 建筑主体：ENU 东向宽 `18 m`、北向深 `12 m`、高 `16 m`；底面 `z = 0 m`。
- ENU 范围：`[-9, -6, 0]` 至 `[9, 6, 16]`；六面使用不同顶点颜色。
- 3D Tiles 版本：`1.1`。根节点 `transform` 为列主序 ENU → ECEF 矩阵；`boundingVolume.box` 为 ENU 中的中心和三个半轴。
- 顶层 `geometricError = 32 m` 表示省略整个建筑的误差；根叶节点 `geometricError = 0` 表示已有完整网格。不要把顶层也设为零，否则 Cesium 会按屏幕空间误差提前跳过整个 Tileset，出现“无待加载瓦片但建筑不可见”。
- glTF 使用标准 Y-up，将 ENU `(east, north, up)` 编码成 glTF `(east, up, -north)`。Cesium 的 Y-up → Z-up 旋转会还原 ENU 轴，然后应用根节点 ECEF 变换；请勿额外旋转模型。

在项目根目录执行以下命令可重建两个资源文件：

```sh
node scripts/generate-validation-tiles.mjs
```

生成器仅使用 Node.js 内置模块。`building.gltf` 内嵌二进制数据为 1,032 字节，整个 glTF 文件小于 20 KB。
