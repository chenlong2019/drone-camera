import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import vueDevTools from "vite-plugin-vue-devtools";

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages 部署在 `/<repo>/` 子路径下，构建时用 APP_BASE 覆盖；其余场景保持根路径。
  base: process.env.APP_BASE || '/',
  plugins: [vue(), vueJsx(), vueDevTools()],
  build: {
    rollupOptions: {
      output: {
        // 点云覆盖/编码只在任务结束后调用；单独分包避免被并进首屏面板 chunk。
        manualChunks(id) {
          if (id.replaceAll('\\', '/').includes('/src/lib/drone-camera/drone-recon-capture.')) return 'survey-reconstruction'
          if (id.replaceAll('\\', '/').includes('/src/lib/drone-camera/drone-splat.')) return 'survey-point-cloud'
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 56789,
  },
});
