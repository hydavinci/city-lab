import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import baseline from '../fixtures/mobility-baseline.json' with { type: 'json' };
import currentManifest from '../../public/data/manifest.json' with { type: 'json' };

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

test('after static detail at original city and district cameras, day and night; actors still absent', async ({ page }, info) => {
  await open(page);
  const metadata = [];
  for (const view of ['city', 'district'] as const) {
    for (const night of [false, true]) {
      const result = await page.evaluate(({ view, night }) => window.mobility.baseline(view, night), { view, night });
      expect(result).toMatchObject({
        baseDataset: currentManifest.dataset, camera: baseline[view],
        origin: baseline.candidate.origin, routeWidths: baseline.candidate.routeWidths,
        quality: baseline.quality, viewport: baseline.viewport, dpr: baseline.dpr,
        beforeActors: baseline.beforeActors, night,
      });
      const actual = (result as { actualCamera: typeof baseline.actualCamera.city }).actualCamera;
      for (const axis of ['position', 'direction', 'up'] as const) {
        actual[axis].forEach((value, i) => expect(value).toBeCloseTo(baseline.actualCamera[view][axis][i], 5));
      }
      metadata.push(result);
      await capture(page, info, `after-${view}-${night ? 'night' : 'day'}`);
    }
  }
  const path = info.outputPath('after-metadata.json');
  await writeFile(path, JSON.stringify(metadata, null, 2));
  await info.attach('after-metadata', { path, contentType: 'application/json' });
  expect(await page.evaluate(() => window.mobility.errors)).toEqual([]);
});

test('static geometry has metre roads, four profile batches, safe accessories and bounded ownership', async ({ page }, info) => {
  await open(page);
  await page.evaluate(() => window.mobility.baseline('district', false));
  const inspect = () => page.evaluate(() => {
    const scene = window.mobility.scene as any;
    const detail = scene.detail;
    if (!detail) throw new Error('Missing DetailLayer');
    const roads = [...detail.roadRegions.values()] as any[];
    const tiles = [...scene.tiles.values()] as any[];
    const near = roads.filter(r=>r.near?.ready);
    const accessories = [...detail.tiles.values()].filter((t:any)=>t.primitive?.ready) as any[];
    return {
      resources: detail.resourceCounts(), ready: detail.ready,
      near: near.map(r=>({id:r.id, overview:r.overviewVisible, ids:r.near.geometryInstances.map((i:any)=>i.id.segmentId),
        widths:r.near.geometryInstances.map((i:any)=>i.geometry._width),
        vertices:r.near._va.reduce((n:number,v:any)=>n+v.numberOfVertices,0)})),
      accessories: accessories.map(t=>({count:t.primitive.geometryInstances.length,
        vertices:t.primitive._va.reduce((n:number,v:any)=>n+v.numberOfVertices,0),
        heights:t.primitive.geometryInstances.map((i:any)=>[i.geometry._height,i.geometry._extrudedHeight]),
        provenance:t.diagnostics})),
      profileBatches: tiles.flatMap(t=>t.primitives.map((p:any)=>({ready:p.ready,profile:p.appearance.material.uniforms.profile,
        ids:p._instanceIds.map((id:any)=>({id:id.id,height:id.height,basis:id.basis}))}))),
      tileCount:tiles.length, loadedIds:[...detail.loadedIds],
      farShown:roads.filter(r=>r.overviewVisible).length,
    };
  });
  const state = await inspect();
  expect(state.ready).toBe(true);
  expect(state.near.length).toBeGreaterThan(0);
  expect(state.near.every(r=>r.overview===false && r.vertices>0 && r.widths.every((w:number)=>w>=0.5))).toBe(true);
  expect(new Set(state.near.flatMap(r=>r.ids)).size).toBe(state.near.flatMap(r=>r.ids).length);
  expect(state.accessories.some(a=>a.count>0 && a.vertices>0)).toBe(true);
  expect(state.accessories.every(a=>a.heights.every((h:number[])=>h[0]>h[1] && h[1]>0))).toBe(true);
  expect(state.profileBatches.every(p=>p.ready && p.ids.every((id:any)=>id.id && id.height>0 && id.basis))).toBe(true);
  expect(new Set(state.profileBatches.map(p=>p.profile)).size).toBe(4);
  expect(state.tileCount).toBeLessThanOrEqual(8);
  expect(state.farShown).toBeGreaterThan(0);
  const path=info.outputPath('actual-static-geometry.json');
  await writeFile(path,JSON.stringify(state,null,2));
  await info.attach('actual-static-geometry',{path,contentType:'application/json'});
  await page.evaluate(async()=>{
    const url='/web/core/settings.ts', {defaultSettings}=await import(url);
    window.mobility.scene.updateSettings({...defaultSettings,buildings:false});
    await window.mobility.scene.screenshot();
  });
  const hidden=await inspect();
  expect(hidden.tileCount).toBe(0);
  expect(hidden.near.length).toBeGreaterThan(0);
  expect(hidden.accessories).toHaveLength(0);
  for (let i=0;i<10;i++) {
    await page.evaluate(async()=>{
      window.mobility.scene.home(0);
      await window.mobility.scene.screenshot();
    });
    const far=await inspect();
    expect(far.loadedIds).toHaveLength(0);
    expect(far.resources.cacheEntries).toBe(0);
    await page.evaluate(()=>window.mobility.baseline('district',false));
    expect((await inspect()).resources).toEqual(state.resources);
  }
  for (const [quality, limit] of [['low', 4], ['high', 14], ['medium', 8]] as const) {
    await page.evaluate(async quality => {
      const scene = window.mobility.scene as any;
      scene.updateSettings({ ...scene.settings, quality });
      await scene.screenshot();
    }, quality);
    const budgeted = await inspect();
    expect(budgeted.tileCount).toBeGreaterThan(0);
    expect(budgeted.tileCount).toBeLessThanOrEqual(limit);
    expect(budgeted.near.length).toBeGreaterThan(0);
    expect(budgeted.near.length).toBeLessThanOrEqual(limit);
  }
  expect(await page.evaluate(()=>window.mobility.errors)).toEqual([]);
  const final=await page.evaluate(()=>{
    const scene=window.mobility.scene as any, detail=scene.detail;
    scene.destroy();
    return detail.resourceCounts();
  });
  expect(final).toEqual({primitives:0,models:0,cacheEntries:0});
});

