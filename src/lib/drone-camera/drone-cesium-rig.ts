/**
 * Cesium 侧的机体表现层 —— 桨叶自转 + 机体灯光。
 *
 * 与 three 版的 DroneRig + DroneLights 对位:同一套语义节点、同一套转速公式、
 * 同一份灯语数据,只是把"写 three 场景图"换成"写 Cesium Model 的节点矩阵 / 挂 CustomShader"。
 *
 * Cesium 的 Model 是"死"的:GLB 里四颗电机关节不会自己转,灯珠也只是灰壳
 * (模型自带的 KHR_lights_punctual 扩展 Cesium 不支持,由 drone-cesium.ts 在加载期剥离)。
 * 本层用两个机制把表现力补齐到 three 版的水准:
 *
 * 1. 桨叶自转:每帧把「绕电机轴的自转」写进 Spin_Bone 关节矩阵——
 *      node.matrix = originalMatrix × R(axisLocal, angle)
 *    这是实测唯一能传导到子节点的通道(setter 内部置 _userAnimationDirty,
 *    场景图当帧强制重建)。⚠️ 桨叶并不挂在 CTRL_Prop_*_Spin 下面:自转节点
 *    的子树是「两片桨叶折叠骨节」+「CTRL_Prop_*_Spin(其下才是 ROTOR 桨毂与
 *    MOTOR_*_RotorBell 钟罩)」两拨兄弟,只写 CTRL 会漏掉桨叶。
 *
 * 2. 钟罩反向补偿:电机钟罩(磁钢外壳)是**固定件**,不能跟着转子转
 *    (three 版靠把钟罩从自转子树摘出、挂回自转节点的父级实现;Cesium 的
 *    glTF 层级改不了,只能解矩阵)。每帧给钟罩写一个"刚好抵消自转"的矩阵:
 *      M = CTRL.original × ROTOR.original          (自转节点 → 钟罩父级 的出厂链)
 *      B = M⁻¹ · R(axis,θ)⁻¹ · M · B0              (R 定义在自转节点局部系)
 *    于是钟罩世界矩阵逐元素等于出厂值 —— 不是"看起来没动",而是数学上恒定。
 *
 * 3. 机体灯光:**模型自带的灯珠 Mesh 本体发光**(CustomShader 按 positionMC 判定
 *    片元落在哪个灯珠几何内,把 uniform 颜色写进 emissive —— 与 three 版
 *    "复用灯珠网格 + 换自发光材质"同构;Cesium 不支持单节点换材质,shader 是唯一通道)。
 *    灯位/半径从 GLB 灯珠网格顶点离线实测,位置由几何自证,不存在手摆锚点。
 *    灯语数据与 three 版完全同源——statusPatternFor(sim) + STATUS_PATTERNS 时间轴、
 *    batteryLedPlan(batteryPercent)、辅助灯「飞行中且离地 ≤8m 自动点亮」。
 *    两个后端在同样飞行状态下闪一样的灯。
 *    ⚠️ 不要再走"自建 billboard 灯珠"路线:锚点坐标系(ENU↔Y-up)极易错位,
 *    且与灯珠 Mesh 位置永远差着一层手摆常量 —— 已按约定删除。
 *
 * 非 DJI 机体(无 PROP_*_Spin_Bone 语义节点)整体 no-op,与 DroneRig 的降级纪律一致。
 */
import { PROP_SPIN_SIGN, type ArmPosition } from './drone-rig'
import { STATUS_PATTERNS, batteryLedPlan, statusPatternFor } from './drone-lights'
import type { DroneSim } from './drone-sim'

type CesiumNS = Record<string, any>

const ARM_POSITIONS: ArmPosition[] = ['FrontLeft', 'FrontRight', 'RearLeft', 'RearRight']

