import { expect, test, type Page } from '@playwright/test';
import type { Primitive } from 'cesium';
import type { DetailLayer } from '../../web/scene/DetailLayer';

test.use({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

async function open(page: Page) {
  await page.goto('/tests/fixtures/mobility.html');
  await page.waitForFunction(() => Boolean(window.mobility));
  await page.evaluate(() => window.mobility.baseline('district', false));
}

test('optional model processing errors do not stop rendering and can be retried', async ({ page }) => {
  await open(page);
  const failed = await page.evaluate(async () => {
    const scene = window.mobility.scene as any, detail = scene.detail;
    const models = [...detail.districtModels.values()] as any[], model = models[0];
    const observed = new Promise<void>(resolve => {
      const remove = model.errorEvent.addEventListener(() => { remove(); resolve(); });
    });
    model._resourcesLoaded = false;
    model._loader.process = () => { throw new Error('injected district loader processing failure'); };
    scene.viewer.scene.requestRender();
    await observed;
    const capture = await Promise.race([
      scene.screenshot().then((blob: Blob) => blob.size > 0 ? 'png' : 'empty', (error: Error) => error.message),
      new Promise<string>(resolve => setTimeout(() => resolve('base capture stalled'), 10_000)),
    ]);
    return {
      capture, running: scene.viewer.useDefaultRenderLoop, fatal: Boolean(scene.renderFailure || detail.error),
      disposed: models.every(model => model.isDestroyed()), remaining: detail.resourceCounts().models,
      reported: window.mobility.errors.some(error => error.includes('injected district loader processing failure')),
    };
  });
  expect(failed).toEqual({
    capture: 'png', running: true, fatal: false, disposed: true, remaining: 0, reported: true,
  });
  const retried = await page.evaluate(async () => {
    const scene = window.mobility.scene as any;
    scene.retry();
    const capture = await scene.screenshot();
    return { captured: capture.size > 0, models: scene.detail.resourceCounts().models, ready: scene.detail.ready };
  });
  expect(retried.captured).toBe(true);
  expect(retried.models).toBeGreaterThan(0);
  expect(retried.ready).toBe(true);
});

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

test('a detail render failure promptly rejects screenshot waiting for delayed native refinement', async ({ page }) => {
  await page.goto('/tests/fixtures/mobility.html');
  await page.waitForFunction(() => Boolean(window.mobility));
  await page.evaluate(() => window.mobility.ready);
  let release!: () => void, blocked!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { blocked = resolve; });
  await page.route('**/architecture-city/**/*-near.glb', async route => {
    blocked();
    await gate;
    await route.continue();
  });
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'detailCapture', { outcome: 'pending', error: new Error('injected delayed detail render failure') });
      const {scene,geometry:{Cartesian3,HeadingPitchRange,Matrix4}}=window.mobility;
      scene.viewer.camera.lookAt(Cartesian3.fromDegrees(120.6750,31.3124),new HeadingPitchRange(0.6,-0.5,190));
      scene.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
      scene.viewer.scene.requestRender();
      void scene.screenshot().then(
        () => { Reflect.get(window,'detailCapture').outcome='unexpected png'; },
        cause => {
          const state=Reflect.get(window,'detailCapture');
          state.outcome=cause===state.error ? 'original detail error' : String(cause);
        },
      );
    });
    await requested;
    await page.waitForFunction(() => {
      const detail=Reflect.get(window.mobility.scene,'detail') as DetailLayer;
      const regions=Reflect.get(detail,'roadRegions') as Map<string,{near?:Primitive}>;
      return [...regions.values()].some(region=>region.near?.ready);
    });
    expect(await page.evaluate(() => Reflect.get(window,'detailCapture').outcome)).toBe('pending');
    expect(await page.evaluate(() => window.mobility.architecture.ready)).toBe(false);
    await page.evaluate(() => {
      const {scene}=window.mobility, detail=Reflect.get(scene,'detail') as DetailLayer;
      const regions=Reflect.get(detail,'roadRegions') as Map<string,{near?:Primitive}>;
      const primitive=[...regions.values()].find(region=>region.near?.ready)?.near;
      if(!primitive) throw new Error('Missing ready detail corridor');
      const error=Reflect.get(window,'detailCapture').error;
      Reflect.set(primitive,'update',()=>{throw error;});
      scene.viewer.scene.requestRender();
    });
    await expect.poll(() => page.evaluate(() => Reflect.get(window,'detailCapture').outcome), { timeout: 2000 })
      .toBe('original detail error');
    expect(await page.evaluate(() => window.mobility.architecture.error)).toBeUndefined();
  } finally { release(); }
  expect(await page.evaluate(() => window.mobility.errors.join('\n')))
    .toContain('injected delayed detail render failure');
  expect(await page.evaluate(async () => {
    window.mobility.scene.retry();
    return (await window.mobility.scene.screenshot()).size;
  })).toBeGreaterThan(0);
});
