import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'

/**
 * 无人机控制系统库构建配置。
 *
 * 与 app 构建（vite.config.ts）完全隔离：这里不加载 vue 插件、不改 app 的 outDir，
 * 产物全部落在 drone-camera/（与包同名，整目录即可分发）。
 *
 * 两种模式（由 scripts/build-lib.mjs 依次驱动）：
 *   --mode es   → 只出 ESM。three / three/webgpu / three/examples/jsm/*
 *                 全部 external，声明为 peerDependency，使用方复用自带的那一份 three。
 *   --mode umd  → 只出 UMD（全局名 DroneControl）。three 一并打进包体，
 *                 供 <script> 直接引入、无需任何构建工具，代价是包体较大。
 *
 * 不输出 CJS：three 0.186 的 WebGPU/TSL 入口本身就是 ESM，CJS 双格式收益极低，
 * 且 require 场景可由 UMD 产物兜底。
 */
export default defineConfig(({ mode }) => {
  const umd = mode === 'umd'

  return {
    /**
     * UMD 必须显式定义 import.meta.url。
     * 原因：three 的 DRACOLoader.js 在【模块顶层】执行
     *   new URL('../libs/draco/draco_decoder.wasm', import.meta.url)
     * 非 ESM 格式下 import.meta 会被置空为 {}，于是 new URL(..., {}) 抛
     * "Failed to construct 'URL': Invalid base URL"，整个 UMD 工厂体中途中断，
     * 表现为 window.DroneControl 存在但零导出（构建期只给一条 EMPTY_IMPORT_META 警告，极易漏掉）。
     * 经典脚本求值期 document.currentScript 就是本脚本，语义上正是"脚本自身 URL"，回退到页面地址。
     */
    define: umd
      ? { 'import.meta.url': '(document.currentScript && document.currentScript.src) || location.href' }
      : {},
    // 库构建不拷 public/
    publicDir: false,
    // 保留 @ 别名以便库内互相引用
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      outDir: 'drone-camera',
      // 清理由 build-lib.mjs 统一负责（两次构建写同一个目录，交给 Vite 会互相擦除）
      emptyOutDir: false,
      sourcemap: true,
      lib: {
        entry: fileURLToPath(new URL('./src/lib/index.ts', import.meta.url)),
        // UMD 全局变量名，仅 browser 直挂时使用
        name: 'DroneControl',
        formats: [umd ? 'umd' : 'es'],
        fileName: () => (umd ? 'index.umd.cjs' : 'index.js'),
      },
      // ESM 产物保持可读（使用方自行压缩）；UMD 供直挂，压缩以控制体积
      minify: umd,
      // ESM 不下调语法（TSL / WebGPU 代码依赖现代语法）；UMD 放宽到 es2020 以兼容直挂
      target: umd ? 'es2020' : 'esnext',
      rollupOptions: {
        external: umd ? [] : [/^three(\/.*)?$/],
        output: umd
          ? {
              // UMD 不允许分包，强制内联动态导入（当前无动态导入，作为保险）
              inlineDynamicImports: true,
            }
          : {},
      },
    },
  }
})
