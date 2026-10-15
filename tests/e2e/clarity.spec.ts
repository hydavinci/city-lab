import { expect, test } from '@playwright/test';

test.use({ deviceScaleFactor: 2, viewport: { width: 800, height: 600 } });

test('balanced quality uses native Retina pixels instead of stretching a CSS-resolution canvas', async ({ page }) => {
  await page.goto('/tests/fixtures/clarity.html');
  await page.waitForFunction(() => Boolean(window.clarity));
  await page.evaluate(() => window.clarity.ready);
  const sizes = await page.evaluate(() => {
    const canvas = window.clarity.scene.viewer.canvas;
    return { width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, dpr: devicePixelRatio };
  });
  expect(sizes.width).toBe(sizes.cssWidth * sizes.dpr);
  expect(sizes.height).toBe(sizes.cssHeight * sizes.dpr);
});

test('recomputes the pixel budget when browser zoom or the display density changes', async ({ page }) => {
  await page.goto('/tests/fixtures/clarity.html');
  await page.waitForFunction(() => Boolean(window.clarity));
  await page.evaluate(() => window.clarity.ready);
  const width = await page.evaluate(async () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 });
    window.dispatchEvent(new Event('resize'));
    await window.clarity.scene.screenshot();
    return window.clarity.scene.viewer.canvas.width;
  });
  expect(width).toBe(1600);
});

test('near-view export preserves native detail and keeps day/night and quality switches functional', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/tests/fixtures/clarity.html');
  await page.waitForFunction(() => Boolean(window.clarity));
  await page.evaluate(() => window.clarity.ready);
  await page.evaluate(() => window.clarity.near());
  const pixels = await page.evaluate(async () => {
    const blob = await window.clarity.scene.screenshot();
    const bitmap = await createImageBitmap(blob);
    const result = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return result;
  });
  expect(pixels).toEqual({ width: 1600, height: 1200 });
  for (const quality of ['low', 'high', 'medium'] as const) {
    await page.evaluate(async ({ quality }) => {
      const url = '/web/core/settings.ts';
      const { defaultSettings } = await import(url);
      window.clarity.scene.updateSettings({ ...defaultSettings, quality, night: false });
      await window.clarity.scene.screenshot();
    }, { quality });
    const size = await page.evaluate(() => window.clarity.scene.viewer.canvas.width);
    if (quality === 'low') expect(size).toBeLessThan(1600);
    else expect(size).toBeGreaterThanOrEqual(1600);
  }
  expect(await page.evaluate(() => window.clarity.errors)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a subpixel camera movement does not randomly switch thousands of facade lights', async ({ page }) => {
  await page.goto('/tests/fixtures/clarity.html');
  await page.waitForFunction(() => Boolean(window.clarity));
  await page.evaluate(() => window.clarity.ready);
  await page.evaluate(() => window.clarity.near());
  const changedFraction = await page.evaluate(async () => {
    const scene = window.clarity.scene;
    const source = scene.viewer.canvas;
    const copy = document.createElement('canvas');
    copy.width = source.width;
    copy.height = source.height;
    const context = copy.getContext('2d')!;
    await scene.screenshot();
    context.drawImage(source, 0, 0);
    const before = context.getImageData(0, 0, copy.width, copy.height).data;
    // One centimetre at a 1700 m viewing distance is much less than a screen pixel.
    scene.viewer.camera.moveRight(0.01);
    await scene.screenshot();
    context.drawImage(source, 0, 0);
    const after = context.getImageData(0, 0, copy.width, copy.height).data;
    let changed = 0;
    for (let i = 0; i < before.length; i += 4) {
      const difference = Math.max(
        Math.abs(before[i] - after[i]),
        Math.abs(before[i + 1] - after[i + 1]),
        Math.abs(before[i + 2] - after[i + 2]),
      );
      if (difference > 32) changed++;
    }
    return changed / (copy.width * copy.height);
  });
  expect(changedFraction).toBeLessThan(0.001);
});