test('late aborted tile cannot register profile or accessory resources', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const scene = window.mobility.scene as any;
    await scene.screenshot();
    const id = scene.manifest.tiles[0].id;
    const nativeFetch = window.fetch;
    const response = await nativeFetch(`/data/${scene.manifest.dataset}/tiles/${id}.json`);
    let release!: (response: Response) => void;
    window.fetch = (() => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch;
    const before = scene.detail.resourceCounts();
    try {
      scene.wanted.add(id);
      const pending = scene.loadTile(id);
      const controller = scene.pending.get(id);
      controller.abort();
      scene.wanted.delete(id);
      release(response);
      await pending;
      return { before, after: scene.detail.resourceCounts(), tiles: scene.tiles.size, pending: scene.pending.size };
    } finally { window.fetch = nativeFetch; }
  });
  expect(result.after).toEqual(result.before);
  expect(result.tiles).toBe(0);
  expect(result.pending).toBe(0);
  expect(await page.evaluate(() => window.mobility.errors)).toEqual([]);
});

test('geometry failure restores real overview attributes, rejects capture promptly, and retries', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.mobility.baseline('district', false));
  const result = await page.evaluate(async () => {
    const scene = window.mobility.scene as any, detail = scene.detail;
    const region = [...detail.roadRegions.values()].find((r: any) => r.near) as any;
    const ids = region.roads.filter((r: any) => r.eligible).map((r: any) => r.id);
    const show = () => ids.map((id: string) => detail.overview.getGeometryInstanceAttributes(id).show[0]);
    const replaced = show();
    detail.unloadRoad(region);
    detail.syncOverview();
    const unloaded = show();
    const load = detail.loadRoad;
    detail.loadRoad = () => { throw new Error('injected corridor geometry failure'); };
    detail.update(scene.settings);
    detail.loadRoad = load;
    const restored = show();
    const waitError = await detail.waitUntilReady().then(() => '', (e: Error) => e.message);
    const captureError = await Promise.race([
      scene.screenshot().then(() => '', (e: Error) => e.message),
      new Promise<string>(resolve => setTimeout(() => resolve('capture did not reject promptly'), 1500)),
    ]);
    const failedCounts = detail.resourceCounts();
    detail.retry();
    await detail.waitUntilReady();
    return { replaced, unloaded, restored, waitError, captureError, failedCounts, retried: detail.ready, afterRetry: show() };
  });
  expect(result.replaced.every((value: number) => value === 0)).toBe(true);
  expect(result.unloaded.every((value: number) => value === 1)).toBe(true);
  expect(result.restored.every((value: number) => value === 1)).toBe(true);
  expect(result.waitError).toContain('injected corridor geometry failure');
  expect(result.captureError).toContain('injected corridor geometry failure');
  expect(result.failedCounts.primitives).toBe(1);
  expect(result.retried).toBe(true);
  expect(result.afterRetry.every((value: number) => value === 0)).toBe(true);
  expect(await page.evaluate(() => window.mobility.errors.join('\n'))).toContain('injected corridor geometry failure');
});

