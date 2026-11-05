/**
 * 真采集数据 → 视锥骨架 / COLMAP 稀疏数据的测试。
 *
 * 参照物尽量用 three 的实现(applyQuaternion / PerspectiveCamera.lookAt),而不是本模块的
 * 另一段代码:自己验证自己只能证明"自洽",证明不了"对"。
 *
 * 最值钱的一组是 `采集 → manifest → COLMAP 导出 → 解析 → 位姿` 的闭环:它把
 * `drone-colmap-export`(写)、本模块(读)、以及 `drone-capture` 的位姿约定绑在一起,
 * 任何一处轴向或中心定义出错都会在"相机中心回到原位"这条断言上炸掉。
 */
import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Quaternion as ThreeQuaternion, Vector3 as ThreeVector3 } from 'three'
import type { CaptureSession, CapturedImage } from '../lib/drone-camera/drone-capture'
import { buildCaptureManifest } from '../lib/drone-camera/drone-capture-manifest'
import { exportColmapDataset } from '../lib/drone-camera/drone-colmap-export'
import {
  capturePoses,
  capturePosesToCloud,
  colmapDatasetToCloud,
  colmapImagesToPoses,
  colmapTextFromFiles,
  fovFromIntrinsics,
  parseColmapDataset,
  posesToCloud,
} from '../lib/drone-camera/drone-reconstruction-source'
import type { ReconstructionPose } from '../lib/drone-camera/drone-reconstruction-source'
import {
  createEcefEnuFrame,
  enuQuaternionToEcef,
  enuToEcef,
  rotateVectorByQuaternion,
} from '../lib/drone-camera/drone-photogrammetry'

const NOW = '2026-02-02T08:00:00.000Z'

/** 一张环绕拍摄的位姿:相机站在 eye,看向 target,朝向取 three 相机自身的四元数 */
function orbitPose(eye: ThreeVector3, target = new ThreeVector3(0, 0, 0)): ReconstructionPose {
  const camera = new PerspectiveCamera(60, 4 / 3, 0.1, 1000)
  camera.position.copy(eye)
  camera.lookAt(target)
  camera.updateMatrixWorld()
  const q = camera.quaternion
  return {
    id: `pose-${eye.x}-${eye.z}`,
    position: [eye.x, eye.y, eye.z],
    rotation: [q.x, q.y, q.z, q.w],
    horizontalFovDeg: 60,
    verticalFovDeg: 46.8,
  }
}

function makeImage(id: string, eye: ThreeVector3, frame: 'local-enu' | 'project-local' = 'local-enu'): CapturedImage {
  const pose = orbitPose(eye)
  return {
    id,
    source: 'virtual-camera',
    fileName: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 256,
    capturedAt: NOW,
    cameraIntrinsics: {
      width: 1600,
      height: 900,
      fx: 1386,
      fy: 1386,
      cx: 800,
      cy: 450,
      calibrationSource: 'known',
    },
    cameraPose: { position: pose.position, rotation: pose.rotation, coordinateFrame: frame },
    metadata: { engine: 'three' },
    validation: { status: 'valid', messages: [] },
  }
}

function makeSession(images: CapturedImage[]): CaptureSession {
  return {
    id: 'orbit-001',
    options: { source: 'virtual-camera', name: 'orbit', sceneId: 'scene' },
    status: 'finished',
    createdAt: NOW,
    updatedAt: NOW,
    autoCapturing: false,
    images,
  }
}

function orbitSession(count = 8): CaptureSession {
  const images: CapturedImage[] = []
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2
    images.push(makeImage(`img-${i}`, new ThreeVector3(Math.cos(angle) * 12, 6, Math.sin(angle) * 12)))
  }
  return makeSession(images)
}

/** cloud 里离 target 最近的点 */
function nearest(cloud: { count: number; center: Float32Array }, target: ThreeVector3): number {
  let best = Infinity
  for (let i = 0; i < cloud.count; i += 1) {
    const distance = Math.hypot(
      (cloud.center[i * 3] ?? 0) - target.x,
      (cloud.center[i * 3 + 1] ?? 0) - target.y,
      (cloud.center[i * 3 + 2] ?? 0) - target.z,
    )
    best = Math.min(best, distance)
  }
  return best
}