/**
 * 电机轴在「自转节点(PROP_*_Spin_Bone)局部系」里的表示,**运行时从模型算**,
 * 不写死常量:
 *      axisLocal = normalize( linear(CTRL_Prop_*_Spin 出厂矩阵) · (0,1,0) )
 *
 * 依据:电机轴就是 CTRL_Prop_*_Spin 的局部 +Y(实测钟罩侧壁点绕该轴的半径
 * 离散度 MAD≈0.95mm,而绕模型竖直轴则散成 47~74mm —— 后者根本不是它的对称轴)。
 * CTRL 的出厂旋转是绕 X 的 90°,故 axisLocal 恰好是 (0,0,1)(Blender 的局部 Z
 * 即 three 的局部 Y,与 drone-rig.ts 的注释对得上)。
 *
 * ⚠️ 历史坑:这里曾写死四组常量,而那是把 CTRL 局部 +Y 的**世界方向**多换了一次
 * 轴(Blender Z-up ↔ three Y-up),实际指向模型竖直轴,和真电机轴差 15.27°
 * (前臂)/18.52°(后臂)—— 桨盘会绕着偏 15° 的轴进动,钟罩看起来就在"转"。
 */
function spinAxisFor(C: CesiumNS, ctrlOriginal: CesiumNS): CesiumNS | null {
  const column = new C.Cartesian4()
  C.Matrix4.getColumn(ctrlOriginal, 1, column)
  const axis = C.Cartesian3.fromCartesian4(column, new C.Cartesian3())
  if (C.Cartesian3.magnitude(axis) < 1e-9) return null
  return C.Cartesian3.normalize(axis, axis)
}

/**
 * 灯珠几何(GLB 单位,Y-up):从 dji_mini4_pro.glb 的**灯珠网格顶点**离线实测
 * (质心 + 最大半径,脚本 tmp-shots/probe-glb-led-precise.py)。
 *
 * 这就是对齐 three 版「复用模型自带灯珠网格」约定的 Cesium 落地:
 * CustomShader 用它判定"这个片元是不是灯珠"→ 灯珠 Mesh 本体发光,位置由几何自证。
 * 曾经的 ANCHOR_* 手摆锚点 + billboard 灯珠方案已删除 —— 坐标轴(ENU↔Y-up)一错
 * 灯就飞到机身上方,且与 Mesh 位置永远差一层手摆常量(用户看到的"红球绿球")。
 */
const LED_GEO = {
  statusLeft: { center: [-8.64, 0.912, 9.765] as const, radius: 0.5 },
  statusRight: { center: [8.643, 0.911, 9.767] as const, radius: 0.5 },
  battery: [
    { center: [-0.527, 2.085, 4.811] as const, radius: 0.1 },
    { center: [-0.176, 2.084, 4.813] as const, radius: 0.1 },
    { center: [0.178, 2.084, 4.813] as const, radius: 0.1 },
    { center: [0.53, 2.085, 4.812] as const, radius: 0.1 },
  ],
  // 辅助灯照明面 = 下视玻璃(three 版 DroneLights 的同一锚点),不是 LIGHT_BottomAssist 空节点
  aux: { center: [0, -2.445, -0.927] as const, radius: 0.37 },
} as const

/** 电量灯颜色(与 drone-lights 的 BATTERY_COLOR 同值;那边未导出,此处按同值复刻) */
const BATTERY_COLOR = 0x9fffcb
/** 底部辅助灯颜色(与 drone-lights 辅助灯盘的自发光同色:暖白) */
const AUX_COLOR = 0xffe9c0
/** 辅助灯自动档的离地门限(米),与 drone-lights 的 AUTO_LIGHT_MAX_AGL_METERS 一致 */
const AUTO_LIGHT_MAX_AGL_METERS = 8

interface SpinJoint {
  position: ArmPosition
  node: CesiumNS
  /** 出厂矩阵(setter 的语义:写 originalMatrix 等价于"撤销用户动画") */
  original: CesiumNS
  /** 每关节独享的两块矩阵:节点矩阵按引用被 Cesium 持有,绝不能跨关节共用 */
  trs: CesiumNS
  product: CesiumNS
  axis: CesiumNS
  angle: number
  spinning: boolean
  /** 固定钟罩的反向补偿(缺节点时为 null → 该臂钟罩会跟着转,但不会崩) */
  bell: BellCompensation | null
}

