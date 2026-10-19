import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Cesium3DTileset } from 'cesium';
import type { BuildingFeature, CityManifest } from '../../web/core/types';

const source = JSON.parse(readFileSync('assets/architecture/source.json', 'utf8')) as {
  buildings: { style: string; origin: [number, number] }[];
};
const manifest = JSON.parse(readFileSync('public/data/manifest.json', 'utf8')) as CityManifest;

test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
test.setTimeout(120_000);

async function open(page: Page) {
  await page.goto('/tests/fixtures/mobility.html');
  await page.waitForFunction(() => Boolean(window.mobility));
  await page.evaluate(() => window.mobility.ready);
}

async function move(page: Page, range = 190, style = 'residential') {
  const entry = source.buildings.find(building => building.style === style)!;
  await page.evaluate(({ origin, range }) => {
    const { scene, geometry: { Cartesian3, HeadingPitchRange, Matrix4 } } = window.mobility;
    scene.viewer.camera.lookAt(Cartesian3.fromDegrees(origin[0], origin[1]),
      new HeadingPitchRange(15 * Math.PI / 180, -42 * Math.PI / 180, range));
    scene.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    scene.viewer.scene.requestRender();
  }, { origin: entry.origin, range });
}

const capture = (page: Page) => page.evaluate(async () => (await window.mobility.scene.screenshot()).size);
const state = (page: Page) => page.evaluate(() => window.mobility.architecture.resources());

test('native source bodies pick original metadata, retain settings and cache, and dispose cleanly', async ({ page }) => {
  const legacyRequests: string[] = [];
  page.on('request', request => {
    if (/\/data\/[^/]+\/tiles\/|\/architecture\/|city-architecture\.worker/.test(request.url())) {
      legacyRequests.push(request.url());
    }
  });
  await open(page);
  await move(page);
  expect(await capture(page)).toBeGreaterThan(0);
  const ready = await state(page);
  expect(ready).toMatchObject({ tilesets: 1, loading: false, disposed: false });
  expect(ready.failure).toBeUndefined();
  expect(ready.near).toBeGreaterThan(0);
  expect(ready.visibleBuildings).toBe(ready.far + ready.mid + ready.near);
  expect(ready.bytes).toBeLessThanOrEqual(ready.cacheBytes + ready.maximumCacheOverflowBytes);
  const picked = await page.evaluate(() => {
    const { scene, architecture, geometry: { Cartesian2 } } = window.mobility, canvas = scene.viewer.canvas;
    for (const radius of [0, 0.08, 0.16, 0.24]) {
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const selected = architecture.selected(scene.viewer.scene.pick(new Cartesian2(
          canvas.clientWidth * (0.5 + dx * radius), canvas.clientHeight * (0.5 + dy * radius),
        )));
        if (selected) return selected;
      }
    }
    return null;
  });
  expect(picked).not.toBeNull();
  let original: BuildingFeature['properties'] | undefined;
  for (const tile of manifest.tiles) {
    const data = JSON.parse(readFileSync(`public/data/${manifest.dataset}/tiles/${tile.id}.json`, 'utf8')) as {
      features: BuildingFeature[];
    };
    original = data.features.find(feature => feature.properties.id === picked!.id)?.properties;
    if (original) break;
  }
  expect(picked).toEqual(original);
  expect(await page.evaluate(async () => {
    const { scene, architecture, settings } = window.mobility;
    const native = Reflect.get(architecture, 'tileset') as Cesium3DTileset;
    scene.updateSettings({ ...settings(), night: true, glow: 0.8 });
    await scene.screenshot();
    return {
      same: native === Reflect.get(architecture, 'tileset'),
      night: native.customShader!.uniforms.u_night.value, glow: native.customShader!.uniforms.u_glow.value,
    };
  })).toEqual({ same: true, night: 1, glow: 0.8 });
  await page.evaluate(async () => {
    const { scene, settings } = window.mobility;
    scene.updateSettings({ ...settings(), quality: 'low' });
    await scene.screenshot();
  });
  const low = await state(page);
  expect(low.cacheBytes).toBe(low.farWorkingSetBytes + 64 * 1024 * 1024);
  expect(low.bytes).toBeLessThanOrEqual(low.cacheBytes + low.maximumCacheOverflowBytes);
  await page.evaluate(async () => {
    const { scene, settings } = window.mobility;
    scene.updateSettings({ ...settings(), buildings: false });
    await scene.screenshot();
  });
  expect(await state(page)).toMatchObject({ tilesets: 1, visibleTiles: 0, visibleBuildings: 0, loading: false });
  expect(await page.evaluate(() => window.mobility.errors)).toEqual([]);
  expect(legacyRequests).toEqual([]);
  const disposed = await page.evaluate(() => {
    const { scene, architecture } = window.mobility;
    const native = Reflect.get(architecture, 'tileset') as Cesium3DTileset;
    scene.destroy();
    return { ...architecture.resources(), destroyed: native.isDestroyed() };
  });
  expect(disposed).toMatchObject({ tilesets: 0, cachedTiles: 0, bytes: 0, disposed: true, destroyed: true });
});

