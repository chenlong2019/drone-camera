import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

export type BuildPass =
  'blockout' | 'structure' | 'form' | 'material' | 'lighting' | 'interaction' | 'optimization'
type V3 = [number, number, number]

/**
 * 「机械哈士奇」机体建模 —— 程序化 Mesh 重建(零外部资产),迁自 img2threejs 沙盒的
 * AERIS 展示页(作者参考图驱动)。单位为比例单位,Y-up,**+Z 前向**(哈士奇头朝 +Z;
 * 无人机链路约定 -Z 前向,由文件尾的 `createHuskyDroneModel()` 适配层负责翻转)。
 *
 * 本段只负责"造形":按 blockout→structure→form→material→lighting→interaction→
 * optimization 的建造档位输出一个带部件/关节元数据的 THREE.Group;
 * 语义 ID(CTRL_DJI_Root / CTRL_Arm_*_Fold / CTRL_Prop_*_Spin / 云台三轴等)由
 * 适配层补挂 —— 本段不感知无人机仿真链路。
 */
export function createDroneModel(options: { pass?: BuildPass } = {}): THREE.Group {
  const pass = options.pass ?? 'optimization'
  const structured = pass !== 'blockout'
  const formed = !['blockout', 'structure'].includes(pass)
  const colored = !['blockout', 'structure', 'form'].includes(pass)
  const bodyLengthScale = 1.35
  const headShiftZ = 0.95 * (bodyLengthScale - 1)
  const armShiftZ = 0.78 * (bodyLengthScale - 1)
  const root = new THREE.Group()
  root.name = 'drone-root'
  const nodes: Record<string, THREE.Object3D> = { 'drone-root': root }
  const sockets: Record<string, THREE.Object3D> = {}
  const parts: THREE.Group[] = []
  const rotors: THREE.Group[] = []
  const clay = new THREE.MeshStandardMaterial({
    name: 'blockout-clay',
    color: 0x7c8994,
    roughness: 0.58,
    metalness: 0.12,
  })
  const pbr = (
    name: string,
    color: number,
    metalness: number,
    roughness: number,
    extra: THREE.MeshPhysicalMaterialParameters = {},
  ) => new THREE.MeshPhysicalMaterial({ name, color, metalness, roughness, ...extra })
  // Solid coatings from the reference. Relief, seams and machined recesses are modeled, not painted lighting.
  const materials = {
    graphite: pbr('graphite-anodized-shell', 0x303540, 0.76, 0.34),
    deck: pbr('satin-machined-deck', 0x777d89, 0.82, 0.3),
    rail: pbr('machined-arm-alloy', 0x434e60, 0.82, 0.28),
    silver: pbr('brushed-motor-aluminium', 0x8b97a9, 0.94, 0.26),
    edge: pbr('polished-machined-edge', 0xa4b1c0, 0.94, 0.19),
    black: pbr('recess-and-rubber', 0x070c13, 0.08, 0.7),
    dark: pbr('black-anodized-motor-stator', 0x121924, 0.74, 0.36),
    yellow: pbr('safety-yellow-propeller', 0xffc51b, 0.18, 0.28, {
      clearcoat: 0.44,
      clearcoatRoughness: 0.19,
    }),
    gold: pbr('gold-motor-collar', 0xd9a821, 0.72, 0.25),
    powerLed: pbr('power-green-led', 0x5bd98c, 0.05, 0.28, {
      emissive: 0x35ef72,
      emissiveIntensity: 1.1,
    }),
    blue: pbr('cyan-light-guide', 0x0c85e9, 0.1, 0.22, {
      emissive: 0x039eff,
      emissiveIntensity: 3.4,
    }),
    eye: pbr('cyan-eye-emitter', 0x057dc2, 0.12, 0.2, {
      emissive: 0x007cce,
      emissiveIntensity: 1.1,
    }),
    amber: pbr('amber-navigation-led', 0xffbd45, 0.12, 0.27, {
      emissive: 0xffa922,
      emissiveIntensity: 2.8,
    }),
    redLed: pbr('red-navigation-led', 0x980919, 0.1, 0.25, {
      emissive: 0xff0823,
      emissiveIntensity: 3.0,
    }),
    lens: pbr('blue-coated-optical-glass', 0x05102c, 0.55, 0.09, {
      clearcoat: 1,
      clearcoatRoughness: 0.0525,
      emissive: 0x022762,
      emissiveIntensity: 0.18,
    }),
    iris: pbr('deep-optical-aperture', 0x01030a, 0.24, 0.14, { clearcoat: 0.8 }),
    opticRing: pbr('blue-optic-ring', 0x12397b, 0.68, 0.15, {
      emissive: 0x034fbc,
      emissiveIntensity: 0.75,
    }),
    guard: pbr('dark-blue-guard-frame', 0x203855, 0.78, 0.25),
    huskyWhite: pbr('husky-ceramic-white', 0xcbd3dd, 0.32, 0.36, {
      clearcoat: 0.24,
      clearcoatRoughness: 0.26,
    }),
    nose: pbr('nose-graphite', 0x10151d, 0.18, 0.3, { clearcoat: 0.4, clearcoatRoughness: 0.22 }),
  }
  function materialFor(parent: THREE.Object3D, name: string): THREE.Material {
    if (!colored) return clay
    const partId = parent.name
    if (name.startsWith('screw-')) return materials.silver
    if (partId === 'beast-head' || partId === 'jaw') {
      if (name === 'muzzle-chin' || name === 'armor-mandible') return materials.graphite
      if (name.startsWith('mask-') || name === 'husky-muzzle') return materials.huskyWhite
      if (name === 'nose-shell') return materials.nose
      if (
        name.startsWith('nostril') ||
        name.startsWith('ear-inset') ||
        name.startsWith('mouth-seam')
      )
        return materials.black
      if (name.startsWith('ear-shell')) return materials.deck
      if (name.startsWith('ear-inner-panel')) return materials.graphite
      if (name.startsWith('eye-iris')) return materials.lens
      if (name === 'armor-face-mask' || name.startsWith('armor-crown')) return materials.graphite
    }
    if (name.startsWith('eye-light')) return materials.eye
    if (name.startsWith('tooth-')) return materials.edge
    if (name.includes('scanner-light')) return materials.blue
    if (name.includes('sole') || name.includes('socket')) return materials.black
    if (
      name.startsWith('recess-') ||
      name.includes('gasket') ||
      name.includes('cable') ||
      name.includes('vent-') ||
      name.includes('isolator') ||
      name.includes('damping')
    )
      return materials.black
    if (name.includes('pupil')) return materials.iris
    if (partId.startsWith('guard-'))
      return name === 'ring' || name === 'outer-rail'
        ? materials.blue
        : name.includes('clip')
          ? materials.silver
          : name.includes('support')
            ? materials.dark
            : materials.guard
    if (partId.startsWith('rotor-'))
      return name.startsWith('blade')
        ? materials.yellow
        : name === 'hub-cap'
          ? materials.dark
          : materials.silver
    if (partId.startsWith('motor-')) {
      if (name === 'status-led' || name === 'bottom-glow') return materials.amber
      if (name === 'blue-can-band') return materials.blue
      if (name === 'can-upper-band' || name === 'top-collar') return materials.gold
      if (name === 'silver-can') return materials.silver
      if (
        name.includes('band') ||
        name.includes('bell-rib') ||
        name === 'shaft' ||
        name === 'lower-neck'
      )
        return materials.edge
      if (name.includes('cooling-fin')) return materials.rail
      return materials.dark
    }
    if (partId.startsWith('arm-'))
      return name.includes('blue-trim')
        ? materials.blue
        : name.includes('spar') || name.includes('rail')
          ? materials.silver
          : name.includes('slotted')
            ? materials.rail
            : materials.graphite
    if (name.includes('light-strip') || name.includes('blue-trim')) return materials.blue
    if (name.startsWith('power-led-')) return materials.powerLed
    if (name.includes('power-seat')) return materials.black
    if (name.includes('rim') || name.includes('fastener') || name.includes('hydraulic'))
      return materials.silver
    if (name.startsWith('armor-'))
      return name.includes('inset') || name.includes('brow') ? materials.graphite : materials.deck
    if (name.includes('drum') || name.includes('joint')) return materials.dark
    if (name === 'skull-shell') return materials.graphite
    if (partId === 'landing-gear')
      return name.includes('rubber')
        ? materials.black
        : name.includes('strut')
          ? materials.rail
          : materials.graphite
    if (partId === 'gimbal') {
      if (name.includes('glass')) return materials.lens
      if (name === 'camera-status') return materials.blue
      if (name.startsWith('focus-ring'))
        return name.endsWith('-4') ? materials.opticRing : materials.dark
      if (name.includes('pitch-') || name.includes('fork-')) return materials.silver
      if (name === 'camera-bezel') return materials.dark
      return materials.graphite
    }
    if (name.startsWith('power-led-')) return materials.powerLed
    if (name.startsWith('power-icon-')) return materials.silver
    if (name.startsWith('power-')) return materials.black
    if (name.startsWith('front-status')) return materials.redLed
    if (name.includes('light-strip') || name.includes('led-cell') || name.includes('side-status'))
      return materials.blue
    if (name.includes('recess')) return materials.black
    if (name.startsWith('split-top') || name.startsWith('top-shoulder')) return materials.deck
    if (name === 'lower-skirt') return materials.dark
    return materials.graphite
  }
  function part(id: string, label: string, position: V3): THREE.Group {
    const group = new THREE.Group()
    group.name = id
    group.position.set(...position)
    group.userData = {
      componentId: id,
      partId: id,
      label,
      destructionGroup: id,
      collider: { shape: 'box' },
    }
    root.add(group)
    nodes[id] = group
    parts.push(group)
    const socket = new THREE.Object3D()
    socket.name = `socket-${id}`
    socket.position.set(...position)
    root.add(socket)
    sockets[id] = socket
    return group
  }
  function mesh(
    parent: THREE.Object3D,
    name: string,
    geometry: THREE.BufferGeometry,
    p: V3 = [0, 0, 0],
  ) {
    const object = new THREE.Mesh(geometry, materialFor(parent, name))
    object.name = `${parent.name}-${name}`
    object.position.set(...p)
    object.castShadow = true
    object.receiveShadow = true
    object.userData = { explodeWithParent: true, componentId: parent.name }
    parent.add(object)
    return object
  }
  function box(parent: THREE.Object3D, name: string, size: V3, p: V3 = [0, 0, 0]) {
    const geometry = formed
      ? new RoundedBoxGeometry(...size, 2, Math.min(0.055, Math.min(...size) * 0.2))
      : new THREE.BoxGeometry(...size)
    return mesh(parent, name, geometry, p)
  }
  function cylinder(
    parent: THREE.Object3D,
    name: string,
    r: number,
    h: number,
    p: V3,
    axis: 'x' | 'y' | 'z' = 'y',
  ) {
    const m = mesh(parent, name, new THREE.CylinderGeometry(r, r, h, 40), p)
    if (axis === 'x') m.rotation.z = Math.PI / 2
    if (axis === 'z') m.rotation.x = Math.PI / 2
    return m
  }
  function ring(
    parent: THREE.Object3D,
    name: string,
    r: number,
    t: number,
    p: V3,
    axis: 'x' | 'y' | 'z' = 'y',
  ) {
    const m = mesh(parent, name, new THREE.TorusGeometry(r, t, 8, 64), p)
    if (axis === 'y') m.rotation.x = Math.PI / 2
    if (axis === 'x') m.rotation.y = Math.PI / 2
    return m
  }
  function rod(parent: THREE.Object3D, name: string, a: V3, b: V3, r: number) {
    const start = new THREE.Vector3(...a),
      end = new THREE.Vector3(...b),
      delta = end.clone().sub(start)
    const m = cylinder(
      parent,
      name,
      r,
      delta.length(),
      start.add(end).multiplyScalar(0.5).toArray() as V3,
    )
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize())
    return m
  }
  function slotPanel(
    parent: THREE.Object3D,
    name: string,
    length: number,
    height: number,
    depth: number,
    p: V3,
  ) {
    const roundedPath = (
      path: THREE.Path,
      x: number,
      y: number,
      w: number,
      h: number,
      r: number,
    ) => {
      if (r <= 0) {
        path.moveTo(x, y)
        path.lineTo(x + w, y)
        path.lineTo(x + w, y + h)
        path.lineTo(x, y + h)
        path.closePath()
        return
      }
      path.moveTo(x + r, y)
      path.lineTo(x + w - r, y)
      path.quadraticCurveTo(x + w, y, x + w, y + r)
      path.lineTo(x + w, y + h - r)
      path.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
      path.lineTo(x + r, y + h)
      path.quadraticCurveTo(x, y + h, x, y + h - r)
      path.lineTo(x, y + r)
      path.quadraticCurveTo(x, y, x + r, y)
      path.closePath()
    }
    const s = new THREE.Shape()
    roundedPath(s, 0, -height / 2, length, height, formed ? 0.035 : 0.025)
    const hole = new THREE.Path()
    const x0 = 0.2,
      x1 = length - 0.2,
      h = height * 0.19
    roundedPath(hole, x0, -h, x1 - x0, h * 2, h * 0.95)
    s.holes.push(hole)
    const geometry = new THREE.ExtrudeGeometry(s, {
      depth: depth - (formed ? 0.008 : 0),
      steps: 1,
      bevelEnabled: formed,
      bevelThickness: 0.004,
      bevelSize: 0.004,
      bevelSegments: 1,
      curveSegments: 6,
    })
    geometry.translate(0, 0, -depth / 2 + (formed ? 0.004 : 0))
    return mesh(parent, name, geometry, p)
  }
  function screw(
    parent: THREE.Object3D,
    name: string,
    p: V3,
    axis: 'x' | 'y' | 'z' = 'y',
    r = 0.032,
  ) {
    if (axis === 'x') {
      const inner = r * 0.43
      const profile = [
        [inner, -0.006],
        [r, -0.006],
        [r, 0.003],
        [r - 0.002, 0.006],
        [inner + 0.001, 0.006],
        [inner, 0.004],
        [inner, -0.006],
      ].map(([x, y]) => new THREE.Vector2(x, y))
      const geometry = new THREE.LatheGeometry(profile, 40)
      geometry.normalizeNormals()
      const object = mesh(parent, 'screw-' + name, geometry, p)
      object.rotation.z = Math.PI / 2
      cylinder(parent, 'recess-' + name, inner, 0.004, p, axis)
      return
    }
    const shape = new THREE.Shape()
    shape.absarc(0, 0, r, 0, Math.PI * 2, false)
    const hole = new THREE.Path()
    for (let i = 0; i < 6; i++) {
      const a = (-i * Math.PI) / 3
      const x = Math.cos(a) * r * 0.43,
        y = Math.sin(a) * r * 0.43
      i ? hole.lineTo(x, y) : hole.moveTo(x, y)
    }
    hole.closePath()
    shape.holes.push(hole)
    // Preserve a crisp, closed hex recess: tiny inward bevels can fold through its corners.
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 0.012,
      bevelEnabled: false,
      curveSegments: 8,
    })
    geometry.translate(0, 0, -0.006)
    const m = mesh(parent, 'screw-' + name, geometry, p)
    if (axis === 'y') m.rotation.x = -Math.PI / 2
    cylinder(parent, 'recess-' + name, r * 0.85, 0.007, p, axis)
  }
  function cable(parent: THREE.Object3D, name: string, points: V3[], radius = 0.011) {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)))
    return mesh(parent, name, new THREE.TubeGeometry(curve, 24, radius, 6, false))
  }
  // Closed octagonal lofts give the armor a changing cross-section, with real planar facets.
  function armor(
    parent: THREE.Object3D,
    name: string,
    sections: { z: number; w: number; b: number; t: number }[],
    p: V3 = [0, 0, 0],
  ) {
    const positions: number[] = [],
      indices: number[] = []
    for (const s of sections) {
      const bevel = (s.t - s.b) * 0.24
      for (const [x, y] of [
        [-s.w * 0.7, s.b],
        [s.w * 0.7, s.b],
        [s.w, s.b + bevel],
        [s.w, s.t - bevel],
        [s.w * 0.68, s.t],
        [-s.w * 0.68, s.t],
        [-s.w, s.t - bevel],
        [-s.w, s.b + bevel],
      ] as const)
        positions.push(x, y, s.z)
    }
    for (let i = 0; i < sections.length - 1; i++)
      for (let j = 0; j < 8; j++) {
        const a = i * 8 + j,
          b = i * 8 + ((j + 1) % 8),
          c = a + 8,
          d = b + 8
        indices.push(a, b, c, b, d, c)
      }
    for (const [k, front] of [
      [0, false],
      [sections.length - 1, true],
    ] as [number, boolean][]) {
      const s = sections[k]!,
        c = positions.length / 3
      positions.push(0, (s.b + s.t) / 2, s.z)
      for (let j = 0; j < 8; j++) {
        const a = k * 8 + j,
          b = k * 8 + ((j + 1) % 8)
        indices.push(c, front ? a : b, front ? b : a)
      }
    }
    const indexed = new THREE.BufferGeometry()
    indexed.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    indexed.setIndex(indices)
    const geometry = indexed.toNonIndexed()
    indexed.dispose()
    geometry.computeVertexNormals()
    return mesh(parent, name, geometry, p)
  }
  function plate(
    parent: THREE.Object3D,
    name: string,
    outline: [number, number][],
    depth: number,
    p: V3,
    rotation: V3 = [0, 0, 0],
  ) {
    const shape = new THREE.Shape()
    outline.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)))
    shape.closePath()
    const bevel =
      formed &&
      !name.startsWith('armor-jowl') &&
      !name.startsWith('ear-') &&
      !name.startsWith('mask-cheek')
        ? Math.min(depth * 0.16, 0.018)
        : 0
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: depth - 2 * bevel,
      bevelEnabled: bevel > 0,
      bevelSize: bevel,
      bevelThickness: bevel,
      bevelSegments: 1,
      steps: 1,
      curveSegments: 1,
    })
    geometry.translate(0, 0, -depth / 2 + bevel)
    const object = mesh(parent, name, geometry, p)
    object.rotation.set(...rotation)
    return object
  }
  function armoredLink(
    parent: THREE.Object3D,
    name: string,
    a: V3,
    b: V3,
    width: number,
    thickness: number,
  ) {
    const start = new THREE.Vector3(...a),
      end = new THREE.Vector3(...b),
      delta = end.clone().sub(start),
      length = delta.length()
    const object = armor(
      parent,
      name,
      [
        { z: 0, w: width * 0.32, b: -thickness * 0.34, t: thickness * 0.34 },
        { z: length * 0.18, w: width * 0.5, b: -thickness * 0.5, t: thickness * 0.5 },
        { z: length * 0.68, w: width * 0.45, b: -thickness * 0.45, t: thickness * 0.45 },
        { z: length, w: width * 0.26, b: -thickness * 0.27, t: thickness * 0.27 },
      ],
      a,
    )
    object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), delta.normalize())
    return object
  }
  function bladeGeometry() {
    // Closed variable-section airfoil. Rounded cross-sections taper and twist along the radius.
    const outline = new THREE.CatmullRomCurve3(
      [
        [0.09, 0.065, 0],
        [0.18, 0.105, 0],
        [0.3, 0.245, 0.025],
        [0.46, 0.31, 0.045],
        [0.64, 0.29, 0.055],
        [0.82, 0.24, 0.058],
        [0.98, 0.15, 0.03],
        [1.08, 0.065, 0.005],
        [1.105, 0.008, 0],
      ].map((v) => new THREE.Vector3(...v)),
    )
    const positions: number[] = [],
      indices: number[] = []
    const sections = 32,
      sides = 12
    for (let i = 0; i <= sections; i++) {
      const t = i / sections,
        p = outline.getPoint(t),
        thickness = 0.021 * (1 - 0.65 * t)
      for (let j = 0; j < sides; j++) {
        const a = (j * Math.PI * 2) / sides,
          z = (Math.cos(a) * p.y) / 2
        positions.push(p.x, Math.sin(a) * thickness + z * (0.3 - 0.18 * t), p.z + z)
      }
    }
    for (let i = 0; i < sections; i++)
      for (let j = 0; j < sides; j++) {
        const a = i * sides + j,
          b = i * sides + ((j + 1) % sides),
          c = a + sides,
          d = b + sides
        indices.push(a, c, b, b, c, d)
      }
    const first = positions.length / 3
    positions.push(0.09, 0, 0)
    const last = positions.length / 3
    positions.push(1.105, 0, 0)
    for (let j = 0; j < sides; j++) {
      const n = (j + 1) % sides
      indices.push(first, j, n, last, sections * sides + n, sections * sides + j)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    return geometry
  }
  const body = part('chassis', '长脊装甲机身', [0, 0, 0])
  armor(body, 'armor-backbone', [
    { z: -1.55, w: 0.78, b: -0.25, t: 0.44 },
    { z: -1.35, w: 0.96, b: -0.43, t: 0.74 },
    { z: -0.3, w: 0.97, b: -0.46, t: 0.8 },
    { z: 0.75, w: 0.86, b: -0.42, t: 0.56 },
    { z: 0.95, w: 0.63, b: -0.24, t: 0.32 },
  ])
  box(body, 'belly-core', [1.45, 0.37, 2.0], [0, -0.54, -0.25])
  if (structured) {
    armor(body, 'armor-dorsal-crown', [
      { z: -1.34, w: 0.57, b: 0.65, t: 0.73 },
      { z: -0.38, w: 0.65, b: 0.7, t: 0.84 },
      { z: 0.3, w: 0.49, b: 0.67, t: 0.78 },
    ])
    box(body, 'belly-vent-recess', [1.5, 0.17, 1.84], [0, -0.66, -0.21])
    box(body, 'rear-access-panel', [1.21, 0.35, 0.038], [0, -0.01, -1.557])
    box(body, 'rear-light-strip', [0.68, 0.04, 0.025], [0, 0.21, -1.586])
    for (const side of [-1, 1]) {
      const id = side < 0 ? 'l' : 'r'
      box(body, 'power-seat-' + id, [0.025, 0.2, 1.12], [side * 0.967, 0.24, -0.64])
      for (let i = 0; i < 4; i++) {
        const z = -1.045 + i * 0.255
        cylinder(body, 'power-seat-' + id + '-' + i, 0.049, 0.027, [side * 0.986, 0.26, z], 'x')
        cylinder(body, 'power-led-' + id + '-' + i, 0.034, 0.015, [side * 1.003, 0.26, z], 'x')
      }
      cylinder(body, 'side-power-ring-' + id, 0.071, 0.025, [side * 0.98, -0.045, -0.7], 'x')
      ring(body, 'blue-trim-power-' + id, 0.073, 0.009, [side * 0.998, -0.045, -0.7], 'x')
      for (let i = 0; i < 16; i++)
        box(
          body,
          'belly-cooling-fin-' + id + '-' + i,
          [0.048, 0.17, 0.032],
          [side * 0.776, -0.64, -0.98 + i * 0.104],
        )
      plate(
        body,
        'armor-lower-flank-' + id,
        [
          [-0.82, 0.07],
          [0.51, 0.08],
          [0.7, -0.1],
          [0.53, -0.23],
          [-0.75, -0.23],
        ],
        0.09,
        [side * 0.83, -0.31, -0.21],
        [0, Math.PI / 2, 0],
      )
    }
  }
  if (formed) {
    for (const side of [-1, 1]) {
      for (const z of [-1.1, -0.65, -0.2, 0.25])
        screw(body, 'flank-' + side + '-' + z, [side * 0.98, 0.09, z], 'x', 0.023)
      box(body, 'side-gasket-' + side, [0.014, 0.022, 1.12], [side * 0.967, -0.17, -0.64])
      box(body, 'rear-panel-seam-' + side, [0.015, 0.008, 0.68], [side * 0.44, 0.776, -0.81])
    }
    armor(body, 'armor-service-hatch', [
      { z: -1.15, w: 0.26, b: 0.763, t: 0.78 },
      { z: -0.72, w: 0.26, b: 0.794, t: 0.81 },
    ])
    for (const x of [-0.2, 0.2]) screw(body, 'hatch-' + x, [x, 0.802, -0.79], 'y', 0.018)
    for (const x of [-0.44, 0.44]) screw(body, 'rear-access-' + x, [x, 0.03, -1.584], 'z', 0.029)
  }
  // Extend the torso in its own frame, keeping lamps, buttons and fasteners round.
  // The articulated assemblies are translated separately, so no parent scale distorts them.
  const bodyStretch = new THREE.Matrix4().makeScale(1, 1, bodyLengthScale)
  for (const child of body.children) {
    if (!(child instanceof THREE.Mesh)) continue
    child.position.z *= bodyLengthScale
    const roundHardware =
      ['CylinderGeometry', 'TorusGeometry'].includes(child.geometry.type) ||
      child.name.startsWith('chassis-screw-') ||
      child.name.startsWith('chassis-recess-')
    if (roundHardware) continue
    const rotation = new THREE.Matrix4().makeRotationFromQuaternion(child.quaternion)
    const localStretch = rotation.clone().invert().multiply(bodyStretch).multiply(rotation)
    child.geometry.applyMatrix4(localStretch)
  }
  const head = part('beast-head', '机械哈士奇头部', [0, 0.18, 0.62 + headShiftZ])
  const mirrored = (points: [number, number][], side: number) =>
    points.map(([x, y]) => [x * side, y] as [number, number])
  function roundedOutline(points: [number, number][], radius = 0.02): THREE.Shape {
    const shape = new THREE.Shape()
    points.forEach(([x, y], i) => {
      const a = new THREE.Vector2(...points[(i + points.length - 1) % points.length]!),
        b = new THREE.Vector2(x, y),
        c = new THREE.Vector2(...points[(i + 1) % points.length]!)
      const cut = Math.min(radius, b.distanceTo(a) * 0.24, b.distanceTo(c) * 0.24)
      const enter = b.clone().add(a.sub(b).normalize().multiplyScalar(cut)),
        leave = b.clone().add(c.sub(b).normalize().multiplyScalar(cut))
      if (i === 0) shape.moveTo(enter.x, enter.y)
      else shape.lineTo(enter.x, enter.y)
      shape.quadraticCurveTo(x, y, leave.x, leave.y)
    })
    shape.closePath()
    return shape
  }
  // A thick, closed curved panel. Eye/nostril holes are real extruded tunnels.
  // Subdivision follows the surface equation; analytic cap normals keep the coatings smooth.
  function curvedPanel(
    parent: THREE.Object3D,
    name: string,
    shape: THREE.Shape,
    depth: number,
    surface: (x: number, y: number) => number,
    subdivisions = 1,
  ) {
    // Normalize both loops explicitly: mirrored outlines must not reverse tunnel walls.
    const contours = shape.extractPoints(6)
    const outline = THREE.ShapeUtils.isClockWise(contours.shape)
      ? contours.shape
      : contours.shape.reverse()
    const profile = new THREE.Shape(outline)
    profile.holes = contours.holes.map(
      (points) => new THREE.Path(THREE.ShapeUtils.isClockWise(points) ? points.reverse() : points),
    )
    const base = new THREE.ExtrudeGeometry(profile, {
      depth,
      steps: 1,
      bevelEnabled: false,
      curveSegments: 6,
    })
    const source = base.getAttribute('position'),
      positions: number[] = [],
      normals: number[] = []
    const emit = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, level: number) => {
      if (level > 0) {
        const ab = a.clone().add(b).multiplyScalar(0.5),
          bc = b.clone().add(c).multiplyScalar(0.5),
          ca = c.clone().add(a).multiplyScalar(0.5)
        emit(a, ab, ca, level - 1)
        emit(ab, b, bc, level - 1)
        emit(ca, bc, c, level - 1)
        emit(ab, bc, ca, level - 1)
        return
      }
      const cap = Math.abs(a.z - b.z) < 1e-6 && Math.abs(a.z - c.z) < 1e-6
      const mapped = [a, b, c].map(
        (p) => new THREE.Vector3(p.x, p.y, surface(p.x, p.y) + p.z - depth),
      )
      const faceNormal = mapped[1]!
        .clone()
        .sub(mapped[0]!)
        .cross(mapped[2]!.clone().sub(mapped[0]!))
        .normalize()
      mapped.forEach((p, i) => {
        positions.push(p.x, p.y, p.z)
        const n = faceNormal.clone()
        if (cap) {
          const e = 0.0001,
            corner = [a, b, c][i]!,
            x = corner.x,
            y = corner.y
          n.set(
            -(surface(x + e, y) - surface(x - e, y)) / (2 * e),
            -(surface(x, y + e) - surface(x, y - e)) / (2 * e),
            1,
          )
            .normalize()
            .multiplyScalar(faceNormal.z < 0 ? -1 : 1)
        }
        normals.push(n.x, n.y, n.z)
      })
    }
    for (let i = 0; i < source.count; i += 3)
      emit(
        new THREE.Vector3().fromBufferAttribute(source, i),
        new THREE.Vector3().fromBufferAttribute(source, i + 1),
        new THREE.Vector3().fromBufferAttribute(source, i + 2),
        subdivisions,
      )
    base.dispose()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    return mesh(parent, name, geometry)
  }
  function roundedLoft(
    parent: THREE.Object3D,
    name: string,
    sections: { z: number; w: number; y: number; h: number; hUpper?: number }[],
    sides = 24,
    upperTaper = 0,
  ) {
    const positions: number[] = [],
      indices: number[] = []
    for (const s of sections)
      for (let j = 0; j < sides; j++) {
        const a = (j * Math.PI * 2) / sides,
          sin = Math.sin(a)
        positions.push(
          Math.cos(a) * s.w * (1 - upperTaper * Math.max(0, sin)),
          s.y + sin * (sin > 0 ? (s.hUpper ?? s.h) : s.h),
          s.z,
        )
      }
    for (let i = 0; i < sections.length - 1; i++)
      for (let j = 0; j < sides; j++) {
        const a = i * sides + j,
          b = i * sides + ((j + 1) % sides),
          c = a + sides,
          d = b + sides
        indices.push(a, b, c, b, d, c)
      }
    for (const [i, front] of [
      [0, false],
      [sections.length - 1, true],
    ] as [number, boolean][]) {
      const s = sections[i]!,
        center = positions.length / 3
      positions.push(0, s.y, s.z)
      for (let j = 0; j < sides; j++) {
        const a = i * sides + j,
          b = i * sides + ((j + 1) % sides)
        indices.push(center, front ? a : b, front ? b : a)
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    return mesh(parent, name, geometry)
  }
  roundedLoft(
    head,
    'skull-shell',
    [
      { z: -0.24, w: 0.48, y: 0.26, h: 0.55 },
      { z: -0.06, w: 0.68, y: 0.27, h: 0.72 },
      { z: 0.16, w: 0.77, y: 0.28, h: 0.8 },
      { z: 0.38, w: 0.78, y: 0.27, h: 0.8 },
      { z: 0.57, w: 0.72, y: 0.25, h: 0.75 },
      { z: 0.7, w: 0.64, y: 0.23, h: 0.66 },
    ],
    20,
  )
  const faceZ = (x: number, y: number) =>
    1.02 - 0.28 * (x / 0.8) ** 2 - (y > 0.3 ? 0.4 : 0.06) * ((y - 0.3) / 0.8) ** 2
  const faceOutline: [number, number][] = [
    [-0.48, -0.41],
    [-0.69, -0.16],
    [-0.765, 0.27],
    [-0.69, 0.7],
    [-0.43, 0.99],
    [0, 1.07],
    [0.43, 0.99],
    [0.69, 0.7],
    [0.765, 0.27],
    [0.69, -0.16],
    [0.48, -0.41],
  ]
  const eyeOutline: [number, number][] = [
    [-0.2, 0.018],
    [-0.15, -0.092],
    [0.07, -0.103],
    [0.19, 0.025],
    [0.18, 0.12],
    [0.055, 0.085],
  ]
  const faceShape = roundedOutline(faceOutline, 0.065)
  for (const side of [-1, 1])
    faceShape.holes.push(
      roundedOutline(
        eyeOutline.map(([x, y]) => [(0.39 + x) * side, 0.3 + y]),
        0.024,
      ),
    )
  curvedPanel(head, 'armor-face-mask', faceShape, 0.095, faceZ, 3)
  for (const side of [-1, 1]) {
    const id = side < 0 ? 'l' : 'r',
      eyeX = side * 0.39,
      eyeY = 0.3,
      eyeFront = faceZ(eyeX, eyeY)
    const aperture = roundedOutline(
      eyeOutline.map(([x, y]) => [(0.39 + x) * side, 0.3 + y]),
      0.025,
    )
    curvedPanel(
      head,
      'eye-socket-' + id,
      aperture,
      0.025,
      (x, y) => faceZ(x, y) - 0.092,
      1,
    ).material = colored ? materials.black : clay
    const optic = cylinder(
      head,
      'eye-optic-' + id,
      0.102,
      0.018,
      [eyeX, eyeY, eyeFront - 0.048],
      'z',
    )
    optic.rotation.y = side * 0.33
    optic.material = colored ? materials.lens : clay
    const iris = ring(head, 'eye-light-' + id, 0.074, 0.012, [eyeX, eyeY, eyeFront - 0.032], 'z')
    iris.rotation.y = side * 0.33
    const irisInner = ring(
      head,
      'eye-light-inner-' + id,
      0.058,
      0.004,
      [eyeX, eyeY, eyeFront - 0.031],
      'z',
    )
    irisInner.rotation.y = side * 0.33
    irisInner.material = colored ? materials.eye : clay
    const pupil = cylinder(
      head,
      'eye-iris-' + id,
      0.052,
      0.012,
      [eyeX, eyeY, eyeFront - 0.033],
      'z',
    )
    pupil.rotation.y = side * 0.33
    pupil.material = colored ? materials.iris : clay
    const glint = cylinder(
      head,
      'eye-catchlight-' + id,
      0.009,
      0.007,
      [eyeX - side * 0.022, eyeY + 0.035, eyeFront - 0.025],
      'z',
    )
    glint.rotation.y = side * 0.33
    glint.material = colored ? materials.eye : clay
    const brow: [number, number][] = [
      [0.12, 0.344],
      [0.215, 0.423],
      [0.278, 0.574],
      [0.382, 0.595],
      [0.468, 0.535],
      [0.644, 0.594],
      [0.574, 0.414],
      [0.314, 0.311],
    ]
    curvedPanel(
      head,
      'mask-eyebrow-' + id,
      roundedOutline(mirrored(brow, side), 0.025),
      0.026,
      (x, y) => faceZ(x, y) + 0.012,
      2,
    )
    const cheek: [number, number][] = [
      [0.712, 0.385],
      [0.617, 0.296],
      [0.549, 0.13],
      [0.373, 0.153],
      [0.304, 0.01],
      [0.244, -0.271],
      [0.438, -0.392],
      [0.664, -0.247],
      [0.754, 0.002],
    ]
    curvedPanel(
      head,
      'mask-cheek-' + id,
      roundedOutline(mirrored(cheek, side), 0.036),
      0.04,
      (x, y) => faceZ(x, y) + 0.022,
      2,
    )
    // A curved triangular rim surrounds a recessed ear bowl, with real taper in depth.
    const earPoints: [number, number][] = [
      [0.225, 0.785],
      [0.735, 0.768],
      [0.765, 0.875],
      [0.692, 1.494],
      [0.65, 1.6],
      [0.606, 1.544],
    ]
    const earInner: [number, number][] = [
      [0.337, 0.875],
      [0.66, 0.852],
      [0.684, 0.944],
      [0.639, 1.423],
      [0.606, 1.377],
    ]
    const earZ = (x: number, y: number) =>
      0.305 + 0.065 * Math.max(0, 1 - ((Math.abs(x) - 0.515) / 0.29) ** 2) - 0.045 * (y - 0.8)
    const earShape = roundedOutline(mirrored(earPoints, side), 0.018)
    earShape.holes.push(roundedOutline(mirrored(earInner, side), 0.019))
    curvedPanel(head, 'ear-shell-' + id, earShape, 0.14, earZ, 1)
    curvedPanel(
      head,
      'ear-inset-' + id,
      roundedOutline(mirrored(earInner, side), 0.022),
      0.03,
      (x, y) => earZ(x, y) - 0.092,
      1,
    )
    curvedPanel(
      head,
      'ear-inner-panel-' + id,
      roundedOutline(
        mirrored(
          [
            [0.407, 0.881],
            [0.515, 0.912],
            [0.621, 1.325],
            [0.605, 1.368],
            [0.474, 1.089],
          ],
          side,
        ),
        0.013,
      ),
      0.025,
      (x, y) => earZ(x, y) - 0.071,
      1,
    )
    if (structured) {
      plate(
        head,
        'armor-temple-' + id,
        [
          [-0.54, 0.06],
          [-0.4, 0.49],
          [-0.08, 0.6],
          [0.19, 0.35],
          [0.2, -0.12],
          [-0.04, -0.38],
          [-0.38, -0.31],
        ],
        0.1,
        [side * 0.714, 0.045, 0.12],
        [0, Math.PI / 2, 0],
      )
      plate(
        head,
        'armor-temple-inset-' + id,
        [
          [-0.445, 0.065],
          [-0.333, 0.389],
          [-0.1, 0.48],
          [0.1, 0.29],
          [0.11, -0.055],
          [-0.067, -0.26],
          [-0.292, -0.23],
        ],
        0.022,
        [side * 0.774, 0.045, 0.12],
        [0, Math.PI / 2, 0],
      )
      curvedPanel(
        head,
        'mask-ear-mount-' + id,
        roundedOutline(
          mirrored(
            [
              [0.282, 0.803],
              [0.41, 0.804],
              [0.416, 0.924],
              [0.35, 0.965],
            ],
            side,
          ),
          0.013,
        ),
        0.045,
        (x, y) => earZ(x, y) + 0.02,
        1,
      )
      if (formed) {
        for (const [y, z] of [
          [0.42, 0.21],
          [-0.16, 0.3],
        ] as const)
          screw(head, 'temple-' + id + y, [side * 0.784, y, z], 'x', 0.019)
        for (const [x, y] of [
          [0.696, 0.901],
          [0.675, 1.07],
        ] as const)
          screw(head, 'ear-' + id + y, [side * x, y, earZ(side * x, y) + 0.008], 'z', 0.012)
        screw(
          head,
          'brow-' + id,
          [side * 0.514, 0.506, faceZ(side * 0.514, 0.506) + 0.035],
          'z',
          0.012,
        )
      }
    }
  }
  const muzzleSections = [
    { z: 0.64, w: 0.45, y: -0.115, h: 0.315, hUpper: 0.335 },
    { z: 0.79, w: 0.465, y: -0.105, h: 0.317, hUpper: 0.37 },
    { z: 0.94, w: 0.445, y: -0.115, h: 0.294, hUpper: 0.4 },
    { z: 1.1, w: 0.404, y: -0.127, h: 0.264, hUpper: 0.34 },
    { z: 1.24, w: 0.349, y: -0.139, h: 0.235, hUpper: 0.27 },
    { z: 1.37, w: 0.286, y: -0.145, h: 0.202, hUpper: 0.205 },
    { z: 1.405, w: 0.238, y: -0.155, h: 0.185, hUpper: 0.185 },
  ]
  roundedLoft(head, 'husky-muzzle', muzzleSections, 24, 0.22)
  const noseShape = roundedOutline(
    [
      [-0.186, 0.069],
      [0.186, 0.069],
      [0.222, 0.021],
      [0.184, -0.076],
      [0.072, -0.141],
      [0, -0.153],
      [-0.072, -0.141],
      [-0.184, -0.076],
      [-0.222, 0.021],
    ],
    0.025,
  )
  for (const side of [-1, 1]) {
    const hole = new THREE.Path()
    hole.absellipse(side * 0.105, -0.03, 0.053, 0.036, 0, Math.PI * 2, true, -side * 0.22)
    noseShape.holes.push(hole)
  }
  const noseZ = (x: number, y: number) =>
    1.58 - 0.063 * (x / 0.225) ** 2 - 0.025 * ((y + 0.025) / 0.15) ** 2
  curvedPanel(head, 'nose-shell', noseShape, 0.14, noseZ, 3)
  for (const side of [-1, 1]) {
    const cavity = mesh(
      head,
      'nostril-cavity-' + (side < 0 ? 'l' : 'r'),
      new THREE.SphereGeometry(1, 20, 12),
      [side * 0.105, -0.03, noseZ(side * 0.105, -0.03) - 0.151],
    )
    cavity.scale.set(0.083, 0.06, 0.043)
    cavity.material = colored ? materials.black : clay
  }
  if (structured) {
    const cap = roundedOutline(
      [
        [-0.2, 0.63],
        [-0.27, 0.86],
        [-0.21, 1.013],
        [0, 1.07],
        [0.21, 1.013],
        [0.27, 0.86],
        [0.2, 0.63],
      ],
      0.027,
    )
    curvedPanel(head, 'armor-crown-panel', cap, 0.03, (x, y) => faceZ(x, y) + 0.01, 2)
    for (const side of [-1, 1]) {
      const forehead = roundedOutline(
        mirrored(
          [
            [0.268, 0.659],
            [0.308, 0.903],
            [0.417, 0.951],
            [0.589, 0.779],
            [0.654, 0.655],
            [0.522, 0.637],
            [0.431, 0.704],
          ],
          side,
        ),
        0.017,
      )
      curvedPanel(
        head,
        'armor-forehead-panel-' + side,
        forehead,
        0.025,
        (x, y) => faceZ(x, y) + 0.008,
        2,
      ).material = colored ? materials.rail : clay
    }
    curvedPanel(
      head,
      'mask-forehead-blaze',
      roundedOutline(
        [
          [-0.018, 0.466],
          [-0.025, 0.631],
          [0, 0.748],
          [0.025, 0.631],
          [0.018, 0.466],
        ],
        0.005,
      ),
      0.012,
      (x, y) => faceZ(x, y) + 0.023,
      1,
    )
    for (const side of [-1, 1]) {
      const bridge = roundedOutline(
        mirrored(
          [
            [0.035, 0.014],
            [0.151, 0.055],
            [0.123, 0.193],
            [0.043, 0.282],
          ],
          side,
        ),
        0.02,
      )
      curvedPanel(
        head,
        'mask-nose-bridge-' + side,
        bridge,
        0.024,
        (x, y) => 1.026 - 0.27 * (y / 0.31) ** 2 - 0.17 * (x / 0.46) ** 2,
        3,
      )
    }
  }
  const jaw = part('jaw', '闭合机械下颚', [0, -0.1, 0.97 + headShiftZ])
  roundedLoft(
    jaw,
    'armor-mandible',
    [
      { z: -0.12, w: 0.405, y: -0.025, h: 0.12 },
      { z: 0.12, w: 0.457, y: -0.065, h: 0.14 },
      { z: 0.41, w: 0.418, y: -0.13, h: 0.105 },
      { z: 0.7, w: 0.347, y: -0.132, h: 0.084 },
      { z: 0.94, w: 0.242, y: -0.105, h: 0.06 },
      { z: 1.035, w: 0.205, y: -0.098, h: 0.042 },
    ],
    20,
  )
  roundedLoft(jaw, 'muzzle-chin', [
    { z: 0.38, w: 0.412, y: -0.094, h: 0.078 },
    { z: 0.63, w: 0.371, y: -0.1, h: 0.072 },
    { z: 0.86, w: 0.278, y: -0.09, h: 0.057 },
    { z: 0.99, w: 0.226, y: -0.073, h: 0.046 },
    { z: 1.035, w: 0.198, y: -0.063, h: 0.032 },
  ])
  // Follow actual lower muzzle stations so the mouth stays a single fine closed seam.
  const lipPoints: V3[] = []
  for (const s of muzzleSections)
    lipPoints.push([Math.cos(Math.PI / 6) * s.w + 0.006, s.y - 0.5 * s.h + 0.278, s.z - 0.35])
  for (let i = 1; i < 8; i++) {
    const x = 0.206 * (1 - (2 * i) / 8)
    lipPoints.push([x, -0.02 + 0.0525 * (x / 0.206) ** 2, 1.064])
  }
  for (const s of [...muzzleSections].reverse())
    lipPoints.push([-Math.cos(Math.PI / 6) * s.w - 0.006, s.y - 0.5 * s.h + 0.278, s.z - 0.35])
  lipPoints.push([0, -0.035, 0.285])
  const lipCurve = new THREE.CatmullRomCurve3(
    lipPoints.map((p) => new THREE.Vector3(...p)),
    true,
    'centripetal',
  )
  const mouth = mesh(jaw, 'mouth-seam', new THREE.TubeGeometry(lipCurve, 192, 0.008, 8, true))
  mouth.material = colored ? materials.black : clay
  mouth.userData.tubeRadius = 0.008
  rod(head, 'mouth-philtrum', [0, -0.15, 1.417], [0, -0.3, 1.417], 0.007).material = colored
    ? materials.black
    : clay
  for (const side of [-1, 1]) {
    cylinder(jaw, 'jaw-hinge-' + side, 0.104, 0.12, [side * 0.47, 0.035, 0], 'x')
    if (structured) {
      ring(jaw, 'jaw-hinge-rim-' + side, 0.078, 0.008, [side * 0.542, 0.035, 0], 'x')
      if (formed) screw(jaw, 'jaw-pivot-' + side, [side * 0.554, 0.035, 0], 'x', 0.02)
    }
  }

  const legs: { upper: THREE.Group; lower: THREE.Group; foot: THREE.Group }[] = []
  for (const [id, side, front] of [
    ['fl', -1, true],
    ['fr', 1, true],
    ['rl', -1, false],
    ['rr', 1, false],
  ] as [string, number, boolean][]) {
    const legShiftZ = (front ? 0.78 : -1.0) * (bodyLengthScale - 1)
    const hip: V3 = [side * 0.95, -0.42, (front ? 0.78 : -1.0) + legShiftZ]
    const knee: V3 = [side * 1.16, -1.42, (front ? 0.32 : -1.45) + legShiftZ]
    const ankle: V3 = [side * 1.36, -2.37, (front ? 1.15 : -1.06) + legShiftZ]
    const upper = part('leg-upper-' + id, '髋关节与上腿 ' + id.toUpperCase(), hip)
    const kneeLocal = knee.map((v, i) => v - (hip[i] ?? 0)) as V3
    cylinder(upper, 'hip-drum', 0.31, 0.34, [side * 0.035, 0, 0], 'x')
    armoredLink(upper, 'armor-thigh', [0, -0.05, 0], kneeLocal, 0.48, 0.48)
    const lower = part('leg-lower-' + id, '膝关节与下腿 ' + id.toUpperCase(), knee)
    const ankleLocal = ankle.map((v, i) => v - (knee[i] ?? 0)) as V3
    cylinder(lower, 'knee-drum', 0.235, 0.38, [0, 0, 0], 'x')
    armoredLink(lower, 'armor-shin', [0, -0.02, 0], ankleLocal, 0.29, 0.3)
    const foot = part('foot-' + id, '机械支撑足 ' + id.toUpperCase(), ankle)
    cylinder(foot, 'ankle-drum', 0.125, 0.37, [0, 0.005, 0], 'x')
    armor(foot, 'armor-toe', [
      { z: -0.27, w: 0.17, b: -0.15, t: 0.025 },
      { z: -0.1, w: 0.225, b: -0.15, t: 0.095 },
      { z: 0.25, w: 0.23, b: -0.15, t: 0.015 },
      { z: 0.49, w: 0.16, b: -0.15, t: -0.09 },
    ])
    box(foot, 'sole', [0.38, 0.055, 0.63], [0, -0.1525, 0.075])
    if (structured) {
      const shoulderShape: [number, number][] = [
        [-0.23, 0.22],
        [0.04, 0.35],
        [0.31, 0.23],
        [0.39, -0.1],
        [0.19, -0.36],
        [-0.15, -0.31],
        [-0.31, -0.06],
      ]
      plate(
        upper,
        'armor-hip-cover',
        shoulderShape,
        0.16,
        [side * 0.225, 0, -0.02],
        [0, Math.PI / 2, 0],
      )
      plate(
        upper,
        'armor-hip-inset',
        shoulderShape.map(([x, y]) => [x * 0.8, y * 0.8]),
        0.025,
        [side * 0.315, 0, -0.02],
        [0, Math.PI / 2, 0],
      )
      cylinder(lower, 'knee-rim', 0.24, 0.04, [side * 0.214, 0, 0], 'x')
      cylinder(lower, 'knee-cap', 0.188, 0.035, [side * 0.248, 0, 0], 'x')
      ring(lower, 'knee-inner-rim', 0.151, 0.011, [side * 0.27, 0, 0], 'x')
      cylinder(lower, 'knee-center', 0.1, 0.026, [side * 0.273, 0, 0], 'x')
      armoredLink(
        upper,
        'armor-thigh-inset',
        [side * 0.13, -0.2, -0.08],
        [kneeLocal[0] + side * 0.13, kneeLocal[1] + 0.16, kneeLocal[2]],
        0.26,
        0.12,
      )
      armoredLink(
        lower,
        'armor-shin-inset',
        [side * 0.075, -0.2, 0.09],
        [ankleLocal[0] + side * 0.075, ankleLocal[1] + 0.18, ankleLocal[2] - 0.07],
        0.18,
        0.08,
      )
      rod(
        upper,
        'hydraulic-piston',
        [0, -0.18, 0.12],
        [kneeLocal[0], kneeLocal[1] + 0.08, kneeLocal[2] + 0.13],
        0.045,
      )
      for (const s of [-1, 1])
        ring(foot, 'ankle-rim-' + s, 0.102, 0.012, [s * 0.203, 0.005, 0], 'x')
      for (let i = 0; i < 2; i++)
        box(foot, 'toe-panel-seam-' + i, [0.008, 0.008, 0.23], [-0.065 + i * 0.13, -0.021, 0.22])
    }
    if (formed) {
      for (const [z, y] of [
        [-0.17, 0.12],
        [0.11, 0.22],
        [0.22, -0.09],
      ] as const)
        screw(upper, 'hip-' + z, [side * 0.34, y, z], 'x', 0.022)
      screw(lower, 'knee-fastener', [side * 0.297, 0, 0], 'x', 0.066)
      for (const t of [0.32, 0.65]) {
        const p = ankleLocal.map((v) => v * t) as V3
        screw(lower, 'shin-' + t, [(p[0] ?? 0) + side * 0.15, p[1] ?? 0, p[2] ?? 0], 'x', 0.023)
      }
      for (const s of [-1, 1]) screw(foot, 'ankle-' + s, [s * 0.227, 0.005, 0], 'x', 0.032)
      box(upper, 'hip-gold-mark', [0.01, 0.015, 0.16], [side * 0.335, 0.12, -0.04]).material =
        colored ? materials.gold : clay
    }
    legs.push({ upper, lower, foot })
  }
  for (const [id, x, baseZ] of [
    ['fl', -2.6, 1.4],
    ['fr', 2.6, 1.4],
    ['rl', -2.6, -1.4],
    ['rr', 2.6, -1.4],
  ] as [string, number, number][]) {
    const z = baseZ + Math.sign(baseZ) * armShiftZ
    const start = new THREE.Vector3(
      Math.sign(x) * 0.79,
      0.05,
      Math.sign(z) * 0.78 * bodyLengthScale,
    )
    const end = new THREE.Vector3(x, 0.05, z)
    const delta = end.clone().sub(start)
    const arm = part('arm-' + id, '承力机臂 ' + id.toUpperCase(), start.toArray() as V3)
    arm.rotation.y = -Math.atan2(delta.z, delta.x)
    const length = delta.length()
    if (!structured) box(arm, 'beam', [length, 0.22, 0.25], [length / 2, 0, 0])
    else {
      for (const side of [-1, 1])
        slotPanel(arm, 'slotted-web-' + side, length, 0.22, 0.045, [0, 0, side * 0.108])
      for (const y of [-0.115, 0.115])
        box(arm, 'spar-' + y, [length, 0.035, 0.23], [length / 2, y, 0])
      for (const xh of [0.07, length - 0.2]) {
        box(arm, 'hinge-block-' + xh, [0.24, 0.28, 0.3], [xh, 0, 0])
        cylinder(arm, 'hinge-pin-' + xh, 0.055, 0.31, [xh, 0.03, 0])
      }
      const braceElbow: V3 = [length * 0.61, -0.64, 0]
      armoredLink(arm, 'brace-root', [0.19, -0.13, 0], braceElbow, 0.17, 0.14)
      armoredLink(arm, 'brace-tip', braceElbow, [length - 0.13, -0.15, 0], 0.14, 0.12)
      cylinder(arm, 'brace-joint', 0.16, 0.21, braceElbow, 'z')
      ring(arm, 'brace-joint-rim', 0.121, 0.012, [braceElbow[0], braceElbow[1], 0.126], 'z')
      rod(
        arm,
        'blue-trim-brace',
        [0.36, -0.25, 0.082],
        [braceElbow[0] - 0.07, braceElbow[1] + 0.06, 0.082],
        0.008,
      )
      if (formed) {
        for (const side of [-1, 1]) {
          for (const px of [0.28, length - 0.35])
            screw(arm, 'side-' + side + px, [px, 0, side * 0.141], 'z', 0.026)
          box(
            arm,
            'top-rail-' + side,
            [length - 0.44, 0.012, 0.017],
            [length / 2, 0.142, side * 0.065],
          )
        }
        for (const px of [0.06, length - 0.19])
          screw(arm, 'pivot-' + px, [px, 0.195, 0], 'y', 0.044)
        cable(
          arm,
          'under-cable',
          [
            [0.15, -0.072, -0.075],
            [length * 0.45, -0.1, -0.06],
            [length * 0.78, -0.08, -0.065],
            [length - 0.1, -0.025, -0.065],
          ],
          0.012,
        )
      }
    }
    const motor = part('motor-' + id, '无刷电机 ' + id.toUpperCase(), [x, 0.32, z])
    if (!structured) mesh(motor, 'can', new THREE.CylinderGeometry(0.24, 0.24, 0.7, 32))
    else {
      cylinder(motor, 'stator', 0.26, 0.28, [0, -0.24, 0])
      cylinder(motor, 'lower-cap', 0.205, 0.075, [0, -0.412, 0])
      cylinder(motor, 'silver-can', 0.228, formed ? 0.39 : 0.25, [0, formed ? 0.145 : 0.055, 0])
      cylinder(motor, 'top-collar', 0.217, formed ? 0.06 : 0.065, [0, formed ? 0.355 : 0.215, 0])
      cylinder(motor, 'shaft', 0.091, formed ? 0.17 : 0.295, [0, formed ? 0.475 : 0.38, 0])
      ring(motor, 'can-lower-band', 0.228, 0.016, [0, -0.066, 0])
      ring(motor, 'can-upper-band', 0.23, 0.016, [0, formed ? 0.337 : 0.176, 0])
      cylinder(motor, 'vented-bell', 0.165, formed ? 0.05 : 0.06, [0, formed ? 0.425 : 0.28, 0])
      ring(motor, 'blue-can-band', 0.232, 0.008, [0, 0.11, 0])
      ring(motor, 'bottom-glow', 0.135, 0.016, [0, -0.46, 0])
      if (formed) {
        cylinder(motor, 'lower-neck', 0.225, 0.09, [0, -0.07, 0])
        ring(motor, 'stator-seam', 0.26, 0.008, [0, -0.115, 0])
        for (let j = 0; j < 20; j++) {
          const a = (j * Math.PI) / 10
          const fin = box(
            motor,
            'cooling-fin-' + j,
            [0.017, 0.19, 0.024],
            [Math.sin(a) * 0.258, -0.25, Math.cos(a) * 0.258],
          )
          fin.rotation.y = a
        }
        for (let j = 0; j < 12; j++) {
          const a = (j * Math.PI) / 6
          const rib = box(
            motor,
            'bell-rib-' + j,
            [0.031, 0.043, 0.048],
            [Math.sin(a) * 0.174, 0.41, Math.cos(a) * 0.174],
          )
          rib.rotation.y = a
        }
        for (let j = 0; j < 6; j++) {
          const a = (j * Math.PI) / 3
          screw(
            motor,
            'stator-' + j,
            [Math.sin(a) * 0.226, -0.096, Math.cos(a) * 0.226],
            'y',
            0.016,
          )
        }
        box(motor, 'status-led', [0.046, 0.065, 0.014], [0, -0.23, 0.274])
        cylinder(motor, 'bottom-axle', 0.09, 0.05, [0, -0.47, 0])
      }
    }
    const rotor = part('rotor-' + id, '三叶旋翼 ' + id.toUpperCase(), [x, 0.94, z])
    rotor.rotation.y = id === 'fl' || id === 'rr' ? 0.22 : -0.35
    mesh(rotor, 'hub', new THREE.CylinderGeometry(0.14, 0.14, 0.15, 24))
    if (!formed) {
      for (let j = 0; j < 3; j++) {
        const blade = box(rotor, 'blade-' + j, [0.89, 0.035, 0.16], [0, 0, 0])
        blade.geometry.translate(0.52, 0, 0)
        blade.rotation.y = (j * Math.PI * 2) / 3
      }
    } else {
      const geometry = bladeGeometry()
      for (let j = 0; j < 3; j++) {
        const blade = mesh(rotor, 'blade-' + j, geometry)
        blade.rotation.y = (j * Math.PI * 2) / 3
        blade.scale.setScalar(0.9)
      }
      cylinder(rotor, 'hub-cap', 0.089, 0.035, [0, 0.091, 0])
      screw(rotor, 'hub-lock', [0, 0.118, 0], 'y', 0.045)
    }
    rotors.push(rotor)
    const guard = part('guard-' + id, '蓝色保护圈 ' + id.toUpperCase(), [x, 0.77, z])
    mesh(guard, 'ring', new THREE.TorusGeometry(1.06, 0.009, 6, 80)).rotation.x = Math.PI / 2
    if (structured) {
      ring(guard, 'outer-rail', 1.079, 0.007, [0, -0.024, 0])
      for (let j = 0; j < 3; j++) {
        const angle = (j * Math.PI * 2) / 3 + Math.PI / 6
        rod(
          guard,
          'radial-support-' + j,
          [Math.cos(angle) * 0.205, -0.26, Math.sin(angle) * 0.205],
          [Math.cos(angle) * 1.06, -0.03, Math.sin(angle) * 1.06],
          0.014,
        )
      }
      if (formed) {
        for (let j = 0; j < 12; j++) {
          const a = (j * Math.PI) / 6
          const clip = box(
            guard,
            'perimeter-clip-' + j,
            [0.045, 0.041, 0.032],
            [Math.cos(a) * 1.07, -0.015, Math.sin(a) * 1.07],
          )
          clip.rotation.y = -a
        }
      }
    }
  }
  const parentIds: Record<string, string> = {
    chassis: 'drone-root',
    'beast-head': 'chassis',
    jaw: 'beast-head',
  }
  for (const corner of ['fl', 'fr', 'rl', 'rr']) {
    parentIds['arm-' + corner] = 'chassis'
    parentIds['motor-' + corner] = 'arm-' + corner
    parentIds['rotor-' + corner] = 'motor-' + corner
    parentIds['guard-' + corner] = 'motor-' + corner
    parentIds['leg-upper-' + corner] = 'chassis'
    parentIds['leg-lower-' + corner] = 'leg-upper-' + corner
    parentIds['foot-' + corner] = 'leg-lower-' + corner
  }
  // Colliders describe each part in its own frame, before installing the articulated hierarchy.
  for (const group of parts) {
    const bounds = new THREE.Box3()
    for (const child of group.children) {
      if (!(child instanceof THREE.Mesh)) continue
      child.updateMatrix()
      child.geometry.computeBoundingBox()
      if (child.geometry.boundingBox)
        bounds.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrix))
    }
    group.userData.collider = {
      shape: 'box',
      center: bounds.getCenter(new THREE.Vector3()).toArray(),
      halfExtents: bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5).toArray(),
    }
    group.userData.attachment = {
      parentId: parentIds[group.name],
      parentSocket: `socket-${group.name}`,
      contactType: group.name.startsWith('rotor') ? 'shaft' : 'mechanical-mount',
    }
  }
  if (['interaction', 'optimization'].includes(pass)) {
    root.updateMatrixWorld(true)
    for (const group of parts) {
      const parent = nodes[parentIds[group.name]!]!
      parent.attach(group)
      parent.attach(sockets[group.name]!)
    }
    for (const rotor of rotors) rotor.userData.joint = { type: 'continuous', axis: [0, 1, 0] }
    jaw.userData.joint = { type: 'revolute', axis: [1, 0, 0], limits: [-0.18, 0.22] }
    for (const leg of legs)
      for (const node of [leg.upper, leg.lower, leg.foot])
        node.userData.joint = { type: 'revolute', axis: [1, 0, 0], limits: [-0.25, 0.25] }
  }
  if (pass === 'optimization') {
    // Share byte-identical geometry and index repeated face vertices without changing any surface.
    const fingerprint = (geometry: THREE.BufferGeometry) => {
      let h1 = 2166136261,
        h2 = 5381,
        length = 0
      const arrays = Object.keys(geometry.attributes)
        .sort()
        .map((k) => geometry.attributes[k]!.array)
      if (geometry.index) arrays.push(geometry.index.array)
      for (const array of arrays) {
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
        length += bytes.length
        for (const value of bytes) {
          h1 = Math.imul(h1 ^ value, 16777619)
          h2 = Math.imul(h2, 33) ^ value
        }
      }
      return `${Object.keys(geometry.attributes).sort().join('-')}:${length}:${h1 >>> 0}:${h2 >>> 0}`
    }
    const cache = new Map<string, THREE.BufferGeometry>()
    const discarded = new Set<THREE.BufferGeometry>()
    let beforeMeshes = 0
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      beforeMeshes++
      const original = object.geometry,
        key = fingerprint(original)
      let shared = cache.get(key)
      if (!shared) {
        shared = mergeVertices(original, 1e-6)
        shared.clearGroups()
        cache.set(key, shared)
      }
      object.geometry = shared
      discarded.add(original)
    })
    // Batch only repeated copies of the SAME primitive within a part. Unlike a material-wide
    // merge, this keeps mechanically overlapping stators, housings and rails as separate solids.
    const containers: THREE.Object3D[] = []
    root.traverse((object) => {
      if (object.children.some((child) => child instanceof THREE.Mesh)) containers.push(object)
    })
    for (const container of containers) {
      const buckets = new Map<string, THREE.Mesh[]>()
      for (const child of container.children) {
        if (!(child instanceof THREE.Mesh) || Array.isArray(child.material)) continue
        // Closely spaced teeth keep their own closed solids and semantic boundaries.
        if (child.name.includes('tooth-')) continue
        // 桨叶必须保持独立网格:无人机适配层要按名字重命名成 PROP_*_Blade_*,
        // DroneRig 靠它们驱动自转/收纳叠拢(合并后三叶变一个整体网格,无法驱动)。
        if (child.name.includes('blade-')) continue
        // 电量灯珠同理:适配层要把左侧 4 颗升格为 LED_BatteryCharge_01..04 交给灯光系统驱动。
        if (child.name.includes('power-led-')) continue
        const key = child.geometry.uuid + child.material.uuid
        const bucket = buckets.get(key) ?? []
        bucket.push(child)
        buckets.set(key, bucket)
      }
      let batch = 0
      for (const copies of buckets.values()) {
        if (copies.length < 2) continue
        const transformed = copies.map((copy) => {
          copy.updateMatrix()
          return copy.geometry.clone().applyMatrix4(copy.matrix)
        })
        const merged = mergeGeometries(transformed, false)
        transformed.forEach((geometry) => geometry.dispose())
        if (!merged) throw new Error('Repeated drone geometry could not be batched.')
        const object = new THREE.Mesh(merged, copies[0]!.material)
        object.name = `${container.name}-repeated-${batch++}`
        object.castShadow = true
        object.receiveShadow = true
        object.userData = {
          ...copies[0]!.userData,
          sourceMeshes: copies.map((copy) => copy.name),
          repeatedSolidCount: copies.length,
        }
        copies.forEach((copy) => container.remove(copy))
        container.add(object)
      }
    }
    // Share the resulting repeated arrangements across the four identical motor stations, too.
    const finalCache = new Map<string, THREE.BufferGeometry>()
    let afterMeshes = 0
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      afterMeshes++
      const key = fingerprint(object.geometry),
        shared = finalCache.get(key)
      if (shared && shared !== object.geometry) {
        discarded.add(object.geometry)
        object.geometry = shared
      } else finalCache.set(key, object.geometry)
    })
    const retained = new Set(finalCache.values())
    discarded.forEach((geometry) => {
      if (!retained.has(geometry)) geometry.dispose()
    })
    root.userData.optimization = {
      beforeMeshes,
      afterMeshes,
      uniqueGeometries: finalCache.size,
      method:
        'shared buffers; indexed vertices; repeated non-intersecting primitives batched within each part',
      decimated: false,
    }
  }
  root.userData.sculptRuntime = {
    nodes,
    sockets,
    parts,
    rotors,
    jaw,
    legs,
    parentIds,
    colliders: parts.map((p) => ({ id: p.name, ...p.userData.collider })),
    destructionGroups: parts.map((p) => ({
      id: p.name,
      parentId: parentIds[p.name],
      parts: [p.name],
      seam: 'mechanical-mount',
    })),
  }
  root.userData.buildPass = pass
  root.userData.source =
    'User supplied mechanical-beast concept images; revision-v6 sculpted mechanical husky head'
  root.userData.proportions = {
    bodyLengthScale,
    bodyLength: 2.5 * bodyLengthScale,
    headShiftZ,
    armShiftZ,
  }
  root.userData.design =
    'Mechanical husky with upright ears and closed muzzle, elongated body, four tri-blade rotors'
  root.updateMatrixWorld(true)
  return root
}

