import { describe, expect, it } from 'vitest'
import { Matrix4, PerspectiveCamera, Quaternion as ThreeQuaternion, Vector3 as ThreeVector3 } from 'three'
import {
  cameraPoseToColmap,
  cameraQuaternionFromBasis,
  convertCameraQuaternion,
  type CameraAxisConvention,
  type CameraWorldBasis,
  type Quaternion,
} from '../lib/drone-camera/drone-photogrammetry'

/**
 * 四套相机轴约定的边界测试。
 *
 * 四套约定 +X 一律向右,差别只在两处:
 *   - "上是 +Y 还是 -Y"(three/cesium 上为 +Y,colmap/opencv 下为 +Y)
 *   - "前是 +Z 还是 -Z"(three/cesium 看 -Z,colmap/opencv 看 +Z)
 * 所以只测"转过去再转回来"是不够的 —— 把 colmap 和 cesium 的矩阵抄反,往返照样通过。
 * 这里用 three 的 lookAt / project 作为独立参考实现,验证转换后的**光学轴朝向**与**投影像素**。
 *
 * 一个已知的不可观测面:四套约定在实现里都是对角 ±1 矩阵,而这类矩阵两两对易,
 * 于是 convertCameraQuaternion 里 `AᵀB` 与 `BᵀA` 写反了会得到**完全相同**的结果(已用变异测试确认)。
 * 也就是说方向写反当前无害,但这依赖矩阵族对易;一旦加入非对角约定(例如 Unity 手性、
 * Blender Z-up),这层保护就会失效,必须补一条非对易的用例。真正敏感的是左乘/右乘的顺序,
 * 写反会让 11/36 条断言变红。
 */
const CONVENTIONS: CameraAxisConvention[] = ['three', 'cesium', 'colmap', 'opencv']

/** 该约定下"视觉前方"落在这个相机坐标系里的哪个轴上 */
function forwardAxis(convention: CameraAxisConvention): [number, number, number] {
  return convention === 'colmap' || convention === 'opencv' ? [0, 0, 1] : [0, 0, -1]
}

/** 该约定下"视觉上方"落在这个相机坐标系里的哪个轴上 */
function upAxis(convention: CameraAxisConvention): [number, number, number] {
  return convention === 'colmap' || convention === 'opencv' ? [0, -1, 0] : [0, 1, 0]
}

/** 一个不与任何世界轴对齐的测试旋转:绕任意轴转 47° */
const SAMPLE: Quaternion = (() => {
  const axis = new ThreeVector3(0.3, -0.5, 0.2).normalize()
  const half = (47 * Math.PI) / 180 / 2
  const sin = Math.sin(half)
  return [axis.x * sin, axis.y * sin, axis.z * sin, Math.cos(half)]
})()

const EYE = new ThreeVector3(5, 3, 12)
const TARGET = new ThreeVector3(-1, 0.5, -4)
const WORLD_UP = new ThreeVector3(0, 1, 0)

function toTuple(vector: ThreeVector3): [number, number, number] {
  return [vector.x, vector.y, vector.z]
}

/** q 与 -q 是同一个旋转,比较必须用 |点积| 而不是逐分量 */
function rotationDot(a: Quaternion, b: Quaternion): number {
  return Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])
}

function rotate(q: Quaternion, axis: [number, number, number]): ThreeVector3 {
  return new ThreeVector3(axis[0], axis[1], axis[2]).applyQuaternion(
    new ThreeQuaternion(q[0], q[1], q[2], q[3]),
  )
}

function cameraBasis(): CameraWorldBasis {
  const matrix = new Matrix4().lookAt(EYE, TARGET, WORLD_UP)
  return {
    right: toTuple(new ThreeVector3().setFromMatrixColumn(matrix, 0)),
    up: toTuple(new ThreeVector3().setFromMatrixColumn(matrix, 1)),
    forward: toTuple(new ThreeVector3().setFromMatrixColumn(matrix, 2).negate()),
  }
}

