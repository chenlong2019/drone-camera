#!/usr/bin/env node
/**
 * 把一份 capture manifest 写成 COLMAP 三件套(cameras.txt / images.txt / points3D.txt)。
 *
 *   node scripts/export-colmap.mjs --manifest captures/xxx/manifest.json --out reconstruction/xxx/colmap
 *   node scripts/export-colmap.mjs --sample --out tmp-shots/colmap-sample   # 没数据时看产物形状
 *
 * manifest 由 `buildCaptureManifest(session)` + `serializeCaptureManifest()` 落盘得到。
 * 位姿必须是 COLMAP 能用的世界系(project-local 或 ENU);ECEF 会走 manifest 里 transform.origin
 * 自动转到 ENU,没有 origin 的图像会被跳过并说明原因。
 *
 * ⚠️ points3D.txt 默认是空的:SfM 自己会三角化,但 3DGS 这类训练器要用它做高斯初始化。
 *    要么先跑一遍 COLMAP mapper 拿到 sparse 模型,要么用 --points 传入点云。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createJiti } from 'jiti'
import { Matrix4, Quaternion, Vector3 } from 'three'

const jiti = createJiti(import.meta.url)
const { exportColmapDataset } = await jiti.import('../src/lib/drone-camera/drone-colmap-export.ts')

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个值`)
  return value
}

function fail(message) {
  console.error(`错误:${message}`)
  console.error('用法:node scripts/export-colmap.mjs (--manifest <path> | --sample) [--out <dir>] [--precision 6] [--camera-model auto]')
  process.exit(1)
}

/** 八个机位环绕注视原点:用来观察产物形状,不参与任何验证结论 */
function sampleManifest() {
  const target = new Vector3(0, 0, 0)
  const up = new Vector3(0, 1, 0)
  const images = []
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2
    const eye = new Vector3(Math.cos(angle) * 12, 3, Math.sin(angle) * 12)
    const rotation = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(eye, target, up))
    images.push({
      id: `frame-${String(index).padStart(3, '0')}`,
      file: `images/frame-${String(index).padStart(3, '0')}.jpg`,
      timestamp: new Date(Date.UTC(2026, 9, 20, 8, 0, index)).toISOString(),
      position: [eye.x, eye.y, eye.z],
      rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
      rotationConvention: 'quaternion [x,y,z,w]; active camera-local-to-world; forward=-Z, up=+Y',
      captureStatus: 'success',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      width: 1280,
      height: 720,
      coordinateFrame: 'project-local',
    })
  }
  return {
    schemaVersion: 1,
    captureId: 'sample-ring',
    createdAt: new Date(Date.UTC(2026, 9, 20, 8, 0, 0)).toISOString(),
    coordinateFrame: {
      world: 'project-local',
      local: 'project-local',
      units: 'meters',
      transform: { source: 'project-local', target: 'project-local' },
    },
    camera: {
      model: 'PINHOLE',
      width: 1280,
      height: 720,
      fx: 760,
      fy: 760,
      cx: 640,
      cy: 360,
      projection: 'perspective',
    },
    images,
  }
}

const manifestPath = arg('--manifest', null)
const useSample = process.argv.includes('--sample')
if (!manifestPath && !useSample) fail('需要 --manifest <path> 或 --sample')

let manifest
if (manifestPath) {
  try {
    manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'))
  } catch (error) {
    fail(`读不了 manifest:${error instanceof Error ? error.message : String(error)}`)
  }
} else {
  manifest = sampleManifest()
}

const outDir = resolve(arg('--out', 'colmap-export'))
const precision = Number(arg('--precision', '6'))
if (!Number.isInteger(precision) || precision < 0 || precision > 17) fail('--precision 必须是 0..17 的整数')

const result = exportColmapDataset(manifest, {
  precision,
  cameraModel: arg('--camera-model', 'auto'),
})

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'cameras.txt'), result.camerasTxt)
writeFileSync(join(outDir, 'images.txt'), result.imagesTxt)
writeFileSync(join(outDir, 'points3D.txt'), result.points3Dtxt)

console.log(`captureId   ${manifest.captureId ?? '(未命名)'}`)
console.log(`输出目录    ${outDir}`)
console.log(`相机/图像/点 ${result.cameraCount} / ${result.imageCount} / ${result.pointCount}`)

if (result.skipped.length > 0) {
  console.log(`\n跳过 ${result.skipped.length} 张:`)
  for (const entry of result.skipped.slice(0, 10)) console.log(`  - ${entry.imageId}: ${entry.reason}`)
  if (result.skipped.length > 10) console.log(`  …还有 ${result.skipped.length - 10} 张`)
}

if (result.warnings.length > 0) {
  console.log(`\n警告 ${result.warnings.length} 条:`)
  for (const warning of new Set(result.warnings)) console.log(`  ! ${warning}`)
}

console.log('\n下一步(把 <captureDir> 换成图片实际所在目录):')
console.log(`  colmap feature_extractor --database_path ${join(outDir, 'database.db')} \\`)
console.log('    --image_path <captureDir> --ImageReader.camera_model PINHOLE --ImageReader.single_camera 1')
console.log(`  colmap exhaustive_matcher --database_path ${join(outDir, 'database.db')}`)
console.log(`  colmap mapper --database_path ${join(outDir, 'database.db')} --image_path <captureDir> \\`)
console.log(`    --output_path ${join(outDir, 'sparse')}`)

if (result.pointCount === 0) {
  console.log('\n注意:points3D.txt 是空的。3DGS / nerfstudio 这类训练器要用它做高斯初始化,')
  console.log('      先跑上面的 mapper 拿到 sparse 模型,或用 --points 传入点云后再训练。')
}

process.exit(result.imageCount === 0 ? 1 : 0)
