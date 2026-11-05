import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Quaternion as ThreeQuaternion, Vector3 as ThreeVector3 } from 'three'
import { exportColmapDataset } from '../lib/drone-camera/drone-colmap-export'
import { cameraQuaternionFromBasis } from '../lib/drone-camera/drone-photogrammetry'
import {
  CAPTURE_MANIFEST_SCHEMA_VERSION,
  type CaptureManifest,
  type CaptureManifestCamera,
  type CaptureManifestImage,
} from '../lib/drone-camera/drone-capture-manifest'

const WIDTH = 1280
const HEIGHT = 720
const FOCAL = 760
const TIMESTAMP = '2026-10-20T08:00:00.000Z'

function toTuple(vector: ThreeVector3): [number, number, number] {
  return [vector.x, vector.y, vector.z]
}

function makeCamera(overrides: Partial<CaptureManifestCamera> = {}): CaptureManifestCamera {
  return {
    model: 'PINHOLE',
    width: WIDTH,
    height: HEIGHT,
    fx: FOCAL,
    fy: FOCAL,
    cx: WIDTH / 2,
    cy: HEIGHT / 2,
    projection: 'perspective',
    ...overrides,
  }
}

function makeImage(
  id: string,
  position: [number, number, number],
  rotation: [number, number, number, number],
  overrides: Partial<CaptureManifestImage> = {},
): CaptureManifestImage {
  return {
    id,
    file: `images/${id}.jpg`,
    timestamp: TIMESTAMP,
    position,
    rotation,
    rotationConvention: 'quaternion [x,y,z,w]; camera forward=-Z, up=+Y',
    captureStatus: 'success',
    mimeType: 'image/jpeg',
    sizeBytes: 2048,
    width: WIDTH,
    height: HEIGHT,
    coordinateFrame: 'project-local',
    ...overrides,
  }
}

function makeManifest(
  images: CaptureManifestImage[],
  camera: CaptureManifestCamera = makeCamera(),
): CaptureManifest {
  return {
    schemaVersion: CAPTURE_MANIFEST_SCHEMA_VERSION,
    captureId: 'unit-test-capture',
    createdAt: TIMESTAMP,
    coordinateFrame: {
      world: 'project-local',
      local: 'project-local',
      units: 'meters',
      transform: { source: 'project-local', target: 'project-local' },
    },
    camera,
    images,
  }
}

interface ParsedImage {
  id: number
  qvec: [number, number, number, number]
  tvec: [number, number, number]
  cameraId: number
  name: string
}

/** 按 COLMAP 的读法解析:非注释行按「每图两行」配对,空行也必须占位 */
function parseImages(text: string): ParsedImage[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const data = lines.filter((line) => !line.startsWith('#'))
  const parsed: ParsedImage[] = []
  for (let index = 0; index < data.length; index += 2) {
    const parts = data[index]!.split(' ')
    parsed.push({
      id: Number(parts[0]),
      qvec: [Number(parts[1]), Number(parts[2]), Number(parts[3]), Number(parts[4])],
      tvec: [Number(parts[5]), Number(parts[6]), Number(parts[7])],
      cameraId: Number(parts[8]),
      name: parts.slice(9).join(' '),
    })
  }
  return parsed
}

function parseCameraParams(text: string): { model: string; width: number; height: number; params: number[] } {
  const data = text
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  const parts = data[0]!.split(' ')
  return {
    model: parts[1]!,
    width: Number(parts[2]),
    height: Number(parts[3]),
    params: parts.slice(4).map(Number),
  }
}

interface LookAtSetup {
  camera: PerspectiveCamera
  rotation: [number, number, number, number]
  eye: ThreeVector3
  targets: ThreeVector3[]
}

