import { defineConfig, devices } from '@playwright/test'
import process from 'node:process'

export default defineConfig({
  testDir: '.',
  testMatch: 'photogrammetry-validation.spec.ts',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: '../test-results/photogrammetry',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:56801',
    viewport: { width: 1440, height: 1080 },
    headless: true,
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 56801',
    url: 'http://127.0.0.1:56801',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
