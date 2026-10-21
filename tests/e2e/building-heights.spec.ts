import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildingHeightRecords } from '../../web/core/building-height-references';
import { referenceHeightFor } from '../../web/core/building-heights';
import type { BuildingFeature, CityManifest } from '../../web/core/types';
import type {} from '../fixtures/landmark-review';

test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
test.setTimeout(180_000);

for (const record of buildingHeightRecords) {
  test(`${record.sourceId} renders a generic high-rise with separate verified and original heights`, async ({ page }) => {
    const errors: string[] = [], directory = `artifacts/highrise/${record.sourceId.replace('/', '-')}`;
    page.on('pageerror', error => errors.push(error.message));
    await mkdir(directory, { recursive: true });
    const manifest = JSON.parse(await readFile('public/data/manifest.json', 'utf8')) as CityManifest;
    const tile = manifest.tiles.find(tile => tile.bounds[0] <= record.bounds[0] && tile.bounds[1] <= record.bounds[1]
      && tile.bounds[2] >= record.bounds[2] && tile.bounds[3] >= record.bounds[3])!;
    const collection = JSON.parse(await readFile(`public/data/${manifest.dataset}/tiles/${tile.id}.json`, 'utf8')) as {
      features: BuildingFeature[];
    };
    const feature = collection.features.find(feature => feature.properties.id === record.sourceId)!;
    expect(feature).toBeDefined();
    await page.goto('/');
    await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
    await page.addScriptTag({ type: 'module', url: '/tests/fixtures/landmark-review.ts' });
    await page.waitForFunction(() => Boolean(window.landmarkReview));
    await page.getByRole('button', { name: '日景', exact: true }).click();
    await page.getByRole('button', { name: '收起控制面板', exact: true }).click();
    const captures: {
      name: string; range: number; heading: number;
      resources: ReturnType<Window['landmarkReview']['state']>; lods: string[];
    }[] = [];
    // Tower B occludes Tower A from the default southwest viewpoint.
    const heading = record.sourceId === 'way/475616603' ? 210 : 30;
    for (const [name, factor] of [['skyline', 6], ['near', 1.8]] as const) {
      const range = record.height * factor;
      expect(await page.evaluate(({ id, range, heading }) => window.landmarkReview.view(id, range, heading, -30),
        { id: record.sourceId, range, heading })).toBeGreaterThan(0);
      await expect(async () => {
        const state = await page.evaluate(id => ({
          resources: window.landmarkReview.state(), lods: window.landmarkReview.lods(id),
        }), record.sourceId);
        expect(state.resources.failure).toBeUndefined();
        expect(state.resources.loading).toBe(false);
        expect(state.lods).toHaveLength(1);
        captures.push({ name, range, heading, ...state });
      }).toPass({ timeout: 30_000 });
      await page.screenshot({ path: `${directory}/${name}.png` });
    }
    const point = await page.evaluate(id => window.landmarkReview.pickPoint(id), record.sourceId);
    expect(point.picked).toEqual({ ...feature.properties, heightReference: referenceHeightFor(feature) });
    await page.mouse.click(point.x, point.y);
    const card = page.locator('.selection-card');
    await expect(card.locator('h3')).toHaveText(record.name);
    await expect(card.locator('dl > div').filter({ has: page.getByText('参考建筑高度', { exact: true }) }).locator('dd'))
      .toHaveText(`${record.approximate ? '约 ' : ''}${record.height} m`);
    if (record.floors === undefined) await expect(card.getByText('地上楼层', { exact: true })).toHaveCount(0);
    else await expect(card).toContainText(`${record.floors} 层`);
    await expect(card).toContainText(record.checkedAt);
    await expect(card).toContainText(`${record.approximate ? '资料约值' : '资料核实'} · 通用高度插件`);
    await expect(card).toContainText('立面、塔冠与窗格并非实测还原');
    await expect(card).toContainText('原始 OSM 高度');
    await expect(card).toContainText(`${feature.properties.height.toFixed(1)} m`);
    await expect(card).toContainText('类型默认值 · 估算');
    for (const source of record.sources) {
      await expect(card.getByRole('link', { name: source.label })).toHaveAttribute('href', source.url);
    }
    await page.screenshot({ path: `${directory}/picked.png` });
    await page.getByRole('button', { name: '关闭建筑信息', exact: true }).click();
    await page.getByRole('button', { name: '展开控制面板', exact: true }).click();
    await page.getByRole('button', { name: '夜景', exact: true }).click();
    await page.getByRole('button', { name: '收起控制面板', exact: true }).click();
    expect(await page.evaluate(() => window.landmarkReview.ready())).toBeGreaterThan(0);
    await page.screenshot({ path: `${directory}/night.png` });
    const lit = await page.evaluate(id => window.landmarkReview.windowLight(id), record.sourceId);
    expect(lit.ownedSamples, 'warm pixels must belong to this tower, not an illuminated neighbour').toBeGreaterThan(2);
    await page.getByRole('button', { name: '展开控制面板', exact: true }).click();
    await page.locator('#glow').focus();
    await page.locator('#glow').press('Home');
    await page.getByRole('button', { name: '收起控制面板', exact: true }).click();
    const unlit = await page.evaluate(id => window.landmarkReview.windowLight(id), record.sourceId);
    expect(unlit.ownedSamples).toBe(0);
    expect(errors).toEqual([]);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await writeFile(`${directory}/evidence.json`, JSON.stringify({
      original: feature.properties, picked: point.picked, captures, nightWindows: { lit, unlit },
    }, null, 2));
  });
}

