/// <reference lib="dom" />
import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

async function downloadJson(page: Page, button: string): Promise<Record<string, unknown>> {
  const event = page.waitForEvent('download')
  await page.getByTestId(button).click()
  const download = await event
  expect(download.suggestedFilename()).toMatch(/\.json$/)
  expect(await download.failure()).toBeNull()
  const path = await download.path()
  if (!path) throw new Error(`No downloaded file for ${button}`)
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

function finiteTuple(value: unknown, count: number): number[] {
  expect(Array.isArray(value)).toBe(true)
  const tuple = value as number[]
  expect(tuple).toHaveLength(count)
  expect(tuple.every((entry) => typeof entry === 'number' && Number.isFinite(entry))).toBe(true)
  return tuple
}

async function scenePixels(page: Page): Promise<number[]> {
  return page
    .locator('.cesium-widget canvas')
    .first()
    .evaluate(async (element) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      const canvas = document.createElement('canvas')
      canvas.width = 96
      canvas.height = 54
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas 2D is unavailable')
      context.drawImage(element as HTMLCanvasElement, 0, 0, canvas.width, canvas.height)
      return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data)
    })
}

function pixelDifference(first: number[], second: number[]): number {
  expect(first).toHaveLength(second.length)
  let difference = 0
  for (let index = 0; index < first.length; index++) {
    if (index % 4 !== 3) difference += Math.abs(first[index]! - second[index]!)
  }
  return difference / ((first.length * 3) / 4)
}