// ═══════════════════════ 无人机链路适配层 ═══════════════════════
//
// 把上面的"纯造形"哈士奇改造成 DroneFly 语义机体。与积木机体(已移除)相同的三条
// 隐性契约在这里兑现:
//   1. 语义 ID 全量补挂(部件自检 50/50),功能性节点(CTRL_*)真正可驱动;
//   2. 前向对齐:哈士奇头朝 +Z,链路约定 -Z → 适配层绕竖轴翻转 180°;
//   3. 触地点交给 normalizeModel(全模型最低点=机足),适配层不手工对地。
// 所有补挂的网格/材质都在模型树内,随 DroneFly.destroy() 一并释放。

import type { ArmPosition } from './drone-rig'

/** 建一个命名节点并挂到父级 */
function huskyNode(parent: THREE.Object3D, name: string, position?: THREE.Vector3): THREE.Object3D {
  const node = new THREE.Object3D()
  node.name = name
  if (position) node.position.copy(position)
  parent.add(node)
  return node
}

/** 适配层自用材质(风格对齐哈士奇的石墨/蓝玻璃,不引用建模段闭包里的材质) */
interface HuskyAdapterMaterials {
  housing: THREE.MeshStandardMaterial
  glass: THREE.MeshStandardMaterial
  lens: THREE.MeshStandardMaterial
  led: THREE.MeshStandardMaterial
  decal: THREE.MeshStandardMaterial
  all: THREE.Material[]
}

