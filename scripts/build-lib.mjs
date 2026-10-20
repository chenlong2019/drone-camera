/**
 * 无人机控制系统库构建编排。
 *
 * 三步，顺序固定：
 *   1. ESM   —— three 全部 external（vite.lib.config.ts --mode es）
 *   2. UMD    —— three 打进包体（--mode umd），浏览器 <script> 直挂 window.DroneControl
 *   3. .d.ts —— tsc 只产声明（tsconfig.lib.json）
 * 最后往 drone-camera/ 写一份可独立分发的 package.json。
 *
 * 用法：node scripts/build-lib.mjs
 * 产物：drone-camera/{index.js, index.js.map, index.umd.cjs, index.umd.cjs.map,
 *                    index.d.ts, lib/*.d.ts, package.json}
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 库产物目录：与包同名，整目录即「可分发的 drone-camera 包」 */
const outDir = path.join(root, 'drone-camera')

/** 读 app 的 package.json，库版本跟着 app 走 */
const appPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const t0 = Date.now()
const steps = []

function log(msg) {
  process.stdout.write(`${msg}\n`)
}

function kb(file) {
  const size = fs.statSync(file).size
  return `${(size / 1024).toFixed(1)} KB`
}

// ── 0. 清理产物目录 ────────────────────────────────────────────────────────
// 清空 drone-camera 内的旧文件,避免上次构建的残留(如已删模块的 .d.ts)混进分发产物。
//
// ⚠️ 只清「内容」,不删目录本身:本目录同时是 node_modules/drone-camera 软链的目标。
// 若把目录整个删掉再重建,编辑器(Volar / TS)会观察到模块一度消失,并把
// "Cannot find module 'drone-camera'" 记进解析缓存,必须手动重启 TS 服务才恢复;
// 保留目录 inode 可以避免这个反复出现的问题。
fs.mkdirSync(outDir, { recursive: true })
for (const entry of fs.readdirSync(outDir)) {
  fs.rmSync(path.join(outDir, entry), { recursive: true, force: true })
}

// ── 1 & 2. Vite 库构建（ESM / UMD） ────────────────────────────────────────
const { build } = await import('vite')

for (const mode of ['es', 'umd']) {
  const label = mode === 'es' ? 'ESM (three external)' : 'UMD (three bundled)'
  log(`\n▶ ${label}`)
  await build({
    root,
    configFile: path.join(root, 'vite.lib.config.ts'),
    mode,
    logLevel: 'warn',
  })
  steps.push(mode)
}

// ── 3. 类型声明 ────────────────────────────────────────────────────────────
// 用 TypeScript 编译器 API 在进程内跑：本机 spawnSync 起子进程偶发 EBUSY，
// 且进程内能拿到结构化诊断（不必去解析 stdout 文本）。
log('\n▶ 类型声明 (.d.ts)')
const ts = (await import('typescript')).default
const tsconfigPath = path.join(root, 'tsconfig.lib.json')
const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
if (configFile.error) {
  log(`✗ 读取 ${path.basename(tsconfigPath)} 失败：${ts.flattenDiagnosticMessageText(configFile.error.messageText, ' ')}`)
  process.exit(1)
}
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
const program = ts.createProgram(parsed.fileNames, parsed.options)
const emitResult = program.emit()
const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics]
if (diagnostics.length > 0) {
  for (const diagnostic of diagnostics) {
    const where = diagnostic.file
      ? `${path.relative(root, diagnostic.file.fileName)}(${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1})`
      : ''
    log(`  ${where} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)
  }
  log(`✗ 类型声明生成失败（${diagnostics.length} 个错误）—— 类型错误必须先清零，否则库没有可用的 .d.ts`)
  process.exit(1)
}

// ── 3.5 声明目录改名 ───────────────────────────────────────────────────────
// tsc 按 rootDir(src/lib) 镜像源码路径，会产出 drone-camera/drone-camera/*.d.ts。
// 分发时去掉这层重名嵌套 → drone-camera/lib/*.d.ts，
// 同时把入口声明里的 `./drone-camera/xxx` 改写成 `./lib/xxx`。
// 目录深度不变，模块之间以及 .d.ts.map 里的相对路径无需改动。
const declSrc = path.join(outDir, 'drone-camera')
const declDst = path.join(outDir, 'lib')
if (fs.existsSync(declSrc)) {
  fs.rmSync(declDst, { recursive: true, force: true })
  fs.renameSync(declSrc, declDst)
  const entryDts = path.join(outDir, 'index.d.ts')
  fs.writeFileSync(
    entryDts,
    fs.readFileSync(entryDts, 'utf8').replaceAll("'./drone-camera/", "'./lib/"),
    'utf8',
  )
  log('\n▶ 声明目录改名 drone-camera/ → lib/')
}

// ── 4. 生成可分发包描述 ────────────────────────────────────────────────────
const libPkg = {
  name: 'drone-camera',
  version: appPkg.version ?? '0.0.0',
  description:
    'Framework-agnostic drone control library for the browser: one zero-dependency flight core driving both three.js and CesiumJS backends, with capture, panorama stitching and mission editing.',
  keywords: [
    'drone',
    'uav',
    'three.js',
    'threejs',
    'cesium',
    'cesiumjs',
    'webgl',
    'webgpu',
    'flight-simulator',
    'digital-twin',
    'photogrammetry',
    'panorama',
    'mcp',
    'typescript',
  ],
  license: 'MIT',
  author: 'chenlong2019',
  homepage: 'https://github.com/chenlong2019/drone-camera#readme',
  repository: {
    type: 'git',
    url: 'git+https://github.com/chenlong2019/drone-camera.git',
  },
  bugs: {
    url: 'https://github.com/chenlong2019/drone-camera/issues',
  },
  type: 'module',
  sideEffects: false,
  main: './index.umd.cjs',
  module: './index.js',
  types: './index.d.ts',
  exports: {
    '.': {
      types: './index.d.ts',
      // ESM：three 由使用方提供（peerDependency），避免同页两份 three 实例
      import: './index.js',
      // CJS：Node 里 require() 走 UMD（three 已内联）—— three 的 examples/webgpu 只有 ESM 入口，
      // 无法产出「three external 的 CJS」，故 require 场景只能用内联 three 的 UMD 兜底
      require: './index.umd.cjs',
      default: './index.js',
    },
    './package.json': './package.json',
  },
  files: [
    'index.js',
    'index.js.map',
    'index.umd.cjs',
    'index.umd.cjs.map',
    'index.d.ts',
    'index.d.ts.map',
    'lib',
  ],
  peerDependencies: {
    three: '>=0.180.0',
    // three 不自带类型，ESM 使用方需自行安装；不装也只是丢类型提示，不影响运行
    '@types/three': '>=0.180.0',
  },
  peerDependenciesMeta: {
    '@types/three': { optional: true },
  },
}
fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(libPkg, null, 2)}\n`, 'utf8')

// ── 5. 汇总 ────────────────────────────────────────────────────────────────
log('\n产物：')
log(`  入口                ${kb(path.join(outDir, 'index.js'))} (ESM)`)
log(`  UMD                 ${kb(path.join(outDir, 'index.umd.cjs'))} (three bundled)`)
const declCount = fs
  .readdirSync(path.join(outDir, 'lib'))
  .filter((f) => f.endsWith('.d.ts')).length
log(`  lib/*.d.ts           ${declCount} 个模块声明`)
log(`\n✓ 库构建完成（${((Date.now() - t0) / 1000).toFixed(1)}s），输出目录 drone-camera/`)