test('close day and night inspect roof volumes and tessellated metre width', async ({ page }, info) => {
  await open(page);
  await page.evaluate(() => window.mobility.baseline('district', false));
  const evidence = await page.evaluate(async () => {
    const { Cartesian3, Matrix4, Transforms, CorridorGeometry, HeadingPitchRange } = window.mobility.geometry;
    const scene = window.mobility.scene as any, detail = scene.detail;
    const regions = [...detail.roadRegions.values()] as any[];
    const region = regions.find(r => r.near?.ready && r.roads.some((road: any) => road.eligible && road.line.length === 2));
    const road = region.roads.find((r: any) => r.eligible && r.line.length === 2);
    const instance = region.near.geometryInstances.find((i: any) => i.id.segmentId === road.id);
    const generated = CorridorGeometry.createGeometry(instance.geometry);
    const a = Cartesian3.fromDegrees(road.line[0][0], road.line[0][1]);
    const b = Cartesian3.fromDegrees(road.line[1][0], road.line[1][1]);
    const midpoint = Cartesian3.midpoint(a, b, new Cartesian3());
    const inverse = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(midpoint), new Matrix4());
    const start = Matrix4.multiplyByPoint(inverse, a, new Cartesian3());
    const end = Matrix4.multiplyByPoint(inverse, b, new Cartesian3());
    const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy);
    if (!generated?.attributes.position) throw new Error('No tessellated corridor positions');
    const positions = generated.attributes.position.values, cross = [];
    for (let i = 0; i < positions.length; i += 3) {
      const p = Matrix4.multiplyByPoint(inverse, new Cartesian3(positions[i], positions[i+1], positions[i+2]), new Cartesian3());
      cross.push((p.x * -dy + p.y * dx) / length);
    }
    const tile = ([...detail.tiles.values()] as any[]).find(t => t.primitive?.ready);
    const roof = tile.primitive.geometryInstances.find((i: any) => i.id.detail === 'roof-access')
      ?? tile.primitive.geometryInstances[0];
    const footprint = roof.geometry._polygonHierarchy.positions;
    const centre = footprint.reduce((sum: any, p: any) => Cartesian3.add(sum, p, sum), new Cartesian3());
    Cartesian3.divideByScalar(centre, footprint.length, centre);
    scene.viewer.camera.lookAt(centre, new HeadingPitchRange(0.6, -0.5, 260));
    scene.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    await scene.screenshot();
    return { roadId: road.id, width: road.width, measuredWidth: Math.max(...cross) - Math.min(...cross),
      vertices: positions.length / 3, accessory: roof.id,
      baseHeight: roof.geometry._extrudedHeight, topHeight: roof.geometry._height };
  });
  expect(evidence.vertices).toBeGreaterThanOrEqual(4);
  expect(evidence.measuredWidth).toBeCloseTo(evidence.width, 1);
  expect(evidence.topHeight).toBeGreaterThan(evidence.baseHeight);
  await capture(page, info, 'after-detail-close-day');
  await page.evaluate(() => {
    const scene = window.mobility.scene as any;
    scene.updateSettings({ ...scene.settings, night: true });
  });
  await capture(page, info, 'after-detail-close-night');
  const path = info.outputPath('tessellated-geometry.json');
  await writeFile(path, JSON.stringify(evidence, null, 2));
  await info.attach('tessellated-geometry', { path, contentType: 'application/json' });
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