test('district cold load halves the baseline and a resident return needs no downloads or regeneration', async ({ page }, info) => {
  const downloads: string[] = [];
  page.on('request', request => { if (/\/architecture-city\/.*\.glb/.test(request.url())) downloads.push(request.url()); });
  await open(page);
  const cold = await page.evaluate(async () => {
    const start = performance.now();
    await window.mobility.baseline('district', false);
    return performance.now() - start;
  });
  const first = await state(page);
  await page.evaluate(async () => { window.mobility.scene.home(0); await window.mobility.scene.screenshot(); });
  expect((await state(page)).visibleBuildings).toBeGreaterThan(0);
  const prior = downloads.length;
  const revisit = await page.evaluate(async () => {
    const start = performance.now();
    await window.mobility.baseline('district', false);
    return performance.now() - start;
  });
  const result = { cold, revisit, returnDownloads: downloads.length - prior, viewport: [1440, 1000],
    renderer: 'Chromium SwiftShader', first, returned: await state(page), baseline: { cold: 34630.7, revisit: 31570.2 } };
  await mkdir('artifacts/unified-city', { recursive: true });
  const path = 'artifacts/unified-city/loading.json';
  await writeFile(path, JSON.stringify(result, null, 2));
  await info.attach('native-loading', { path, contentType: 'application/json' });
  expect(cold).toBeLessThanOrEqual(17315.35);
  expect(revisit).toBeLessThanOrEqual(5000);
  expect(result.returnDownloads).toBe(0);
  expect(result.returned.visibleBuildings).toBe(first.visibleBuildings);
  expect(await page.evaluate(() => window.mobility.errors)).toEqual([]);
});

test('native refinement keeps architectural parents visible and export waits for requested detail', async ({ page }) => {
  await open(page);
  await move(page, 2000);
  await capture(page);
  let release!: () => void, blocked!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { blocked = resolve; });
  await page.route('**/architecture-city/**/*-near.glb', async route => {
    blocked();
    await gate;
    await route.continue();
  });
  try {
    await move(page);
    await page.evaluate(() => {
      Reflect.set(window, 'architectureCapture', 'pending');
      void window.mobility.scene.screenshot().then(
        () => Reflect.set(window, 'architectureCapture', 'png'),
        error => Reflect.set(window, 'architectureCapture', String(error)),
      );
    });
    await requested;
    const pending = await state(page);
    expect(pending.loading).toBe(true);
    expect(pending.visibleBuildings).toBeGreaterThan(0);
    expect(pending.far + pending.mid).toBeGreaterThan(0);
    expect(await page.evaluate(() => Reflect.get(window, 'architectureCapture'))).toBe('pending');
  } finally { release(); }
  await page.waitForFunction(() => Reflect.get(window, 'architectureCapture') === 'png');
  expect(await state(page)).toMatchObject({ loading: false });
  expect((await state(page)).near).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.mobility.errors)).toEqual([]);
});

for (const failure of ['manifest', 'content'] as const) {
  test(`${failure} failure is explicit without box fallback and only explicit retry reloads`, async ({ page }) => {
    const pattern = failure === 'manifest' ? '**/architecture-city/manifest.json' : '**/architecture-city/**/*.glb';
    await page.route(pattern, route => route.fulfill({ status: 503, body: 'Unavailable' }));
    await open(page);
    await move(page);
    await page.waitForFunction(() => Boolean(window.mobility.architecture.error));
    expect(await page.evaluate(() => window.mobility.scene.screenshot().then(
      () => 'unexpected png', (error: Error) => error.message,
    ))).toContain('503');
    expect(await page.evaluate(() => window.mobility.errors.join('\n'))).toContain('全城建筑加载失败');
    await page.unroute(pattern);
    expect((await state(page)).failure).toContain('503');
    await page.evaluate(() => window.mobility.scene.retry());
    expect(await capture(page)).toBeGreaterThan(0);
    expect(await state(page)).toMatchObject({ tilesets: 1, loading: false });
    expect((await state(page)).failure).toBeUndefined();
    expect((await state(page)).near).toBeGreaterThan(0);
  });
}

