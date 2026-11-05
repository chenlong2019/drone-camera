import { defineConfig } from '@playwright/test'
import process from 'node:process'

export default defineConfig({
  testDir: '.',
  testMatch: 'digital-campus.spec.ts',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  expect: { timeout: 15_000 },
  outputDir: '../test-results/digital-campus',
  use: {
    headless: true,
    baseURL: 'http://127.0.0.1:4175',
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