describe('rotateVectorByQuaternion', () => {
  it('绕 +Z 转 90° 把 +X 送到 +Y', () => {
    const result = rotateVectorByQuaternion([1, 0, 0], [0, 0, Math.SQRT1_2, Math.SQRT1_2])
    expect(result[0]).toBeCloseTo(0, 12)
    expect(result[1]).toBeCloseTo(1, 12)
    expect(result[2]).toBeCloseTo(0, 12)
  })

  it('与 three 的 applyQuaternion 在随机输入上逐位一致', () => {
    let seed = 7
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < 40; i += 1) {
      const q = new ThreeQuaternion(
        random() - 0.5,
        random() - 0.5,
        random() - 0.5,
        random() - 0.5,
      ).normalize()
      const v = new ThreeVector3(random() * 20 - 10, random() * 20 - 10, random() * 20 - 10)
      const expected = v.clone().applyQuaternion(q)
      const actual = rotateVectorByQuaternion([v.x, v.y, v.z], [q.x, q.y, q.z, q.w])
      expect(actual[0]).toBeCloseTo(expected.x, 12)
      expect(actual[1]).toBeCloseTo(expected.y, 12)
      expect(actual[2]).toBeCloseTo(expected.z, 12)
    }
  })

  it('不改变向量长度(纯旋转)', () => {
    const q = new ThreeQuaternion(0.2, -0.4, 0.5, 0.7).normalize()
    const v: [number, number, number] = [3, -4, 12]
    const result = rotateVectorByQuaternion(v, [q.x, q.y, q.z, q.w])
    expect(Math.hypot(...result)).toBeCloseTo(13, 12)
  })
})

describe('fovFromIntrinsics', () => {
  it('fx 优先:1600 宽 / fx 1386 给出约 60° 水平视场', () => {
    const fov = fovFromIntrinsics({ width: 1600, height: 900, fx: 1386, fy: 1386 })
    expect(fov.horizontalFovDeg).toBeCloseTo(60, 0)
    // 16:9 下垂直视场明显小于水平;这正是"宽屏拼图出空隙"的根因
    expect(fov.verticalFovDeg).toBeCloseTo(35.9, 0)
    expect(fov.verticalFovDeg).toBeLessThan(fov.horizontalFovDeg - 20)
  })

  it('没有内参时退回 60° / 按画幅比例', () => {
    expect(fovFromIntrinsics().horizontalFovDeg).toBe(60)
    expect(fovFromIntrinsics({ width: 1000, height: 1000 }).verticalFovDeg).toBeCloseTo(60, 6)
  })
})

describe('posesToCloud', () => {
  it('光心小球数量等于位姿数量', () => {
    const poses = [orbitPose(new ThreeVector3(5, 2, 0)), orbitPose(new ThreeVector3(-5, 2, 0))]
    const cloud = posesToCloud(poses, { frustumDepth: 10, markerRadius: 0.5, trail: false })
    // 每个位姿 1 个光心 + 视锥棱与末端方框;光心是唯一 alpha=1 且半径等于 markerRadius 的点
    let markers = 0
    for (let i = 0; i < cloud.count; i += 1) {
      if ((cloud.rgba[i * 4 + 3] ?? 0) === 1) markers += 1
    }
    expect(markers).toBe(2)
    expect(cloud.count).toBeGreaterThan(2)
  })

  it('朝 -Z 的相机,视锥角点落在 -Z 侧的正确位置上', () => {
    const pose: ReconstructionPose = {
      id: 'p',
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      horizontalFovDeg: 90,
      verticalFovDeg: 90,
    }
    const cloud = posesToCloud([pose], { frustumDepth: 10, trail: false, markerRadius: 0.1 })
    // 半画幅 = depth·tan(45°) = 10,所以四个角在 (±10, ±10, -10)
    const corner = new ThreeVector3(10, 10, -10)
    expect(nearest(cloud, corner)).toBeLessThan(0.02)
    expect(nearest(cloud, new ThreeVector3(-10, -10, -10))).toBeLessThan(0.02)
  })

  it('旋转 180° 后视锥翻到 +Z 侧(证明朝向真的进了几何)', () => {
    const pose: ReconstructionPose = {
      id: 'p',
      position: [0, 0, 0],
      rotation: [0, 1, 0, 0], // 绕 Y 轴 180°
      horizontalFovDeg: 60,
      verticalFovDeg: 60,
    }
    const cloud = posesToCloud([pose], { frustumDepth: 10, trail: false, markerRadius: 0.1 })
    let maxZ = -Infinity
    for (let i = 0; i < cloud.count; i += 1) maxZ = Math.max(maxZ, cloud.center[i * 3 + 2] ?? 0)
    expect(maxZ).toBeGreaterThan(9.5)
  })

  it('空输入返回零包围盒而不是 NaN', () => {
    const cloud = posesToCloud([])
    expect(cloud.count).toBe(0)
    expect(cloud.bounds.radius).toBe(0)
    expect(Number.isFinite(cloud.bounds.center[0])).toBe(true)
  })
})