/** 一台由 three 亲自摆位的相机:位姿来自 matrixWorld,不手写四元数 */
function lookAtSetup(): LookAtSetup {
  const eye = new ThreeVector3(5, 3, 12)
  const target = new ThreeVector3(-1, 0.5, -4)
  const fovDeg = (2 * Math.atan(HEIGHT / (2 * FOCAL)) * 180) / Math.PI
  const camera = new PerspectiveCamera(fovDeg, WIDTH / HEIGHT, 0.1, 1000)
  camera.position.copy(eye)
  camera.lookAt(target)
  camera.updateMatrixWorld()

  const matrix = camera.matrixWorld
  const rotation = cameraQuaternionFromBasis(
    {
      right: toTuple(new ThreeVector3().setFromMatrixColumn(matrix, 0)),
      up: toTuple(new ThreeVector3().setFromMatrixColumn(matrix, 1)),
      forward: toTuple(new ThreeVector3().setFromMatrixColumn(matrix, 2).negate()),
    },
    'three',
  )
  return { camera, rotation, eye, targets: [target, new ThreeVector3(2, 2.5, -6)] }
}

/** 用 COLMAP 侧的 qvec/tvec + 针孔公式重投影,返回每个点的像素误差 */
function reprojectionErrors(
  text: string,
  camera: PerspectiveCamera,
  points: ThreeVector3[],
): number[] {
  const [parsed] = parseImages(text)
  const [qw, qx, qy, qz] = parsed!.qvec
  const worldToCamera = new ThreeQuaternion(qx, qy, qz, qw)
  const translation = new ThreeVector3(...parsed!.tvec)
  return points.map((point) => {
    const ndc = point.clone().project(camera)
    const uExpected = ((ndc.x + 1) / 2) * WIDTH
    const vExpected = ((1 - ndc.y) / 2) * HEIGHT
    const cameraPoint = point.clone().applyQuaternion(worldToCamera).add(translation)
    if (!(cameraPoint.z > 0)) throw new Error('测试点落在相机背后')
    return Math.hypot(
      (FOCAL * cameraPoint.x) / cameraPoint.z + WIDTH / 2 - uExpected,
      (FOCAL * cameraPoint.y) / cameraPoint.z + HEIGHT / 2 - vExpected,
    )
  })
}

describe('COLMAP cameras.txt', () => {
  it('写出 PINHOLE 模型与四个内参', () => {
    const result = exportColmapDataset(makeManifest([makeImage('a', [0, 0, 0], [0, 0, 0, 1])]))
    const camera = parseCameraParams(result.camerasTxt)
    expect(camera.model).toBe('PINHOLE')
    expect(camera.width).toBe(WIDTH)
    expect(camera.height).toBe(HEIGHT)
    expect(camera.params).toEqual([760, 760, 640, 360])
    expect(result.camerasTxt).toContain('# Number of cameras: 1')
  })

  it('畸变系数够四个时切到 OPENCV,参数顺序是 fx fy cx cy k1 k2 p1 p2', () => {
    const camera = makeCamera({ distortion: [0.12, -0.05, 0.001, -0.002] })
    const result = exportColmapDataset(makeManifest([makeImage('a', [0, 0, 0], [0, 0, 0, 1])], camera))
    const parsed = parseCameraParams(result.camerasTxt)
    expect(parsed.model).toBe('OPENCV')
    expect(parsed.params).toEqual([760, 760, 640, 360, 0.12, -0.05, 0.001, -0.002])
  })

  it('缺焦距时用水平 FOV 反算,而不是写 0', () => {
    const camera = makeCamera({ fx: undefined, fy: undefined, horizontalFovDeg: 60 })
    const result = exportColmapDataset(makeManifest([makeImage('a', [0, 0, 0], [0, 0, 0, 1])], camera))
    const parsed = parseCameraParams(result.camerasTxt)
    expect(parsed.params[0]).toBeCloseTo(WIDTH / 2 / Math.tan(Math.PI / 6), 3)
    expect(parsed.params[1]).toBeCloseTo(parsed.params[0]!, 6)
  })

  it('畸变不足四个又强行要 OPENCV 时退回 PINHOLE 并留下警告', () => {
    const camera = makeCamera({ distortion: [0.1, -0.02] })
    const result = exportColmapDataset(makeManifest([makeImage('a', [0, 0, 0], [0, 0, 0, 1])], camera), {
      cameraModel: 'OPENCV',
    })
    expect(parseCameraParams(result.camerasTxt).model).toBe('PINHOLE')
    expect(result.warnings.join(' ')).toContain('退回 PINHOLE')
  })
})

