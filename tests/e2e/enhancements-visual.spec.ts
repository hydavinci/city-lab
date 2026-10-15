import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import baseline from '../fixtures/mobility-baseline.json' with { type: 'json' };

test.use({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
test.setTimeout(180_000);

async function open(page: Page) {
  await page.goto('/tests/fixtures/mobility.html');
  await page.waitForFunction(() => Boolean(window.mobility));
  await page.evaluate(() => window.mobility.ready);
}

async function capture(page: Page, info: TestInfo, name: string) {
  const { bytes, pixels } = await page.evaluate(async (label) => {
    const blob = await window.mobility.capture(label);
    let pixels: { count: number; hash: string; headlamps: number; taillamps: number } | undefined;
    if (label.startsWith('car-a') || label.startsWith('person-a')) {
      const image = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      image.close();
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const mask = new Uint8Array(canvas.width * canvas.height);
      let headlamps = 0, taillamps = 0;
      for (let i = 0; i < mask.length; i++) {
        const [r, g, b] = rgba.subarray(i * 4, i * 4 + 3);
        mask[i] = Number(label.startsWith('person-a')
          ? r > 60 && r > g * 1.5 && r > b * 1.5
          : b > 60 && b > r * 1.5 && g > r * 1.2);
        if (r > 180 && g > 170 && r > g && b < g * 0.95) headlamps++;
        if (r > 80 && r > g * 2 && r > b * 2) taillamps++;
      }
      pixels = {
        count: mask.reduce((sum, pixel) => sum + pixel, 0),
        headlamps, taillamps,
        hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', mask)))
          .map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      };
    }
    return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), pixels };
  }, name);
  const path = info.outputPath(`${name}.png`);
  await writeFile(path, Buffer.from(bytes));
  await info.attach(name, { path, contentType: 'image/png' });
  if (pixels) expect(pixels.count, `${name} must contain visible actor pixels`).toBeGreaterThan(1000);
  return pixels;
}

test('unchanged base city and selected district baseline, day and night; actors honestly absent', async ({ page }, info) => {
  await open(page);
  const metadata = [];
  for (const view of ['city', 'district'] as const) {
    for (const night of [false, true]) {
      const result = await page.evaluate(({ view, night }) => window.mobility.baseline(view, night), { view, night });
      expect(result).toMatchObject({
        baseDataset: baseline.baseDataset, camera: baseline[view],
        origin: baseline.candidate.origin, routeWidths: baseline.candidate.routeWidths,
        quality: baseline.quality, viewport: baseline.viewport, dpr: baseline.dpr,
        beforeActors: baseline.beforeActors, night,
      });
      metadata.push(result);
      await capture(page, info, `before-${view}-${night ? 'night' : 'day'}`);
    }
  }
  const path = info.outputPath('baseline-metadata.json');
  await writeFile(path, JSON.stringify(metadata, null, 2));
  await info.attach('baseline-metadata', { path, contentType: 'application/json' });
  expect(await page.evaluate(() => window.mobility.errors)).toEqual([]);
});