describe('capturePoses', () => {
  it('从采集会话读出全部位姿,丢弃失败帧', () => {
    const session = orbitSession(4)
    const broken = session.images[1]
    expect(broken).toBeDefined()
    if (broken) broken.validation = { status: 'invalid', messages: ['missing pose'] }
    const poses = capturePoses(session)
    expect(poses).toHaveLength(3)
    expect(poses.some((pose) => pose.id === 'img-1')).toBe(false)
  })

  it('会话位置原样保留(不做任何隐式坐标变换)', () => {
    const session = makeSession([makeImage('a', new ThreeVector3(3, -4, 5))])
    const [pose] = capturePoses(session)
    expect(pose?.position).toEqual([3, -4, 5])
  })

  it('colmap 约定的位姿会被换到 three 约定(前向相差 180°)', () => {
    // 同一台相机,分别用两种约定描述:three 朝 -Z,colmap 朝 +Z,世界朝向必须一致
    const session = makeSession([makeImage('a', new ThreeVector3(0, 0, 5))])
    const three = capturePoses(session)[0]
    const colmap = capturePoses(session, { sourceCameraConvention: 'colmap' })[0]
    expect(three).toBeDefined()
    expect(colmap).toBeDefined()
    if (!three || !colmap) return
    // 同一个四元数在 colmap 解释下,前向是 +Z 而不是 -Z → 两者前向应互为相反数
    const forwardThree = rotateVectorByQuaternion([0, 0, -1], three.rotation)
    const forwardColmap = rotateVectorByQuaternion([0, 0, -1], colmap.rotation)
    const dot = forwardThree[0] * forwardColmap[0] + forwardThree[1] * forwardColmap[1] + forwardThree[2] * forwardColmap[2]
    expect(dot).toBeCloseTo(-1, 6)
  })

  it('capturePosesToCloud 的标题带张数', () => {
    const cloud = capturePosesToCloud(orbitSession(5))
    expect(cloud.name).toContain('5')
    expect(cloud.count).toBeGreaterThan(5)
  })

  it('ECEF 位姿(Cesium 后端)换到 ENU 后回到原来的 ENU 位置', () => {
    const origin = { longitude: 116.391, latitude: 39.906, altitude: 42 }
    const frame = createEcefEnuFrame(origin)
    const source = orbitPose(new ThreeVector3(12, 6, -4))
    const session = makeSession([makeImage('a', new ThreeVector3(0, 0, 0))])
    session.options.georeference = origin
    const image = session.images[0]
    expect(image).toBeDefined()
    if (!image) return
    // 用真值正向算出 ECEF,再交给本模块反解 —— 不自己抄一份逆变换
    image.cameraPose = {
      position: enuToEcef(source.position, frame),
      rotation: enuQuaternionToEcef(source.rotation, frame),
      coordinateFrame: 'ecef',
    }
    const [pose] = capturePoses(session)
    expect(pose).toBeDefined()
    if (!pose) return
    for (let k = 0; k < 3; k += 1) {
      expect(pose.position[k] ?? 0).toBeCloseTo(source.position[k] ?? 0, 6)
    }
    // 位置对不代表朝向对:单独验前向
    const expected = rotateVectorByQuaternion([0, 0, -1], source.rotation)
    const actual = rotateVectorByQuaternion([0, 0, -1], pose.rotation)
    const dot = expected[0] * actual[0] + expected[1] * actual[1] + expected[2] * actual[2]
    expect(dot).toBeCloseTo(1, 6)
  })

  it('ECEF 位姿但没有原点时跳过,并说明原因', () => {
    const session = makeSession([makeImage('a', new ThreeVector3(0, 0, 0))])
    const image = session.images[0]
    if (image) image.cameraPose = { position: [-2.1e6, 4.4e6, 4.1e6], rotation: [0, 0, 0, 1], coordinateFrame: 'ecef' }
    const skipped: string[] = []
    const poses = capturePoses(session, { onSkip: (_id, reason) => skipped.push(reason) })
    expect(poses).toHaveLength(0)
    expect(skipped[0]).toContain('ENU')
  })

  it('manifest 也能从 transform.origin 推出 ENU 帧', () => {
    const origin = { longitude: 116.391, latitude: 39.906, altitude: 42 }
    const frame = createEcefEnuFrame(origin)
    const source = orbitPose(new ThreeVector3(-8, 5, 9))
    const session = makeSession([makeImage('a', new ThreeVector3(0, 0, 0))])
    session.options.georeference = origin
    const image = session.images[0]
    if (image) {
      image.cameraPose = {
        position: enuToEcef(source.position, frame),
        rotation: enuQuaternionToEcef(source.rotation, frame),
        coordinateFrame: 'ecef',
      }
    }
    // manifest 里位姿仍是 ECEF,ENU 帧只存在于 coordinateFrame.transform.origin
    const [pose] = capturePoses(buildCaptureManifest(session))
    expect(pose?.position[0] ?? 0).toBeCloseTo(-8, 5)
    expect(pose?.position[2] ?? 0).toBeCloseTo(9, 5)
  })

  it('manifest 与 session 走同一条路径', () => {
    const session = orbitSession(3)
    const fromSession = capturePoses(session)
    const fromManifest = capturePoses(buildCaptureManifest(session))
    expect(fromManifest).toHaveLength(fromSession.length)
    for (let i = 0; i < fromSession.length; i += 1) {
      expect(fromManifest[i]?.position).toEqual(fromSession[i]?.position)
      expect(fromManifest[i]?.rotation[3]).toBeCloseTo(fromSession[i]?.rotation[3] ?? 0, 9)
    }
  })
})