/**
 * 电机钟罩(磁钢外壳)的反向补偿数据。
 * 每帧给钟罩写 K·B0,K = M⁻¹·R⁻¹·M —— 把自转在钟罩自己的父级坐标系里抵消掉,
 * 于是钟罩世界矩阵恒等于出厂值(与 three 版"把钟罩挂到不动骨节下"等价)。
 */
interface BellCompensation {
  node: CesiumNS
  /** 出厂矩阵 */
  original: CesiumNS
  /** M = CTRL_Prop_*_Spin.original × ROTOR_*.original */
  chain: CesiumNS
  invChain: CesiumNS
  /** 逐帧中间量(全预先分配,稳态零分配) */
  inv: CesiumNS
  conj: CesiumNS
  kernel: CesiumNS
  product: CesiumNS
  spinning: boolean
}

/** 闪烁相位:与 drone-lights 的 blinkPhase 同式 */
function blinkPhase(timeMs: number, onMs: number, offMs: number): boolean {
  return timeMs % (onMs + offMs) < onMs
}

/**
 * 停转复位:把节点矩阵交还 setter 的"清除用户动画"分支 —— 恢复出厂矩阵并清
 * userAnimated,场景图不再每帧强制重建。自转节点与钟罩必须成对复位。
 */
function stopJoint(joint: SpinJoint): void {
  if (joint.spinning) {
    joint.node.matrix = undefined
    joint.spinning = false
  }
  const bell = joint.bell
  if (bell?.spinning) {
    bell.node.matrix = undefined
    bell.spinning = false
  }
}

export class CesiumDroneRig {
  private readonly sim: DroneSim
  private readonly C: CesiumNS

  private joints: SpinJoint[] = []
  /** 灯珠发光 shader(attach 时创建一次;每帧只改 uniform 颜色) */
  private lightShader: CesiumNS | null = null
  /** 当前绑定的模型(detach 时要摘掉 customShader) */
  private modelRef: CesiumNS | null = null
  /** 当前机体是否有语义节点(只有 DJI 机体启用本层) */
  private enabled = false
  private timeMs = 0

  /**
   * @param sim    飞控内核(与适配器共用同一个实例,读到的永远是同一份真值)
   * @param cesium Cesium 命名空间;缺省取 window.Cesium(全局脚本注入方式)
   */
  /** Cesium 机体表现层:把 DroneSim 真值映射到 Model 关节(桨叶自转/起落架/灯光) */
  constructor(sim: DroneSim, cesium?: CesiumNS) {
    this.sim = sim
    const injected = cesium ?? (window as unknown as { Cesium?: CesiumNS }).Cesium
    if (!injected) {
      throw new Error('[drone-camera] CesiumDroneRig 需要 Cesium 命名空间(请先加载 Cesium.js)')
    }
    this.C = injected
  }

  // ───────────────────────────── 挂载 / 拆卸 ─────────────────────────────

  /**
   * 绑定新机体:重绑自转关节、挂灯珠发光 shader。旧机体的关节矩阵先复位。
   */
  attach(model: CesiumNS): void {
    this.detach()
    const C = this.C
    this.enabled = typeof model.getNode === 'function' && !!model.getNode('PROP_FrontLeft_Spin_Bone')
    if (!this.enabled) return
    this.modelRef = model

    // —— 自转关节 ——
    this.joints = []
    for (const position of ARM_POSITIONS) {
      const node = model.getNode(`PROP_${position}_Spin_Bone`)
      const ctrl = model.getNode(`CTRL_Prop_${position}_Spin`)
      // 自转节点 + 轴参照节点缺一不可:轴要从 CTRL 的出厂矩阵推
      if (!node || !ctrl) continue
      const axis = spinAxisFor(C, ctrl.originalMatrix)
      if (!axis) continue

      // —— 钟罩反向补偿:需要 CTRL/ROTOR/钟罩三个节点 ——
      const rotor = model.getNode(`ROTOR_${position}`)
      const bellNode = model.getNode(`MOTOR_${position}_RotorBell`)
      let bell: BellCompensation | null = null
      if (rotor && bellNode) {
        const chain = C.Matrix4.multiply(
          ctrl.originalMatrix,
          rotor.originalMatrix,
          new C.Matrix4(),
        )
        bell = {
          node: bellNode,
          original: bellNode.originalMatrix,
          chain,
          invChain: C.Matrix4.inverse(chain, new C.Matrix4()),
          inv: new C.Matrix4(),
          conj: new C.Matrix4(),
          kernel: new C.Matrix4(),
          product: new C.Matrix4(),
          spinning: false,
        }
      }

      this.joints.push({
        position,
        node,
        original: node.originalMatrix,
        trs: new C.Matrix4(),
        product: new C.Matrix4(),
        axis,
        angle: 0,
        spinning: false,
        bell,
      })
    }

    // —— 灯组:CustomShader 让模型自带的灯珠 Mesh 本体发光(与 three 版"复用灯珠
    //      网格 + 自发光材质"同构;Cesium 不支持单节点换材质,只能走 shader)。
    //      不挂任何自建灯珠/billboard —— 位置由灯珠几何自证 ——
    this.attachLightShader(model)
  }