test('Hudong Yuanrong towers form a separately pickable day and night skyline', async ({ page }) => {
  const directory = 'artifacts/hudong/skyline', ids = ['way/482784883', 'way/482784884', 'way/482784885'];
  const errors: string[] = [], captures = [];
  page.on('pageerror', error => errors.push(error.message));
  await mkdir(directory, { recursive: true });
  await page.goto('/');
  await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
  await page.addScriptTag({ type: 'module', url: '/tests/fixtures/landmark-review.ts' });
  await page.waitForFunction(() => Boolean(window.landmarkReview));
  for (const mode of ['日景', '夜景']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await page.getByRole('button', { name: '收起控制面板', exact: true }).click();
    expect(await page.evaluate(() => window.landmarkReview.view('way/482784885', 1250, 30, -42, 0.35,
      [120.7106, 31.3200]))).toBeGreaterThan(0);
    const towers = [];
    for (const id of ids) {
      expect(await page.evaluate(id => window.landmarkReview.lods(id), id)).toHaveLength(1);
      const point = await page.evaluate(id => window.landmarkReview.pickPoint(id), id);
      expect(point.picked).toMatchObject({ id, height: 12.8, basis: 'fallback', estimated: true });
      expect(point.picked?.heightReference?.height).toBe(id === 'way/482784885' ? 160 : 100);
      const light = await page.evaluate(id => window.landmarkReview.windowLight(id), id);
      if (mode === '夜景') expect(light.ownedSamples, `${id} must be illuminated in the skyline`).toBeGreaterThan(2);
      else expect(light.ownedSamples).toBe(0);
      towers.push({ id, picked: point.picked, light });
    }
    captures.push({ mode, towers });
    await page.screenshot({ path: `${directory}/${mode === '日景' ? 'day' : 'night'}.png` });
    await page.getByRole('button', { name: '展开控制面板', exact: true }).click();
  }
  expect(errors).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await writeFile(`${directory}/evidence.json`, JSON.stringify(captures, null, 2));
});

test('ICC windows remain visible at night in each native LOD', async ({ page }) => {
  const id = 'way/802754584', directory = 'artifacts/highrise/night-lods', errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await mkdir(directory, { recursive: true });
  await page.goto('/');
  await expect(page.getByTestId('scene-state')).toHaveText('场景就绪');
  await page.addScriptTag({ type: 'module', url: '/tests/fixtures/landmark-review.ts' });
  await page.waitForFunction(() => Boolean(window.landmarkReview));
  await page.getByRole('button', { name: '夜景', exact: true }).click();
  await page.getByRole('button', { name: '收起控制面板', exact: true }).click();
  const captures = [];
  // Retain native far LOD while keeping its narrow windows above subpixel antialiasing.
  for (const [lod, range] of [['far', 3000], ['mid', 1000], ['near', 190]] as const) {
    expect(await page.evaluate(({ id, range }) => window.landmarkReview.view(id, range, 30, -30),
      { id, range })).toBeGreaterThan(0);
    expect(await page.evaluate(id => window.landmarkReview.lods(id), id)).toEqual([lod]);
    const light = await page.evaluate(id => window.landmarkReview.windowLight(id), id);
    expect(light.ownedSamples, `${lod} windows must be visibly illuminated`).toBeGreaterThan(2);
    await page.screenshot({ path: `${directory}/${lod}-night.png` });
    captures.push({ lod, range, light });
  }
  await page.getByRole('button', { name: '展开控制面板', exact: true }).click();
  await page.getByRole('button', { name: '日景', exact: true }).click();
  await page.getByRole('button', { name: '收起控制面板', exact: true }).click();
  const day = await page.evaluate(id => window.landmarkReview.windowLight(id), id);
  expect(day.ownedSamples).toBe(0);
  await page.screenshot({ path: `${directory}/near-day.png` });
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
  await writeFile(`${directory}/evidence.json`, JSON.stringify({ id, captures, day }, null, 2));
});