describe('COLMAP 输出 → 位姿:闭环回到原点', () => {
  const session = orbitSession(6)
  const manifest = buildCaptureManifest(session)
  const exported = exportColmapDataset(manifest)
  const dataset = parseColmapDataset({
    camerasTxt: exported.camerasTxt,
    imagesTxt: exported.imagesTxt,
    points3Dtxt: exported.points3Dtxt,
  })

  it('解析出的相机数与图像数一致', () => {
    expect(dataset.cameras).toHaveLength(exported.cameraCount)
    expect(dataset.images).toHaveLength(exported.imageCount)
    expect(dataset.images.every((image) => image.points2D.length === 0)).toBe(true)
  })

  it('相机中心回到采集时的位置(6 位小数下 < 1e-4 米)', () => {
    const poses = colmapImagesToPoses(dataset)
    expect(poses).toHaveLength(session.images.length)
    for (let i = 0; i < poses.length; i += 1) {
      const original = session.images[i]?.cameraPose?.position
      const restored = poses[i]?.position
      expect(original).toBeDefined()
      expect(restored).toBeDefined()
      if (!original || !restored) continue
      for (let k = 0; k < 3; k += 1) {
        expect(restored[k] ?? 0).toBeCloseTo(original[k] ?? 0, 4)
      }
    }
  })

  it('光轴朝向与采集时一致(证明约定没被换错)', () => {
    const poses = colmapImagesToPoses(dataset)
    for (let i = 0; i < poses.length; i += 1) {
      const source = session.images[i]?.cameraPose?.rotation
      const pose = poses[i]
      if (!source || !pose) continue
      const expected = rotateVectorByQuaternion([0, 0, -1], [source[0], source[1], source[2], source[3]])
      const actual = rotateVectorByQuaternion([0, 0, -1], pose.rotation)
      const dot = expected[0] * actual[0] + expected[1] * actual[1] + expected[2] * actual[2]
      expect(dot).toBeCloseTo(1, 6)
    }
  })
})