  /**
   * 灯珠发光 shader:按 positionMC(GLB 原始 Y-up 坐标,实测见 probe-pmc-axis)判定
   * 片元是否落在灯珠网格内,是则把 uniform 颜色写进 emissive。
   * 灭灯 = uniform 为 0 = emissive 0 = 原贴图灯罩本色,与 three 版"换自发光材质"一致。
   * 每帧只改 uniform 值,shader 本体在 attach 时创建一次。
   */
  private attachLightShader(model: CesiumNS): void {
    const C = this.C
    const g = LED_GEO
    const uniform = () => ({ type: C.UniformType.VEC3, value: new C.Cartesian3(0, 0, 0) })
    const fmt = (c: readonly number[]) => `vec3(${c[0]}, ${c[1]}, ${c[2]})`
    this.lightShader = new C.CustomShader({
      lightingModel: C.LightingModel.PBR,
      uniforms: {
        u_statusL: uniform(),
        u_statusR: uniform(),
        u_batt0: uniform(),
        u_batt1: uniform(),
        u_batt2: uniform(),
        u_batt3: uniform(),
        u_aux: uniform(),
      },
      fragmentShaderText: `
        void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
          vec3 p = fsInput.attributes.positionMC;
          vec3 e = vec3(0.0);
          float t = 0.0;   // 0 = 灯区中心,1 = 灯区边缘(供亮度梯度用)
          if      (distance(p, ${fmt(g.statusLeft.center)})  < ${g.statusLeft.radius})  { e = u_statusL; t = distance(p, ${fmt(g.statusLeft.center)})  / ${g.statusLeft.radius}; }
          else if (distance(p, ${fmt(g.statusRight.center)}) < ${g.statusRight.radius}) { e = u_statusR; t = distance(p, ${fmt(g.statusRight.center)}) / ${g.statusRight.radius}; }
          else if (distance(p, ${fmt(g.battery[0].center)})  < ${g.battery[0].radius})  { e = u_batt0; t = distance(p, ${fmt(g.battery[0].center)})  / ${g.battery[0].radius}; }
          else if (distance(p, ${fmt(g.battery[1].center)})  < ${g.battery[1].radius})  { e = u_batt1; t = distance(p, ${fmt(g.battery[1].center)})  / ${g.battery[1].radius}; }
          else if (distance(p, ${fmt(g.battery[2].center)})  < ${g.battery[2].radius})  { e = u_batt2; t = distance(p, ${fmt(g.battery[2].center)})  / ${g.battery[2].radius}; }
          else if (distance(p, ${fmt(g.battery[3].center)})  < ${g.battery[3].radius})  { e = u_batt3; t = distance(p, ${fmt(g.battery[3].center)})  / ${g.battery[3].radius}; }
          else if (distance(p, ${fmt(g.aux.center)})         < ${g.aux.radius})         { e = u_aux; t = distance(p, ${fmt(g.aux.center)})         / ${g.aux.radius}; }
          // 点亮时只留自发光:必须同时关掉底色(diffuse)与高光(specular)——
          // Cesium PBR 的最终色 = 底色×光照 + 高光 + emissive,灯珠网格底图是灰白灯罩
          // (且被太阳照亮),红色 emissive 叠上去就被冲成粉色(观感"不够红")。
          // three 版是整颗换成"底黑 + emissive"的自发光材质,这里等价地把两项清零。
          //
          // 亮度梯度(发光感的来源):边缘保持纯灯色(强度 1.0,深红不发粉),
          // 中心按 core² 过曝到 ~3.2 倍形成亮核 —— 均匀提亮只会整块变粉,
          // "深色边缘 + 过曝亮核"的径向梯度才是 LED 点亮的观感。
          if (any(greaterThan(e, vec3(0.0)))) {
            float core = 1.0 - clamp(t, 0.0, 1.0);
            material.diffuse = vec3(0.0);
            material.specular = vec3(0.0);
            material.emissive = e * (1.0 + 2.2 * core * core);
          }
        }`,
    })
    model.customShader = this.lightShader
  }