function buildingEvidence(pixels: number[]) {
  // The local fixture has a flat green ground. Sample its side margins, then
  // require a substantial foreground silhouette around the known target.
  const channels: number[][] = [[], [], []]
  for (let y = 13; y < 41; y++) {
    for (let x = 0; x < 96; x++) {
      if (x >= 12 && x < 84) continue
      for (let channel = 0; channel < 3; channel++) {
        channels[channel]!.push(pixels[(y * 96 + x) * 4 + channel]!)
      }
    }
  }
  const ground = channels.map(
    (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!,
  )
  const foreground: number[] = []
  let left = 96,
    right = -1,
    top = 54,
    bottom = -1
  for (let y = 13; y < 41; y++) {
    for (let x = 24; x < 72; x++) {
      const offset = (y * 96 + x) * 4
      const distance = Math.hypot(
        ...ground.map((value, channel) => pixels[offset + channel]! - value),
      )
      if (distance <= 45) continue
      foreground.push(y * 96 + x)
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  return {
    ground,
    foreground,
    foregroundPixels: foreground.length,
    width: Math.max(0, right - left + 1),
    height: Math.max(0, bottom - top + 1),
  }
}

test('captures real Cesium frames, checks metadata, previews Tiles and releases the page', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/photogrammetry-validation')
  await page.getByTestId('init-scene').click()
  await expect(page.getByTestId('scene-status')).toContainText('场景就绪', { timeout: 90_000 })
  await page.getByTestId('capture-batch').click()
  await expect(page.getByTestId('image-count')).toHaveText('8', { timeout: 90_000 })
  await expect(page.getByTestId('frame-audit-result')).toContainText('8 / 8')
  await page.getByTestId('validate-capture').click()
  await expect(page.getByTestId('capture-result')).toContainText('采集检查通过')

  const thumbnails = page.locator('img[src^="data:image/"], img[src^="blob:"]')
  await expect(thumbnails.first()).toBeVisible()
  const pixels = await thumbnails.first().evaluate(async (element) => {
    const image = element as HTMLImageElement
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D is unavailable')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    let total = 0
    let squared = 0
    for (let index = 0; index < data.length; index += 4) {
      const luma = 0.2126 * data[index]! + 0.7152 * data[index + 1]! + 0.0722 * data[index + 2]!
      total += luma
      squared += luma * luma
    }
    const count = data.length / 4
    const mean = total / count
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      mean,
      variance: squared / count - mean * mean,
    }
  })
  expect(pixels.width).toBeGreaterThan(200)
  expect(pixels.height).toBeGreaterThan(200)
  expect(pixels.variance).toBeGreaterThan(1)
  expect(pixels.mean).toBeGreaterThan(1)
  expect(pixels.mean).toBeLessThan(254)

  const manifest = await downloadJson(page, 'download-manifest')
  expect(manifest.schemaVersion).toBe(1)
  const camera = manifest.camera as Record<string, number>
  expect(camera.width).toBe(pixels.width)
  expect(camera.height).toBe(pixels.height)
  expect(camera.fx).toBeGreaterThan(0)
  expect(camera.fy).toBeGreaterThan(0)
  const images = manifest.images as Array<Record<string, unknown>>
  expect(images).toHaveLength(8)
  for (const image of images) {
    expect(image.captureStatus).toBe('success')
    finiteTuple(image.position, 3)
    const rotation = finiteTuple(image.rotation, 4)
    expect(Math.hypot(...rotation)).toBeCloseTo(1, 8)
    expect(image.width).toBe(camera.width)
    expect(image.height).toBe(camera.height)
    expect(image.sizeBytes).toBeGreaterThan(0)
    expect(image.file).toMatch(/^images\/.+\.png$/)
  }

  await page.getByTestId('load-sample-tiles').click()
  await expect(page.getByTestId('tiles-status')).toContainText('可见瓦片就绪', { timeout: 60_000 })
  await page.getByTestId('compare-mode').selectOption('original')
  const originalPixels = await scenePixels(page)
  const originalEvidence = buildingEvidence(originalPixels)
  expect(
    originalEvidence.foregroundPixels,
    'The original building must occupy the central target area',
  ).toBeGreaterThan(50)
  await page.getByTestId('compare-mode').selectOption('reconstructed')
  await expect
    .poll(async () => pixelDifference(await scenePixels(page), originalPixels))
    .toBeGreaterThan(1)
  await expect
    .poll(async () => buildingEvidence(await scenePixels(page)).foregroundPixels, {
      message: 'Tiles-only must render a building, not an empty green ground',
    })
    .toBeGreaterThan(Math.max(40, originalEvidence.foregroundPixels * 0.25))
  const tilesPixels = await scenePixels(page)
  const tilesEvidence = buildingEvidence(tilesPixels)
  expect(tilesEvidence.width).toBeGreaterThanOrEqual(8)
  expect(tilesEvidence.height).toBeGreaterThanOrEqual(8)
  const originalMask = new Set(originalEvidence.foreground)
  const overlap = tilesEvidence.foreground.filter((pixel) => originalMask.has(pixel)).length
  expect(
    overlap / originalEvidence.foregroundPixels,
    'Tiles must appear at the original building location',
  ).toBeGreaterThan(0.2)
  await testInfo.attach('tiles-render-evidence', {
    body: JSON.stringify(
      {
        originalForegroundPixels: originalEvidence.foregroundPixels,
        tilesForegroundPixels: tilesEvidence.foregroundPixels,
        tilesWidth: tilesEvidence.width,
        tilesHeight: tilesEvidence.height,
        overlapPixels: overlap,
        sampledGroundRgb: tilesEvidence.ground,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })
  await testInfo.attach('tiles-only', {
    body: await page.screenshot({
      path: 'test-results/photogrammetry/tiles-only.png',
      fullPage: true,
    }),
    contentType: 'image/png',
  })
  await page.getByTestId('compare-mode').selectOption('both')
  await expect(page.getByTestId('compare-mode')).toHaveValue('both')
  const report = await downloadJson(page, 'download-report')
  expect(report.reconstructionStatus).toBe('not-run')
  expect(report.frameAudits).toHaveLength(8)
  const audits = report.frameAudits as Array<Record<string, unknown>>
  for (const audit of audits) {
    expect(audit.passed).toBe(true)
    expect(audit.pixelsMatch).toBe(true)
    expect(audit.observerRestored).toBe(true)
    expect(typeof audit.targetProjectionErrorPixels).toBe('number')
    expect(Number.isFinite(audit.targetProjectionErrorPixels)).toBe(true)
    expect(audit.targetProjectionErrorPixels).toBeLessThan(1e-4)
  }
  const quality = report.imageQuality as Record<string, { decodable: boolean; variance: number }>
  expect(Object.keys(quality)).toHaveLength(8)
  for (const probe of Object.values(quality)) {
    expect(probe.decodable).toBe(true)
    expect(probe.variance).toBeGreaterThan(0)
  }
  expect(report.captureValidation).toMatchObject({ valid: true, imageCount: 8 })
  expect(report.tiles).toBeTruthy()
  await testInfo.attach('capture-manifest', {
    body: JSON.stringify(manifest, null, 2),
    contentType: 'application/json',
  })
  await testInfo.attach('validation-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  })
  await testInfo.attach('validation-page', {
    body: await page.screenshot({
      path: 'test-results/photogrammetry/validation-page.png',
      fullPage: true,
    }),
    contentType: 'image/png',
  })

  // A rejected replacement must keep the loaded tileset visible and usable.
  await page.getByTestId('compare-mode').selectOption('reconstructed')
  await page.route('**/validation/malformed-tileset.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ asset: { version: '1.1' }, geometricError: 0 }),
    }),
  )
  await page.getByLabel('tileset.json 地址').fill('/validation/malformed-tileset.json')
  await page.getByRole('button', { name: '加载成果', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('root is required')
  await expect(page.getByTestId('tiles-status')).toContainText('可见瓦片就绪')
  const retainedPixels = await scenePixels(page)
  expect(pixelDifference(retainedPixels, tilesPixels)).toBeLessThan(0.1)
  expect(pixelDifference(retainedPixels, originalPixels)).toBeGreaterThan(1)
  const failureReport = await downloadJson(page, 'download-report')
  expect(failureReport.tiles).toMatchObject({
    url: '/validation/tileset.json',
    lastLoadAttempt: {
      url: '/validation/malformed-tileset.json',
      status: 'failed',
      error: expect.stringContaining('root is required'),
    },
  })
  await testInfo.attach('rejected-tiles-report', {
    body: JSON.stringify(failureReport, null, 2),
    contentType: 'application/json',
  })
  await page.unroute('**/validation/malformed-tileset.json')

  // Use client-side navigation so Vue must dispose the existing Cesium viewer.
  await page.locator('a[href="/docs"]').first().click()
  await expect(page).toHaveURL(/\/docs$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/photogrammetry-validation$/)
  await page.getByTestId('init-scene').click()
  await expect(page.getByTestId('scene-status')).toContainText('场景就绪', { timeout: 90_000 })
  await expect(page.getByTestId('image-count')).toHaveText('0')
  expect(pageErrors).toEqual([])
})