describe('parseColmapDataset', () => {
  it('带 2D 观测时仍然每图两行(观测行不会被当成下一张的位姿行)', () => {
    // ⚠️ 这组数据是专门为"两行结构"设计的:如果解析器按一行前进,第 2 张的观测行会被
    // 当成位姿行(字段不足 → 跳过),之后全部错位。而**空观测行**的版本抓不到这个错误:
    // 改坏之后下一轮正好读到空行,被"空行容错"掩盖,结果一模一样 —— 变异测试发现的。
    const text = [
      '1 1 0 0 0 0 0 0 1 images/a.jpg',
      // 4 个观测 = 12 个数字:如果解析器按一行前进,这一行会被**当成位姿行**解析成功,
      // 因为前 9 个字段恰好都是数字(10 20 7 30 40 8 50 60 9)
      '10 20 7 30 40 8 50 60 9 70 80 10',
      '2 1 0 0 0 -4 0 0 1 images/b.jpg',
      '11 21 9 12 22 10',
      '3 1 0 0 0 -8 0 0 1 images/c.jpg',
      '12 22 -1',
    ].join('\n')
    const dataset = parseColmapDataset({ imagesTxt: text })
    expect(dataset.images.map((image) => image.name)).toEqual([
      'images/a.jpg',
      'images/b.jpg',
      'images/c.jpg',
    ])
    expect(dataset.images.map((image) => image.points2D.length)).toEqual([4, 2, 1])
    expect(dataset.images[2]?.tvec).toEqual([-8, 0, 0])
  })

  it('空观测行也不会让后续图像错位', () => {
    const text = [
      '# Image list with two lines of data per image:',
      '1 1 0 0 0 0 0 0 1 images/a.jpg',
      '',
      '2 1 0 0 0 -4 0 0 1 images/b.jpg',
      '',
      '3 1 0 0 0 -8 0 0 1 images/c.jpg',
      '',
    ].join('\n')
    const dataset = parseColmapDataset({ imagesTxt: text })
    expect(dataset.images.map((image) => image.name)).toEqual([
      'images/a.jpg',
      'images/b.jpg',
      'images/c.jpg',
    ])
    expect(dataset.images[2]?.tvec).toEqual([-8, 0, 0])
  })

  it('读回 2D 观测三元组', () => {
    const dataset = parseColmapDataset({
      imagesTxt: ['1 1 0 0 0 0 0 0 1 a.jpg', '12.5 33.25 7 100 200 -1', ''].join('\n'),
    })
    expect(dataset.images[0]?.points2D).toEqual([
      { x: 12.5, y: 33.25, point3DId: 7 },
      { x: 100, y: 200, point3DId: -1 },
    ])
  })

  it('points3D 的 track 与误差统计', () => {
    const dataset = parseColmapDataset({
      points3Dtxt: [
        '1 1.0 2.0 3.0 255 128 0 0.5 1 0 2 1',
        '2 -1.0 0.0 0.0 0 255 0 1.5 1 2',
        '',
      ].join('\n'),
    })
    expect(dataset.points).toHaveLength(2)
    expect(dataset.points[0]?.track).toEqual([
      [1, 0],
      [2, 1],
    ])
    // track 分别是 2 和 1,均值 1.5 —— 真实数据里"平均 track < 2"就是三角化不可信的信号
    expect(dataset.meanTrackLength).toBeCloseTo(1.5, 6)
    expect(dataset.meanError).toBeCloseTo(1, 6)
  })

  it('坏行只记 warning,不抛异常', () => {
    const dataset = parseColmapDataset({
      imagesTxt: ['这张不是位姿行', '1 1 0 0 0 0 0 0 1 a.jpg', '', ''].join('\n'),
      points3Dtxt: '3 0 0 0 255 255 255 0.2 1 0\n坏行\n',
    })
    expect(dataset.images).toHaveLength(1)
    expect(dataset.points).toHaveLength(1)
    expect(dataset.warnings.some((warning) => warning.includes('无法识别'))).toBe(true)
  })

  it('缺文件时给出明确提示而不是静默空', () => {
    const dataset = parseColmapDataset({})
    expect(dataset.images).toHaveLength(0)
    expect(dataset.warnings.join()).toContain('images.txt')
    expect(dataset.warnings.join()).toContain('points3D.txt')
  })

  it('按文件名认出三件套,其余计入 ignored', () => {
    const { input, matched, ignored } = colmapTextFromFiles([
      { name: 'sparse/0/cameras.txt', text: '1 PINHOLE 1 1 1 1 0 0' },
      { name: 'sparse/0/images.txt', text: '' },
      { name: 'sparse/0/points3D.txt', text: '' },
      { name: 'sparse/0/project.ini', text: '' },
    ])
    expect(matched).toEqual(['cameras.txt', 'images.txt', 'points3D.txt'])
    expect(ignored).toEqual(['project.ini'])
    expect(input.camerasTxt).toContain('PINHOLE')
  })
})