function expectSameDirection(actual: ThreeVector3, expected: ThreeVector3): number {
  return actual.normalize().dot(expected.clone().normalize())
}

const CONVENTION_PAIRS = CONVENTIONS.flatMap((from) => CONVENTIONS.map((to) => [from, to] as const))

describe('camera axis conventions: 代数自洽', () => {
  it.each(CONVENTION_PAIRS)('%s → %s → %s 回到原旋转', (from, to) => {
    const there = convertCameraQuaternion(SAMPLE, from, to)
    const back = convertCameraQuaternion(there, to, from)
    expect(rotationDot(back, SAMPLE)).toBeCloseTo(1, 12)
  })

  it('转换是坐标系切换,满足结合律:a→b 再 b→c 等于 a→c', () => {
    for (const a of CONVENTIONS) {
      for (const b of CONVENTIONS) {
        for (const c of CONVENTIONS) {
          const stepped = convertCameraQuaternion(
            convertCameraQuaternion(SAMPLE, a, b),
            b,
            c,
          )
          const direct = convertCameraQuaternion(SAMPLE, a, c)
          expect(rotationDot(stepped, direct)).toBeCloseTo(1, 12)
        }
      }
    }
  })

  it('所有输出都是单位四元数,不随输入长度漂移', () => {
    for (const from of CONVENTIONS) {
      for (const to of CONVENTIONS) {
        const q = convertCameraQuaternion([SAMPLE[0] * 7, SAMPLE[1] * 7, SAMPLE[2] * 7, SAMPLE[3] * 7], from, to)
        expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(1, 14)
      }
    }
  })

  it('three 与 cesium 共用同一套相机轴', () => {
    expect(rotationDot(convertCameraQuaternion(SAMPLE, 'three', 'cesium'), SAMPLE)).toBeCloseTo(1, 14)
  })

  it('反复往返两百次不产生可见漂移', () => {
    let q = SAMPLE
    for (let index = 0; index < 200; index += 1) {
      q = convertCameraQuaternion(convertCameraQuaternion(q, 'three', 'colmap'), 'colmap', 'three')
    }
    expect(rotationDot(q, SAMPLE)).toBeCloseTo(1, 10)
  })

  it('未知约定直接抛错,而不是当成恒等变换蒙混过去', () => {
    expect(() =>
      convertCameraQuaternion(SAMPLE, 'three', 'unity' as CameraAxisConvention),
    ).toThrow(/Unknown camera axis convention/)
  })
})

describe('camera axis conventions: 光学轴语义', () => {
  it.each(CONVENTIONS)('%s 视角下,四套约定转换后的前向轴指向同一世界方向', (viewer) => {
    const basis = cameraBasis()
    const expected = new ThreeVector3(...basis.forward)
    for (const source of CONVENTIONS) {
      const sourceRotation = cameraQuaternionFromBasis(basis, source)
      const converted = convertCameraQuaternion(sourceRotation, source, viewer)
      expect(expectSameDirection(rotate(converted, forwardAxis(viewer)), expected)).toBeCloseTo(1, 10)
    }
  })

  it.each(CONVENTIONS)('%s 视角下,视觉上方也保持一致(不被整体翻转)', (viewer) => {
    const basis = cameraBasis()
    const expected = new ThreeVector3(...basis.up)
    for (const source of CONVENTIONS) {
      const sourceRotation = cameraQuaternionFromBasis(basis, source)
      const converted = convertCameraQuaternion(sourceRotation, source, viewer)
      expect(expectSameDirection(rotate(converted, upAxis(viewer)), expected)).toBeCloseTo(1, 10)
    }
  })

  it('cameraQuaternionFromBasis 复现 three lookAt 自带的四元数', () => {
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 1000)
    camera.position.copy(EYE)
    camera.lookAt(TARGET)
    camera.updateMatrixWorld()

    const matrix = camera.matrixWorld
    const basis: CameraWorldBasis = {
      right: toTuple(new ThreeVector3().setFromMatrixColumn(matrix, 0)),
      up: toTuple(new ThreeVector3().setFromMatrixColumn(matrix, 1)),
      forward: toTuple(new ThreeVector3().setFromMatrixColumn(matrix, 2).negate()),
    }
    const derived = cameraQuaternionFromBasis(basis, 'three')
    const official: Quaternion = [
      camera.quaternion.x,
      camera.quaternion.y,
      camera.quaternion.z,
      camera.quaternion.w,
    ]
    expect(rotationDot(derived, official)).toBeCloseTo(1, 12)
  })

  it.each(CONVENTIONS)('%s:从基向量直出 与 从 three 转换 得到同一旋转', (convention) => {
    const basis = cameraBasis()
    const direct = cameraQuaternionFromBasis(basis, convention)
    const viaThree = convertCameraQuaternion(
      cameraQuaternionFromBasis(basis, 'three'),
      'three',
      convention,
    )
    expect(rotationDot(direct, viaThree)).toBeCloseTo(1, 12)
  })
})