describe('COLMAP images.txt', () => {
  it('每张图严格占两行,没有观测也留空行', () => {
    const result = exportColmapDataset(
      makeManifest([
        makeImage('a', [0, 0, 0], [0, 0, 0, 1]),
        makeImage('b', [2, 0, 3], [0, 0, 0, 1]),
      ]),
    )
    const lines = result.imagesTxt.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    const data = lines.filter((line) => !line.startsWith('#'))
    expect(data).toHaveLength(4)
    expect(data[1]).toBe('')
    expect(data[3]).toBe('')
    expect(result.imagesTxt).toContain('# Number of images: 2, mean observations per image: 0')
  })

  it('第一行九个字段:image_id qvec tvec camera_id name', () => {
    const result = exportColmapDataset(makeManifest([makeImage('a', [0, 0, 0], [0, 0, 0, 1])]))
    const [image] = parseImages(result.imagesTxt)
    // three 的单位四元数相机看 -Z,换算到 COLMAP 的"看 +Z"要绕 X 轴翻 180°,
    // 于是 world-to-camera 是 [qw,qx,qy,qz] = [0,-1,0,0] —— 不是单位四元数才是对的
    expect(image).toEqual({
      id: 1,
      qvec: [0, -1, 0, 0],
      tvec: [0, 0, 0],
      cameraId: 1,
      name: 'images/a.jpg',
    })
  })

  it('qvec 是 world-to-camera:tvec 等于 -R·C 而不是相机中心', () => {
    const result = exportColmapDataset(makeManifest([makeImage('a', [4, -2, 10], [0, 0, 0, 1])]))
    const [image] = parseImages(result.imagesTxt)
    expect(image!.tvec.map((value) => Math.abs(value))).toEqual([4, 2, 10])
    const [qw, qx, qy, qz] = image!.qvec
    const centre = new ThreeVector3(4, -2, 10)
      .applyQuaternion(new ThreeQuaternion(qx, qy, qz, qw))
      .add(new ThreeVector3(...image!.tvec))
    expect(centre.length()).toBeCloseTo(0, 6)
  })

  it('写出的位姿能让 COLMAP 的针孔公式复现 three 渲染出的像素', () => {
    const { camera, rotation, eye, targets } = lookAtSetup()
    const manifest = makeManifest([makeImage('a', toTuple(eye), rotation)])

    const errors = reprojectionErrors(exportColmapDataset(manifest).imagesTxt, camera, targets)
    // 6 位小数下重投影误差在 1e-4 像素量级,即千分之一像素以内
    for (const error of errors) expect(error).toBeLessThan(0.005)
  })

  it('误差来自文本精度而不是位姿:提到 12 位小数后收敛到 1e-6 像素', () => {
    const { camera, rotation, eye, targets } = lookAtSetup()
    const manifest = makeManifest([makeImage('a', toTuple(eye), rotation)])

    const errors = reprojectionErrors(
      exportColmapDataset(manifest, { precision: 12 }).imagesTxt,
      camera,
      targets,
    )
    for (const error of errors) expect(error).toBeLessThan(1e-6)
  })

  it('qvec 归一化到 COLMAP 能接受的精度(否则 ReadImage 直接拒绝)', () => {
    const rotations: Array<[number, number, number, number]> = [
      [0, 0, 0, 1],
      [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      [0.5, 0.5, 0.5, 0.5],
    ]
    const images = rotations.map((rotation, index) =>
      makeImage(`f${index}`, [Math.cos(index) * 10, 2, Math.sin(index) * 10], rotation),
    )
    for (const image of parseImages(exportColmapDataset(makeManifest(images)).imagesTxt)) {
      // COLMAP 的容差是 |‖q‖²-1| ≤ 1e-5,这里用更严的 1e-6
      expect(Math.hypot(...image.qvec)).toBeCloseTo(1, 6)
    }
  })

  it('传入 2D 观测时写在第二行,不传就保持空行', () => {
    const result = exportColmapDataset(
      makeManifest([makeImage('a', [0, 0, 0], [0, 0, 0, 1]), makeImage('b', [1, 0, 0], [0, 0, 0, 1])]),
      { points2D: { a: '640 360 -1' } },
    )
    const lines = result.imagesTxt.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    const data = lines.filter((line) => !line.startsWith('#'))
    expect(data[1]).toBe('640 360 -1')
    expect(data[3]).toBe('')
  })

  it('内参不同的图像各占一个 camera_id(多相机 / 变焦)', () => {
    const result = exportColmapDataset(
      makeManifest(
        [
          makeImage('a', [0, 0, 0], [0, 0, 0, 1]),
          makeImage('b', [0, 0, 0], [0, 0, 0, 1], { intrinsics: makeCamera({ fx: 900, fy: 900 }) }),
          makeImage('c', [0, 0, 0], [0, 0, 0, 1]),
        ],
        makeCamera(),
      ),
      // 同一内参的两张图共用一个 camera_id,变焦那张单独一个
    )
    const images = parseImages(result.imagesTxt)
    expect(result.cameraCount).toBe(2)
    expect(images.map((image) => image.cameraId)).toEqual([1, 2, 1])
  })

  it('跳过没有位姿或拍摄失败的图像,并说明原因', () => {
    const result = exportColmapDataset(
      makeManifest([
        makeImage('ok', [0, 0, 0], [0, 0, 0, 1]),
        makeImage('failed', [0, 0, 0], [0, 0, 0, 1], { captureStatus: 'failed' }),
        makeImage('no-pose', [0, 0, 0], [0, 0, 0, 1], { position: undefined, rotation: undefined }),
      ]),
    )
    expect(result.imageCount).toBe(1)
    expect(result.skipped.map((entry) => entry.imageId)).toEqual(['failed', 'no-pose'])
    expect(result.skipped[0]!.reason).toContain('captureStatus')
  })

  it('位姿是 ECEF 又没有原点时明确跳过,不静默写出错误坐标', () => {
    const result = exportColmapDataset(
      makeManifest([makeImage('ecef', [0, 0, 0], [0, 0, 0, 1], { coordinateFrame: 'ecef' })]),
    )
    expect(result.imageCount).toBe(0)
    expect(result.skipped[0]!.reason).toContain('enuFrame')
  })

  it('不写负零,免得文件里出现 -0.000000', () => {
    const result = exportColmapDataset(makeManifest([makeImage('a', [1e-9, 0, 0], [0, 0, 0, 1])]))
    expect(result.imagesTxt).not.toContain('-0.000000')
  })
})

describe('COLMAP points3D.txt', () => {
  it('没有点云时只写头部,数量为 0', () => {
    const result = exportColmapDataset(makeManifest([makeImage('a', [0, 0, 0], [0, 0, 0, 1])]))
    expect(result.pointCount).toBe(0)
    expect(result.points3Dtxt).toContain('# Number of points: 0, mean track length: 0')
  })

  it('有点云时按 COLMAP 的字段顺序写出,并夹取颜色', () => {
    const result = exportColmapDataset(makeManifest([makeImage('a', [0, 0, 0], [0, 0, 0, 1])]), {
      points: [
        { position: [1, 2, 3], color: [10, 20, 300], error: 0.5, track: [[1, 0], [2, 14]] },
      ],
    })
    const line = result.points3Dtxt
      .split('\n')
      .find((row) => row.startsWith('1 '))
    expect(line).toBe('1 1.000000 2.000000 3.000000 10 20 255 0.500000 1 0 2 14')
    expect(result.points3Dtxt).toContain('# Number of points: 1, mean track length: 2.00')
  })
})
