#!/usr/bin/env node
/**
 * 把 COLMAP 跑完的 sparse 输出转成 `.splat`,可以直接拖进 Splat 查看器看。
 *
 *   node scripts/colmap-to-splat.mjs --dir path/to/sparse/0 --out cloud.splat
 *   node scripts/colmap-to-splat.mjs --images images.txt --points3D points3D.txt --out cloud.splat
 *
 * 这是"采集 → 导出 → 训练"闭环里属于**我们**的那一环:COLMAP mapper 的产物
 * (`cameras.txt / images.txt / points3D.txt`)→ 位姿反解 + 三角化点 → 查看器能吃的
 * 各向同性小球点云。真 3DGS 训练器还需要从这些点初始化椭球 —— 那一步在训练器里,
 * 不在这里假装已经做了。
 *
 * 用途有两个:
 *   1. 训练之前先看一眼:sparse 点是否聚成一坨、位姿是否成环、重投影误差是否离谱;
 *   2. 训练完的 3DGS .ply 也走同一个查看器 —— 同一个场景,稀疏和稠密并排对比。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url)
const { colmapDatasetToCloud, colmapTextFromFiles, parseColmapDataset } = await jiti.import(
  '../src/lib/drone-camera/drone-reconstruction-source.ts',
)
const { encodeSplatBinary } = await jiti.import('../src/lib/drone-camera/drone-splat.ts')

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个值`)
  return value
}

function fail(message) {
  console.error(`错误:${message}`)
  console.error(
    '用法:node scripts/colmap-to-splat.mjs (--dir <sparse/0> | --cameras <f> --images <f> --points3D <f>) --out <cloud.splat> [--no-cameras] [--error-color]',
  )
  process.exit(1)
}

const out = arg('--out', '')
if (!out) fail('缺少 --out <cloud.splat>')

// ── 收集三件套 ──
const dir = arg('--dir', null)
const files = []
if (dir) {
  for (const name of ['cameras.txt', 'images.txt', 'points3D.txt']) {
    try {
      files.push({ name, text: readFileSync(join(dir, name), 'utf8') })
    } catch {
      // 缺哪个文件 parseColmapDataset 会给出提示
    }
  }
} else {
  for (const name of ['--cameras', '--images', '--points3D']) {
    const path = arg(name, null)
    if (!path) continue
    const base = { '--cameras': 'cameras.txt', '--images': 'images.txt', '--points3D': 'points3D.txt' }[name]
    files.push({ name: base, text: readFileSync(path, 'utf8') })
  }
}
if (files.length === 0) fail('没有输入文件(--dir 或单个 --cameras/--images/--points3D)')

const { input, matched, ignored } = colmapTextFromFiles(files)
const dataset = parseColmapDataset(input)
for (const warning of dataset.warnings) console.log(`  ! ${warning}`)
if (ignored.length > 0) console.log(`  忽略:${ignored.join(', ')}`)

if (dataset.images.length === 0 && dataset.points.length === 0) {
  fail('没有可用的位姿或点(文件是空的,或格式不是 COLMAP sparse 输出)')
}

// ── 转 splat 并落盘 ──
const cloud = colmapDatasetToCloud(dataset, {
  name: out.split(/[\\/]/).pop() ?? 'colmap',
  showCameras: !process.argv.includes('--no-cameras'),
  colorBy: process.argv.includes('--error-color') ? 'error' : 'rgb',
})
writeFileSync(out, encodeSplatBinary(cloud))

// ── 报告:这一段是给人看的"训练前体检" ──
console.log(
  [
    `位姿 ${dataset.images.length} 张 · 相机 ${dataset.cameras.length} 台 · 点 ${dataset.points.length} 个`,
    `平均 track 长度 ${dataset.meanTrackLength.toFixed(2)}(小于 2 说明三角化不可信)`,
    `平均重投影误差 ${dataset.meanError.toFixed(3)} px(大于 1 需要检查标定)`,
    `已写出 ${out}(${cloud.count} splat,可直接拖进 Splat 查看器)`,
  ].join('\n'),
)
if (dataset.points.length > 0 && dataset.meanTrackLength < 2) {
  console.log('  ⚠ 平均 track < 2:大多数点只被一张图看到,可能匹配失败或影像重叠不足')
}
if (dataset.points.length > 0 && dataset.meanError > 1) {
  console.log('  ⚠ 平均重投影误差 > 1px:检查内参是否准确、畸变模型是否匹配')
}
if (dataset.points.length === 0) {
  console.log('  提示:没有 points3D.txt —— 只有位姿骨架。跑完 colmap mapper 再来,才能看到三角化点')
}
