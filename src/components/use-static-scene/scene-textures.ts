/**
 * 静态场景的程序化材质工厂。
 *
 * 为什么全部用 Canvas 生成而不是下载贴图：
 *   1) 零资产、零版权、零额外网络请求，路由一打开就能看；
 *   2) 颜色全部走「贴图 × 顶点色」——同一张灰度细节图可以被上百个物体复用，
 *      墙体/屋顶/桶的色差靠顶点色给，于是**整个营地只需要 6 张颜色图 + 6 张法线图**。
 *
 * 法线贴图由颜色图的亮度用 Sobel 求梯度现算（{@link normalFromCanvas}）。
 * 这是「塑料感 → 水泥/铁皮质感」的关键：没有法线，所有面都是绝对光滑的平面，
 * 光照再真实也像玩具。
 */
import * as THREE from 'three'

export interface SurfaceMaps {
  map: THREE.CanvasTexture
  normalMap: THREE.CanvasTexture
}

export interface SceneSurfaces {
  plaster: SurfaceMaps
  concrete: SurfaceMaps
  roof: SurfaceMaps
  metal: SurfaceMaps
  wood: SurfaceMaps
  ground: SurfaceMaps
  /** 草簇的 alpha 图（一撮草的剪影，带透明通道） */
  grass: THREE.CanvasTexture
  /** 供销毁时统一释放 */
  all: THREE.Texture[]
}

/** 确定性随机：同种子 → 同纹路，便于截图回归 */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function canvas(size: number, height = size): HTMLCanvasElement {
  const el = document.createElement('canvas')
  el.width = size
  el.height = height
  return el
}

function toTexture(source: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(source)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  texture.anisotropy = 8
  return texture
}

/**
 * 由亮度图算切线空间法线（Sobel 梯度 → 归一化 (nx, ny, 1)）。
 * strength 越大凹凸越狠；贴图是接缝可循环的，取样时按边界取模。
 */
function normalFromCanvas(source: HTMLCanvasElement, strength: number): THREE.CanvasTexture {
  const width = source.width
  const height = source.height
  const ctx = source.getContext('2d')
  if (!ctx) return toTexture(source, false)
  const data = ctx.getImageData(0, 0, width, height).data
  const luma = new Float32Array(width * height)
  for (let i = 0; i < width * height; i += 1) {
    const r = data[i * 4] ?? 0
    const g = data[i * 4 + 1] ?? 0
    const b = data[i * 4 + 2] ?? 0
    luma[i] = (r * 0.299 + g * 0.587 + b * 0.114) / 255
  }
  const at = (x: number, y: number): number =>
    luma[((y + height) % height) * width + ((x + width) % width)] ?? 0

  const out = canvas(width, height)
  const outCtx = out.getContext('2d')
  if (!outCtx) return toTexture(source, false)
  const image = outCtx.createImageData(width, height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // 相邻像素亮度差 = 高度场梯度，取负作为法线的 x/y 分量
      const dx = at(x + 1, y) - at(x - 1, y)
      const dy = at(x, y + 1) - at(x, y - 1)
      let nx = -dx * strength
      let ny = -dy * strength
      let nz = 1
      const length = Math.hypot(nx, ny, nz) || 1
      nx /= length
      ny /= length
      nz /= length
      const i = (y * width + x) * 4
      image.data[i] = (nx * 0.5 + 0.5) * 255
      image.data[i + 1] = (ny * 0.5 + 0.5) * 255
      image.data[i + 2] = (nz * 0.5 + 0.5) * 255
      image.data[i + 3] = 255
    }
  }
  outCtx.putImageData(image, 0, 0)
  return toTexture(out, false)
}

