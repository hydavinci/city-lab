import { expect, test } from '@playwright/test';

test('serves local Cesium runtime assets rather than the SPA fallback HTML', async ({ request }) => {
  const response = await request.get('/cesium/Assets/approximateTerrainHeights.json');
  expect(response.headers()['content-type']).toContain('application/json');
  expect(Object.keys(await response.json()).length).toBeGreaterThan(0);
  const worker = await request.get('/cesium/Workers/createGeometry.js');
  expect(worker.headers()['content-type']).toMatch(/javascript/);
});

test('renders a local city without hosted services and supports scene controls', async ({ page }) => {
  const external: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '苏州' })).toBeVisible();
  await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
  await expect(page.locator('.cesium-widget canvas')).toBeVisible();
  await page.getByRole('button', { name: '金鸡湖', exact: true }).click();
  await expect(page.getByTestId('loaded-buildings')).not.toHaveText('0', { timeout: 60_000 });
  await page.getByRole('button', { name: '日景', exact: true }).click();
  await expect(page.getByRole('button', { name: '日景', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const roads = page.getByRole('switch', { name: '道路网络' });
  await roads.click();
  await expect(roads).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('switch', { name: '道路网络' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('估算高度', { exact: false }).first()).toBeVisible();
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('exports a screenshot and rejects invalid imported configuration', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出截图', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
  await page.getByTestId('import-config').setInputFiles({
    name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"version":99}'),
  });
  await expect(page.getByRole('alert')).toContainText('配置');
});

test('explains missing datasets instead of inventing a city', async ({ page }) => {
  await page.route('**/data/manifest.json', (route) => route.fulfill({ status: 404, body: 'Not found' }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('数据');
  await expect(page.getByRole('alert')).toContainText('data:build');
});

test('releases near-view building tiles when returning to the full municipality', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
  await page.getByRole('button', { name: '姑苏古城', exact: true }).click();
  await expect(page.getByTestId('loaded-buildings')).not.toHaveText('0', { timeout: 60_000 });
  await page.getByRole('button', { name: '苏州市全域', exact: true }).click();
  await expect(page.getByTestId('loaded-buildings')).toHaveText('0');
});

test('shows failed building tile requests and allows retry without replacing source data', async ({ page }) => {
  await page.route('**/tiles/*.json', (route) => route.fulfill({ status: 503, body: 'Temporarily unavailable' }));
  await page.goto('/');
  await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
  await page.getByRole('button', { name: '金鸡湖', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('分块');
  await page.unroute('**/tiles/*.json');
  await page.getByRole('button', { name: '重试加载', exact: true }).click();
  await expect(page.getByTestId('loaded-buildings')).not.toHaveText('0', { timeout: 60_000 });
});

test('does not announce readiness or enable screenshots while geometry workers are blocked', async ({ page }) => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const workerStarted = new Promise<void>((resolve) => { started = resolve; });
  await page.route('**/cesium/Workers/createGeometry.js', async (route) => {
    started();
    await gate;
    await route.continue();
  });
  try {
    await page.goto('/');
    await workerStarted;
    await expect(page.getByRole('button', { name: '导出截图', exact: true })).toBeDisabled();
    await expect(page.getByTestId('scene-state')).toHaveText('等待数据');
  } finally {
    release();
  }
  await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
});

test('applies display changes made before the manifest finishes loading', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/data/manifest.json', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: '日景', exact: true }).click();
  release();
  await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
  await expect.poll(async () => page.locator('.cesium-widget canvas').evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d')!;
    context.drawImage(canvas, 0, 0);
    const [r, g, b] = context.getImageData(5, Math.floor(canvas.height / 2), 1, 1).data;
    return r + g + b;
  })).toBeGreaterThan(200);
});