function createHuskyAdapterMaterials(): HuskyAdapterMaterials {
  const housing = new THREE.MeshStandardMaterial({
    name: 'husky-gimbal-housing',
    color: 0x303540,
    roughness: 0.34,
    metalness: 0.76,
  })
  const glass = new THREE.MeshStandardMaterial({
    name: 'husky-sensor-glass',
    color: 0x0c2233,
    roughness: 0.16,
    metalness: 0.7,
    emissive: 0x039eff,
    emissiveIntensity: 0.55,
    side: THREE.DoubleSide,
  })
  const lens = new THREE.MeshStandardMaterial({
    name: 'husky-optical-lens',
    color: 0x05102c,
    roughness: 0.09,
    metalness: 0.55,
  })
  // 灯珠底色:DroneLights 装配时会就地换成自发光材质
  const led = new THREE.MeshStandardMaterial({
    name: 'husky-led-base',
    color: 0x14171c,
    roughness: 0.3,
    metalness: 0.1,
  })
  const decal = new THREE.MeshStandardMaterial({
    name: 'husky-decal-plate',
    color: 0x4c5563,
    roughness: 0.5,
    metalness: 0.3,
  })
  return { housing, glass, lens, led, decal, all: [housing, glass, lens, led, decal] }
}

/**
 * 造一台「机械哈士奇」语义机体:建模(createDroneModel)+ 语义适配。
 * 返回的模型可直接交给 DroneFly.initialize()(缺省机体的来源);
 * 所有几何/材质由模型自己持有,随 DroneFly.destroy() 一起释放。
 */
