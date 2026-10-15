import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

async function open(page: Page) {
  await page.goto('/tests/fixtures/mobility.html');
  await page.waitForFunction(() => Boolean(window.mobility));
  await page.evaluate(() => window.mobility.baseline('district', false));
}

test('Retry recovers an actual detail primitive render error and exports again', async ({ page }) => {
  await open(page);
  const failed = await page.evaluate(async () => {
    const scene = window.mobility.scene as any, detail = scene.detail;
    const region = [...detail.roadRegions.values()].find((r: any) => r.near?.ready) as any;
    const primitive = region.near;
    const owned = [...detail.roadRegions.values()].map((r: any) => r.near)
      .concat([...detail.tiles.values()].map((t: any) => t.primitive)).filter(Boolean);
    const ids = region.roads.filter((r: any) => r.eligible).map((r: any) => r.id);
    const error = new Error('injected detail update failure');
    primitive.update = () => { throw error; };
    const observed = new Promise<boolean>(resolve => {
      const remove = scene.viewer.scene.renderError.addEventListener((_scene: unknown, cause: Error) => {
        remove();
        resolve(cause === error);
      });
    });
    scene.viewer.scene.requestRender();
    const originalRenderError = await observed;
    const originalCaptureError = await scene.screenshot().then(() => false, (cause: Error) => cause === error);
    return {
      originalRenderError, originalCaptureError,
      stopped: !scene.viewer.useDefaultRenderLoop,
      disposed: owned.every((p: any) => p.isDestroyed()),
      restored: ids.every((id: string) => detail.overview.getGeometryInstanceAttributes(id).show[0] === 1),
      primitives: detail.resourceCounts().primitives,
    };
  });
  expect(failed).toEqual({
    originalRenderError: true, originalCaptureError: true,
    stopped: true, disposed: true, restored: true, primitives: 1,
  });
  const retried = await page.evaluate(async () => {
    const scene = window.mobility.scene as any;
    scene.retry();
    const capture = await Promise.race([
      scene.screenshot().then((blob: Blob) => blob.size > 0 ? 'png' : 'empty', (error: Error) => error.message),
      new Promise<string>(resolve => setTimeout(() => resolve('retry capture stalled'), 10_000)),
    ]);
    const near = [...scene.detail.roadRegions.values()].filter((r: any) => r.near?.ready) as any[];
    return { capture, running: scene.viewer.useDefaultRenderLoop, ready: scene.detail.ready,
      replaced: near.length > 0 && near.every(r => !r.overviewVisible) };
  });
  expect(retried).toEqual({ capture: 'png', running: true, ready: true, replaced: true });
});

for (const detailFirst of [false, true]) {
  test(`Retry preserves an unrelated fatal render error (prior detail failure: ${detailFirst})`, async ({ page }) => {
    await open(page);
    const result = await page.evaluate(async detailFirst => {
      const scene = window.mobility.scene as any, detail = scene.detail;
      if (detailFirst) {
        const region = [...detail.roadRegions.values()].find((r: any) => r.near?.ready) as any;
        region.near.update = () => { throw new Error('prior detail update failure'); };
        const observed = new Promise<void>(resolve => {
          const remove = scene.viewer.scene.renderError.addEventListener(() => { remove(); resolve(); });
        });
        scene.viewer.scene.requestRender();
        await observed;
      }
      const error = new Error('unrelated water render failure');
      const water = scene.layers.water.get(0);
      water.update = () => { throw error; };
      // A real render, including when the prior error has stopped the automatic loop.
      scene.viewer.scene.requestRender();
      scene.viewer.render();
      const attributedToDetail = detail.failure === error;
      scene.retry();
      const capture = await Promise.race([
        scene.screenshot().then(() => 'unexpected png', (cause: Error) => cause === error ? 'original fatal' : cause.message),
        new Promise<string>(resolve => setTimeout(() => resolve('fatal capture stalled'), 1500)),
      ]);
      return { attributedToDetail, capture, stopped: !scene.viewer.useDefaultRenderLoop,
        fatalRetained: scene.renderFailure === error };
    }, detailFirst);
    expect(result).toEqual({
      attributedToDetail: false, capture: 'original fatal', stopped: true, fatalRetained: true,
    });
  });
}

test('accessory failure from a delayed tile rejects the active screenshot geometry wait promptly', async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const scene = window.mobility.scene as any;
    scene.updateSettings({ ...scene.settings, buildings: false });
    await scene.screenshot();
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/data/*/tiles/*.json', async route => {
    await gate;
    await route.continue();
  });
  await page.evaluate(() => {
    const scene = window.mobility.scene as any, detail = scene.detail;
    const error = new Error('injected delayed accessory construction failure');
    const load = detail.loadAccessories;
    detail.loadAccessories = () => { throw error; };
    const state = { waiting: false, outcome: 'pending' };
    (window as any).detailCapture = state;
    const wait = scene.waitForGeometry;
    scene.waitForGeometry = function (includeBuildings: boolean) {
      state.waiting = includeBuildings;
      return wait.call(this, includeBuildings);
    };
    scene.updateSettings({ ...scene.settings, buildings: true });
    void scene.screenshot().then(
      () => { state.outcome = 'unexpected png'; },
      (cause: Error) => { state.outcome = cause === error ? 'original detail error' : cause.message; },
    ).finally(() => {
      detail.loadAccessories = load;
      scene.waitForGeometry = wait;
    });
  });
  await page.waitForFunction(() => {
    const scene = window.mobility.scene as any;
    return (window as any).detailCapture.waiting && scene.pending.size > 0;
  });
  expect(await page.evaluate(() => (window as any).detailCapture.outcome)).toBe('pending');
  release();
  await page.waitForFunction(() => Boolean((window.mobility.scene as any).detail.failure));
  await expect.poll(() => page.evaluate(() => (window as any).detailCapture.outcome), { timeout: 2000 })
    .toBe('original detail error');
  expect(await page.evaluate(() => (window.mobility.scene as any).failed.size)).toBe(0);
  expect(await page.evaluate(() => window.mobility.errors.join('\n')))
    .toContain('injected delayed accessory construction failure');
  expect(await page.evaluate(async () => {
    window.mobility.scene.retry();
    return (await window.mobility.scene.screenshot()).size;
  })).toBeGreaterThan(0);
});
