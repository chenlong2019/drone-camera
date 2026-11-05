import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const diagnostics = (page: import('@playwright/test').Page) =>
  page.evaluate(() => window.__DIGITAL_CAMPUS_DEMO__!.getDiagnostics())

test('canvas gestures, controls, flight capture and pause stay responsive', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/digital-campus-demo')
  await expect(page.locator('.status-chip')).toHaveText('已规划', { timeout: 60_000 })
  await expect(page.locator('.loading-mask')).toHaveCount(0)
  expect(await page.evaluate(() => document.elementFromPoint(700, 480)?.classList.contains('campus-canvas'))).toBe(true)
  const initial = await diagnostics(page)
  await page.mouse.move(660, 480)
  await page.mouse.down()
  await page.mouse.move(770, 530, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await diagnostics(page)).camera).not.toEqual(initial.camera)
  const rotated = await diagnostics(page)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(730, 540, { steps: 5 })
  await page.mouse.up({ button: 'right' })
  await expect.poll(async () => (await diagnostics(page)).target).not.toEqual(rotated.target)
  const distance = async () => {
    const { camera, target } = await diagnostics(page)
    return Math.hypot(...camera!.map((n, i) => n - target![i]!))
  }
  const beforeZoom = await distance()
  await page.mouse.wheel(0, -200)
  await expect.poll(distance).toBeLessThan(beforeZoom)
  await page.getByRole('button', { name: '园区总览', exact: true }).click()
  await page.screenshot({ path: 'test-results/digital-campus/desktop.png' })

  await page.locator('.dcp [data-action="power-on"]').click()
  await expect.poll(async () => (await diagnostics(page)).phase).not.toBe('powerOff')
  await page.getByRole('button', { name: '开始自主采集', exact: true }).click()
  await expect.poll(async () => (await diagnostics(page)).flightAltitude, { timeout: 30_000 }).toBeGreaterThan(1)
  await expect.poll(async () => (await diagnostics(page)).captured, { timeout: 90_000 }).toBeGreaterThanOrEqual(5)
  await page.locator('.survey-card').getByRole('button', { name: '暂停', exact: true }).click()
  await expect(page.locator('.status-chip')).toHaveText('已暂停')
  await expect.poll(async () => (await diagnostics(page)).captureBusy).toBe(false)
  const paused = await diagnostics(page)
  await expect.poll(async () => (await diagnostics(page)).captured).toBe(paused.captured)
  await page.locator('.survey-card').getByRole('button', { name: '继续', exact: true }).click()
  await expect.poll(async () => (await diagnostics(page)).captured, { timeout: 60_000 }).toBeGreaterThan(paused.captured)
  await page.getByRole('button', { name: '结束任务', exact: true }).click()
  await expect(page.locator('.status-chip')).toHaveText('已结束')
  await expect.poll(async () => (await diagnostics(page)).pointCloudPoints).toBeGreaterThan(0)
  const [pointCloud] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出 point-cloud.ply', exact: true }).click(),
  ])
  const ply = await readFile((await pointCloud.path())!, 'utf8')
  expect(ply.startsWith('ply\nformat ascii 1.0')).toBe(true)
  expect(ply).toContain('element vertex ')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出 manifest.json', exact: true }).click(),
  ])
  const manifest = JSON.parse(await readFile((await download.path())!, 'utf8'))
  expect(manifest.images.length).toBeGreaterThanOrEqual(5)
  expect(manifest.images.every((image: { position: number[]; rotation: number[] }) => image.position.length === 3 && image.rotation.length === 4)).toBe(true)
  expect(errors).toEqual([])
  console.log('Campus diagnostics:', await diagnostics(page))
})

test('small viewport and route remount keep the scene usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/digital-campus-demo')
  await expect(page.locator('.status-chip')).toHaveText('已规划', { timeout: 60_000 })
  expect(await page.evaluate(() => document.elementFromPoint(180, 300)?.classList.contains('campus-canvas'))).toBe(true)
  await expect(page.locator('.dcp')).toBeHidden()
  await expect(page.locator('.library-panels > .dmp')).toHaveCount(0)
  await page.getByRole('button', { name: '航点列表', exact: true }).click()
  await expect(page.locator('.library-panels > .dmp')).toHaveCount(1)
  await page.getByRole('button', { name: '测绘任务', exact: true }).click()
  await expect(page.locator('.library-panels > .dmp')).toBeHidden()
  await page.getByRole('button', { name: '开始自主采集', exact: true }).click()
  await page.getByRole('button', { name: '结束任务', exact: true }).click()
  await expect(page.locator('.status-chip')).toHaveText('已结束')
  await expect.poll(async () => (await diagnostics(page)).captureBusy).toBe(false)
  await page.screenshot({ path: 'test-results/digital-campus/mobile.png' })
  // Use in-app navigation to exercise Vue's unmount/remount, not a full reload.
  await page.getByRole('link', { name: '返回示例', exact: true }).click()
  await expect(page.locator('.campus-demo')).toHaveCount(0)
  expect(await page.evaluate(() => window.__DIGITAL_CAMPUS_DEMO__)).toBeUndefined()
  await page.goBack()
  await expect(page.locator('.status-chip')).toHaveText('已规划', { timeout: 60_000 })
  await expect(page.locator('.campus-canvas')).toHaveCount(1)
  await expect(page.locator('.library-panels > .dcp')).toHaveCount(1)
})