/** 撒一层细颗粒（墙面的砂粒、混凝土的骨料） */
function speckle(
  ctx: CanvasRenderingContext2D,
  size: number,
  rng: () => number,
  count: number,
  min: number,
  max: number,
  alpha = 0.5,
): void {
  for (let i = 0; i < count; i += 1) {
    const v = Math.floor(min + rng() * (max - min))
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha})`
    const s = 1 + rng() * 2
    ctx.fillRect(rng() * size, rng() * size, s, s)
  }
}

/** 随机游走的裂缝：几条细线，比噪点更像“老墙” */
function cracks(
  ctx: CanvasRenderingContext2D,
  size: number,
  rng: () => number,
  count: number,
  color: string,
): void {
  ctx.strokeStyle = color
  for (let i = 0; i < count; i += 1) {
    let x = rng() * size
    let y = rng() * size
    ctx.lineWidth = 0.6 + rng() * 1.1
    ctx.beginPath()
    ctx.moveTo(x, y)
    const steps = 4 + Math.floor(rng() * 8)
    for (let s = 0; s < steps; s += 1) {
      x += (rng() - 0.5) * size * 0.06
      y += (rng() - 0.5) * size * 0.06
      ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
}

/** 灰泥墙：米灰底 + 砂粒 + 雨渍 + 裂缝。压成近白，色相交给顶点色 */
function makePlaster(): SurfaceMaps {
  const size = 512
  const rng = seeded(1013)
  const el = canvas(size)
  const ctx = el.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#cfc8b8'
    ctx.fillRect(0, 0, size, size)
    // 大块色斑（受潮、修补）
    for (let i = 0; i < 26; i += 1) {
      const g = ctx.createRadialGradient(rng() * size, rng() * size, 4, rng() * size, rng() * size, 60 + rng() * 110)
      g.addColorStop(0, `rgba(120,112,98,${0.05 + rng() * 0.1})`)
      g.addColorStop(1, 'rgba(120,112,98,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, size, size)
    }
    speckle(ctx, size, rng, 9000, 140, 225, 0.32)
    // 墙面竖向雨渍
    for (let i = 0; i < 30; i += 1) {
      const x = rng() * size
      const w = 2 + rng() * 10
      const g = ctx.createLinearGradient(0, 0, 0, size)
      g.addColorStop(0, 'rgba(88,82,72,0)')
      g.addColorStop(0.35, `rgba(88,82,72,${0.05 + rng() * 0.07})`)
      g.addColorStop(1, 'rgba(88,82,72,0.11)')
      ctx.fillStyle = g
      ctx.fillRect(x, rng() * size * 0.3, w, size)
    }
    cracks(ctx, size, rng, 7, 'rgba(96,90,80,0.5)')
  }
  return { map: toTexture(el), normalMap: normalFromCanvas(el, 0.5) }
}

/** 混凝土：骨料颗粒 + 轻微污渍 + 细裂纹 */
function makeConcrete(): SurfaceMaps {
  const size = 512
  const rng = seeded(2027)
  const el = canvas(size)
  const ctx = el.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#b6b1a6'
    ctx.fillRect(0, 0, size, size)
    speckle(ctx, size, rng, 16000, 120, 220, 0.42)
    // 粗骨料
    for (let i = 0; i < 900; i += 1) {
      const v = 90 + rng() * 90
      ctx.fillStyle = `rgba(${v},${v - 4},${v - 10},0.35)`
      const s = 1.4 + rng() * 3.4
      ctx.beginPath()
      ctx.arc(rng() * size, rng() * size, s, 0, Math.PI * 2)
      ctx.fill()
    }
    for (let i = 0; i < 16; i += 1) {
      const r = 40 + rng() * 120
      const g = ctx.createRadialGradient(rng() * size, rng() * size, 2, rng() * size, rng() * size, r)
      g.addColorStop(0, `rgba(70,66,60,${0.05 + rng() * 0.08})`)
      g.addColorStop(1, 'rgba(70,66,60,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, size, size)
    }
    cracks(ctx, size, rng, 5, 'rgba(80,76,70,0.42)')
  }
  return { map: toTexture(el), normalMap: normalFromCanvas(el, 0.65) }
}

/** 屋瓦：横向瓦垄 + 每片瓦的明暗差异，颜色偏灰以便顶点色染成陶土/青瓦 */
function makeRoof(): SurfaceMaps {
  const size = 512
  const rng = seeded(3037)
  const el = canvas(size)
  const ctx = el.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#b9b3aa'
    ctx.fillRect(0, 0, size, size)
    const rows = 12
    const cols = 10
    const rh = size / rows
    const cw = size / cols
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const v = 150 + Math.floor(rng() * 70)
        ctx.fillStyle = `rgb(${v},${v - 4},${v - 10})`
        ctx.fillRect(c * cw + 1, r * rh + 1, cw - 2, rh - 2)
      }
      // 瓦垄阴影线
      ctx.fillStyle = 'rgba(60,55,50,0.5)'
      ctx.fillRect(0, r * rh, size, 2.2)
    }
    // 竖向瓦缝
    ctx.fillStyle = 'rgba(60,55,50,0.28)'
    for (let c = 0; c < cols; c += 1) ctx.fillRect(c * cw, 0, 1.6, size)
    // 青苔 / 水渍
    for (let i = 0; i < 40; i += 1) {
      const g = ctx.createRadialGradient(rng() * size, rng() * size, 1, rng() * size, rng() * size, 18 + rng() * 40)
      g.addColorStop(0, `rgba(64,72,58,${0.06 + rng() * 0.12})`)
      g.addColorStop(1, 'rgba(64,72,58,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, size, size)
    }
    speckle(ctx, size, rng, 4000, 100, 210, 0.18)
  }
  return { map: toTexture(el), normalMap: normalFromCanvas(el, 0.9) }
}

/** 波纹铁皮：竖向波纹（集装箱 / 彩钢瓦 / 仓库墙），带锈斑 */
function makeCorrugated(): SurfaceMaps {
  const size = 512
  const rng = seeded(4049)
  const el = canvas(size)
  const ctx = el.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#c3c3c0'
    ctx.fillRect(0, 0, size, size)
    const period = 26
    for (let x = 0; x < size; x += 1) {
      const t = (x % period) / period
      // 一波一谷：sin 映射到明暗，读起来就是金属起伏
      const shade = 0.62 + 0.38 * Math.cos(t * Math.PI * 2)
      const v = Math.floor(150 + shade * 95)
      ctx.fillStyle = `rgb(${v},${v},${v})`
      ctx.fillRect(x, 0, 1, size)
    }
    // 锈迹：从边角往下淌
    for (let i = 0; i < 26; i += 1) {
      const x = rng() * size
      const y = rng() * size
      const g = ctx.createRadialGradient(x, y, 1, x, y, 12 + rng() * 46)
      g.addColorStop(0, `rgba(122,66,36,${0.16 + rng() * 0.3})`)
      g.addColorStop(1, 'rgba(122,66,36,0)')
      ctx.fillStyle = g
      ctx.fillRect(x - 60, y - 60, 120, 120)
    }
    speckle(ctx, size, rng, 2600, 90, 190, 0.14)
  }
  return { map: toTexture(el), normalMap: normalFromCanvas(el, 1.35) }
}

/** 木板：竖向拼板 + 木纹 + 节疤 */
function makeWood(): SurfaceMaps {
  const size = 512
  const rng = seeded(5051)
  const el = canvas(size)
  const ctx = el.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#b59a76'
    ctx.fillRect(0, 0, size, size)
    const planks = 8
    const pw = size / planks
    for (let p = 0; p < planks; p += 1) {
      const v = 150 + Math.floor(rng() * 40)
      ctx.fillStyle = `rgb(${v + 20},${v},${v - 28})`
      ctx.fillRect(p * pw, 0, pw - 1, size)
      // 木纹：沿 V 方向的细长曲线
      for (let i = 0; i < 26; i += 1) {
        ctx.strokeStyle = `rgba(88,62,36,${0.06 + rng() * 0.16})`
        ctx.lineWidth = 0.7 + rng() * 1.4
        ctx.beginPath()
        const x0 = p * pw + rng() * pw
        ctx.moveTo(x0, 0)
        for (let y = 0; y <= size; y += 32) {
          ctx.lineTo(x0 + Math.sin((y / size) * Math.PI * 2 + rng() * 0.4) * 2.4, y)
        }
        ctx.stroke()
      }
      // 板缝
      ctx.fillStyle = 'rgba(50,36,22,0.55)'
      ctx.fillRect(p * pw, 0, 1.6, size)
      // 节疤
      if (rng() > 0.55) {
        const kx = p * pw + pw * (0.25 + rng() * 0.5)
        const ky = rng() * size
        ctx.strokeStyle = 'rgba(74,50,28,0.5)'
        for (let ring = 1; ring <= 3; ring += 1) {
          ctx.beginPath()
          ctx.ellipse(kx, ky, ring * 2.4, ring * 4.2, 0, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
    }
  }
  return { map: toTexture(el), normalMap: normalFromCanvas(el, 0.8) }
}

/**
 * 地面细节：近白的灰度噪点 + 小石子。
 * 刻意做成「无色」——地面的草/土/路面色全部由顶点色给，
 * 一张贴图就能同时服务草地、土路、营地碎石地，且接缝几乎看不出来。
 */
function makeGroundDetail(): SurfaceMaps {
  const size = 512
  const rng = seeded(6067)
  const el = canvas(size)
  const ctx = el.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#d8d4c8'
    ctx.fillRect(0, 0, size, size)
    // 大尺度斑块：避免远看是一片均匀噪声
    for (let i = 0; i < 40; i += 1) {
      const g = ctx.createRadialGradient(rng() * size, rng() * size, 8, rng() * size, rng() * size, 50 + rng() * 130)
      g.addColorStop(0, `rgba(120,116,102,${0.05 + rng() * 0.1})`)
      g.addColorStop(1, 'rgba(120,116,102,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, size, size)
    }
    speckle(ctx, size, rng, 24000, 120, 235, 0.28)
    // 小石子
    for (let i = 0; i < 1400; i += 1) {
      const v = 110 + rng() * 110
      ctx.fillStyle = `rgba(${v},${v - 6},${v - 14},${0.25 + rng() * 0.35})`
      ctx.beginPath()
      ctx.arc(rng() * size, rng() * size, 0.8 + rng() * 2.1, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  return { map: toTexture(el), normalMap: normalFromCanvas(el, 0.55) }
}

/** 一小撮草的剪影：透明底，画 14 根带弧度、上浅下深的草叶 */
function makeGrassTuft(): THREE.CanvasTexture {
  const size = 256
  const rng = seeded(7079)
  const el = canvas(size)
  const ctx = el.getContext('2d')
  if (ctx) {
    ctx.clearRect(0, 0, size, size)
    for (let i = 0; i < 16; i += 1) {
      const baseX = size * (0.2 + rng() * 0.6)
      const baseY = size * 0.98
      const tipX = baseX + (rng() - 0.5) * size * 0.5
      const tipY = size * (0.06 + rng() * 0.4)
      const width = 4 + rng() * 7
      const midX = baseX + (tipX - baseX) * 0.35 + (rng() - 0.5) * 24
      const midY = baseY - (baseY - tipY) * 0.55
      const gradient = ctx.createLinearGradient(baseX, baseY, tipX, tipY)
      gradient.addColorStop(0, 'rgba(74,88,42,0.98)')
      gradient.addColorStop(0.55, 'rgba(126,136,62,0.95)')
      gradient.addColorStop(1, 'rgba(186,182,104,0.9)')
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.moveTo(baseX - width / 2, baseY)
      ctx.quadraticCurveTo(midX - width * 0.35, midY, tipX, tipY)
      ctx.quadraticCurveTo(midX + width * 0.35, midY, baseX + width / 2, baseY)
      ctx.closePath()
      ctx.fill()
    }
  }
  // 草簇靠 alphaTest 裁形，不参与 mipmap 之外的透明排序
  const texture = toTexture(el)
  texture.premultiplyAlpha = false
  return texture
}

/** 一次性生成本场景需要的全部贴图 */
export function createSceneSurfaces(): SceneSurfaces {
  const plaster = makePlaster()
  const concrete = makeConcrete()
  const roof = makeRoof()
  const metal = makeCorrugated()
  const wood = makeWood()
  const ground = makeGroundDetail()
  const grass = makeGrassTuft()
  return {
    plaster,
    concrete,
    roof,
    metal,
    wood,
    ground,
    grass,
    all: [
      plaster.map,
      plaster.normalMap,
      concrete.map,
      concrete.normalMap,
      roof.map,
      roof.normalMap,
      metal.map,
      metal.normalMap,
      wood.map,
      wood.normalMap,
      ground.map,
      ground.normalMap,
      grass,
    ],
  }
}