describe('camera axis conventions: 端到端投影', () => {
  it('COLMAP 位姿与 three 相机把同一世界点投到同一像素', () => {
    const width = 1280
    const height = 720
    const focal = 760
    // three 的投影矩阵是方形像素(fx = fy),相机垂直 fov 由焦距反推
    const fovDeg = (2 * Math.atan(height / (2 * focal)) * 180) / Math.PI
    const camera = new PerspectiveCamera(fovDeg, width / height, 0.1, 1000)
    camera.position.copy(EYE)
    camera.lookAt(TARGET)
    camera.updateMatrixWorld()

    const matrix = camera.matrixWorld
    const basis: CameraWorldBasis = {
      right: toTuple(new ThreeVector3().setFromMatrixColumn(matrix, 0)),
      up: toTuple(new ThreeVector3().setFromMatrixColumn(matrix, 1)),
      forward: toTuple(new ThreeVector3().setFromMatrixColumn(matrix, 2).negate()),
    }
    const pose = cameraPoseToColmap(
      { position: toTuple(EYE), rotation: cameraQuaternionFromBasis(basis, 'three'), coordinateFrame: 'project-local' },
      { sourceCameraConvention: 'three' },
    )

    const [qw, qx, qy, qz] = pose.qvec
    const worldToCamera = new ThreeQuaternion(qx, qy, qz, qw)
    const translation = new ThreeVector3(pose.tvec[0], pose.tvec[1], pose.tvec[2])

    const worldPoints = [
      new ThreeVector3(-1, 0.5, -4),
      new ThreeVector3(2, 2.5, -6),
      new ThreeVector3(-4, -1, -2),
    ]

    for (const point of worldPoints) {
      const ndc = point.clone().project(camera)
      const uThree = ((ndc.x + 1) / 2) * width
      const vThree = ((1 - ndc.y) / 2) * height

      const cameraPoint = point.clone().applyQuaternion(worldToCamera).add(translation)
      expect(cameraPoint.z).toBeGreaterThan(0)
      const uColmap = (focal * cameraPoint.x) / cameraPoint.z + width / 2
      const vColmap = (focal * cameraPoint.y) / cameraPoint.z + height / 2

      expect(uColmap).toBeCloseTo(uThree, 6)
      expect(vColmap).toBeCloseTo(vThree, 6)
    }
  })

  it('colmap 的 tvec 把相机中心送回原点,而不是把中心当成平移', () => {
    const pose = cameraPoseToColmap(
      { position: toTuple(EYE), rotation: SAMPLE, coordinateFrame: 'project-local' },
      { sourceCameraConvention: 'three' },
    )
    const [qw, qx, qy, qz] = pose.qvec
    const cameraPoint = EYE.clone()
      .applyQuaternion(new ThreeQuaternion(qx, qy, qz, qw))
      .add(new ThreeVector3(pose.tvec[0], pose.tvec[1], pose.tvec[2]))
    expect(cameraPoint.x).toBeCloseTo(0, 10)
    expect(cameraPoint.y).toBeCloseTo(0, 10)
    expect(cameraPoint.z).toBeCloseTo(0, 10)
  })
})