test('real slice has metre dimensions, ground contact, visible cardinal headings and Walk independent of city clock', async ({ page }, info) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await open(page);
  const clock = await page.evaluate(() => window.mobility.clock());
  await page.evaluate(() => window.mobility.assetViews());
  const measurements = [];
  for (const kind of ['car-a', 'person-a'] as const) {
    for (const [heading, direction] of [
      [0, [0, 1, 0]], [Math.PI / 2, [1, 0, 0]], [Math.PI, [0, -1, 0]], [3 * Math.PI / 2, [-1, 0, 0]],
    ] as const) {
      await page.evaluate(({ kind, heading }) => window.mobility.view(kind, heading), { kind, heading });
      const result = await page.evaluate((kind) => window.mobility.measure(kind), kind);
      measurements.push({ kind, heading, ...result });
      expect(result.ready).toBe(true);
      expect(result.sphereRadius).toBeGreaterThan(0.5);
      expect(result.sphereRadius).toBeLessThan(3);
      result.direction.forEach((value, i) => expect(value).toBeCloseTo(direction[i], 5));
      expect(Math.abs(result.bounds.min[2])).toBeLessThan(0.005);
      const expected = kind === 'car-a'
        ? (heading === Math.PI / 2 || heading === 3 * Math.PI / 2 ? [4.4, 1.8, 1.45] : [1.8, 4.4, 1.45])
        : [undefined, undefined, 1.75];
      expected.forEach((value, i) => { if (value !== undefined) expect(Math.abs(result.bounds.size[i] - value) / value).toBeLessThan(0.05); });
      if (kind === 'person-a') {
        expect(result.animations).toEqual(['Walk']);
        expect(result.animationDurations).toEqual([1]);
      }
      const pixels = await capture(page, info, `${kind}-heading-${Math.round(heading * 180 / Math.PI)}`);
      if (kind === 'car-a' && heading === 0) expect(pixels!.headlamps).toBeGreaterThan(600);
      if (kind === 'car-a' && heading === Math.PI) expect(pixels!.taillamps).toBeGreaterThan(600);
    }
    await page.evaluate((kind) => window.mobility.view(kind, 0, true), kind);
    await capture(page, info, `${kind}-side`);
  }
  const neutral = await page.evaluate(() => window.mobility.measure('person-a'));
  const sampled: typeof neutral[] = [];
  const walkingPixels = [];
  for (let step = 0; step <= 24; step++) {
    await page.evaluate((phase) => window.mobility.phase(phase), step / 24);
    sampled.push(await page.evaluate(() => window.mobility.measure('person-a')));
    expect(Math.abs(sampled[step].bounds.min[2])).toBeLessThan(0.005);
    if (step === 6 || step === 18) walkingPixels.push(await capture(page, info, `person-a-walk-${step}`));
  }
  expect(sampled[6].limbMatrices).not.toEqual(neutral.limbMatrices);
  expect(sampled[18].limbMatrices).not.toEqual(sampled[6].limbMatrices);
  await page.evaluate(() => window.mobility.phase(0));
  const stopped = await page.evaluate(() => window.mobility.measure('person-a').limbMatrices);
  const stoppedPixels = await capture(page, info, 'person-a-stopped-immediate');
  walkingPixels.forEach((pixels) => expect(pixels!.hash).not.toBe(stoppedPixels!.hash));
  await page.waitForTimeout(300);
  expect(await capture(page, info, 'person-a-stopped')).toEqual(stoppedPixels);
  expect(await page.evaluate(() => window.mobility.measure('person-a').limbMatrices)).toEqual(stopped);
  stopped.forEach((matrix, i) => matrix.forEach((value, j) => expect(value).toBeCloseTo(neutral.limbMatrices[i][j], 5)));
  expect(await page.evaluate(() => window.mobility.clock())).toBe(clock);
  const animatedBounds = {
    min: [0, 1, 2].map((i) => Math.min(...sampled.map((sample) => sample.bounds.min[i]))),
    max: [0, 1, 2].map((i) => Math.max(...sampled.map((sample) => sample.bounds.max[i]))),
  };
  const path = info.outputPath('runtime-measurements.json');
  await writeFile(path, JSON.stringify({ measurements, animatedBounds, sampled, clock }, null, 2));
  await info.attach('runtime-measurements', { path, contentType: 'application/json' });
  expect(await page.evaluate(() => window.mobility.errors)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('missing model fails explicitly and promptly, not as a ready scene', async ({ page }) => {
  await page.route('**/enhancements/slice/car-a.glb', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await open(page);
  const error = await page.evaluate(async () => {
    try { await window.mobility.assetViews(); return null; } catch (e) { return String(e); }
  });

  expect(error).toContain('HTTP 404');
  expect(await page.evaluate(() => window.mobility.errors)).not.toEqual([]);
});

test('failure of second asset removes the partially loaded slice', async ({ page }) => {
  await page.route('**/enhancements/slice/person-a.glb', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await open(page);
  const result = await page.evaluate(async () => {
    try { await window.mobility.assetViews(); } catch { /* Inspect the failed load below. */ }
    try { window.mobility.measure('car-a'); return 'unexpected loaded car'; }
    catch (error) { return String(error); }
  });
  expect(result).toContain('not rendered-ready');
  expect(await page.evaluate(() => window.mobility.errors.join('\n'))).toContain('HTTP 404');
});

test('stalled asset read rejects within its deadline', async ({ page }) => {
  await page.route('**/enhancements/slice/car-a.glb', () => {});
  await open(page);
  const result = await page.evaluate(async () => {
    const started = performance.now();
    try { await window.mobility.assetViews(); return { error: '', elapsed: 0 }; }
    catch (error) { return { error: String(error), elapsed: performance.now() - started }; }
  });
  expect(result.error).toMatch(/timeout|timed out/i);
  expect(result.elapsed).toBeLessThan(21_000);
  expect(await page.evaluate(() => window.mobility.errors.join('\n'))).toContain('read car-a');
});