export function createHuskyDroneModel(): THREE.Group {
  const materials = createHuskyAdapterMaterials()
  const inner = createDroneModel()

  const model = new THREE.Group()
  model.name = '机械哈士奇无人机'

  // —— 顶层骨架:与默认 GLB 的双根约定一致 ——
  // CTRL_DJI_Root 施加机体俯仰/横滚;RIG_DJI_Arms_Props 承载机臂折叠/旋翼自转。
  // 两根同在模型原点且都不带旋转,DroneRig 对两根施加相同姿态 → 机体与机臂同步刚转。
  const controlRoot = huskyNode(model, 'CTRL_DJI_Root')
  const rigRoot = huskyNode(model, 'RIG_DJI_Arms_Props')

  // 前向翻转:哈士奇头朝 +Z,链路约定 -Z。绕竖轴转 180°,原点不动,
  // 因此机身/腿/头的世界坐标只做 (x,z) → (-x,-z),y 不变。
  const oriented = huskyNode(controlRoot, 'BLOCK_Orientation')
  oriented.rotation.y = Math.PI
  oriented.add(inner)
  model.updateMatrixWorld(true)
  const world = (object: THREE.Object3D) => object.getWorldPosition(new THREE.Vector3())

  // —— 机臂 / 电机 / 旋翼:四角按"转后世界象限"归位成 FL/FR/RL/RR ——
  // 哈士奇原角标 fl 在 (+Z 机头、-X),翻转 180° 后落在 +X/-Z = FrontRight,以此类推。
  for (const corner of ['fl', 'fr', 'rl', 'rr'] as const) {
    const armPart = inner.getObjectByName(`arm-${corner}`)
    const rotorPart = inner.getObjectByName(`rotor-${corner}`)
    const motorPart = inner.getObjectByName(`motor-${corner}`)
    if (!armPart || !rotorPart || !motorPart) continue

    const hinge = world(armPart) // 折叠铰链(机身角上)
    const prop = world(rotorPart) // 桨心
    const position: ArmPosition =
      `${prop.z < 0 ? 'Front' : 'Rear'}${prop.x < 0 ? 'Left' : 'Right'}` as ArmPosition

    // 折叠节点:局部 -Z 指向"铰链→桨心"水平方向(DroneRig 由该向量反推折叠角)
    const dir = new THREE.Vector3(prop.x - hinge.x, 0, prop.z - hinge.z).normalize()
    const fold = huskyNode(rigRoot, `CTRL_Arm_${position}_Fold`, hinge)
    fold.rotation.y = -Math.PI / 2 - Math.atan2(dir.z, dir.x)
    // 整条臂(含电机/旋翼/护圈子树)按世界位姿收养进折叠节点
    fold.attach(armPart)
    // 自检项:机臂网格(语义名,空组)
    huskyNode(fold, `ARM_${position}`)

    // 电机钟罩(固定外壳,DroneRig.buildProps 会把它从自转子树摘出挂回折叠节点)
    motorPart.name = `MOTOR_${position}_RotorBell`
    // 自转节点:整个旋翼组件(rotor 组)原地升格;出厂相位角随之保留
    rotorPart.name = `CTRL_Prop_${position}_Spin`
    // 桨毂网格对齐语义名(部件表核对项"转子桨毂")
    const hubMesh = rotorPart.getObjectByName(`rotor-${corner}-hub`)
    if (hubMesh) hubMesh.name = `ROTOR_${position}`
    // 三叶桨:前两片进 DroneRig 桨叶表(可自转/收纳叠拢),第三片留在自转节点下随转
    for (const [index, name] of [`rotor-${corner}-blade-0`, `rotor-${corner}-blade-1`].entries()) {
      const blade = model.getObjectByName(name)
      if (blade) blade.name = `PROP_${position}_Blade_${index + 1}`
    }
  }

  // —— 起落架腿:四条机械腿的三关节补挂语义名,供 DroneRig 的收腿功能驱动 ——
  // 角标同样按"转后世界象限"映射(fl→FrontRight,以此类推,与机臂一致)。
  // 收腿姿态角(髋 +65°/膝 −145°/踝 +45°)由 DroneRig 的 LEG_FOLD_ANGLES 定义;
  // 没有 LEG_* 节点的模型(真机 GLB)收腿功能自动停用。
  const legCornerToPosition: Record<string, ArmPosition> = {
    fl: 'FrontRight',
    fr: 'FrontLeft',
    rl: 'RearRight',
    rr: 'RearLeft',
  }
  for (const [corner, position] of Object.entries(legCornerToPosition)) {
    for (const [sourceName, joint] of [
      [`leg-upper-${corner}`, 'Hip'],
      [`leg-lower-${corner}`, 'Knee'],
      [`foot-${corner}`, 'Ankle'],
    ] as const) {
      const node = inner.getObjectByName(sourceName)
      if (node) node.name = `LEG_${position}_${joint}`
    }
  }

  // —— 云台:哈士奇没有云台,在机头前下方新建三轴 + 载荷 ——
  // 枢轴越过下颚前缘(z -1.72,下巴伸到约 -1.55):FPV 前视不被狗下巴挡住;
  // 载荷盒底保持在机腹之上,全机最低点仍是机足,不抢触地点。
  const gimbalYaw = huskyNode(controlRoot, 'CTRL_Gimbal_Yaw', new THREE.Vector3(0, -0.5, -1.72))
  const gimbalPitch = huskyNode(gimbalYaw, 'CTRL_Gimbal_Pitch')
  const gimbalRoll = huskyNode(gimbalPitch, 'CTRL_Gimbal_Roll')
  const pod = huskyNode(gimbalRoll, 'GIMBAL_BlackCameraPod')
  // 减震臂:从载荷顶连到机腹
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.55, 14), materials.housing)
  neck.name = 'GIMBAL_DampingArm'
  neck.position.set(0, 0.3, 0.02)
  pod.add(neck)
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.34, 0.46), materials.housing)
  housing.name = 'GIMBAL_CameraHousing'
  housing.position.set(0, -0.02, -0.06)
  pod.add(housing)
  const lensFrame = new THREE.Mesh(
    new THREE.CylinderGeometry(0.135, 0.15, 0.16, 24),
    materials.housing,
  )
  lensFrame.name = 'GIMBAL_CameraLensFrame'
  lensFrame.rotation.x = Math.PI / 2
  lensFrame.position.set(0, -0.02, -0.3)
  pod.add(lensFrame)
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.105, 24), materials.lens)
  lens.name = 'SENSOR_Glass_GimbalLens'
  lens.rotation.y = Math.PI
  lens.position.set(0, -0.02, -0.385)
  pod.add(lens)
  const sideRing = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.02, 8, 20), materials.lens)
  sideRing.name = 'GIMBAL_Camera_SideRing_Right'
  sideRing.rotation.y = Math.PI / 2
  sideRing.position.set(0.225, -0.02, -0.08)
  pod.add(sideRing)

  // —— 视觉玻璃:五块单面 Plane(法线朝向即雷达判向,与积木机同规则) ——
  // 位置贴哈士奇的背脊/机腹表面,坐标全部用转后系(机头 = -Z)。
  const glassGroup = huskyNode(controlRoot, 'SRC_SensorGlass_Group')
  const addGlass = (
    name: string,
    w: number,
    h: number,
    position: THREE.Vector3,
    orientation: 'front' | 'up' | 'down',
  ) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), materials.glass)
    mesh.name = name
    mesh.position.copy(position)
    if (orientation === 'front') mesh.rotation.y = Math.PI
    if (orientation === 'up') mesh.rotation.x = -Math.PI / 2
    if (orientation === 'down') mesh.rotation.x = Math.PI / 2
    glassGroup.add(mesh)
    return mesh
  }
  addGlass('SENSOR_Glass_Front_Left', 0.26, 0.15, new THREE.Vector3(-0.3, 0.72, -1.32), 'front')
  addGlass('SENSOR_Glass_Front_Right', 0.26, 0.15, new THREE.Vector3(0.3, 0.72, -1.32), 'front')
  addGlass('SENSOR_Glass_Side_Left', 0.24, 0.15, new THREE.Vector3(-0.42, 0.795, 0.1), 'up')
  addGlass('SENSOR_Glass_Side_Right', 0.24, 0.15, new THREE.Vector3(0.42, 0.795, 0.1), 'up')
  addGlass('SENSOR_Glass_Downward', 0.3, 0.22, new THREE.Vector3(0, -0.752, 0.28), 'down')
  // 前视壳体:前脸玻璃外侧的两块深灰传感舱
  const frontHousingGeometry = new THREE.BoxGeometry(0.2, 0.13, 0.07)
  for (const [name, x] of [
    ['SENSOR_FrontHousing_Left', -0.31],
    ['SENSOR_FrontHousing_Right', 0.31],
  ] as const) {
    const mesh = new THREE.Mesh(frontHousingGeometry, materials.housing)
    mesh.name = name
    mesh.position.set(x, 0.72, -1.34)
    glassGroup.add(mesh)
  }

  // —— 尾灯:机尾两侧小灯珠(DroneLights 会把它们收养进两条后臂折叠节点) ——
  const tailGroup = huskyNode(controlRoot, 'SRC_TailStatusLED_Group')
  for (const [name, x] of [
    ['LED_Status_Tail_Left', -2.2],
    ['LED_Status_Tail_Right', 2.2],
  ] as const) {
    const anchor = new THREE.Vector3(x, 0.15, 2.3)
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.038, 12, 10), materials.led)
    bead.name = name
    bead.position.copy(anchor)
    tailGroup.add(bead)
    const light = new THREE.PointLight(0xffc14d, 0, 0)
    light.name = name.replace('LED_Status_Tail', 'LIGHT_StatusLED')
    light.position.copy(anchor)
    tailGroup.add(light)
  }

  // —— 电量灯:哈士奇机身两侧各有 4 颗绿色 power-led;把左侧一列升格为电量灯 ——
  for (let index = 0; index < 4; index += 1) {
    const bead = model.getObjectByName(`chassis-power-led-l-${index}`)
    if (!bead) continue
    bead.name = `LED_BatteryCharge_0${index + 1}`
    const anchor = world(bead)
    const light = new THREE.PointLight(0xffc14d, 0, 0)
    light.name = `LIGHT_BatteryLED_0${index + 1}`
    light.position.copy(anchor)
    controlRoot.add(light)
  }

  // —— 电源键 / 贴花 / 语义空组(部件自检用) ——
  const button = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.03, 16), materials.decal)
  button.name = 'BUTTON_Power'
  button.position.set(0.3, 0.8, -0.55)
  controlRoot.add(button)
  const decals = huskyNode(controlRoot, 'SRC_Decals_Group')
  const decal = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.01, 0.18), materials.decal)
  decal.name = 'DECAL_Text_Labels'
  decal.position.set(-0.3, 0.8, -0.55)
  decals.add(decal)
  // 机身主体 / 黑色下壳:哈士奇的对应体块叫 chassis/belly,语义名补成空组供自检核对
  huskyNode(controlRoot, 'BODY_Main_Fuselage')
  huskyNode(controlRoot, 'BODY_Black_Underside_SensorHousing')
  huskyNode(controlRoot, 'SRC_BlackHousing_Group')
  huskyNode(controlRoot, 'SRC_GeometryRoot')
  // 底部辅助灯的模型自带点光源(DroneLights 吸附到机腹下方做降落补光)
  const assist = new THREE.PointLight(0xffc14d, 0, 0)
  assist.name = 'LIGHT_BottomAssist'
  assist.position.set(0, -0.66, 0.28)
  controlRoot.add(assist)

  return model
}