  /** 拆卸:复位关节矩阵(含钟罩补偿)、摘掉发光 shader 与光晕集合 */
  detach(): void {
    for (const j of this.joints) stopJoint(j)
    this.joints = []
    if (this.modelRef && this.lightShader) {
      // shader 是挂在整个 Model 上的,换机体/销毁时必须摘掉,
      // 否则新机体(无灯位语义)会沿用旧模型的灯位判据
      try {
        this.modelRef.customShader = undefined
      } catch {
        /* 旧版 Cesium 无此属性时静默 */
      }
    }
    this.lightShader = null
    this.modelRef = null
    this.enabled = false
  }

  /** 停止每帧同步并解除与 primitive 的绑定 */
  dispose(): void {
    this.detach()
  }

  // ───────────────────────────── 每帧更新 ─────────────────────────────

  /**
   * 每帧驱动。调用时机:adapter 已推进 sim 并写完 model.modelMatrix ——
   * 桨叶关节矩阵直接改模型内部节点,光晕位置复用同一份世界矩阵。
   */
  update(deltaSeconds: number): void {
    if (!this.enabled) return
    // 与 drone-lights 同款截断:标签页挂起恢复时 delta 大跳,不让灯语时间轴跳变
    const dt = Math.max(0, Math.min(deltaSeconds, 0.1))
    this.timeMs += dt * 1000
    this.updateProps(dt)
    this.updateLights()
  }

  /**
   * 桨叶自转。转速公式与 three 版 DroneRig.updateProps 完全一致:
   * 每分钟转速 = (3.8 + 负载×7) 转/秒,对角反转由 PROP_SPIN_SIGN 给出,
   * 负载表直接取 DroneSim 的四电机混控输出(悬停 ≈ 1,前飞时后桨快前桨慢)。
   */
  private updateProps(dt: number): void {
    const C = this.C
    const speeds = this.sim.motorSpeeds
    for (const j of this.joints) {
      const speed = Math.min(1.15, Math.max(0, speeds[j.position] ?? 0))
      if (speed <= 0.01) {
        // 停转:传 undefined 走 setter 的"清除用户动画"分支(恢复出厂矩阵 + 清 userAnimated,
        // 场景图不再每帧强制重建);写 originalMatrix 反而会一直置脏。
        // 钟罩必须一起复位,否则会留着上一帧的反向补偿量、看上去歪一个角。
        stopJoint(j)
        continue
      }
      j.angle =
        (j.angle + ((3.8 + speed * 7) * dt * PROP_SPIN_SIGN[j.position] * Math.PI * 2)) %
        (Math.PI * 2)
      const rot = C.Matrix3.fromQuaternion(C.Quaternion.fromAxisAngle(j.axis, j.angle))
      C.Matrix4.fromRotationTranslation(rot, C.Cartesian3.ZERO, j.trs)
      // 关节矩阵 = 出厂矩阵 × 绕电机轴的自转(后乘 = 关节局部系,与 three 版前乘父系轴等价)
      j.node.matrix = C.Matrix4.multiply(j.original, j.trs, j.product)
      j.spinning = true
      const bell = j.bell
      if (bell) {
        // K = M⁻¹ · Rot⁻¹ · M:把自转在钟罩父级坐标系里原样抵消,
        // 钟罩世界矩阵逐元素等于出厂值(不是"看起来没动",是数学上恒定)
        C.Matrix4.inverseTransformation(j.trs, bell.inv)
        C.Matrix4.multiply(bell.invChain, bell.inv, bell.conj)
        C.Matrix4.multiply(bell.conj, bell.chain, bell.kernel)
        bell.node.matrix = C.Matrix4.multiply(bell.kernel, bell.original, bell.product)
        bell.spinning = true
      }
    }
  }