for (const priorFailure of [false, true]) {
  test(`native render failure ${priorFailure ? 'after content failure ' : ''}rejects export and explicit retry restores the render loop`, async ({ page }) => {
    await open(page);
    await move(page);
    await capture(page);
    const failed = await page.evaluate(async priorFailure => {
      const { scene, architecture } = window.mobility;
      const native = Reflect.get(architecture, 'tileset') as Cesium3DTileset;
      if (priorFailure) native.tileFailed.raiseEvent({ url: 'tile.glb', message: 'HTTP 503' });
      const error = new Error('injected native architecture render failure');
      Reflect.set(native, 'update', () => { throw error; });
      const observed = new Promise<void>(resolve => {
        const remove = scene.viewer.scene.renderError.addEventListener(() => { remove(); resolve(); });
      });
      scene.viewer.scene.requestRender();
      await observed;
      return {
        stopped: !scene.viewer.useDefaultRenderLoop, attributed: architecture.error === error,
        original: await scene.screenshot().then(() => false, cause => cause === error),
      };
    }, priorFailure);
    expect(failed).toEqual({ stopped: true, attributed: true, original: true });
    await page.evaluate(() => window.mobility.scene.retry());
    expect(await capture(page)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.mobility.scene.viewer.useDefaultRenderLoop)).toBe(true);
    expect((await state(page)).failure).toBeUndefined();
  });
}

test('destroying during native refinement cancels export and late content cannot republish', async ({ page }) => {
  await open(page);
  let release!: () => void, blocked!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { blocked = resolve; });
  await page.route('**/architecture-city/**/*-near.glb', async route => {
    blocked();
    await gate;
    await route.continue();
  });
  try {
    await move(page);
    await page.evaluate(() => {
      Reflect.set(window, 'closingCapture', window.mobility.scene.screenshot().then(
        () => 'unexpected png', (error: Error) => error.message,
      ));
    });
    await requested;
    const result = await page.evaluate(async () => {
      const { scene, architecture } = window.mobility;
      scene.destroy();
      return { resources: architecture.resources(), capture: await Reflect.get(window, 'closingCapture') };
    });
    expect(result.capture).toContain('场景已关闭');
    expect(result.resources).toMatchObject({ tilesets: 0, cachedTiles: 0, bytes: 0, disposed: true });
  } finally { release(); }
});

for (const [style, lng, lat, coordinates] of [
  ['historic', 120.64196, 31.31118, /120\.641[0-9].*31\.309[0-9]/],
  ['residential', 120.65027, 31.30999, /120\.649[0-9].*31\.308[0-9]/],
  ['office', 120.61117, 31.26943, /120\.610[0-9].*31\.268[0-9]/],
  ['industrial', 120.65628, 31.33305, /120\.655[0-9].*31\.331[0-9]/],
] as const) {
  test(`main page exports actual ${style} district close views in daylight and at night`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
    await expect(page.getByRole('button', { name: '古城精细街区', exact: true })).toHaveCount(0);
    await page.addScriptTag({ type: 'module', url: '/tests/fixtures/landmark-review.ts' });
    await page.waitForFunction(() => Boolean(window.landmarkReview));
    expect(await page.evaluate(({ lng, lat }) => window.landmarkReview.location(lng, lat, 190), { lng, lat })).toBeGreaterThan(0);
    await expect(page.locator('.coordinates')).toHaveText(coordinates);
    await expect(page.locator('#glow')).toHaveValue('0.8');
    await mkdir('artifacts/unified-city', { recursive: true });
    const pictures: Buffer[] = [];
    for (const [label, mode] of [['日景', 'day'], ['夜景', 'night']] as const) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出截图', exact: true }).click();
      const download = await pending, path = `artifacts/unified-city/${style}-${mode}.png`;
      await download.saveAs(path);
      const image = readFileSync(path);
      expect(image.byteLength).toBeGreaterThan(20_000);
      pictures.push(image);
      await info.attach(`${style}-${mode}`, { path, contentType: 'image/png' });
    }
    expect(pictures[0].equals(pictures[1])).toBe(false);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
