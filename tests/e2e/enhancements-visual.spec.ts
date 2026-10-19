import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import baseline from '../fixtures/mobility-baseline.json' with { type: 'json' };
import currentManifest from '../../public/data/manifest.json' with { type: 'json' };

test.use({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
test.setTimeout(180_000);

test('production scene loads native architectural bodies and bounded street models without duplicate building detail', async ({page}) => {
  await open(page);
  await page.evaluate(()=>window.mobility.baseline('district',false));
  const state=await page.evaluate(()=>{
    const scene=window.mobility.scene as any,detail=scene.detail;
    return {models:detail.resourceCounts().models,
      duplicateTiles:detail.tiles.size, architecture:window.mobility.architecture.resources(),
      actors:[...detail.districtModels.values()].map((m:any)=>m.id.asset)};
  });
  expect(state.models).toBeGreaterThan(0);
  expect(state.models).toBeLessThanOrEqual(64);
  expect(state.duplicateTiles).toBe(0);
  expect(state.architecture).toMatchObject({tilesets:1,loading:false});
  expect(state.architecture.visibleBuildings).toBeGreaterThan(0);
  expect(state.architecture.mid+state.architecture.near).toBeGreaterThan(0);
  expect(state.actors.every((kind:string)=>['tree','lamp','entrance','roof-unit'].includes(kind))).toBe(true);
  expect(await page.evaluate(()=>window.mobility.errors)).toEqual([]);
});

test('optional district failure preserves base browsing and retries the manifest',async({page})=>{
  await page.route('**/enhancements/manifest.json',route=>route.fulfill({status:503,body:'Unavailable'}));
  await open(page);
  await page.evaluate(()=>window.mobility.baseline('district',false));
  const failed=await page.evaluate(()=>{
    const scene=window.mobility.scene as any;
    return {models:scene.detail.resourceCounts().models,
      buildings:window.mobility.architecture.resources().visibleBuildings,errors:window.mobility.errors};
  });
  expect(failed.models).toBe(0);
  expect(failed.buildings).toBeGreaterThan(0);
  expect(failed.errors.join('\n')).toContain('金鸡湖街景加载失败');
  await page.unroute('**/enhancements/manifest.json');
  await page.evaluate(()=>window.mobility.scene.retry());
  await page.waitForFunction(()=>{
    const scene=window.mobility.scene as any;
    return scene.detail.resourceCounts().models>0 && scene.detail.ready;
  });
  await page.evaluate(()=>window.mobility.scene.screenshot());
});

test('optional district asset corruption preserves the base city and can be retried',async({page})=>{
  await page.route('**/enhancements/*/tree.glb',route=>route.fulfill({status:200,body:'corrupt GLB'}));
  await open(page);
  await page.evaluate(()=>window.mobility.baseline('district',false));
  const state=await page.evaluate(()=>{
    const scene=window.mobility.scene as any;
    return {models:scene.detail.resourceCounts().models,ready:scene.detail.ready,
      buildings:window.mobility.architecture.resources().visibleBuildings,errors:window.mobility.errors};
  });
  expect(state.models).toBe(0);
  expect(state.ready).toBe(true);
  expect(state.buildings).toBeGreaterThan(0);
  expect(state.errors.join('\n')).toContain('hash/bytes mismatch');
  await page.unroute('**/enhancements/*/tree.glb');
  await page.evaluate(()=>window.mobility.scene.retry());
  await page.evaluate(()=>window.mobility.scene.screenshot());
  expect(await page.evaluate(()=>(window.mobility.scene as any).detail.resourceCounts().models)).toBeGreaterThan(0);
});

test('main page retains close lakeside detail without a separate roaming destination',async({page},info)=>{
  await page.goto('/');
  await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
  await page.addScriptTag({type:'module',url:'/tests/fixtures/landmark-review.ts'});
  await page.waitForFunction(()=>Boolean(window.landmarkReview));
  expect(await page.evaluate(()=>window.landmarkReview.location(120.6758,31.3151,420))).toBeGreaterThan(0);
  await expect(page.getByTestId('loaded-buildings')).not.toHaveText('0');
  await expect(page.locator('.coordinates')).toHaveText(/120\.6750.*31\.3124/);
  const coordinates=await page.locator('.coordinates').textContent();
  for (const [label,mode] of [['日景','day'],['夜景','night']]) {
    await page.getByRole('button',{name:label,exact:true}).click();
    const pending=page.waitForEvent('download');
    await page.getByRole('button',{name:'导出截图',exact:true}).click();
    const download=await pending,path=info.outputPath(`lakeside-close-${mode}.png`);
    await download.saveAs(path);
    await info.attach(`lakeside-close-${mode}`,{path,contentType:'image/png'});
    await page.screenshot({path:info.outputPath(`lakeside-ui-${mode}.png`)});
    expect(await page.locator('.coordinates').textContent()).toBe(coordinates);
  }
  await page.getByRole('button',{name:'数据与来源',exact:true}).click();
  await expect(page.getByText('立面、屋顶设备和街景构件为推断装饰，并非实测实景。')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('district lifecycle validates packages, gates groups, cancels stale loads and preserves base details',async({page})=>{
  await open(page);
  await page.evaluate(()=>window.mobility.baseline('district',false));
  const result=await page.evaluate(async()=>{
    const scene=window.mobility.scene as any, detail=scene.detail;
    const manifest=await (await fetch('/enhancements/manifest.json')).json();
    detail.unloadDistrict();
    const before=detail.resourceCounts();
    await detail.loadDistrict(manifest);await detail.waitUntilReady();
    const loaded=detail.resourceCounts();
    scene.updateSettings({...scene.settings,buildings:false,roads:false,green:false});
    await detail.waitUntilReady();
    const hidden=detail.resourceCounts();
    scene.updateSettings({...scene.settings,buildings:true,roads:true,green:true});
    await detail.waitUntilReady();
    const restored=detail.resourceCounts();
    detail.unloadDistrict();
    const after=detail.resourceCounts();
    const native=window.fetch;
    let release!:(r:Response)=>void;
    const pendingResponse=await native(`/enhancements/${manifest.placements}`);
    window.fetch=((input:any,init:any)=>String(input).endsWith(manifest.placements)
      ? new Promise<Response>(resolve=>{release=resolve;}) : native(input,init)) as typeof fetch;
    try {
      const pending=detail.loadDistrict(manifest);
      await new Promise(r=>setTimeout(r,50));
      detail.unloadDistrict();release(pendingResponse);
      await pending;
    } finally {window.fetch=native;}
    return {before,loaded,hidden,restored,after,late:detail.resourceCounts()};
  });
  expect(result.loaded.models).toBeGreaterThan(0);
  expect(result.hidden.models).toBe(0);
  expect(result.restored.models).toBe(result.loaded.models);
  expect(result.after).toEqual(result.before);
  expect(result.late).toEqual(result.before);
  expect(await page.evaluate(()=>window.mobility.errors)).toEqual([]);
});

test('final nine assets render in Cesium with cardinal orientation and both Walk clips', async ({page},info) => {
  await open(page);
  await page.evaluate(()=>window.mobility.assetViews());
  const measurements=[];
  for (const kind of ['car-a','car-b','bus','person-a','person-b','tree','lamp','entrance','roof-unit'] as const) {
    for (const heading of [0,Math.PI/2,Math.PI,Math.PI*1.5]) {
      await page.evaluate(({kind,heading})=>window.mobility.view(kind,heading),{kind,heading});
      const result=await page.evaluate(kind=>window.mobility.measure(kind),kind);
      expect(result.ready).toBe(true);
      [Math.sin(heading),Math.cos(heading),0].forEach((n,i)=>expect(result.direction[i]).toBeCloseTo(n,5));
      expect(result.bounds.size.every(n=>n>0)).toBe(true);
      expect(Math.abs(result.bounds.min[2])).toBeLessThan(0.005);
      const dimensions = ({ 'car-a':[4.4,1.8,1.45], 'car-b':[4.7,1.9,1.7], bus:[10,2.5,3.1] } as Record<string,number[]>)[kind];
      if (dimensions) {
        const [length,width,height]=dimensions;
        const expected=heading===Math.PI/2 || heading===Math.PI*1.5 ? [length,width,height]:[width,length,height];
        expected.forEach((n,i)=>expect(result.bounds.size[i]).toBeCloseTo(n,3));
      }
      if(kind.startsWith('person-')) expect(result.bounds.size[2]).toBeGreaterThanOrEqual(1.65);
      const required:Partial<Record<typeof kind,string[]>>={
        tree:['branch-','leaf-cluster-'],
        lamp:['anchor-bolt-','tapered-pole','led-module-'],
        entrance:['door-handle-','transom','threshold'],
        'roof-unit':['fan-blade-','fan-guard-','service-panel','isolator-'],
      };
      for (const prefix of required[kind] ?? []) {
        expect(Object.keys(result.nodes).some(name=>name.startsWith(prefix)),`${kind}: authored ${prefix}`).toBe(true);
      }
      measurements.push({kind,heading,...result});
    }
    await capture(page,info,`${kind}-final`);
    if(kind.startsWith('person-')) {
      await page.evaluate(()=>window.mobility.phase(0));
      const neutral=await page.evaluate(kind=>window.mobility.measure(kind),kind);
      await page.evaluate(()=>window.mobility.phase(0.25));
      const walking=await page.evaluate(kind=>window.mobility.measure(kind),kind);
      expect(walking.animations).toEqual(['Walk']);
      expect(walking.animationDurations).toEqual([1]);
      expect(walking.limbMatrices).not.toEqual(neutral.limbMatrices);
      expect(Math.abs(walking.bounds.min[2])).toBeLessThan(0.005);
      const walkingPixels=await capture(page,info,`${kind}-walk-final`);
      await page.evaluate(()=>window.mobility.phase(0));
      const stopped=await page.evaluate(kind=>window.mobility.measure(kind),kind);
      stopped.limbMatrices.forEach((matrix,i)=>matrix.forEach((value,j)=>
        expect(value).toBeCloseTo(neutral.limbMatrices[i][j],5)));
      const stoppedPixels=await capture(page,info,`${kind}-stopped-final`);
      expect(stoppedPixels!.hash).not.toBe(walkingPixels!.hash);
      const clock=await page.evaluate(()=>window.mobility.clock());
      await page.waitForTimeout(100);
      expect(await page.evaluate(kind=>window.mobility.measure(kind).limbMatrices,kind)).toEqual(stopped.limbMatrices);
      expect(await capture(page,info,`${kind}-stopped-stable`)).toEqual(stoppedPixels);
      expect(await page.evaluate(()=>window.mobility.clock())).toBe(clock);
    }
  }
  await writeFile(info.outputPath('nine-assets.json'),JSON.stringify(measurements,null,2));
  expect(await page.evaluate(()=>window.mobility.errors)).toEqual([]);
});

async function open(page: Page) {
  await page.goto('/tests/fixtures/mobility.html');
  await page.waitForFunction(() => Boolean(window.mobility));
  await page.evaluate(() => window.mobility.ready);
}

async function capture(page: Page, info: TestInfo, name: string) {
  const { bytes, pixels } = await page.evaluate(async (label) => {
    const blob = await window.mobility.capture(label);
    let pixels: { count: number; hash: string; headlamps: number; taillamps: number } | undefined;
    if (label.startsWith('car-a') || label.startsWith('person-')) {
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
          : label.startsWith('person-b')
            ? g > 60 && g > r * 1.5 && g > b * 1.05
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

test('static geometry has metre roads, native architectural bodies and bounded nonduplicated ownership', async ({ page }, info) => {
  test.setTimeout(420_000);
  await open(page);
  await page.evaluate(() => window.mobility.baseline('district', false));
  const inspect = () => page.evaluate(() => {
    const scene = window.mobility.scene as any;
    const detail = scene.detail;
    if (!detail) throw new Error('Missing DetailLayer');
    const roads = [...detail.roadRegions.values()] as any[];
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
      architecture:window.mobility.architecture.resources(), loadedIds:[...detail.loadedIds],
      detailedBuildings:([...detail.tiles.values()] as any[]).reduce((n,t)=>n+t.active.size,0),
      farShown:roads.filter(r=>r.overviewVisible).length,
    };
  });
  const state = await inspect();
  expect(state.ready).toBe(true);
  expect(state.near.length).toBeGreaterThan(0);
  expect(state.near.every(r=>r.overview===false && r.vertices>0 && r.widths.every((w:number)=>w>=0.5))).toBe(true);
  expect(new Set(state.near.flatMap(r=>r.ids)).size).toBe(state.near.flatMap(r=>r.ids).length);
  expect(state.accessories).toHaveLength(0);
  expect(state.detailedBuildings).toBe(0);
  expect(state.architecture).toMatchObject({tilesets:1,loading:false});
  expect(state.architecture.visibleBuildings).toBeGreaterThan(0);
  expect(state.architecture.bytes).toBeLessThanOrEqual(state.architecture.cacheBytes+state.architecture.maximumCacheOverflowBytes);
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
  expect(hidden.architecture.visibleBuildings).toBe(0);
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
    expect(budgeted.architecture.visibleBuildings).toBeGreaterThan(0);
    expect(budgeted.architecture.bytes).toBeLessThanOrEqual(budgeted.architecture.cacheBytes+budgeted.architecture.maximumCacheOverflowBytes);
    expect(budgeted.near.length).toBeGreaterThan(0);
    expect(budgeted.near.length).toBeLessThanOrEqual(limit);
    expect(budgeted.detailedBuildings).toBe(0);
    expect(budgeted.resources.models).toBeLessThanOrEqual({low:32,medium:64,high:128}[quality]);
  }
  expect(await page.evaluate(()=>window.mobility.errors)).toEqual([]);
  const final=await page.evaluate(()=>{
    const scene=window.mobility.scene as any, detail=scene.detail;
    scene.destroy();
    return detail.resourceCounts();
  });
  expect(final).toEqual({primitives:0,models:0,cacheEntries:0});
});

test('a late architecture manifest cannot publish resources after disposal', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const {scene,architecture}=window.mobility;
    await scene.screenshot();
    const nativeFetch = window.fetch;
    const response = await nativeFetch('/architecture-city/manifest.json');
    const manifest = await response.clone().json();
    let release!: (response: Response) => void;
    window.fetch = (input,init) => String(input)==='/architecture-city/manifest.json'
      ? new Promise<Response>(resolve => { release = resolve; }) : nativeFetch(input,init);
    try {
      const pending = architecture.load(manifest.sourceDataset,manifest.buildings);
      architecture.destroy();
      release(response);
      await pending;
      return architecture.resources();
    } finally { window.fetch = nativeFetch; }
  });
  expect(result).toMatchObject({tilesets:0,cachedTiles:0,visibleBuildings:0,bytes:0,disposed:true});
  expect(result.failure).toBeUndefined();
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

test('close day and night inspect native roofs and tessellated metre road width', async ({ page }, info) => {
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
    scene.viewer.camera.lookAt(midpoint, new HeadingPitchRange(0.6, -0.5, 260));
    scene.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    await scene.screenshot();
    return { roadId: road.id, width: road.width, measuredWidth: Math.max(...cross) - Math.min(...cross),
      vertices: positions.length / 3, architecture:window.mobility.architecture.resources() };
  });
  expect(evidence.vertices).toBeGreaterThanOrEqual(4);
  expect(evidence.measuredWidth).toBeCloseTo(evidence.width, 1);
  expect(evidence.architecture).toMatchObject({tilesets:1,loading:false});
  expect(evidence.architecture.near).toBeGreaterThan(0);
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

test('published assets have metre dimensions, ground contact, visible cardinal headings and Walk independent of city clock', async ({ page }, info) => {
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
  await page.route('**/enhancements/*/car-a.glb', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await open(page);
  const error = await page.evaluate(async () => {
    try { await window.mobility.assetViews(); return null; } catch (e) { return String(e); }
  });

  expect(error).toContain('HTTP 404');
  expect(await page.evaluate(() => window.mobility.errors)).not.toEqual([]);
});

test('failure of an asset removes the partially loaded package', async ({ page }) => {
  await page.route('**/enhancements/*/person-a.glb', (route) => route.fulfill({ status: 404, body: 'not found' }));
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
  await page.route('**/enhancements/*/car-a.glb', () => {});
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