  /** 灯光:灯珠 Mesh 本体发光(只写 shader uniform),灯语时序与 three 版同源 */
  private updateLights(): void {
    // —— 灯语时间轴(three 版 applyStatusPattern 的同款展开):状态灯 = [左色, 右色] ——
    const pattern = STATUS_PATTERNS[statusPatternFor(this.sim)]
    const loopMs = pattern.steps.reduce((sum, s) => sum + s.onMs + s.offMs, 0)
    let t = loopMs > 0 ? this.timeMs % loopMs : 0
    let colors = pattern.steps[0]?.colors ?? [0x000000]
    let statusOn = false
    for (const s of pattern.steps) {
      if (t < s.onMs) {
        colors = s.colors
        statusOn = true
        break
      }
      if (t < s.onMs + s.offMs) {
        colors = s.colors
        statusOn = false
        break
      }
      t -= s.onMs + s.offMs
    }
    const statusColors = [colors[0] ?? 0x000000, colors[1] ?? colors[0] ?? 0x000000] as const

    // —— 电量灯:按电量分级点亮 + 末颗低电闪烁(three 版 applyBattery 的 level 档) ——
    const plan = batteryLedPlan(this.sim.batteryPercent)
    const batteryStates = [0, 1, 2, 3].map(
      (i) =>
        i < plan.lit ||
        (plan.blinkIndex !== null && i === plan.blinkIndex && blinkPhase(this.timeMs, 240, 240)),
    )

    // —— 辅助灯:飞行中且离地 ≤8m 自动点亮(three 版 auto 档同款门控) ——
    const auxOn = this.sim.airborne && this.sim.position.y <= AUTO_LIGHT_MAX_AGL_METERS

    // —— 灯珠 Mesh 发光:把每盏灯的当前颜色写进 shader uniform(灭 = 0 = 原贴图本色) ——
    // ⚠️ hex 是 sRGB,Cesium 把 emissive uniform 当**线性**值用,输出前会做 sRGB 编码
    //    (czm_gammaCorrect)—— 直接写 sRGB 数值,线性小分量(如 0xff3b30 的绿 0.23)经编码
    //    回到屏幕变成 ~0.5,红灯就被"提亮"成粉色。必须先做 sRGB→线性转换,与 three 版
    //    ColorManagement.setHex 的往返等价,屏幕色才和 hex 一致。
    const u = this.lightShader?.uniforms
    if (u) {
      const setColor = (name: string, hex: number, on: boolean) => {
        const v = u[name].value as CesiumNS
        if (on) {
          v.x = srgbToLinear(((hex >> 16) & 0xff) / 255)
          v.y = srgbToLinear(((hex >> 8) & 0xff) / 255)
          v.z = srgbToLinear((hex & 0xff) / 255)
        } else {
          v.x = 0
          v.y = 0
          v.z = 0
        }
      }
      setColor('u_statusL', statusColors[0], statusOn)
      setColor('u_statusR', statusColors[1], statusOn)
      batteryStates.forEach((lit, i) => setColor(`u_batt${i}`, BATTERY_COLOR, lit))
      setColor('u_aux', AUX_COLOR, auxOn)
    }
  }
}

/** sRGB → 线性(IEC 61966-2-1 传递函数);Cesium 的 emissive/PBR 全程按线性计算 */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