describe('colmapDatasetToCloud', () => {
  const dataset = parseColmapDataset({
    camerasTxt: '1 PINHOLE 1600 900 1386 1386 800 450',
    imagesTxt: ['1 1 0 0 0 0 0 -10 1 a.jpg', '', '2 1 0 0 0 -10 0 -10 1 b.jpg', ''].join('\n'),
    points3Dtxt: ['1 0 0 0 255 0 0 0.1 1 0', '2 1 1 1 0 255 0 0.2 1 1', ''].join('\n'),
  })

  it('点云 + 视锥一起进去,数量大于纯点数', () => {
    const cloud = colmapDatasetToCloud(dataset, { showCameras: true })
    expect(cloud.count).toBeGreaterThan(dataset.points.length)
    expect(nearest(cloud, new ThreeVector3(0, 0, 0))).toBeLessThan(0.05)
  })

  it('关掉视锥后只剩点,颜色取原始 RGB', () => {
    const cloud = colmapDatasetToCloud(dataset, { showCameras: false })
    expect(cloud.count).toBe(2)
    expect(cloud.rgba[0]).toBeCloseTo(1, 6)
    expect(cloud.rgba[1]).toBeCloseTo(0, 6)
  })

  it('按误差着色时误差大的点更红', () => {
    const withError = parseColmapDataset({
      points3Dtxt: ['1 0 0 0 200 200 200 0.001 1 0', '2 5 0 0 200 200 200 5 1 1', ''].join('\n'),
    })
    const cloud = colmapDatasetToCloud(withError, { showCameras: false, colorBy: 'error', errorScale: 1 })
    const calm = { r: cloud.rgba[0] ?? 0, g: cloud.rgba[1] ?? 0 }
    const bad = { r: cloud.rgba[4] ?? 0, g: cloud.rgba[5] ?? 0 }
    expect(bad.r).toBeGreaterThan(calm.r)
    expect(bad.g).toBeLessThan(calm.g)
  })

  it('位姿用的是 -Rᵀ·tvec:相机在 tvec 反方向 10 米处', () => {
    const poses = colmapImagesToPoses(dataset)
    // tvec = (0,0,-10) 且 qvec = 单位 → 相机中心在 (0,0,10)
    expect(poses[0]?.position[2]).toBeCloseTo(10, 6)
  })
})
